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
//   * create_sheet, get_sheet, get_sheet_wrapped_key,
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
    // v1.6.0: per-user encrypted transaction templates (AES-GCM under a
    // self-derived user key). Optional ⇒ Candid-backward-compatible.
    pub templates_enc: Option<Vec<u8>>,
    pub templates_iv: Option<Vec<u8>>,
    // v1.12.0: the user's ONE default currency (ISO 4217, uppercase). Was
    // browser-only (localStorage "iou:prefs:v1"), so it did not follow the user
    // to another device; now canister-backed with localStorage as a cache.
    //
    // Stored in PLAINTEXT, unlike the display name: a 3-letter currency code is
    // not PII, it is only ever returned by `get_my_user` (caller-scoped, so no
    // one else can read it), and keeping it key-free is what lets a fresh device
    // adopt it before any sheet key has been unwrapped. Optional ⇒ old records
    // decode with None.
    pub default_currency: Option<String>,
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
    // v1.12.0: the currency IOU's app-rendered confirmable card pre-selects, for the WHOLE
    // deployment. Deliberately app-level rather than per user: the card renders in an iframe that
    // OpenChat storage-partitions, so it has no IOU session and cannot tell one viewer from another,
    // and anything keyed by the chat would collide (an OpenChat direct-chat key names only the
    // COUNTERPARTY, so every user chatting with the same person shares it — see the MemoryId 21
    // note). One global value is the only thing every viewer resolves identically. `get_config` is
    // anonymous, so the card can read it with no identity. None = unset, and the card falls back to
    // deferring the currency to whoever imports it. Additive `opt` ⇒ old records decode with None.
    pub card_currency: Option<String>,
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
    // v1.5.0: E2E-encrypted display names (AES-GCM under the active
    // sheet's K_sheet; the canister stores ciphertext only). All optional
    // ⇒ Candid-backward-compatible with pre-v1.5.0 records.
    pub name_enc: Option<Vec<u8>>,         // account name
    pub name_iv: Option<Vec<u8>>,
    pub member_a_name_enc: Option<Vec<u8>>, // member_a's display name
    pub member_a_name_iv: Option<Vec<u8>>,
    pub member_b_name_enc: Option<Vec<u8>>, // member_b's display name
    pub member_b_name_iv: Option<Vec<u8>>,
    // v1.12.0: per-member SHARED transaction-template blobs (AES-GCM under
    // the active sheet's K_sheet — ciphertext only, exactly like the names
    // above). Slot a belongs to members[0], slot b to members[1];
    // set_pair_templates routes by caller, so one member's write can never
    // touch the other's slot. Both members read both slots via get_pair and
    // merge client-side (src/features/templates/pairTemplates.ts). All
    // optional ⇒ Candid-backward-compatible with pre-v1.12.0 records.
    pub templates_a_enc: Option<Vec<u8>>,
    pub templates_a_iv: Option<Vec<u8>>,
    pub templates_b_enc: Option<Vec<u8>>,
    pub templates_b_iv: Option<Vec<u8>>,
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
    // v1.10.0: account-level archive flag (set by archive_pair) so the accounts
    // list can split active vs archived. None = active.
    pub archived_at: Option<u64>,
    // v1.5.0: encrypted account name + the OTHER member's encrypted name
    // (resolved server-side relative to the caller) so the accounts list
    // can show names once K_sheet is cached.
    pub name_enc: Option<Vec<u8>>,
    pub name_iv: Option<Vec<u8>>,
    pub other_name_enc: Option<Vec<u8>>,
    pub other_name_iv: Option<Vec<u8>>,
}

// BTreeMap needs Ord, and Candid's Nat32 isn't a u32 in Rust.
// We use a plain u32 internally and expose it as Nat32 in Candid.
type Nat32_ = u32;

#[derive(Clone, CandidType, Deserialize)]
pub struct Sheet {
    pub id: String,
    pub pair_id: String,
    pub state: SheetState,
    // NOTE: v1.12.0 REMOVED `enabled_currencies: Vec<String>`. A sheet has no currency of its own:
    // any entry may use any ISO code, balances are grouped by what the entries actually use, and the
    // one default currency is a USER-level setting. The canister could never validate an entry's
    // currency anyway (entries are E2E encrypted). Old stored sheets still carry the field; Candid
    // ignores unknown record fields on decode, so `Decode!` reads them unchanged.
    pub closing_window_days: u32,
    pub last_entry_at: Option<u64>,
    pub wrapped_key_a: Vec<u8>,    // sealed to member_a's vetkd pub
    pub wrapped_key_b: Vec<u8>,    // sealed to member_b's vetkd pub
    pub member_a: Principal,
    pub member_b: Principal,
    pub created_at: u64,
    pub closed_at: Option<u64>,
    pub closing_balances: Option<Vec<ClosingBalance>>,
    // v1.5.0: E2E-encrypted sheet name (AES-GCM under this sheet's K_sheet).
    pub name_enc: Option<Vec<u8>>,
    pub name_iv: Option<Vec<u8>>,
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
// (lost on upgrade) with a StableBTreeMap<u64, Entry> per
// sheet. v1.3.2: a single StableBTreeMap<String, Entry> with
// a composite (sheet_id, entry_id) String key replaces the
// per-sheet sharding, which had a 4-region hash collision
// (issue #1, fix #1). The old MemoryIds 12..14 and 15 are
// now orphaned; see the memory layout comment near the top
// of this file.
//
// Entries are CIPHERTEXT-ONLY on the canister. The client encrypts
// the full payload (kind, currency, amount_minor, direction, note,
// ts) with a per-entry key derived from K_sheet, and the canister
// only stores the ciphertext + iv + the encrypted entry_key.
// v1.7.0: a prior (superseded) version of an entry, kept for the edit
// history. Ciphertext-only, same encryption as Entry.
#[derive(Clone, CandidType, Deserialize)]
pub struct EntryVersion {
    pub entry_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
    pub replaced_at: u64, // ns when this version was superseded by an edit
}

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
    // v1.7.0: edit history + soft delete. Optional ⇒ Candid decodes
    // pre-v1.7.0 entries with these absent (None).
    pub history: Option<Vec<EntryVersion>>, // prior versions, oldest first
    pub deleted_at: Option<u64>,            // soft-delete marker (ns)
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
// Memory layout (v1.3.3):
//   MemoryId 0: VERSION (StableCell<u32>) — current schema version.
//     Bump in post_upgrade if you change a map's key/value type
//     OR move a structure to a new MemoryId.
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
//   MemoryId 10: ENTRY_COUNTERS (StableBTreeMap<String, u64>)
//     sheet_id -> next entry id (per-sheet monotonic counter).
//   MemoryId 16: ENTRIES (StableBTreeMap<String, Entry>)
//     Single region for ALL entries across ALL sheets. Key is
//     `format!("{sheet_id}\0{:020}", entry_id)`. The `\0` separator
//     is safe because sheet_id never contains a NUL byte. v1.3.2
//     replaces the per-sheet sharding (MemoryIds 11..14) which had a
//     4-region hash collision (issue #1, fix #1). v1.3.3 moves the
//     map from MemoryId 11 to a fresh MemoryId 16 to avoid re-`init`-
//     ing a region whose stored u64-key header is incompatible with
//     the new String-key header (issue #7). See the layout callout
//     in `post_upgrade` and docs/02-architecture.md §3.2.
//
//   The following MemoryIds from the v1.3.0/v1.3.1 layout are
//   orphaned (no code reads or writes them). They still hold the
//   broken pre-v1.3.2 data and the v1.3.2 String-keyed entries
//   (respectively). `dfx canister install --mode reinstall` will
//   reclaim the space. In-place upgrades keep the orphan data on
//   those regions — it cannot be safely migrated (the pre-v1.3.2
//   per-sheet hash keys are ambiguous; the v1.3.2 String-keyed
//   entries are deliberately orphaned so the new MemoryId 16
//   starts with a clean header). The first upgrade on existing
//   data effectively wipes the entry tables. This is a deliberate
//   trade-off: the pre-v1.3.2 data was already cross-sheet-
//   corrupted, and the v1.3.2 trade-off is "fresh MemoryId over
//   data preservation" so future MemoryId refactors stay safe.
//
//   MemoryId 11: (was SHEET_ENTRIES[0] in v1.3.0/v1.3.1 with a
//                u64 key — incompatible with v1.3.2's String key;
//                was ENTRIES in v1.3.2 with a String key — moved
//                to MemoryId 16 in v1.3.3)
//   MemoryId 12..14: (was SHEET_ENTRIES[1..3] in v1.3.0, orphaned
//                since v1.3.2)
//   MemoryId 15:    (was SHEET_ENTRIES_IDS in v1.3.0, orphaned
//                since v1.3.2)
//
//   MemoryId 17: PARTNER_PUBKEYS (StableBTreeMap<Principal, Vec<u8>>)
//     v1.4.0 solo sheets — canister-attested per-principal wrap pubkeys.
//   MemoryId 18: CONSUMER_KEYPAIRS (StableBTreeMap<Principal, ConsumerKeypair>)
//     v1.8.0 OpenChat per-user consumer keypair — opaque wrapped
//     private-key blob + public key PEM, wrapped client-side under the
//     vetkd-derived user key (the canister never sees the plaintext).
//   MemoryId 19: CHAT_SHEET_LINKS (StableBTreeMap<String, ChatSheetLink>)
//     v1.9.0 OpenChat chat → sheet mapping. Key is
//     `format!("{}\0{}", caller.to_text(), chat_key)` — see
//     chat_link_key(). Caller-keyed; chat_key is the opaque OpenChat
//     context.chat string; sheet_id is the 16-hex-char sheet id
//     encoded as a u64.
//   MemoryId 20:    (was ACCOUNT_INBOX_KEYS for ~1 day during v1.11.0
//                development, never released; orphaned. The shared-inbox
//                review feature was REDESIGNED to OpenChat-side fan-out
//                delivery after an adversarial review showed wrapping the
//                user-global consumer key under K_sheet leaks a member's
//                OTHER accounts' drafts to a co-member.)
//   MemoryId 21:    (was CHAT_CARD_CURRENCY for ~1 hour during v1.12.0
//                development, never released; orphaned. An anonymously
//                readable chat_key -> ISO-code map, so the app-rendered
//                card could SHOW a currency instead of "Your IOU default".
//                REVERTED: an OpenChat direct-chat key names only the
//                COUNTERPARTY, so every user chatting with X shares the key
//                `direct:X` — two users' links collide on one entry. It also
//                answered the wrong question (what the shared sheet is
//                denominated in, not what the confirming user's default is),
//                which regressed the import back to the founder's currency.
//                The default currency is resolved PER USER at import instead.)
//
//   DO NOT re-use these orphaned MemoryIds for a new structure
//   with a different key/value type — see issue #7. If you need
//   a new region, use the next free number (currently 22+).

// v1.5.0 (schema v3 -> v4): added optional encrypted name fields to Pair,
// Sheet, PairSummary, CreateSheetReq.
// v1.6.0 (schema v4 -> v5): added optional templates_enc/iv to UserRecord.
// v1.7.0 (schema v5 -> v6): added optional history + deleted_at to Entry
// (edit history + soft delete). All new fields are `opt`, so Candid decodes
// older records with them absent — no data migration needed.
// v1.12.0 (schema v6 -> v7): added optional templates_a/b_enc/iv to Pair
// (per-member SHARED transaction-template slots). Same additive-`opt`
// pattern — old Pair records decode with the new fields = None. No
// MemoryId changes.
// v1.12.0 (schema v8 -> v9): added optional `default_currency` to UserRecord —
// the user's ONE default currency, moved off browser-only localStorage so it
// follows them across devices. Additive-`opt`, so old UserRecords decode with
// None (and the app then pushes the cached browser value up once).
// v1.12.0 (schema v7 -> v8): REMOVED `enabled_currencies` from Sheet and
// CreateSheetReq, and deleted the `add_currency` endpoint. A sheet has no
// currency of its own — the one default currency is a USER-level setting, and
// the canister never validated an entry's currency anyway (entries are E2E
// encrypted, so it cannot read it). This is the REMOVAL direction of the same
// Candid rule: a record with MORE fields still decodes, so pre-upgrade sheets
// (which carry the field in their bytes) read back unchanged and skip it. No
// data migration, no MemoryId changes. See
// `sheet_decodes_pre_v1_12_records_that_still_carry_enabled_currencies`.
const SCHEMA_VERSION: u32 = 9;

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
            Config { creator_principal: Principal::anonymous(), deployed_at: 0, card_currency: None },
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

