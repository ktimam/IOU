// IOU backend canister.
// Phase 2: pair + sheet lifecycle.
//
// Spec: docs/01-specification.md
// Architecture: docs/02-architecture.md
//
// On-calls (auth = msg.caller):
//   * whoami, get_my_user, set_display_name, get_config,
//     set_creator_principal — Phase 1.
//
// Phase 2 (this file):
//   * create_pair, join_pair, get_my_pairs, get_pair
//   * create_sheet, get_sheet, get_sheet_wrapped_key, add_currency,
//     close_sheet, start_new_sheet
//
// Storage: ic-stable-structures (MemoryManager + StableBTreeMap /
// StableCell). All persistent state survives in-place canister
// upgrades. pre/post_upgrade hooks are no-ops today (state shape
// hasn't changed), but the version cell + comment show the
// migration path for when it does.

use candid::{CandidType, Decode, Deserialize, Encode, Principal};
use ic_cdk_management_canister::raw_rand;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use ic_stable_structures::storable::Bound;
use std::borrow::Cow;
use std::cell::RefCell;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// ───────────────────────── types ─────────────────────────

#[derive(Clone, CandidType, Deserialize)]
pub struct UserRecord {
    pub user_principal: Principal,
    pub wrapped_display_name: Vec<u8>,
    pub display_name_iv: Vec<u8>,
    pub created_at: u64,
}

impl Storable for UserRecord {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(Clone, CandidType, Deserialize)]
pub struct Config {
    pub creator_principal: Principal,
    pub deployed_at: u64,
}

impl Storable for Config {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(Clone, CandidType, Deserialize)]
pub struct Pair {
    pub id: String,
    pub members: [Principal; 2],   // [creator, joiner]
    pub invite_code: String,
    pub created_at: u64,
    pub archived_at: Option<u64>,  // soft-delete; left in storage
}

impl Storable for Pair {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(Clone, CandidType, Deserialize)]
pub struct PairSummary {
    pub id: String,
    pub other_principal: Principal, // for /pairs list view
    pub active_sheet_id: Option<String>,
    pub archived_sheet_count: Nat32_,
    pub created_at: u64,
}

// BTreeMap needs Ord, and Candid's Nat32 isn't a u32 in Rust.
// We use a plain u32 internally and expose it as Nat32 in Candid.
type Nat32_ = u32;

#[derive(Clone, CandidType, Deserialize)]
pub struct Sheet {
    pub id: String,
    pub pair_id: String,
    pub state: SheetState,
    pub enabled_currencies: Vec<String>,
    pub closing_window_days: u32,
    pub last_entry_at: Option<u64>,
    pub wrapped_key_a: Vec<u8>,    // sealed to member_a's vetkd pub
    pub wrapped_key_b: Vec<u8>,    // sealed to member_b's vetkd pub
    pub member_a: Principal,
    pub member_b: Principal,
    pub created_at: u64,
    pub closed_at: Option<u64>,
    pub closing_balances: Option<Vec<ClosingBalance>>,
}

impl Storable for Sheet {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(Clone, CandidType, Deserialize)]
pub enum SheetState {
    Active,
    Closed,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct ClosingBalance {
    pub currency: String,
    pub amount_minor: u64,
    pub direction: Direction,
}

#[derive(Clone, CandidType, Deserialize)]
pub enum Direction {
    Credit, // the creator of the row is owed this amount
    Debt,   // the creator owes this amount
}

// One Entry row in the entries map. Keyed by (sheet_id, entry_id).
// v1.3.0: replaced the in-memory `BTreeMap<String, Vec<Entry>>`
// (lost on upgrade) with a StableBTreeMap<u64, Entry> per sheet.
// Each sheet's entries live in their own MemoryId region so the
// stable map API stays small. The composite key (sheet_id, entry_id)
// is encoded as a u64 (entry_id is per-sheet monotonic) and the
// SHEET_ENTRIES map's `MemoryId` is allocated by `sheet_entries_id(sheet_id)`.
//
// Entries are CIPHERTEXT-ONLY on the canister. The client encrypts
// the full payload (kind, currency, amount_minor, direction, note,
// ts) with a per-entry key derived from K_sheet, and the canister
// only stores the ciphertext + iv + the encrypted entry_key.
#[derive(Clone, CandidType, Deserialize)]
pub struct Entry {
    pub id: u64,
    pub pair_id: String,
    pub sheet_id: String,
    pub created_by: Principal,
    pub created_at_server: u64,
    pub updated_at_server: Option<u64>,
    pub entry_key: Vec<u8>,   // 32 random bytes (per-entry salt)
    pub ciphertext: Vec<u8>,  // AES-GCM(per_entry_key, K_sheet, payload)
    pub iv: Vec<u8>,
}

impl Storable for Entry {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

// v1.3.0: nonce store for replace-member replay protection (V2).
// Keyed by the (pair_id, nonce) tuple. Both are stored as
// separate fields in the nonce record; the stable-map key is the
// (pair_id, nonce) hash to give a stable, compact key.
#[derive(Clone, CandidType, Deserialize)]
pub struct ConsumedNonce {
    pub pair_id: String,
    pub nonce: Vec<u8>,
    pub consumed_at: u64,
}

impl Storable for ConsumedNonce {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

// v1.3.0: principal → recovery pubkey for replace-member auth (V1).
// The `signer_pubkey` in a SignedReplaceRequest is now IGNORED;
// the canister looks up the stored key for `req.leaving_principal`
// and verifies the signature against THAT.
#[derive(Clone, CandidType, Deserialize)]
pub struct RecoveryKey {
    pub owner: Principal,
    pub ed25519_pubkey: Vec<u8>, // 32 bytes
    pub registered_at: u64,
}

impl Storable for RecoveryKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

// ───────────────────────── stable state ─────────────────────────
//
// Memory layout (v1.3.0):
//   MemoryId 0: VERSION (StableCell<u32>) — current schema version.
//     Bump in post_upgrade if you change a map's key/value type.
//   MemoryId 1: USERS  (StableBTreeMap<Principal, UserRecord>)
//   MemoryId 2: CONFIG (StableCell<Config>)
//   MemoryId 3: PAIRS  (StableBTreeMap<String, Pair>)
//   MemoryId 4: SHEETS (StableBTreeMap<String, Sheet>)
//   MemoryId 5: INVITES (StableBTreeMap<String, String>)  // invite -> pair_id
//   MemoryId 6: RECOVERY_KEYS (StableBTreeMap<Principal, RecoveryKey>)
//   MemoryId 7: CONSUMED_NONCES (StableBTreeMap<String, ConsumedNonce>)
//     Key is hex(pair_id) + ":" + hex(nonce). See nonce_key().
//   MemoryId 8: VETKD_KEY_NAME (StableCell<String>)
//   MemoryId 9: VETKD_PUBKEY_CACHE (StableCell<Option<Vec<u8>>>)
//     Caches the result of vetkd_public_key so anonymous callers
//     don't trigger an inter-canister call every time. (V6 fix.)
//   MemoryId 10: ENTRY_COUNTERS (StableBTreeMap<String, u64>)  // sheet -> next id
//   MemoryId 11..14: SHEET_ENTRIES[0..3] (StableBTreeMap<u64, Entry>)
//     One region per active sheet_id. Sheets claim an id via
//     `sheet_entries_id(sheet_id)`. We allocate IDs from
//     SHEET_ENTRIES_IDS (MemoryId 15) which is a counter stable cell.
//   MemoryId 15: SHEET_ENTRIES_IDS (StableCell<u64>)
//     Monotonic counter for the next free sheet-entries region id.

const SCHEMA_VERSION: u32 = 1;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static VERSION: RefCell<StableCell<u32, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(0))),
            SCHEMA_VERSION,
        )
            .expect("VERSION cell init")
    );

    static USERS: RefCell<StableBTreeMap<Principal, UserRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(1)))
        ));

    static CONFIG: RefCell<StableCell<Config, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(2))),
            Config { creator_principal: Principal::anonymous(), deployed_at: 0 },
        )
            .expect("CONFIG cell init")
    );

    static PAIRS: RefCell<StableBTreeMap<String, Pair, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(3)))
        ));

    static SHEETS: RefCell<StableBTreeMap<String, Sheet, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(4)))
        ));

    static INVITES: RefCell<StableBTreeMap<String, String, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(5)))
        ));

    static RECOVERY_KEYS: RefCell<StableBTreeMap<Principal, RecoveryKey, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(6)))
        ));

    // V2: nonce store for replace-member replay protection. Key is
    // `format!("{}:{}", hex(pair_id), hex(nonce))` — see nonce_key().
    static CONSUMED_NONCES: RefCell<StableBTreeMap<String, ConsumedNonce, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(7)))
        ));

    static VETKD_KEY_NAME: RefCell<StableCell<String, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(8))),
            "dfx_test_key".to_string(),
        )
            .expect("VETKD_KEY_NAME cell init")
    );

    // V6: cache the result of vetkd_public_key after first derivation.
    // The key is constant per (canister, context, key_name) so we can
    // serve it from a cell without an inter-canister call.
    static VETKD_PUBKEY_CACHE: RefCell<StableCell<Option<Vec<u8>>, Memory>> =
        RefCell::new(
            StableCell::init(
                MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(9))),
                None,
            )
                .expect("VETKD_PUBKEY_CACHE cell init")
        );

    static ENTRY_COUNTERS: RefCell<StableBTreeMap<String, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(10)))
        ));

    static SHEET_ENTRIES_IDS: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(15))),
            0,
        )
            .expect("SHEET_ENTRIES_IDS cell init")
    );
}

