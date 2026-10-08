//! Generic, encryption-blind durable delivery. This is not an OpenChat attestation service.
//! A recipient authorizes a bounded write capability; only that authenticated recipient may
//! retrieve or acknowledge records. Acknowledgement never saves an application entry.

use candid::{CandidType, Decode, Deserialize, Encode, Principal};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{Memory, StableBTreeMap, StableCell, Storable};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::ops::Bound::{Excluded, Included};

pub const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
pub const MAX_GRANT_LIFETIME_MS: u64 = 90 * 24 * 60 * 60 * 1_000;
pub const MAX_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_PAGE_BYTES: usize = 512 * 1024;
const PAGE_SIZE: usize = 16;
const MAX_SCAN: usize = 64;
const PRUNE_RECORDS: usize = 32;
const PRUNE_GRANTS: usize = 16;
const MAX_OWNER_GRANTS: u64 = 32;
const MAX_GRANTS: u64 = 1_024;
const MAX_OWNER_RECORDS: u64 = 4_096;
const MAX_RECORDS: u64 = 100_000;
const MAX_OWNER_PENDING: u64 = 256;
const MAX_GRANT_PENDING: u64 = 128;
const MAX_OWNER_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub enum InboxError {
    NotAuthorized,
    InvalidRequest,
    NotFound,
    Expired,
    Revoked,
    Conflict,
    Capacity,
    CounterExhausted,
}
pub type InboxResult<T> = Result<T, InboxError>;

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct CreateGrantRequest {
    pub app_id: String,
    pub app_revision: String,
    pub action_id: String,
    pub destination: String,
    pub recipient_key_id: String,
    pub recipient_context: String,
    pub write_capability_hash: Vec<u8>,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct InboxGrant {
    pub inbox_id: String,
    pub app_id: String,
    pub app_revision: String,
    pub action_id: String,
    pub destination: String,
    pub recipient_key_id: String,
    pub recipient_context: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct GrantPage {
    pub grants: Vec<InboxGrant>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct DepositRequest {
    pub inbox_id: String,
    pub write_capability: Vec<u8>,
    pub request_id: String,
    pub encrypted_payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub enum DeliveryStatus {
    Pending,
    Saved,
    Dismissed,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub enum Disposition {
    Saved,
    Dismissed,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct DeliveryReceipt {
    pub inbox_id: String,
    pub request_id: String,
    pub body_sha256: Vec<u8>,
    pub received_at_ms: u64,
    pub expires_at_ms: u64,
    pub status: DeliveryStatus,
    pub replayed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct ListInboxRequest {
    pub inbox_id: String,
    pub after_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct InboxItem {
    pub receipt: DeliveryReceipt,
    pub encrypted_payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct InboxPage {
    pub items: Vec<InboxItem>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
pub struct AcknowledgeRequest {
    pub inbox_id: String,
    pub request_id: String,
    pub body_sha256: Vec<u8>,
    pub disposition: Disposition,
}

#[derive(Clone, Default, Debug, PartialEq, Eq, CandidType, Deserialize)]
struct Usage {
    grants: u64,
    records: u64,
    pending: u64,
    bytes: u64,
}

#[derive(Clone, CandidType, Deserialize)]
struct StoredGrant {
    owner: Principal,
    grant: InboxGrant,
    capability_hash: Vec<u8>,
    pending: u64,
    records: u64,
    bytes: u64,
}

#[derive(Clone, CandidType, Deserialize)]
struct StoredRecord {
    owner: Principal,
    receipt: DeliveryReceipt,
    payload: Option<Vec<u8>>,
}

macro_rules! stable_candid {
    ($($name:ty),+ $(,)?) => {$ (
        impl Storable for $name {
            fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(Encode!(self).expect("inbox stable encode")) }
            fn from_bytes(bytes: Cow<[u8]>) -> Self { Decode!(bytes.as_ref(), Self).expect("inbox stable decode") }
            const BOUND: Bound = Bound::Unbounded;
        }
    )+};
}
stable_candid!(Usage, StoredGrant, StoredRecord);

/// The caller supplies eight fresh, independent stable memories. Existing layouts are untouched.
pub struct DurableInbox<M: Memory> {
    grants: StableBTreeMap<String, StoredGrant, M>,
    owner_grants: StableBTreeMap<String, u8, M>,
    records: StableBTreeMap<String, StoredRecord, M>,
    pending: StableBTreeMap<String, String, M>,
    record_expiry: StableBTreeMap<String, String, M>,
    owners: StableBTreeMap<Principal, Usage, M>,
    totals: StableCell<Usage, M>,
    grant_expiry: StableBTreeMap<String, String, M>,
}

impl<M: Memory> DurableInbox<M> {
    pub fn init(memories: [M; 8]) -> Self {
        let [grants, owner_grants, records, pending, record_expiry, owners, totals, grant_expiry] =
            memories;
        Self {
            grants: StableBTreeMap::init(grants),
            owner_grants: StableBTreeMap::init(owner_grants),
            records: StableBTreeMap::init(records),
            pending: StableBTreeMap::init(pending),
            record_expiry: StableBTreeMap::init(record_expiry),
            owners: StableBTreeMap::init(owners),
            totals: StableCell::init(totals, Usage::default()).expect("inbox usage init"),
            grant_expiry: StableBTreeMap::init(grant_expiry),
        }
    }

    pub fn create_grant(
        &mut self,
        owner: Principal,
        request: CreateGrantRequest,
        now: u64,
    ) -> InboxResult<InboxGrant> {
        authenticated(owner)?;
        validate_grant(&request, now)?;
        let inbox_id = grant_id(owner, &request.write_capability_hash);
        if let Some(stored) = self.grants.get(&inbox_id) {
            if stored.grant.revoked {
                return Err(InboxError::Revoked);
            }
            if stored.grant.expires_at_ms <= now {
                return Err(InboxError::Expired);
            }
            if !same_grant_request(&stored.grant, &request) {
                return Err(InboxError::Conflict);
            }
            return Ok(stored.grant);
        }
        self.prune(now);
        let mut usage = self.owners.get(&owner).unwrap_or_default();
        let mut totals = self.totals.get().clone();
        if usage.grants >= MAX_OWNER_GRANTS || totals.grants >= MAX_GRANTS {
            return Err(InboxError::Capacity);
        }
        usage.grants = increment(usage.grants)?;
        totals.grants = increment(totals.grants)?;
        let cleanup_at = request
            .expires_at_ms
            .checked_add(RETENTION_MS)
            .ok_or(InboxError::CounterExhausted)?;
        let grant = InboxGrant {
            inbox_id: inbox_id.clone(),
            app_id: request.app_id,
            app_revision: request.app_revision,
            action_id: request.action_id,
            destination: request.destination,
            recipient_key_id: request.recipient_key_id,
            recipient_context: request.recipient_context,
            created_at_ms: now,
            expires_at_ms: request.expires_at_ms,
            revoked: false,
        };
        self.grants.insert(
            inbox_id.clone(),
            StoredGrant {
                owner,
                grant: grant.clone(),
                capability_hash: request.write_capability_hash,
                pending: 0,
                records: 0,
                bytes: 0,
            },
        );
        self.owner_grants
            .insert(owner_grant_key(owner, &inbox_id), 0);
        self.grant_expiry
            .insert(expiry_key(cleanup_at, &inbox_id), inbox_id);
        self.owners.insert(owner, usage);
        self.set_totals(totals);
        Ok(grant)
    }

    pub fn list_grants(
        &mut self,
        owner: Principal,
        after: Option<String>,
        now: u64,
    ) -> InboxResult<GrantPage> {
        authenticated(owner)?;
        if after.as_ref().is_some_and(|id| !is_hex_id(id)) {
            return Err(InboxError::InvalidRequest);
        }
        self.prune(now);
        let prefix = format!("{}:", owner.to_text());
        let lower = after
            .map(|id| Excluded(format!("{prefix}{id}")))
            .unwrap_or_else(|| Included(prefix.clone()));
        let keys: Vec<_> = self
            .owner_grants
            .range((lower, Excluded(format!("{prefix}~"))))
            .take(PAGE_SIZE + 1)
            .collect();
        let more = keys.len() > PAGE_SIZE;
        let grants: Vec<_> = keys
            .into_iter()
            .take(PAGE_SIZE)
            .map(|(key, _)| {
                self.grants
                    .get(&key[prefix.len()..].to_string())
                    .expect("inbox grant index invariant")
                    .grant
            })
            .collect();
        let next = if more {
            grants.last().map(|grant| grant.inbox_id.clone())
        } else {
            None
        };
        Ok(GrantPage { grants, next })
    }

    pub fn revoke(&mut self, owner: Principal, inbox_id: String) -> InboxResult<bool> {
        let mut stored = self.owned_grant(owner, &inbox_id)?;
        let changed = !stored.grant.revoked;
        stored.grant.revoked = true;
        self.grants.insert(inbox_id, stored);
        Ok(changed)
    }

    pub fn deposit(&mut self, request: DepositRequest, now: u64) -> InboxResult<DeliveryReceipt> {
        if !is_hex_id(&request.inbox_id)
            || !is_request_id(&request.request_id)
            || request.write_capability.len() != 32
            || request.encrypted_payload.is_empty()
            || request.encrypted_payload.len() > MAX_PAYLOAD_BYTES
        {
            return Err(InboxError::InvalidRequest);
        }
        let mut grant = self
            .grants
            .get(&request.inbox_id)
            .ok_or(InboxError::NotAuthorized)?;
        if !equal_bytes(
            &Sha256::digest(&request.write_capability),
            &grant.capability_hash,
        ) {
            return Err(InboxError::NotAuthorized);
        }
        if grant.grant.revoked {
            return Err(InboxError::Revoked);
        }
        if grant.grant.expires_at_ms <= now {
            return Err(InboxError::Expired);
        }
        validate_payload(
            &request.encrypted_payload,
            &request.request_id,
            &grant.grant,
        )?;
        let digest = Sha256::digest(&request.encrypted_payload).to_vec();
        // Request identity is owner-scoped, not capability-scoped. Reconnecting cannot evade
        // an acknowledged tombstone by creating a second grant for the same recipient.
        let key = record_key(grant.owner, &request.request_id);
        if let Some(existing) = self.records.get(&key) {
            if existing.receipt.expires_at_ms > now {
                if !equal_bytes(&existing.receipt.body_sha256, &digest) {
                    return Err(InboxError::Conflict);
                }
                let mut receipt = existing.receipt;
                receipt.replayed = true;
                return Ok(receipt);
            }
            self.remove_record(&key, existing);
        }
        self.prune(now);
        // Pruning can change this grant's counters; re-read before capacity preflight.
        grant = self
            .grants
            .get(&request.inbox_id)
            .expect("live grant survives prune");
        let mut usage = self
            .owners
            .get(&grant.owner)
            .expect("inbox owner invariant");
        let mut totals = self.totals.get().clone();
        let bytes = request.encrypted_payload.len() as u64;
        let owner_bytes = usage
            .bytes
            .checked_add(bytes)
            .ok_or(InboxError::CounterExhausted)?;
        let total_bytes = totals
            .bytes
            .checked_add(bytes)
            .ok_or(InboxError::CounterExhausted)?;
        if usage.records >= MAX_OWNER_RECORDS
            || totals.records >= MAX_RECORDS
            || usage.pending >= MAX_OWNER_PENDING
            || grant.pending >= MAX_GRANT_PENDING
            || owner_bytes > MAX_OWNER_BYTES
            || total_bytes > MAX_TOTAL_BYTES
        {
            return Err(InboxError::Capacity);
        }
        let expires_at_ms = now
            .checked_add(RETENTION_MS)
            .ok_or(InboxError::CounterExhausted)?;
        usage.records = increment(usage.records)?;
        usage.pending = increment(usage.pending)?;
        usage.bytes = owner_bytes;
        totals.records = increment(totals.records)?;
        totals.pending = increment(totals.pending)?;
        totals.bytes = total_bytes;
        grant.records = increment(grant.records)?;
        grant.pending = increment(grant.pending)?;
        grant.bytes = grant
            .bytes
            .checked_add(bytes)
            .ok_or(InboxError::CounterExhausted)?;
        let receipt = DeliveryReceipt {
            inbox_id: request.inbox_id.clone(),
            request_id: request.request_id.clone(),
            body_sha256: digest,
            received_at_ms: now,
            expires_at_ms,
            status: DeliveryStatus::Pending,
            replayed: false,
        };
        self.records.insert(
            key.clone(),
            StoredRecord {
                owner: grant.owner,
                receipt: receipt.clone(),
                payload: Some(request.encrypted_payload),
            },
        );
        self.pending.insert(
            pending_key(&request.inbox_id, &request.request_id),
            key.clone(),
        );
        self.record_expiry
            .insert(expiry_key(expires_at_ms, &key), key);
        self.owners.insert(grant.owner, usage);
        self.grants.insert(request.inbox_id, grant);
        self.set_totals(totals);
        Ok(receipt)
    }

    pub fn list(
        &mut self,
        owner: Principal,
        request: ListInboxRequest,
        now: u64,
    ) -> InboxResult<InboxPage> {
        self.owned_grant(owner, &request.inbox_id)?;
        if request
            .after_id
            .as_ref()
            .is_some_and(|id| !is_request_id(id))
        {
            return Err(InboxError::InvalidRequest);
        }
        self.prune(now);
        let prefix = format!("{}:", request.inbox_id);
        let lower = request
            .after_id
            .map(|id| Excluded(format!("{prefix}{id}")))
            .unwrap_or_else(|| Included(prefix.clone()));
        let mut rows = self
            .pending
            .range((lower, Excluded(format!("{prefix}~"))))
            .peekable();
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut cursor = None;
        let mut scanned = 0;
        while let Some((index_key, record_key)) = rows.peek().cloned() {
            if scanned >= MAX_SCAN || items.len() >= PAGE_SIZE {
                break;
            }
            let record = self
                .records
                .get(&record_key)
                .expect("inbox pending index invariant");
            let payload = record.payload.expect("inbox pending payload invariant");
            if record.receipt.expires_at_ms > now && bytes + payload.len() + 4096 > MAX_PAGE_BYTES {
                break;
            }
            rows.next();
            scanned += 1;
            cursor = Some(index_key[prefix.len()..].to_string());
            if record.receipt.expires_at_ms <= now {
                continue;
            }
            bytes += payload.len() + 4096;
            items.push(InboxItem {
                receipt: record.receipt,
                encrypted_payload: payload,
            });
        }
        let next = if rows.peek().is_some() { cursor } else { None };
        Ok(InboxPage { items, next })
    }

    pub fn acknowledge(
        &mut self,
        owner: Principal,
        request: AcknowledgeRequest,
        now: u64,
    ) -> InboxResult<DeliveryReceipt> {
        let mut grant = self.owned_grant(owner, &request.inbox_id)?;
        if !is_request_id(&request.request_id) || request.body_sha256.len() != 32 {
            return Err(InboxError::InvalidRequest);
        }
        let key = record_key(owner, &request.request_id);
        let mut record = self.records.get(&key).ok_or(InboxError::NotFound)?;
        if record.receipt.inbox_id != request.inbox_id {
            return Err(InboxError::NotFound);
        }
        if !equal_bytes(&record.receipt.body_sha256, &request.body_sha256) {
            return Err(InboxError::Conflict);
        }
        if record.receipt.expires_at_ms <= now {
            return Err(InboxError::Expired);
        }
        let status = match request.disposition {
            Disposition::Saved => DeliveryStatus::Saved,
            Disposition::Dismissed => DeliveryStatus::Dismissed,
        };
        if record.payload.is_none() {
            if record.receipt.status != status {
                return Err(InboxError::Conflict);
            }
            let mut receipt = record.receipt;
            receipt.replayed = true;
            return Ok(receipt);
        }
        let bytes = record.payload.take().expect("checked payload").len() as u64;
        let mut usage = self.owners.get(&owner).expect("inbox owner invariant");
        let mut totals = self.totals.get().clone();
        decrease_pending(&mut usage, bytes);
        decrease_pending(&mut totals, bytes);
        grant.pending = grant.pending.checked_sub(1).expect("inbox pending counter");
        grant.bytes = grant.bytes.checked_sub(bytes).expect("inbox byte counter");
        record.receipt.status = status;
        let receipt = record.receipt.clone();
        self.pending
            .remove(&pending_key(&request.inbox_id, &request.request_id));
        self.records.insert(key, record);
        self.owners.insert(owner, usage);
        self.grants.insert(request.inbox_id, grant);
        self.set_totals(totals);
        Ok(receipt)
    }

    fn owned_grant(&self, owner: Principal, id: &str) -> InboxResult<StoredGrant> {
        authenticated(owner)?;
        if !is_hex_id(id) {
            return Err(InboxError::InvalidRequest);
        }
        let grant = self
            .grants
            .get(&id.to_string())
            .ok_or(InboxError::NotFound)?;
        if grant.owner != owner {
            return Err(InboxError::NotAuthorized);
        }
        Ok(grant)
    }

    fn set_totals(&mut self, totals: Usage) {
        self.totals.set(totals).expect("inbox usage write");
    }

    fn remove_record(&mut self, key: &str, record: StoredRecord) {
        let mut grant = self
            .grants
            .get(&record.receipt.inbox_id)
            .expect("inbox record grant invariant");
        let mut usage = self
            .owners
            .get(&record.owner)
            .expect("inbox owner invariant");
        let mut totals = self.totals.get().clone();
        if let Some(payload) = record.payload {
            decrease_pending(&mut usage, payload.len() as u64);
            decrease_pending(&mut totals, payload.len() as u64);
            grant.pending = grant.pending.checked_sub(1).expect("inbox pending counter");
            grant.bytes = grant
                .bytes
                .checked_sub(payload.len() as u64)
                .expect("inbox byte counter");
            self.pending.remove(&pending_key(
                &record.receipt.inbox_id,
                &record.receipt.request_id,
            ));
        }
        usage.records = usage.records.checked_sub(1).expect("inbox record counter");
        totals.records = totals.records.checked_sub(1).expect("inbox record counter");
        grant.records = grant.records.checked_sub(1).expect("inbox record counter");
        self.records.remove(&key.to_string());
        self.record_expiry
            .remove(&expiry_key(record.receipt.expires_at_ms, key));
        self.owners.insert(record.owner, usage);
        self.grants.insert(record.receipt.inbox_id, grant);
        self.set_totals(totals);
    }

    fn prune(&mut self, now: u64) {
        let end = format!("{now:016x}:~");
        let expired: Vec<_> = self
            .record_expiry
            .range(..=end.clone())
            .take(PRUNE_RECORDS)
            .collect();
        for (_, key) in expired {
            let record = self
                .records
                .get(&key)
                .expect("inbox expiry index invariant");
            self.remove_record(&key, record);
        }
        let expired: Vec<_> = self.grant_expiry.range(..=end).take(PRUNE_GRANTS).collect();
        for (expiry, id) in expired {
            let grant = self.grants.get(&id).expect("inbox grant expiry invariant");
            // A bounded record sweep may not have reached all this grant's expired records yet.
            if grant.records != 0 {
                continue;
            }
            let mut usage = self
                .owners
                .get(&grant.owner)
                .expect("inbox owner invariant");
            let mut totals = self.totals.get().clone();
            usage.grants = usage.grants.checked_sub(1).expect("inbox grant counter");
            totals.grants = totals.grants.checked_sub(1).expect("inbox grant counter");
            self.grants.remove(&id);
            self.grant_expiry.remove(&expiry);
            self.owner_grants.remove(&owner_grant_key(grant.owner, &id));
            if usage == Usage::default() {
                self.owners.remove(&grant.owner);
            } else {
                self.owners.insert(grant.owner, usage);
            }
            self.set_totals(totals);
        }
    }
}

fn authenticated(owner: Principal) -> InboxResult<()> {
    if owner == Principal::anonymous() || owner == Principal::management_canister() {
        Err(InboxError::NotAuthorized)
    } else {
        Ok(())
    }
}
fn increment(value: u64) -> InboxResult<u64> {
    value.checked_add(1).ok_or(InboxError::CounterExhausted)
}
fn decrease_pending(usage: &mut Usage, bytes: u64) {
    usage.pending = usage.pending.checked_sub(1).expect("inbox pending counter");
    usage.bytes = usage.bytes.checked_sub(bytes).expect("inbox byte counter");
}
fn equal_bytes(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
fn is_hex_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn is_request_id(value: &str) -> bool {
    canonical_base64url(value, 32, 32)
}
fn record_key(owner: Principal, request_id: &str) -> String {
    format!("{}:{request_id}", owner.to_text())
}
fn pending_key(inbox_id: &str, request_id: &str) -> String {
    format!("{inbox_id}:{request_id}")
}
fn owner_grant_key(owner: Principal, inbox_id: &str) -> String {
    format!("{}:{inbox_id}", owner.to_text())
}
fn expiry_key(at: u64, suffix: &str) -> String {
    format!("{at:016x}:{suffix}")
}
fn grant_id(owner: Principal, hash: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"app-encrypted-inbox/grant/v1\0");
    digest.update([owner.as_slice().len() as u8]);
    digest.update(owner.as_slice());
    digest.update(hash);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn same_grant_request(grant: &InboxGrant, request: &CreateGrantRequest) -> bool {
    grant.app_id == request.app_id
        && grant.app_revision == request.app_revision
        && grant.action_id == request.action_id
        && grant.destination == request.destination
        && grant.recipient_key_id == request.recipient_key_id
        && grant.recipient_context == request.recipient_context
        && grant.expires_at_ms == request.expires_at_ms
}
fn bounded_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn validate_grant(request: &CreateGrantRequest, now: u64) -> InboxResult<()> {
    if !bounded_text(&request.app_id, 128)
        || !bounded_text(&request.app_revision, 128)
        || !bounded_text(&request.action_id, 128)
        || !bounded_text(&request.destination, 2048)
        || !(request.destination.starts_with("https://")
            || request.destination.starts_with("http://"))
        || !is_hex_id(&request.recipient_key_id)
        || !canonical_base64url(&request.recipient_context, 1, 1536)
        || request.write_capability_hash.len() != 32
        || request.expires_at_ms <= now
        || request.expires_at_ms - now > MAX_GRANT_LIFETIME_MS
        || request.expires_at_ms.checked_add(RETENTION_MS).is_none()
    {
        Err(InboxError::InvalidRequest)
    } else {
        Ok(())
    }
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}
fn canonical_base64url(value: &str, min: usize, max: usize) -> bool {
    let length = value.len();
    if length == 0
        || length > (max * 4).div_ceil(3)
        || length % 4 == 1
        || value.bytes().any(|byte| base64_value(byte).is_none())
    {
        return false;
    }
    let bytes = length * 6 / 8;
    let last = base64_value(value.as_bytes()[length - 1]).expect("validated alphabet");
    bytes >= min
        && bytes <= max
        && match length % 4 {
            2 => last & 15 == 0,
            3 => last & 3 == 0,
            _ => true,
        }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EncryptedRequest {
    app_id: String,
    app_revision: String,
    action_id: String,
    destination: String,
    idempotency_key: String,
    envelope: EncryptedEnvelope,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EncryptedEnvelope {
    version: u8,
    scheme: String,
    key_id: String,
    recipient_context: String,
    ephemeral_public_key: String,
    salt: String,
    iv: String,
    ciphertext: String,
}
fn validate_payload(payload: &[u8], request_id: &str, grant: &InboxGrant) -> InboxResult<()> {
    let body: EncryptedRequest =
        serde_json::from_slice(payload).map_err(|_| InboxError::InvalidRequest)?;
    let envelope = &body.envelope;
    if body.app_id != grant.app_id
        || body.app_revision != grant.app_revision
        || body.action_id != grant.action_id
        || body.destination != grant.destination
        || body.idempotency_key != request_id
        || envelope.version != 1
        || envelope.scheme != "p256-hkdf-sha256-aes-256-gcm-v1"
        || envelope.key_id != grant.recipient_key_id
        || envelope.recipient_context != grant.recipient_context
        || !canonical_base64url(&envelope.ephemeral_public_key, 65, 65)
        || !canonical_base64url(&envelope.salt, 32, 32)
        || !canonical_base64url(&envelope.iv, 12, 12)
        || !canonical_base64url(&envelope.ciphertext, 17, 65552)
    {
        return Err(InboxError::InvalidRequest);
    }
    let public_key = envelope.ephemeral_public_key.as_bytes();
    if (base64_value(public_key[0]).unwrap() << 2) | (base64_value(public_key[1]).unwrap() >> 4)
        != 4
    {
        return Err(InboxError::InvalidRequest);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::VectorMemory;
    use serde_json::{json, Value};

    fn owner(id: u8) -> Principal {
        Principal::from_slice(&[id, 1])
    }
    fn memories() -> [VectorMemory; 8] {
        std::array::from_fn(|_| VectorMemory::default())
    }
    fn store() -> DurableInbox<VectorMemory> {
        DurableInbox::init(memories())
    }
    fn b64(bytes: &[u8]) -> String {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut output = String::new();
        for chunk in bytes.chunks(3) {
            output.push(alphabet[(chunk[0] >> 2) as usize] as char);
            output.push(
                alphabet[((chunk[0] & 3) << 4 | chunk.get(1).copied().unwrap_or(0) >> 4) as usize]
                    as char,
            );
            if chunk.len() > 1 {
                output.push(
                    alphabet
                        [((chunk[1] & 15) << 2 | chunk.get(2).copied().unwrap_or(0) >> 6) as usize]
                        as char,
                );
            }
            if chunk.len() > 2 {
                output.push(alphabet[(chunk[2] & 63) as usize] as char);
            }
        }
        output
    }
    fn request_id(id: u32) -> String {
        let mut bytes = [0; 32];
        bytes[..4].copy_from_slice(&id.to_be_bytes());
        b64(&bytes)
    }
    fn create_request(cap: u8, now: u64) -> CreateGrantRequest {
        CreateGrantRequest {
            app_id: "example".into(),
            app_revision: "v1".into(),
            action_id: "example.import".into(),
            destination: "https://example.com/import".into(),
            recipient_key_id: "a".repeat(64),
            recipient_context: b64(b"opaque recipient context"),
            write_capability_hash: Sha256::digest([cap; 32]).to_vec(),
            expires_at_ms: now + MAX_GRANT_LIFETIME_MS,
        }
    }
    fn grant(store: &mut DurableInbox<VectorMemory>, who: Principal, cap: u8) -> InboxGrant {
        store.create_grant(who, create_request(cap, 0), 0).unwrap()
    }
    fn body(grant: &InboxGrant, id: &str, ciphertext_bytes: usize) -> Value {
        let mut public_key = [0; 65];
        public_key[0] = 4;
        json!({
            "appId": grant.app_id, "appRevision": grant.app_revision, "actionId": grant.action_id,
            "destination": grant.destination, "idempotencyKey": id,
            "envelope": {
                "version": 1, "scheme": "p256-hkdf-sha256-aes-256-gcm-v1",
                "keyId": grant.recipient_key_id, "recipientContext": grant.recipient_context,
                "ephemeralPublicKey": b64(&public_key), "salt": b64(&[2; 32]), "iv": b64(&[3; 12]),
                "ciphertext": b64(&vec![4; ciphertext_bytes]),
            }
        })
    }
    fn deposit_request(grant: &InboxGrant, cap: u8, id: u32) -> DepositRequest {
        let request_id = request_id(id);
        DepositRequest {
            inbox_id: grant.inbox_id.clone(),
            write_capability: vec![cap; 32],
            encrypted_payload: serde_json::to_vec(&body(grant, &request_id, 17)).unwrap(),
            request_id,
        }
    }
    fn list_request(grant: &InboxGrant) -> ListInboxRequest {
        ListInboxRequest {
            inbox_id: grant.inbox_id.clone(),
            after_id: None,
        }
    }
    fn ack(receipt: &DeliveryReceipt, disposition: Disposition) -> AcknowledgeRequest {
        AcknowledgeRequest {
            inbox_id: receipt.inbox_id.clone(),
            request_id: receipt.request_id.clone(),
            body_sha256: receipt.body_sha256.clone(),
            disposition,
        }
    }

    #[test]
    fn capability_authorizes_write_but_never_cross_owner_reads_or_deletes() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        let request = deposit_request(&grant, 7, 1);
        let receipt = store.deposit(request.clone(), 1).unwrap();
        assert_eq!(
            store.list(owner(2), list_request(&grant), 2),
            Err(InboxError::NotAuthorized)
        );
        assert_eq!(
            store.acknowledge(owner(2), ack(&receipt, Disposition::Saved), 2),
            Err(InboxError::NotAuthorized)
        );
        assert_eq!(
            store.revoke(owner(2), grant.inbox_id.clone()),
            Err(InboxError::NotAuthorized)
        );
        assert_eq!(
            store.list_grants(owner(2), None, 2).unwrap().grants.len(),
            0
        );
        let mut wrong = request;
        wrong.write_capability[0] ^= 1;
        assert_eq!(store.deposit(wrong, 2), Err(InboxError::NotAuthorized));
        assert_eq!(
            store
                .list(owner(1), list_request(&grant), 2)
                .unwrap()
                .items
                .len(),
            1
        );
        for principal in [Principal::anonymous(), Principal::management_canister()] {
            assert_eq!(
                store.create_grant(principal, create_request(8, 0), 0),
                Err(InboxError::NotAuthorized)
            );
            assert_eq!(
                store.list_grants(principal, None, 0),
                Err(InboxError::NotAuthorized)
            );
        }
    }

    #[test]
    fn retry_is_exact_bytes_and_never_refreshes_expiry_or_replaces_ciphertext() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        let request = deposit_request(&grant, 7, 1);
        let original = store.deposit(request.clone(), 1).unwrap();
        let replay = store.deposit(request.clone(), 100).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.expires_at_ms, original.expires_at_ms);
        let mut changed = request.clone();
        changed.encrypted_payload.push(b' ');
        assert_eq!(store.deposit(changed, 100), Err(InboxError::Conflict));
        let page = store.list(owner(1), list_request(&grant), 100).unwrap();
        assert_eq!(page.items[0].encrypted_payload, request.encrypted_payload);
        assert_eq!(store.totals.get().records, 1);
    }

    #[test]
    fn exact_acknowledgement_is_idempotent_and_tombstone_blocks_reconnect_replay() {
        let mut store = store();
        let grant1 = grant(&mut store, owner(1), 7);
        let request = deposit_request(&grant1, 7, 1);
        let receipt = store.deposit(request.clone(), 1).unwrap();
        let other = store.deposit(deposit_request(&grant1, 7, 2), 1).unwrap();
        let mut wrong = ack(&receipt, Disposition::Saved);
        wrong.body_sha256[0] ^= 1;
        assert_eq!(
            store.acknowledge(owner(1), wrong, 2),
            Err(InboxError::Conflict)
        );
        let saved = store
            .acknowledge(owner(1), ack(&receipt, Disposition::Saved), 2)
            .unwrap();
        assert_eq!(saved.status, DeliveryStatus::Saved);
        assert!(
            store
                .acknowledge(owner(1), ack(&receipt, Disposition::Saved), 2)
                .unwrap()
                .replayed
        );
        assert_eq!(
            store.acknowledge(owner(1), ack(&receipt, Disposition::Dismissed), 2),
            Err(InboxError::Conflict)
        );
        let page = store.list(owner(1), list_request(&grant1), 2).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].receipt.request_id, other.request_id);
        let grant2 = grant(&mut store, owner(1), 8);
        let mut replay = request;
        replay.inbox_id = grant2.inbox_id.clone();
        replay.write_capability = vec![8; 32];
        let replayed = store.deposit(replay, 3).unwrap();
        assert_eq!(replayed.status, DeliveryStatus::Saved);
        assert_eq!(replayed.inbox_id, grant1.inbox_id);
        assert!(replayed.replayed);
        assert!(store
            .list(owner(1), list_request(&grant2), 3)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(store.totals.get().records, 2);
        assert_eq!(store.totals.get().pending, 1);
    }

    #[test]
    fn pending_drafts_survive_revoke_and_expired_grant_without_allowing_new_writes() {
        let mut store = store();
        let mut args = create_request(7, 0);
        args.expires_at_ms = 100;
        let grant = store.create_grant(owner(1), args.clone(), 0).unwrap();
        let request = deposit_request(&grant, 7, 1);
        let receipt = store.deposit(request.clone(), 1).unwrap();
        assert_eq!(
            store.deposit(request.clone(), 100),
            Err(InboxError::Expired)
        );
        assert_eq!(
            store
                .list(owner(1), list_request(&grant), 100)
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(store.revoke(owner(1), grant.inbox_id.clone()).unwrap());
        assert!(!store.revoke(owner(1), grant.inbox_id.clone()).unwrap());
        assert_eq!(store.deposit(request, 2), Err(InboxError::Revoked));
        assert_eq!(
            store.create_grant(owner(1), args, 2),
            Err(InboxError::Revoked)
        );
        assert_eq!(
            store
                .acknowledge(owner(1), ack(&receipt, Disposition::Dismissed), 101)
                .unwrap()
                .status,
            DeliveryStatus::Dismissed
        );
    }

    #[test]
    fn payload_and_tombstone_survive_stable_reopen() {
        let memories = memories();
        let mut store = DurableInbox::init(memories.clone());
        let grant = grant(&mut store, owner(1), 7);
        let request = deposit_request(&grant, 7, 1);
        let receipt = store.deposit(request.clone(), 1).unwrap();
        let pending = store.deposit(deposit_request(&grant, 7, 2), 1).unwrap();
        store
            .acknowledge(owner(1), ack(&receipt, Disposition::Saved), 2)
            .unwrap();
        drop(store);
        let mut reopened = DurableInbox::init(memories);
        let page = reopened.list(owner(1), list_request(&grant), 3).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].receipt.request_id, pending.request_id);
        assert_eq!(
            reopened.deposit(request, 3).unwrap().status,
            DeliveryStatus::Saved
        );
        assert_eq!(reopened.totals.get().records, 2);
        assert_eq!(reopened.totals.get().pending, 1);
    }

    #[test]
    fn logical_retention_is_exact_and_pruning_is_bounded() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        for id in 0..100 {
            store.deposit(deposit_request(&grant, 7, id), 1).unwrap();
        }
        assert!(!store
            .list(owner(1), list_request(&grant), RETENTION_MS)
            .unwrap()
            .items
            .is_empty());
        let page = store
            .list(owner(1), list_request(&grant), RETENTION_MS + 1)
            .unwrap();
        assert!(page.items.is_empty());
        assert!(page.next.is_some());
        assert_eq!(store.totals.get().records, 100 - PRUNE_RECORDS as u64);
        for _ in 0..3 {
            store.list_grants(owner(1), None, RETENTION_MS + 1).unwrap();
        }
        assert_eq!(store.totals.get().records, 0);
        assert_eq!(store.totals.get().bytes, 0);
    }

    #[test]
    fn grant_cleanup_waits_until_every_record_is_pruned() {
        let mut store = store();
        let mut args = create_request(7, 0);
        args.expires_at_ms = 10;
        let grant = store.create_grant(owner(1), args.clone(), 0).unwrap();
        for id in 0..100 {
            store.deposit(deposit_request(&grant, 7, id), 9).unwrap();
        }
        for count in [68, 36, 4] {
            let page = store
                .list_grants(owner(1), None, RETENTION_MS + 10)
                .unwrap();
            assert_eq!(page.grants.len(), 1);
            assert_eq!(store.totals.get().records, count);
        }
        assert!(store
            .list_grants(owner(1), None, RETENTION_MS + 10)
            .unwrap()
            .grants
            .is_empty());
        assert_eq!(store.totals.get(), &Usage::default());
        assert_eq!(
            store.create_grant(owner(1), args, RETENTION_MS + 10),
            Err(InboxError::InvalidRequest)
        );
    }

    #[test]
    fn capacity_rejects_without_eviction_but_duplicate_and_ack_release_work() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        let first = store.deposit(deposit_request(&grant, 7, 0), 1).unwrap();
        for id in 1..MAX_GRANT_PENDING {
            store
                .deposit(deposit_request(&grant, 7, id as u32), 1)
                .unwrap();
        }
        let before = store.totals.get().clone();
        assert_eq!(
            store.deposit(deposit_request(&grant, 7, 1_000), 2),
            Err(InboxError::Capacity)
        );
        assert_eq!(store.totals.get(), &before);
        assert!(
            store
                .deposit(deposit_request(&grant, 7, 0), 2)
                .unwrap()
                .replayed
        );
        store
            .acknowledge(owner(1), ack(&first, Disposition::Dismissed), 2)
            .unwrap();
        store.deposit(deposit_request(&grant, 7, 1_000), 2).unwrap();
        assert_eq!(store.totals.get().pending, MAX_GRANT_PENDING);
        assert_eq!(store.totals.get().records, MAX_GRANT_PENDING + 1);
    }

    #[test]
    fn grant_quota_and_pagination_are_owner_scoped_and_bounded() {
        let mut store = store();
        for cap in 0..MAX_OWNER_GRANTS {
            grant(&mut store, owner(1), cap as u8);
        }
        assert_eq!(
            store.create_grant(owner(1), create_request(100, 0), 0),
            Err(InboxError::Capacity)
        );
        grant(&mut store, owner(2), 100);
        let first = store.list_grants(owner(1), None, 1).unwrap();
        assert_eq!(first.grants.len(), 16);
        let second = store.list_grants(owner(1), first.next, 1).unwrap();
        assert_eq!(second.grants.len(), 16);
        assert_eq!(second.next, None);
        assert!(first.grants.iter().all(|left| second
            .grants
            .iter()
            .all(|right| left.inbox_id != right.inbox_id)));
    }

    #[test]
    fn pending_pagination_respects_byte_budget_and_never_skips_next_item() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        for id in 0..7 {
            let mut request = deposit_request(&grant, 7, id);
            request.encrypted_payload =
                serde_json::to_vec(&body(&grant, &request.request_id, 65552)).unwrap();
            store.deposit(request, 1).unwrap();
        }
        let first = store.list(owner(1), list_request(&grant), 2).unwrap();
        assert!(first.items.len() < 7);
        assert!(!first.items.is_empty());
        assert!(first.next.is_some());
        assert!(Encode!(&first).unwrap().len() < MAX_PAGE_BYTES);
        let second = store
            .list(
                owner(1),
                ListInboxRequest {
                    inbox_id: grant.inbox_id.clone(),
                    after_id: first.next.clone(),
                },
                2,
            )
            .unwrap();
        assert_eq!(first.items.len() + second.items.len(), 7);
        assert_eq!(second.next, None);
        assert!(first.items.iter().all(|left| second
            .items
            .iter()
            .all(|right| left.receipt.request_id != right.receipt.request_id)));
    }

    #[test]
    fn rejects_plaintext_extra_fields_duplicate_keys_and_every_binding_change() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        let request = deposit_request(&grant, 7, 1);
        for field in [
            "appId",
            "appRevision",
            "actionId",
            "destination",
            "idempotencyKey",
        ] {
            let mut payload = body(&grant, &request.request_id, 17);
            payload[field] = json!("wrong");
            let mut changed = request.clone();
            changed.encrypted_payload = serde_json::to_vec(&payload).unwrap();
            assert_eq!(store.deposit(changed, 1), Err(InboxError::InvalidRequest));
        }
        for field in [
            "keyId",
            "recipientContext",
            "scheme",
            "salt",
            "iv",
            "ephemeralPublicKey",
            "ciphertext",
        ] {
            let mut payload = body(&grant, &request.request_id, 17);
            payload["envelope"][field] = json!("wrong");
            let mut changed = request.clone();
            changed.encrypted_payload = serde_json::to_vec(&payload).unwrap();
            assert_eq!(store.deposit(changed, 1), Err(InboxError::InvalidRequest));
        }
        let mut payload = body(&grant, &request.request_id, 17);
        payload["fields"] = json!({"private":"plaintext"});
        let mut changed = request.clone();
        changed.encrypted_payload = serde_json::to_vec(&payload).unwrap();
        assert_eq!(store.deposit(changed, 1), Err(InboxError::InvalidRequest));
        let mut changed = request.clone();
        let original = String::from_utf8(changed.encrypted_payload).unwrap();
        changed.encrypted_payload =
            format!("{{\"appId\":\"example\",{}", &original[1..]).into_bytes();
        assert_eq!(store.deposit(changed, 1), Err(InboxError::InvalidRequest));
        assert_eq!(store.totals.get().records, 0);
    }

    #[test]
    fn canonical_binary_and_expiry_boundaries_fail_closed() {
        for length in [1, 12, 17, 32, 65, 1536, 65552] {
            assert!(canonical_base64url(&b64(&vec![5; length]), length, length));
        }
        assert!(!is_request_id(&format!("{}B", "A".repeat(42))));
        assert!(!canonical_base64url("AA==", 1, 1));
        let mut store = store();
        for expiry in [0, MAX_GRANT_LIFETIME_MS + 1, u64::MAX] {
            let mut request = create_request(7, 0);
            request.expires_at_ms = expiry;
            assert_eq!(
                store.create_grant(owner(1), request, 0),
                Err(InboxError::InvalidRequest)
            );
        }
        let grant = grant(&mut store, owner(1), 7);
        let mut request = deposit_request(&grant, 7, 1);
        request.encrypted_payload = vec![0; MAX_PAYLOAD_BYTES + 1];
        assert_eq!(store.deposit(request, 1), Err(InboxError::InvalidRequest));
    }

    #[test]
    fn arithmetic_failure_never_partially_deposits() {
        let mut store = store();
        let grant = grant(&mut store, owner(1), 7);
        let mut totals = store.totals.get().clone();
        totals.bytes = u64::MAX;
        store.set_totals(totals.clone());
        assert_eq!(
            store.deposit(deposit_request(&grant, 7, 1), 1),
            Err(InboxError::CounterExhausted)
        );
        assert_eq!(store.totals.get(), &totals);
        assert_eq!(store.records.len(), 0);
        assert_eq!(store.pending.len(), 0);
    }

    #[test]
    fn stable_grant_revocation_rejects_late_create_and_deposit_after_reopen() {
        let memories = memories();
        let mut store = DurableInbox::init(memories.clone());
        let grant = grant(&mut store, owner(1), 7);
        let request = deposit_request(&grant, 7, 1);
        store.revoke(owner(1), grant.inbox_id.clone()).unwrap();
        drop(store);
        let mut store = DurableInbox::init(memories);
        assert_eq!(store.deposit(request, 1), Err(InboxError::Revoked));
        assert_eq!(
            store.create_grant(owner(1), create_request(7, 0), 1),
            Err(InboxError::Revoked)
        );
        assert!(store.list_grants(owner(1), None, 1).unwrap().grants[0].revoked);
    }

    #[test]
    fn retrying_grant_cannot_change_its_binding_or_expiration() {
        let mut store = store();
        let original = grant(&mut store, owner(1), 7);
        assert_eq!(
            store
                .create_grant(owner(1), create_request(7, 0), 1)
                .unwrap(),
            original
        );
        for field in 0..7 {
            let mut request = create_request(7, 0);
            match field {
                0 => request.app_id.push('2'),
                1 => request.app_revision.push('2'),
                2 => request.action_id.push('2'),
                3 => request.destination.push('2'),
                4 => request.recipient_key_id = "b".repeat(64),
                5 => request.recipient_context = b64(b"changed context"),
                _ => request.expires_at_ms -= 1,
            }
            assert_eq!(
                store.create_grant(owner(1), request, 1),
                Err(InboxError::Conflict)
            );
        }
        assert_eq!(
            store.list_grants(owner(1), None, 1).unwrap().grants,
            vec![original]
        );
    }

    #[test]
    fn host_wrapper_keeps_fresh_stable_regions_and_separates_anonymous_deposit() {
        let source = include_str!("lib.rs");
        assert!(source.contains("const SCHEMA_VERSION: u32 = 19;"));
        assert!(source.contains("MemoryId::new(30 + index as u8)"));
        let inspect = source
            .split("fn inspect_message() {")
            .nth(1)
            .unwrap()
            .split("// ───────────────────────── Phase 1 endpoints")
            .next()
            .unwrap();
        let auth_start = inspect.find("let require_auth_methods").unwrap();
        let (allowed, auth) = inspect.split_at(auth_start);
        for method in [
            "create_encrypted_inbox_grant",
            "list_encrypted_inbox_grants",
            "revoke_encrypted_inbox_grant",
            "list_encrypted_inbox",
            "acknowledge_encrypted_inbox",
        ] {
            assert!(allowed.contains(&format!("\"{method}\"")));
            assert!(auth.contains(&format!("\"{method}\"")));
        }
        assert!(allowed.contains("\"deposit_encrypted_inbox\""));
        assert!(!auth.contains("\"deposit_encrypted_inbox\""));
    }
}