    // v1.4.0 (solo sheets): each principal registers their P-256 wrap
    // pubkey under their own delegation. A solo-sheet creator wraps
    // K_sheet to the partner's *canister-attested* key (fetched via
    // get_sheet_pubkey) when granting access, instead of trusting a
    // pasted string. Fresh MemoryId (17) — additive, no migration.
    static PARTNER_PUBKEYS: RefCell<StableBTreeMap<Principal, Vec<u8>, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(17)))
        ));

    // v1.8.0 (OpenChat multi-user keys): each principal's action-inbox
    // consumer keypair, stored as an OPAQUE wrapped private-key blob +
    // the matching public key PEM. Wrapped client-side under the
    // vetkd-derived user key (dev sim: self-ECDH user key; prod:
    // vetkd_wrap_consumer_key), so any of the user's devices can
    // recover it — the canister never sees the plaintext private key.
    // Fresh MemoryId (18) — additive, no migration. Lives in stable
    // memory, so it survives in-place upgrades like everything else.
    static CONSUMER_KEYPAIRS: RefCell<StableBTreeMap<Principal, ConsumerKeypair, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(18)))
        ));

    // v1.9.0 (OpenChat delivery provenance): per-user chat → sheet
    // mapping. When OpenChat deposits a confirmed action it now carries
    // the source chat in the envelope's v2 context wrapper; the PWA lets
    // the user pin "always import this chat's drafts into this sheet".
    // The mapping is caller-keyed (composite String key, see
    // chat_link_key()); the chat_key is OPAQUE text to the canister
    // (OpenChat's canonical "group:<principal>" /
    // "channel:<principal>:<id>" form). Mirrors the CONSUMER_KEYPAIRS
    // conventions: fresh MemoryId (19), additive, no migration.
    static CHAT_SHEET_LINKS: RefCell<StableBTreeMap<String, ChatSheetLink, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(19)))
        ));

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

    // v1.3.2: all entries across all sheets live in a single
    // StableBTreeMap keyed by `entry_key(sheet_id, entry_id)`
    // (see entry_key() below). Replaces the per-sheet sharding
    // that shipped in v1.3.0 and which had a 4-region hash
    // collision (issue #1).
    //
    // v1.3.3: moved from MemoryId 11 to a fresh MemoryId 16.
    // The v1.3.2 layout re-`init`-ed MemoryId 11 (previously
    // holding a `StableBTreeMap<u64, Entry>` in v1.3.0/v1.3.1)
    // under the new `String` key type. `ic-stable-structures`
    // stores a per-region header that records the original key
    // and value types, and re-`init` under a different type
    // traps in `init` (failing `post_upgrade`). See issue #7.
    // We don't migrate the v1.3.2 String-keyed entries from
    // MemoryId 11 to 16 — the pre-v1.3.2 data was already
    // cross-sheet-corrupted, and a wipe is simpler + safer than
    // a multi-step migration. The v1.3.3 comment at the top of
    // this `thread_local!` documents the trade-off.
    static ENTRIES: RefCell<StableBTreeMap<String, Entry, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(16)))
        ));
}

/// Composite key for the entries map. The NUL separator is
/// safe because sheet_id (a 16-char hex string in our caller)
/// never contains a NUL byte. The fixed-width entry id suffix
/// makes lexicographic order match (sheet_id, entry_id) order
/// so `iter()` (which is not a range scan in stable structures)
/// returns entries in deterministic order.
fn entry_key(sheet_id: &str, entry_id: u64) -> String {
    format!("{}\0{:020}", sheet_id, entry_id)
}

/// Extract the sheet_id from an entry key. Returns the slice
/// up to the first NUL byte.
fn entry_key_sheet_id(key: &str) -> &str {
    match key.find('\0') {
        Some(i) => &key[..i],
        None => key, // malformed; treat the whole thing as sheet_id
    }
}

/// v1.3.2 + v1.3.3: the entry storage is a single StableBTreeMap
/// keyed by `entry_key(sheet_id, entry_id)`. v1.3.2 unified the
/// 4-region sharding that v1.3.0 shipped (which had a hash
/// collision — issue #1). v1.3.3 moved the map from MemoryId 11
/// to a fresh MemoryId 16 to avoid re-`init`-ing a region whose
/// stored u64-key header was incompatible with the new
/// String-key header — issue #7.
///
/// These helpers used to fan out across 4 pre-allocated
/// MemoryIds, which caused cross-sheet data corruption when
/// more than 4 sheets existed (or any 2 hashed to the same
/// slot). Issue #1.
//
// The functions below keep the old name `sheet_entries_map`
// for source compat with the call sites (add_entry, edit_entry,
// get_entry, list_entries) so the rest of the file reads
// naturally. The body is a thin closure over ENTRIES that
/// filters by sheet_id.
fn sheet_entries_get(sheet_id: &str, entry_id: u64) -> Option<Entry> {
    ENTRIES.with(|m| m.borrow().get(&entry_key(sheet_id, entry_id)))
}

fn sheet_entries_insert(sheet_id: &str, entry_id: u64, entry: Entry) {
    ENTRIES.with(|m| m.borrow_mut().insert(entry_key(sheet_id, entry_id), entry));
}

fn sheet_entries_remove(sheet_id: &str, entry_id: u64) -> Option<Entry> {
    ENTRIES.with(|m| m.borrow_mut().remove(&entry_key(sheet_id, entry_id)))
}

/// Returns every entry for the given sheet, in id-ascending
/// order. v1.3.2 uses a full-table scan (stable structures
/// don't expose a range API); this is fine for the IOU scale
/// (each pair has at most one active sheet, so the total
/// entry count is bounded by the number of pairs).
fn sheet_entries_iter(sheet_id: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    ENTRIES.with(|m| {
        for (k, v) in m.borrow().iter() {
            if entry_key_sheet_id(&k) == sheet_id {
                out.push(v);
            }
        }
    });
    out.sort_by_key(|e| e.id);
    out
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

    // v1.3.3 (schema v2 -> v3): ENTRIES moved from MemoryId 11 to
    // a fresh MemoryId 16. The previous region held either:
    //   * pre-v1.3.2: a `StableBTreeMap<u64, Entry>` (4-region
    //     sharding, cross-sheet-corrupted per issue #1). Re-`init`
    //     under the new String-key type would trap in init(),
    //     failing the upgrade.
    //   * v1.3.2: a `StableBTreeMap<String, Entry>` (the corrected
    //     single-region layout). Compatible type, but we still
    //     want a clean region to make the trade-off explicit and
    //     to keep the layout comment honest.
    // In both cases the data on MemoryId 11 is left orphaned
    // (matching the existing pre-v1.3.2 -> v1.3.2 trade-off).
    // We do NOT migrate entries from MemoryId 11 to 16; the
    // pre-v1.3.2 data is corrupt and the v1.3.2 data is
    // deliberately orphaned as the safer path forward. See
    // issue #7 for the rationale.
    if (1..SCHEMA_VERSION).contains(&current) {
        ic_cdk::println!(
            "iou_backend: v1.3.3 ENTRIES moved to fresh MemoryId 16; \
             any pre-v1.3.3 entries on MemoryId 11 are orphaned and \
             no longer accessible (this is a deliberate trade-off — \
             see issue #7 and the layout comment in thread_local!)"
        );
    }

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
    // Never treat the anonymous principal as a member. An empty pair slot
    // (pending invite, or a future solo pair) is Principal::anonymous(), and
    // several read paths gate purely on membership — without this guard any
    // anonymous caller would match every such pair.
    p != Principal::anonymous() && pair.members.contains(&p)
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

/// Current time in **nanoseconds** (raw `ic_cdk::api::time()`). Display
/// timestamps (Pair/Sheet `created_at`, `closed_at`, `last_entry_at`) use
/// this so they match entry/user timestamps — the PWA divides by 1_000_000
/// to get JS milliseconds. (Previously these fields stored seconds, which
/// the frontend mis-rendered as 1/1/1970.)
fn now_nanos() -> u64 {
    ic_cdk::api::time()
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
        "set_user_templates",
        "set_default_currency",
        "get_config",
        "set_creator_principal",
        "set_card_currency",
        // Phase 2: pair lifecycle
        "create_pair",
        "join_pair",
        "get_my_pairs",
        "get_pair",
        // v1.10.0: invite-link auto-join + account lifecycle
        "issue_invite",
        "accept_invite",
        "leave_pair",
        "archive_pair",
        "unarchive_pair",
        "delete_pair",
        // Phase 3: sheet lifecycle
        "create_sheet",
        "get_sheet",
        "list_archived_sheets",
        "get_sheet_wrapped_key",
        "close_sheet",
        "start_new_sheet",
        // v1.5.0: encrypted names
        "set_pair_name",
        "set_sheet_name",
        "set_member_name",
        // v1.12.0: shared transaction types per account
        "set_pair_templates",
        // Phase 4: entries
        "add_entry",
        "edit_entry",
        "delete_entry",
        "restore_entry",
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
        // v1.4.0: solo sheets
        "grant_partner_access",
        "register_sheet_pubkey",
        "get_sheet_pubkey",
        // v1.8.0: OpenChat per-user consumer keypair
        "set_consumer_keypair",
        "get_consumer_keypair",
        "delete_consumer_keypair",
        "vetkd_wrap_consumer_key",
        // v1.9.0: OpenChat chat → sheet mapping
        "set_chat_sheet_link",
        "remove_chat_sheet_link",
        "chat_sheet_links",
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
        "set_user_templates",
        "set_default_currency",
        "set_creator_principal",
        "set_card_currency",
        "create_pair",
        "join_pair",
        "issue_invite",
        "accept_invite",
        "leave_pair",
        "archive_pair",
        "unarchive_pair",
        "delete_pair",
        "create_sheet",
        "close_sheet",
        "start_new_sheet",
        "add_entry",
        "edit_entry",
        "delete_entry",
        "restore_entry",
        "vetkd_wrap_sheet_key",
        "submit_replace_member",
        "register_recovery_pubkey",
        "grant_partner_access",
        "register_sheet_pubkey",
        "set_pair_name",
        "set_sheet_name",
        "set_member_name",
        "set_pair_templates",
        "set_consumer_keypair",
        "delete_consumer_keypair",
        "vetkd_wrap_consumer_key",
        "set_chat_sheet_link",
        "remove_chat_sheet_link",
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

/// Read-modify-write the CALLER's UserRecord, creating it if absent, and return the stored result.
///
/// Every field `f` does not touch is preserved. This exists because each setter used to rebuild the
/// whole record by hand: adding a field meant remembering to copy it through in every other setter,
/// and forgetting silently WIPED it (e.g. saving your name would have erased your default currency).
/// `created_at` is set only on first write.
fn upsert_my_user(f: impl FnOnce(&mut UserRecord)) -> UserRecord {
    let caller = ic_cdk::api::msg_caller();
    let now = ic_cdk::api::time();
    USERS.with(|u| {
        let mut map = u.borrow_mut();
        let mut rec = map.get(&caller).unwrap_or(UserRecord {
            user_principal: caller,
            wrapped_display_name: Vec::new(),
            display_name_iv: Vec::new(),
            created_at: now,
            templates_enc: None,
            templates_iv: None,
            default_currency: None,
        });
        rec.user_principal = caller;
        f(&mut rec);
        map.insert(caller, rec.clone());
        rec
    })
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
    upsert_my_user(|rec| {
        rec.wrapped_display_name = wrapped_display_name;
        rec.display_name_iv = display_name_iv;
    })
}

/// set_default_currency: the caller's ONE default currency (ISO 4217, stored uppercase).
///
/// A sheet has no currency of its own, so this single per-user value is what pre-selects every entry
/// form and is stamped onto a chat import that names no currency. Caller-keyed and only ever returned
/// by `get_my_user`, so no other principal can read or write it.
#[ic_cdk::update]
fn set_default_currency(iso: String) -> UserRecord {
    require_authed();
    let code = iso.trim().to_ascii_uppercase();
    if code.len() != 3 || !code.chars().all(|c| c.is_ascii_alphabetic()) {
        ic_cdk::trap("currency must be a 3-letter ISO 4217 code");
    }
    upsert_my_user(|rec| rec.default_currency = Some(code))
}

/// set_user_templates: store the caller's encrypted transaction templates
/// (a single AES-GCM blob, encrypted client-side under the user key).
/// Preserves the display name. Usable across all of the user's sheets.
#[ic_cdk::update]
fn set_user_templates(templates_enc: Vec<u8>, templates_iv: Vec<u8>) -> UserRecord {
    require_authed();
    if templates_enc.len() > 64_000 {
        ic_cdk::trap("templates blob too large");
    }
    if templates_iv.len() < 12 || templates_iv.len() > 16 {
        ic_cdk::trap("templates iv length out of range");
    }
    upsert_my_user(|rec| {
        rec.templates_enc = Some(templates_enc);
        rec.templates_iv = Some(templates_iv);
    })
}

#[ic_cdk::query]
fn get_config() -> Config {
    CONFIG.with(|c| c.borrow().get().clone())
}

// Generic OpenChat manifest-verification contract (the app side). OpenChat's user_index c2c-calls
// this at publish time to confirm the registrant controls the canister the manifest points at:
// because only THIS canister answers here, a squatter who registers the name "iou" pointing at a
// bogus/absent canister can never get it published. We vouch for our own name only (option A —
// name attestation; `owner` is accepted but not required, since OpenChat's owner is a user-canister
// principal we don't know out of band). Pure identity attestation: no private-key material, so the
// E2E crypto invariant is untouched. Kept a QUERY so the c2c is cheap and side-effect-free.
#[derive(CandidType, Deserialize)]
struct VerifyAiAppArgs {
    name: String,
    #[allow(dead_code)]
    owner: Principal,
}

#[derive(CandidType, Deserialize)]
struct VerifyAiAppResponse {
    vouched: bool,
    name: Option<String>,
    owner: Option<Principal>,
}

#[ic_cdk::query]
fn c2c_verify_ai_app(args: VerifyAiAppArgs) -> VerifyAiAppResponse {
    let creator = CONFIG.with(|c| c.borrow().get().creator_principal);
    VerifyAiAppResponse {
        vouched: args.name == "iou",
        name: Some("iou".to_string()),
        owner: Some(creator),
    }
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
            // Preserve — this setter rebuilds the whole record.
            card_currency: current.card_currency.clone(),
        });
    });
}