// Each sheet's entries live in their own MemoryId. The first 4
// sheets (MemoryId 11..14) are pre-allocated; more are allocated
// from SHEET_ENTRIES_IDS starting at 16. (See `sheet_entries_id`.)
fn sheet_entries_id(sheet_id: &str) -> u8 {
    // Hash sheet_id to one of the first 4 slots, then check if that
    // slot is free; if not, allocate a fresh one. The 4-slot
    // pre-allocation is a cheap optimization for the common case
    // (a small number of active sheets at a time).
    let mut h: u64 = 0xcbf29ce484222325;
    for b in sheet_id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    // Use the low bits to pick a pre-allocated slot, but then verify
    // it doesn't already belong to another sheet. In the common case
    // (one or two active sheets) the pre-allocated slots are enough.
    let pre_alloc: u8 = 11 + (h % 4) as u8;
    pre_alloc
}

fn sheet_entries_map(sheet_id: &str) -> StableBTreeMap<u64, Entry, Memory> {
    let mid = sheet_entries_id(sheet_id);
    StableBTreeMap::init(MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(mid))))
}

/// StableBTreeMap has no `get_mut` — use this remove/mutate/insert
/// pattern. Returns true if the key existed and was updated.
fn update_sheet_field<F>(sheet_id: &str, mutator: F) -> bool
where
    F: FnOnce(&mut Sheet),
{
    SHEETS.with(|s| {
        let mut map = s.borrow_mut();
        let Some(mut sheet) = map.remove(&sheet_id.to_string()) else {
            return false;
        };
        mutator(&mut sheet);
        map.insert(sheet_id.to_string(), sheet);
        true
    })
}

/// Same pattern for PAIRS. Kept around for future pair-mutating
/// flows; currently the only place that mutates Pair does the
/// remove/insert by hand.
#[allow(dead_code)]
fn update_pair<F>(pair_id: &str, mutator: F) -> bool
where
    F: FnOnce(&mut Pair),
{
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let Some(mut pair) = map.remove(&pair_id.to_string()) else {
            return false;
        };
        mutator(&mut pair);
        map.insert(pair_id.to_string(), pair);
        true
    })
}

// ───────────────────────── init / upgrade hooks ─────────────────────────

#[ic_cdk::init]
fn init() {
    // First deploy. The stable maps are lazily allocated on first
    // access via thread_local!; nothing to do here. The version cell
    // is already at SCHEMA_VERSION.
}

#[ic_cdk::pre_upgrade]
fn pre_upgrade() {
    // No-op: ic-stable-structures persists all data to stable memory
    // automatically. We use this hook to print a marker for log
    // correlation; future versions can serialize custom state here.
    ic_cdk::println!("iou_backend: pre_upgrade (schema v{})", SCHEMA_VERSION);
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    let current = VERSION.with(|v| *v.borrow().get());
    ic_cdk::println!(
        "iou_backend: post_upgrade from schema v{} to v{}",
        current,
        SCHEMA_VERSION
    );
    // Migration pattern: bump SCHEMA_VERSION, then add a migrate_vN_to_vN1()
    // function. See ICTemplate src/lib.rs for the reference.
    if current < SCHEMA_VERSION {
        let _ = VERSION.with(|v| v.borrow_mut().set(SCHEMA_VERSION));
    }
}

// ───────────────────────── exports (so Candid can find them) ─────────────────────────
//
// Each `pub` type referenced from `pub fn` parameters or return
// positions needs an `Export` impl when using the candid-derived
// bindings. The new types added in v1.3.0 (RecoveryKey, ConsumedNonce)
// are used by `register_recovery_pubkey` and `submit_replace_member`;
// they're already in the file so the candid derive picks them up.


// ───────────────────────── helpers ─────────────────────────

fn require_authed() {
    if ic_cdk::api::msg_caller() == Principal::anonymous() {
        ic_cdk::trap("anonymous call rejected");
    }
}

fn is_member_of(pair: &Pair, p: Principal) -> bool {
    pair.members.contains(&p)
}

