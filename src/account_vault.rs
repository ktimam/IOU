//! Upgrade-stable ciphertext vaults and bounded paid-key admission; no root plaintext is stored.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use candid::{CandidType, Decode, Deserialize, Encode, Principal};
use ic_stable_structures::{storable::Bound, Memory, StableBTreeMap, StableCell, Storable};
use sha2::{Digest, Sha256};
use std::borrow::Cow;

pub const MAX_ACCOUNTS: u64 = 10_000;
pub const MAX_VAULT_BYTES: usize = 65_536;
const RETAINED_ROOT_ATTEMPTS: usize = 8;
const HOUR_NS: u64 = 3_600_000_000_000;
const DAY_NS: u64 = 24 * HOUR_NS;

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct AccountVault {
    pub revision: u64,
    pub payload: Vec<u8>,
}
#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
pub struct AccountWrappingKey {
    pub key_id: String,
    pub public_key: Vec<u8>,
    pub vault_revision: u64,
}
#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
enum RootOutcome {
    Pending,
    Unknown,
    Ready(Vec<u8>),
    Failed,
}
#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
struct RootAttempt {
    request_id: String,
    transport_public_key: Vec<u8>,
    created_at: u64,
    outcome: RootOutcome,
}
#[derive(Clone, Debug, Default, CandidType, Deserialize, PartialEq, Eq)]
struct RootHistory {
    attempts: Vec<RootAttempt>,
    highest_request_time_ms: u64,
}
#[derive(Clone, Debug, Default, CandidType, Deserialize, PartialEq, Eq)]
struct Budget {
    tokens: u64,
    updated_at: u64,
    initialized: bool,
}
macro_rules! stable_candid {
    ($($t:ty),+ $(,)?) => { $(impl Storable for $t {
        fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(Encode!(self).expect("encode vault state")) }
        fn from_bytes(bytes: Cow<[u8]>) -> Self { Decode!(bytes.as_ref(), Self).expect("decode vault state") }
        const BOUND: Bound = Bound::Unbounded;
    })+ };
}
stable_candid!(AccountVault, AccountWrappingKey, RootHistory, Budget);
#[derive(Debug, PartialEq, Eq)]
pub enum RootAdmission {
    Cached(Vec<u8>),
    Dispatch,
}
pub struct AccountVaultStore<M: Memory> {
    vaults: StableBTreeMap<Principal, AccountVault, M>,
    keys: StableBTreeMap<Principal, AccountWrappingKey, M>,
    roots: StableBTreeMap<Principal, RootHistory, M>,
    global_budget: StableCell<Budget, M>,
    principal_budgets: StableBTreeMap<Principal, Budget, M>,
}
pub fn valid_identifier(value: &str, minimum: usize) -> bool {
    (minimum..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn wrapping_key_id(public_key: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_key))
}
fn debit(mut budget: Budget, now: u64, capacity: u64) -> Result<Budget, String> {
    if !budget.initialized {
        budget = Budget {
            tokens: capacity,
            updated_at: now,
            initialized: true,
        };
    }
    let refills = now.saturating_sub(budget.updated_at) / HOUR_NS;
    if refills > 0 {
        budget.tokens = budget.tokens.saturating_add(refills).min(capacity);
        budget.updated_at = if budget.tokens == capacity {
            now
        } else {
            budget
                .updated_at
                .saturating_add(refills.saturating_mul(HOUR_NS))
        };
    }
    if budget.tokens == 0 {
        return Err("paid key derivation budget exhausted; retry later".into());
    }
    budget.tokens -= 1;
    Ok(budget)
}
impl<M: Memory> AccountVaultStore<M> {
    pub fn init(memories: [M; 5]) -> Self {
        let [vaults, keys, roots, global, principals] = memories;
        Self {
            vaults: StableBTreeMap::init(vaults),
            keys: StableBTreeMap::init(keys),
            roots: StableBTreeMap::init(roots),
            global_budget: StableCell::init(global, Budget::default()).expect("vault budget init"),
            principal_budgets: StableBTreeMap::init(principals),
        }
    }
    pub fn vault(&self, caller: Principal) -> Option<AccountVault> {
        self.vaults.get(&caller)
    }
    pub fn wrapping_key(&self, caller: Principal) -> Option<AccountWrappingKey> {
        self.keys.get(&caller)
    }
    pub fn has_root_history(&self, caller: Principal) -> bool {
        self.roots.contains_key(&caller)
    }
    pub fn set_vault(
        &mut self,
        caller: Principal,
        expected: u64,
        payload: Vec<u8>,
    ) -> Result<u64, String> {
        if caller == Principal::anonymous() {
            return Err("authentication required".into());
        }
        if payload.is_empty() || payload.len() > MAX_VAULT_BYTES {
            return Err("vault payload must be 1..=65536 bytes".into());
        }
        let previous = self.vaults.get(&caller);
        if previous.as_ref().map_or(0, |v| v.revision) != expected {
            return Err("vault revision conflict".into());
        }
        if previous.is_none() && self.vaults.len() >= MAX_ACCOUNTS {
            return Err("vault account capacity reached".into());
        }
        let revision = expected.checked_add(1).ok_or("vault revision exhausted")?;
        self.vaults
            .insert(caller, AccountVault { revision, payload });
        Ok(revision)
    }
    pub fn register_key(
        &mut self,
        caller: Principal,
        revision: u64,
        key_id: String,
        public_key: Vec<u8>,
    ) -> Result<(), String> {
        if caller == Principal::anonymous() {
            return Err("authentication required".into());
        }
        let vault = self
            .vaults
            .get(&caller)
            .ok_or("save the encrypted account vault before publishing its key")?;
        if vault.revision != revision {
            return Err("vault revision conflict".into());
        }
        // The exact uncompressed encoding/fingerprint is caller-bound. WebCrypto checks curve membership on import.
        if public_key.len() != 65 || public_key[0] != 4 || wrapping_key_id(&public_key) != key_id {
            return Err("invalid P-256 public encoding or key fingerprint".into());
        }
        if let Some(existing) = self.keys.get(&caller) {
            if existing.key_id != key_id || existing.public_key != public_key {
                return Err("wrapping-key rotation requires an explicit migration".into());
            }
        }
        self.keys.insert(
            caller,
            AccountWrappingKey {
                key_id,
                public_key,
                vault_revision: revision,
            },
        );
        Ok(())
    }
    /// Charge at admission, never refund; a global bucket is necessary because principals are not scarce.
    pub fn admit_paid(&mut self, caller: Principal, now: u64) -> Result<(), String> {
        let current = self.principal_budgets.get(&caller);
        if current.is_none() && self.principal_budgets.len() >= MAX_ACCOUNTS {
            return Err("paid key account capacity reached".into());
        }
        let global = debit(self.global_budget.get().clone(), now, 32)?;
        let principal = debit(current.unwrap_or_default(), now, 8)?;
        self.global_budget
            .set(global)
            .expect("persist global key budget");
        self.principal_budgets.insert(caller, principal);
        Ok(())
    }
    pub fn begin_root(
        &mut self,
        caller: Principal,
        request_id: String,
        transport_public_key: Vec<u8>,
        emergency: bool,
        now: u64,
    ) -> Result<RootAdmission, String> {
        if caller == Principal::anonymous() {
            return Err("authentication required".into());
        }
        if !valid_identifier(&request_id, 16) || transport_public_key.len() != 48 {
            return Err("invalid request id or transport public key".into());
        }
        let mut history = self.roots.get(&caller).unwrap_or_default();
        if let Some(old) = history.attempts.iter().find(|a| a.request_id == request_id) {
            if old.transport_public_key != transport_public_key {
                return Err("request id is pinned to another transport public key".into());
            }
            return match &old.outcome {
                RootOutcome::Ready(reply) => Ok(RootAdmission::Cached(reply.clone())),
                RootOutcome::Pending => Err(
                    "root request pending or outcome unknown; no second derivation dispatched"
                        .into(),
                ),
                RootOutcome::Unknown => Err(
                    "root request outcome unknown; this request will never dispatch again".into(),
                ),
                RootOutcome::Failed => {
                    Err("root request failed; explicit emergency recovery is required".into())
                }
            };
        }
        // The monotonic watermark survives receipt pruning: an old id can never cause a new
        // paid dispatch after its cached reply expires. Cached matching replies above remain readable.
        let request_time_ms = request_id
            .split_once('_')
            .and_then(|(t, _)| t.parse::<u64>().ok())
            .ok_or("request id must start with a millisecond timestamp followed by underscore")?;
        let now_ms = now / 1_000_000;
        if request_time_ms <= history.highest_request_time_ms
            || request_time_ms > now_ms.saturating_add(300_000)
            || now_ms.saturating_sub(request_time_ms) > 900_000
        {
            return Err("root request timestamp is stale, reused, or in the future".into());
        }
        if history
            .attempts
            .iter()
            .any(|a| a.outcome == RootOutcome::Pending)
            && !emergency
        {
            return Err("an existing root request has an unresolved outcome".into());
        }
        if let Some(previous) = history.attempts.last() {
            if !emergency {
                return Err("account root already acquired; unlock the vault or explicitly request emergency recovery".into());
            }
            if now.saturating_sub(previous.created_at) < DAY_NS {
                return Err("emergency root recovery is limited to once per 24 hours".into());
            }
        }
        if history.attempts.is_empty() && self.roots.len() >= MAX_ACCOUNTS {
            return Err("root account capacity reached".into());
        }
        if history.attempts.len() == RETAINED_ROOT_ATTEMPTS {
            let completed = history
                .attempts
                .iter()
                .position(|a| a.outcome != RootOutcome::Pending)
                .ok_or("too many unresolved root requests; manual reconciliation is required")?;
            history.attempts.remove(completed);
        }
        self.admit_paid(caller, now)?;
        history.highest_request_time_ms = request_time_ms;
        history.attempts.push(RootAttempt {
            request_id,
            transport_public_key,
            created_at: now,
            outcome: RootOutcome::Pending,
        });
        self.roots.insert(caller, history);
        Ok(RootAdmission::Dispatch)
    }
    pub fn mark_root_unknown(&mut self, caller: Principal, request_id: &str) -> Result<(), String> {
        let mut history = self.roots.get(&caller).ok_or("missing root reservation")?;
        let attempt = history
            .attempts
            .iter_mut()
            .find(|a| a.request_id == request_id)
            .ok_or("missing root request")?;
        if attempt.outcome != RootOutcome::Pending {
            return Err("root request already completed".into());
        }
        attempt.outcome = RootOutcome::Unknown;
        self.roots.insert(caller, history);
        Ok(())
    }