/// set_card_currency: the deployment-wide currency IOU's confirmable card pre-selects.
///
/// Gated like `set_creator_principal`: the creator sets it, and while no creator has been claimed any
/// signed-in user may (fresh deployments start with `creator_principal` = anonymous). It is ONE value
/// for every user of this canister — see the `card_currency` field comment for why it cannot be
/// per-user — and it is only a PRE-SELECTION: whoever confirms a card can change it in the dropdown
/// before importing.
#[ic_cdk::update]
fn set_card_currency(iso: String) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    // An EMPTY string CLEARS it, so a deployment can go back to per-user deferral without a second
    // endpoint (and so the Settings "Not set" option actually does something).
    let code = iso.trim().to_ascii_uppercase();
    if !code.is_empty() && (code.len() != 3 || !code.chars().all(|c| c.is_ascii_alphabetic())) {
        ic_cdk::trap("currency must be a 3-letter ISO 4217 code (or empty to clear)");
    }
    CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let current = cfg.get().clone();
        let is_unset = current.creator_principal == Principal::anonymous();
        if !is_unset && current.creator_principal != caller {
            ic_cdk::trap("only the creator can set the card currency");
        }
        let _ = cfg.set(Config {
            creator_principal: current.creator_principal,
            deployed_at: current.deployed_at,
            card_currency: if code.is_empty() { None } else { Some(code) },
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
    // v1.3.2: fix for issue #2 (create_pair async TOCTOU). On the
    // IC, an `await` (here, the `raw_rand` calls) suspends the
    // method and lets other ingress messages run. The previous
    // version did the "already in an active pair" check BEFORE
    // the awaits, so two concurrent `create_pair` calls from the
    // same principal could both pass the check and end up in two
    // active pairs. Fix: do all the awaits first, then perform the
    // membership check + insert in a single synchronous block.
    let id = now_id().await;
    let invite = gen_invite_code().await;
    let now = now_nanos();
    let pair = Pair {
        id: id.clone(),
        members: [caller, Principal::anonymous()], // [creator, pending]
        invite_code: invite.clone(),
        created_at: now,
        archived_at: None,
        name_enc: None,
        name_iv: None,
        member_a_name_enc: None,
        member_a_name_iv: None,
        member_b_name_enc: None,
        member_b_name_iv: None,
        templates_a_enc: None,
        templates_a_iv: None,
        templates_b_enc: None,
        templates_b_iv: None,
    };
    PAIRS.with(|p| {
        // V5 fix: pre-insert existence check. now_id uses 64 bits
        // of raw_rand entropy so collisions are vanishingly unlikely,
        // but check anyway to fail loudly if it ever happens.
        if p.borrow().contains_key(&id) {
            ic_cdk::trap("pair id collision; please retry");
        }
        // A principal may be in any number of pairs concurrently — one shared
        // ledger per partner. The earlier v1 "at most one active pair per
        // principal" restriction was dropped (see the comment it replaced):
        // get_my_pairs already returns the full list and the UI picks among
        // them, join_pair never enforced the limit anyway, and there is no
        // principal->pair index to maintain — sheets are keyed per pair and
        // keys per principal, so unbounded pairs need no other change. The
        // `archived_at` field is retained for a future leave/close-pair action.
        p.borrow_mut().insert(id.clone(), pair);
    });
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
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let mut out: Vec<PairSummary> = Vec::new();
    PAIRS.with(|p| {
        SHEETS.with(|s| {
            for (_id, pair) in p.borrow().iter() {
                if !is_member_of(&pair, caller) {
                    continue;
                }
                let caller_is_a = pair.members[0] == caller;
                let other = if caller_is_a {
                    pair.members[1]
                } else {
                    pair.members[0]
                };
                // The OTHER member's encrypted name, relative to the caller.
                let (other_name_enc, other_name_iv) = if caller_is_a {
                    (pair.member_b_name_enc.clone(), pair.member_b_name_iv.clone())
                } else {
                    (pair.member_a_name_enc.clone(), pair.member_a_name_iv.clone())
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
                    archived_at: pair.archived_at,
                    name_enc: pair.name_enc.clone(),
                    name_iv: pair.name_iv.clone(),
                    other_name_enc,
                    other_name_iv,
                });
            }
        });
    });
    out
}

/// get_pair: full pair record for a given id. Caller must be a member.
#[ic_cdk::query]
fn get_pair(pair_id: String) -> Option<Pair> {
    require_authed();
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
    pub closing_window_days: u32,
    pub wrapped_key_a: Vec<u8>,
    pub wrapped_key_b: Vec<u8>,
    // v1.5.0: optional encrypted sheet name set at creation.
    pub name_enc: Option<Vec<u8>>,
    pub name_iv: Option<Vec<u8>>,
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
    if req.closing_window_days < 30 || req.closing_window_days > 730 {
        ic_cdk::trap("closing_window_days must be 30..=730");
    }
    // v1.3.2: fix for issue #3 (create_sheet async TOCTOU). Same
    // pattern as create_pair (#2): do all the awaits first, then
    // the membership / existence / insert in one synchronous
    // block so two concurrent calls can't both pass the
    // "already has an active sheet" check.
    let id = now_id().await;
    let now = now_nanos();
    let sheet = SHEETS.with(|s| {
        // V5 fix: pre-insert existence check (see create_pair).
        if s.borrow().contains_key(&id) {
            ic_cdk::trap("sheet id collision; please retry");
        }
        // Resolve the parent pair and check membership in the
        // same synchronous block.
        let (member_a, member_b) = PAIRS.with(|p| {
            let map = p.borrow();
            let pair = match map.get(&req.pair_id) {
                Some(x) => x,
                None => ic_cdk::trap("pair not found"),
            };
            // Solo sheets are allowed: members[1] may still be anonymous
            // (no partner has joined yet). is_member_of rejects anonymous,
            // so only the real creator (members[0]) passes here.
            if !is_member_of(&pair, caller) {
                ic_cdk::trap("not a member of this pair");
            }
            (pair.members[0], pair.members[1])
        });
        if req.wrapped_key_a.is_empty() {
            ic_cdk::trap("wrapped_key_a must not be empty");
        }
        // Solo sheet: ignore any client-supplied wrapped_key_b and store an
        // empty placeholder; grant_partner_access fills it once a partner
        // joins. member_b stays anonymous until then.
        let is_solo = member_b == Principal::anonymous();
        let wrapped_key_b = if is_solo { Vec::new() } else { req.wrapped_key_b.clone() };
        // v1: only one active sheet per pair. The check + insert
        // are in the same synchronous block (no await between), so
        // two concurrent create_sheet calls for the same pair
        // cannot both pass the check.
        for (_id, existing) in s.borrow().iter() {
            if existing.pair_id == req.pair_id {
                if let SheetState::Active = existing.state {
                    ic_cdk::trap("pair already has an active sheet");
                }
            }
        }
        let sheet = Sheet {
            id: id.clone(),
            pair_id: req.pair_id,
            state: SheetState::Active,
            closing_window_days: req.closing_window_days,
            last_entry_at: None,
            wrapped_key_a: req.wrapped_key_a,
            wrapped_key_b,
            member_a,
            member_b,
            created_at: now,
            closed_at: None,
            closing_balances: None,
            name_enc: req.name_enc,
            name_iv: req.name_iv,
        };
        s.borrow_mut().insert(id, sheet.clone());
        sheet
    });
    sheet
}