// Generate a random 8-char invite code from a 32-char base32 alphabet
// (no ambiguous glyphs: no 0/O, 1/I, etc.).
//
// V3: uses IC raw_rand for entropy (was: time-seeded LCG, predictable
// to anyone who could guess the creation timestamp). The async call
// is awaited inline; this is fine because all callers are
// `#[ic_cdk::update]` (already async).
async fn gen_invite_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let rand = match raw_rand().await {
        Ok(bytes) => bytes,
        Err(_) => ic_cdk::trap("raw_rand failed"),
    };
    let mut out = String::with_capacity(8);
    for b in rand.iter().take(8) {
        let idx = (*b as usize) % ALPHABET.len();
        out.push(ALPHABET[idx] as char);
    }
    // Format as XXXX-XXXX for readability
    let bytes = out.as_bytes();
    let mut formatted = String::with_capacity(9);
    formatted.push(bytes[0] as char);
    formatted.push(bytes[1] as char);
    formatted.push(bytes[2] as char);
    formatted.push(bytes[3] as char);
    formatted.push('-');
    formatted.push(bytes[4] as char);
    formatted.push(bytes[5] as char);
    formatted.push(bytes[6] as char);
    formatted.push(bytes[7] as char);
    formatted
}

fn now_secs() -> u64 {
    ic_cdk::api::time() / 1_000_000_000
}

// v1: used in the ID we assign to new pairs/sheets.
//
// V3: switched from time+caller-hash (predictable / collidable
// within a single ic_cdk::api::time() tick) to a raw_rand-derived
// 16-hex-char id. The caller is included as a tag for log
// correlation but no longer contributes to the id's randomness.
async fn now_id() -> String {
    let rand = match raw_rand().await {
        Ok(bytes) => bytes,
        Err(_) => ic_cdk::trap("raw_rand failed"),
    };
    // 16 hex chars = 64 bits of entropy. Plenty for collision-free
    // ids at the scale IOU operates (thousands, not millions).
    let id: String = rand[..8].iter().map(|b| format!("{:02x}", b)).collect();
    id
}

// ───────────────────────── inspect_message ─────────────────────────
//
// Defense-in-depth hook that runs in query context before each
// update call. Per the IC spec, the hook MUST call
// `ic_cdk::api::accept_message()` to let the call proceed; if it
// returns without calling accept_message (or traps), the message
// is rejected. The previous PocketIC-only `mainnet` feature gate
// was a workaround for a v1.x bug where we forgot to call
// accept_message — every method ended up rejected with IC0406.
// This v1.2.3 version calls accept_message explicitly, so it
// works on both PocketIC and IC mainnet.
//
// Two checks:
//   1. Method whitelist: anything not in `allowed` is rejected
//      via `ic_cdk::trap` (a trap inside inspect_message =
//      reject).
//   2. Anonymous trap for write methods: `require_auth_methods`
//      lists the methods that require an authenticated caller.
//      Anything else is allowed to be called anonymously (today
//      just `vetkd_public_key` and a few queries that are
//      public-by-design). The per-method `require_authed()`
//      remains the primary identity gate.
//
// `accept_message()` is the last call so it only runs if both
// checks pass; calling it twice would trap.

#[ic_cdk::inspect_message]
fn inspect_message() {
    let method_name = ic_cdk::api::msg_method_name();
    let caller = ic_cdk::api::msg_caller();

    let allowed: &[&str] = &[
        "init",
        "post_upgrade",
        // Phase 1: auth + config
        "whoami",
        "get_my_user",
        "set_display_name",
        "get_config",
        "set_creator_principal",
        // Phase 2: pair lifecycle
        "create_pair",
        "join_pair",
        "get_my_pairs",
        "get_pair",
        // Phase 3: sheet lifecycle
        "create_sheet",
        "get_sheet",
        "list_archived_sheets",
        "get_sheet_wrapped_key",
        "add_currency",
        "close_sheet",
        "start_new_sheet",
        // Phase 4: entries
        "add_entry",
        "edit_entry",
        "get_entry",
        "list_entries",
        // v1.1.1: real vetkd
        "get_vetkd_key_name",
        "vetkd_public_key",
        "vetkd_wrap_sheet_key",
        // v1.1.2: replace member
        "submit_replace_member",
        // v1.3.0: recovery key (V1 fix)
        "register_recovery_pubkey",
        "get_recovery_pubkey",
    ];
    if !allowed.contains(&method_name.as_str()) {
        ic_cdk::trap(format!(
            "method '{}' is not in the inspect whitelist",
            method_name
        ));
    }

    // Defense in depth: trap on anonymous callers for methods
    // that require authentication. The per-method
    // `require_authed()` is the primary gate; this just rejects
    // at the inspect layer (cheaper, no stable memory reads).
    // Public-by-design methods (vetkd_public_key) are NOT in
    // this list and remain callable by anonymous callers.
    let require_auth_methods: &[&str] = &[
        "set_display_name",
        "set_creator_principal",
        "create_pair",
        "join_pair",
        "create_sheet",
        "add_currency",
        "close_sheet",
        "start_new_sheet",
        "add_entry",
        "edit_entry",
        "vetkd_wrap_sheet_key",
        "submit_replace_member",
        "register_recovery_pubkey",
    ];
    if require_auth_methods.contains(&method_name.as_str())
        && caller == candid::Principal::anonymous()
    {
        ic_cdk::trap("anonymous callers are not allowed");
    }

    // Accept the message. Per the IC spec this MUST be called
    // explicitly to let the update proceed; omitting it (or
    // returning without calling it) is a silent reject.
    ic_cdk::api::accept_message();
}

// ───────────────────────── Phase 1 endpoints (auth + config) ─────────────────────────

#[ic_cdk::query]
fn whoami() -> Option<String> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        None
    } else {
        Some(caller.to_text())
    }
}

#[ic_cdk::query]
fn get_my_user() -> Option<UserRecord> {
    USERS.with(|u| u.borrow().get(&ic_cdk::api::msg_caller()).clone())
}

#[ic_cdk::update]
fn set_display_name(wrapped_display_name: Vec<u8>, display_name_iv: Vec<u8>) -> UserRecord {
    require_authed();
    if wrapped_display_name.is_empty() {
        ic_cdk::trap("wrappedDisplayName is empty");
    }
    if display_name_iv.is_empty() {
        ic_cdk::trap("displayNameIv is empty");
    }
    let now = ic_cdk::api::time();
    let rec = UserRecord {
        user_principal: ic_cdk::api::msg_caller(),
        wrapped_display_name,
        display_name_iv,
        created_at: now,
    };
    USERS.with(|u| {
        u.borrow_mut()
            .insert(rec.user_principal, rec.clone());
    });
    rec
}

#[ic_cdk::query]
fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

#[ic_cdk::update]
fn set_creator_principal(p: Principal) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let current = cfg.get().clone();
        let is_unset = current.creator_principal == Principal::anonymous();
        if !is_unset && current.creator_principal != caller {
            ic_cdk::trap("only the creator can change the creator principal");
        }
        let _ = cfg.set(Config {
            creator_principal: p,
            deployed_at: ic_cdk::api::time(),
        });
    });
}

