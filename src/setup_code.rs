//! Bounded, short-lived, app-owned encrypted setup rendezvous (not OpenChat attestation).
//! Creator = ephemeral client identity; claimant = normal app identity plus a derived secret.
//! Clients encrypt and validate all app/session/account/scope bindings. No raw code/key is stored.
//! Heap-only by design: upgrades invalidate pending codes, without changing grants or chat routes.
//! Cancelling/expiry removes transport state only, never rolls back app-side setup effects.

use candid::{CandidType, Deserialize, Principal};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_LIFETIME_MS: u64 = 10 * 60 * 1_000;
pub const MAX_ENCRYPTED_BYTES: usize = 1024 * 1024 + 28; // 1 MiB + GCM nonce/tag.
const MIN_ENCRYPTED_BYTES: usize = 29; // Nonempty encrypted document.
const MAX_ROWS: usize = 256;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const ROW_OVERHEAD_BYTES: usize = 512; // Bounded ids, principals, hashes and map metadata.
const AUTH: &str = "setup code not authorized";
const INVALID: &str = "invalid setup code request";
const UNAVAILABLE: &str = "setup code unavailable or expired";
const CONFLICT: &str = "setup code request conflicts with an existing request";
const CAPACITY: &str = "setup code capacity reached";

#[derive(Clone, CandidType, Deserialize)]
pub struct CreateSetupCodeRequest {
    pub request_id: String,
    pub claim_hash: Vec<u8>,
    pub encrypted_context: Vec<u8>,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct SetupCodeReceipt {
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct SetupCodeContext {
    pub encrypted_context: Vec<u8>,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct SetupCodeCompletion {
    pub encrypted_result: Vec<u8>,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub enum SetupCodeStatus {
    Waiting(SetupCodeReceipt),
    Claimed(SetupCodeReceipt),
    Completed(SetupCodeCompletion),
}
struct Row {
    creator: Principal,
    claimant: Option<Principal>,
    request: CreateSetupCodeRequest,
    encrypted_result: Option<Vec<u8>>,
}
impl Row {
    fn bytes(&self) -> usize {
        ROW_OVERHEAD_BYTES
            + self.request.encrypted_context.len()
            + self.encrypted_result.as_ref().map_or(0, Vec::len)
    }
    fn receipt(&self) -> SetupCodeReceipt {
        SetupCodeReceipt {
            expires_at_ms: self.request.expires_at_ms,
        }
    }
}
#[derive(Default)]
pub struct SetupCodeStore {
    rows: BTreeMap<String, Row>,
    bytes: usize,
}
fn authenticated(caller: Principal) -> Result<(), String> {
    if caller == Principal::anonymous() {
        Err(AUTH.into())
    } else {
        Ok(())
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_blob(blob: &[u8]) -> bool {
    (MIN_ENCRYPTED_BYTES..=MAX_ENCRYPTED_BYTES).contains(&blob.len())
}
fn authorized_secret(hash: &[u8], secret: &[u8]) -> bool {
    if secret.len() != 32 || hash.len() != 32 {
        return false;
    }
    let actual = Sha256::digest(secret);
    hash.iter()
        .zip(actual.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
impl SetupCodeStore {
    fn prune(&mut self, now_ms: u64) {
        // At most MAX_ROWS entries: bounded work, no stable scans/timers.
        self.rows
            .retain(|_, row| row.request.expires_at_ms > now_ms);
        self.bytes = self.rows.values().map(Row::bytes).sum();
    }
    pub fn create(
        &mut self,
        caller: Principal,
        request: CreateSetupCodeRequest,
        now_ms: u64,
    ) -> Result<SetupCodeReceipt, String> {
        authenticated(caller)?;
        if !valid_id(&request.request_id)
            || request.claim_hash.len() != 32
            || !valid_blob(&request.encrypted_context)
            || request.expires_at_ms <= now_ms
            || request.expires_at_ms - now_ms > MAX_LIFETIME_MS
        {
            return Err(INVALID.into());
        }
        self.prune(now_ms);
        if let Some(row) = self.rows.get(&request.request_id) {
            if row.creator != caller {
                return Err(AUTH.into());
            }
            if row.request.claim_hash != request.claim_hash
                || row.request.encrypted_context != request.encrypted_context
                || row.request.expires_at_ms != request.expires_at_ms
            {
                return Err(CONFLICT.into());
            }
            return Ok(row.receipt()); // Never extends expiry or resets claim/completion.
        }
        if self.rows.values().any(|row| row.creator == caller) {
            return Err(CONFLICT.into());
        }
        let added = ROW_OVERHEAD_BYTES + request.encrypted_context.len();
        if self.rows.len() >= MAX_ROWS || self.bytes + added > MAX_TOTAL_BYTES {
            return Err(CAPACITY.into());
        }
        let receipt = SetupCodeReceipt {
            expires_at_ms: request.expires_at_ms,
        };
        let id = request.request_id.clone();
        self.rows.insert(
            id,
            Row {
                creator: caller,
                claimant: None,
                request,
                encrypted_result: None,
            },
        );
        self.bytes += added;
        Ok(receipt)
    }
    pub fn claim(
        &mut self,
        caller: Principal,
        request_id: &str,
        claim_secret: &[u8],
        now_ms: u64,
    ) -> Result<SetupCodeContext, String> {
        authenticated(caller)?;
        if !valid_id(request_id) {
            return Err(INVALID.into());
        }
        self.prune(now_ms);
        let row = self.rows.get_mut(request_id).ok_or(UNAVAILABLE)?;
        if !authorized_secret(&row.request.claim_hash, claim_secret)
            || row.claimant.is_some_and(|claimant| claimant != caller)
        {
            return Err(AUTH.into());
        }
        // Re-entering a completed code must not reopen app-side setup and mint a
        // different grant/route while the creator can still receive the old result.
        // Lost-response retries use complete() with the original ciphertext instead.
        if row.encrypted_result.is_some() {
            return Err(UNAVAILABLE.into());
        }
        row.claimant = Some(caller);
        Ok(SetupCodeContext {
            encrypted_context: row.request.encrypted_context.clone(),
            expires_at_ms: row.request.expires_at_ms,
        })
    }
    pub fn complete(
        &mut self,
        caller: Principal,
        request_id: &str,
        claim_secret: &[u8],
        encrypted_result: Vec<u8>,
        now_ms: u64,
    ) -> Result<SetupCodeReceipt, String> {
        authenticated(caller)?;
        if !valid_id(request_id) || !valid_blob(&encrypted_result) {
            return Err(INVALID.into());
        }
        self.prune(now_ms);
        let row = self.rows.get_mut(request_id).ok_or(UNAVAILABLE)?;
        if row.claimant != Some(caller) || !authorized_secret(&row.request.claim_hash, claim_secret)
        {
            return Err(AUTH.into());
        }
        if let Some(existing) = &row.encrypted_result {
            return if *existing == encrypted_result {
                Ok(row.receipt())
            } else {
                Err(CONFLICT.into())
            };
        }
        if self.bytes + encrypted_result.len() > MAX_TOTAL_BYTES {
            return Err(CAPACITY.into());
        }
        self.bytes += encrypted_result.len();
        row.encrypted_result = Some(encrypted_result);
        Ok(row.receipt())
    }
    pub fn poll(
        &mut self,
        caller: Principal,
        request_id: &str,
        now_ms: u64,
    ) -> Result<SetupCodeStatus, String> {
        authenticated(caller)?;
        if !valid_id(request_id) {
            return Err(INVALID.into());
        }
        self.prune(now_ms);
        let row = self.rows.get(request_id).ok_or(UNAVAILABLE)?;
        if row.creator != caller {
            return Err(AUTH.into());
        }
        Ok(match &row.encrypted_result {
            Some(result) => SetupCodeStatus::Completed(SetupCodeCompletion {
                encrypted_result: result.clone(),
                expires_at_ms: row.request.expires_at_ms,
            }),
            None if row.claimant.is_some() => SetupCodeStatus::Claimed(row.receipt()),
            None => SetupCodeStatus::Waiting(row.receipt()),
        }) // Nondestructive read: response loss can be retried safely.
    }
    pub fn cancel(
        &mut self,
        caller: Principal,
        request_id: &str,
        now_ms: u64,
    ) -> Result<bool, String> {
        authenticated(caller)?;
        if !valid_id(request_id) {
            return Err(INVALID.into());
        }
        self.prune(now_ms);
        let Some(row) = self.rows.get(request_id) else {
            return Ok(false);
        };
        if row.creator != caller {
            return Err(AUTH.into());
        }
        let size = row.bytes();
        self.rows.remove(request_id);
        self.bytes -= size;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: u64 = 1_000;
    fn user(n: u32) -> Principal {
        Principal::self_authenticating(n.to_be_bytes())
    }
    fn request(n: u32) -> CreateSetupCodeRequest {
        CreateSetupCodeRequest {
            request_id: format!("{n:064x}"),
            claim_hash: Sha256::digest([7; 32]).to_vec(),
            encrypted_context: vec![1; 40],
            expires_at_ms: NOW + MAX_LIFETIME_MS,
        }
    }
    fn initialized() -> (SetupCodeStore, CreateSetupCodeRequest) {
        let mut store = SetupCodeStore::default();
        let req = request(1);
        store.create(user(1), req.clone(), NOW).unwrap();
        (store, req)
    }
    #[test]
    fn round_trip_keeps_exact_result_until_creator_cancels() {
        let (mut s, r) = initialized();
        assert!(matches!(
            s.poll(user(1), &r.request_id, NOW).unwrap(),
            SetupCodeStatus::Waiting(_)
        ));
        let ctx = s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        assert_eq!(ctx.encrypted_context, r.encrypted_context);
        assert_eq!(ctx.expires_at_ms, r.expires_at_ms);
        assert!(matches!(
            s.poll(user(1), &r.request_id, NOW).unwrap(),
            SetupCodeStatus::Claimed(_)
        ));
        assert_eq!(
            s.complete(user(2), &r.request_id, &[7; 32], vec![3; 64], NOW)
                .unwrap()
                .expires_at_ms,
            r.expires_at_ms
        );
        let expected = SetupCodeStatus::Completed(SetupCodeCompletion {
            encrypted_result: vec![3; 64],
            expires_at_ms: r.expires_at_ms,
        });
        assert_eq!(s.poll(user(1), &r.request_id, NOW).unwrap(), expected);
        assert_eq!(s.poll(user(1), &r.request_id, NOW + 1).unwrap(), expected);
        assert!(s.cancel(user(1), &r.request_id, NOW).unwrap());
        assert!(!s.cancel(user(1), &r.request_id, NOW).unwrap());
        assert_eq!(s.bytes, 0);
    }
    #[test]
    fn anonymous_is_denied_every_operation() {
        let (mut s, r) = initialized();
        let a = Principal::anonymous();
        assert_eq!(s.create(a, request(2), NOW), Err(AUTH.into()));
        assert_eq!(s.claim(a, &r.request_id, &[7; 32], NOW), Err(AUTH.into()));
        assert_eq!(
            s.complete(a, &r.request_id, &[7; 32], vec![3; 40], NOW),
            Err(AUTH.into())
        );
        assert_eq!(s.poll(a, &r.request_id, NOW), Err(AUTH.into()));
        assert_eq!(s.cancel(a, &r.request_id, NOW), Err(AUTH.into()));
        assert!(s.rows[&r.request_id].claimant.is_none());
    }
    #[test]
    fn creator_exclusively_polls_cancels_and_retries_creation() {
        let (mut s, r) = initialized();
        assert_eq!(s.create(user(2), r.clone(), NOW), Err(AUTH.into()));
        assert_eq!(s.poll(user(2), &r.request_id, NOW), Err(AUTH.into()));
        assert_eq!(s.cancel(user(2), &r.request_id, NOW), Err(AUTH.into()));
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        assert_eq!(s.poll(user(2), &r.request_id, NOW), Err(AUTH.into()));
        assert_eq!(s.cancel(user(2), &r.request_id, NOW), Err(AUTH.into()));
        assert_eq!(s.rows.len(), 1);
    }
    #[test]
    fn claim_requires_secret_and_first_claimant_cannot_be_replaced() {
        let (mut s, r) = initialized();
        for secret in [
            vec![],
            vec![7; 31],
            vec![7; 33],
            vec![8; 32],
            r.claim_hash.clone(),
        ] {
            assert_eq!(
                s.claim(user(2), &r.request_id, &secret, NOW),
                Err(AUTH.into())
            );
        }
        assert!(s.rows[&r.request_id].claimant.is_none());
        let first = s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        assert_eq!(
            s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap(),
            first
        );
        assert_eq!(
            s.claim(user(3), &r.request_id, &[7; 32], NOW),
            Err(AUTH.into())
        );
        assert_eq!(s.rows[&r.request_id].claimant, Some(user(2)));
    }
    #[test]
    fn completion_requires_prior_claim_and_both_claimant_and_secret() {
        let (mut s, r) = initialized();
        assert_eq!(
            s.complete(user(1), &r.request_id, &[7; 32], vec![2; 40], NOW),
            Err(AUTH.into())
        );
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        for caller in [user(1), user(3)] {
            assert_eq!(
                s.complete(caller, &r.request_id, &[7; 32], vec![2; 40], NOW),
                Err(AUTH.into())
            );
        }
        for secret in [vec![], vec![7; 31], vec![7; 33], vec![8; 32]] {
            assert_eq!(
                s.complete(user(2), &r.request_id, &secret, vec![2; 40], NOW),
                Err(AUTH.into())
            );
        }
        assert!(s.rows[&r.request_id].encrypted_result.is_none());
    }
    #[test]
    fn create_retries_do_not_reset_claim_result_or_expiry_and_conflicts_fail() {
        let (mut s, r) = initialized();
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        s.complete(user(2), &r.request_id, &[7; 32], vec![2; 40], NOW)
            .unwrap();
        let size = s.bytes;
        assert_eq!(
            s.create(user(1), r.clone(), NOW + 1).unwrap().expires_at_ms,
            r.expires_at_ms
        );
        assert_eq!(s.bytes, size);
        assert_eq!(s.rows[&r.request_id].claimant, Some(user(2)));
        assert_eq!(s.rows[&r.request_id].encrypted_result, Some(vec![2; 40]));
        for field in 0..3 {
            let mut changed = r.clone();
            match field {
                0 => changed.claim_hash[0] ^= 1,
                1 => changed.encrypted_context[0] ^= 1,
                _ => changed.expires_at_ms -= 1,
            }
            assert_eq!(s.create(user(1), changed, NOW), Err(CONFLICT.into()));
        }
    }
    #[test]
    fn completion_retries_are_exactly_idempotent_and_cannot_replace_result() {
        let (mut s, r) = initialized();
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        let first = s
            .complete(user(2), &r.request_id, &[7; 32], vec![3; 40], NOW)
            .unwrap();
        let size = s.bytes;
        assert_eq!(
            s.complete(user(2), &r.request_id, &[7; 32], vec![3; 40], NOW + 1)
                .unwrap(),
            first
        );
        assert_eq!(s.bytes, size);
        assert_eq!(
            s.complete(user(2), &r.request_id, &[7; 32], vec![4; 40], NOW),
            Err(CONFLICT.into())
        );
        assert_eq!(s.rows[&r.request_id].encrypted_result, Some(vec![3; 40]));
    }
    #[test]
    fn completed_code_cannot_reopen_setup_but_exact_completion_remains_retryable() {
        let (mut s, r) = initialized();
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        let receipt = s
            .complete(user(2), &r.request_id, &[7; 32], vec![3; 40], NOW)
            .unwrap();
        let result = s.poll(user(1), &r.request_id, NOW).unwrap();
        let size = s.bytes;
        // A refreshed app page must not receive context and prepare another grant/route.
        assert_eq!(
            s.claim(user(2), &r.request_id, &[7; 32], NOW + 1),
            Err(UNAVAILABLE.into())
        );
        // Even replaying the creator's exact create request must not reopen it.
        assert_eq!(s.create(user(1), r.clone(), NOW + 1).unwrap(), receipt);
        assert_eq!(
            s.claim(user(2), &r.request_id, &[7; 32], NOW + 1),
            Err(UNAVAILABLE.into())
        );
        // A still-live app's lost-response retry does not claim again.
        assert_eq!(
            s.complete(user(2), &r.request_id, &[7; 32], vec![3; 40], NOW + 1)
                .unwrap(),
            receipt
        );
        assert_eq!(s.poll(user(1), &r.request_id, NOW + 1).unwrap(), result);
        assert_eq!(s.rows[&r.request_id].claimant, Some(user(2)));
        assert_eq!(s.bytes, size);
    }
    #[test]
    fn expiry_is_enforced_at_every_access_including_exact_boundary() {
        for op in 0..4 {
            let (mut s, r) = initialized();
            s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
            let t = r.expires_at_ms;
            match op {
                0 => assert_eq!(
                    s.claim(user(2), &r.request_id, &[7; 32], t),
                    Err(UNAVAILABLE.into())
                ),
                1 => assert_eq!(
                    s.complete(user(2), &r.request_id, &[7; 32], vec![3; 40], t),
                    Err(UNAVAILABLE.into())
                ),
                2 => assert_eq!(s.poll(user(1), &r.request_id, t), Err(UNAVAILABLE.into())),
                _ => assert_eq!(s.cancel(user(1), &r.request_id, t), Ok(false)),
            }
            assert_eq!(s.bytes, 0);
            assert!(s.rows.is_empty());
        }
        let (mut s, r) = initialized();
        assert!(s.poll(user(1), &r.request_id, r.expires_at_ms - 1).is_ok());
        assert_eq!(
            s.create(user(1), r.clone(), r.expires_at_ms),
            Err(INVALID.into())
        );
    }
    #[test]
    fn malformed_ids_hashes_ciphertext_and_ttl_fail_without_insertion() {
        let mut s = SetupCodeStore::default();
        for id in [
            String::new(),
            "0".repeat(63),
            "0".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
            "é".repeat(32),
        ] {
            let mut r = request(1);
            r.request_id = id.clone();
            assert_eq!(s.create(user(1), r, NOW), Err(INVALID.into()));
            assert_eq!(s.poll(user(1), &id, NOW), Err(INVALID.into()));
            assert_eq!(s.claim(user(2), &id, &[7; 32], NOW), Err(INVALID.into()));
            assert_eq!(
                s.complete(user(2), &id, &[7; 32], vec![2; 40], NOW),
                Err(INVALID.into())
            );
            assert_eq!(s.cancel(user(1), &id, NOW), Err(INVALID.into()));
        }
        for n in [0, 31, 33] {
            let mut r = request(1);
            r.claim_hash = vec![1; n];
            assert_eq!(s.create(user(1), r, NOW), Err(INVALID.into()));
        }
        for n in [0, 16, 28, MAX_ENCRYPTED_BYTES + 1] {
            let mut r = request(1);
            r.encrypted_context = vec![1; n];
            assert_eq!(s.create(user(1), r, NOW), Err(INVALID.into()));
        }
        for t in [0, NOW - 1, NOW, NOW + MAX_LIFETIME_MS + 1, u64::MAX] {
            let mut r = request(1);
            r.expires_at_ms = t;
            assert_eq!(s.create(user(1), r, NOW), Err(INVALID.into()));
        }
        assert_eq!(s.bytes, 0);
        assert!(s.rows.is_empty());
    }
    #[test]
    fn ciphertext_boundaries_and_large_timestamps_are_safe() {
        for len in [MIN_ENCRYPTED_BYTES, MAX_ENCRYPTED_BYTES] {
            let mut s = SetupCodeStore::default();
            let mut r = request(1);
            r.encrypted_context = vec![1; len];
            r.expires_at_ms = u64::MAX;
            let now = u64::MAX - 1;
            s.create(user(1), r.clone(), now).unwrap();
            s.claim(user(2), &r.request_id, &[7; 32], now).unwrap();
            s.complete(user(2), &r.request_id, &[7; 32], vec![2; len], now)
                .unwrap();
            assert_eq!(s.bytes, ROW_OVERHEAD_BYTES + 2 * len);
        }
    }
    #[test]
    fn invalid_result_does_not_consume_claim() {
        let (mut s, r) = initialized();
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        for n in [0, 28, MAX_ENCRYPTED_BYTES + 1] {
            assert_eq!(
                s.complete(user(2), &r.request_id, &[7; 32], vec![2; n], NOW),
                Err(INVALID.into())
            );
        }
        assert!(s.rows[&r.request_id].encrypted_result.is_none());
        s.complete(user(2), &r.request_id, &[7; 32], vec![2; 40], NOW)
            .unwrap();
    }
    #[test]
    fn one_active_request_per_creator_including_completed_requests() {
        let (mut s, r) = initialized();
        assert_eq!(s.create(user(1), request(2), NOW), Err(CONFLICT.into()));
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        s.complete(user(2), &r.request_id, &[7; 32], vec![2; 40], NOW)
            .unwrap();
        assert_eq!(s.create(user(1), request(2), NOW), Err(CONFLICT.into()));
        s.cancel(user(1), &r.request_id, NOW).unwrap();
        s.create(user(1), request(2), NOW).unwrap();
    }
    #[test]
    fn bounded_row_capacity_is_reclaimed_by_expiry() {
        let mut s = SetupCodeStore::default();
        for n in 0..MAX_ROWS as u32 {
            s.create(user(n), request(n), NOW).unwrap();
        }
        assert_eq!(s.create(user(999), request(999), NOW), Err(CAPACITY.into()));
        let mut fresh = request(999);
        fresh.expires_at_ms += MAX_LIFETIME_MS;
        s.create(user(999), fresh, NOW + MAX_LIFETIME_MS).unwrap();
        assert_eq!(s.rows.len(), 1);
    }
    #[test]
    fn byte_capacity_counts_both_documents_and_failed_completion_can_retry() {
        let mut s = SetupCodeStore::default();
        for n in 0..7 {
            let mut r = request(n);
            r.encrypted_context = vec![1; MAX_ENCRYPTED_BYTES];
            s.create(user(n), r, NOW).unwrap();
        }
        let mut full = request(7);
        full.encrypted_context = vec![1; MAX_ENCRYPTED_BYTES];
        assert_eq!(s.create(user(7), full, NOW), Err(CAPACITY.into()));
        let id = request(0).request_id;
        s.claim(user(99), &id, &[7; 32], NOW).unwrap();
        let used = s.bytes;
        assert_eq!(
            s.complete(user(99), &id, &[7; 32], vec![2; MAX_ENCRYPTED_BYTES], NOW),
            Err(CAPACITY.into())
        );
        assert_eq!(s.bytes, used);
        assert!(s.rows[&id].encrypted_result.is_none());
        s.cancel(user(1), &request(1).request_id, NOW).unwrap();
        s.complete(user(99), &id, &[7; 32], vec![2; MAX_ENCRYPTED_BYTES], NOW)
            .unwrap();
        assert_eq!(s.bytes, used - ROW_OVERHEAD_BYTES);
        assert!(s.bytes <= MAX_TOTAL_BYTES);
    }
    #[test]
    fn unknown_and_cancelled_requests_cannot_claim_complete_or_poll() {
        let (mut s, r) = initialized();
        s.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        s.cancel(user(1), &r.request_id, NOW).unwrap();
        for id in [r.request_id, request(2).request_id] {
            assert_eq!(
                s.claim(user(2), &id, &[7; 32], NOW),
                Err(UNAVAILABLE.into())
            );
            assert_eq!(
                s.complete(user(2), &id, &[7; 32], vec![2; 40], NOW),
                Err(UNAVAILABLE.into())
            );
            assert_eq!(s.poll(user(1), &id, NOW), Err(UNAVAILABLE.into()));
        }
    }
    #[test]
    fn fresh_heap_after_upgrade_has_no_old_codes() {
        let (mut old, r) = initialized();
        old.claim(user(2), &r.request_id, &[7; 32], NOW).unwrap();
        old.complete(user(2), &r.request_id, &[7; 32], vec![2; 40], NOW)
            .unwrap();
        let mut fresh = SetupCodeStore::default();
        assert_eq!(
            fresh.poll(user(1), &r.request_id, NOW),
            Err(UNAVAILABLE.into())
        );
        assert_eq!(
            fresh.claim(user(2), &r.request_id, &[7; 32], NOW),
            Err(UNAVAILABLE.into())
        );
        assert_eq!(fresh.bytes, 0);
    }
}