/// get_sheet: full sheet record. Caller must be a member of the parent pair.
#[ic_cdk::query]
fn get_sheet(sheet_id: String) -> Option<Sheet> {
    require_authed();
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
    require_authed();
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
    require_authed();
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

// ───────────────────────── v1.5.0: E2E-encrypted names ─────────────────────────
//
// Account/sheet/member names are AES-GCM ciphertext (encrypted client-side
// under the shared K_sheet); the canister only stores and serves the blobs.

fn check_name_blob(enc: &[u8], iv: &[u8]) {
    if enc.is_empty() || enc.len() > 1024 {
        ic_cdk::trap("name ciphertext length out of range");
    }
    if iv.len() < 12 || iv.len() > 16 {
        ic_cdk::trap("name iv length out of range");
    }
}

/// set_sheet_name: set this sheet's encrypted name. Caller must own the sheet.
#[ic_cdk::update]
fn set_sheet_name(sheet_id: String, name_enc: Vec<u8>, name_iv: Vec<u8>) {
    require_authed();
    check_name_blob(&name_enc, &name_iv);
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    let ok = update_sheet_field(&sheet_id, |sheet| {
        sheet.name_enc = Some(name_enc);
        sheet.name_iv = Some(name_iv);
    });
    if !ok {
        ic_cdk::trap("sheet not found");
    }
}

/// set_pair_name: set the account's encrypted name. Caller must be a pair member.
#[ic_cdk::update]
fn set_pair_name(pair_id: String, name_enc: Vec<u8>, name_iv: Vec<u8>) {
    require_authed();
    check_name_blob(&name_enc, &name_iv);
    let caller = ic_cdk::api::msg_caller();
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        if !is_member_of(&pair, caller) {
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("not a member of this pair");
        }
        pair.name_enc = Some(name_enc);
        pair.name_iv = Some(name_iv);
        map.insert(pair_id.clone(), pair);
    });
}

/// set_member_name: set the caller's own encrypted display name on this
/// account. Writes the member_a or member_b slot depending on which member
/// the caller is.
#[ic_cdk::update]
fn set_member_name(pair_id: String, name_enc: Vec<u8>, name_iv: Vec<u8>) {
    require_authed();
    check_name_blob(&name_enc, &name_iv);
    let caller = ic_cdk::api::msg_caller();
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        if pair.members[0] == caller {
            pair.member_a_name_enc = Some(name_enc);
            pair.member_a_name_iv = Some(name_iv);
        } else if pair.members[1] == caller {
            pair.member_b_name_enc = Some(name_enc);
            pair.member_b_name_iv = Some(name_iv);
        } else {
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("not a member of this pair");
        }
        map.insert(pair_id.clone(), pair);
    });
}

// ───────────────────────── v1.12.0: shared transaction types per account ─────────────────────────
//
// Each member publishes the templates they chose to SHARE with this account
// as one AES-GCM blob (encrypted client-side under the active sheet's
// K_sheet) into their OWN per-member slot on the Pair. Per-member slots make
// write conflicts impossible by construction (mirrors set_member_name); both
// members read both slots via the existing get_pair and merge client-side.
// Guards mirror set_user_templates (64KB blob, 12–16B iv) — NOT the 1KB
// check_name_blob.

/// Pure guard for a templates blob. Returns the trap message on failure.
fn check_templates_blob(enc: &[u8], iv: &[u8]) -> Result<(), &'static str> {
    if enc.is_empty() {
        return Err("templates ciphertext is empty");
    }
    if enc.len() > 64_000 {
        return Err("templates blob too large");
    }
    if iv.len() < 12 || iv.len() > 16 {
        return Err("templates iv length out of range");
    }
    Ok(())
}

/// Pure slot routing: which per-member slot (0 = a, 1 = b) the caller may
/// write, or None for a non-member. The anonymous principal is NEVER a
/// member — a solo pair's empty members[1] slot is Principal::anonymous(),
/// and matching it would let an anonymous caller write the b-slot.
fn member_slot(members: &[Principal; 2], caller: Principal) -> Option<usize> {
    if caller == Principal::anonymous() {
        None
    } else if members[0] == caller {
        Some(0)
    } else if members[1] == caller {
        Some(1)
    } else {
        None
    }
}

/// set_pair_templates: publish the caller's SHARED transaction templates
/// for this account into the caller's own slot (members[0] → a-slot,
/// members[1] → b-slot). A non-member traps; one member's write never
/// touches the other member's slot.
#[ic_cdk::update]
fn set_pair_templates(pair_id: String, templates_enc: Vec<u8>, templates_iv: Vec<u8>) {
    require_authed();
    if let Err(msg) = check_templates_blob(&templates_enc, &templates_iv) {
        ic_cdk::trap(msg);
    }
    let caller = ic_cdk::api::msg_caller();
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        match member_slot(&pair.members, caller) {
            Some(0) => {
                pair.templates_a_enc = Some(templates_enc);
                pair.templates_a_iv = Some(templates_iv);
            }
            Some(_) => {
                pair.templates_b_enc = Some(templates_enc);
                pair.templates_b_iv = Some(templates_iv);
            }
            None => {
                map.insert(pair_id.clone(), pair);
                ic_cdk::trap("not a member of this pair");
            }
        }
        map.insert(pair_id.clone(), pair);
    });
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
        sheet.closed_at = Some(now_nanos());
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