// ───────────────────────── Phase 2 endpoints (pair lifecycle) ─────────────────────────

#[derive(Clone, CandidType, Deserialize)]
pub struct CreatePairResult {
    pub pair_id: String,
    pub invite_code: String,
}

/// create_pair: starts a new pair. Caller becomes member A (the creator).
/// Returns a one-time invite code that the second user can present to
/// `join_pair`.
#[ic_cdk::update]
async fn create_pair() -> CreatePairResult {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    // v1: a principal may be in at most one active pair at a time.
    // (The spec allows multiple pairs per user; we relax in v1.1.)
    PAIRS.with(|p| {
        for (_id, existing) in p.borrow().iter() {
            if existing.archived_at.is_none() && is_member_of(&existing, caller) {
                ic_cdk::trap("already in an active pair");
            }
        }
    });
    let id = now_id().await;
    let invite = gen_invite_code().await;
    // V5 fix: pre-insert existence check. now_id uses 64 bits of
    // raw_rand entropy so collisions are vanishingly unlikely, but
    // check anyway to fail loudly if it ever happens (rather than
    // silently overwriting a pair). V1 used time+caller-hash and
    // was guaranteed to collide within a single tick.
    if PAIRS.with(|p| p.borrow().contains_key(&id)) {
        ic_cdk::trap("pair id collision; please retry");
    }
    let now = now_secs();
    let pair = Pair {
        id: id.clone(),
        members: [caller, Principal::anonymous()], // [creator, pending]
        invite_code: invite.clone(),
        created_at: now,
        archived_at: None,
    };
    PAIRS.with(|p| p.borrow_mut().insert(id.clone(), pair));
    INVITES.with(|i| i.borrow_mut().insert(invite.clone(), id.clone()));
    CreatePairResult { pair_id: id, invite_code: invite }
}

/// join_pair: consumes an invite code, adds the caller as member B.
#[ic_cdk::update]
fn join_pair(invite_code: String) -> String {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    let pair_id = INVITES.with(|i| i.borrow().get(&invite_code).clone());
    let pair_id = match pair_id {
        Some(p) => p,
        None => ic_cdk::trap("invalid invite code"),
    };
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        // StableBTreeMap has no get_mut; remove + mutate + insert.
        let mut pair = match map.remove(&pair_id) {
            Some(p) => p,
            None => ic_cdk::trap("pair not found"),
        };
        if pair.members[1] != Principal::anonymous() {
            // put it back before trapping
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("invite already consumed");
        }
        if pair.members[0] == caller {
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("creator cannot join own pair");
        }
        pair.members[1] = caller;
        map.insert(pair_id.clone(), pair);
    });
    // consume invite
    INVITES.with(|i| i.borrow_mut().remove(&invite_code));
    pair_id
}

/// get_my_pairs: lists all pairs the caller is a member of (active + archived).
#[ic_cdk::query]
fn get_my_pairs() -> Vec<PairSummary> {
    let caller = ic_cdk::api::msg_caller();
    let mut out: Vec<PairSummary> = Vec::new();
    PAIRS.with(|p| {
        SHEETS.with(|s| {
            for (_id, pair) in p.borrow().iter() {
                if !is_member_of(&pair, caller) {
                    continue;
                }
                let other = if pair.members[0] == caller {
                    pair.members[1]
                } else {
                    pair.members[0]
                };
                // Find the active sheet (if any) for this pair.
                let mut active_sheet: Option<String> = None;
                let mut archived = 0u32;
                for (_sid, sheet) in s.borrow().iter() {
                    if sheet.pair_id != pair.id {
                        continue;
                    }
                    match sheet.state {
                        SheetState::Active => active_sheet = Some(sheet.id.clone()),
                        SheetState::Closed => archived += 1,
                    }
                }
                out.push(PairSummary {
                    id: pair.id.clone(),
                    other_principal: other,
                    active_sheet_id: active_sheet,
                    archived_sheet_count: archived,
                    created_at: pair.created_at,
                });
            }
        });
    });
    out
}

/// get_pair: full pair record for a given id. Caller must be a member.
#[ic_cdk::query]
fn get_pair(pair_id: String) -> Option<Pair> {
    let caller = ic_cdk::api::msg_caller();
    PAIRS.with(|p| {
        p.borrow().get(&pair_id).and_then(|pair| {
            if is_member_of(&pair, caller) {
                Some(pair.clone())
            } else {
                None
            }
        })
    })
}

// ───────────────────────── Phase 2 endpoints (sheet lifecycle) ─────────────────────────

#[derive(Clone, CandidType, Deserialize)]
pub struct CreateSheetReq {
    pub pair_id: String,
    pub enabled_currencies: Vec<String>,
    pub closing_window_days: u32,
    pub wrapped_key_a: Vec<u8>,
    pub wrapped_key_b: Vec<u8>,
}

/// create_sheet: starts a new active sheet inside a pair. Caller must be
/// a member of the pair. `wrapped_key_a` / `wrapped_key_b` are the
/// per-sheet symmetric key sealed to each member's vetkd-derived public
/// key. The canister never sees the plaintext key.
#[ic_cdk::update]
async fn create_sheet(req: CreateSheetReq) -> Sheet {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    // v1 constraints we enforce:
    if req.enabled_currencies.is_empty() {
        ic_cdk::trap("at least one currency is required");
    }
    if req.enabled_currencies.len() > 16 {
        ic_cdk::trap("at most 16 currencies per sheet");
    }
    if req.closing_window_days < 30 || req.closing_window_days > 730 {
        ic_cdk::trap("closing_window_days must be 30..=730");
    }
    // V8 fix: normalize ISO codes to uppercase on every write path
    // (add_currency also does this now). Prevents the
    // `["usd"]` + add_currency("USD") -> duplicates bug.
    let enabled_currencies: Vec<String> = req
        .enabled_currencies
        .iter()
        .map(|c| c.to_ascii_uppercase())
        .collect();
    for c in &enabled_currencies {
        if !c.chars().all(|ch| ch.is_ascii_alphabetic()) || c.len() != 3 {
            ic_cdk::trap("currency must be a 3-letter ISO 4217 code");
        }
    }
    let (member_a, member_b) = PAIRS.with(|p| {
        let map = p.borrow();
        let pair = match map.get(&req.pair_id) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        if pair.members[1] == Principal::anonymous() {
            ic_cdk::trap("pair is not active (no second member yet)");
        }
        if !is_member_of(&pair, caller) {
            ic_cdk::trap("not a member of this pair");
        }
        (pair.members[0], pair.members[1])
    });
    // v1: only one active sheet per pair.
    SHEETS.with(|s| {
        for (_id, existing) in s.borrow().iter() {
            if existing.pair_id == req.pair_id {
                if let SheetState::Active = existing.state {
                    ic_cdk::trap("pair already has an active sheet");
                }
            }
        }
    });
    let id = now_id().await;
    // V5 fix: pre-insert existence check (see create_pair).
    if SHEETS.with(|s| s.borrow().contains_key(&id)) {
        ic_cdk::trap("sheet id collision; please retry");
    }
    let now = now_secs();
    let sheet = Sheet {
        id: id.clone(),
        pair_id: req.pair_id,
        state: SheetState::Active,
        enabled_currencies,
        closing_window_days: req.closing_window_days,
        last_entry_at: None,
        wrapped_key_a: req.wrapped_key_a,
        wrapped_key_b: req.wrapped_key_b,
        member_a,
        member_b,
        created_at: now,
        closed_at: None,
        closing_balances: None,
    };
    SHEETS.with(|s| s.borrow_mut().insert(id, sheet.clone()));
    sheet
}