    pub fn finish_root(
        &mut self,
        caller: Principal,
        request_id: &str,
        reply: Option<Vec<u8>>,
    ) -> Result<(), String> {
        let mut history = self.roots.get(&caller).ok_or("missing root reservation")?;
        let attempt = history
            .attempts
            .iter_mut()
            .find(|a| a.request_id == request_id)
            .ok_or("missing root request")?;
        if attempt.outcome != RootOutcome::Pending {
            return Err("root request already completed".into());
        }
        if reply
            .as_ref()
            .is_some_and(|r| r.is_empty() || r.len() > 1024)
        {
            return Err("unexpected encrypted root response size".into());
        }
        attempt.outcome = reply.map_or(RootOutcome::Failed, RootOutcome::Ready);
        self.roots.insert(caller, history);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::VectorMemory;

    #[test]
    fn explicit_emergency_after_unknown_or_pending_waits_a_day_and_preserves_late_reply() {
        let mut store = AccountVaultStore::init(memories());
        let first = "1_request_first_0001".to_string();
        store
            .begin_root(caller(1), first.clone(), vec![1; 48], false, 1_000_000)
            .unwrap();
        let second = format!("{}_request_second", DAY_NS / 1_000_000);
        assert!(store
            .begin_root(caller(1), second, vec![2; 48], true, DAY_NS)
            .is_err());
        let next_time = DAY_NS + 1_000_000;
        let second = format!("{}_request_second", next_time / 1_000_000);
        store
            .begin_root(caller(1), second.clone(), vec![2; 48], true, next_time)
            .unwrap();
        store
            .finish_root(caller(1), &first, Some(vec![3; 192]))
            .unwrap();
        assert_eq!(
            store.begin_root(caller(1), first, vec![1; 48], false, next_time),
            Ok(RootAdmission::Cached(vec![3; 192]))
        );
        assert!(store
            .begin_root(caller(1), second.clone(), vec![2; 48], true, next_time)
            .is_err());
        store.mark_root_unknown(caller(1), &second).unwrap();
        assert!(store
            .begin_root(caller(1), second, vec![2; 48], true, DAY_NS * 3)
            .is_err());
        let third = format!("{}_request_third", DAY_NS * 3 / 1_000_000);
        store
            .begin_root(caller(1), third, vec![4; 48], true, DAY_NS * 3)
            .unwrap();
        assert_eq!(
            store.roots.get(&caller(1)).unwrap().attempts[1].outcome,
            RootOutcome::Unknown
        );
    }

    #[test]
    fn genuinely_inflight_requests_are_not_pruned_for_another_paid_attempt() {
        let mut store = AccountVaultStore::init(memories());
        for index in 0..RETAINED_ROOT_ATTEMPTS {
            let now = (index as u64 + 1) * DAY_NS;
            let id = format!("{}_pending_request", now / 1_000_000);
            store
                .begin_root(caller(1), id, vec![1; 48], index != 0, now)
                .unwrap();
        }
        let now = 20 * DAY_NS;
        assert!(store
            .begin_root(
                caller(1),
                format!("{}_pending_request", now / 1_000_000),
                vec![1; 48],
                true,
                now
            )
            .unwrap_err()
            .contains("manual reconciliation"));
    }
    fn caller(n: u8) -> Principal {
        Principal::self_authenticating([n; 32])
    }
    fn memories() -> [VectorMemory; 5] {
        std::array::from_fn(|_| VectorMemory::default())
    }
    #[test]
    fn vault_cas_bounds_owner_isolation_and_upgrade() {
        let memories = memories();
        let mut store = AccountVaultStore::init(memories.clone());
        assert!(store.set_vault(Principal::anonymous(), 0, vec![1]).is_err());
        assert!(store.set_vault(caller(1), 0, vec![]).is_err());
        assert!(store
            .set_vault(caller(1), 0, vec![1; MAX_VAULT_BYTES + 1])
            .is_err());
        assert_eq!(store.set_vault(caller(1), 0, vec![1]), Ok(1));
        assert!(store.set_vault(caller(1), 0, vec![2]).is_err());
        assert_eq!(store.vault(caller(2)), None);
        drop(store);
        let store = AccountVaultStore::init(memories);
        assert_eq!(store.vault(caller(1)).unwrap().payload, vec![1]);
    }
    #[test]
    fn publication_requires_saved_vault_and_forbids_silent_rotation() {
        let mut store = AccountVaultStore::init(memories());
        let mut key = vec![3; 65];
        key[0] = 4;
        let id = wrapping_key_id(&key);
        assert!(store
            .register_key(caller(1), 1, id.clone(), key.clone())
            .is_err());
        store.set_vault(caller(1), 0, vec![1]).unwrap();
        store
            .register_key(caller(1), 1, id.clone(), key.clone())
            .unwrap();
        store.set_vault(caller(1), 1, vec![2]).unwrap();
        assert!(store
            .register_key(caller(1), 1, id.clone(), key.clone())
            .is_err());
        store.register_key(caller(1), 2, id, key.clone()).unwrap();
        key[1] ^= 1;
        assert!(store
            .register_key(caller(1), 2, wrapping_key_id(&key), key)
            .is_err());
    }
    #[test]
    fn root_retries_pin_transport_and_never_redispatch_pending_or_ready() {
        let memories = memories();
        let mut store = AccountVaultStore::init(memories.clone());
        let id = "1_request_0000000001".to_string();
        assert_eq!(
            store.begin_root(caller(1), id.clone(), vec![1; 48], false, 1_000_000),
            Ok(RootAdmission::Dispatch)
        );
        assert!(store
            .begin_root(caller(1), id.clone(), vec![1; 48], false, 2)
            .is_err());
        assert!(store
            .begin_root(
                caller(1),
                "request_0000000002".into(),
                vec![2; 48],
                true,
                DAY_NS * 2
            )
            .is_err());
        drop(store);
        let mut store = AccountVaultStore::init(memories);
        assert!(store
            .begin_root(caller(1), id.clone(), vec![2; 48], true, DAY_NS * 2)
            .is_err());
        store
            .finish_root(caller(1), &id, Some(vec![7; 192]))
            .unwrap();
        assert_eq!(
            store.begin_root(caller(1), id, vec![1; 48], false, 2),
            Ok(RootAdmission::Cached(vec![7; 192]))
        );
        assert!(store
            .begin_root(
                caller(1),
                "request_0000000002".into(),
                vec![2; 48],
                false,
                DAY_NS * 2
            )
            .is_err());
        assert_eq!(
            store.begin_root(
                caller(1),
                format!("{}_request_0000000002", DAY_NS * 2 / 1_000_000),
                vec![2; 48],
                true,
                DAY_NS * 2
            ),
            Ok(RootAdmission::Dispatch)
        );
    }
    #[test]
    fn completed_receipts_are_bounded_but_recovery_is_not_lifetime_limited() {
        let mut store = AccountVaultStore::init(memories());
        for attempt in 0..(RETAINED_ROOT_ATTEMPTS + 10) {
            let now = (attempt as u64 + 1) * DAY_NS;
            let id = format!("{}_request_{attempt:016}", now / 1_000_000);
            store
                .begin_root(caller(1), id.clone(), vec![1; 48], attempt != 0, now)
                .unwrap();
            store.finish_root(caller(1), &id, None).unwrap();
            assert!(store
                .begin_root(caller(1), id, vec![1; 48], true, now)
                .is_err());
        }
        assert_eq!(
            store.roots.get(&caller(1)).unwrap().attempts.len(),
            RETAINED_ROOT_ATTEMPTS
        );
        assert!(store
            .begin_root(
                caller(1),
                format!("{}_request_0000000000000000", DAY_NS / 1_000_000),
                vec![1; 48],
                true,
                DAY_NS * 100
            )
            .is_err());
    }
    #[test]
    fn global_budget_bounds_sybil_principals_and_survives_upgrade() {
        let memories = memories();
        let mut store = AccountVaultStore::init(memories.clone());
        for n in 0..32 {
            store.admit_paid(caller(n), 1).unwrap();
        }
        assert!(store.admit_paid(caller(40), 1).is_err());
        drop(store);
        let mut store = AccountVaultStore::init(memories);
        assert!(store.admit_paid(caller(40), 1).is_err());
        store.admit_paid(caller(40), HOUR_NS + 1).unwrap();
        assert!(store.admit_paid(caller(41), HOUR_NS + 1).is_err());
    }
}