/// caller_owns_sheet: true iff the authenticated caller is member_a or
/// member_b OF THE SHEET ITSELF (not merely the parent pair). For a solo
/// sheet member_b is anonymous, so a partner who joined the pair but has
/// not been granted access (sheet.member_b still anonymous) does NOT own
/// it. This per-sheet check is the consent gate: it replaces the broader
/// pair-wide membership gate on the read, write, and key-derivation paths
/// so a late joiner cannot derive K_sheet (or read/write entries) for
/// sheets the creator made while solo until an explicit
/// grant_partner_access sets member_b.
fn caller_owns_sheet(sheet_id: &str) -> bool {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return false;
    }
    SHEETS.with(|s| {
        s.borrow()
            .get(&sheet_id.to_string())
            .map(|sh| sh.member_a == caller || sh.member_b == caller)
            .unwrap_or(false)
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

/// add_entry: store an encrypted entry on an active sheet.
///
/// v1.4.0: gated on caller_owns_sheet (per-sheet membership), matching the
/// read path (list_entries/get_entry) and the key-derivation path. For
/// legacy 2-member sheets the sheet members are exactly the pair members,
/// so behavior is unchanged. For a solo sheet a partner who joined the
/// pair but has not been granted access (sheet.member_b still anonymous)
/// cannot write entries until an explicit grant_partner_access sets
/// member_b — closing the integrity gap where an ungranted partner could
/// pollute the sheet with (undecryptable) junk entries.
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
    if !caller_owns_sheet(&req.sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
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
        history: None,
        deleted_at: None,
    };
    // v1.3.0: per-sheet stable map (not the in-memory BTreeMap<String, Vec<Entry>>
    // we had before — that lost data on upgrade). v1.3.2: a single
    // composite-key map replaces the 4-region sharding that had
    // cross-sheet hash collisions (issue #1).
    sheet_entries_insert(&req.sheet_id, entry.id, entry.clone());
    record_entry_timestamp(&req.sheet_id, now_nanos());
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
    if !caller_owns_sheet(&req.sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    if !sheet_is_active(&req.sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let now = ic_cdk::api::time();
    let Some(mut entry) = sheet_entries_remove(&req.sheet_id, req.entry_id) else {
        ic_cdk::trap("entry not found");
    };
    if entry.created_by != caller {
        // put it back before trapping
        sheet_entries_insert(&req.sheet_id, req.entry_id, entry);
        ic_cdk::trap("only the original creator can edit this entry");
    }
    if entry.deleted_at.is_some() {
        sheet_entries_insert(&req.sheet_id, req.entry_id, entry);
        ic_cdk::trap("cannot edit a deleted entry");
    }
    // v1.7.0: snapshot the current (pre-edit) ciphertext into history before
    // overwriting, so the full edit history is preserved.
    let mut hist = entry.history.take().unwrap_or_default();
    hist.push(EntryVersion {
        entry_key: entry.entry_key.clone(),
        ciphertext: entry.ciphertext.clone(),
        iv: entry.iv.clone(),
        replaced_at: now,
    });
    entry.history = Some(hist);
    entry.entry_key = req.entry_key;
    entry.ciphertext = req.ciphertext;
    entry.iv = req.iv;
    entry.updated_at_server = Some(now);
    let result = entry.clone();
    sheet_entries_insert(&req.sheet_id, req.entry_id, entry);
    result
}

/// delete_entry: soft-delete (mark deleted). The entry stays stored (with
/// its history) so it can be shown/restored; balances exclude it. Only the
/// original creator can delete, on an active sheet.
#[ic_cdk::update]
fn delete_entry(sheet_id: String, entry_id: u64) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    if !sheet_is_active(&sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let Some(mut entry) = sheet_entries_remove(&sheet_id, entry_id) else {
        ic_cdk::trap("entry not found");
    };
    if entry.created_by != caller {
        sheet_entries_insert(&sheet_id, entry_id, entry);
        ic_cdk::trap("only the original creator can delete this entry");
    }
    if entry.deleted_at.is_none() {
        entry.deleted_at = Some(ic_cdk::api::time());
    }
    sheet_entries_insert(&sheet_id, entry_id, entry);
}

/// restore_entry: undo a soft-delete. Creator-only, active sheet.
#[ic_cdk::update]
fn restore_entry(sheet_id: String, entry_id: u64) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    if !sheet_is_active(&sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let Some(mut entry) = sheet_entries_remove(&sheet_id, entry_id) else {
        ic_cdk::trap("entry not found");
    };
    if entry.created_by != caller {
        sheet_entries_insert(&sheet_id, entry_id, entry);
        ic_cdk::trap("only the original creator can restore this entry");
    }
    entry.deleted_at = None;
    sheet_entries_insert(&sheet_id, entry_id, entry);
}

/// get_entry: fetch a single entry by (sheet_id, id).
///
/// v1.4.0: gated on caller_owns_sheet (per-sheet membership), not the
/// broader pair-wide membership. For legacy 2-member sheets the sheet
/// members are exactly the pair members, so behavior is unchanged. For a
/// solo sheet a partner who joined the pair but has not been granted
/// access (sheet.member_b still anonymous) does not own the sheet, so they
/// cannot read its entries' ciphertext/metadata — matching the per-sheet
/// consent boundary already enforced on the key-derivation path.
#[ic_cdk::query]
fn get_entry(sheet_id: String, entry_id: u64) -> Option<Entry> {
    if !caller_owns_sheet(&sheet_id) {
        return None;
    }
    sheet_entries_get(&sheet_id, entry_id)
}

/// list_entries: paginated by `limit` (newest first). `cursor` is
/// the smallest `id` already seen (exclusive).
///
/// v1.4.0: gated on caller_owns_sheet (per-sheet membership) — see
/// get_entry for the rationale. A joined-but-ungranted partner of a solo
/// sheet is rejected here even though they are a pair member.
#[ic_cdk::query]
fn list_entries(
    sheet_id: String,
    cursor: Option<u64>,
    limit: u32,
) -> ListEntriesResult {
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    let limit = limit.min(200) as usize;
    // v1.3.2: full-table scan filtered by sheet_id (the
    // single-map layout doesn't have a range API; this is
    // O(total entries) but bounded by the number of pairs in
    // practice — each pair has at most one active sheet).
    let mut all: Vec<Entry> = sheet_entries_iter(&sheet_id);
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
    // Per-sheet consent gate (not just pair membership): a partner who
    // joined the pair gains K_sheet only after grant_partner_access sets
    // them as the sheet's member_b. Equivalent to the old gate for legacy
    // 2-member sheets (sheet members == pair members there).
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("not a member of this sheet (or partner access not yet granted)");
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

/// vetkd_wrap_consumer_key: per-CALLER analogue of vetkd_wrap_sheet_key,
/// used to wrap the OpenChat action-inbox consumer keypair (see
/// set_consumer_keypair below). Same vetkd mechanism, but the IBE input
/// is scoped to the caller's principal instead of a sheet id:
///
///   input:   b"iou-consumer:" + caller principal text
///   context: b"iou-vetkd-symmetric-v1"   (unchanged)
///
/// The PWA HKDFs the decrypted vetKey into the 32-byte wrap key it uses
/// to AES-GCM the consumer private key before storing it here. Because
/// the input is the caller's own principal, no consent gate beyond
/// require_authed is needed — a caller can only ever derive THEIR key.
#[ic_cdk::update]
async fn vetkd_wrap_consumer_key(transport_public_key: Vec<u8>) -> Vec<u8> {
    require_authed();
    if transport_public_key.is_empty() {
        ic_cdk::trap("transport_public_key must not be empty");
    }
    // BLS12-381 G1 compressed, exactly like vetkd_wrap_sheet_key.
    if transport_public_key.len() != 48 {
        ic_cdk::trap("transport_public_key must be 48 bytes (BLS12-381 G1, compressed)");
    }
    let caller_text = ic_cdk::api::msg_caller().to_text();
    let mut input = Vec::with_capacity(13 + caller_text.len());
    input.extend_from_slice(b"iou-consumer:");
    input.extend_from_slice(caller_text.as_bytes());
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

// ───────────── v1.8.0: OpenChat per-user consumer keypair ─────────────
//
// The action-inbox consumer keypair (P-256; the public half is what the
// user registers with OpenChat as their per-user delivery key) becomes
// canister-backed so any of the user's devices can recover it — device
// localStorage is only a cache. The canister stores an OPAQUE blob: the
// PWA wraps the private key client-side (AES-GCM under the vetkd-derived
// user key — dev sim uses the self-ECDH user key, prod uses
// vetkd_wrap_consumer_key above), so the canister never sees plaintext
// key material. Mirrors the PARTNER_PUBKEYS per-principal registry
// pattern (v1.4.0).

#[derive(Clone, CandidType, Deserialize)]
pub struct ConsumerKeypair {
    pub wrapped_private_key: Vec<u8>,
    pub public_key_pem: String,
}

impl Storable for ConsumerKeypair {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

/// set_consumer_keypair: caller-keyed upsert of the wrapped consumer
/// keypair. `wrapped_private_key` is the opaque client-side AES-GCM blob
/// (iv || ciphertext, wrapped under the vetkd-derived user key);
/// `public_key_pem` is the matching P-256 SPKI PEM OpenChat encrypts
/// confirmed actions to. Validation mirrors OpenChat's key checks so a
/// bad PEM fails here, before it ever reaches a registration.
#[ic_cdk::update]
fn set_consumer_keypair(wrapped_private_key: Vec<u8>, public_key_pem: String) {
    require_authed();
    if wrapped_private_key.is_empty() {
        ic_cdk::trap("wrapped_private_key is empty");
    }
    if wrapped_private_key.len() > 8_192 {
        ic_cdk::trap("wrapped_private_key too large (max 8192 bytes)");
    }
    if public_key_pem.is_empty() || public_key_pem.len() > 2_000 {
        ic_cdk::trap("public_key_pem length out of range (1..=2000 chars)");
    }
    if !public_key_pem.contains("BEGIN PUBLIC KEY") {
        ic_cdk::trap("public_key_pem must be a SPKI PEM (missing 'BEGIN PUBLIC KEY')");
    }
    let caller = ic_cdk::api::msg_caller();
    CONSUMER_KEYPAIRS.with(|m| {
        m.borrow_mut().insert(
            caller,
            ConsumerKeypair {
                wrapped_private_key,
                public_key_pem,
            },
        )
    });
}

/// get_consumer_keypair: the caller's stored consumer keypair (or None).
/// Caller-keyed — a principal can only ever read their own record; the
/// anonymous principal never has one.
#[ic_cdk::query]
fn get_consumer_keypair() -> Option<ConsumerKeypair> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return None;
    }
    CONSUMER_KEYPAIRS.with(|m| m.borrow().get(&caller))
}

/// delete_consumer_keypair: caller-keyed removal of the stored consumer
/// keypair. Backs the app's "Disconnect from OpenChat" action — once removed
/// the device holds no wrapped private key, so it can no longer decrypt any
/// action-inbox envelope and stops importing. This is the app-side half of a
/// one-sided unlink that needs no code from OpenChat; removing the OpenChat-side
/// delivery key (so OpenChat stops sending) is the separate `remove_my_ai_app_key`
/// action in the OpenChat UI. Idempotent — a no-op when the caller has none.
/// Only the opaque wrapped blob + PEM are affected; the plaintext private key
/// never lived in the canister, so the E2E invariant is untouched.
#[ic_cdk::update]
fn delete_consumer_keypair() {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    CONSUMER_KEYPAIRS.with(|m| m.borrow_mut().remove(&caller));
}

// ───────────── v1.9.0: OpenChat chat → sheet mapping ─────────────
//
// OpenChat's confirmed-action envelopes now carry a v2 context wrapper
// with the source chat ("group:<principal>" or
// "channel:<principal>:<channel id>"). The PWA lets the user remember
// "always import this chat's drafts into this sheet"; the mapping lives
// here so it follows the user across devices (localStorage is only a
// cache). The chat_key is OPAQUE to the canister — plain text, never
// parsed. sheet_id is the 16-hex-char sheet id encoded as a u64 (the
// ids come from now_id(): 8 raw_rand bytes hex-encoded, so the mapping
// is loss-free). Caller-keyed like CONSUMER_KEYPAIRS: a principal only
// ever sees / edits its own links.

#[derive(Clone, CandidType, Deserialize)]
pub struct ChatSheetLink {
    pub chat_key: String,
    pub sheet_id: u64,
}

impl Storable for ChatSheetLink {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

/// Composite key for CHAT_SHEET_LINKS: `caller text \0 chat_key`. The
/// NUL separator is safe because principal text never contains a NUL
/// byte and validate_chat_key rejects NUL in chat_key. Same pattern as
/// entry_key().
fn chat_link_key(caller: &Principal, chat_key: &str) -> String {
    format!("{}\0{}", caller.to_text(), chat_key)
}

/// Validation shared by set/remove: the chat_key is opaque but bounded
/// (1..=200 chars) and must not contain NUL (it is embedded in the
/// composite stable-map key).
fn validate_chat_key(chat_key: &str) {
    let n = chat_key.chars().count();
    if n == 0 || n > 200 {
        ic_cdk::trap("chat_key length out of range (1..=200 chars)");
    }
    if chat_key.contains('\0') {
        ic_cdk::trap("chat_key must not contain NUL");
    }
}

/// set_chat_sheet_link: caller-keyed upsert of a chat → sheet mapping.
/// `chat_key` is the OpenChat context.chat string (opaque here);
/// `sheet_id` is the sheet id as a u64 (hex-decoded client-side).
#[ic_cdk::update]
fn set_chat_sheet_link(chat_key: String, sheet_id: u64) {
    require_authed();
    validate_chat_key(&chat_key);
    let caller = ic_cdk::api::msg_caller();
    CHAT_SHEET_LINKS.with(|m| {
        m.borrow_mut().insert(
            chat_link_key(&caller, &chat_key),
            ChatSheetLink { chat_key, sheet_id },
        )
    });
}

/// remove_chat_sheet_link: caller-keyed removal. Removing a mapping
/// that does not exist is a no-op (idempotent).
#[ic_cdk::update]
fn remove_chat_sheet_link(chat_key: String) {
    require_authed();
    validate_chat_key(&chat_key);
    let caller = ic_cdk::api::msg_caller();
    CHAT_SHEET_LINKS.with(|m| {
        m.borrow_mut().remove(&chat_link_key(&caller, &chat_key));
    });
}

/// chat_sheet_links: all of the CALLER's chat → sheet mappings. The
/// anonymous principal never has any. Full-table scan filtered by the
/// caller prefix — same trade-off as sheet_entries_iter (bounded by
/// the number of chats a user has ever linked).
#[ic_cdk::query]
fn chat_sheet_links() -> Vec<ChatSheetLink> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Vec::new();
    }
    let prefix = format!("{}\0", caller.to_text());
    let mut out: Vec<ChatSheetLink> = Vec::new();
    CHAT_SHEET_LINKS.with(|m| {
        for (k, v) in m.borrow().iter() {
            if k.starts_with(&prefix) {
                out.push(v);
            }
        }
    });
    out
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

// ───────────────────── v1.4.0: solo sheets ─────────────────────

/// register_sheet_pubkey: bind a P-256 wrap public key to the caller, so
/// a solo-sheet creator can wrap K_sheet to the partner's canister-attested
/// key (fetched via get_sheet_pubkey) rather than a pasted string — closing
/// the dev key-exchange MITM. Authenticated; one key per principal.
#[ic_cdk::update]
fn register_sheet_pubkey(pubkey: Vec<u8>) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    if pubkey.is_empty() || pubkey.len() > 256 {
        ic_cdk::trap("pubkey length out of range");
    }
    PARTNER_PUBKEYS.with(|m| m.borrow_mut().insert(caller, pubkey));
}

/// get_sheet_pubkey: the wrap pubkey a principal registered (or None).
/// Public so the granter can fetch the partner's attested key.
#[ic_cdk::query]
fn get_sheet_pubkey(principal: Principal) -> Option<Vec<u8>> {
    PARTNER_PUBKEYS.with(|m| m.borrow().get(&principal))
}

#[derive(Clone, CandidType, Deserialize)]
pub struct SheetRewrap {
    pub sheet_id: String,
    pub wrapped_key_for_partner: Vec<u8>, // dev: K_sheet sealed to partner; prod: empty
}

/// grant_partner_access: the solo-sheet creator (pair.members[0]) grants a
/// joined partner access to their still-Active solo sheets. The single
/// explicit, owner-initiated consent step, used in BOTH dev and prod (in
/// prod `rewraps` carry empty blobs; the grant works by setting member_b so
/// the per-sheet vetkd gate passes).
///
/// Security guards (all validated before any write — atomic):
///   - caller authed and == pair.members[0] (the K_sheet holder);
///   - `expected_partner` must equal the principal that actually joined
///     (pair.members[1]) — defeats a join-race redirecting the grant;
///   - each sheet must belong to this pair, be owned by the caller
///     (member_a == caller), be a genuine solo sheet (member_b anonymous),
///     and be Active. The member_b-anonymous check makes the grant
///     idempotent / replay-safe (a second grant fails) and prevents
///     overwriting a real partner's wrapped_key_b. Closed-before-grant
///     sheets are skipped, matching the prod sheet_is_active gate.
///
/// The canister never sees plaintext K_sheet — only the opaque blob.
#[ic_cdk::update]
fn grant_partner_access(
    pair_id: String,
    expected_partner: Principal,
    rewraps: Vec<SheetRewrap>,
) -> u32 {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    if expected_partner == Principal::anonymous() {
        ic_cdk::trap("expected_partner must not be anonymous");
    }
    if caller == expected_partner {
        ic_cdk::trap("cannot grant access to yourself");
    }
    let pair = match PAIRS.with(|p| p.borrow().get(&pair_id).clone()) {
        Some(p) => p,
        None => ic_cdk::trap("pair not found"),
    };
    if pair.archived_at.is_some() {
        ic_cdk::trap("pair is archived");
    }
    if pair.members[0] != caller {
        ic_cdk::trap("only the sheet owner (pair creator) may grant partner access");
    }
    // Recipient binding: the partner must have actually joined this pair and
    // be exactly who the caller committed to wrapping for.
    if pair.members.get(1) != Some(&expected_partner) {
        ic_cdk::trap("expected_partner is not the joined member of this pair");
    }
    // Validate the entire batch BEFORE mutating (single message → atomic).
    let mut validated: Vec<(String, Vec<u8>)> = Vec::with_capacity(rewraps.len());
    SHEETS.with(|s| {
        let map = s.borrow();
        for rw in &rewraps {
            let sheet = match map.get(&rw.sheet_id) {
                Some(sh) => sh,
                None => ic_cdk::trap("sheet not found"),
            };
            if sheet.pair_id != pair_id {
                ic_cdk::trap("sheet does not belong to this pair");
            }
            if sheet.member_a != caller {
                ic_cdk::trap("caller does not own this sheet");
            }
            if sheet.member_b != Principal::anonymous() {
                ic_cdk::trap("sheet already has a partner (not a solo sheet)");
            }
            if !matches!(sheet.state, SheetState::Active) {
                ic_cdk::trap("cannot grant access to a closed sheet");
            }
            validated.push((rw.sheet_id.clone(), rw.wrapped_key_for_partner.clone()));
        }
    });
    let mut count = 0u32;
    for (sid, blob) in validated {
        let ok = update_sheet_field(&sid, |sheet| {
            sheet.member_b = expected_partner;
            sheet.wrapped_key_b = blob.clone();
            // state stays Active.
        });
        if ok {
            count += 1;
        }
    }
    count
}

// ───────────────────── v1.10.0: invite-link auto-join + account lifecycle ─────────────────────

/// issue_invite: mint a FRESH, single-use invite code for a pair and return it.
///
/// WHY: the previous design reused `pair.invite_code`, but that stored string goes
/// STALE the moment the first invitee accepts (accept_invite/join_pair remove the
/// code from the INVITES map but never clear the field) — and it is never re-minted
/// when the second slot frees up again (leave_pair). So a link built from the stored
/// code hit "invalid or already-consumed invite code". Minting a fresh code on every
/// invite-modal open guarantees the shareable link always carries a LIVE code, and
/// invalidates any older link (single-use hygiene).
///
/// Any member may call it. Allowed whether the second slot is open (invite a NEW
/// partner) or already filled (re-share the key to the EXISTING, ungranted partner —
/// see accept_invite's re-seal path); a stranger with the code still can't take a
/// filled slot (accept_invite rejects that).
#[ic_cdk::update]
async fn issue_invite(pair_id: String) -> String {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    {
        let pair = match PAIRS.with(|p| p.borrow().get(&pair_id).clone()) {
            Some(p) => p,
            None => ic_cdk::trap("pair not found"),
        };
        if !is_member_of(&pair, caller) {
            ic_cdk::trap("not a member of this pair");
        }
        if pair.archived_at.is_some() {
            ic_cdk::trap("pair is archived");
        }
    }
    // Mint the code (async raw_rand) BEFORE touching any map — never await across a borrow.
    let code = gen_invite_code().await;
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        if !is_member_of(&pair, caller) {
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("not a member of this pair");
        }
        // Swap in the fresh code and drop the previous one from INVITES so at most one
        // live code exists per pair.
        let old = std::mem::replace(&mut pair.invite_code, code.clone());
        map.insert(pair_id.clone(), pair);
        INVITES.with(|i| {
            let mut inv = i.borrow_mut();
            if !old.is_empty() {
                inv.remove(&old);
            }
            inv.insert(code.clone(), pair_id.clone());
        });
    });
    code
}

/// accept_invite: the pull-model self-join that REPLACES `join_pair` + the
/// creator's manual `grant_partner_access`. The invitee (holder of a valid
/// invite code) joins the pair AND seals K_sheet to themselves in ONE
/// authorized message — no creator involvement.
///
/// Authorization is by **possession of the (single-use) invite code**, not
/// creator identity: this is the bearer-capability model that makes invite
/// LINKS work (the link carries the code + — in dev — K_sheet in its fragment,
/// so the invitee can produce `rewraps` client-side). Prod (vetkd) passes empty
/// `rewraps` and works purely by flipping `member_b`.
///
/// Two accept modes, chosen by caller identity:
///   - NEW JOIN — the open slot (`members[1] == anonymous`) is claimed by the
///     caller (must not be the creator).
///   - RE-SEAL  — the caller is ALREADY `members[1]` but a sheet key was never
///     sealed to them (a legacy "joined but not granted" pair, or an access
///     re-share). Membership is unchanged; we just (re)seal their `wrapped_key_b`.
///
/// Guards (all validated before any write — atomic, single sync message):
///   - caller authed; `pubkey` a plausible P-256 wrap key;
///   - invite resolves to a pair; pair not archived;
///   - new-join only: `members[1] == anonymous` and `caller != members[0]`;
///   - each rewrap sheet belongs to the pair, is Active, and its `member_b` is
///     either anonymous (solo) or already the caller (idempotent re-seal) — a
///     sheet sealed to a DIFFERENT partner is never overwritten.
#[ic_cdk::update]
fn accept_invite(invite_code: String, rewraps: Vec<SheetRewrap>, pubkey: Vec<u8>) -> Pair {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    if pubkey.is_empty() || pubkey.len() > 256 {
        ic_cdk::trap("pubkey length out of range");
    }
    let pair_id = match INVITES.with(|i| i.borrow().get(&invite_code).clone()) {
        Some(p) => p,
        None => ic_cdk::trap("invalid or already-consumed invite code"),
    };
    let pair = match PAIRS.with(|p| p.borrow().get(&pair_id).clone()) {
        Some(p) => p,
        None => ic_cdk::trap("pair not found"),
    };
    if pair.archived_at.is_some() {
        ic_cdk::trap("pair is archived");
    }
    // The caller is either claiming the open slot (new join) or is already the
    // partner and only needs their key (re)sealed.
    let is_reseal = pair.members[1] == caller;
    if !is_reseal {
        if pair.members[1] != Principal::anonymous() {
            ic_cdk::trap("this account already has a partner");
        }
        if pair.members[0] == caller {
            ic_cdk::trap("creator cannot accept their own invite");
        }
    }
    // Validate the whole batch before mutating (atomic).
    let mut validated: Vec<(String, Vec<u8>)> = Vec::with_capacity(rewraps.len());
    SHEETS.with(|s| {
        let map = s.borrow();
        for rw in &rewraps {
            let sheet = match map.get(&rw.sheet_id) {
                Some(sh) => sh,
                None => ic_cdk::trap("sheet not found"),
            };
            if sheet.pair_id != pair_id {
                ic_cdk::trap("sheet does not belong to this pair");
            }
            // Solo (anonymous) for a new join, or already ours for an idempotent re-seal.
            // Never overwrite a key sealed to a different partner.
            if sheet.member_b != Principal::anonymous() && sheet.member_b != caller {
                ic_cdk::trap("sheet already has a different partner");
            }
            if !matches!(sheet.state, SheetState::Active) {
                ic_cdk::trap("cannot join a closed sheet");
            }
            validated.push((rw.sheet_id.clone(), rw.wrapped_key_for_partner.clone()));
        }
    });
    // Mutate: claim the slot (new join only, re-checked under the lock), store pubkey,
    // seal each sheet, consume the invite.
    let updated = PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id) {
            Some(p) => p,
            None => ic_cdk::trap("pair not found"),
        };
        if !is_reseal {
            if pair.members[1] != Principal::anonymous() {
                map.insert(pair_id.clone(), pair);
                ic_cdk::trap("this account already has a partner");
            }
            pair.members[1] = caller;
        }
        map.insert(pair_id.clone(), pair.clone());
        pair
    });
    PARTNER_PUBKEYS.with(|m| m.borrow_mut().insert(caller, pubkey));
    for (sid, blob) in validated {
        update_sheet_field(&sid, |sheet| {
            sheet.member_b = caller;
            sheet.wrapped_key_b = blob.clone();
        });
    }
    INVITES.with(|i| i.borrow_mut().remove(&invite_code));
    updated
}