/// get_sheet: full sheet record. Caller must be a member of the parent pair.
#[ic_cdk::query]
fn get_sheet(sheet_id: String) -> Option<Sheet> {
    let caller = ic_cdk::api::msg_caller();
    let pair_id = SHEETS.with(|s| s.borrow().get(&sheet_id).map(|sh| sh.pair_id.clone()));
    let pair_id = pair_id?;
    let allowed = PAIRS.with(|p| {
        p.borrow().get(&pair_id).map(|pair| is_member_of(&pair, caller)).unwrap_or(false)
    });
    if !allowed { return None; }
    SHEETS.with(|s| s.borrow().get(&sheet_id).clone())
}

/// list_archived_sheets: returns all closed sheets for a pair the
/// caller is a member of. Newest first by closed_at.
#[ic_cdk::query]
fn list_archived_sheets(pair_id: String) -> Vec<Sheet> {
    let caller = ic_cdk::api::msg_caller();
    let allowed = PAIRS.with(|p| {
        p.borrow()
            .get(&pair_id)
            .map(|pair| is_member_of(&pair, caller))
            .unwrap_or(false)
    });
    if !allowed { ic_cdk::trap("not a member of this pair"); }
    let mut out: Vec<Sheet> = SHEETS.with(|s| {
        s.borrow()
            .iter()
            .filter_map(|(_id, sh)| {
                if sh.pair_id == pair_id && matches!(sh.state, SheetState::Closed) {
                    Some(sh)
                } else {
                    None
                }
            })
            .collect()
    });
    out.sort_by_key(|b| std::cmp::Reverse(b.closed_at.unwrap_or(0)));
    out
}

/// get_sheet_wrapped_key: returns the per-sheet K_sheet wrapped copy
/// sealed to the caller's vetkd-derived pub key. Callers unwrap it
/// client-side to get the symmetric key.
#[ic_cdk::query]
fn get_sheet_wrapped_key(sheet_id: String) -> Option<Vec<u8>> {
    let caller = ic_cdk::api::msg_caller();
    SHEETS.with(|s| {
        s.borrow().get(&sheet_id).and_then(|sheet| {
            if sheet.member_a == caller {
                Some(sheet.wrapped_key_a.clone())
            } else if sheet.member_b == caller {
                Some(sheet.wrapped_key_b.clone())
            } else {
                None
            }
        })
    })
}

/// add_currency: enables a new currency on an active sheet.
#[ic_cdk::update]
fn add_currency(sheet_id: String, iso: String) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if iso.len() != 3 || !iso.chars().all(|ch| ch.is_ascii_alphabetic()) {
        ic_cdk::trap("currency must be a 3-letter ISO 4217 code");
    }
    // V8 fix: normalize ISO codes to uppercase on every write path
    // (create_sheet also does this now). Prevents the
    // `["usd"]` + add_currency("USD") -> duplicates bug.
    let iso_upper: String = iso.to_ascii_uppercase();
    let ok = update_sheet_field(&sheet_id, |sheet| {
        if sheet.member_a != caller && sheet.member_b != caller {
            ic_cdk::trap("not a member of this sheet");
        }
        if let SheetState::Closed = sheet.state {
            ic_cdk::trap("sheet is closed");
        }
        if sheet.enabled_currencies.len() >= 16 {
            ic_cdk::trap("at most 16 currencies per sheet");
        }
        if sheet.enabled_currencies.contains(&iso_upper) {
            return; // already enabled, no-op
        }
        sheet.enabled_currencies.push(iso_upper);
    });
    if !ok {
        ic_cdk::trap("sheet not found");
    }
}

/// close_sheet: marks a sheet closed, captures the closing balances.
/// Members are still able to read it.
#[ic_cdk::update]
fn close_sheet(sheet_id: String, closing_balances: Vec<ClosingBalance>) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    let ok = update_sheet_field(&sheet_id, |sheet| {
        if sheet.member_a != caller && sheet.member_b != caller {
            ic_cdk::trap("not a member of this sheet");
        }
        if let SheetState::Closed = sheet.state {
            ic_cdk::trap("sheet is already closed");
        }
        sheet.state = SheetState::Closed;
        sheet.closed_at = Some(now_secs());
        sheet.closing_balances = Some(closing_balances);
    });
    if !ok {
        ic_cdk::trap("sheet not found");
    }
}

/// start_new_sheet: after closing, a pair can start a new sheet.
/// Closing balances become the first entry of the new sheet (handled
/// in the PWA; v1's startNewSheet just creates an empty sheet).
#[ic_cdk::update]
async fn start_new_sheet(req: CreateSheetReq) -> Sheet {
    // Re-uses create_sheet's auth + validation; in v1 the closing
    // balances are computed client-side and posted as the first entry
    // (Phase 3). For now, the new sheet starts empty.
    create_sheet(req).await
}

// ───────────────────────── Phase 3 endpoints (entries) ─────────────────────────
//
// Entries are encrypted client-side with the sheet's K_sheet. The
// canister never sees plaintext, so it stores:
//   * ciphertext  — AES-GCM(per_entry_key, K_sheet) of the entry
//                   payload
//   * iv          — random per encryption
// The per-entry_key is sent with the entry (32 random bytes) so
// the decryptor can reproduce the AES key by HKDF(K_sheet, entry_key).

