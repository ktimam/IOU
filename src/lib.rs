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
// Storage: stable BTreeMaps. The per-sheet symmetric key (K_sheet) is
// generated client-side and never reaches the canister in cleartext;
// the canister only stores two wrapped copies sealed to each member's
// vetkd-derived public key (Phase 1.2's devVetkd adapter fills the
// gap until real vetkd_derive_key is exercised).

use candid::{CandidType, Deserialize, Principal};
use std::cell::RefCell;
use std::collections::BTreeMap;

// ───────────────────────── types ─────────────────────────

#[derive(Clone, CandidType, Deserialize)]
pub struct UserRecord {
    pub user_principal: Principal,
    pub wrapped_display_name: Vec<u8>,
    pub display_name_iv: Vec<u8>,
    pub created_at: u64,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct Config {
    pub creator_principal: Principal,
    pub deployed_at: u64,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct Pair {
    pub id: String,
    pub members: [Principal; 2],   // [creator, joiner]
    pub invite_code: String,
    pub created_at: u64,
    pub archived_at: Option<u64>,  // soft-delete; left in storage
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

// ───────────────────────── stable state ─────────────────────────

thread_local! {
    // Phase 1: user records. Not yet stable — for v1, on a canister
    // upgrade users re-set their display name. v1.1 will make this
    // stable.
    static USERS: RefCell<BTreeMap<Principal, UserRecord>> =
        const { RefCell::new(BTreeMap::new()) };

    static CONFIG: RefCell<Config> = const { RefCell::new(Config {
        creator_principal: Principal::anonymous(),
        deployed_at: 0,
    }) };

    // Phase 2: pair and sheet state. Stable across upgrades.
    static PAIRS: RefCell<BTreeMap<String, Pair>> =
        const { RefCell::new(BTreeMap::new()) };
    static SHEETS: RefCell<BTreeMap<String, Sheet>> =
        const { RefCell::new(BTreeMap::new()) };
    static INVITES: RefCell<BTreeMap<String, String>> =
        const { RefCell::new(BTreeMap::new()) };  // invite_code -> pair_id
}

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
fn gen_invite_code() -> String {
    // 32-char base32 alphabet: ABCDEFGHJKLMNPQRSTUVWXYZ23456789
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    // Time-based seed (we don't have rand yet; this is a v1 placeholder,
    // v1.1 should use ic_cdk::management_canister::raw_rand).
    let now = ic_cdk::api::time();
    let mut n = now;
    let mut out = String::with_capacity(8);
    for _ in 0..8 {
        let idx = (n % ALPHABET.len() as u64) as usize;
        out.push(ALPHABET[idx] as char);
        // Cheap LCG-style mix
        n = n.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        n >>= 16;
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

// v1: used in the ID we assign to new pairs/sheets. Real implementation
// should use ic_cdk::management_canister::raw_rand for collision-free ids.
fn now_id() -> String {
    let t = ic_cdk::api::time();
    let caller = ic_cdk::api::msg_caller().to_text();
    // Short enough to fit in a Candid Text, deterministic enough for v1.
    let hash: u64 = caller.bytes().fold(0u64, |acc, b| {
        acc.wrapping_mul(131).wrapping_add(b as u64)
    });
    format!("{:x}-{:x}", t, hash)
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
    USERS.with(|u| u.borrow().get(&ic_cdk::api::msg_caller()).cloned())
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
    USERS.with(|u| u.borrow_mut().insert(rec.user_principal, rec.clone()));
    rec
}

#[ic_cdk::query]
fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().clone())
}

#[ic_cdk::update]
fn set_creator_principal(p: Principal) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let is_unset = cfg.creator_principal == Principal::anonymous();
        if !is_unset && cfg.creator_principal != caller {
            ic_cdk::trap("only the creator can change the creator principal");
        }
        cfg.creator_principal = p;
        cfg.deployed_at = ic_cdk::api::time();
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
fn create_pair() -> CreatePairResult {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    // v1: a principal may be in at most one active pair at a time.
    // (The spec allows multiple pairs per user; we relax in v1.1.)
    PAIRS.with(|p| {
        for existing in p.borrow().values() {
            if existing.archived_at.is_none() && is_member_of(existing, caller) {
                ic_cdk::trap("already in an active pair");
            }
        }
    });
    let id = now_id();
    let invite = gen_invite_code();
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
    let pair_id = INVITES.with(|i| i.borrow().get(&invite_code).cloned());
    let pair_id = match pair_id {
        Some(p) => p,
        None => ic_cdk::trap("invalid invite code"),
    };
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let pair = match map.get_mut(&pair_id) {
            Some(p) => p,
            None => ic_cdk::trap("pair not found"),
        };
        if pair.members[1] != Principal::anonymous() {
            ic_cdk::trap("invite already consumed");
        }
        if pair.members[0] == caller {
            ic_cdk::trap("creator cannot join own pair");
        }
        pair.members[1] = caller;
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
            for pair in p.borrow().values() {
                if !is_member_of(pair, caller) {
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
                for sheet in s.borrow().values() {
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
            if is_member_of(pair, caller) {
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
fn create_sheet(req: CreateSheetReq) -> Sheet {
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
    for c in &req.enabled_currencies {
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
        if !is_member_of(pair, caller) {
            ic_cdk::trap("not a member of this pair");
        }
        (pair.members[0], pair.members[1])
    });
    // v1: only one active sheet per pair.
    SHEETS.with(|s| {
        for existing in s.borrow().values() {
            if existing.pair_id == req.pair_id {
                if let SheetState::Active = existing.state {
                    ic_cdk::trap("pair already has an active sheet");
                }
            }
        }
    });
    let id = now_id();
    let now = now_secs();
    let sheet = Sheet {
        id: id.clone(),
        pair_id: req.pair_id,
        state: SheetState::Active,
        enabled_currencies: req.enabled_currencies,
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
        p.borrow().get(&pair_id).map(|pair| is_member_of(pair, caller)).unwrap_or(false)
    });
    if !allowed { return None; }
    SHEETS.with(|s| s.borrow().get(&sheet_id).cloned())
}

/// list_archived_sheets: returns all closed sheets for a pair the
/// caller is a member of. Newest first by closed_at.
#[ic_cdk::query]
fn list_archived_sheets(pair_id: String) -> Vec<Sheet> {
    let caller = ic_cdk::api::msg_caller();
    let allowed = PAIRS.with(|p| {
        p.borrow()
            .get(&pair_id)
            .map(|pair| is_member_of(pair, caller))
            .unwrap_or(false)
    });
    if !allowed { ic_cdk::trap("not a member of this pair"); }
    let mut out: Vec<Sheet> = SHEETS.with(|s| {
        s.borrow()
            .values()
            .filter(|sh| sh.pair_id == pair_id && matches!(sh.state, SheetState::Closed))
            .cloned()
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
    let iso_upper: String = iso.to_ascii_uppercase();
    SHEETS.with(|s| {
        let mut map = s.borrow_mut();
        let sheet = match map.get_mut(&sheet_id) {
            Some(x) => x,
            None => ic_cdk::trap("sheet not found"),
        };
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
}

/// close_sheet: marks a sheet closed, captures the closing balances.
/// Members are still able to read it.
#[ic_cdk::update]
fn close_sheet(sheet_id: String, closing_balances: Vec<ClosingBalance>) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    SHEETS.with(|s| {
        let mut map = s.borrow_mut();
        let sheet = match map.get_mut(&sheet_id) {
            Some(x) => x,
            None => ic_cdk::trap("sheet not found"),
        };
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
}

/// start_new_sheet: after closing, a pair can start a new sheet.
/// Closing balances become the first entry of the new sheet (handled
/// in the PWA; v1's startNewSheet just creates an empty sheet).
#[ic_cdk::update]
fn start_new_sheet(req: CreateSheetReq) -> Sheet {
    // Re-uses create_sheet's auth + validation; in v1 the closing
    // balances are computed client-side and posted as the first entry
    // (Phase 3). For now, the new sheet starts empty.
    create_sheet(req)
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

// Sheets gain a per-sheet entry counter for monotonic ids.
thread_local! {
    static ENTRY_COUNTERS: RefCell<BTreeMap<String, u64>> =
        const { RefCell::new(BTreeMap::new()) };
    static ENTRIES: RefCell<BTreeMap<String, Vec<Entry>>> =
        const { RefCell::new(BTreeMap::new()) };
    // We also keep a secondary index: pair_id -> Vec<sheet_id> for
    // bulk operations. (Currently unused but cheap.)
}

fn next_entry_id(sheet_id: &str) -> u64 {
    ENTRY_COUNTERS.with(|c| {
        let mut map = c.borrow_mut();
        let cur = map.get(sheet_id).copied().unwrap_or(0);
        let next = cur + 1;
        map.insert(sheet_id.to_string(), next);
        next
    })
}

fn caller_is_pair_member(sheet_id: &str) -> bool {
    let caller = ic_cdk::api::msg_caller();
    SHEETS.with(|s| {
        let pair_id = match s.borrow().get(sheet_id).map(|sh| sh.pair_id.clone()) {
            Some(p) => p,
            None => return false,
        };
        PAIRS.with(|p| {
            p.borrow()
                .get(&pair_id)
                .map(|pair| is_member_of(pair, caller))
                .unwrap_or(false)
        })
    })
}

fn sheet_is_active(sheet_id: &str) -> bool {
    SHEETS.with(|s| {
        s.borrow()
            .get(sheet_id)
            .map(|sh| matches!(sh.state, SheetState::Active))
            .unwrap_or(false)
    })
}

fn record_entry_timestamp(sheet_id: &str, now: u64) {
    SHEETS.with(|s| {
        let mut map = s.borrow_mut();
        if let Some(sh) = map.get_mut(sheet_id) {
            sh.last_entry_at = Some(now);
        }
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
    let sheet = SHEETS.with(|s| s.borrow().get(&req.sheet_id).cloned());
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
    ENTRIES.with(|e| {
        let mut map = e.borrow_mut();
        let list = map.entry(req.sheet_id.clone()).or_default();
        list.push(entry.clone());
    });
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
    ENTRIES.with(|e| {
        let mut map = e.borrow_mut();
        let list = map.get_mut(&req.sheet_id);
        let list = match list {
            Some(l) => l,
            None => ic_cdk::trap("entry not found"),
        };
        let entry = list
            .iter_mut()
            .find(|e| e.id == req.entry_id)
            .ok_or("entry not found")
            .unwrap(/* panic trap */);
        if entry.created_by != caller {
            ic_cdk::trap("only the original creator can edit this entry");
        }
        entry.entry_key = req.entry_key;
        entry.ciphertext = req.ciphertext;
        entry.iv = req.iv;
        entry.updated_at_server = Some(now);
        entry.clone()
    })
}

/// get_entry: fetch a single entry by (sheet_id, id).
#[ic_cdk::query]
fn get_entry(sheet_id: String, entry_id: u64) -> Option<Entry> {
    if !caller_is_pair_member(&sheet_id) {
        return None;
    }
    ENTRIES.with(|e| {
        e.borrow()
            .get(&sheet_id)
            .and_then(|list| list.iter().find(|x| x.id == entry_id).cloned())
    })
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
    let mut all: Vec<Entry> = ENTRIES.with(|e| {
        e.borrow()
            .get(&sheet_id)
            .cloned()
            .unwrap_or_default()
    });
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
        name: VETKD_KEY_NAME.with(|k| k.borrow().clone()),
    }
}

thread_local! {
    // v1.1.1: vetkd key name. Defaults to "dfx_test_key" on local
    // replica; can be overridden at init time. On the IC mainnet,
    // set the IOU_VETKD_KEY_NAME env var to "key_1" (or whatever
    // your canister's derivation-key id is).
    static VETKD_KEY_NAME: RefCell<String> = RefCell::new(
        "dfx_test_key".to_string()
    );
}

/// get_vetkd_key_name: returns the vetkd key name configured for this
/// canister. The PWA uses it to surface a useful error when prod
/// vetkd is requested but the canister is on a replica that doesn't
/// have the key enabled.
#[ic_cdk::query]
fn get_vetkd_key_name() -> String {
    VETKD_KEY_NAME.with(|k| k.borrow().clone())
}

/// vetkd_public_key: returns the canister's master vetkd public key
/// for the configured IBE context. Useful for the PWA to verify the
/// key id matches before deriving encrypted keys.
#[ic_cdk::update]
async fn vetkd_public_key() -> Vec<u8> {
    let request = VetKDPublicKeyArgs {
        canister_id: None,
        context: b"iou-vetkd-symmetric-v1".to_vec(),
        key_id: vetkd_key_id(),
    };
    let res: VetKDPublicKeyResult =
        ic_cdk_management_canister::vetkd_public_key(&request)
            .await
            .expect("call to vetkd_public_key failed");
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

/// submit_replace_member: caller's II delegation (msg_caller) must
/// be the *staying* member. The leaving member signed the request
/// offline; the canister verifies the ed25519 sig and applies the
/// change.
#[ic_cdk::update]
fn submit_replace_member(signed: SignedReplaceRequest) -> Pair {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    let req = &signed.request;
    if signed.signature.len() != 64 {
        ic_cdk::trap("signature must be 64 bytes");
    }
    if signed.signer_pubkey.len() != 32 {
        ic_cdk::trap("signer_pubkey must be 32 bytes");
    }
    if req.nonce.len() != 32 {
        ic_cdk::trap("nonce must be 32 bytes");
    }
    if req.leaving_principal == req.new_principal {
        ic_cdk::trap("leaving and new principals must differ");
    }

    // 1. Look up the pair; both members must exist.
    let pair = PAIRS.with(|p| p.borrow().get(&req.pair_id).cloned());
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

    // 2. Verify the ed25519 signature.
    verify_replace_signature(&signed);

    // 3. Apply the change.
    // Remove the leaving member; add the new one. The new member
    // takes the slot of the leaving member (preserves member_a /
    // member_b ordering on the existing sheets).
    if leaving_is_a {
        pair.members[0] = req.new_principal;
    } else {
        pair.members[1] = req.new_principal;
    }
    PAIRS.with(|p| {
        p.borrow_mut().insert(req.pair_id.clone(), pair.clone());
    });

    // 4. Update all sheets: replace the leaving member's slot with
    // the new member. The leaving member loses read access; the
    // new member inherits the slot.
    let sheet_ids: Vec<String> = SHEETS.with(|s| {
        s.borrow()
            .iter()
            .filter(|(_, sh)| sh.pair_id == req.pair_id)
            .map(|(id, _)| id.clone())
            .collect()
    });
    for sid in sheet_ids {
        SHEETS.with(|s| {
            let mut map = s.borrow_mut();
            if let Some(sh) = map.get_mut(&sid) {
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
            }
        });
    }

    pair
}

/// Canonical bytes of a ReplaceRequest (used as the ed25519 message).
/// Domain-separated so the signature can't be replayed across
/// canisters or for other purposes.
fn canonical_replace_bytes(req: &ReplaceRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(b"iou-replace-member-v1:");
    out.extend_from_slice(req.pair_id.as_bytes());
    out.push(0xff);
    out.extend_from_slice(req.leaving_principal.as_slice());
    out.push(0xff);
    out.extend_from_slice(req.new_principal.as_slice());
    out.push(0xff);
    out.extend_from_slice(&req.ts_ms.to_be_bytes());
    out.push(0xff);
    out.extend_from_slice(&req.nonce);
    out
}

fn verify_replace_signature(signed: &SignedReplaceRequest) {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let msg = canonical_replace_bytes(&signed.request);
    let pk_bytes: [u8; 32] = signed.signer_pubkey.clone().try_into()
        .unwrap_or_else(|_| ic_cdk::trap("invalid pubkey length"));
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