/// leave_pair: the caller leaves a 2-member account; the other member becomes
/// the sole member. Replaces the old replace-member flow for the "I want out"
/// case. Only allowed when there are two REAL members (`members[1]` is not the
/// anonymous placeholder) — a solo account is deleted, not left.
///
/// The leaver is removed from `pair.members` (if the creator leaves, the staying
/// member is promoted into slot 0 so the owner invariant holds). On every sheet
/// the leaver's member slot + wrapped key are cleared, revoking their key. When
/// the creator (member_a) leaves, the staying member (member_b) is promoted to
/// member_a and their wrapped key moves to `wrapped_key_a`.
///
/// The staying member keeps read access in BOTH builds. Dev (P-256): their kept /
/// promoted `wrapped_key_a` is either their OWN self-wrap (a sheet they created, or
/// the first sheet self-wrapped at accept_invite) or a TAGGED cross-wrap that embeds
/// the sealer's public key — so they unwrap it with only their own private key even
/// though the departed member's slot is now anonymized (see devVetkd's
/// wrapSheetKeyTagged / unwrapTaggedSheetKey and createSheet's read path). Prod
/// (vetkd): the IC re-derives K_sheet for any member. Both leave directions are
/// covered by createSheet.test.ts (creator-leaves and partner-leaves).
#[ic_cdk::update]
fn leave_pair(pair_id: String) -> Pair {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let (updated, staying) = PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        if !is_member_of(&pair, caller) {
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("not a member of this pair");
        }
        if pair.members[1] == Principal::anonymous() {
            map.insert(pair_id.clone(), pair);
            ic_cdk::trap("cannot leave a solo account; delete it instead");
        }
        let leaving_is_a = pair.members[0] == caller;
        let staying = if leaving_is_a { pair.members[1] } else { pair.members[0] };
        pair.members[0] = staying;
        pair.members[1] = Principal::anonymous();
        map.insert(pair_id.clone(), pair.clone());
        (pair, staying)
    });
    // Rewrite every sheet: clear the leaver, promote the staying member if needed.
    let sheet_ids: Vec<String> = SHEETS.with(|s| {
        s.borrow()
            .iter()
            .filter_map(|(id, sh)| if sh.pair_id == pair_id { Some(id) } else { None })
            .collect()
    });
    for sid in sheet_ids {
        update_sheet_field(&sid, |sh| {
            if sh.member_a == caller {
                // Creator left: promote the staying member into slot A (moving key).
                sh.member_a = staying;
                sh.wrapped_key_a = std::mem::take(&mut sh.wrapped_key_b);
                sh.member_b = Principal::anonymous();
                sh.wrapped_key_b = Vec::new();
            } else if sh.member_b == caller {
                // Partner left: clear slot B, member_a keeps reading.
                sh.member_b = Principal::anonymous();
                sh.wrapped_key_b = Vec::new();
            }
        });
    }
    updated
}