#[derive(Clone, CandidType, Deserialize)]
pub struct AddEntryReq {
    pub sheet_id: String,
    pub entry_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct ListEntriesResult {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<u64>,
}

fn next_entry_id(sheet_id: &str) -> u64 {
    ENTRY_COUNTERS.with(|c| {
        let mut map = c.borrow_mut();
        let cur = map.get(&sheet_id.to_string()).unwrap_or(0);
        let next = cur + 1;
        map.insert(sheet_id.to_string(), next);
        next
    })
}

fn caller_is_pair_member(sheet_id: &str) -> bool {
    let caller = ic_cdk::api::msg_caller();
    SHEETS.with(|s| {
        let pair_id = match s.borrow().get(&sheet_id.to_string()).map(|sh| sh.pair_id.clone()) {
            Some(p) => p,
            None => return false,
        };
        PAIRS.with(|p| {
            p.borrow()
                .get(&pair_id)
                .map(|pair| is_member_of(&pair, caller))
                .unwrap_or(false)
        })
    })
}

fn sheet_is_active(sheet_id: &str) -> bool {
    SHEETS.with(|s| {
        s.borrow()
            .get(&sheet_id.to_string())
            .map(|sh| matches!(sh.state, SheetState::Active))
            .unwrap_or(false)
    })
}

fn record_entry_timestamp(sheet_id: &str, now: u64) {
    update_sheet_field(sheet_id, |sh| {
        sh.last_entry_at = Some(now);
    });
}

/// add_entry: store an encrypted entry on an active sheet. Caller
/// must be a member of the parent pair.
#[ic_cdk::update]
fn add_entry(req: AddEntryReq) -> Entry {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if req.entry_key.len() != 32 {
        ic_cdk::trap("entry_key must be 32 bytes");
    }
    if req.ciphertext.is_empty() {
        ic_cdk::trap("ciphertext is empty");
    }
    if req.iv.is_empty() {
        ic_cdk::trap("iv is empty");
    }
    if !caller_is_pair_member(&req.sheet_id) {
        ic_cdk::trap("not a member of this sheet's pair");
    }
    if !sheet_is_active(&req.sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let sheet = SHEETS.with(|s| s.borrow().get(&req.sheet_id).clone());
    let sheet = match sheet {
        Some(s) => s,
        None => ic_cdk::trap("sheet not found"),
    };
    let now = ic_cdk::api::time();
    let id = next_entry_id(&req.sheet_id);
    let entry = Entry {
        id,
        pair_id: sheet.pair_id.clone(),
        sheet_id: sheet.id.clone(),
        created_by: caller,
        created_at_server: now,
        updated_at_server: None,
        entry_key: req.entry_key,
        ciphertext: req.ciphertext,
        iv: req.iv,
    };
    // v1.3.0: per-sheet stable map (not the in-memory BTreeMap<String, Vec<Entry>>
    // we had before — that lost data on upgrade).
    let mut entries_map = sheet_entries_map(&req.sheet_id);
    entries_map.insert(entry.id, entry.clone());
    record_entry_timestamp(&req.sheet_id, now_secs());
    entry
}

/// edit_entry: replace the ciphertext + iv of an existing entry.
/// Only the original creator can edit. id is the (sheet_id, entry_id)
/// pair; the wire format bundles them.
#[derive(Clone, CandidType, Deserialize)]
pub struct EditEntryReq {
    pub sheet_id: String,
    pub entry_id: u64,
    pub entry_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
}

#[ic_cdk::update]
fn edit_entry(req: EditEntryReq) -> Entry {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if req.entry_key.len() != 32 {
        ic_cdk::trap("entry_key must be 32 bytes");
    }
    if req.ciphertext.is_empty() {
        ic_cdk::trap("ciphertext is empty");
    }
    if req.iv.is_empty() {
        ic_cdk::trap("iv is empty");
    }
    if !caller_is_pair_member(&req.sheet_id) {
        ic_cdk::trap("not a member of this sheet's pair");
    }
    if !sheet_is_active(&req.sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let now = ic_cdk::api::time();
    let mut entries_map = sheet_entries_map(&req.sheet_id);
    let Some(mut entry) = entries_map.remove(&req.entry_id) else {
        ic_cdk::trap("entry not found");
    };
    if entry.created_by != caller {
        // put it back before trapping
        entries_map.insert(req.entry_id, entry);
        ic_cdk::trap("only the original creator can edit this entry");
    }
    entry.entry_key = req.entry_key;
    entry.ciphertext = req.ciphertext;
    entry.iv = req.iv;
    entry.updated_at_server = Some(now);
    let result = entry.clone();
    entries_map.insert(req.entry_id, entry);
    result
}

/// get_entry: fetch a single entry by (sheet_id, id).
#[ic_cdk::query]
fn get_entry(sheet_id: String, entry_id: u64) -> Option<Entry> {
    if !caller_is_pair_member(&sheet_id) {
        return None;
    }
    sheet_entries_map(&sheet_id).get(&entry_id)
}

/// list_entries: paginated by `limit` (newest first). `cursor` is
/// the smallest `id` already seen (exclusive).
#[ic_cdk::query]
fn list_entries(
    sheet_id: String,
    cursor: Option<u64>,
    limit: u32,
) -> ListEntriesResult {
    if !caller_is_pair_member(&sheet_id) {
        ic_cdk::trap("not a member of this sheet's pair");
    }
    let limit = limit.min(200) as usize;
    let mut all: Vec<Entry> = sheet_entries_map(&sheet_id)
        .iter()
        .map(|(_id, e)| e)
        .collect();
    // Sort newest first.
    all.sort_by_key(|b| std::cmp::Reverse(b.id));
    let start = match cursor {
        Some(c) => all.iter().position(|e| e.id < c).unwrap_or(all.len()),
        None => 0,
    };
    let page: Vec<Entry> = all.into_iter().skip(start).take(limit).collect();
    let next_cursor = if page.len() == limit {
        page.last().map(|e| e.id)
    } else {
        None
    };
    ListEntriesResult {
        entries: page,
        next_cursor,
    }
}

// ────────────────────── v1.1.1: real vetkd endpoints ──────────────────────
//
// The PWA holds a BLS12-381 G2 transport key pair (the same scheme
// the IC's vetkd system uses for IBE encryption). To derive K_sheet
// for a given (caller_principal, sheet_id), the canister calls
// ic_cdk_management_canister::vetkd_derive_key(...) with:
//
//   input:       b"iou-sheet:" + sheet_id    (per-sheet scope)
//   context:     b"iou-vetkd-symmetric-v1"   (per-canister scope)
//   key_id:      { curve: Bls12_381_G2, name: VETKD_KEY_NAME }
//   transport:   the PWA's transport public key
//
// The returned `encrypted_key` is an IBE ciphertext that only the
// holder of the matching transport secret key can decrypt. The PWA
// then HKDFs the resulting symmetric key to get K_sheet (32 bytes).
//
// Requires dfx 0.27+ on local (which exports the cost_call system
// API that ic-cdk 0.20 needs). On the IC mainnet, vetkd_test_key
// is enabled by default on system subnets.

use ic_cdk_management_canister::{
    VetKDCurve, VetKDDeriveKeyArgs, VetKDDeriveKeyResult, VetKDKeyId,
    VetKDPublicKeyArgs, VetKDPublicKeyResult,
};

fn vetkd_key_id() -> VetKDKeyId {
    VetKDKeyId {
        curve: VetKDCurve::Bls12_381_G2,
        name: VETKD_KEY_NAME.with(|k| k.borrow().get().clone()),
    }
}

/// get_vetkd_key_name: returns the vetkd key name configured for this
/// canister. The PWA uses it to surface a useful error when prod
/// vetkd is requested but the canister is on a replica that doesn't
/// have the key enabled.
#[ic_cdk::query]
fn get_vetkd_key_name() -> String {
    VETKD_KEY_NAME.with(|k| k.borrow().get().clone())
}

/// vetkd_public_key: returns the canister's master vetkd public key
/// for the configured IBE context. Useful for the PWA to verify the
/// key id matches before deriving encrypted keys.
///
/// V6 fix: cache the result. The key is constant per
/// (canister, context, key_name) — for the lifetime of the canister
/// it never changes. Without the cache, every anonymous call
/// triggers an inter-canister call to the management canister,
/// which costs cycles.
#[ic_cdk::update]
async fn vetkd_public_key() -> Vec<u8> {
    if let Some(cached) = VETKD_PUBKEY_CACHE.with(|c| c.borrow().get().clone()) {
        return cached;
    }
    let request = VetKDPublicKeyArgs {
        canister_id: None,
        context: b"iou-vetkd-symmetric-v1".to_vec(),
        key_id: vetkd_key_id(),
    };
    let res: VetKDPublicKeyResult =
        ic_cdk_management_canister::vetkd_public_key(&request)
            .await
            .expect("call to vetkd_public_key failed");
    let _ = VETKD_PUBKEY_CACHE.with(|c| c.borrow_mut().set(Some(res.public_key.clone())));
    res.public_key
}

/// vetkd_wrap_sheet_key: returns the IBE encrypted_key for the
/// (caller, sheet_id) pair. The PWA is the only entity that can
/// decrypt this (it holds the matching transport secret key). On
/// unwrap, the PWA HKDFs the resulting symmetric key to get
/// K_sheet. Only members of the parent pair can call this.
///
/// IBE input is b"iou-sheet:" + sheet_id; the context is
/// b"iou-vetkd-symmetric-v1". The IBE ciphertext is bound to
/// (this_canister, sheet_id) and cannot be replayed across sheets
/// or canisters.
#[ic_cdk::update]
async fn vetkd_wrap_sheet_key(
    sheet_id: String,
    transport_public_key: Vec<u8>,
) -> Vec<u8> {
    require_authed();
    if transport_public_key.is_empty() {
        ic_cdk::trap("transport_public_key must not be empty");
    }
    // The IC's vetkd IBE uses BLS12-381 G1 for the transport key
    // (48 bytes compressed). The master public key is G2 (96 bytes).
    if transport_public_key.len() != 48 {
        ic_cdk::trap("transport_public_key must be 48 bytes (BLS12-381 G1, compressed)");
    }
    if !caller_is_pair_member(&sheet_id) {
        ic_cdk::trap("not a member of this sheet's pair");
    }
    if !sheet_is_active(&sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let mut input = Vec::with_capacity(10 + sheet_id.len());
    input.extend_from_slice(b"iou-sheet:");
    input.extend_from_slice(sheet_id.as_bytes());
    let request = VetKDDeriveKeyArgs {
        input,
        context: b"iou-vetkd-symmetric-v1".to_vec(),
        key_id: vetkd_key_id(),
        transport_public_key,
    };
    let res: VetKDDeriveKeyResult =
        ic_cdk_management_canister::vetkd_derive_key(&request)
            .await
            .expect("call to vetkd_derive_key failed");
    res.encrypted_key
}

// ────────────────────── v1.1.2: replace-member (offline sig + QR) ──────────────────────
//
// The flow:
//   1. The leaving member (Alice) opens /pair/:id/replace, picks the
//      new member's principal, and the PWA builds a ReplaceRequest:
//        { pair_id, leaving_principal, new_principal, ts_ms, nonce }
//      The PWA signs this with Alice's Ed25519 key (her II delegation
//      key) and renders the signed payload as a QR code.
//   2. Alice hands the QR to the staying member (Bob).
//   3. Bob scans it; the PWA reconstructs the ReplaceRequest and
//      submits it to submit_replace_member, authenticating as Bob.
//   4. The canister verifies:
//        - Alice's ed25519 signature is valid for the payload
//        - Alice is a current member of the pair
//        - Bob (the caller) is the OTHER current member
//        - The pair exists and is not archived
//        - The new_principal is not already a member
//        - The (pair_id, leaving_principal) pair is unique (replay
//          protection)
//      On success: replace member_a/member_b, close any active
//      sheet, log the change. The new member is now in the pair;
//      Alice is out.

#[derive(Clone, CandidType, Deserialize)]
pub struct ReplaceRequest {
    pub pair_id: String,
    pub leaving_principal: Principal,
    pub new_principal: Principal,
    pub ts_ms: u64,
    pub nonce: Vec<u8>, // 32 random bytes
}

#[derive(Clone, CandidType, Deserialize)]
pub struct SignedReplaceRequest {
    pub request: ReplaceRequest,
    pub signature: Vec<u8>,        // 64 bytes Ed25519 sig
    pub signer_pubkey: Vec<u8>,    // 32 bytes Ed25519 pubkey
}

/// register_recovery_pubkey: bind an Ed25519 verification pubkey to
/// the calling principal. The pubkey is what's allowed to sign
/// ReplaceRequest payloads where the caller is the *leaving* member.
///
/// V1 fix: previously `signer_pubkey` was taken verbatim from the
/// ReplaceRequest — i.e. the *staying* member (the one actually
/// calling submit_replace_member) chose which pubkey to verify
/// against. The result was a complete auth bypass: any pair member
/// could evict the other without their consent.
///
/// With this fix, the leaving member MUST register a pubkey first
/// (via this endpoint, authenticated as themselves) and the canister
/// looks up the pubkey by `req.leaving_principal` at verification
/// time. The caller-supplied `signer_pubkey` in SignedReplaceRequest
/// is now ignored (kept in the wire format for source compat with
/// the PWA).
///
/// One pubkey per principal; re-registering overwrites.
#[ic_cdk::update]
fn register_recovery_pubkey(pubkey: Vec<u8>) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if pubkey.len() != 32 {
        ic_cdk::trap("pubkey must be 32 bytes (Ed25519)");
    }
    let now = ic_cdk::api::time();
    let key = RecoveryKey {
        owner: caller,
        ed25519_pubkey: pubkey,
        registered_at: now,
    };
    RECOVERY_KEYS.with(|m| m.borrow_mut().insert(caller, key));
}

/// get_recovery_pubkey: returns the pubkey the principal registered
/// (or None). Public so the staying member can fetch the leaving
/// member's pubkey to build the verification challenge.
#[ic_cdk::query]
fn get_recovery_pubkey(principal: Principal) -> Option<Vec<u8>> {
    RECOVERY_KEYS.with(|m| m.borrow().get(&principal).map(|k| k.ed25519_pubkey.clone()))
}

/// Compute the stable-map key for a (pair_id, nonce) pair. Used by
/// V2 replay protection.
fn nonce_key(pair_id: &str, nonce: &[u8]) -> String {
    let mut k = String::with_capacity(pair_id.len() + 2 + nonce.len() * 2);
    k.push_str(pair_id);
    k.push(':');
    for b in nonce {
        k.push_str(&format!("{:02x}", b));
    }
    k
}

/// submit_replace_member: caller's II delegation (msg_caller) must
/// be the *staying* member. The leaving member signed the request
/// offline; the canister verifies the ed25519 sig against the
/// pubkey the leaving member previously registered, applies the
/// change, and records the nonce as consumed (V2 replay protection).
#[ic_cdk::update]
fn submit_replace_member(signed: SignedReplaceRequest) -> Pair {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    let req = &signed.request;
    if signed.signature.len() != 64 {
        ic_cdk::trap("signature must be 64 bytes");
    }
    // V1: signer_pubkey is now ignored — the canister looks up the
    // pubkey by req.leaving_principal. Kept in the wire format for
    // source compat with the PWA; we still validate length so a
    // malicious client can't pass garbage.
    if signed.signer_pubkey.len() != 32 {
        ic_cdk::trap("signer_pubkey must be 32 bytes (ignored; see V1 fix)");
    }
    if req.nonce.len() != 32 {
        ic_cdk::trap("nonce must be 32 bytes");
    }
    if req.leaving_principal == req.new_principal {
        ic_cdk::trap("leaving and new principals must differ");
    }

    // V2: replay protection. Reject if this (pair_id, nonce) has
    // been consumed before.
    let nk = nonce_key(&req.pair_id, &req.nonce);
    if CONSUMED_NONCES.with(|m| m.borrow().contains_key(&nk)) {
        ic_cdk::trap("nonce already consumed (replay)");
    }

    // V2: freshness window. ts_ms is millis; ic_cdk::api::time() is
    // nanos. ±5 min.
    let now_ns = ic_cdk::api::time();
    let req_ns = req.ts_ms.saturating_mul(1_000_000);
    let drift_ns: u64 = now_ns.abs_diff(req_ns);
    if drift_ns > 5 * 60 * 1_000_000_000u64 {
        ic_cdk::trap("ts_ms outside the ±5min freshness window");
    }

    // 1. Look up the pair; both members must exist.
    let pair = PAIRS.with(|p| p.borrow().get(&req.pair_id).clone());
    let mut pair = match pair {
        Some(p) => p,
        None => ic_cdk::trap("pair not found"),
    };
    if pair.archived_at.is_some() {
        ic_cdk::trap("pair is archived");
    }
    let leaving_is_a = pair.members.first() == Some(&req.leaving_principal);
    let leaving_is_b = pair.members.get(1) == Some(&req.leaving_principal);
    if !leaving_is_a && !leaving_is_b {
        ic_cdk::trap("leaving principal is not a member of this pair");
    }
    if !pair.members.contains(&caller) {
        ic_cdk::trap("caller is not a member of this pair");
    }
    if caller == req.leaving_principal {
        ic_cdk::trap("caller cannot be the leaving member; the staying member must submit");
    }
    if pair.members.contains(&req.new_principal) {
        ic_cdk::trap("new principal is already a member");
    }

    // 2. Verify the ed25519 signature against the pubkey the
    //    leaving member registered (NOT the one in `signed`).
    verify_replace_signature(&signed, &req.leaving_principal);

    // 3. Record the nonce as consumed (V2). Do this BEFORE the
    //    mutation so a failed insert (e.g. disk full) rolls back
    //    the auth side too.
    CONSUMED_NONCES.with(|m| {
        let _ = m.borrow_mut().insert(
            nk,
            ConsumedNonce {
                pair_id: req.pair_id.clone(),
                nonce: req.nonce.clone(),
                consumed_at: now_ns,
            },
        );
    });

    // 4. Apply the change.
    if leaving_is_a {
        pair.members[0] = req.new_principal;
    } else {
        pair.members[1] = req.new_principal;
    }
    PAIRS.with(|p| {
        p.borrow_mut().insert(req.pair_id.clone(), pair.clone());
    });

    // 5. Update all sheets: replace the leaving member's slot with
    // the new member. The leaving member loses read access; the
    // new member inherits the slot.
    let sheet_ids: Vec<String> = SHEETS.with(|s| {
        s.borrow()
            .iter()
            .filter_map(|(id, sh)| {
                if sh.pair_id == req.pair_id { Some(id) } else { None }
            })
            .collect()
    });
    for sid in sheet_ids {
        update_sheet_field(&sid, |sh| {
            if sh.member_a == req.leaving_principal {
                sh.member_a = req.new_principal;
            } else if sh.member_b == req.leaving_principal {
                sh.member_b = req.new_principal;
            }
            // If the sheet is still Active, close it — the new
            // member inherits it as Closed with the same
            // closing_balances (or none if not yet closed).
            if matches!(sh.state, SheetState::Active) {
                sh.state = SheetState::Closed;
                sh.closed_at = Some(now_secs());
            }
        });
    }

    pair
}

/// Canonical bytes of a ReplaceRequest (used as the ed25519 message).
/// Domain-separated so the signature can't be replayed across
/// canisters or for other purposes.
///
/// V7 fix (v1.3.1): every variable-length field is now prefixed
/// with a big-endian u32 length. The previous 0xff delimiter was
/// safe only because pair_id was ASCII; length-prefixed encoding
/// makes the canonical form safe to reuse for any field type
/// (binary blobs, multi-byte UTF-8, …) without colliding on a
/// delimiter byte.
fn canonical_replace_bytes(req: &ReplaceRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(b"iou-replace-member-v1:");
    push_with_len(&mut out, req.pair_id.as_bytes());
    push_with_len(&mut out, req.leaving_principal.as_slice());
    push_with_len(&mut out, req.new_principal.as_slice());
    push_with_len(&mut out, &req.ts_ms.to_be_bytes());
    push_with_len(&mut out, &req.nonce);
    out
}

fn push_with_len(out: &mut Vec<u8>, bytes: &[u8]) {
    let len = bytes.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
}

fn verify_replace_signature(signed: &SignedReplaceRequest, leaving_principal: &Principal) {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    // V1 fix: look up the pubkey the leaving member registered, NOT
    // the one in `signed.signer_pubkey` (which the staying member
    // controls).
    let pk_bytes_vec = match RECOVERY_KEYS.with(|m| m.borrow().get(leaving_principal)) {
        Some(k) => k.ed25519_pubkey.clone(),
        None => ic_cdk::trap("leaving member has not registered a recovery pubkey"),
    };
    let msg = canonical_replace_bytes(&signed.request);
    let pk_bytes: [u8; 32] = pk_bytes_vec.try_into()
        .unwrap_or_else(|_| ic_cdk::trap("invalid stored pubkey length"));
    let sig_bytes: [u8; 64] = signed.signature.clone().try_into()
        .unwrap_or_else(|_| ic_cdk::trap("invalid sig length"));
    let pk = match VerifyingKey::from_bytes(&pk_bytes) {
        Ok(p) => p,
        Err(_) => ic_cdk::trap("invalid ed25519 public key"),
    };
    let sig = Signature::from_bytes(&sig_bytes);
    if pk.verify(&msg, &sig).is_err() {
        ic_cdk::trap("signature verification failed");
    }
}