/// archive_pair / unarchive_pair: any member flips the account's organizational
/// `archived_at` flag. Archived accounts move to the "Archived" section of the
/// accounts list but stay fully readable; any member can unarchive.
#[ic_cdk::update]
fn archive_pair(pair_id: String) -> Pair {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    set_pair_archived(&pair_id, caller, true)
}

#[ic_cdk::update]
fn unarchive_pair(pair_id: String) -> Pair {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    set_pair_archived(&pair_id, caller, false)
}

fn set_pair_archived(pair_id: &str, caller: Principal, archived: bool) -> Pair {
    PAIRS.with(|p| {
        let mut map = p.borrow_mut();
        let mut pair = match map.remove(&pair_id.to_string()) {
            Some(x) => x,
            None => ic_cdk::trap("pair not found"),
        };
        if !is_member_of(&pair, caller) {
            map.insert(pair_id.to_string(), pair);
            ic_cdk::trap("not a member of this pair");
        }
        pair.archived_at = if archived { Some(now_nanos()) } else { None };
        map.insert(pair_id.to_string(), pair.clone());
        pair
    })
}

/// delete_pair: permanently removes a SINGLE-MEMBER, ARCHIVED account and all of
/// its sheets/entries/counters/invite from stable memory. Restricted so there is
/// never a partner's data at stake (`members[1] == anonymous`), and only after
/// the account was archived (a deliberate two-step guard for an irreversible op).
#[ic_cdk::update]
fn delete_pair(pair_id: String) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let pair = match PAIRS.with(|p| p.borrow().get(&pair_id).clone()) {
        Some(p) => p,
        None => ic_cdk::trap("pair not found"),
    };
    if !is_member_of(&pair, caller) {
        ic_cdk::trap("not a member of this pair");
    }
    if pair.archived_at.is_none() {
        ic_cdk::trap("archive the account before deleting it");
    }
    if pair.members[1] != Principal::anonymous() {
        ic_cdk::trap("cannot delete an account that still has another member; leave first");
    }
    // Collect this pair's sheet ids, then purge their entries + counters + the sheets.
    let sheet_ids: Vec<String> = SHEETS.with(|s| {
        s.borrow()
            .iter()
            .filter_map(|(id, sh)| if sh.pair_id == pair_id { Some(id) } else { None })
            .collect()
    });
    for sid in &sheet_ids {
        for e in sheet_entries_iter(sid) {
            sheet_entries_remove(sid, e.id);
        }
        ENTRY_COUNTERS.with(|m| m.borrow_mut().remove(sid));
        SHEETS.with(|s| s.borrow_mut().remove(sid));
    }
    INVITES.with(|i| i.borrow_mut().remove(&pair.invite_code));
    PAIRS.with(|p| p.borrow_mut().remove(&pair_id));
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
    // v1.4.0 (solo sheets): the anonymous slot is a real, persistent value
    // now, so it must never participate in a replacement. Adding a partner
    // to a solo pair is join_pair's job, not replace.
    if req.leaving_principal == Principal::anonymous()
        || req.new_principal == Principal::anonymous()
    {
        ic_cdk::trap("anonymous principal cannot take part in a member replacement");
    }
    if pair.members.get(1) == Some(&Principal::anonymous()) {
        ic_cdk::trap("cannot replace a member on a solo pair; invite a partner via join instead");
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
                sh.closed_at = Some(now_nanos());
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

// ─────────────────────────── in-canister tests ───────────────────────────
//
// Pure-Rust tests of the entry-key format and the sheet_id
// extraction. These are the building blocks of the v1.3.2 entry
// storage fix (issue #1); the actual end-to-end multi-sheet
// isolation is verified via the IBE + smoke runs against a
// fresh canister. Run with `cargo test --lib`.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_key_format_is_unique_per_sheet_and_id() {
        // Same (sheet_id, entry_id) → same key.
        assert_eq!(entry_key("sheet-a", 1), entry_key("sheet-a", 1));
        // Different sheet_id → different key.
        assert_ne!(entry_key("sheet-a", 1), entry_key("sheet-b", 1));
        // Different entry_id → different key.
        assert_ne!(entry_key("sheet-a", 1), entry_key("sheet-a", 2));
    }

    #[test]
    fn entry_key_round_trips_through_extract() {
        for sheet in &["a", "sheet-with-dashes", "1234567890abcdef"] {
            for id in [0u64, 1, 42, u64::MAX, 1_000_000_000_000] {
                let k = entry_key(sheet, id);
                assert_eq!(entry_key_sheet_id(&k), *sheet, "round-trip for sheet={sheet} id={id}");
            }
        }
    }

    #[test]
    fn entry_key_is_nul_separated_and_lexicographic() {
        // The fixed-width entry id suffix means (sheet_a, 2) sorts
        // BEFORE (sheet_a, 10) — useful for stable iter() ordering.
        let k_a_2 = entry_key("a", 2);
        let k_a_10 = entry_key("a", 10);
        let k_b_1 = entry_key("b", 1);
        assert!(k_a_2 < k_a_10, "lexicographic: a\\0...02 < a\\0...10");
        assert!(k_a_10 < k_b_1, "lexicographic: a* < b*");
    }

    #[test]
    fn chat_link_key_is_caller_scoped_and_unambiguous() {
        // v1.9.0: CHAT_SHEET_LINKS uses `caller\0chat_key` composite
        // keys. Same caller + chat → same key; anything else differs.
        let a = Principal::from_text("aaaaa-aa").unwrap();
        let b = Principal::anonymous();
        assert_eq!(chat_link_key(&a, "group:x"), chat_link_key(&a, "group:x"));
        assert_ne!(chat_link_key(&a, "group:x"), chat_link_key(&a, "group:y"));
        assert_ne!(chat_link_key(&a, "group:x"), chat_link_key(&b, "group:x"));
        // The caller-prefix scan in chat_sheet_links() relies on the
        // NUL separator: a key belongs to caller `p` iff it starts
        // with `p.to_text() + "\0"`. Principal text never contains
        // NUL, so no other principal's keys can match the prefix.
        let key = chat_link_key(&a, "channel:xyz:42");
        assert!(key.starts_with(&format!("{}\0", a.to_text())));
        assert_eq!(&key[a.to_text().len() + 1..], "channel:xyz:42");
    }

    #[test]
    fn create_pair_check_pattern_is_atomic() {
        // Documentation test: v1.3.2's create_pair does the
        // membership check + insert in a single PAIRS.with(|p| { ... })
        // closure with no await between, so two concurrent
        // create_pair calls from the same principal cannot both
        // pass the check. The real concurrency test would
        // require a PocketIC integration harness; see
        // docs/VERIFICATION-2026-06-16.md for the multi-call
        // test pattern. This test is a placeholder that asserts
        // nothing at runtime — it's here so a future edit
        // that moves the check outside the closure will trigger
        // a code review via this comment.
    }

    #[test]
    fn entries_lives_on_dedicated_memory_id() {
        // Documentation test (issue #7 fix, v1.3.3): ENTRIES lives on
        // a FRESH MemoryId (currently 16) and MUST NOT be re-`init`-ed
        // on a region that previously held a different key/value
        // type. `ic-stable-structures` stores a per-region header
        // describing the original key/value type, and re-`init` under
        // a different type traps in `init`, which fails
        // `post_upgrade`. We hit this in v1.3.2: the entries map
        // moved from `u64` keys to `String` keys but stayed on
        // MemoryId 11 — the old `u64` header was incompatible and
        // the upgrade could trap. The v1.3.3 fix moves ENTRIES to
        // MemoryId 16 and leaves 11-15 orphaned.
        //
        // The actual MemoryId number is hardcoded in the
        // `ENTRIES` thread_local! initializer above. If a future
        // refactor moves ENTRIES (or changes its key/value type),
        // update both the initializer AND this comment so the
        // next maintainer sees the constraint. Also: never re-use
        // an orphaned MemoryId (11-15) for a new structure with
        // a different key/value type — the same trap is waiting.
        //
        // We can't easily probe the live `MemoryId` number from a
        // test (the thread_local! initializer runs at canister
        // start, not in cargo test), so this is a placeholder
        // that asserts nothing at runtime. Its job is to make the
        // above constraint visible to anyone reading the test
        // file.
    }

    #[test]
    fn schema_version_bumped_for_memory_id_move() {
        // Documentation test (issue #7 fix, v1.3.3): SCHEMA_VERSION
        // was bumped from 2 to 3 to record the ENTRIES -> MemoryId 16
        // move. Any future change to a map's key/value type OR
        // MemoryId assignment must bump SCHEMA_VERSION again so
        // `post_upgrade` can log the migration clearly.
        //
        // The constant lives at the top of the stable-state
        // comment block. If a future refactor undoes the bump,
        // update this comment so the next maintainer can see
        // why the bump matters (it's the only signal an operator
        // gets about which storage version they're running).
        //
        // Use a const block so the assertion runs at compile
        // time — if SCHEMA_VERSION is ever dropped below 3 the
        // test crate won't compile, which is the loudest possible
        // signal.
        const { assert!(SCHEMA_VERSION >= 3, "SCHEMA_VERSION must be >= 3 after the v1.3.3 MemoryId move (issue #7)") };
    }

    // ── v1.12.0: shared transaction types per account ──────────────────

    fn p(byte: u8) -> Principal {
        Principal::from_slice(&[byte])
    }

    #[test]
    fn templates_blob_guards_mirror_set_user_templates_not_check_name_blob() {
        let iv12 = vec![0u8; 12];
        // empty ciphertext trap
        assert!(check_templates_blob(&[], &iv12).is_err());
        // 64KB cap (set_user_templates' 64_000, NOT check_name_blob's 1024)
        assert!(check_templates_blob(&vec![0u8; 64_000], &iv12).is_ok());
        assert!(check_templates_blob(&vec![0u8; 64_001], &iv12).is_err());
        // a >1KB blob is FINE here (this is what rules out the name channel)
        assert!(check_templates_blob(&vec![0u8; 2048], &iv12).is_ok());
        // iv must be 12..=16
        assert!(check_templates_blob(&[1], &vec![0u8; 11]).is_err());
        assert!(check_templates_blob(&[1], &vec![0u8; 12]).is_ok());
        assert!(check_templates_blob(&[1], &vec![0u8; 16]).is_ok());
        assert!(check_templates_blob(&[1], &vec![0u8; 17]).is_err());
    }

    #[test]
    fn member_slot_routes_by_caller_and_rejects_outsiders() {
        let members = [p(1), p(2)];
        // members[0] writes the a-slot, members[1] the b-slot
        assert_eq!(member_slot(&members, p(1)), Some(0));
        assert_eq!(member_slot(&members, p(2)), Some(1));
        // a non-member gets None (set_pair_templates traps on it)
        assert_eq!(member_slot(&members, p(3)), None);
        // the anonymous principal NEVER matches — even a solo pair whose
        // members[1] slot IS anonymous must not hand out the b-slot
        let solo = [p(1), Principal::anonymous()];
        assert_eq!(member_slot(&solo, Principal::anonymous()), None);
        assert_eq!(member_slot(&solo, p(1)), Some(0));
        assert_eq!(member_slot(&solo, p(9)), None);
    }

    #[test]
    fn pair_decodes_pre_v1_12_records_with_template_slots_absent() {
        // Candid backward-compat: a Pair encoded WITHOUT the v1.12.0
        // template fields (i.e. any record written before this upgrade)
        // must decode with all four = None. Same additive-`opt` pattern
        // as the v1.5.0 name fields.
        #[derive(CandidType, Deserialize)]
        struct OldPair {
            id: String,
            members: [Principal; 2],
            invite_code: String,
            created_at: u64,
            archived_at: Option<u64>,
            name_enc: Option<Vec<u8>>,
            name_iv: Option<Vec<u8>>,
            member_a_name_enc: Option<Vec<u8>>,
            member_a_name_iv: Option<Vec<u8>>,
            member_b_name_enc: Option<Vec<u8>>,
            member_b_name_iv: Option<Vec<u8>>,
        }
        let old = OldPair {
            id: "pair-1".into(),
            members: [p(1), p(2)],
            invite_code: "AAAA-BBBB".into(),
            created_at: 42,
            archived_at: None,
            name_enc: Some(vec![9, 9]),
            name_iv: Some(vec![0u8; 12]),
            member_a_name_enc: None,
            member_a_name_iv: None,
            member_b_name_enc: None,
            member_b_name_iv: None,
        };
        let bytes = Encode!(&old).expect("encode old pair");
        let new = Decode!(&bytes, Pair).expect("old Pair must decode as new Pair");
        assert_eq!(new.id, "pair-1");
        assert_eq!(new.members, [p(1), p(2)]);
        assert_eq!(new.name_enc, Some(vec![9, 9]));
        assert_eq!(new.templates_a_enc, None);
        assert_eq!(new.templates_a_iv, None);
        assert_eq!(new.templates_b_enc, None);
        assert_eq!(new.templates_b_iv, None);
    }

    #[test]
    fn config_decodes_pre_card_currency_records_as_none() {
        // Additive `opt` on the Config CELL: a Config written before v1.12.0 must decode with
        // card_currency = None, so an existing deployment upgrades without trapping and the card
        // simply falls back to per-user deferral until someone sets one.
        #[derive(CandidType, Deserialize)]
        struct OldConfig {
            creator_principal: Principal,
            deployed_at: u64,
        }
        let old = OldConfig { creator_principal: p(1), deployed_at: 99 };
        let bytes = Encode!(&old).expect("encode old config");
        let new = Config::from_bytes(std::borrow::Cow::Owned(bytes));
        assert_eq!(new.creator_principal, p(1));
        assert_eq!(new.deployed_at, 99);
        assert_eq!(new.card_currency, None);
    }

    #[test]
    fn config_round_trips_with_card_currency() {
        let cfg = Config {
            creator_principal: p(2),
            deployed_at: 7,
            card_currency: Some("EGP".into()),
        };
        let back = Config::from_bytes(cfg.to_bytes());
        assert_eq!(back.card_currency, Some("EGP".to_string()));
        assert_eq!(back.creator_principal, p(2));
        assert_eq!(back.deployed_at, 7);
    }

    #[test]
    fn user_record_decodes_pre_default_currency_records_as_none() {
        // Additive-`opt`: a UserRecord written before v1.12.0 (no default_currency) must decode with
        // None so the app knows to push the browser-cached value up once, instead of trapping.
        #[derive(CandidType, Deserialize)]
        struct OldUserRecord {
            user_principal: Principal,
            wrapped_display_name: Vec<u8>,
            display_name_iv: Vec<u8>,
            created_at: u64,
            templates_enc: Option<Vec<u8>>,
            templates_iv: Option<Vec<u8>>,
        }
        let old = OldUserRecord {
            user_principal: p(1),
            wrapped_display_name: vec![1, 2, 3],
            display_name_iv: vec![0u8; 12],
            created_at: 42,
            templates_enc: Some(vec![7]),
            templates_iv: Some(vec![0u8; 12]),
        };
        let bytes = Encode!(&old).expect("encode old user");
        let new = UserRecord::from_bytes(std::borrow::Cow::Owned(bytes));
        assert_eq!(new.user_principal, p(1));
        assert_eq!(new.wrapped_display_name, vec![1, 2, 3]);
        assert_eq!(new.created_at, 42);
        assert_eq!(new.templates_enc, Some(vec![7]));
        assert_eq!(new.default_currency, None);
    }

    #[test]
    fn user_record_round_trips_with_default_currency() {
        // Forward path through the same Storable the stable map uses.
        let rec = UserRecord {
            user_principal: p(2),
            wrapped_display_name: vec![9],
            display_name_iv: vec![0u8; 12],
            created_at: 7,
            templates_enc: None,
            templates_iv: None,
            default_currency: Some("EGP".into()),
        };
        let back = UserRecord::from_bytes(rec.to_bytes());
        assert_eq!(back.default_currency, Some("EGP".to_string()));
        assert_eq!(back.created_at, 7);
        assert_eq!(back.wrapped_display_name, vec![9]);
    }

    #[test]
    fn schema_version_bumped_for_user_default_currency() {
        // v1.12.0 added UserRecord.default_currency (schema v8 -> v9).
        const {
            assert!(
                SCHEMA_VERSION >= 9,
                "SCHEMA_VERSION must be >= 9 after adding UserRecord.default_currency"
            )
        };
    }

    #[test]
    fn sheet_decodes_pre_v1_12_records_that_still_carry_enabled_currencies() {
        // Candid backward-compat for a field REMOVAL (the mirror of the additive case above).
        // v1.12.0 dropped `enabled_currencies` from Sheet: a sheet has no currency of its own, and the
        // canister could never validate an entry's currency anyway (entries are E2E encrypted). Every
        // sheet written BEFORE that upgrade still has the field in its stored bytes, so decoding must
        // skip it rather than fail — otherwise `Sheet::from_bytes`' `.unwrap()` would trap the canister
        // on the first read of any pre-existing sheet.
        #[derive(CandidType, Deserialize)]
        struct OldSheet {
            id: String,
            pair_id: String,
            state: SheetState,
            enabled_currencies: Vec<String>,
            closing_window_days: u32,
            last_entry_at: Option<u64>,
            wrapped_key_a: Vec<u8>,
            wrapped_key_b: Vec<u8>,
            member_a: Principal,
            member_b: Principal,
            created_at: u64,
            closed_at: Option<u64>,
            closing_balances: Option<Vec<ClosingBalance>>,
            name_enc: Option<Vec<u8>>,
            name_iv: Option<Vec<u8>>,
        }
        let old = OldSheet {
            id: "c819f76d77f260b3".into(),
            pair_id: "pair-1".into(),
            state: SheetState::Active,
            enabled_currencies: vec!["USD".into(), "EGP".into()],
            closing_window_days: 365,
            last_entry_at: Some(11),
            wrapped_key_a: vec![1, 2, 3],
            wrapped_key_b: vec![4, 5, 6],
            member_a: p(1),
            member_b: p(2),
            created_at: 42,
            closed_at: None,
            closing_balances: None,
            name_enc: Some(vec![9, 9]),
            name_iv: Some(vec![0u8; 12]),
        };
        let bytes = Encode!(&old).expect("encode old sheet");
        // Decode through the SAME path the stable map uses.
        let new = Sheet::from_bytes(std::borrow::Cow::Owned(bytes));
        assert_eq!(new.id, "c819f76d77f260b3");
        assert_eq!(new.pair_id, "pair-1");
        assert_eq!(new.closing_window_days, 365);
        assert_eq!(new.last_entry_at, Some(11));
        assert_eq!(new.wrapped_key_a, vec![1, 2, 3]);
        assert_eq!(new.wrapped_key_b, vec![4, 5, 6]);
        assert_eq!(new.member_a, p(1));
        assert_eq!(new.member_b, p(2));
        assert_eq!(new.name_enc, Some(vec![9, 9]));
        // And a fresh sheet still round-trips (no currency field to carry).
        let round = Sheet::from_bytes(new.to_bytes());
        assert_eq!(round.id, new.id);
        assert_eq!(round.closing_window_days, 365);
    }

    #[test]
    fn pair_round_trips_with_template_slots_via_storable() {
        // Forward path: a post-upgrade Pair carrying both slots survives
        // the Storable encode/decode used by the stable map.
        let pair = Pair {
            id: "pair-2".into(),
            members: [p(1), p(2)],
            invite_code: "CCCC-DDDD".into(),
            created_at: 7,
            archived_at: None,
            name_enc: None,
            name_iv: None,
            member_a_name_enc: None,
            member_a_name_iv: None,
            member_b_name_enc: None,
            member_b_name_iv: None,
            templates_a_enc: Some(vec![1, 2, 3]),
            templates_a_iv: Some(vec![0u8; 12]),
            templates_b_enc: Some(vec![4, 5, 6]),
            templates_b_iv: Some(vec![1u8; 16]),
        };
        let back = Pair::from_bytes(pair.to_bytes());
        assert_eq!(back.templates_a_enc, Some(vec![1, 2, 3]));
        assert_eq!(back.templates_a_iv, Some(vec![0u8; 12]));
        assert_eq!(back.templates_b_enc, Some(vec![4, 5, 6]));
        assert_eq!(back.templates_b_iv, Some(vec![1u8; 16]));
    }

    #[test]
    fn schema_version_bumped_for_pair_template_slots() {
        // v1.12.0 added the optional Pair template slots (schema v6 -> v7).
        const {
            assert!(
                SCHEMA_VERSION >= 7,
                "SCHEMA_VERSION must be >= 7 after the v1.12.0 Pair template slots"
            )
        };
    }

    #[test]
    fn schema_version_bumped_for_sheet_currency_removal() {
        // v1.12.0 removed Sheet.enabled_currencies + add_currency (schema v7 -> v8).
        const {
            assert!(
                SCHEMA_VERSION >= 8,
                "SCHEMA_VERSION must be >= 8 after removing Sheet.enabled_currencies"
            )
        };
    }
}
