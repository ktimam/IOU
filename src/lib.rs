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
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

type Memory = VirtualMemory<DefaultMemoryImpl>;

// Resource limits are deliberately generous for normal household/property-manager use while
// putting a hard ceiling on attacker-controlled stable-memory growth. They are enforced at the
// canister boundary; UI limits are not a security boundary.
const MAX_PAIRS_PER_PRINCIPAL: usize = 512;
const MAX_SHEETS_PER_PAIR: usize = 512;
const MAX_ENTRIES_PER_SHEET: u64 = 10_000;
const MAX_ENTRIES_PER_BATCH: usize = 32;
const MAX_BATCH_ENCRYPTED_BYTES: u64 = 256 * 1024;
const MAX_ENTRY_CIPHERTEXT_BYTES: usize = 64_000;
const MAX_ENTRY_HISTORY_VERSIONS: usize = 100;
const MAX_SHEET_ENCRYPTED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_WRAPPED_KEY_BYTES: usize = 8_192;
const MAX_REWRAPS_PER_REQUEST: usize = MAX_SHEETS_PER_PAIR;
const MAX_CHAT_LINKS_PER_PRINCIPAL: usize = 1_024;
const MAX_PENDING_CHAT_ROUTES_PER_PRINCIPAL: usize = 32;
const MAX_PENDING_CHAT_ROUTES_TOTAL: usize = 4_096;
const PENDING_CHAT_ROUTE_TTL_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
// Legacy PAIRS/SHEETS maps predate secondary indexes. Keep every externally reachable fallback
// scan instruction-bounded and fail closed once the deployment outgrows this ceiling. A resumable
// controller-driven stable-index migration is required before raising/removing this guard.
const MAX_LEGACY_GLOBAL_SCAN_RECORDS: usize = 10_000;

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

/// Exact OpenChat registry commitment this deployment has reviewed and is willing to vouch for.
///
/// The manifest itself remains in OpenChat; storing its domain-separated hash plus every routing
/// coordinate prevents this canister from blindly reflecting a publication challenge. This field
/// is optional in `Config`, so canisters upgraded from the V1 verifier decode with verification
/// disabled until an administrator installs the reviewed V2 binding.
#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct AiAppVerificationBinding {
    pub user_index_canister_id: Principal,
    pub app_id: u32,
    pub app_revision: u64,
    pub owner: Principal,
    pub canonical_name: String,
    pub app_canister_id: Principal,
    pub inbox_canister_id: Option<Principal>,
    pub manifest_hash: Vec<u8>,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct Config {
    pub creator_principal: Principal,
    pub deployed_at: u64,
    // The OpenChat registry owner is a user-canister principal and is not necessarily the same
    // principal that installed/administers IOU. Publication is vouched only when the owner supplied
    // by OpenChat exactly matches this separately configured value. Optional keeps old stable Config
    // records Candid-compatible; None means "do not vouch for any registration".
    pub ai_app_owner: Option<Principal>,
    // Exact OpenChat UserIndex trusted for link-code claims and one-time
    // app-card capability redemption. The card endpoint is anonymous by
    // design, so accepting a caller-supplied verifier would turn a malicious
    // canister into an authorization oracle. None fails closed.
    pub openchat_user_index_canister_id: Option<Principal>,
    // OpenChat publication verifier V2 binding. It is cleared automatically whenever the owner or
    // UserIndex trust pin changes. None makes c2c_verify_ai_app_v2 fail closed.
    pub ai_app_verification_binding: Option<AiAppVerificationBinding>,
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
    pub members: [Principal; 2], // [creator, joiner]
    pub invite_code: String,
    pub created_at: u64,
    pub archived_at: Option<u64>, // soft-delete; left in storage
    // v1.5.0: E2E-encrypted display names (AES-GCM under the active
    // sheet's K_sheet; the canister stores ciphertext only). All optional
    // ⇒ Candid-backward-compatible with pre-v1.5.0 records.
    pub name_enc: Option<Vec<u8>>, // account name
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
    pub wrapped_key_a: Vec<u8>, // sealed to member_a's vetkd pub
    pub wrapped_key_b: Vec<u8>, // sealed to member_b's vetkd pub
    pub member_a: Principal,
    pub member_b: Principal,
    pub created_at: u64,
    pub closed_at: Option<u64>,
    // v1.13.0: closing balances are an opaque AES-GCM blob encrypted by the client under K_sheet.
    // The random 32-byte key salt uses the same per-record derivation as encrypted entries. The
    // previous plaintext closing_balances field is intentionally omitted: Candid safely ignores
    // it while decoding old stable records, so historical plaintext is no longer returned.
    pub closing_balances_key: Option<Vec<u8>>,
    pub closing_balances_enc: Option<Vec<u8>>,
    pub closing_balances_iv: Option<Vec<u8>>,
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
pub struct EncryptedClosingBalances {
    pub entry_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
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
    pub entry_key: Vec<u8>,  // 32 random bytes (per-entry salt)
    pub ciphertext: Vec<u8>, // AES-GCM(per_entry_key, K_sheet, payload)
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
//     OpenChat app-scoped chat-handle → sheet mapping. Key is
//     `format!("{}\0{}", caller.to_text(), chat_key)` — see
//     chat_link_key(). Caller-keyed; the stable chat_key field now contains a
//     canonical unpadded base64url encoding of OpenChat's 32-byte app-scoped
//     chat handle. sheet_id is the 16-hex-char sheet id encoded as a u64.
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
//   MemoryIds 22-23: unused.
//   MemoryId 24: SHEET_ENTRY_BYTES (StableBTreeMap<String, u64>)
//     v1.13.0 lazy per-sheet accounting for encrypted entry/history payload quotas.
//   MemoryId 25: CONSUMER_KEY_EPOCHS (StableBTreeMap<Principal, u64>)
//     v1.14.0 monotonic compare-and-swap epoch for consumer-key mutations.
//     Entries remain after delete as stable tombstones, so a set prepared by
//     another browser/process before the delete can never land afterwards.
//   MemoryId 26: OPENCHAT_BINDINGS_BY_IOU
//     One canister-verified OpenChat binding per IOU principal.
//   MemoryId 27: OPENCHAT_BINDINGS_BY_OC
//     Reverse index from deployment/app/OpenChat-user to IOU principal.
//   MemoryId 28: PENDING_CHAT_ROUTES
//     Short-lived, caller-private app-scoped chat handles learned only after
//     redeeming an authenticated, one-time OpenChat chat-link token against
//     the caller's exact current binding. Public APIs expose only a
//     domain-separated digest, never the handle.
//   MemoryId 29: ENTRY_BATCH_RECEIPTS
//     Sheet-scoped exact OpenChat message identity -> committed entry ids. This
//     makes an outcome-unknown batch retry return the original rows instead of
//     adding duplicates even if client-side parsing or encryption later drifts.
//     Additive fresh region.
//
//   DO NOT re-use these orphaned MemoryIds for a new structure
//   with a different key/value type — see issue #7. If you need
//   a new region, use the next free number (currently 30+).

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
// v1.13.0 (schema v9 -> v10): added optional Config.ai_app_owner and MemoryId 24
// encrypted-payload usage counters. Existing counters are populated lazily from
// the per-sheet entry range, avoiding an unbounded upgrade-hook scan.
// v1.13.0 (schema v10 -> v11): replaced plaintext Sheet.closing_balances with
// optional closing_balances_key/enc/iv ciphertext fields. Old records decode by
// ignoring the removed field; historical plaintext cannot be retroactively protected.
// v1.14.0 (schema v11 -> v12): added MemoryId 25 CONSUMER_KEY_EPOCHS. Existing
// keypairs lazily begin at epoch 0; the first accepted set/delete writes epoch 1.
// Deletes retain the epoch with no keypair, forming an upgrade-stable tombstone.
// v1.15.0 (schema v12 -> v13): added authoritative OpenChat identity bindings
// in MemoryIds 26-27 and an optional pinned UserIndex in Config.
// v1.16.0 (schema v13 -> v14): added optional Config.ai_app_verification_binding and optional
// app_revision/app_canister_id/key_version fields to stable OpenChatBinding records. The options
// preserve decoding of existing cells/maps; legacy links deliberately fail private-card access and
// must be recreated through the app-authenticated C2C claim.
// v1.17.0 (schema v14 -> v15): added the optional app_subject/subject_version pair. Newly claimed
// links use only OpenChat's app-scoped subject; the retained openchat_user_id field exists solely so
// v14 stable bytes decode and is anonymous for new rows. Legacy raw-subject rows fail closed.
// v1.18.0 (schema v15 -> v16): added optional OpenChatBinding.consumer_public_key_pem. Existing
// bindings decode with None and deliberately fail key-bound authorization until the owner relinks.
// v1.19.0 (schema v16 -> v17): added MemoryId 28 PENDING_CHAT_ROUTES. Rows are
// bounded, expiring and caller-scoped; no existing chat-link migration is needed.
// v1.20.0 (schema v17 -> v18): added MemoryId 29 ENTRY_BATCH_RECEIPTS. Existing
// entries require no migration; receipts are written only by the new atomic
// batch endpoint and survive state-preserving upgrades.
const SCHEMA_VERSION: u32 = 18;

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
            Config {
                creator_principal: Principal::anonymous(),
                deployed_at: 0,
                ai_app_owner: None,
                openchat_user_index_canister_id: None,
                ai_app_verification_binding: None,
            },
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

    // v1.14.0: canister-owned, per-principal mutation sequence for the
    // consumer-key record. This is intentionally a separate additive map so
    // MemoryId 18 keeps its exact released key/value layout. A missing epoch
    // decodes as legacy epoch 0. Unlike CONSUMER_KEYPAIRS, delete NEVER removes
    // this row: the retained value is the tombstone which rejects stale writes
    // from delayed requests, other devices, or a restarted browser process.
    static CONSUMER_KEY_EPOCHS: RefCell<StableBTreeMap<Principal, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(25)))
        ));

    // OpenChat delivery provenance: per-user app-scoped chat-handle → sheet
    // mapping. OpenChat's v4 envelope carries a secret-derived handle; the PWA lets
    // the user pin "always import this chat's drafts into this sheet".
    // The mapping is caller-keyed (composite String key, see
    // chat_link_key()). The stable chat_key field name is retained for Candid/stable compatibility,
    // but raw OpenChat chat coordinates are rejected and legacy rows are hidden. Mirrors the
    // CONSUMER_KEYPAIRS conventions: fresh MemoryId (19), additive, no migration.
    static CHAT_SHEET_LINKS: RefCell<StableBTreeMap<String, ChatSheetLink, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(19)))
        ));

    static OPENCHAT_BINDINGS_BY_IOU: RefCell<StableBTreeMap<Principal, OpenChatBinding, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(26)))
        ));

    static OPENCHAT_BINDINGS_BY_OC: RefCell<StableBTreeMap<String, Principal, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(27)))
        ));

    static PENDING_CHAT_ROUTES: RefCell<StableBTreeMap<String, PendingChatRoute, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(28)))
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

    // v1.13.0: cached encrypted payload bytes per sheet. Existing sheets initialize lazily from
    // the bounded entry-key range on their first add/edit, so no unbounded post-upgrade migration is
    // required. MemoryId 24 is fresh; do not reuse an orphaned region for a different type.
    static SHEET_ENTRY_BYTES: RefCell<StableBTreeMap<String, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(24)))
        ));

    // v1.20.0: atomic/idempotent multi-entry imports. Fresh MemoryId 29;
    // never reuse an orphaned region because stable-map headers are typed.
    static ENTRY_BATCH_RECEIPTS: RefCell<StableBTreeMap<String, EntryBatchReceipt, Memory>> =
        RefCell::new(StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MemoryId::new(29)))
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

fn entry_key_bounds(sheet_id: &str, max_id: u64) -> (String, String) {
    (entry_key(sheet_id, 0), entry_key(sheet_id, max_id))
}

/// Extract the sheet_id from an entry key. Returns the slice
/// up to the first NUL byte.
#[cfg(test)]
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

/// Returns every entry for the given sheet, in id-ascending order. Composite keys are contiguous,
/// so use StableBTreeMap::range rather than scanning every user's entries.
fn sheet_entries_iter(sheet_id: &str) -> Vec<Entry> {
    let (start, end) = entry_key_bounds(sheet_id, u64::MAX);
    ENTRIES.with(|m| {
        m.borrow()
            .range(start..=end)
            .map(|(_, value)| value)
            .collect()
    })
}

fn entry_blob_bytes(entry_key: &[u8], ciphertext: &[u8], iv: &[u8]) -> u64 {
    entry_key
        .len()
        .saturating_add(ciphertext.len())
        .saturating_add(iv.len()) as u64
}

fn stored_entry_bytes(entry: &Entry) -> u64 {
    let current = entry_blob_bytes(&entry.entry_key, &entry.ciphertext, &entry.iv);
    entry
        .history
        .as_deref()
        .unwrap_or_default()
        .iter()
        .fold(current, |total, version| {
            total.saturating_add(entry_blob_bytes(
                &version.entry_key,
                &version.ciphertext,
                &version.iv,
            ))
        })
}

/// Return the sheet's current encrypted-payload usage. The cache is initialized lazily so an
/// upgrade from a pre-quota release does not need to scan every entry in post_upgrade.
fn sheet_entry_bytes(sheet_id: &str) -> u64 {
    if let Some(cached) = SHEET_ENTRY_BYTES.with(|m| m.borrow().get(&sheet_id.to_string())) {
        return cached;
    }
    let total = sheet_entries_iter(sheet_id)
        .iter()
        .fold(0u64, |sum, entry| {
            sum.saturating_add(stored_entry_bytes(entry))
        });
    SHEET_ENTRY_BYTES.with(|m| {
        m.borrow_mut().insert(sheet_id.to_string(), total);
    });
    total
}

fn add_sheet_entry_bytes(sheet_id: &str, additional: u64) {
    let current = sheet_entry_bytes(sheet_id);
    let next = current
        .checked_add(additional)
        .unwrap_or_else(|| ic_cdk::trap("sheet encrypted-byte counter overflow"));
    if next > MAX_SHEET_ENCRYPTED_BYTES {
        ic_cdk::trap("sheet encrypted payload quota exceeded");
    }
    SHEET_ENTRY_BYTES.with(|m| {
        m.borrow_mut().insert(sheet_id.to_string(), next);
    });
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
    // Bind administration to the installer/controller during the install message. Previously the
    // cell stayed anonymous and the first arbitrary authenticated caller could claim the canister.
    let installer = ic_cdk::api::msg_caller();
    if installer == Principal::anonymous() || !ic_cdk::api::is_controller(&installer) {
        ic_cdk::trap("installer must be an authenticated canister controller");
    }
    CONFIG.with(|c| {
        let current = c.borrow().get().clone();
        let _ = c.borrow_mut().set(Config {
            creator_principal: installer,
            deployed_at: ic_cdk::api::time(),
            ai_app_owner: current.ai_app_owner,
            openchat_user_index_canister_id: current.openchat_user_index_canister_id,
            ai_app_verification_binding: current.ai_app_verification_binding,
        });
    });
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

fn can_manage_config(creator: Principal, caller: Principal, caller_is_controller: bool) -> bool {
    caller != Principal::anonymous() && (caller_is_controller || creator == caller)
}

fn validate_entry_blob(entry_key: &[u8], ciphertext: &[u8], iv: &[u8]) -> Result<(), &'static str> {
    if entry_key.len() != 32 {
        return Err("entry_key must be 32 bytes");
    }
    // AES-GCM ciphertext always includes a 16-byte authentication tag.
    if ciphertext.len() < 16 {
        return Err("ciphertext is too short for an AES-GCM authentication tag");
    }
    if ciphertext.len() > MAX_ENTRY_CIPHERTEXT_BYTES {
        return Err("ciphertext exceeds the 64000-byte limit");
    }
    if !(12..=16).contains(&iv.len()) {
        return Err("iv length must be 12..=16 bytes");
    }
    Ok(())
}

fn validate_wrapped_key(blob: &[u8], allow_empty: bool) -> Result<(), &'static str> {
    if blob.is_empty() && !allow_empty {
        return Err("wrapped key must not be empty");
    }
    if blob.len() > MAX_WRAPPED_KEY_BYTES {
        return Err("wrapped key exceeds the 8192-byte limit");
    }
    Ok(())
}

fn validate_optional_name(enc: &Option<Vec<u8>>, iv: &Option<Vec<u8>>) -> Result<(), &'static str> {
    match (enc.as_deref(), iv.as_deref()) {
        (None, None) => Ok(()),
        (Some(enc), Some(iv)) => {
            if enc.is_empty() || enc.len() > 1_024 {
                return Err("name ciphertext length out of range");
            }
            if !(12..=16).contains(&iv.len()) {
                return Err("name iv length out of range");
            }
            Ok(())
        }
        _ => Err("name ciphertext and iv must either both be present or both be absent"),
    }
}

fn principal_pair_count(principal: Principal) -> usize {
    PAIRS.with(|pairs| {
        let mut scanned = 0usize;
        let mut count = 0usize;
        for (_, pair) in pairs.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "account");
            if is_member_of(&pair, principal) {
                count += 1;
                if count > MAX_PAIRS_PER_PRINCIPAL {
                    break;
                }
            }
        }
        count
    })
}

fn pair_sheet_count(pair_id: &str) -> usize {
    SHEETS.with(|sheets| {
        let mut scanned = 0usize;
        let mut count = 0usize;
        for (_, sheet) in sheets.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "sheet");
            if sheet.pair_id == pair_id {
                count += 1;
                if count > MAX_SHEETS_PER_PAIR {
                    break;
                }
            }
        }
        count
    })
}

fn pair_sheet_ids(pair_id: &str) -> Vec<String> {
    SHEETS.with(|sheets| {
        let mut scanned = 0usize;
        let mut ids = Vec::new();
        for (id, sheet) in sheets.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "sheet");
            if sheet.pair_id == pair_id {
                if ids.len() >= MAX_SHEETS_PER_PAIR {
                    ic_cdk::trap("sheet quota exceeded in legacy state; migration required");
                }
                ids.push(id);
            }
        }
        ids
    })
}

fn checked_legacy_scan_increment(scanned: &mut usize) -> Result<(), &'static str> {
    *scanned = scanned.saturating_add(1);
    if *scanned > MAX_LEGACY_GLOBAL_SCAN_RECORDS {
        Err("legacy global scan limit reached; migrate stable secondary indexes")
    } else {
        Ok(())
    }
}

fn require_legacy_scan_capacity(scanned: &mut usize, collection: &str) {
    if checked_legacy_scan_increment(scanned).is_err() {
        ic_cdk::trap(format!(
            "{collection} index migration required: legacy global scan limit reached"
        ));
    }
}

fn principal_can_read_sheet(sheet: &Sheet, principal: Principal) -> bool {
    principal != Principal::anonymous()
        && (sheet.member_a == principal || sheet.member_b == principal)
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
        "set_ai_app_owner",
        "set_openchat_user_index_canister_id",
        "set_ai_app_verification_binding",
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
        "close_sheet_encrypted",
        "start_new_sheet",
        // v1.5.0: encrypted names
        "set_pair_name",
        "set_sheet_name",
        "set_member_name",
        // v1.12.0: shared transaction types per account
        "set_pair_templates",
        // Phase 4: entries
        "add_entry",
        "add_entry_batch",
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
        "chat_routable_sheet_ids",
        "pending_chat_routes",
        "claim_openchat_chat_route",
        "assign_pending_chat_route",
        "dismiss_pending_chat_route",
        "remove_pending_chat_route_link",
        // v1.15.0: authenticated OC identity binding + anonymous,
        // capability-gated encrypted card context.
        "connect_openchat",
        "get_openchat_binding",
        "disconnect_openchat",
        "openchat_card_context",
        "openchat_private_match_context",
        // App-authoritative shared-account fan-out. The method itself pins the exact UserIndex
        // canister caller; it is intentionally not a normal signed-in-user endpoint.
        "c2c_authorize_ai_action_recipients",
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
        "set_ai_app_owner",
        "set_openchat_user_index_canister_id",
        "set_ai_app_verification_binding",
        "create_pair",
        "join_pair",
        "issue_invite",
        "accept_invite",
        "leave_pair",
        "archive_pair",
        "unarchive_pair",
        "delete_pair",
        "create_sheet",
        "close_sheet_encrypted",
        "start_new_sheet",
        "add_entry",
        "add_entry_batch",
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
        "claim_openchat_chat_route",
        "assign_pending_chat_route",
        "dismiss_pending_chat_route",
        "remove_pending_chat_route_link",
        "connect_openchat",
        "disconnect_openchat",
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
    check_name_blob(&wrapped_display_name, &display_name_iv);
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
    if let Err(msg) = check_templates_blob(&templates_enc, &templates_iv) {
        ic_cdk::trap(msg);
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

// Legacy V1 OpenChat verifier. Kept only for wire compatibility with older local deployments;
// current OpenChat publication never consults it because name+owner alone do not bind a manifest,
// registry, revision, route, or app canister.
#[derive(CandidType, Deserialize)]
struct VerifyAiAppArgs {
    name: String,
    owner: Principal,
}

#[derive(CandidType, Deserialize)]
struct VerifyAiAppResponse {
    vouched: bool,
    name: Option<String>,
    owner: Option<Principal>,
}

fn verify_ai_app(
    args: VerifyAiAppArgs,
    configured_owner: Option<Principal>,
) -> VerifyAiAppResponse {
    let vouched = configured_owner
        .as_ref()
        .map(|owner| *owner != Principal::anonymous() && args.name == "iou" && args.owner == *owner)
        .unwrap_or(false);
    VerifyAiAppResponse {
        vouched,
        name: Some("iou".to_string()),
        owner: configured_owner,
    }
}

#[ic_cdk::query]
fn c2c_verify_ai_app(args: VerifyAiAppArgs) -> VerifyAiAppResponse {
    let configured_owner = CONFIG.with(|c| c.borrow().get().ai_app_owner);
    verify_ai_app(args, configured_owner)
}

#[derive(CandidType, Deserialize)]
struct VerifyAiAppV2Args {
    binding: AiAppVerificationBinding,
}

#[derive(CandidType, Deserialize)]
struct VerifyAiAppV2Response {
    vouched: bool,
    binding: AiAppVerificationBinding,
}

fn verification_binding_is_valid(
    binding: &AiAppVerificationBinding,
    configured_owner: Option<Principal>,
    configured_user_index: Option<Principal>,
    app_canister_id: Principal,
) -> bool {
    binding.user_index_canister_id != Principal::anonymous()
        && binding.owner != Principal::anonymous()
        && binding.app_canister_id != Principal::anonymous()
        && binding.app_id > 0
        && binding.app_revision > 0
        && binding.canonical_name == "iou"
        && binding.manifest_hash.len() == 32
        && binding
            .inbox_canister_id
            .map(|id| id != Principal::anonymous())
            .unwrap_or(true)
        && configured_owner == Some(binding.owner)
        && configured_user_index == Some(binding.user_index_canister_id)
        && binding.app_canister_id == app_canister_id
}

fn verify_ai_app_v2(
    challenge: AiAppVerificationBinding,
    configured: Option<AiAppVerificationBinding>,
    configured_owner: Option<Principal>,
    configured_user_index: Option<Principal>,
    app_canister_id: Principal,
    caller: Principal,
) -> VerifyAiAppV2Response {
    // A false response still needs a non-optional binding on the wire. Return the independently
    // stored value when available; otherwise echo the challenge with `vouched = false`. OpenChat
    // accepts only true plus byte-for-byte equality, so the disabled case cannot grant authority.
    let response_binding = configured.clone().unwrap_or_else(|| challenge.clone());
    let vouched = configured.as_ref() == Some(&challenge)
        && verification_binding_is_valid(
            &challenge,
            configured_owner,
            configured_user_index,
            app_canister_id,
        )
        && caller == challenge.user_index_canister_id;
    VerifyAiAppV2Response {
        vouched,
        binding: response_binding,
    }
}

/// Vouch only for the exact V2 registry commitment independently installed by this canister's
/// administrator. This deliberately does not hash or trust the caller's manifest challenge.
#[ic_cdk::query]
fn c2c_verify_ai_app_v2(args: VerifyAiAppV2Args) -> VerifyAiAppV2Response {
    let config = CONFIG.with(|c| c.borrow().get().clone());
    verify_ai_app_v2(
        args.binding,
        config.ai_app_verification_binding,
        config.ai_app_owner,
        config.openchat_user_index_canister_id,
        ic_cdk::api::canister_self(),
        ic_cdk::api::msg_caller(),
    )
}

// Generic OpenChat card-attestation contracts. These mirror OpenChat's
// language-neutral V1 wire types locally so IOU independently decides whether
// an exact public card and an exact edited confirmation payload are acceptable.
// OpenChat remains app-agnostic: the IOU-specific schema checks live here.
#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AttestedActionCardRow {
    label: String,
    value: String,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AiAppCardContentV1 {
    title: String,
    rows: Vec<AttestedActionCardRow>,
    confirm_label: String,
    cancel_label: String,
    action_id: String,
    disclosure: Option<String>,
    expires_at: Option<u64>,
    confirm_payload: Option<Vec<u8>>,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AppScopedCardContextV1 {
    context_version: u16,
    app_subject: Vec<u8>,
    chat_handle: Vec<u8>,
    message_handle: Vec<u8>,
    app_id: u32,
    app_revision: u64,
    action_id: String,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AppScopedCardContentCommitmentV1 {
    context: AppScopedCardContextV1,
    content: AiAppCardContentV1,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct CardAttestationBindingV1 {
    user_index_canister_id: Principal,
    app_canister_id: Principal,
    commitment: AppScopedCardContentCommitmentV1,
    authority_content_hash: [u8; 32],
}

#[derive(CandidType, Deserialize)]
struct AttestAiAppCardV1Args {
    binding: CardAttestationBindingV1,
}

#[derive(CandidType, Deserialize)]
struct AttestAiAppCardV1Response {
    vouched: bool,
    binding: CardAttestationBindingV1,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct CardConfirmationAttestationBindingV1 {
    user_index_canister_id: Principal,
    app_canister_id: Principal,
    context: AppScopedCardContextV1,
    content_hash: [u8; 32],
    confirm_payload: Vec<u8>,
    app_user_key_version: Option<u64>,
}

#[derive(CandidType, Deserialize)]
struct AttestAiAppCardConfirmationV1Args {
    binding: CardConfirmationAttestationBindingV1,
}

#[derive(CandidType, Deserialize)]
struct AttestAiAppCardConfirmationV1Response {
    vouched: bool,
    binding: CardConfirmationAttestationBindingV1,
}

/// OpenChat's app-authoritative recipient callback. All user/account coordinates stay inside IOU;
/// the response contains only the opaque app subject, queue selector and independently registered
/// public key that UserIndex already knows how to validate for each recipient.
#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AuthorizeAiActionRecipientsArgs {
    context: AppScopedCardContextV1,
    content_hash: Vec<u8>,
    confirm_payload_hash: Vec<u8>,
    confirmation_lease_generation: u64,
    /// Immutable confirmation provenance timestamp (milliseconds).
    created_at: u64,
    /// Fresh timestamp for this exact authorization/deposit attempt (milliseconds).
    authorization_created_at: u64,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AuthorizedAiActionRecipient {
    app_subject: Vec<u8>,
    subject_version: u16,
    consumer_queue_selector: Vec<u8>,
    consumer_queue_selector_version: u16,
    consumer_public_key: String,
    app_user_key_version: u64,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct AuthorizeAiActionRecipientsSuccess {
    recipients: Vec<AuthorizedAiActionRecipient>,
    scope_commitment: Vec<u8>,
    expires_at: u64,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
enum AuthorizeAiActionRecipientsResponse {
    Success(AuthorizeAiActionRecipientsSuccess),
    NotAuthorized,
    Stale,
    InvalidRequest(String),
}

#[derive(Clone, Debug)]
struct RecipientBindingState {
    binding: OpenChatBinding,
    current_consumer_public_key: Option<String>,
}

const IOU_CARD_ACTION_ID: &str = "iou.entry.import";
const IOU_CARD_TITLE: &str = "Add to IOU";
const IOU_CARD_CONFIRM_LABEL: &str = "Add to IOU";
const IOU_CARD_CANCEL_LABEL: &str = "Cancel";
const MAX_CARD_CONFIRM_PAYLOAD_BYTES: usize = 16_384;
const MAX_CARD_DRAFTS: usize = 32;
const MAX_CARD_SOURCE_INTERVAL_CHARS: usize = 96;
const TEMPLATE_REF_PREFIX: &str = "ioutr1.";
const TEMPLATE_REF_MAX_LENGTH: usize = 1_416;
const AI_ACTION_RECIPIENT_GRANT_TTL_MS: u64 = 300_000;

#[derive(Clone, Debug)]
struct AttestedEntryDraft {
    amount: serde_json::Number,
    kind: Option<String>,
    currency: Option<String>,
    direction: Option<String>,
    date: Option<String>,
    note: Option<String>,
    message: Option<String>,
    // Initial card evidence only: IOU's renderer projects these paired endpoint values into the
    // reviewed note. They are not entry fields and must never enter a final confirmation payload.
    interval_start: Option<String>,
    interval_end: Option<String>,
    template_ref: Option<String>,
}

// A custom visitor rejects duplicate and unknown keys. Parsing to a generic
// JSON map first would silently collapse duplicates, which can create
// cross-language interpretation differences at this security boundary.
impl<'de> Deserialize<'de> for AttestedEntryDraft {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct EntryVisitor;
        impl<'de> Visitor<'de> for EntryVisitor {
            type Value = AttestedEntryDraft;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an IOU entry-draft object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut seen = BTreeSet::new();
                let mut amount = None;
                let mut kind = None;
                let mut currency = None;
                let mut direction = None;
                let mut date = None;
                let mut note = None;
                let mut message = None;
                let mut interval_start = None;
                let mut interval_end = None;
                let mut template_ref = None;
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom("duplicate entry-draft field"));
                    }
                    match key.as_str() {
                        "amount" => amount = Some(map.next_value()?),
                        "kind" => kind = Some(map.next_value()?),
                        "currency" => currency = Some(map.next_value()?),
                        "direction" => direction = Some(map.next_value()?),
                        "date" => date = Some(map.next_value()?),
                        "note" => note = Some(map.next_value()?),
                        "message" => message = Some(map.next_value()?),
                        "interval_start" => interval_start = Some(map.next_value()?),
                        "interval_end" => interval_end = Some(map.next_value()?),
                        "template_ref" => template_ref = Some(map.next_value()?),
                        _ => {
                            let _: de::IgnoredAny = map.next_value()?;
                            return Err(de::Error::custom("unknown entry-draft field"));
                        }
                    }
                }
                Ok(AttestedEntryDraft {
                    amount: amount.ok_or_else(|| de::Error::missing_field("amount"))?,
                    kind,
                    currency,
                    direction,
                    date,
                    note,
                    message,
                    interval_start,
                    interval_end,
                    template_ref,
                })
            }
        }
        deserializer.deserialize_map(EntryVisitor)
    }
}

#[derive(Debug)]
struct AttestedEntryDrafts(Vec<AttestedEntryDraft>);

impl<'de> Deserialize<'de> for AttestedEntryDrafts {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct PayloadVisitor;
        impl<'de> Visitor<'de> for PayloadVisitor {
            type Value = AttestedEntryDrafts;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("one IOU entry draft or a non-empty array of drafts")
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let draft =
                    AttestedEntryDraft::deserialize(de::value::MapAccessDeserializer::new(map))?;
                Ok(AttestedEntryDrafts(vec![draft]))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut drafts = Vec::new();
                while let Some(draft) = seq.next_element::<AttestedEntryDraft>()? {
                    if drafts.len() == MAX_CARD_DRAFTS {
                        return Err(de::Error::custom("too many entry drafts"));
                    }
                    drafts.push(draft);
                }
                if drafts.is_empty() {
                    return Err(de::Error::custom("entry-draft array must not be empty"));
                }
                Ok(AttestedEntryDrafts(drafts))
            }
        }
        deserializer.deserialize_any(PayloadVisitor)
    }
}

fn is_ascii_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, byte)| i == 4 || i == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u16>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u8>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u8>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days_in_month
}

fn is_structural_encrypted_template_ref(value: &str) -> bool {
    if value.len() <= TEMPLATE_REF_PREFIX.len()
        || value.len() > TEMPLATE_REF_MAX_LENGTH
        || !value.starts_with(TEMPLATE_REF_PREFIX)
    {
        return false;
    }
    let encoded = &value[TEMPLATE_REF_PREFIX.len()..];
    let sextet = |byte: u8| match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    };
    let remainder = encoded.len() % 4;
    if remainder == 1 || !encoded.bytes().all(|byte| sextet(byte).is_some()) {
        return false;
    }
    let last = encoded
        .as_bytes()
        .last()
        .and_then(|byte| sextet(*byte))
        .unwrap_or_default();
    if (remainder == 2 && last & 0x0f != 0) || (remainder == 3 && last & 0x03 != 0) {
        return false;
    }
    // 12-byte IV + at least one plaintext byte + 16-byte GCM tag. The
    // browser codec uses canonical unpadded base64url and caps plaintext.
    let decoded_len = encoded.len().saturating_mul(3) / 4;
    (29..=1_052).contains(&decoded_len)
}

fn contains_whole_text_token(text: &str, token: &str) -> bool {
    let folded_text = text.to_lowercase();
    let folded_token = token.to_lowercase();
    if folded_token.is_empty() {
        return false;
    }
    folded_text
        .match_indices(&folded_token)
        .any(|(start, matched)| {
            let before_is_word = folded_text[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric);
            let end = start + matched.len();
            let after_is_word = folded_text[end..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric);
            !before_is_word && !after_is_word
        })
}

fn text_currency_evidence_matches(text: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token
        .chars()
        .any(|ch| !ch.is_alphanumeric() && !ch.is_whitespace())
    {
        return text.to_lowercase().contains(&token.to_lowercase());
    }
    contains_whole_text_token(text, token)
}

fn initial_currency_is_evidenced(draft: &AttestedEntryDraft) -> bool {
    let (Some(currency), Some(message)) = (draft.currency.as_deref(), draft.message.as_deref())
    else {
        // Image-only extraction deliberately omits its model-authored message echo. Without an
        // authenticated source-modality flag the attester cannot distinguish that valid case from
        // text with no echo, so the strict evidence check applies whenever authoritative text is
        // actually present. OpenChat independently applies the same registered schema policy.
        return true;
    };
    let aliases: &[&str] = match currency {
        "USD" => &["$", "dollar", "dollars", "US dollar", "US dollars"],
        "GBP" => &["£", "pound sterling", "pounds sterling"],
        "EUR" => &["€", "euro", "euros"],
        "JPY" => &["¥", "yen"],
        "INR" => &["₹", "rupee", "rupees"],
        "EGP" => &["E£", "Egyptian pound", "Egyptian pounds", "ج.م"],
        _ => &[],
    };
    text_currency_evidence_matches(message, currency)
        || aliases
            .iter()
            .any(|alias| text_currency_evidence_matches(message, alias))
}

fn bounded_card_source_interval(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_CARD_SOURCE_INTERVAL_CHARS
        && !value.chars().any(|ch| {
            matches!(ch, '\0'..='\u{1f}' | '\u{7f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn validate_attested_entry_draft(draft: &AttestedEntryDraft, allow_template_ref: bool) -> bool {
    let Some(amount) = draft.amount.as_f64() else {
        return false;
    };
    let minor_units = (amount * 100.0).round();
    amount.is_finite()
        && amount > 0.0
        && minor_units.is_finite()
        && (1.0..=9_007_199_254_740_991.0).contains(&minor_units)
        && matches!(draft.kind.as_deref(), Some("iou" | "settlement"))
        && draft.currency.as_deref().is_none_or(|value| {
            value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase())
        })
        && matches!(draft.direction.as_deref(), Some("credit" | "debt"))
        && draft.date.as_deref().is_none_or(is_ascii_date)
        && draft
            .note
            .as_deref()
            .is_none_or(|value| value.chars().count() <= 4_096 && !value.contains('\0'))
        && draft.message.as_deref().is_none_or(|value| {
            !value.is_empty() && value.chars().count() <= 200 && !value.contains('\0')
        })
        // `allow_template_ref=false` is the initial model-produced stored payload. Confirmation
        // payloads use true and may contain a currency the user explicitly edited in the card.
        && (allow_template_ref || initial_currency_is_evidenced(draft))
        // The app's extraction schema declares these values as paired, bounded source evidence.
        // Their bytes are covered by initial content attestation, but do not add public summary
        // rows or bypass canonical `date` validation. Only IOU's renderer interprets them. The
        // renderer removes both after composing the visible note, before final confirmation.
        && match (&draft.interval_start, &draft.interval_end) {
            (None, None) => true,
            (Some(start), Some(end)) => {
                !allow_template_ref
                    && bounded_card_source_interval(start)
                    && bounded_card_source_interval(end)
            }
            _ => false,
        }
        && match draft.template_ref.as_deref() {
            None => true,
            Some(value) => allow_template_ref && is_structural_encrypted_template_ref(value),
        }
}

fn parse_attested_entry_drafts(
    payload: &[u8],
    allow_template_ref: bool,
) -> Option<Vec<AttestedEntryDraft>> {
    if payload.is_empty() || payload.len() > MAX_CARD_CONFIRM_PAYLOAD_BYTES {
        return None;
    }
    let mut deserializer = serde_json::Deserializer::from_slice(payload);
    let parsed = AttestedEntryDrafts::deserialize(&mut deserializer).ok()?;
    deserializer.end().ok()?;
    parsed
        .0
        .iter()
        .all(|draft| validate_attested_entry_draft(draft, allow_template_ref))
        .then_some(parsed.0)
}

fn draft_public_values(draft: &AttestedEntryDraft) -> Vec<(&'static str, String)> {
    [
        Some(("Amount", draft.amount.to_string())),
        draft.currency.clone().map(|value| ("Currency", value)),
        // This is the public transaction kind (iou/settlement), not a private
        // account Type. Account Type is accepted only as encrypted template_ref.
        draft.kind.clone().map(|value| ("Type", value)),
        draft.direction.clone().map(|value| ("Direction", value)),
        draft.date.clone().map(|value| ("Date", value)),
        draft.note.clone().map(|value| ("Note", value)),
    ]
    .into_iter()
    .flatten()
    .filter(|(_, value)| !value.is_empty())
    .collect()
}

fn exact_iou_card_content_is_valid(content: &AiAppCardContentV1) -> bool {
    if content.confirm_label != IOU_CARD_CONFIRM_LABEL
        || content.cancel_label != IOU_CARD_CANCEL_LABEL
        || content.action_id != IOU_CARD_ACTION_ID
        // The explicit app identity, title, and "Add to IOU" action already state the destination.
        // Requiring a second informational acknowledgement only adds a redundant click.
        || content.disclosure.is_some()
        || content.expires_at.is_some()
    {
        return false;
    }
    let Some(payload) = content.confirm_payload.as_deref() else {
        return false;
    };
    let Some(drafts) = parse_attested_entry_drafts(payload, false) else {
        return false;
    };
    let expected_rows = if drafts.len() == 1 {
        draft_public_values(&drafts[0])
            .into_iter()
            .map(|(label, value)| AttestedActionCardRow {
                label: label.to_string(),
                value,
            })
            .collect::<Vec<_>>()
    } else {
        drafts
            .iter()
            .enumerate()
            .map(|(index, draft)| AttestedActionCardRow {
                label: format!("Entry {}", index + 1),
                value: draft_public_values(draft)
                    .into_iter()
                    .map(|(label, value)| format!("{label}: {value}"))
                    .collect::<Vec<_>>()
                    .join(" · "),
            })
            .collect::<Vec<_>>()
    };
    let expected_title = if drafts.len() == 1 {
        IOU_CARD_TITLE.to_string()
    } else {
        format!("{IOU_CARD_TITLE} ({} entries)", drafts.len())
    };
    content.title == expected_title && content.rows == expected_rows
}

fn current_card_link_matches(
    link: Option<&OpenChatBinding>,
    user_index_canister_id: Principal,
    app_canister_id: Principal,
    app_subject: &[u8],
    app_id: u32,
    app_revision: u64,
    key_version: Option<u64>,
) -> bool {
    let Some(link) = link else {
        return false;
    };
    link.user_index_canister_id == user_index_canister_id
        && link.app_canister_id == Some(app_canister_id)
        && valid_app_subject(link) == Some(app_subject)
        && link.app_id == app_id
        && link.app_revision == Some(app_revision)
        && link.key_version.is_some_and(|version| version > 0)
        && key_version.is_none_or(|version| Some(version) == link.key_version)
}

fn valid_app_scoped_card_context(context: &AppScopedCardContextV1) -> bool {
    context.context_version == 1
        && context.app_subject.len() == 32
        && context.chat_handle.len() == 32
        && context.message_handle.len() == 32
        && !context.action_id.is_empty()
        && context.action_id.len() <= 128
}

fn lowercase_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn base64url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(b2 & 0x3f) as usize] as char);
        }
    }
    out
}

/// Decode the one canonical text spelling of a 32-byte opaque token. Keeping
/// this tiny decoder local avoids accepting padded/base64 aliases (or adding a
/// dependency whose permissive mode could accidentally do so).
fn decode_base64url_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 43 {
        return None;
    }
    let mut decoded = [0u8; 32];
    let mut out_len = 0usize;
    let mut accumulator = 0u32;
    let mut bits = 0u8;
    for byte in value.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if out_len >= decoded.len() {
                return None;
            }
            decoded[out_len] = (accumulator >> bits) as u8;
            out_len += 1;
            accumulator &= (1u32 << bits).saturating_sub(1);
        }
    }
    if out_len != decoded.len() || bits != 2 || accumulator != 0 {
        return None;
    }
    (base64url_no_pad(&decoded) == value).then_some(decoded)
}

fn scoped_chat_handle_key(handle: &[u8]) -> Option<String> {
    (handle.len() == 32).then(|| base64url_no_pad(handle))
}

fn attests_exact_iou_card(
    binding: &CardAttestationBindingV1,
    configured: Option<&AiAppVerificationBinding>,
    link: Option<&OpenChatBinding>,
    app_canister_id: Principal,
    caller: Principal,
) -> bool {
    let Some(configured) = configured else {
        return false;
    };
    caller == configured.user_index_canister_id
        && binding.user_index_canister_id == configured.user_index_canister_id
        && binding.app_canister_id == app_canister_id
        && configured.app_canister_id == app_canister_id
        && configured.inbox_canister_id.is_some()
        && valid_app_scoped_card_context(&binding.commitment.context)
        && binding.commitment.context.app_id == configured.app_id
        && binding.commitment.context.app_revision == configured.app_revision
        && binding.commitment.context.action_id == IOU_CARD_ACTION_ID
        && binding.authority_content_hash.iter().any(|byte| *byte != 0)
        && current_card_link_matches(
            link,
            binding.user_index_canister_id,
            app_canister_id,
            &binding.commitment.context.app_subject,
            binding.commitment.context.app_id,
            binding.commitment.context.app_revision,
            None,
        )
        && exact_iou_card_content_is_valid(&binding.commitment.content)
}

/// Vouch for the exact public card only after independently hashing and
/// validating every row and consumer payload. Private Type names and ids
/// cannot enter this initial/public payload.
#[ic_cdk::update]
fn c2c_attest_ai_app_card_v1(args: AttestAiAppCardV1Args) -> AttestAiAppCardV1Response {
    let app_canister_id = ic_cdk::api::canister_self();
    let caller = ic_cdk::api::msg_caller();
    let configured =
        CONFIG.with(|config| config.borrow().get().ai_app_verification_binding.clone());
    let link = openchat_binding_for_subject(
        args.binding.user_index_canister_id,
        args.binding.commitment.context.app_id,
        &args.binding.commitment.context.app_subject,
    );
    let vouched = attests_exact_iou_card(
        &args.binding,
        configured.as_ref(),
        link.as_ref(),
        app_canister_id,
        caller,
    );
    AttestAiAppCardV1Response {
        vouched,
        binding: args.binding,
    }
}

fn private_reference_sheet_access_is_valid(
    link: Option<&OpenChatBinding>,
    chat_handle: &[u8],
) -> bool {
    let Some(link) = link else {
        return false;
    };
    let Some(chat_key) = scoped_chat_handle_key(chat_handle) else {
        return false;
    };
    let Some(sheet_id) = linked_sheet_for(link.iou_principal, &chat_key) else {
        return false;
    };
    principal_owns_sheet(link.iou_principal, &sheet_id) && sheet_is_active(&sheet_id)
}

fn attests_exact_iou_card_confirmation(
    binding: &CardConfirmationAttestationBindingV1,
    configured: Option<&AiAppVerificationBinding>,
    link: Option<&OpenChatBinding>,
    app_canister_id: Principal,
    caller: Principal,
    private_sheet_access_valid: bool,
) -> bool {
    let Some(configured) = configured else {
        return false;
    };
    let Some(drafts) = parse_attested_entry_drafts(&binding.confirm_payload, true) else {
        return false;
    };
    let has_private_reference = drafts.iter().any(|draft| draft.template_ref.is_some());
    caller == configured.user_index_canister_id
        && binding.user_index_canister_id == configured.user_index_canister_id
        && binding.app_canister_id == app_canister_id
        && configured.app_canister_id == app_canister_id
        && configured.inbox_canister_id.is_some()
        && valid_app_scoped_card_context(&binding.context)
        && binding.context.app_id == configured.app_id
        && binding.context.app_revision == configured.app_revision
        && binding.context.action_id == IOU_CARD_ACTION_ID
        && binding.content_hash.iter().any(|byte| *byte != 0)
        && current_card_link_matches(
            link,
            binding.user_index_canister_id,
            app_canister_id,
            &binding.context.app_subject,
            binding.context.app_id,
            binding.context.app_revision,
            binding.app_user_key_version,
        )
        && binding.app_user_key_version.is_some()
        && (!has_private_reference || private_sheet_access_valid)
}

/// Vouch for the exact final bytes edited inside the app-rendered card. The
/// only private account-Type field accepted is a structurally valid opaque
/// template_ref; plaintext template/type fields are rejected as unknown.
#[ic_cdk::update]
fn c2c_attest_ai_app_card_confirmation_v1(
    args: AttestAiAppCardConfirmationV1Args,
) -> AttestAiAppCardConfirmationV1Response {
    let app_canister_id = ic_cdk::api::canister_self();
    let caller = ic_cdk::api::msg_caller();
    let configured =
        CONFIG.with(|config| config.borrow().get().ai_app_verification_binding.clone());
    let link = openchat_binding_for_subject(
        args.binding.user_index_canister_id,
        args.binding.context.app_id,
        &args.binding.context.app_subject,
    );
    let private_sheet_access_valid =
        private_reference_sheet_access_is_valid(link.as_ref(), &args.binding.context.chat_handle);
    let vouched = attests_exact_iou_card_confirmation(
        &args.binding,
        configured.as_ref(),
        link.as_ref(),
        app_canister_id,
        caller,
        private_sheet_access_valid,
    );
    AttestAiAppCardConfirmationV1Response {
        vouched,
        binding: args.binding,
    }
}

#[ic_cdk::update]
fn set_creator_principal(p: Principal) {
    require_authed();
    if p == Principal::anonymous() {
        ic_cdk::trap("creator principal must not be anonymous");
    }
    let caller = ic_cdk::api::msg_caller();
    CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let current = cfg.get().clone();
        if !can_manage_config(
            current.creator_principal,
            caller,
            ic_cdk::api::is_controller(&caller),
        ) {
            ic_cdk::trap("only the creator or a canister controller can change configuration");
        }
        let _ = cfg.set(Config {
            creator_principal: p,
            deployed_at: ic_cdk::api::time(),
            ai_app_owner: current.ai_app_owner,
            openchat_user_index_canister_id: current.openchat_user_index_canister_id,
            ai_app_verification_binding: current.ai_app_verification_binding.clone(),
        });
    });
}

/// Configure the exact OpenChat user-canister principal allowed to register this IOU deployment.
/// Passing anonymous clears the binding and makes verification fail closed.
#[ic_cdk::update]
fn set_ai_app_owner(owner: Principal) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let trust_changed = CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let current = cfg.get().clone();
        if !can_manage_config(
            current.creator_principal,
            caller,
            ic_cdk::api::is_controller(&caller),
        ) {
            ic_cdk::trap("only the creator or a canister controller can change configuration");
        }
        let next_owner = (owner != Principal::anonymous()).then_some(owner);
        let verification_binding = current
            .ai_app_verification_binding
            .clone()
            .filter(|binding| Some(binding.owner) == next_owner);
        let trust_changed = current.ai_app_owner != next_owner
            || current.ai_app_verification_binding != verification_binding;
        let _ = cfg.set(Config {
            creator_principal: current.creator_principal,
            deployed_at: current.deployed_at,
            ai_app_owner: next_owner,
            openchat_user_index_canister_id: current.openchat_user_index_canister_id,
            ai_app_verification_binding: verification_binding,
        });
        trust_changed
    });
    if trust_changed {
        clear_all_pending_chat_routes();
    }
}

/// Pin the only OpenChat UserIndex whose link claims and card capabilities
/// this deployment will accept. Passing anonymous clears the pin and makes
/// both flows fail closed.
#[ic_cdk::update]
fn set_openchat_user_index_canister_id(canister_id: Principal) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let trust_changed = CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let current = cfg.get().clone();
        if !can_manage_config(
            current.creator_principal,
            caller,
            ic_cdk::api::is_controller(&caller),
        ) {
            ic_cdk::trap("only the creator or a canister controller can change configuration");
        }
        let next_user_index = (canister_id != Principal::anonymous()).then_some(canister_id);
        let verification_binding = current
            .ai_app_verification_binding
            .clone()
            .filter(|binding| Some(binding.user_index_canister_id) == next_user_index);
        let trust_changed = current.openchat_user_index_canister_id != next_user_index
            || current.ai_app_verification_binding != verification_binding;
        let _ = cfg.set(Config {
            creator_principal: current.creator_principal,
            deployed_at: current.deployed_at,
            ai_app_owner: current.ai_app_owner,
            openchat_user_index_canister_id: next_user_index,
            ai_app_verification_binding: verification_binding,
        });
        trust_changed
    });
    if trust_changed {
        clear_all_pending_chat_routes();
    }
}

/// Install or clear the exact OpenChat verifier-v2 commitment reviewed for this IOU deployment.
///
/// Registration is an upsert and every security-relevant manifest edit receives a new revision,
/// so this value must be refreshed before publication. The setter refuses a binding that does not
/// match the already-pinned owner/UserIndex or this canister; callers cannot use it to widen trust.
#[ic_cdk::update]
fn set_ai_app_verification_binding(binding: Option<AiAppVerificationBinding>) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let trust_changed = CONFIG.with(|c| {
        let mut cfg = c.borrow_mut();
        let current = cfg.get().clone();
        if !can_manage_config(
            current.creator_principal,
            caller,
            ic_cdk::api::is_controller(&caller),
        ) {
            ic_cdk::trap("only the creator or a canister controller can change configuration");
        }
        if let Some(candidate) = binding.as_ref() {
            if !verification_binding_is_valid(
                candidate,
                current.ai_app_owner,
                current.openchat_user_index_canister_id,
                ic_cdk::api::canister_self(),
            ) {
                ic_cdk::trap(
                    "verification binding must match the pinned owner, UserIndex, this app canister, canonical name iou, and a 32-byte manifest hash",
                );
            }
        }
        let trust_changed = current.ai_app_verification_binding != binding;
        let _ = cfg.set(Config {
            creator_principal: current.creator_principal,
            deployed_at: current.deployed_at,
            ai_app_owner: current.ai_app_owner,
            openchat_user_index_canister_id: current.openchat_user_index_canister_id,
            ai_app_verification_binding: binding,
        });
        trust_changed
    });
    if trust_changed {
        clear_all_pending_chat_routes();
    }
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
    if principal_pair_count(caller) >= MAX_PAIRS_PER_PRINCIPAL {
        ic_cdk::trap("account quota reached for this principal");
    }
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
        let mut map = p.borrow_mut();
        if INVITES.with(|invites| invites.borrow().contains_key(&invite)) {
            ic_cdk::trap("invite code collision; please retry");
        }
        // V5 fix: pre-insert existence check. now_id uses 64 bits
        // of raw_rand entropy so collisions are vanishingly unlikely,
        // but check anyway to fail loudly if it ever happens.
        if map.contains_key(&id) {
            ic_cdk::trap("pair id collision; please retry");
        }
        // A principal may be in any number of pairs concurrently — one shared
        // ledger per partner. The earlier v1 "at most one active pair per
        // principal" restriction was dropped (see the comment it replaced):
        // get_my_pairs already returns the full list and the UI picks among
        // them, join_pair never enforced the limit anyway, and there is no
        // principal->pair index to maintain — sheets are keyed per pair and
        // keys per principal, so quota enforcement currently uses a bounded scan. The
        // `archived_at` field is retained for a future leave/close-pair action.
        let mut scanned = 0usize;
        let mut count = 0usize;
        for (_, existing) in map.iter() {
            require_legacy_scan_capacity(&mut scanned, "account");
            if is_member_of(&existing, caller) {
                count += 1;
                if count >= MAX_PAIRS_PER_PRINCIPAL {
                    break;
                }
            }
        }
        if count >= MAX_PAIRS_PER_PRINCIPAL {
            ic_cdk::trap("account quota reached for this principal");
        }
        map.insert(id.clone(), pair);
        INVITES.with(|invites| {
            invites.borrow_mut().insert(invite.clone(), id.clone());
        });
    });
    CreatePairResult {
        pair_id: id,
        invite_code: invite,
    }
}

/// join_pair: consumes an invite code, adds the caller as member B.
#[ic_cdk::update]
fn join_pair(invite_code: String) -> String {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if principal_pair_count(caller) >= MAX_PAIRS_PER_PRINCIPAL {
        ic_cdk::trap("account quota reached for this principal");
    }
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
    // Bound legacy responses and scan SHEETS once rather than once for every account.
    let pairs: Vec<Pair> = PAIRS.with(|p| {
        let mut scanned = 0usize;
        let mut out = Vec::new();
        for (_, pair) in p.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "account");
            if is_member_of(&pair, caller) {
                if out.len() >= MAX_PAIRS_PER_PRINCIPAL {
                    ic_cdk::trap("account quota exceeded in legacy state; migration required");
                }
                out.push(pair);
            }
        }
        out
    });
    let mut sheet_stats: BTreeMap<String, (Option<String>, u32)> = pairs
        .iter()
        .map(|pair| (pair.id.clone(), (None, 0)))
        .collect();
    SHEETS.with(|s| {
        let mut scanned = 0usize;
        for (_, sheet) in s.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "sheet");
            let Some((active, archived)) = sheet_stats.get_mut(&sheet.pair_id) else {
                continue;
            };
            match sheet.state {
                SheetState::Active => *active = Some(sheet.id),
                SheetState::Closed => *archived = archived.saturating_add(1),
            }
        }
    });
    pairs
        .into_iter()
        .map(|pair| {
            let caller_is_a = pair.members[0] == caller;
            let other_principal = if caller_is_a {
                pair.members[1]
            } else {
                pair.members[0]
            };
            let (other_name_enc, other_name_iv) = if caller_is_a {
                (
                    pair.member_b_name_enc.clone(),
                    pair.member_b_name_iv.clone(),
                )
            } else {
                (
                    pair.member_a_name_enc.clone(),
                    pair.member_a_name_iv.clone(),
                )
            };
            let (active_sheet_id, archived_sheet_count) =
                sheet_stats.remove(&pair.id).unwrap_or((None, 0));
            PairSummary {
                id: pair.id,
                other_principal,
                active_sheet_id,
                archived_sheet_count,
                created_at: pair.created_at,
                archived_at: pair.archived_at,
                name_enc: pair.name_enc,
                name_iv: pair.name_iv,
                other_name_enc,
                other_name_iv,
            }
        })
        .collect()
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
    if let Err(msg) = validate_wrapped_key(&req.wrapped_key_a, false) {
        ic_cdk::trap(msg);
    }
    if let Err(msg) = validate_wrapped_key(&req.wrapped_key_b, true) {
        ic_cdk::trap(msg);
    }
    if let Err(msg) = validate_optional_name(&req.name_enc, &req.name_iv) {
        ic_cdk::trap(msg);
    }
    // v1 constraints we enforce:
    if req.closing_window_days < 30 || req.closing_window_days > 730 {
        ic_cdk::trap("closing_window_days must be 30..=730");
    }
    // Early rejection avoids paying for raw_rand when a legacy account is already over quota.
    // The count is checked again atomically immediately before insertion below.
    if pair_sheet_count(&req.pair_id) >= MAX_SHEETS_PER_PAIR {
        ic_cdk::trap("sheet quota reached for this account");
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
        if !is_solo && req.wrapped_key_b.is_empty() {
            ic_cdk::trap("wrapped_key_b must not be empty for a two-member sheet");
        }
        let wrapped_key_b = if is_solo {
            Vec::new()
        } else {
            req.wrapped_key_b.clone()
        };
        // v1: only one active sheet per pair. The check + insert
        // are in the same synchronous block (no await between), so
        // two concurrent create_sheet calls for the same pair
        // cannot both pass the check.
        let mut sheet_count = 0usize;
        let mut scanned = 0usize;
        for (_id, existing) in s.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "sheet");
            if existing.pair_id == req.pair_id {
                sheet_count += 1;
                if let SheetState::Active = existing.state {
                    ic_cdk::trap("pair already has an active sheet");
                }
            }
        }
        if sheet_count >= MAX_SHEETS_PER_PAIR {
            ic_cdk::trap("sheet quota reached for this account");
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
            closing_balances_key: None,
            closing_balances_enc: None,
            closing_balances_iv: None,
            name_enc: req.name_enc,
            name_iv: req.name_iv,
        };
        s.borrow_mut().insert(id, sheet.clone());
        sheet
    });
    sheet
}

/// get_sheet: full sheet record. Caller must be an explicitly recorded sheet member.
#[ic_cdk::query]
fn get_sheet(sheet_id: String) -> Option<Sheet> {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    SHEETS.with(|s| {
        s.borrow()
            .get(&sheet_id)
            .filter(|sheet| principal_can_read_sheet(sheet, caller))
    })
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
    if !allowed {
        ic_cdk::trap("not a member of this pair");
    }
    let mut out: Vec<Sheet> = SHEETS.with(|s| {
        let mut scanned = 0usize;
        let mut out = Vec::new();
        for (_, sh) in s.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "sheet");
            if sh.pair_id == pair_id
                && matches!(sh.state, SheetState::Closed)
                && principal_can_read_sheet(&sh, caller)
            {
                if out.len() >= MAX_SHEETS_PER_PAIR {
                    ic_cdk::trap("sheet quota exceeded in legacy state; migration required");
                }
                out.push(sh);
            }
        }
        out
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

/// Close a sheet while preserving the E2E boundary. The client serializes the balance snapshot and
/// encrypts it under K_sheet before calling; the canister validates only the AES-GCM envelope and
/// never receives currency, amount, or direction in plaintext.
#[ic_cdk::update]
fn close_sheet_encrypted(sheet_id: String, closing_balances: EncryptedClosingBalances) {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    if let Err(msg) = validate_entry_blob(
        &closing_balances.entry_key,
        &closing_balances.ciphertext,
        &closing_balances.iv,
    ) {
        ic_cdk::trap(msg);
    }
    let ok = update_sheet_field(&sheet_id, |sheet| {
        if !principal_can_read_sheet(sheet, caller) {
            ic_cdk::trap("not a member of this sheet");
        }
        if let SheetState::Closed = sheet.state {
            ic_cdk::trap("sheet is already closed");
        }
        sheet.state = SheetState::Closed;
        sheet.closed_at = Some(now_nanos());
        sheet.closing_balances_key = Some(closing_balances.entry_key.clone());
        sheet.closing_balances_enc = Some(closing_balances.ciphertext.clone());
        sheet.closing_balances_iv = Some(closing_balances.iv.clone());
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

/// One ciphertext-only row in an atomic entry batch. The sheet id and
/// idempotency coordinates live once on `AddEntryBatchReq` so they cannot
/// disagree between rows.
#[derive(Clone, CandidType, Deserialize)]
pub struct EncryptedEntryInput {
    pub entry_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
}

/// Atomically import one OpenChat message containing 1..=32 ledger rows.
///
/// `import_id` is the exact 32-byte app-scoped OpenChat message handle (or a
/// domain-separated 32-byte digest for the legacy relay). The receipt is
/// authoritative for that sheet/message identity: a retry returns the original
/// ids even if the client re-parses or re-encrypts the message differently.
#[derive(Clone, CandidType, Deserialize)]
pub struct AddEntryBatchReq {
    pub sheet_id: String,
    pub import_id: Vec<u8>,
    pub entries: Vec<EncryptedEntryInput>,
}

#[derive(Clone, CandidType, Deserialize)]
pub struct AddEntryBatchResult {
    pub entry_ids: Vec<u64>,
    pub replayed: bool,
}

/// Upgrade-stable receipt for an atomic import. Keyed by sheet + import id,
/// deliberately not by caller: both sheet members receive the same OpenChat
/// message handle, so simultaneous imports converge on one set of entries.
#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct EntryBatchReceipt {
    entry_ids: Vec<u64>,
    created_at: u64,
}

impl Storable for EntryBatchReceipt {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
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
        if cur >= MAX_ENTRIES_PER_SHEET {
            ic_cdk::trap("entry quota reached for this sheet");
        }
        let next = cur
            .checked_add(1)
            .unwrap_or_else(|| ic_cdk::trap("entry id counter overflow"));
        map.insert(sheet_id.to_string(), next);
        next
    })
}

fn entry_batch_receipt_key(sheet_id: &str, import_id: &[u8]) -> String {
    let encoded: String = import_id.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{sheet_id}\0{encoded}")
}

fn entry_batch_receipt_bounds(sheet_id: &str) -> (String, String) {
    (format!("{sheet_id}\0"), format!("{sheet_id}\u{1}"))
}

fn clear_entry_batch_receipts_for_sheet(sheet_id: &str) {
    let (start, end) = entry_batch_receipt_bounds(sheet_id);
    let keys: Vec<String> = ENTRY_BATCH_RECEIPTS.with(|receipts| {
        receipts
            .borrow()
            .range(start..end)
            .map(|(key, _)| key)
            .collect()
    });
    ENTRY_BATCH_RECEIPTS.with(|receipts| {
        let mut map = receipts.borrow_mut();
        for key in keys {
            map.remove(&key);
        }
    });
}

#[derive(Debug)]
struct ValidatedEntryBatch {
    entry_ids: Vec<u64>,
    next_sheet_bytes: u64,
    #[cfg(test)]
    replay: bool,
}

impl ValidatedEntryBatch {
    fn entry_ids(&self) -> &[u64] {
        &self.entry_ids
    }

    fn next_sheet_bytes(&self) -> u64 {
        self.next_sheet_bytes
    }

    #[cfg(test)]
    fn is_replay(&self) -> bool {
        self.replay
    }

    #[cfg(test)]
    fn receipt(&self) -> EntryBatchReceipt {
        EntryBatchReceipt {
            entry_ids: self.entry_ids.clone(),
            created_at: 0,
        }
    }
}

/// Validate the complete request and calculate every id/quota counter before
/// any stable write. A synchronous canister update is transactional, so an
/// unexpected trap during the subsequent commit also rolls every stable-map
/// write back; the explicit preflight keeps all expected failures before that
/// commit begins.
fn validate_add_entry_batch<F>(
    req: &AddEntryBatchReq,
    current_counter: u64,
    existing: Option<&EntryBatchReceipt>,
    current_sheet_bytes: F,
) -> Result<ValidatedEntryBatch, &'static str>
where
    F: FnOnce() -> u64,
{
    validate_entry_batch_import_id(&req.import_id)?;

    // The receipt is the authoritative outcome for (sheet, exact import id).
    // Deliberately do not inspect row count or ciphertext first: an
    // outcome-unknown retry may have been re-parsed, filtered, or encrypted
    // differently after the original commit.
    if let Some(receipt) = existing {
        validate_entry_batch_receipt(receipt)?;
        return Ok(ValidatedEntryBatch {
            entry_ids: receipt.entry_ids.clone(),
            next_sheet_bytes: 0,
            #[cfg(test)]
            replay: true,
        });
    }

    validate_new_entry_batch_shape(req)?;

    let mut additional_bytes = 0u64;
    for row in &req.entries {
        validate_entry_blob(&row.entry_key, &row.ciphertext, &row.iv)?;
        additional_bytes = additional_bytes
            .checked_add(entry_blob_bytes(&row.entry_key, &row.ciphertext, &row.iv))
            .ok_or("batch encrypted-byte counter overflow")?;
    }
    if additional_bytes > MAX_BATCH_ENCRYPTED_BYTES {
        return Err("entry batch encrypted payload exceeds the 262144-byte limit");
    }

    let count = u64::try_from(req.entries.len()).map_err(|_| "entry batch is too large")?;
    let last_id = current_counter
        .checked_add(count)
        .ok_or("entry id counter overflow")?;
    if last_id > MAX_ENTRIES_PER_SHEET {
        return Err("entry quota reached for this sheet");
    }
    // This lazy stable-map scan is intentionally after every cheap row and
    // aggregate check above, and is never evaluated on receipt replay.
    let next_sheet_bytes = current_sheet_bytes()
        .checked_add(additional_bytes)
        .ok_or("sheet encrypted-byte counter overflow")?;
    if next_sheet_bytes > MAX_SHEET_ENCRYPTED_BYTES {
        return Err("sheet encrypted payload quota exceeded");
    }
    let entry_ids = ((current_counter + 1)..=last_id).collect();
    Ok(ValidatedEntryBatch {
        entry_ids,
        next_sheet_bytes,
        #[cfg(test)]
        replay: false,
    })
}

fn validate_entry_batch_import_id(import_id: &[u8]) -> Result<(), &'static str> {
    if import_id.len() != 32 {
        return Err("batch import id must be 32 bytes");
    }
    Ok(())
}

fn validate_new_entry_batch_shape(req: &AddEntryBatchReq) -> Result<(), &'static str> {
    if !(1..=MAX_ENTRIES_PER_BATCH).contains(&req.entries.len()) {
        return Err("entry batch must contain 1..=32 rows");
    }
    Ok(())
}

fn validate_entry_batch_receipt(receipt: &EntryBatchReceipt) -> Result<(), &'static str> {
    if !(1..=MAX_ENTRIES_PER_BATCH).contains(&receipt.entry_ids.len()) {
        return Err("invalid stored batch receipt");
    }
    let mut ids = receipt.entry_ids.clone();
    if ids.iter().any(|id| *id == 0) {
        return Err("invalid stored batch receipt");
    }
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("invalid stored batch receipt");
    }
    Ok(())
}

fn validate_entry_batch_sheet_access(
    sheet: Option<Sheet>,
    caller: Principal,
) -> Result<Sheet, &'static str> {
    let sheet = sheet.ok_or("caller does not have access to this sheet")?;
    if !principal_can_read_sheet(&sheet, caller) {
        return Err("caller does not have access to this sheet");
    }
    if !matches!(sheet.state, SheetState::Active) {
        return Err("sheet is not active");
    }
    Ok(sheet)
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
fn principal_owns_sheet(principal: Principal, sheet_id: &str) -> bool {
    if principal == Principal::anonymous() {
        return false;
    }
    SHEETS.with(|s| {
        s.borrow()
            .get(&sheet_id.to_string())
            .map(|sh| principal_can_read_sheet(&sh, principal))
            .unwrap_or(false)
    })
}

fn caller_owns_sheet(sheet_id: &str) -> bool {
    principal_owns_sheet(ic_cdk::api::msg_caller(), sheet_id)
}

fn sheet_is_active(sheet_id: &str) -> bool {
    SHEETS.with(|s| {
        s.borrow()
            .get(&sheet_id.to_string())
            .map(|sh| matches!(sh.state, SheetState::Active))
            .unwrap_or(false)
    })
}

fn sheet_is_chat_routable(sheet: &Sheet, principal: Principal) -> bool {
    matches!(sheet.state, SheetState::Active) && principal_can_read_sheet(sheet, principal)
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
    if let Err(msg) = validate_entry_blob(&req.entry_key, &req.ciphertext, &req.iv) {
        ic_cdk::trap(msg);
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
    let additional = entry_blob_bytes(&req.entry_key, &req.ciphertext, &req.iv);
    add_sheet_entry_bytes(&req.sheet_id, additional);
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

/// Store a complete 1..=32-row import in one update and make retry after an
/// outcome-unknown response exactly-once for the sheet/message identity.
/// Ordinary local single-entry writes continue to use `add_entry` unchanged;
/// chat/relay singles use this receipt endpoint as well.
#[ic_cdk::update]
fn add_entry_batch(req: AddEntryBatchReq) -> AddEntryBatchResult {
    let caller = ic_cdk::api::msg_caller();
    require_authed();
    let sheet = SHEETS.with(|s| s.borrow().get(&req.sheet_id));
    // Authenticate against the current sheet membership/state before the
    // first receipt lookup. A removed member cannot probe old import ids.
    let sheet = validate_entry_batch_sheet_access(sheet, caller)
        .unwrap_or_else(|message| ic_cdk::trap(message));
    // Reject an oversized attacker-controlled identity before using it to
    // allocate a stable-map lookup key. Row validation deliberately follows a
    // receipt lookup so response-loss retries remain authoritative.
    validate_entry_batch_import_id(&req.import_id).unwrap_or_else(|message| ic_cdk::trap(message));
    let receipt_key = entry_batch_receipt_key(&req.sheet_id, &req.import_id);
    let existing = ENTRY_BATCH_RECEIPTS.with(|receipts| receipts.borrow().get(&receipt_key));
    if let Some(receipt) = existing.as_ref() {
        validate_entry_batch_receipt(receipt).unwrap_or_else(|message| ic_cdk::trap(message));
        return AddEntryBatchResult {
            entry_ids: receipt.entry_ids.clone(),
            replayed: true,
        };
    }

    let current_counter =
        ENTRY_COUNTERS.with(|counters| counters.borrow().get(&req.sheet_id).unwrap_or(0));
    let validated = validate_add_entry_batch(&req, current_counter, None, || {
        sheet_entry_bytes(&req.sheet_id)
    })
    .unwrap_or_else(|message| ic_cdk::trap(message));

    let now = ic_cdk::api::time();
    let entries: Vec<Entry> = req
        .entries
        .into_iter()
        .zip(validated.entry_ids().iter().copied())
        .map(|(row, id)| Entry {
            id,
            pair_id: sheet.pair_id.clone(),
            sheet_id: sheet.id.clone(),
            created_by: caller,
            created_at_server: now,
            updated_at_server: None,
            entry_key: row.entry_key,
            ciphertext: row.ciphertext,
            iv: row.iv,
            history: None,
            deleted_at: None,
        })
        .collect();

    // No await/inter-canister call occurs from preflight through the final
    // receipt write. IC message execution rolls all stable-memory mutations
    // back together if an unexpected trap occurs anywhere in this block.
    for entry in &entries {
        sheet_entries_insert(&req.sheet_id, entry.id, entry.clone());
    }
    let last_id = *validated
        .entry_ids()
        .last()
        .unwrap_or_else(|| ic_cdk::trap("validated batch has no entry ids"));
    ENTRY_COUNTERS.with(|counters| {
        counters.borrow_mut().insert(req.sheet_id.clone(), last_id);
    });
    SHEET_ENTRY_BYTES.with(|bytes| {
        bytes
            .borrow_mut()
            .insert(req.sheet_id.clone(), validated.next_sheet_bytes());
    });
    ENTRY_BATCH_RECEIPTS.with(|receipts| {
        receipts.borrow_mut().insert(
            receipt_key,
            EntryBatchReceipt {
                entry_ids: validated.entry_ids().to_vec(),
                created_at: now,
            },
        );
    });
    record_entry_timestamp(&req.sheet_id, now);

    AddEntryBatchResult {
        entry_ids: validated.entry_ids().to_vec(),
        replayed: false,
    }
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
    if let Err(msg) = validate_entry_blob(&req.entry_key, &req.ciphertext, &req.iv) {
        ic_cdk::trap(msg);
    }
    if !caller_owns_sheet(&req.sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    if !sheet_is_active(&req.sheet_id) {
        ic_cdk::trap("sheet is not active");
    }
    let Some(existing) = sheet_entries_get(&req.sheet_id, req.entry_id) else {
        ic_cdk::trap("entry not found");
    };
    if existing.created_by != caller {
        ic_cdk::trap("only the original creator can edit this entry");
    }
    if existing.deleted_at.is_some() {
        ic_cdk::trap("cannot edit a deleted entry");
    }
    if existing.history.as_ref().map_or(0, Vec::len) >= MAX_ENTRY_HISTORY_VERSIONS {
        ic_cdk::trap("entry edit-history quota reached");
    }
    // The previous current version remains stored as history, so an edit adds one complete new blob.
    add_sheet_entry_bytes(
        &req.sheet_id,
        entry_blob_bytes(&req.entry_key, &req.ciphertext, &req.iv),
    );
    let now = ic_cdk::api::time();
    let mut entry = sheet_entries_remove(&req.sheet_id, req.entry_id)
        .unwrap_or_else(|| ic_cdk::trap("entry disappeared during edit"));
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
fn list_entries(sheet_id: String, cursor: Option<u64>, limit: u32) -> ListEntriesResult {
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("caller does not have access to this sheet");
    }
    let limit = limit.min(200) as usize;
    if limit == 0 {
        return ListEntriesResult {
            entries: Vec::new(),
            next_cursor: None,
        };
    }
    let max_id = cursor
        .map(|value| value.saturating_sub(1))
        .unwrap_or(u64::MAX);
    let (start, end) = entry_key_bounds(&sheet_id, max_id);
    // Fetch one extra row so next_cursor is returned only when another page really exists.
    let mut page: Vec<Entry> = ENTRIES.with(|m| {
        m.borrow()
            .range(start..=end)
            .rev()
            .take(limit + 1)
            .map(|(_, value)| value)
            .collect()
    });
    let has_more = page.len() > limit;
    if has_more {
        page.truncate(limit);
    }
    let next_cursor = has_more.then(|| page.last().expect("non-empty bounded page").id);
    ListEntriesResult {
        entries: page,
        next_cursor,
    }
}

// ────────────────────── v1.1.1: real vetkd endpoints ──────────────────────
//
// The PWA creates an ephemeral BLS12-381 G1 transport key pair (the same scheme
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
// holder of the matching transport secret key can decrypt. The transport
// secret is discarded with the client session; a fresh transport key can
// retrieve the same deterministic vetKey. The PWA then HKDFs the resulting
// symmetric key to get K_sheet (32 bytes).
//
// Requires dfx 0.27+ on local (which exports the cost_call system
// API that ic-cdk 0.20 needs). On the IC mainnet, vetkd_test_key
// is enabled by default on system subnets.

use ic_cdk_management_canister::{
    VetKDCurve, VetKDDeriveKeyArgs, VetKDDeriveKeyResult, VetKDKeyId, VetKDPublicKeyArgs,
    VetKDPublicKeyResult,
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
    let res: VetKDPublicKeyResult = ic_cdk_management_canister::vetkd_public_key(&request)
        .await
        .expect("call to vetkd_public_key failed");
    let _ = VETKD_PUBKEY_CACHE.with(|c| c.borrow_mut().set(Some(res.public_key.clone())));
    res.public_key
}

/// vetkd_wrap_sheet_key: returns the IBE encrypted_key for the
/// (caller, sheet_id) pair. The PWA is the only entity that can
/// decrypt this (it holds the matching transport secret key). On
/// unwrap, the PWA HKDFs the resulting symmetric key to get
/// K_sheet. Only principals recorded on the sheet can call this, including after the sheet closes.
///
/// IBE input is b"iou-sheet:" + sheet_id; the context is
/// b"iou-vetkd-symmetric-v1". The IBE ciphertext is bound to
/// (this_canister, sheet_id) and cannot be replayed across sheets
/// or canisters.
#[ic_cdk::update]
async fn vetkd_wrap_sheet_key(sheet_id: String, transport_public_key: Vec<u8>) -> Vec<u8> {
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
    let mut input = Vec::with_capacity(10 + sheet_id.len());
    input.extend_from_slice(b"iou-sheet:");
    input.extend_from_slice(sheet_id.as_bytes());
    let request = VetKDDeriveKeyArgs {
        input,
        context: b"iou-vetkd-symmetric-v1".to_vec(),
        key_id: vetkd_key_id(),
        transport_public_key,
    };
    let res: VetKDDeriveKeyResult = ic_cdk_management_canister::vetkd_derive_key(&request)
        .await
        .expect("call to vetkd_derive_key failed");
    // Inter-canister awaits permit other updates to run. A leave/replacement
    // can revoke this principal while the management canister derives the
    // result, so repeat the consent check immediately before releasing it.
    if !caller_owns_sheet(&sheet_id) {
        ic_cdk::trap("sheet membership changed while deriving the key");
    }
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
    let res: VetKDDeriveKeyResult = ic_cdk_management_canister::vetkd_derive_key(&request)
        .await
        .expect("call to vetkd_derive_key failed");
    res.encrypted_key
}

// ───────────── v1.8.0: OpenChat per-user consumer keypair ─────────────
//
// The action-inbox consumer keypair (P-256; the public half is what the
// user registers with OpenChat as their per-user delivery key) becomes
// canister-backed so any of the user's devices can recover it. Production web
// holds plaintext only in session memory; native uses platform secure storage;
// localStorage is development-only and a one-time production migration source.
// The canister stores an OPAQUE blob: the
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

/// Authoritative caller-scoped consumer-key state. `mutation_epoch` is owned
/// by this canister and advances exactly once for every accepted set/delete.
/// `keypair = None` with a non-zero epoch is a durable deletion tombstone.
#[derive(Clone, CandidType, Deserialize)]
pub struct ConsumerKeypairState {
    pub mutation_epoch: u64,
    pub keypair: Option<ConsumerKeypair>,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct ConsumerKeyEpochConflict {
    pub expected_epoch: u64,
    pub current_epoch: u64,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub enum ConsumerKeyMutationError {
    StaleEpoch(ConsumerKeyEpochConflict),
    EpochExhausted,
    OpenChatBindingKeyMismatch,
}

#[derive(Clone, CandidType, Deserialize)]
pub enum ConsumerKeyMutationResult {
    Ok(u64),
    Err(ConsumerKeyMutationError),
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

fn next_consumer_key_epoch(
    current_epoch: u64,
    expected_epoch: u64,
) -> Result<u64, ConsumerKeyMutationError> {
    if expected_epoch != current_epoch {
        return Err(ConsumerKeyMutationError::StaleEpoch(
            ConsumerKeyEpochConflict {
                expected_epoch,
                current_epoch,
            },
        ));
    }
    current_epoch
        .checked_add(1)
        .ok_or(ConsumerKeyMutationError::EpochExhausted)
}

fn consumer_key_epoch(caller: &Principal) -> u64 {
    CONSUMER_KEY_EPOCHS.with(|epochs| epochs.borrow().get(caller).unwrap_or(0))
}

fn consumer_key_update_preserves_binding(
    binding_exists: bool,
    binding_public_key: Option<&str>,
    current_public_key: Option<&str>,
    proposed_public_key: &str,
) -> bool {
    !binding_exists
        || (openchat_binding_key_matches(binding_public_key, current_public_key)
            && current_public_key == Some(proposed_public_key))
}

fn openchat_binding_key_matches(
    binding_public_key: Option<&str>,
    current_public_key: Option<&str>,
) -> bool {
    binding_public_key.is_some() && binding_public_key == current_public_key
}

fn consumer_key_snapshot_matches(
    expected_epoch: u64,
    expected_public_key: &str,
    current_epoch: u64,
    current_public_key: Option<&str>,
) -> bool {
    current_epoch == expected_epoch && current_public_key == Some(expected_public_key)
}

fn consumer_key_state_still_matches(
    caller: &Principal,
    expected_epoch: u64,
    expected_public_key: &str,
) -> bool {
    let current = CONSUMER_KEYPAIRS.with(|keypairs| keypairs.borrow().get(caller));
    consumer_key_snapshot_matches(
        expected_epoch,
        expected_public_key,
        consumer_key_epoch(caller),
        current
            .as_ref()
            .map(|keypair| keypair.public_key_pem.as_str()),
    )
}

/// set_consumer_keypair: caller-keyed compare-and-swap upsert. The caller MUST
/// supply the epoch returned by get_consumer_keypair. A delayed request
/// prepared before a newer set/delete is rejected without changing stable
/// state. The key blob remains opaque and client-side encrypted.
#[ic_cdk::update]
fn set_consumer_keypair(
    expected_epoch: u64,
    wrapped_private_key: Vec<u8>,
    public_key_pem: String,
) -> ConsumerKeyMutationResult {
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
    let current_epoch = consumer_key_epoch(&caller);
    let next_epoch = match next_consumer_key_epoch(current_epoch, expected_epoch) {
        Ok(epoch) => epoch,
        Err(error) => return ConsumerKeyMutationResult::Err(error),
    };
    let binding = OPENCHAT_BINDINGS_BY_IOU.with(|bindings| bindings.borrow().get(&caller));
    let binding_exists = binding.is_some();
    let current_keypair = CONSUMER_KEYPAIRS.with(|keypairs| keypairs.borrow().get(&caller));
    if !consumer_key_update_preserves_binding(
        binding_exists,
        binding
            .as_ref()
            .and_then(|value| value.consumer_public_key_pem.as_deref()),
        current_keypair
            .as_ref()
            .map(|keypair| keypair.public_key_pem.as_str()),
        &public_key_pem,
    ) {
        return ConsumerKeyMutationResult::Err(
            ConsumerKeyMutationError::OpenChatBindingKeyMismatch,
        );
    }

    // There is deliberately no await between compare and mutation. The IC
    // executes this as one atomic update message.
    CONSUMER_KEYPAIRS.with(|keypairs| {
        keypairs.borrow_mut().insert(
            caller,
            ConsumerKeypair {
                wrapped_private_key,
                public_key_pem,
            },
        );
    });
    CONSUMER_KEY_EPOCHS.with(|epochs| {
        epochs.borrow_mut().insert(caller, next_epoch);
    });
    ConsumerKeyMutationResult::Ok(next_epoch)
}

/// Return the caller's authoritative key + mutation epoch. Legacy keypairs
/// lazily start at epoch 0; no unbounded upgrade migration is needed.
#[ic_cdk::query]
fn get_consumer_keypair() -> ConsumerKeypairState {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return ConsumerKeypairState {
            mutation_epoch: 0,
            keypair: None,
        };
    }
    ConsumerKeypairState {
        mutation_epoch: consumer_key_epoch(&caller),
        keypair: CONSUMER_KEYPAIRS.with(|keypairs| keypairs.borrow().get(&caller)),
    }
}

/// Compare-and-swap delete. The incremented epoch is retained after removing
/// the keypair as a stable tombstone, preventing a set prepared before this
/// delete from landing later from another browser/device/process.
#[ic_cdk::update]
fn delete_consumer_keypair(expected_epoch: u64) -> ConsumerKeyMutationResult {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let current_epoch = consumer_key_epoch(&caller);
    let next_epoch = match next_consumer_key_epoch(current_epoch, expected_epoch) {
        Ok(epoch) => epoch,
        Err(error) => return ConsumerKeyMutationResult::Err(error),
    };
    CONSUMER_KEYPAIRS.with(|keypairs| {
        keypairs.borrow_mut().remove(&caller);
    });
    CONSUMER_KEY_EPOCHS.with(|epochs| {
        epochs.borrow_mut().insert(caller, next_epoch);
    });
    // Emergency local erase remains available even if OpenChat is unreachable.
    // Removing the IOU binding immediately closes private-card access, but this
    // raw endpoint cannot revoke the now-useless public key held by OpenChat.
    // The normal UI calls disconnect_openchat first and reaches this delete only
    // after OpenChat returned Success/KeyNotFound.
    if binding_removal_is_allowed(OpenChatBindingRemovalCause::EmergencyLocalErase) {
        remove_openchat_binding_for_iou(caller);
    }
    ConsumerKeyMutationResult::Ok(next_epoch)
}

// ───────────── OpenChat app-scoped chat handle → sheet mapping ─────────────
//
// OpenChat's v4 confirmed-action envelope carries a secret-derived 32-byte app-scoped chat handle.
// The PWA lets the user remember "always import this chat's drafts into this sheet"; the mapping
// follows the user across devices (localStorage is only a cache). The released field name chat_key
// remains for stable/Candid compatibility, but writes and reads require canonical unpadded base64url
// handles and never accept raw OpenChat chat coordinates. sheet_id is the 16-hex-char sheet id
// encoded as a u64. Caller-keyed like CONSUMER_KEYPAIRS: a principal only sees/edits its own links.

#[derive(Clone, CandidType, Deserialize)]
pub struct ChatSheetLink {
    pub chat_key: String,
    pub sheet_id: u64,
    /// OpenChat-provided display label. Optional keeps legacy stable rows decodable.
    pub chat_name: Option<String>,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct PendingChatRoute {
    // Canonical app-scoped handle. It is stable-state-only and never returned by
    // pending_chat_routes; the caller receives only pending_id.
    pub chat_key: String,
    pub last_seen: u64,
    // Present only for routes created by a successful one-time OpenChat token redemption.
    // This optional field keeps old stable rows decodable while ensuring legacy card-attestation
    // rows can never become assignable after an upgrade.
    pub claim_version: Option<u16>,
    /// OpenChat-provided display label, revealed only to this IOU principal.
    pub chat_name: Option<String>,
}

impl Storable for PendingChatRoute {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct PendingChatRouteView {
    /// Domain-separated digest scoped to this IOU principal; never an OpenChat coordinate/handle.
    pub pending_id: String,
    pub last_seen: u64,
    /// True even when the saved destination was closed or caller access was revoked.
    pub has_current_link: bool,
    /// Current destination, if this recently requested chat is already linked.
    /// Returned only when that destination is still an active, caller-readable route target.
    pub current_sheet_id: Option<u64>,
    /// The chat label captured by OpenChat when this exact setup request was minted.
    pub chat_name: Option<String>,
}

/// Authoritative cross-origin identity binding established only when the IOU
/// canister itself redeems an OpenChat link code. Browser localStorage and a
/// delivery public-key fingerprint are intentionally not authority here.
#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct OpenChatBinding {
    pub iou_principal: Principal,
    pub user_index_canister_id: Principal,
    pub app_id: u32,
    // Optional only for stable decoding of pre-V2 links. Authorization requires all three V2
    // values, so legacy links fail closed and must be recreated by the user.
    pub app_revision: Option<u64>,
    pub app_canister_id: Option<Principal>,
    pub key_version: Option<u64>,
    pub app_subject: Option<Vec<u8>>,
    pub subject_version: Option<u16>,
    pub consumer_queue_selector: Option<Vec<u8>>,
    pub consumer_queue_selector_version: Option<u16>,
    // Optional only for stable decoding of links created before the consumer-key
    // lifecycle invariant. Card authorization requires this exact link-time PEM
    // to still be the caller's authoritative delivery key.
    pub consumer_public_key_pem: Option<String>,
    // Stable-layout compatibility only. New links always store anonymous and no public endpoint
    // returns this field.
    pub openchat_user_id: Principal,
    pub linked_at: u64,
}

impl Storable for OpenChatBinding {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(Encode!(self).unwrap())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Decode!(bytes.as_ref(), Self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct OpenChatBindingView {
    pub iou_principal: Principal,
    pub user_index_canister_id: Principal,
    pub app_id: u32,
    pub app_revision: u64,
    pub app_canister_id: Principal,
    pub key_version: u64,
    pub app_subject: Vec<u8>,
    pub subject_version: u16,
    /// Opaque, caller-private ActionInbox queue selector issued by OpenChat's HMAC authority.
    pub consumer_queue_selector: Vec<u8>,
    pub consumer_queue_selector_version: u16,
    pub linked_at: u64,
}

fn public_openchat_binding(binding: &OpenChatBinding) -> Option<OpenChatBindingView> {
    Some(OpenChatBindingView {
        iou_principal: binding.iou_principal,
        user_index_canister_id: binding.user_index_canister_id,
        app_id: binding.app_id,
        app_revision: binding.app_revision?,
        app_canister_id: binding.app_canister_id?,
        key_version: binding.key_version?,
        app_subject: valid_app_subject(binding)?.to_vec(),
        subject_version: binding.subject_version?,
        consumer_queue_selector: valid_consumer_queue_selector(binding)?.to_vec(),
        consumer_queue_selector_version: binding.consumer_queue_selector_version?,
        linked_at: binding.linked_at,
    })
}

fn openchat_subject_key(
    user_index_canister_id: Principal,
    app_id: u32,
    app_subject: &[u8],
) -> String {
    format!(
        "{}\0{app_id:010}\0{}",
        user_index_canister_id.to_text(),
        lowercase_hex(app_subject)
    )
}

fn legacy_openchat_subject_key(
    user_index_canister_id: Principal,
    app_id: u32,
    openchat_user_id: Principal,
) -> String {
    format!(
        "{}\0{app_id:010}\0{}",
        user_index_canister_id.to_text(),
        openchat_user_id.to_text()
    )
}

fn valid_app_subject(binding: &OpenChatBinding) -> Option<&[u8]> {
    (binding.subject_version == Some(1))
        .then_some(binding.app_subject.as_deref())
        .flatten()
        .filter(|subject| subject.len() == 32)
}

fn valid_consumer_queue_selector(binding: &OpenChatBinding) -> Option<&[u8]> {
    (binding.consumer_queue_selector_version == Some(1))
        .then_some(binding.consumer_queue_selector.as_deref())
        .flatten()
        .filter(|selector| selector.len() == 32)
}

fn openchat_binding_key_matches_current(
    iou_principal: &Principal,
    binding: &OpenChatBinding,
) -> bool {
    if binding.iou_principal != *iou_principal {
        return false;
    }
    let current = CONSUMER_KEYPAIRS.with(|keypairs| keypairs.borrow().get(iou_principal));
    openchat_binding_key_matches(
        binding.consumer_public_key_pem.as_deref(),
        current
            .as_ref()
            .map(|keypair| keypair.public_key_pem.as_str()),
    )
}

fn openchat_binding_matches_verification(
    binding: &OpenChatBinding,
    configured: &AiAppVerificationBinding,
) -> bool {
    binding.user_index_canister_id == configured.user_index_canister_id
        && binding.app_id == configured.app_id
        && binding.app_revision == Some(configured.app_revision)
        && binding.app_canister_id == Some(configured.app_canister_id)
}

fn openchat_binding_matches_current_trust(
    iou_principal: &Principal,
    binding: &OpenChatBinding,
) -> bool {
    if !openchat_binding_key_matches_current(iou_principal, binding)
        || public_openchat_binding(binding).is_none()
    {
        return false;
    }
    let config = CONFIG.with(|config| config.borrow().get().clone());
    let Some(configured) = config.ai_app_verification_binding.as_ref() else {
        return false;
    };
    verification_binding_is_valid(
        configured,
        config.ai_app_owner,
        config.openchat_user_index_canister_id,
        ic_cdk::api::canister_self(),
    ) && openchat_binding_matches_verification(binding, configured)
}

fn remove_openchat_binding_for_iou(iou_principal: Principal) {
    clear_pending_chat_routes_for_principal(iou_principal);
    if let Some(binding) = OPENCHAT_BINDINGS_BY_IOU.with(|m| m.borrow_mut().remove(&iou_principal))
    {
        OPENCHAT_BINDINGS_BY_OC.with(|m| {
            let mut map = m.borrow_mut();
            if let Some(subject) = valid_app_subject(&binding) {
                let reverse =
                    openchat_subject_key(binding.user_index_canister_id, binding.app_id, subject);
                if map.get(&reverse) == Some(iou_principal) {
                    map.remove(&reverse);
                }
            }
            if binding.openchat_user_id != Principal::anonymous() {
                let legacy = legacy_openchat_subject_key(
                    binding.user_index_canister_id,
                    binding.app_id,
                    binding.openchat_user_id,
                );
                if map.get(&legacy) == Some(iou_principal) {
                    map.remove(&legacy);
                }
            }
        });
    }
}

fn replace_openchat_binding(binding: OpenChatBinding) {
    remove_openchat_binding_for_iou(binding.iou_principal);
    let Some(subject) = valid_app_subject(&binding) else {
        return;
    };
    let reverse = openchat_subject_key(binding.user_index_canister_id, binding.app_id, subject);
    if let Some(previous_iou) = OPENCHAT_BINDINGS_BY_OC.with(|m| m.borrow().get(&reverse)) {
        if previous_iou != binding.iou_principal {
            clear_pending_chat_routes_for_principal(previous_iou);
            OPENCHAT_BINDINGS_BY_IOU.with(|m| {
                let mut map = m.borrow_mut();
                if map.get(&previous_iou).as_ref().is_some_and(|old| {
                    old.user_index_canister_id == binding.user_index_canister_id
                        && old.app_id == binding.app_id
                        && valid_app_subject(old) == valid_app_subject(&binding)
                }) {
                    map.remove(&previous_iou);
                }
            });
        }
    }
    OPENCHAT_BINDINGS_BY_OC.with(|m| {
        m.borrow_mut().insert(reverse, binding.iou_principal);
    });
    OPENCHAT_BINDINGS_BY_IOU.with(|m| {
        m.borrow_mut().insert(binding.iou_principal, binding);
    });
}

/// Return only the signed-in caller's authoritative OpenChat link. The browser
/// needs these exact app-scoped coordinates to sign the revocation proof; it must never
/// infer them from localStorage or from public-key lookup results.
#[ic_cdk::query]
fn get_openchat_binding() -> Option<OpenChatBindingView> {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    OPENCHAT_BINDINGS_BY_IOU
        .with(|bindings| bindings.borrow().get(&caller))
        .as_ref()
        .and_then(public_openchat_binding)
}

fn disconnect_binding_is_valid(
    binding: &OpenChatBinding,
    caller: Principal,
    pinned_user_index: Option<Principal>,
    app_canister_id: Principal,
) -> bool {
    caller != Principal::anonymous()
        && binding.iou_principal == caller
        && binding.user_index_canister_id != Principal::anonymous()
        && pinned_user_index == Some(binding.user_index_canister_id)
        && binding.app_revision.is_some_and(|revision| revision > 0)
        && binding.app_canister_id == Some(app_canister_id)
        && binding.key_version.is_some_and(|version| version > 0)
        && valid_app_subject(binding).is_some()
}

fn openchat_binding_for_subject(
    user_index_canister_id: Principal,
    app_id: u32,
    app_subject: &[u8],
) -> Option<OpenChatBinding> {
    if app_subject.len() != 32 {
        return None;
    }
    let reverse = openchat_subject_key(user_index_canister_id, app_id, app_subject);
    let iou_principal = OPENCHAT_BINDINGS_BY_OC.with(|m| m.borrow().get(&reverse))?;
    OPENCHAT_BINDINGS_BY_IOU
        .with(|m| m.borrow().get(&iou_principal))
        .filter(|binding| {
            binding.user_index_canister_id == user_index_canister_id
                && binding.app_id == app_id
                && valid_app_subject(binding) == Some(app_subject)
                && openchat_binding_key_matches_current(&iou_principal, binding)
        })
}

fn recipient_binding_is_current(
    state: &RecipientBindingState,
    configured: &AiAppVerificationBinding,
    app_canister_id: Principal,
) -> Option<AuthorizedAiActionRecipient> {
    let binding = &state.binding;
    if binding.iou_principal == Principal::anonymous()
        || configured.app_canister_id != app_canister_id
        || !openchat_binding_matches_verification(binding, configured)
        || !openchat_binding_key_matches(
            binding.consumer_public_key_pem.as_deref(),
            state.current_consumer_public_key.as_deref(),
        )
    {
        return None;
    }
    let app_subject = valid_app_subject(binding)?.to_vec();
    let consumer_queue_selector = valid_consumer_queue_selector(binding)?.to_vec();
    let consumer_public_key = binding.consumer_public_key_pem.clone()?;
    let app_user_key_version = binding.key_version.filter(|version| *version > 0)?;
    if consumer_public_key.is_empty()
        || consumer_public_key.len() > 2_000
        || !consumer_public_key.contains("BEGIN PUBLIC KEY")
    {
        return None;
    }
    Some(AuthorizedAiActionRecipient {
        app_subject,
        subject_version: binding.subject_version?,
        consumer_queue_selector,
        consumer_queue_selector_version: binding.consumer_queue_selector_version?,
        consumer_public_key,
        app_user_key_version,
    })
}

fn scope_hash_bytes(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn scope_hash_text(hasher: &mut Sha256, value: &str) {
    scope_hash_bytes(hasher, value.as_bytes());
}

fn scope_hash_principal(hasher: &mut Sha256, value: Principal) {
    scope_hash_bytes(hasher, value.as_slice());
}

fn ai_action_recipient_scope_commitment(
    args: &AuthorizeAiActionRecipientsArgs,
    configured: &AiAppVerificationBinding,
    app_canister_id: Principal,
    sheet: &Sheet,
    pair: &Pair,
    recipients: &[(Principal, AuthorizedAiActionRecipient)],
    expires_at: u64,
) -> Vec<u8> {
    let mut digest = Sha256::new();
    digest.update(b"iou.ai-action-recipient-scope.v1\0");
    scope_hash_principal(&mut digest, configured.user_index_canister_id);
    scope_hash_principal(&mut digest, app_canister_id);
    digest.update(args.context.context_version.to_be_bytes());
    scope_hash_bytes(&mut digest, &args.context.app_subject);
    scope_hash_bytes(&mut digest, &args.context.chat_handle);
    scope_hash_bytes(&mut digest, &args.context.message_handle);
    digest.update(args.context.app_id.to_be_bytes());
    digest.update(args.context.app_revision.to_be_bytes());
    scope_hash_text(&mut digest, &args.context.action_id);
    scope_hash_bytes(&mut digest, &args.content_hash);
    scope_hash_bytes(&mut digest, &args.confirm_payload_hash);
    digest.update(args.confirmation_lease_generation.to_be_bytes());
    digest.update(args.created_at.to_be_bytes());
    digest.update(args.authorization_created_at.to_be_bytes());
    digest.update(expires_at.to_be_bytes());

    // These exact account coordinates never leave IOU. Hashing both the routed sheet and its
    // parent pair makes the opaque commitment change across account reassignment or membership
    // churn without making Pair.members a recipient authority.
    scope_hash_text(&mut digest, &sheet.id);
    scope_hash_text(&mut digest, &sheet.pair_id);
    digest.update([match sheet.state {
        SheetState::Active => 1,
        SheetState::Closed => 2,
    }]);
    scope_hash_principal(&mut digest, sheet.member_a);
    scope_hash_principal(&mut digest, sheet.member_b);
    scope_hash_text(&mut digest, &pair.id);
    scope_hash_principal(&mut digest, pair.members[0]);
    scope_hash_principal(&mut digest, pair.members[1]);
    match pair.archived_at {
        Some(value) => {
            digest.update([1]);
            digest.update(value.to_be_bytes());
        }
        None => digest.update([0]),
    }

    digest.update((recipients.len() as u64).to_be_bytes());
    for (principal, recipient) in recipients {
        scope_hash_principal(&mut digest, *principal);
        scope_hash_bytes(&mut digest, &recipient.app_subject);
        digest.update(recipient.subject_version.to_be_bytes());
        scope_hash_bytes(&mut digest, &recipient.consumer_queue_selector);
        digest.update(recipient.consumer_queue_selector_version.to_be_bytes());
        scope_hash_text(&mut digest, &recipient.consumer_public_key);
        digest.update(recipient.app_user_key_version.to_be_bytes());
    }
    digest.finalize().to_vec()
}

fn authorize_ai_action_recipients_for_state(
    args: &AuthorizeAiActionRecipientsArgs,
    config: &Config,
    app_canister_id: Principal,
    caller: Principal,
    now_ms: u64,
    confirmer_binding: &OpenChatBinding,
    sheet: &Sheet,
    pair: &Pair,
    candidates: &[RecipientBindingState],
) -> AuthorizeAiActionRecipientsResponse {
    let Some(configured) = config.ai_app_verification_binding.as_ref() else {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    };
    if caller != configured.user_index_canister_id
        || !verification_binding_is_valid(
            configured,
            config.ai_app_owner,
            config.openchat_user_index_canister_id,
            app_canister_id,
        )
        || configured.inbox_canister_id.is_none()
    {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    }
    if !valid_app_scoped_card_context(&args.context)
        || args.context.app_id != configured.app_id
        || args.context.app_revision != configured.app_revision
        || args.context.action_id != IOU_CARD_ACTION_ID
        || args.content_hash.len() != 32
        || !args.content_hash.iter().any(|byte| *byte != 0)
        || args.confirm_payload_hash.len() != 32
        || !args.confirm_payload_hash.iter().any(|byte| *byte != 0)
        || args.confirmation_lease_generation == 0
        || args.created_at == 0
        || args.authorization_created_at == 0
    {
        return AuthorizeAiActionRecipientsResponse::InvalidRequest(
            "invalid action recipient authorization coordinates".into(),
        );
    }
    let expires_at = args
        .authorization_created_at
        .saturating_add(AI_ACTION_RECIPIENT_GRANT_TTL_MS);
    // `created_at` and `authorization_created_at` are produced by OpenChat canisters which may
    // live on different subnets from IOU. Their millisecond clocks are not a safe ordering
    // authority. The pinned UserIndex validates its freshly-issued authorization window on its
    // own clock; IOU only rejects a grant once that trusted timestamp plus the bounded TTL is
    // unambiguously in the past on IOU's clock.
    if now_ms > expires_at {
        return AuthorizeAiActionRecipientsResponse::Stale;
    }
    if !matches!(sheet.state, SheetState::Active)
        || sheet.pair_id != pair.id
        || pair.archived_at.is_some()
        || confirmer_binding.iou_principal == Principal::anonymous()
        || !principal_can_read_sheet(sheet, confirmer_binding.iou_principal)
        || valid_app_subject(confirmer_binding) != Some(args.context.app_subject.as_slice())
    {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    }

    let mut exact_members = Vec::with_capacity(2);
    for member in [sheet.member_a, sheet.member_b] {
        if member != Principal::anonymous() && !exact_members.contains(&member) {
            exact_members.push(member);
        }
    }
    let expected_recipient_count = exact_members.len();
    let mut recipients: Vec<(Principal, AuthorizedAiActionRecipient)> = Vec::new();
    for member in exact_members {
        let Some(state) = candidates
            .iter()
            .find(|candidate| candidate.binding.iou_principal == member)
        else {
            continue;
        };
        let Some(recipient) = recipient_binding_is_current(state, configured, app_canister_id)
        else {
            continue;
        };
        recipients.push((member, recipient));
    }
    if recipients.len() != expected_recipient_count {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    }
    let confirmer_is_current = recipients.iter().any(|(principal, recipient)| {
        *principal == confirmer_binding.iou_principal
            && recipient.app_subject == args.context.app_subject
            && candidates
                .iter()
                .any(|state| state.binding == *confirmer_binding)
    });
    if !confirmer_is_current {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    }
    recipients.sort_by(|left, right| {
        left.1
            .app_subject
            .cmp(&right.1.app_subject)
            .then_with(|| {
                left.1
                    .consumer_queue_selector
                    .cmp(&right.1.consumer_queue_selector)
            })
            .then_with(|| {
                left.1
                    .app_user_key_version
                    .cmp(&right.1.app_user_key_version)
            })
    });
    let scope_commitment = ai_action_recipient_scope_commitment(
        args,
        configured,
        app_canister_id,
        sheet,
        pair,
        &recipients,
        expires_at,
    );
    AuthorizeAiActionRecipientsResponse::Success(AuthorizeAiActionRecipientsSuccess {
        recipients: recipients
            .into_iter()
            .map(|(_, recipient)| recipient)
            .collect(),
        scope_commitment,
        expires_at,
    })
}

/// Resolve the confirmer's exact private chat route, authorize only current members of that exact
/// active sheet, and return independently encrypted delivery coordinates. UserIndex is the only
/// accepted caller. Before success, legacy confirmer-only chat routing is atomically repaired for
/// every exact sheet member so the partner's envelope cannot appear as an unmapped global draft.
#[ic_cdk::update]
fn c2c_authorize_ai_action_recipients(
    args: AuthorizeAiActionRecipientsArgs,
) -> AuthorizeAiActionRecipientsResponse {
    let app_canister_id = ic_cdk::api::canister_self();
    let caller = ic_cdk::api::msg_caller();
    let now_ms = ic_cdk::api::time() / 1_000_000;
    let config = CONFIG.with(|config| config.borrow().get().clone());
    if config.openchat_user_index_canister_id != Some(caller) {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    }
    let Some(confirmer_binding) =
        openchat_binding_for_subject(caller, args.context.app_id, &args.context.app_subject)
    else {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    };
    let Some(chat_key) = scoped_chat_handle_key(&args.context.chat_handle) else {
        return AuthorizeAiActionRecipientsResponse::InvalidRequest(
            "invalid app-scoped chat handle".into(),
        );
    };
    let Some(sheet_id) = linked_sheet_for(confirmer_binding.iou_principal, &chat_key) else {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    };
    let Some(sheet) = SHEETS.with(|sheets| sheets.borrow().get(&sheet_id)) else {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    };
    let Some(pair) = PAIRS.with(|pairs| pairs.borrow().get(&sheet.pair_id)) else {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    };
    let candidates: Vec<RecipientBindingState> = [sheet.member_a, sheet.member_b]
        .into_iter()
        .filter(|member| *member != Principal::anonymous())
        .filter_map(|member| {
            let binding =
                OPENCHAT_BINDINGS_BY_IOU.with(|bindings| bindings.borrow().get(&member))?;
            let current_consumer_public_key = CONSUMER_KEYPAIRS.with(|keypairs| {
                keypairs
                    .borrow()
                    .get(&member)
                    .map(|keypair| keypair.public_key_pem)
            });
            Some(RecipientBindingState {
                binding,
                current_consumer_public_key,
            })
        })
        .collect();
    let response = authorize_ai_action_recipients_for_state(
        &args,
        &config,
        app_canister_id,
        caller,
        now_ms,
        &confirmer_binding,
        &sheet,
        &pair,
        &candidates,
    );
    if matches!(response, AuthorizeAiActionRecipientsResponse::Success(_))
        && repair_shared_chat_sheet_link(confirmer_binding.iou_principal, &chat_key, &sheet)
            .is_err()
    {
        return AuthorizeAiActionRecipientsResponse::NotAuthorized;
    }
    response
}

#[derive(CandidType, Deserialize)]
struct ClaimAiAppLinkCodeArgs {
    code: String,
    public_key: String,
}

#[derive(CandidType, Deserialize)]
struct ClaimAiAppLinkCodeSuccess {
    app_subject: Vec<u8>,
    subject_version: u16,
    app_id: u32,
    app_revision: u64,
    app_canister_id: Principal,
    consumer_queue_selector: Vec<u8>,
    consumer_queue_selector_version: u16,
    key_version: u64,
}

#[derive(CandidType, Deserialize)]
enum ClaimAiAppLinkCodeResponse {
    Success(ClaimAiAppLinkCodeSuccess),
    CodeNotFound,
    CodeExpired,
    NotAuthorized,
    InvalidRequest(String),
    Error((u16, Option<String>)),
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub enum ConnectOpenChatResult {
    Success(OpenChatBindingView),
    NotConfigured,
    CodeNotFound,
    CodeExpired,
    InvalidRequest(String),
    WrongApp,
    RemoteError(String),
}

/// Claim the OpenChat link code through this canister, rather than trusting a
/// browser to report which OpenChat user it linked. The pinned UserIndex
/// authoritatively returns the code's user/app, and the returned app canister
/// must be this canister before the IOU-principal mapping is persisted.
#[ic_cdk::update]
async fn connect_openchat(code: String, public_key: String) -> ConnectOpenChatResult {
    require_authed();
    let iou_principal = ic_cdk::api::msg_caller();
    if code.len() != 64
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return ConnectOpenChatResult::CodeNotFound;
    }
    if public_key.is_empty() || public_key.len() > 2_000 {
        return ConnectOpenChatResult::InvalidRequest("public key length out of range".to_string());
    }
    let Some(user_index_canister_id) =
        CONFIG.with(|c| c.borrow().get().openchat_user_index_canister_id)
    else {
        return ConnectOpenChatResult::NotConfigured;
    };

    let consumer_key_epoch = consumer_key_epoch(&iou_principal);
    // The claim must use the authoritative stored public key. Capture the
    // epoch before the await so the continuation can reject a concurrent
    // set/delete rather than binding OpenChat to an obsolete key.
    if !consumer_key_state_still_matches(&iou_principal, consumer_key_epoch, &public_key) {
        return ConnectOpenChatResult::InvalidRequest(
            "public key does not match the current IOU delivery key".to_string(),
        );
    }

    let args = ClaimAiAppLinkCodeArgs {
        code,
        public_key: public_key.clone(),
    };
    let response = match ic_cdk::call::Call::bounded_wait(
        user_index_canister_id,
        "c2c_claim_ai_app_link_code",
    )
    .with_arg(&args)
    .await
    {
        Ok(response) => response,
        Err(error) => return ConnectOpenChatResult::RemoteError(error.to_string()),
    };
    let outcome: ClaimAiAppLinkCodeResponse = match response.candid() {
        Ok(value) => value,
        Err(error) => return ConnectOpenChatResult::RemoteError(error.to_string()),
    };
    let success = match outcome {
        ClaimAiAppLinkCodeResponse::Success(value) => value,
        ClaimAiAppLinkCodeResponse::CodeNotFound => return ConnectOpenChatResult::CodeNotFound,
        ClaimAiAppLinkCodeResponse::CodeExpired => return ConnectOpenChatResult::CodeExpired,
        ClaimAiAppLinkCodeResponse::NotAuthorized => return ConnectOpenChatResult::WrongApp,
        ClaimAiAppLinkCodeResponse::InvalidRequest(message) => {
            return ConnectOpenChatResult::InvalidRequest(message)
        }
        ClaimAiAppLinkCodeResponse::Error((code, message)) => {
            return ConnectOpenChatResult::RemoteError(format!(
                "OpenChat error {code}{}",
                message.map(|m| format!(": {m}")).unwrap_or_default()
            ))
        }
    };

    // Recheck the mutable trust pin after the await and bind only codes for
    // the exact app registration that names this canister.
    if CONFIG.with(|c| c.borrow().get().openchat_user_index_canister_id)
        != Some(user_index_canister_id)
    {
        return ConnectOpenChatResult::NotConfigured;
    }
    if success.app_canister_id != ic_cdk::api::canister_self() {
        return ConnectOpenChatResult::WrongApp;
    }
    if !consumer_key_state_still_matches(&iou_principal, consumer_key_epoch, &public_key) {
        return ConnectOpenChatResult::InvalidRequest(
            "IOU delivery key changed while connecting; create a new OpenChat link code and retry"
                .to_string(),
        );
    }
    let binding = OpenChatBinding {
        iou_principal,
        user_index_canister_id,
        app_id: success.app_id,
        app_revision: Some(success.app_revision),
        app_canister_id: Some(success.app_canister_id),
        key_version: Some(success.key_version),
        app_subject: Some(success.app_subject),
        subject_version: Some(success.subject_version),
        consumer_queue_selector: Some(success.consumer_queue_selector),
        consumer_queue_selector_version: Some(success.consumer_queue_selector_version),
        consumer_public_key_pem: Some(public_key),
        openchat_user_id: Principal::anonymous(),
        linked_at: ic_cdk::api::time(),
    };
    let Some(public_binding) = public_openchat_binding(&binding) else {
        return ConnectOpenChatResult::InvalidRequest(
            "invalid app-scoped subject or queue selector returned by OpenChat".to_string(),
        );
    };
    replace_openchat_binding(binding.clone());
    ConnectOpenChatResult::Success(public_binding)
}

#[derive(CandidType, Deserialize)]
struct RedeemAiAppChatLinkTokenArgs {
    token: Vec<u8>,
    expected_app_subject: Vec<u8>,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
struct RedeemAiAppChatLinkTokenSuccess {
    app_subject: Vec<u8>,
    subject_version: u16,
    app_user_key_version: u64,
    app_id: u32,
    app_revision: u64,
    app_canister_id: Principal,
    chat_handle: Vec<u8>,
    chat_handle_version: u16,
    chat_name: Option<String>,
}

#[derive(CandidType, Deserialize)]
enum RedeemAiAppChatLinkTokenResponse {
    Success(RedeemAiAppChatLinkTokenSuccess),
    TokenNotFound,
    TokenExpired,
    NotAuthorized,
    SubjectMismatch,
    AppUnavailable,
    InvalidRequest(String),
    Error((u16, Option<String>)),
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct ClaimOpenChatChatRouteSuccess {
    /// Caller-scoped SHA-256 digest. The chat handle and launch token never
    /// cross this public IOU boundary.
    pub pending_id: String,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub enum ClaimOpenChatChatRouteResult {
    Success(ClaimOpenChatChatRouteSuccess),
    InvalidToken,
    NotConfigured,
    NotLinked,
    TokenUnavailable,
    WrongAccount,
    InvalidBinding,
    BindingChanged,
    RemoteError,
}

fn redeemed_chat_link_handle(
    grant: &RedeemAiAppChatLinkTokenSuccess,
    binding: &OpenChatBinding,
    app_canister_id: Principal,
) -> Option<String> {
    (grant.app_subject.as_slice() == valid_app_subject(binding)?
        && Some(grant.subject_version) == binding.subject_version
        && Some(grant.app_user_key_version) == binding.key_version
        && grant.app_id == binding.app_id
        && Some(grant.app_revision) == binding.app_revision
        && grant.app_canister_id == app_canister_id
        && grant.chat_handle_version == 1)
        .then(|| scoped_chat_handle_key(&grant.chat_handle))
        .flatten()
}

const MAX_OPENCHAT_CHAT_NAME_CHARS: usize = 80;

fn validated_openchat_chat_name(value: Option<&str>) -> Option<String> {
    let value = value?;
    (value == value.trim()
        && !value.is_empty()
        && value.chars().count() <= MAX_OPENCHAT_CHAT_NAME_CHARS
        && !value.chars().any(char::is_control))
    .then(|| value.to_string())
}

fn chat_route_binding_still_current(caller: Principal, binding: &OpenChatBinding) -> bool {
    OPENCHAT_BINDINGS_BY_IOU
        .with(|bindings| bindings.borrow().get(&caller).as_ref() == Some(binding))
        && openchat_binding_matches_current_trust(&caller, binding)
}

/// Redeem the one-time token placed by OpenChat in the per-chat Settings URL.
///
/// The browser contributes no identity or chat coordinate: its signed-in IOU
/// principal selects an exact current OpenChat binding, and this canister sends
/// that binding's app subject to the pinned UserIndex. A different IOU account
/// therefore receives SubjectMismatch without consuming the token. Only a
/// fully validated success becomes a caller-private pending route.
#[ic_cdk::update]
async fn claim_openchat_chat_route(encoded_token: String) -> ClaimOpenChatChatRouteResult {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    let Some(token) = decode_base64url_32(&encoded_token) else {
        return ClaimOpenChatChatRouteResult::InvalidToken;
    };
    let Some(user_index_canister_id) =
        CONFIG.with(|config| config.borrow().get().openchat_user_index_canister_id)
    else {
        return ClaimOpenChatChatRouteResult::NotConfigured;
    };
    let Some(binding) = OPENCHAT_BINDINGS_BY_IOU.with(|bindings| bindings.borrow().get(&caller))
    else {
        return ClaimOpenChatChatRouteResult::NotLinked;
    };
    if binding.user_index_canister_id != user_index_canister_id
        || !chat_route_binding_still_current(caller, &binding)
    {
        return ClaimOpenChatChatRouteResult::InvalidBinding;
    }
    let Some(expected_app_subject) = valid_app_subject(&binding).map(<[u8]>::to_vec) else {
        return ClaimOpenChatChatRouteResult::InvalidBinding;
    };

    // UserIndex stores an exact-token redemption receipt before replying, so an ambiguous bounded
    // timeout is safe to retry with the same token. Keep this bounded so a stalled UserIndex cannot
    // obstruct a clean IOU stop or upgrade indefinitely.
    let response = match ic_cdk::call::Call::bounded_wait(
        user_index_canister_id,
        "c2c_redeem_ai_app_chat_link_token",
    )
    .change_timeout(30)
    .with_arg(&RedeemAiAppChatLinkTokenArgs {
        token: token.to_vec(),
        expected_app_subject,
    })
    .await
    {
        Ok(response) => response,
        Err(_) => return ClaimOpenChatChatRouteResult::RemoteError,
    };
    let outcome: RedeemAiAppChatLinkTokenResponse = match response.candid() {
        Ok(value) => value,
        Err(_) => return ClaimOpenChatChatRouteResult::RemoteError,
    };
    let grant = match outcome {
        RedeemAiAppChatLinkTokenResponse::Success(value) => value,
        RedeemAiAppChatLinkTokenResponse::TokenNotFound
        | RedeemAiAppChatLinkTokenResponse::TokenExpired => {
            return ClaimOpenChatChatRouteResult::TokenUnavailable
        }
        RedeemAiAppChatLinkTokenResponse::SubjectMismatch => {
            return ClaimOpenChatChatRouteResult::WrongAccount
        }
        RedeemAiAppChatLinkTokenResponse::NotAuthorized
        | RedeemAiAppChatLinkTokenResponse::AppUnavailable => {
            return ClaimOpenChatChatRouteResult::InvalidBinding
        }
        RedeemAiAppChatLinkTokenResponse::InvalidRequest(_) => {
            return ClaimOpenChatChatRouteResult::InvalidToken
        }
        RedeemAiAppChatLinkTokenResponse::Error(_) => {
            return ClaimOpenChatChatRouteResult::RemoteError
        }
    };

    // The cross-canister call introduced an await. Never let its response bind
    // a route after the caller's key, subject, revision, app, or trust pin was
    // replaced in the meantime.
    if CONFIG.with(|config| config.borrow().get().openchat_user_index_canister_id)
        != Some(user_index_canister_id)
        || !chat_route_binding_still_current(caller, &binding)
    {
        return ClaimOpenChatChatRouteResult::BindingChanged;
    }
    let Some(chat_key) = redeemed_chat_link_handle(&grant, &binding, ic_cdk::api::canister_self())
    else {
        return ClaimOpenChatChatRouteResult::InvalidBinding;
    };
    let Some(chat_name) = validated_openchat_chat_name(grant.chat_name.as_deref()) else {
        return ClaimOpenChatChatRouteResult::InvalidBinding;
    };
    remember_claimed_chat_route(caller, &chat_key, &chat_name, ic_cdk::api::time());
    ClaimOpenChatChatRouteResult::Success(ClaimOpenChatChatRouteSuccess {
        pending_id: pending_chat_route_id(&caller, &chat_key),
    })
}

#[derive(CandidType, Deserialize)]
struct RevokeAiAppUserKeyArgs {
    app_subject: Vec<u8>,
    app_id: u32,
    key_version: u64,
    public_key: String,
    signature: Vec<u8>,
    timestamp: u64,
}

#[derive(CandidType, Deserialize, Debug, PartialEq, Eq)]
enum RevokeAiAppUserKeyResponse {
    Success,
    KeyNotFound,
    Error((u16, Option<String>)),
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub enum DisconnectOpenChatResult {
    Success,
    KeyNotFound,
    NotConfigured,
    NotLinked,
    InvalidBinding,
    InvalidRequest(String),
    BindingChanged,
    RemoteError(String),
}

enum OpenChatBindingRemovalCause<'a> {
    CoordinatedRevoke(&'a RevokeAiAppUserKeyResponse),
    /// Explicit/raw local erasure is the availability escape hatch. It closes
    /// IOU-side access immediately but can leave an unusable public key in OC.
    EmergencyLocalErase,
}

fn binding_removal_is_allowed(cause: OpenChatBindingRemovalCause<'_>) -> bool {
    match cause {
        OpenChatBindingRemovalCause::CoordinatedRevoke(response) => matches!(
            response,
            RevokeAiAppUserKeyResponse::Success | RevokeAiAppUserKeyResponse::KeyNotFound
        ),
        OpenChatBindingRemovalCause::EmergencyLocalErase => true,
    }
}

fn disconnect_state_still_matches(
    caller: Principal,
    binding: &OpenChatBinding,
    expected_consumer_key_epoch: u64,
    public_key: &str,
) -> bool {
    let pinned_user_index =
        CONFIG.with(|config| config.borrow().get().openchat_user_index_canister_id);
    disconnect_binding_is_valid(
        binding,
        caller,
        pinned_user_index,
        ic_cdk::api::canister_self(),
    ) && OPENCHAT_BINDINGS_BY_IOU
        .with(|bindings| bindings.borrow().get(&caller).as_ref() == Some(binding))
        && consumer_key_state_still_matches(&caller, expected_consumer_key_epoch, public_key)
}

/// Coordinated IOU-side disconnect. The browser supplies a proof signed by
/// the still-present delivery private key, but only this registered app
/// canister calls OpenChat's V2 revocation endpoint. The authoritative
/// caller-scoped binding supplies the OpenChat user/app/key-version tuple.
///
/// The binding is removed only after OpenChat reports Success or KeyNotFound,
/// and every mutable trust coordinate is rechecked after the await. The UI may
/// delete the wrapped private key only after receiving either clean outcome.
#[ic_cdk::update]
async fn disconnect_openchat(
    public_key: String,
    signature: Vec<u8>,
    timestamp: u64,
) -> DisconnectOpenChatResult {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    if public_key.is_empty()
        || public_key.len() > 2_000
        || !public_key.contains("BEGIN PUBLIC KEY")
        || signature.len() != 64
    {
        return DisconnectOpenChatResult::InvalidRequest(
            "invalid public key or signature shape".to_string(),
        );
    }

    let Some(binding) = OPENCHAT_BINDINGS_BY_IOU.with(|bindings| bindings.borrow().get(&caller))
    else {
        return DisconnectOpenChatResult::NotLinked;
    };
    let pinned_user_index =
        CONFIG.with(|config| config.borrow().get().openchat_user_index_canister_id);
    if pinned_user_index.is_none() {
        return DisconnectOpenChatResult::NotConfigured;
    }
    if !disconnect_binding_is_valid(
        &binding,
        caller,
        pinned_user_index,
        ic_cdk::api::canister_self(),
    ) {
        return DisconnectOpenChatResult::InvalidBinding;
    }
    let Some(key_version) = binding.key_version else {
        return DisconnectOpenChatResult::InvalidBinding;
    };
    let consumer_key_epoch = consumer_key_epoch(&caller);
    let key_matches = CONSUMER_KEYPAIRS.with(|keypairs| {
        keypairs
            .borrow()
            .get(&caller)
            .is_some_and(|keypair| keypair.public_key_pem == public_key)
    });
    if !key_matches {
        return DisconnectOpenChatResult::InvalidRequest(
            "public key does not match the current IOU delivery key".to_string(),
        );
    }

    let args = RevokeAiAppUserKeyArgs {
        app_subject: binding.app_subject.clone().unwrap_or_default(),
        app_id: binding.app_id,
        key_version,
        public_key: public_key.clone(),
        signature,
        timestamp,
    };
    let response = match ic_cdk::call::Call::bounded_wait(
        binding.user_index_canister_id,
        "revoke_ai_app_user_key",
    )
    .with_arg(&args)
    .await
    {
        Ok(response) => response,
        Err(error) => return DisconnectOpenChatResult::RemoteError(error.to_string()),
    };
    let outcome: RevokeAiAppUserKeyResponse = match response.candid() {
        Ok(value) => value,
        Err(error) => return DisconnectOpenChatResult::RemoteError(error.to_string()),
    };
    if !binding_removal_is_allowed(OpenChatBindingRemovalCause::CoordinatedRevoke(&outcome)) {
        let RevokeAiAppUserKeyResponse::Error((code, message)) = outcome else {
            unreachable!();
        };
        return DisconnectOpenChatResult::RemoteError(format!(
            "OpenChat error {code}{}",
            message
                .map(|value| format!(": {value}"))
                .unwrap_or_default()
        ));
    }

    // An inter-canister call commits OpenChat's state before this continuation.
    // Never let that response remove a newer IOU link or key that appeared while
    // awaiting it; the caller must retry against the current binding instead.
    if CONFIG.with(|config| config.borrow().get().openchat_user_index_canister_id)
        != Some(binding.user_index_canister_id)
    {
        return DisconnectOpenChatResult::NotConfigured;
    }
    if !disconnect_state_still_matches(caller, &binding, consumer_key_epoch, &public_key) {
        return DisconnectOpenChatResult::BindingChanged;
    }

    remove_openchat_binding_for_iou(caller);
    match outcome {
        RevokeAiAppUserKeyResponse::Success => DisconnectOpenChatResult::Success,
        RevokeAiAppUserKeyResponse::KeyNotFound => DisconnectOpenChatResult::KeyNotFound,
        RevokeAiAppUserKeyResponse::Error(_) => unreachable!(),
    }
}

#[derive(CandidType, Deserialize)]
struct RedeemAiAppCardCapabilityArgs {
    token: Vec<u8>,
    recipient_key_scheme: String,
    recipient_public_key: Vec<u8>,
}

#[derive(CandidType, Deserialize)]
struct RedeemedAiAppCardContext {
    context_version: u16,
    app_subject: Vec<u8>,
    chat_handle: Vec<u8>,
    message_handle: Vec<u8>,
    app_id: u32,
    app_revision: u64,
    action_id: String,
}

#[derive(CandidType, Deserialize)]
struct RedeemAiAppCardCapabilitySuccess {
    context: RedeemedAiAppCardContext,
    app_canister_id: Principal,
    recipient_key_scheme: String,
    recipient_public_key: Vec<u8>,
    scope: RedeemedAiAppCardCapabilityScope,
    expires_at: u64,
}

#[derive(CandidType, Deserialize, PartialEq, Eq)]
enum RedeemedAiAppCardCapabilityScope {
    #[serde(rename = "private_context")]
    PrivateContext,
}

#[derive(CandidType, Deserialize)]
#[allow(clippy::large_enum_variant)] // Keep the Candid response shape direct and language-neutral.
enum RedeemAiAppCardCapabilityResponse {
    Success(RedeemAiAppCardCapabilitySuccess),
    NotFound,
    Expired,
    NotAuthorized,
    AppUnavailable,
    InvalidRequest(String),
}

#[derive(CandidType, Deserialize)]
struct RedeemAiAppPrivateMatchCapabilityArgs {
    token: Vec<u8>,
    recipient_key_scheme: String,
    recipient_public_key: Vec<u8>,
}

#[derive(CandidType, Deserialize)]
struct RedeemAiAppPrivateMatchCapabilitySuccess {
    context: RedeemedAiAppCardContext,
    source_binding: Vec<u8>,
    app_canister_id: Principal,
    recipient_key_scheme: String,
    recipient_public_key: Vec<u8>,
    expires_at: u64,
}

#[derive(CandidType, Deserialize)]
#[allow(clippy::large_enum_variant)]
enum RedeemAiAppPrivateMatchCapabilityResponse {
    Success(RedeemAiAppPrivateMatchCapabilitySuccess),
    NotFound,
    Expired,
    NotAuthorized,
    AppUnavailable,
    InvalidRequest(String),
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct OpenChatCardContext {
    pub sheet_id: String,
    pub context_version: u16,
    pub app_subject: Vec<u8>,
    pub chat_handle: Vec<u8>,
    pub message_handle: Vec<u8>,
    pub app_id: u32,
    pub app_revision: u64,
    pub action_id: String,
    // The exact viewer's one caller-scoped account default. Optional only for rolling Candid
    // compatibility; current responses always return Some(effective code).
    pub default_currency: Option<String>,
    pub vetkd_public_key: Vec<u8>,
    pub encrypted_vet_key: Vec<u8>,
    pub templates_a_enc: Option<Vec<u8>>,
    pub templates_a_iv: Option<Vec<u8>>,
    pub templates_b_enc: Option<Vec<u8>>,
    pub templates_b_iv: Option<Vec<u8>>,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)] // Keep the public Candid result shape stable.
pub enum OpenChatCardContextResult {
    Success(OpenChatCardContext),
    NotConfigured,
    InvalidCapability,
    NotLinked,
    ChatNotLinked,
    NotAuthorized,
    KeyUnavailable,
}

/// Encrypted account-local Saved-type roster released to one fresh anonymous matcher frame.
/// The authoritative source commitment is public to that frame only; the canister never receives
/// the plaintext message and cannot decrypt or inspect the roster.
#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
pub struct OpenChatPrivateMatchContext {
    pub sheet_id: String,
    pub context_version: u16,
    pub app_subject: Vec<u8>,
    pub chat_handle: Vec<u8>,
    pub message_handle: Vec<u8>,
    pub app_id: u32,
    pub app_revision: u64,
    pub action_id: String,
    pub source_binding: Vec<u8>,
    pub vetkd_public_key: Vec<u8>,
    pub encrypted_vet_key: Vec<u8>,
    pub templates_a_enc: Option<Vec<u8>>,
    pub templates_a_iv: Option<Vec<u8>>,
    pub templates_b_enc: Option<Vec<u8>>,
    pub templates_b_iv: Option<Vec<u8>>,
}

#[derive(Clone, CandidType, Deserialize, Debug, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)]
pub enum OpenChatPrivateMatchContextResult {
    Success(OpenChatPrivateMatchContext),
    NotConfigured,
    InvalidCapability,
    NotLinked,
    ChatNotLinked,
    NotAuthorized,
    KeyUnavailable,
}

const IOU_DEFAULT_CURRENCY_FALLBACK: &str = "USD";

fn effective_default_currency(value: Option<&str>) -> String {
    let code = value
        .unwrap_or(IOU_DEFAULT_CURRENCY_FALLBACK)
        .trim()
        .to_ascii_uppercase();
    if code.len() == 3
        && code
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        code
    } else {
        IOU_DEFAULT_CURRENCY_FALLBACK.to_string()
    }
}

fn default_currency_for_principal(principal: Principal) -> String {
    let stored = USERS.with(|users| {
        users
            .borrow()
            .get(&principal)
            .and_then(|record| record.default_currency)
    });
    effective_default_currency(stored.as_deref())
}

fn linked_sheet_for(principal: Principal, chat_key: &str) -> Option<String> {
    if !is_canonical_app_scoped_chat_handle(chat_key) {
        return None;
    }
    CHAT_SHEET_LINKS
        .with(|m| m.borrow().get(&chat_link_key(&principal, chat_key)))
        .map(|link| format!("{:016x}", link.sheet_id))
}

fn card_access_still_valid(
    user_index_canister_id: Principal,
    context: &RedeemedAiAppCardContext,
    binding: &OpenChatBinding,
    sheet_id: &str,
) -> bool {
    CONFIG.with(|c| c.borrow().get().openchat_user_index_canister_id)
        == Some(user_index_canister_id)
        && openchat_binding_for_subject(
            user_index_canister_id,
            context.app_id,
            &context.app_subject,
        ) == Some(binding.clone())
        && binding.app_revision == Some(context.app_revision)
        && binding.app_canister_id == Some(ic_cdk::api::canister_self())
        && binding.key_version.is_some()
        && scoped_chat_handle_key(&context.chat_handle)
            .and_then(|key| linked_sheet_for(binding.iou_principal, &key))
            .as_deref()
            == Some(sheet_id)
        && principal_owns_sheet(binding.iou_principal, sheet_id)
        && sheet_is_active(sheet_id)
}

/// Redeem an OpenChat-minted, app/revision/chat/message/viewer-bound one-time
/// capability and release only ciphertext plus a vetKD key encrypted to this
/// iframe's fresh transport key. Type names/keywords are decrypted only in
/// the credentialless card's memory; neither canister receives plaintext.
#[ic_cdk::update]
async fn openchat_card_context(
    token: Vec<u8>,
    recipient_key_scheme: String,
    transport_public_key: Vec<u8>,
) -> OpenChatCardContextResult {
    const IOU_CARD_KEY_SCHEME: &str = "iou.vetkd.bls12-381.v1";
    if token.len() != 32
        || recipient_key_scheme != IOU_CARD_KEY_SCHEME
        || transport_public_key.len() != 48
    {
        return OpenChatCardContextResult::InvalidCapability;
    }
    let Some(user_index_canister_id) =
        CONFIG.with(|c| c.borrow().get().openchat_user_index_canister_id)
    else {
        return OpenChatCardContextResult::NotConfigured;
    };

    let args = RedeemAiAppCardCapabilityArgs {
        token,
        recipient_key_scheme: recipient_key_scheme.clone(),
        recipient_public_key: transport_public_key.clone(),
    };
    let response = match ic_cdk::call::Call::bounded_wait(
        user_index_canister_id,
        "c2c_redeem_ai_app_card_capability",
    )
    .with_arg(&args)
    .await
    {
        Ok(response) => response,
        Err(_) => return OpenChatCardContextResult::InvalidCapability,
    };
    let redeemed: RedeemAiAppCardCapabilityResponse = match response.candid() {
        Ok(value) => value,
        Err(_) => return OpenChatCardContextResult::InvalidCapability,
    };
    let grant = match redeemed {
        RedeemAiAppCardCapabilityResponse::Success(value) => value,
        RedeemAiAppCardCapabilityResponse::NotFound
        | RedeemAiAppCardCapabilityResponse::Expired
        | RedeemAiAppCardCapabilityResponse::NotAuthorized
        | RedeemAiAppCardCapabilityResponse::AppUnavailable
        | RedeemAiAppCardCapabilityResponse::InvalidRequest(_) => {
            return OpenChatCardContextResult::InvalidCapability
        }
    };

    let now_ms = ic_cdk::api::time() / 1_000_000;
    if grant.app_canister_id != ic_cdk::api::canister_self()
        || grant.recipient_key_scheme != recipient_key_scheme
        || grant.recipient_public_key != transport_public_key
        || grant.scope != RedeemedAiAppCardCapabilityScope::PrivateContext
        || grant.expires_at <= now_ms
    {
        return OpenChatCardContextResult::InvalidCapability;
    }
    if !valid_app_scoped_card_context(&AppScopedCardContextV1 {
        context_version: grant.context.context_version,
        app_subject: grant.context.app_subject.clone(),
        chat_handle: grant.context.chat_handle.clone(),
        message_handle: grant.context.message_handle.clone(),
        app_id: grant.context.app_id,
        app_revision: grant.context.app_revision,
        action_id: grant.context.action_id.clone(),
    }) {
        return OpenChatCardContextResult::InvalidCapability;
    }
    let Some(binding) = openchat_binding_for_subject(
        user_index_canister_id,
        grant.context.app_id,
        &grant.context.app_subject,
    ) else {
        return OpenChatCardContextResult::NotLinked;
    };
    let Some(chat_handle_key) = scoped_chat_handle_key(&grant.context.chat_handle) else {
        return OpenChatCardContextResult::InvalidCapability;
    };
    if binding.app_revision != Some(grant.context.app_revision)
        || binding.app_canister_id != Some(ic_cdk::api::canister_self())
        || binding.key_version.is_none()
    {
        return OpenChatCardContextResult::NotAuthorized;
    }
    let Some(sheet_id) = linked_sheet_for(binding.iou_principal, &chat_handle_key) else {
        return OpenChatCardContextResult::ChatNotLinked;
    };
    if !card_access_still_valid(user_index_canister_id, &grant.context, &binding, &sheet_id) {
        return OpenChatCardContextResult::NotAuthorized;
    }

    let Some(sheet) = SHEETS.with(|s| s.borrow().get(&sheet_id)) else {
        return OpenChatCardContextResult::NotAuthorized;
    };
    let Some(pair) = PAIRS.with(|p| p.borrow().get(&sheet.pair_id)) else {
        return OpenChatCardContextResult::NotAuthorized;
    };

    let vetkd_public_key = if let Some(cached) =
        VETKD_PUBKEY_CACHE.with(|c| c.borrow().get().clone())
    {
        cached
    } else {
        let request = VetKDPublicKeyArgs {
            canister_id: None,
            context: b"iou-vetkd-symmetric-v1".to_vec(),
            key_id: vetkd_key_id(),
        };
        let Ok(result) = ic_cdk_management_canister::vetkd_public_key(&request).await else {
            return OpenChatCardContextResult::KeyUnavailable;
        };
        let _ = VETKD_PUBKEY_CACHE.with(|c| c.borrow_mut().set(Some(result.public_key.clone())));
        result.public_key
    };
    if vetkd_public_key.len() != 96
        || !card_access_still_valid(user_index_canister_id, &grant.context, &binding, &sheet_id)
    {
        return OpenChatCardContextResult::NotAuthorized;
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
    let Ok(derived) = ic_cdk_management_canister::vetkd_derive_key(&request).await else {
        return OpenChatCardContextResult::KeyUnavailable;
    };
    if !card_access_still_valid(user_index_canister_id, &grant.context, &binding, &sheet_id) {
        return OpenChatCardContextResult::NotAuthorized;
    }

    OpenChatCardContextResult::Success(OpenChatCardContext {
        sheet_id,
        context_version: grant.context.context_version,
        app_subject: grant.context.app_subject,
        chat_handle: grant.context.chat_handle,
        message_handle: grant.context.message_handle,
        app_id: grant.context.app_id,
        app_revision: grant.context.app_revision,
        action_id: grant.context.action_id,
        default_currency: Some(default_currency_for_principal(binding.iou_principal)),
        vetkd_public_key,
        encrypted_vet_key: derived.encrypted_key,
        templates_a_enc: pair.templates_a_enc,
        templates_a_iv: pair.templates_a_iv,
        templates_b_enc: pair.templates_b_enc,
        templates_b_iv: pair.templates_b_iv,
    })
}

/// Redeem an exact-message private-match capability and release the linked sheet's encrypted
/// Saved-type roster only to the requesting iframe's fresh vetKD transport key. The browser frame
/// must reproduce `source_binding` from the exact text before it unwraps this material. This
/// canister sees neither the text nor the decrypted roster and therefore cannot act as a keyword
/// membership oracle.
#[ic_cdk::update]
async fn openchat_private_match_context(
    token: Vec<u8>,
    recipient_key_scheme: String,
    transport_public_key: Vec<u8>,
) -> OpenChatPrivateMatchContextResult {
    const IOU_PRIVATE_MATCH_KEY_SCHEME: &str = "iou.vetkd.bls12-381.v1";
    if token.len() != 32
        || recipient_key_scheme != IOU_PRIVATE_MATCH_KEY_SCHEME
        || transport_public_key.len() != 48
    {
        return OpenChatPrivateMatchContextResult::InvalidCapability;
    }
    let Some(user_index_canister_id) =
        CONFIG.with(|c| c.borrow().get().openchat_user_index_canister_id)
    else {
        return OpenChatPrivateMatchContextResult::NotConfigured;
    };

    let response = match ic_cdk::call::Call::bounded_wait(
        user_index_canister_id,
        "c2c_redeem_ai_app_private_match_capability",
    )
    .with_arg(&RedeemAiAppPrivateMatchCapabilityArgs {
        token,
        recipient_key_scheme: recipient_key_scheme.clone(),
        recipient_public_key: transport_public_key.clone(),
    })
    .await
    {
        Ok(response) => response,
        Err(_) => return OpenChatPrivateMatchContextResult::InvalidCapability,
    };
    let redeemed: RedeemAiAppPrivateMatchCapabilityResponse = match response.candid() {
        Ok(value) => value,
        Err(_) => return OpenChatPrivateMatchContextResult::InvalidCapability,
    };
    let grant = match redeemed {
        RedeemAiAppPrivateMatchCapabilityResponse::Success(value) => value,
        RedeemAiAppPrivateMatchCapabilityResponse::NotFound
        | RedeemAiAppPrivateMatchCapabilityResponse::Expired
        | RedeemAiAppPrivateMatchCapabilityResponse::NotAuthorized
        | RedeemAiAppPrivateMatchCapabilityResponse::AppUnavailable
        | RedeemAiAppPrivateMatchCapabilityResponse::InvalidRequest(_) => {
            return OpenChatPrivateMatchContextResult::InvalidCapability
        }
    };

    let now_ms = ic_cdk::api::time() / 1_000_000;
    if grant.app_canister_id != ic_cdk::api::canister_self()
        || grant.recipient_key_scheme != recipient_key_scheme
        || grant.recipient_public_key != transport_public_key
        || grant.source_binding.len() != 32
        || grant.expires_at <= now_ms
        || !valid_app_scoped_card_context(&AppScopedCardContextV1 {
            context_version: grant.context.context_version,
            app_subject: grant.context.app_subject.clone(),
            chat_handle: grant.context.chat_handle.clone(),
            message_handle: grant.context.message_handle.clone(),
            app_id: grant.context.app_id,
            app_revision: grant.context.app_revision,
            action_id: grant.context.action_id.clone(),
        })
    {
        return OpenChatPrivateMatchContextResult::InvalidCapability;
    }
    let Some(binding) = openchat_binding_for_subject(
        user_index_canister_id,
        grant.context.app_id,
        &grant.context.app_subject,
    ) else {
        return OpenChatPrivateMatchContextResult::NotLinked;
    };
    let Some(chat_handle_key) = scoped_chat_handle_key(&grant.context.chat_handle) else {
        return OpenChatPrivateMatchContextResult::InvalidCapability;
    };
    if binding.app_revision != Some(grant.context.app_revision)
        || binding.app_canister_id != Some(ic_cdk::api::canister_self())
        || binding.key_version.is_none()
    {
        return OpenChatPrivateMatchContextResult::NotAuthorized;
    }
    let Some(sheet_id) = linked_sheet_for(binding.iou_principal, &chat_handle_key) else {
        return OpenChatPrivateMatchContextResult::ChatNotLinked;
    };
    if !card_access_still_valid(user_index_canister_id, &grant.context, &binding, &sheet_id) {
        return OpenChatPrivateMatchContextResult::NotAuthorized;
    }

    let vetkd_public_key = if let Some(cached) =
        VETKD_PUBKEY_CACHE.with(|c| c.borrow().get().clone())
    {
        cached
    } else {
        let request = VetKDPublicKeyArgs {
            canister_id: None,
            context: b"iou-vetkd-symmetric-v1".to_vec(),
            key_id: vetkd_key_id(),
        };
        let Ok(result) = ic_cdk_management_canister::vetkd_public_key(&request).await else {
            return OpenChatPrivateMatchContextResult::KeyUnavailable;
        };
        let _ = VETKD_PUBKEY_CACHE.with(|c| c.borrow_mut().set(Some(result.public_key.clone())));
        result.public_key
    };
    if vetkd_public_key.len() != 96
        || !card_access_still_valid(user_index_canister_id, &grant.context, &binding, &sheet_id)
    {
        return OpenChatPrivateMatchContextResult::NotAuthorized;
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
    let Ok(derived) = ic_cdk_management_canister::vetkd_derive_key(&request).await else {
        return OpenChatPrivateMatchContextResult::KeyUnavailable;
    };
    if !card_access_still_valid(user_index_canister_id, &grant.context, &binding, &sheet_id) {
        return OpenChatPrivateMatchContextResult::NotAuthorized;
    }

    // Fetch the encrypted roster only after the final post-await authorization check. A template
    // edit may commit while vetKD awaits; returning an earlier clone would make a newly added or
    // removed keyword produce a stale decision.
    let Some(sheet) = SHEETS.with(|s| s.borrow().get(&sheet_id)) else {
        return OpenChatPrivateMatchContextResult::NotAuthorized;
    };
    let Some(pair) = PAIRS.with(|p| p.borrow().get(&sheet.pair_id)) else {
        return OpenChatPrivateMatchContextResult::NotAuthorized;
    };

    OpenChatPrivateMatchContextResult::Success(OpenChatPrivateMatchContext {
        sheet_id,
        context_version: grant.context.context_version,
        app_subject: grant.context.app_subject,
        chat_handle: grant.context.chat_handle,
        message_handle: grant.context.message_handle,
        app_id: grant.context.app_id,
        app_revision: grant.context.app_revision,
        action_id: grant.context.action_id,
        source_binding: grant.source_binding,
        vetkd_public_key,
        encrypted_vet_key: derived.encrypted_key,
        templates_a_enc: pair.templates_a_enc,
        templates_a_iv: pair.templates_a_iv,
        templates_b_enc: pair.templates_b_enc,
        templates_b_iv: pair.templates_b_iv,
    })
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

/// Composite key for CHAT_SHEET_LINKS: `caller text \0 chat_key`. The NUL separator is safe because
/// principal text never contains NUL and every new chat_key is canonical base64url. Same pattern as
/// entry_key().
fn chat_link_key(caller: &Principal, chat_key: &str) -> String {
    format!("{}\0{}", caller.to_text(), chat_key)
}

fn chat_link_bounds(caller: &Principal) -> (String, String) {
    // Principal text is ASCII. Every composite key starts with principal + NUL and therefore sorts
    // before principal + SOH, regardless of the opaque chat-key suffix.
    (
        format!("{}\0", caller.to_text()),
        format!("{}\u{1}", caller.to_text()),
    )
}

/// A canonical, unpadded base64url encoding of exactly 32 bytes is 43 characters long. The final
/// sextet can have only its high four bits set; restricting it to the 16 canonical alphabet values
/// rejects alternate spellings with non-zero pad bits without adding a decoder dependency.
fn is_canonical_app_scoped_chat_handle(chat_key: &str) -> bool {
    let bytes = chat_key.as_bytes();
    bytes.len() == 43
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
        && matches!(
            bytes[42],
            b'A' | b'E'
                | b'I'
                | b'M'
                | b'Q'
                | b'U'
                | b'Y'
                | b'c'
                | b'g'
                | b'k'
                | b'o'
                | b's'
                | b'w'
                | b'0'
                | b'4'
                | b'8'
        )
}

/// Removal keeps the released bounded-text validator so callers can explicitly delete a legacy raw
/// row during migration. New writes and all reads remain canonical-handle-only.
fn validate_legacy_chat_key_for_removal(chat_key: &str) {
    let n = chat_key.chars().count();
    if n == 0 || n > 200 {
        ic_cdk::trap("chat_key length out of range (1..=200 chars)");
    }
    if chat_key.contains('\0') {
        ic_cdk::trap("chat_key must not contain NUL");
    }
}

fn pending_chat_route_id(caller: &Principal, chat_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"iou.pending-chat-route.v1\0");
    digest.update(caller.as_slice());
    digest.update([0]);
    digest.update(chat_key.as_bytes());
    lowercase_hex(&digest.finalize())
}

fn pending_chat_route_key(caller: &Principal, pending_id: &str) -> String {
    format!("{}\0{}", caller.to_text(), pending_id)
}

fn pending_chat_route_bounds(caller: &Principal) -> (String, String) {
    (
        format!("{}\0", caller.to_text()),
        format!("{}\u{1}", caller.to_text()),
    )
}

fn validate_pending_chat_route_id(pending_id: &str) {
    if pending_id.len() != 64
        || !pending_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        ic_cdk::trap("pending_id must be a canonical lowercase SHA-256 digest");
    }
}

fn pending_chat_route_is_live(route: &PendingChatRoute, now: u64) -> bool {
    now.saturating_sub(route.last_seen) <= PENDING_CHAT_ROUTE_TTL_NS
}

fn clear_pending_chat_routes_for_principal(caller: Principal) {
    let (start, end) = pending_chat_route_bounds(&caller);
    PENDING_CHAT_ROUTES.with(|routes| {
        let mut map = routes.borrow_mut();
        let keys: Vec<String> = map.range(start..end).map(|(key, _)| key).collect();
        for key in keys {
            map.remove(&key);
        }
    });
}

fn clear_all_pending_chat_routes() {
    PENDING_CHAT_ROUTES.with(|routes| {
        let mut map = routes.borrow_mut();
        let keys: Vec<String> = map.iter().map(|(key, _)| key).collect();
        for key in keys {
            map.remove(&key);
        }
    });
}

/// Remember a setup candidate only after IOU has successfully redeemed OpenChat's one-time,
/// account-bound launch token. Card attestations and private-context requests deliberately do not
/// call this path: viewing/proposing in a chat is not consent to route a private IOU sheet there.
fn remember_claimed_chat_route(caller: Principal, chat_key: &str, chat_name: &str, now: u64) {
    if !is_canonical_app_scoped_chat_handle(chat_key)
        || validated_openchat_chat_name(Some(chat_name)).is_none()
    {
        return;
    }
    let pending_id = pending_chat_route_id(&caller, chat_key);
    let key = pending_chat_route_key(&caller, &pending_id);
    let (start, end) = pending_chat_route_bounds(&caller);
    PENDING_CHAT_ROUTES.with(|routes| {
        let mut map = routes.borrow_mut();
        let expired: Vec<String> = map
            .iter()
            .filter(|(_, route)| !pending_chat_route_is_live(route, now))
            .map(|(key, _)| key)
            .collect();
        for expired_key in expired {
            map.remove(&expired_key);
        }
        if !map.contains_key(&key) {
            let rows: Vec<(String, u64)> = map
                .range(start.clone()..end.clone())
                .map(|(row_key, route)| (row_key, route.last_seen))
                .collect();
            if rows.len() >= MAX_PENDING_CHAT_ROUTES_PER_PRINCIPAL {
                if let Some((oldest, _)) = rows.into_iter().min_by_key(|(_, seen)| *seen) {
                    map.remove(&oldest);
                }
            }
            if map.len() >= MAX_PENDING_CHAT_ROUTES_TOTAL as u64 {
                if let Some((oldest, _)) = map
                    .iter()
                    .map(|(row_key, route)| (row_key, route.last_seen))
                    .min_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)))
                {
                    map.remove(&oldest);
                }
            }
        }
        map.insert(
            key,
            PendingChatRoute {
                chat_key: chat_key.to_string(),
                last_seen: now,
                claim_version: Some(1),
                chat_name: Some(chat_name.to_string()),
            },
        );
    });
    // Token redemption authenticates this exact OpenChat label, but still does not create routing
    // consent. If a valid active shared route already exists, refresh the same label on both exact
    // account-member copies; with no saved route this remains a pending setup candidate only.
    let existing_sheet_id = CHAT_SHEET_LINKS.with(|links| {
        links
            .borrow()
            .get(&chat_link_key(&caller, chat_key))
            .map(|link| link.sheet_id)
    });
    if let Some(sheet_id) = existing_sheet_id {
        let _ = store_shared_chat_sheet_link(
            caller,
            chat_key.to_string(),
            sheet_id,
            Some(chat_name.to_string()),
        );
    }
}

/// Resolve exactly the caller-scoped pending id selected by the page. Each
/// OpenChat Settings launch has its own authenticated token and pending id, so
/// a later launch must not invalidate an earlier chat's still-live row.
fn actionable_pending_chat_route(
    caller: Principal,
    pending_id: &str,
    now: u64,
) -> Option<PendingChatRoute> {
    let pending = PENDING_CHAT_ROUTES.with(|routes| {
        routes
            .borrow()
            .get(&pending_chat_route_key(&caller, pending_id))
    });
    if let Some(route) = pending.filter(|route| {
        route.claim_version == Some(1)
            && pending_chat_route_is_live(route, now)
            && pending_chat_route_id(&caller, &route.chat_key) == pending_id
    }) {
        return Some(route);
    }

    // The one-time setup request is deliberately short-lived, but a link the caller explicitly
    // saved is durable. Reconstruct only that caller's opaque route so it remains visible,
    // reassignable and removable without retaining every expired setup request forever.
    let (start, end) = chat_link_bounds(&caller);
    CHAT_SHEET_LINKS.with(|links| {
        links
            .borrow()
            .range(start..end)
            .map(|(_, link)| link)
            .find(|link| {
                is_canonical_app_scoped_chat_handle(&link.chat_key)
                    && pending_chat_route_id(&caller, &link.chat_key) == pending_id
            })
            .map(|link| PendingChatRoute {
                chat_key: link.chat_key,
                last_seen: 0,
                claim_version: Some(1),
                chat_name: link.chat_name,
            })
    })
}

fn exact_sheet_members(sheet: &Sheet) -> Vec<Principal> {
    let mut members = Vec::with_capacity(2);
    for principal in [sheet.member_a, sheet.member_b] {
        if principal != Principal::anonymous() && !members.contains(&principal) {
            members.push(principal);
        }
    }
    members
}

/// Atomically reconcile one app-scoped chat route across the exact old/new sheet members. Quotas
/// and ownership are preflighted for every target before the first stable write. Old partner rows
/// are removed only while they still point to the caller's exact prior sheet, so a later conflicting
/// assignment cannot be erased by an older remove/reassign operation.
fn store_shared_chat_sheet_link(
    caller: Principal,
    chat_key: String,
    sheet_id: u64,
    chat_name: Option<String>,
) -> Result<(), &'static str> {
    if !is_canonical_app_scoped_chat_handle(&chat_key) {
        return Err("chat_key must be a canonical 32-byte app-scoped handle");
    }
    if chat_name
        .as_deref()
        .is_some_and(|name| validated_openchat_chat_name(Some(name)).is_none())
    {
        return Err("invalid OpenChat chat name");
    }
    let sheet_id_text = format!("{sheet_id:016x}");
    let Some(target_sheet) = SHEETS.with(|sheets| sheets.borrow().get(&sheet_id_text)) else {
        return Err("caller does not have access to the linked sheet");
    };
    if !principal_can_read_sheet(&target_sheet, caller) {
        return Err("caller does not have access to the linked sheet");
    }
    if !matches!(target_sheet.state, SheetState::Active) {
        return Err("only an active sheet can be linked to an OpenChat chat");
    }
    let target_members = exact_sheet_members(&target_sheet);
    if !target_members.contains(&caller) {
        return Err("caller does not have access to the linked sheet");
    }

    let caller_key = chat_link_key(&caller, &chat_key);
    let prior_link = CHAT_SHEET_LINKS.with(|links| links.borrow().get(&caller_key));
    let prior_sheet = prior_link.as_ref().and_then(|link| {
        SHEETS.with(|sheets| sheets.borrow().get(&format!("{:016x}", link.sheet_id)))
    });
    let prior_sheet_id = prior_link.as_ref().map(|link| link.sheet_id);
    let prior_sheet_is_exact = prior_sheet
        .as_ref()
        .is_some_and(|sheet| principal_can_read_sheet(sheet, caller));
    let prior_members = prior_sheet
        .as_ref()
        .filter(|sheet| principal_can_read_sheet(sheet, caller))
        .map(exact_sheet_members)
        .unwrap_or_else(|| vec![caller]);
    let prior_and_target_members_match = prior_members.len() == target_members.len()
        && prior_members
            .iter()
            .all(|member| target_members.contains(member));
    if prior_sheet_is_exact
        && prior_sheet_id.is_some_and(|prior_id| prior_id != sheet_id)
        && !prior_and_target_members_match
    {
        return Err("unlink the existing account route before changing its members");
    }
    let shared_chat_name = chat_name.or_else(|| {
        prior_link
            .as_ref()
            .filter(|link| link.sheet_id == sheet_id)
            .and_then(|link| link.chat_name.clone())
    });

    CHAT_SHEET_LINKS.with(|m| -> Result<(), &'static str> {
        let mut map = m.borrow_mut();
        let mut legacy_keys = BTreeSet::new();
        // Every target member must have capacity before any old row is removed. A same-handle row
        // for another account is a conflict unless it is one of the caller's exact prior shared
        // rows being reconciled by this same update. Reject before the first stable mutation so an
        // A-B assignment can never split an existing B-C route by overwriting only B.
        for member in &target_members {
            let key = chat_link_key(member, &chat_key);
            if let Some(existing) = map.get(&key).filter(|link| link.sheet_id != sheet_id) {
                let belongs_to_exact_prior_sheet = prior_sheet_is_exact
                    && prior_sheet_id == Some(existing.sheet_id)
                    && prior_members.contains(member);
                if !belongs_to_exact_prior_sheet {
                    return Err("target account member has a conflicting chat route");
                }
            }
            let (start, end) = chat_link_bounds(member);
            let rows: Vec<(String, bool)> = map
                .range(start..end)
                .map(|(row_key, value)| {
                    (
                        row_key,
                        is_canonical_app_scoped_chat_handle(&value.chat_key),
                    )
                })
                .collect();
            let canonical_count = rows.iter().filter(|(_, canonical)| *canonical).count();
            for (row_key, canonical) in rows {
                if !canonical {
                    legacy_keys.insert(row_key);
                }
            }
            if !map.contains_key(&key) && canonical_count >= MAX_CHAT_LINKS_PER_PRINCIPAL {
                return Err("chat-to-sheet link quota reached");
            }
        }

        for legacy_key in legacy_keys {
            map.remove(&legacy_key);
        }

        if let Some(expected_sheet_id) = prior_sheet_id {
            for member in &prior_members {
                let key = chat_link_key(member, &chat_key);
                if map
                    .get(&key)
                    .as_ref()
                    .is_some_and(|link| link.sheet_id == expected_sheet_id)
                {
                    map.remove(&key);
                }
            }
        }
        for member in &target_members {
            let key = chat_link_key(member, &chat_key);
            let member_chat_name = shared_chat_name
                .clone()
                .or_else(|| map.get(&key).and_then(|link| link.chat_name));
            map.insert(
                key,
                ChatSheetLink {
                    chat_key: chat_key.clone(),
                    sheet_id,
                    chat_name: member_chat_name,
                },
            );
        }
        Ok(())
    })
}

fn repair_shared_chat_sheet_link(
    confirmer: Principal,
    chat_key: &str,
    sheet: &Sheet,
) -> Result<(), &'static str> {
    let sheet_id = u64::from_str_radix(&sheet.id, 16).map_err(|_| "invalid routed sheet id")?;
    let existing =
        CHAT_SHEET_LINKS.with(|links| links.borrow().get(&chat_link_key(&confirmer, chat_key)));
    if existing.as_ref().map(|link| link.sheet_id) != Some(sheet_id)
        || !matches!(sheet.state, SheetState::Active)
        || !principal_can_read_sheet(sheet, confirmer)
    {
        return Err("confirmer route no longer points to the active sheet");
    }
    let has_partner_conflict = exact_sheet_members(sheet).into_iter().any(|member| {
        CHAT_SHEET_LINKS.with(|links| {
            links
                .borrow()
                .get(&chat_link_key(&member, chat_key))
                .is_some_and(|link| link.sheet_id != sheet_id)
        })
    });
    if has_partner_conflict {
        return Err("another exact sheet member has a newer conflicting chat route");
    }
    store_shared_chat_sheet_link(
        confirmer,
        chat_key.to_string(),
        sheet_id,
        existing.and_then(|link| link.chat_name),
    )
}

fn remove_shared_chat_sheet_link(caller: Principal, chat_key: &str) -> Result<(), &'static str> {
    let caller_key = chat_link_key(&caller, chat_key);
    let Some(existing) = CHAT_SHEET_LINKS.with(|links| links.borrow().get(&caller_key)) else {
        return Ok(());
    };
    let sheet = SHEETS.with(|sheets| sheets.borrow().get(&format!("{:016x}", existing.sheet_id)));
    let members = sheet
        .as_ref()
        .filter(|sheet| principal_can_read_sheet(sheet, caller))
        .map(exact_sheet_members)
        .unwrap_or_else(|| vec![caller]);
    CHAT_SHEET_LINKS.with(|links| {
        let mut map = links.borrow_mut();
        for member in members {
            let key = chat_link_key(&member, chat_key);
            if map
                .get(&key)
                .as_ref()
                .is_some_and(|link| link.sheet_id == existing.sheet_id)
            {
                map.remove(&key);
            }
        }
    });
    Ok(())
}

fn store_chat_sheet_link(
    caller: Principal,
    chat_key: String,
    sheet_id: u64,
    chat_name: Option<String>,
) {
    if let Err(message) = store_shared_chat_sheet_link(caller, chat_key, sheet_id, chat_name) {
        ic_cdk::trap(message);
    }
}

/// set_chat_sheet_link: caller-keyed upsert of an app-scoped chat handle → sheet mapping. The stable
/// argument remains named chat_key for compatibility; raw OpenChat coordinates are rejected.
#[ic_cdk::update]
fn set_chat_sheet_link(chat_key: String, sheet_id: u64) {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    store_chat_sheet_link(caller, chat_key, sheet_id, None);
}

/// Return only active sheets the caller is explicitly recorded on. Pair membership alone is not
/// sufficient: a partner can join after a solo sheet was created and must not be offered that
/// unreadable sheet as a routing destination.
#[ic_cdk::query]
fn chat_routable_sheet_ids() -> Vec<u64> {
    require_authed();
    let caller = ic_cdk::api::msg_caller();
    SHEETS.with(|sheets| {
        let mut scanned = 0usize;
        let mut out = Vec::new();
        for (_, sheet) in sheets.borrow().iter() {
            require_legacy_scan_capacity(&mut scanned, "sheet");
            if sheet_is_chat_routable(&sheet, caller) {
                let Ok(sheet_id) = u64::from_str_radix(&sheet.id, 16) else {
                    continue;
                };
                if out.len() >= MAX_PAIRS_PER_PRINCIPAL {
                    ic_cdk::trap("account quota exceeded in legacy state; migration required");
                }
                out.push(sheet_id);
            }
        }
        out.sort_unstable();
        out
    })
}

fn pending_chat_route_view(
    caller: Principal,
    pending_id: String,
    route: &PendingChatRoute,
) -> PendingChatRouteView {
    let linked_sheet = linked_sheet_for(caller, &route.chat_key);
    let current_sheet_id = linked_sheet.as_deref().and_then(|sheet_id| {
        let routable = SHEETS.with(|sheets| {
            sheets
                .borrow()
                .get(&sheet_id.to_string())
                .as_ref()
                .is_some_and(|sheet| sheet_is_chat_routable(sheet, caller))
        });
        routable
            .then(|| u64::from_str_radix(sheet_id, 16).ok())
            .flatten()
    });
    PendingChatRouteView {
        pending_id,
        last_seen: route.last_seen,
        has_current_link: linked_sheet.is_some(),
        current_sheet_id,
        chat_name: route.chat_name.clone(),
    }
}

fn pending_chat_route_views(caller: Principal, now: u64) -> Vec<PendingChatRouteView> {
    let (start, end) = pending_chat_route_bounds(&caller);
    let mut rows: Vec<PendingChatRouteView> = PENDING_CHAT_ROUTES.with(|routes| {
        routes
            .borrow()
            .range(start..end)
            .filter(|(_, route)| {
                route.claim_version == Some(1) && pending_chat_route_is_live(route, now)
            })
            .take(MAX_PENDING_CHAT_ROUTES_PER_PRINCIPAL)
            .filter_map(|(key, route)| {
                key.rsplit_once('\0').map(|(_, pending_id)| {
                    pending_chat_route_view(caller, pending_id.to_string(), &route)
                })
            })
            .collect()
    });
    let mut seen: BTreeSet<String> = rows.iter().map(|row| row.pending_id.clone()).collect();
    if rows.len() < MAX_PENDING_CHAT_ROUTES_PER_PRINCIPAL {
        let (start, end) = chat_link_bounds(&caller);
        CHAT_SHEET_LINKS.with(|links| {
            for (_, link) in links.borrow().range(start..end) {
                if rows.len() >= MAX_PENDING_CHAT_ROUTES_PER_PRINCIPAL {
                    break;
                }
                if !is_canonical_app_scoped_chat_handle(&link.chat_key) {
                    continue;
                }
                let pending_id = pending_chat_route_id(&caller, &link.chat_key);
                if !seen.insert(pending_id.clone()) {
                    continue;
                }
                rows.push(pending_chat_route_view(
                    caller,
                    pending_id,
                    &PendingChatRoute {
                        chat_key: link.chat_key,
                        last_seen: 0,
                        claim_version: Some(1),
                        chat_name: link.chat_name,
                    },
                ));
            }
        });
    }
    rows.sort_by(|left, right| {
        right
            .last_seen
            .cmp(&left.last_seen)
            .then_with(|| left.pending_id.cmp(&right.pending_id))
    });
    rows
}

#[ic_cdk::query]
fn pending_chat_routes() -> Vec<PendingChatRouteView> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Vec::new();
    }
    pending_chat_route_views(caller, ic_cdk::api::time())
}

#[ic_cdk::update]
fn assign_pending_chat_route(pending_id: String, sheet_id: u64) {
    require_authed();
    validate_pending_chat_route_id(&pending_id);
    let caller = ic_cdk::api::msg_caller();
    let Some(route) = actionable_pending_chat_route(caller, &pending_id, ic_cdk::api::time())
    else {
        ic_cdk::trap("pending chat request is missing, expired, or belongs to another caller");
    };
    let binding_is_current = OPENCHAT_BINDINGS_BY_IOU.with(|bindings| {
        bindings
            .borrow()
            .get(&caller)
            .as_ref()
            .is_some_and(|binding| openchat_binding_matches_current_trust(&caller, binding))
    });
    if !binding_is_current {
        ic_cdk::trap("OpenChat connection changed; connect again before routing this chat");
    }
    store_chat_sheet_link(caller, route.chat_key, sheet_id, route.chat_name);
}

#[ic_cdk::update]
fn remove_pending_chat_route_link(pending_id: String) {
    require_authed();
    validate_pending_chat_route_id(&pending_id);
    let caller = ic_cdk::api::msg_caller();
    let key = pending_chat_route_key(&caller, &pending_id);
    let Some(route) = actionable_pending_chat_route(caller, &pending_id, ic_cdk::api::time())
    else {
        ic_cdk::trap("pending chat request is missing, expired, or belongs to another caller");
    };
    if let Err(message) = remove_shared_chat_sheet_link(caller, &route.chat_key) {
        ic_cdk::trap(message);
    }
    PENDING_CHAT_ROUTES.with(|routes| {
        routes.borrow_mut().remove(&key);
    });
}

#[ic_cdk::update]
fn dismiss_pending_chat_route(pending_id: String) {
    require_authed();
    validate_pending_chat_route_id(&pending_id);
    let caller = ic_cdk::api::msg_caller();
    PENDING_CHAT_ROUTES.with(|routes| {
        routes
            .borrow_mut()
            .remove(&pending_chat_route_key(&caller, &pending_id));
    });
}

/// remove_chat_sheet_link: caller-keyed removal. Removing a mapping
/// that does not exist is a no-op (idempotent).
#[ic_cdk::update]
fn remove_chat_sheet_link(chat_key: String) {
    require_authed();
    validate_legacy_chat_key_for_removal(&chat_key);
    let caller = ic_cdk::api::msg_caller();
    if let Err(message) = remove_shared_chat_sheet_link(caller, &chat_key) {
        ic_cdk::trap(message);
    }
}

/// chat_sheet_links: all of the caller's canonical app-scoped chat-handle → sheet mappings. Legacy
/// raw-coordinate rows are intentionally hidden and are lazily deleted by the next set call.
#[ic_cdk::query]
fn chat_sheet_links() -> Vec<ChatSheetLink> {
    let caller = ic_cdk::api::msg_caller();
    if caller == Principal::anonymous() {
        return Vec::new();
    }
    let (start, end) = chat_link_bounds(&caller);
    CHAT_SHEET_LINKS.with(|m| {
        m.borrow()
            .range(start..end)
            .filter(|(_, value)| is_canonical_app_scoped_chat_handle(&value.chat_key))
            .take(MAX_CHAT_LINKS_PER_PRINCIPAL)
            .map(|(_, value)| value)
            .collect()
    })
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
    pub signature: Vec<u8>,     // 64 bytes Ed25519 sig
    pub signer_pubkey: Vec<u8>, // 32 bytes Ed25519 pubkey
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
    if rewraps.len() > MAX_REWRAPS_PER_REQUEST {
        ic_cdk::trap("too many sheet rewraps in one request");
    }
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
    let mut seen_sheet_ids = BTreeSet::new();
    SHEETS.with(|s| {
        let map = s.borrow();
        for rw in &rewraps {
            if !seen_sheet_ids.insert(rw.sheet_id.as_str()) {
                ic_cdk::trap("duplicate sheet_id in rewrap batch");
            }
            if let Err(msg) = validate_wrapped_key(&rw.wrapped_key_for_partner, true) {
                ic_cdk::trap(msg);
            }
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
    if INVITES.with(|invites| invites.borrow().contains_key(&code)) {
        ic_cdk::trap("invite code collision; please retry");
    }
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
    if rewraps.len() > MAX_REWRAPS_PER_REQUEST {
        ic_cdk::trap("too many sheet rewraps in one request");
    }
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
        if principal_pair_count(caller) >= MAX_PAIRS_PER_PRINCIPAL {
            ic_cdk::trap("account quota reached for this principal");
        }
        if pair.members[1] != Principal::anonymous() {
            ic_cdk::trap("this account already has a partner");
        }
        if pair.members[0] == caller {
            ic_cdk::trap("creator cannot accept their own invite");
        }
    }
    // Validate the whole batch before mutating (atomic).
    let mut validated: Vec<(String, Vec<u8>)> = Vec::with_capacity(rewraps.len());
    let mut seen_sheet_ids = BTreeSet::new();
    SHEETS.with(|s| {
        let map = s.borrow();
        for rw in &rewraps {
            if !seen_sheet_ids.insert(rw.sheet_id.as_str()) {
                ic_cdk::trap("duplicate sheet_id in rewrap batch");
            }
            if let Err(msg) = validate_wrapped_key(&rw.wrapped_key_for_partner, true) {
                ic_cdk::trap(msg);
            }
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
        let staying = if leaving_is_a {
            pair.members[1]
        } else {
            pair.members[0]
        };
        pair.members[0] = staying;
        pair.members[1] = Principal::anonymous();
        map.insert(pair_id.clone(), pair.clone());
        (pair, staying)
    });
    // Rewrite every sheet: clear the leaver, promote the staying member if needed.
    let sheet_ids = pair_sheet_ids(&pair_id);
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
    let sheet_ids = pair_sheet_ids(&pair_id);
    for sid in &sheet_ids {
        for e in sheet_entries_iter(sid) {
            sheet_entries_remove(sid, e.id);
        }
        clear_entry_batch_receipts_for_sheet(sid);
        ENTRY_COUNTERS.with(|m| m.borrow_mut().remove(sid));
        SHEET_ENTRY_BYTES.with(|m| m.borrow_mut().remove(sid));
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
    if principal_pair_count(req.new_principal) >= MAX_PAIRS_PER_PRINCIPAL {
        ic_cdk::trap("new principal has reached the account quota");
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
    let sheet_ids = pair_sheet_ids(&req.pair_id);
    for sid in sheet_ids {
        update_sheet_field(&sid, |sh| {
            if sh.member_a == req.leaving_principal {
                sh.member_a = req.new_principal;
            } else if sh.member_b == req.leaving_principal {
                sh.member_b = req.new_principal;
            }
            // If the sheet is still Active, close it — the new
            // member inherits it as Closed with the same
            // encrypted closing-balance envelope (or none if not yet closed).
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
    let pk_bytes: [u8; 32] = pk_bytes_vec
        .try_into()
        .unwrap_or_else(|_| ic_cdk::trap("invalid stored pubkey length"));
    let sig_bytes: [u8; 64] = signed
        .signature
        .clone()
        .try_into()
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
    fn private_match_fixed_source_binding_candid_decodes_as_blob() {
        // OpenChat's frozen producer uses `[u8; 32]`; IOU intentionally accepts `Vec<u8>` and then
        // enforces length 32. Both are Candid `vec nat8`, so the cross-repo wire remains exact.
        let encoded = candid::encode_one([0x5Au8; 32]).unwrap();
        let decoded: Vec<u8> = candid::decode_one(&encoded).unwrap();
        assert_eq!(decoded, vec![0x5A; 32]);
    }
    use ic_stable_structures::VectorMemory;

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
                assert_eq!(
                    entry_key_sheet_id(&k),
                    *sheet,
                    "round-trip for sheet={sheet} id={id}"
                );
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
    fn batch_validation_rejects_a_bad_middle_row_before_any_entry_is_planned() {
        let mut request = test_add_entry_batch_req(3);
        request.entries[1].iv = vec![0; 11];
        let result = validate_add_entry_batch(&request, 40, None, || {
            panic!("the lazy sheet-byte scan must follow cheap row validation")
        });
        assert_eq!(result.unwrap_err(), "iv length must be 12..=16 bytes");
    }

    #[test]
    fn batch_retry_reuses_the_same_ids_without_planning_duplicate_entries() {
        let request = test_add_entry_batch_req(3);
        let first = validate_add_entry_batch(&request, 40, None, || 1_000).unwrap();
        let receipt = first.receipt();
        assert_eq!(first.entry_ids(), &[41, 42, 43]);

        // A browser encrypts with fresh salts/IVs on an outcome-unknown retry.
        // Idempotency is bound to sheet + exact import identity, not random
        // ciphertext bytes, so this must still resolve to the original ids.
        let mut reencrypted = request.clone();
        for row in &mut reencrypted.entries {
            row.entry_key = vec![91; 32];
            row.ciphertext = vec![92; 48];
            row.iv = vec![93; 16];
        }
        let retry = validate_add_entry_batch(&reencrypted, 43, Some(&receipt), || {
            panic!("receipt replay must not scan sheet entries")
        })
        .unwrap();
        assert!(retry.is_replay());
        assert_eq!(retry.entry_ids(), &[41, 42, 43]);
    }

    #[test]
    fn batch_receipt_is_shared_by_both_current_sheet_members_but_not_other_sheets() {
        let import_id = vec![8; 32];
        let first_member_key = entry_batch_receipt_key("0123456789abcdef", &import_id);
        // There is deliberately no caller coordinate in the receipt key: two
        // current members racing the same fanned-out OpenChat message converge.
        let second_member_key = entry_batch_receipt_key("0123456789abcdef", &import_id);
        assert_eq!(first_member_key, second_member_key);
        assert_ne!(
            first_member_key,
            entry_batch_receipt_key("fedcba9876543210", &import_id)
        );

        let sheet = test_sheet(SheetState::Active);
        assert!(validate_entry_batch_sheet_access(Some(sheet.clone()), p(1)).is_ok());
        assert!(validate_entry_batch_sheet_access(Some(sheet.clone()), p(2)).is_ok());
        // `add_entry_batch` calls this exact helper before its first
        // ENTRY_BATCH_RECEIPTS lookup, so a removed/non-member principal cannot
        // use an old receipt as an entry-existence oracle.
        assert_eq!(
            validate_entry_batch_sheet_access(Some(sheet.clone()), p(3)).err(),
            Some("caller does not have access to this sheet")
        );
        assert_eq!(
            validate_entry_batch_sheet_access(Some(sheet), Principal::anonymous()).err(),
            Some("caller does not have access to this sheet")
        );
        assert_eq!(
            validate_entry_batch_sheet_access(Some(test_sheet(SheetState::Closed)), p(1)).err(),
            Some("sheet is not active")
        );
        assert_eq!(
            validate_entry_batch_sheet_access(None, p(1)).err(),
            Some("caller does not have access to this sheet")
        );
    }

    #[test]
    fn batch_retry_ignores_payload_and_count_drift_after_the_authoritative_receipt() {
        let request = test_add_entry_batch_req(3);
        let first = validate_add_entry_batch(&request, 0, None, || 0).unwrap();
        let receipt = first.receipt();
        let mut changed = request.clone();
        changed.entries[0].ciphertext = vec![9; 47];
        let changed_retry = validate_add_entry_batch(&changed, 3, Some(&receipt), || {
            panic!("receipt replay must not scan after payload drift")
        })
        .unwrap();
        assert!(changed_retry.is_replay());
        assert_eq!(changed_retry.entry_ids(), &[1, 2, 3]);

        let mut shortened = request;
        shortened.entries.clear();
        let count_drift = validate_add_entry_batch(&shortened, 3, Some(&receipt), || {
            panic!("receipt replay must not validate count or scan entries")
        })
        .unwrap();
        assert!(count_drift.is_replay());
        assert_eq!(count_drift.entry_ids(), &[1, 2, 3]);
    }

    #[test]
    fn batch_preflight_enforces_count_entry_and_aggregate_sheet_quotas() {
        let two = test_add_entry_batch_req(2);
        assert_eq!(
            validate_add_entry_batch(&two, MAX_ENTRIES_PER_SHEET - 1, None, || 0).unwrap_err(),
            "entry quota reached for this sheet"
        );
        assert_eq!(
            validate_add_entry_batch(&two, 0, None, || MAX_SHEET_ENCRYPTED_BYTES - 1,).unwrap_err(),
            "sheet encrypted payload quota exceeded"
        );

        let mut oversized_wire = test_add_entry_batch_req(5);
        for row in &mut oversized_wire.entries {
            row.ciphertext = vec![0; MAX_ENTRY_CIPHERTEXT_BYTES];
        }
        assert_eq!(
            validate_add_entry_batch(&oversized_wire, 0, None, || {
                panic!("aggregate rejection must happen before the stable scan")
            })
            .unwrap_err(),
            "entry batch encrypted payload exceeds the 262144-byte limit"
        );

        let mut too_many = test_add_entry_batch_req(MAX_ENTRIES_PER_BATCH + 1);
        assert_eq!(
            validate_add_entry_batch(&too_many, 0, None, || {
                panic!("row-count rejection must happen before the stable scan")
            })
            .unwrap_err(),
            "entry batch must contain 1..=32 rows"
        );
        too_many.entries.truncate(1);
        assert!(validate_add_entry_batch(&too_many, 0, None, || 0).is_ok());
        too_many.entries = test_add_entry_batch_req(2).entries;
        too_many.import_id.pop();
        assert_eq!(
            validate_add_entry_batch(&too_many, 0, None, || {
                panic!("identity rejection must happen before the stable scan")
            })
            .unwrap_err(),
            "batch import id must be 32 bytes"
        );
    }

    #[test]
    fn batch_receipt_rejects_empty_zero_and_duplicate_ids() {
        for entry_ids in [vec![], vec![0], vec![7, 7]] {
            let receipt = EntryBatchReceipt {
                entry_ids,
                created_at: 0,
            };
            assert_eq!(
                validate_entry_batch_receipt(&receipt),
                Err("invalid stored batch receipt")
            );
        }
    }

    #[test]
    fn batch_endpoint_source_authenticates_before_receipt_and_validates_rows_before_scan() {
        let source = include_str!("lib.rs");
        let start = source.find("fn add_entry_batch(req:").unwrap();
        let end = source[start..].find("fn edit_entry(req:").unwrap() + start;
        let endpoint = &source[start..end];
        let access = endpoint.find("validate_entry_batch_sheet_access").unwrap();
        let lookup = endpoint.find("ENTRY_BATCH_RECEIPTS.with").unwrap();
        let validate = endpoint.find("validate_add_entry_batch(").unwrap();
        let scan = endpoint.find("sheet_entry_bytes(&req.sheet_id)").unwrap();
        assert!(
            access < lookup,
            "current membership/state must gate receipt lookup"
        );
        assert!(
            lookup < validate,
            "receipt replay must precede new-row validation"
        );
        assert!(
            validate < scan,
            "cheap new-row validation owns the lazy scan closure"
        );
    }

    #[test]
    fn batch_endpoint_is_pinned_in_both_inspect_message_security_lists() {
        let source = include_str!("lib.rs");
        let inspect_start = source.find("fn inspect_message()").unwrap();
        let endpoint_start = source[inspect_start..].find("fn whoami()").unwrap() + inspect_start;
        let inspect = &source[inspect_start..endpoint_start];
        let auth_start = inspect.find("let require_auth_methods").unwrap();
        let allowed = &inspect[..auth_start];
        let require_auth = &inspect[auth_start..];
        assert_eq!(allowed.matches("\"add_entry_batch\"").count(), 1);
        assert_eq!(require_auth.matches("\"add_entry_batch\"").count(), 1);
    }

    #[test]
    fn private_match_context_is_allowed_as_an_anonymous_capability_endpoint() {
        let source = include_str!("lib.rs");
        let inspect_start = source.find("fn inspect_message()").unwrap();
        let endpoint_start = source[inspect_start..].find("fn whoami()").unwrap() + inspect_start;
        let inspect = &source[inspect_start..endpoint_start];
        let auth_start = inspect.find("let require_auth_methods").unwrap();
        let allowed = &inspect[..auth_start];
        let require_auth = &inspect[auth_start..];
        assert_eq!(
            allowed
                .matches("\"openchat_private_match_context\"")
                .count(),
            1,
            "the credentialless frame must reach the capability-gated endpoint",
        );
        assert_eq!(
            require_auth
                .matches("\"openchat_private_match_context\"")
                .count(),
            0,
            "the caller is intentionally anonymous; the one-use capability is the authority",
        );
    }

    #[test]
    fn recipient_callback_is_whitelisted_but_not_a_generic_signed_in_user_method() {
        let source = include_str!("lib.rs");
        let inspect_start = source.find("fn inspect_message()").unwrap();
        let endpoint_start = source[inspect_start..].find("fn whoami()").unwrap() + inspect_start;
        let inspect = &source[inspect_start..endpoint_start];
        let auth_start = inspect.find("let require_auth_methods").unwrap();
        let allowed = &inspect[..auth_start];
        let require_auth = &inspect[auth_start..];
        assert_eq!(
            allowed
                .matches("\"c2c_authorize_ai_action_recipients\"")
                .count(),
            1,
        );
        assert_eq!(
            require_auth
                .matches("\"c2c_authorize_ai_action_recipients\"")
                .count(),
            0,
            "the callback performs a stricter exact-UserIndex caller check in its handler",
        );
    }

    #[test]
    fn batch_receipts_round_trip_in_a_fresh_stable_map_region() {
        let memory = VectorMemory::default();
        let mut receipts = StableBTreeMap::<String, EntryBatchReceipt, _>::init(memory.clone());
        let receipt = EntryBatchReceipt {
            entry_ids: vec![9, 10],
            created_at: 123,
        };
        receipts.insert("sheet\0message".into(), receipt.clone());
        assert_eq!(receipts.get(&"sheet\0message".to_string()), Some(receipt));
        const {
            assert!(
                SCHEMA_VERSION >= 18,
                "MemoryId 29 batch receipts require schema v18"
            )
        };
    }

    #[test]
    fn clearing_batch_receipts_removes_only_the_exact_sheet_range() {
        let receipt = EntryBatchReceipt {
            entry_ids: vec![41, 42],
            created_at: 123,
        };
        let sheet_a = "batch-cleanup-sheet-a";
        let sheet_b = "batch-cleanup-sheet-b";
        let a_first = entry_batch_receipt_key(sheet_a, &[1; 32]);
        let a_second = entry_batch_receipt_key(sheet_a, &[2; 32]);
        let b_first = entry_batch_receipt_key(sheet_b, &[1; 32]);
        ENTRY_BATCH_RECEIPTS.with(|receipts| {
            let mut receipts = receipts.borrow_mut();
            receipts.insert(a_first.clone(), receipt.clone());
            receipts.insert(a_second.clone(), receipt.clone());
            receipts.insert(b_first.clone(), receipt.clone());
        });

        clear_entry_batch_receipts_for_sheet(sheet_a);

        ENTRY_BATCH_RECEIPTS.with(|receipts| {
            let receipts = receipts.borrow();
            assert_eq!(receipts.get(&a_first), None);
            assert_eq!(receipts.get(&a_second), None);
            assert_eq!(receipts.get(&b_first), Some(receipt));
        });
        clear_entry_batch_receipts_for_sheet(sheet_b);
    }

    #[test]
    fn batch_receipt_decodes_the_pre_release_payload_hash_shape() {
        #[derive(CandidType, Deserialize)]
        struct LegacyEntryBatchReceipt {
            payload_hash: Vec<u8>,
            entry_ids: Vec<u64>,
            created_at: u64,
        }
        let legacy = LegacyEntryBatchReceipt {
            payload_hash: vec![8; 32],
            entry_ids: vec![4, 5],
            created_at: 77,
        };
        let decoded = EntryBatchReceipt::from_bytes(Cow::Owned(Encode!(&legacy).unwrap()));
        assert_eq!(decoded.entry_ids, vec![4, 5]);
        assert_eq!(decoded.created_at, 77);
    }

    #[test]
    fn chat_link_key_is_caller_scoped_and_unambiguous() {
        // CHAT_SHEET_LINKS keeps its released `caller\0chat_key` composite-key layout. The value
        // validator separately guarantees that new suffixes are app-scoped handles.
        let a = Principal::from_text("aaaaa-aa").unwrap();
        let b = Principal::anonymous();
        let first = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let second = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE";
        assert_eq!(chat_link_key(&a, first), chat_link_key(&a, first));
        assert_ne!(chat_link_key(&a, first), chat_link_key(&a, second));
        assert_ne!(chat_link_key(&a, first), chat_link_key(&b, first));
        // The caller-prefix scan in chat_sheet_links() relies on the
        // NUL separator: a key belongs to caller `p` iff it starts
        // with `p.to_text() + "\0"`. Principal text never contains
        // NUL, so no other principal's keys can match the prefix.
        let key = chat_link_key(&a, first);
        assert!(key.starts_with(&format!("{}\0", a.to_text())));
        assert_eq!(&key[a.to_text().len() + 1..], first);
    }

    #[test]
    fn chat_sheet_links_accept_only_canonical_app_scoped_handles() {
        let canonical = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
        assert!(is_canonical_app_scoped_chat_handle(canonical));
        for malformed in [
            "",
            "group:raw-openchat-id",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            // A 43-character base64url spelling with non-zero pad bits cannot canonically encode
            // exactly 32 bytes, even though every character is in the alphabet.
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
        ] {
            assert!(
                !is_canonical_app_scoped_chat_handle(malformed),
                "{malformed:?}"
            );
        }
    }

    #[test]
    fn chat_link_launch_tokens_accept_only_canonical_32_byte_base64url() {
        for bytes in [[0u8; 32], [8u8; 32], [255u8; 32]] {
            let encoded = base64url_no_pad(&bytes);
            assert_eq!(encoded.len(), 43);
            assert_eq!(decode_base64url_32(&encoded), Some(bytes));
        }
        for malformed in [
            "",
            "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
            "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIca!",
            // Valid alphabet and length, but the final character has non-zero pad bits.
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
            "group:raw-openchat-coordinate-should-never-decode",
        ] {
            assert_eq!(decode_base64url_32(malformed), None, "{malformed:?}");
        }
    }

    #[test]
    fn pending_chat_route_ids_are_opaque_caller_scoped_digests() {
        let owner = Principal::from_slice(&[1, 2, 3]);
        let other = Principal::from_slice(&[4, 5, 6]);
        let handle = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
        let owner_id = pending_chat_route_id(&owner, handle);
        let other_id = pending_chat_route_id(&other, handle);
        assert_eq!(owner_id.len(), 64);
        assert!(owner_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_ne!(owner_id, other_id);
        assert!(!owner_id.contains(handle));
        assert!(!owner_id.contains("group:"));
        assert_eq!(owner_id, pending_chat_route_id(&owner, handle));
    }

    #[test]
    fn pending_chat_route_ranges_exclude_other_principals() {
        let owner = Principal::from_slice(&[1, 2, 3]);
        let other = Principal::from_slice(&[4, 5, 6]);
        let pending_id = "ab".repeat(32);
        let key = pending_chat_route_key(&owner, &pending_id);
        let other_key = pending_chat_route_key(&other, &pending_id);
        let (start, end) = pending_chat_route_bounds(&owner);
        assert!(key >= start && key < end);
        assert!(other_key < start || other_key >= end);
        assert_eq!(key.rsplit_once('\0').unwrap().1, pending_id);
    }

    #[test]
    fn legacy_pending_route_decodes_without_token_claim_authority() {
        #[derive(CandidType)]
        struct LegacyPendingChatRoute {
            chat_key: String,
            last_seen: u64,
        }

        let legacy = LegacyPendingChatRoute {
            chat_key: base64url_no_pad(&[39; 32]),
            last_seen: 10,
        };
        let bytes = Encode!(&legacy).expect("encode legacy pending route");
        let upgraded = Decode!(&bytes, PendingChatRoute).expect("decode legacy pending route");
        assert_eq!(upgraded.chat_key, legacy.chat_key);
        assert_eq!(upgraded.last_seen, legacy.last_seen);
        assert_eq!(upgraded.claim_version, None);
        assert_eq!(upgraded.chat_name, None);
    }

    #[test]
    fn legacy_chat_sheet_link_decodes_without_openchat_display_name() {
        #[derive(CandidType)]
        struct LegacyChatSheetLink {
            chat_key: String,
            sheet_id: u64,
        }

        let legacy = LegacyChatSheetLink {
            chat_key: base64url_no_pad(&[37; 32]),
            sheet_id: 7,
        };
        let bytes = Encode!(&legacy).expect("encode legacy chat link");
        let upgraded = Decode!(&bytes, ChatSheetLink).expect("decode legacy chat link");
        assert_eq!(upgraded.chat_key, legacy.chat_key);
        assert_eq!(upgraded.sheet_id, legacy.sheet_id);
        assert_eq!(upgraded.chat_name, None);
    }

    #[test]
    fn pending_chat_routes_expire_at_the_documented_boundary() {
        let route = PendingChatRoute {
            chat_key: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg".to_string(),
            last_seen: 10,
            claim_version: Some(1),
            chat_name: Some("Manager".to_string()),
        };
        assert!(pending_chat_route_is_live(
            &route,
            10 + PENDING_CHAT_ROUTE_TTL_NS
        ));
        assert!(!pending_chat_route_is_live(
            &route,
            11 + PENDING_CHAT_ROUTE_TTL_NS
        ));
        // A clock that moves backwards cannot underflow into an artificial expiry.
        assert!(pending_chat_route_is_live(&route, 0));
    }

    #[test]
    fn durable_chat_links_remain_visible_and_actionable_after_setup_request_expiry() {
        let owner = p(238);
        let chat_key = base64url_no_pad(&[38; 32]);
        let pending_id = pending_chat_route_id(&owner, &chat_key);
        let link_key = chat_link_key(&owner, &chat_key);
        clear_pending_chat_routes_for_principal(owner);
        CHAT_SHEET_LINKS.with(|links| {
            let mut links = links.borrow_mut();
            links.remove(&link_key);
            links.insert(
                link_key.clone(),
                ChatSheetLink {
                    chat_key: chat_key.clone(),
                    sheet_id: 7,
                    chat_name: Some("Mother".to_string()),
                },
            );
        });
        remember_claimed_chat_route(owner, &chat_key, "Mother", 10);

        let after_expiry = 11 + PENDING_CHAT_ROUTE_TTL_NS;
        let rows = pending_chat_route_views(owner, after_expiry);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pending_id, pending_id);
        assert_eq!(rows[0].last_seen, 0);
        assert!(rows[0].has_current_link);
        assert!(actionable_pending_chat_route(owner, &pending_id, after_expiry).is_some());

        CHAT_SHEET_LINKS.with(|links| {
            links.borrow_mut().remove(&link_key);
        });
        clear_pending_chat_routes_for_principal(owner);
    }

    #[test]
    fn two_authenticated_pending_chats_remain_independently_actionable() {
        let owner = p(241);
        let other = p(239);
        clear_pending_chat_routes_for_principal(owner);
        let older_handle = base64url_no_pad(&[41; 32]);
        let newer_handle = base64url_no_pad(&[42; 32]);
        let older_id = pending_chat_route_id(&owner, &older_handle);
        let newer_id = pending_chat_route_id(&owner, &newer_handle);

        remember_claimed_chat_route(owner, &older_handle, "Mother", 10);
        assert!(actionable_pending_chat_route(owner, &older_id, 10).is_some());

        // A second authenticated launch must not invalidate the first chat's exact pending id.
        // Caller scoping and TTL—not visual ordering—remain the authorization boundary.
        remember_claimed_chat_route(owner, &newer_handle, "Manager", 11);
        assert_eq!(
            actionable_pending_chat_route(owner, &older_id, 11).and_then(|route| route.chat_name),
            Some("Mother".to_string()),
        );
        assert_eq!(
            actionable_pending_chat_route(owner, &newer_id, 11).and_then(|route| route.chat_name),
            Some("Manager".to_string()),
        );
        assert!(actionable_pending_chat_route(other, &older_id, 11).is_none());

        clear_pending_chat_routes_for_principal(owner);
        remember_claimed_chat_route(owner, &older_handle, "Mother", 20);
        remember_claimed_chat_route(owner, &newer_handle, "Manager", 20);
        assert!(actionable_pending_chat_route(owner, &older_id, 20).is_some());
        assert!(actionable_pending_chat_route(owner, &newer_id, 20).is_some());
        assert!(
            actionable_pending_chat_route(owner, &older_id, 21 + PENDING_CHAT_ROUTE_TTL_NS,)
                .is_none()
        );
        clear_pending_chat_routes_for_principal(owner);
    }

    #[test]
    fn pending_chat_routes_are_quota_bounded_and_cleared_with_the_binding() {
        let owner = p(240);
        clear_pending_chat_routes_for_principal(owner);
        for index in 1u8..=33 {
            let handle = base64url_no_pad(&[index; 32]);
            remember_claimed_chat_route(owner, &handle, &format!("Chat {index}"), u64::from(index));
        }
        let (start, end) = pending_chat_route_bounds(&owner);
        let keys: Vec<String> = PENDING_CHAT_ROUTES.with(|routes| {
            routes
                .borrow()
                .range(start.clone()..end.clone())
                .map(|(key, _)| key)
                .collect()
        });
        assert_eq!(keys.len(), MAX_PENDING_CHAT_ROUTES_PER_PRINCIPAL);
        let evicted = pending_chat_route_key(
            &owner,
            &pending_chat_route_id(&owner, &base64url_no_pad(&[1; 32])),
        );
        assert!(!keys.contains(&evicted));

        // Disconnect/relink cleanup is unconditional, even if no current binding row remains.
        remove_openchat_binding_for_iou(owner);
        let remaining =
            PENDING_CHAT_ROUTES.with(|routes| routes.borrow().range(start..end).count());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn pending_chat_routes_have_a_global_bound_and_reclaim_expired_rows() {
        clear_all_pending_chat_routes();
        let handle = base64url_no_pad(&[71; 32]);
        let mut oldest_key = String::new();
        PENDING_CHAT_ROUTES.with(|routes| {
            let mut map = routes.borrow_mut();
            for index in 0..MAX_PENDING_CHAT_ROUTES_TOTAL {
                let owner = Principal::from_slice(&(index as u32).to_be_bytes());
                let pending_id = pending_chat_route_id(&owner, &handle);
                let key = pending_chat_route_key(&owner, &pending_id);
                if index == 0 {
                    oldest_key = key.clone();
                }
                map.insert(
                    key,
                    PendingChatRoute {
                        chat_key: handle.clone(),
                        last_seen: (index + 1) as u64,
                        claim_version: Some(1),
                        chat_name: Some(format!("Chat {index}")),
                    },
                );
            }
        });
        let newcomer = Principal::from_slice(b"new-global-route");
        let newcomer_handle = base64url_no_pad(&[72; 32]);
        let newcomer_key = pending_chat_route_key(
            &newcomer,
            &pending_chat_route_id(&newcomer, &newcomer_handle),
        );
        remember_claimed_chat_route(
            newcomer,
            &newcomer_handle,
            "New chat",
            MAX_PENDING_CHAT_ROUTES_TOTAL as u64 + 1,
        );
        PENDING_CHAT_ROUTES.with(|routes| {
            let map = routes.borrow();
            assert_eq!(map.len(), MAX_PENDING_CHAT_ROUTES_TOTAL as u64);
            assert!(!map.contains_key(&oldest_key));
            assert!(map.contains_key(&newcomer_key));
        });

        clear_all_pending_chat_routes();
        let expired_owner = p(242);
        let expired_handle = base64url_no_pad(&[73; 32]);
        remember_claimed_chat_route(expired_owner, &expired_handle, "Expired", 1);
        let live_owner = p(243);
        let live_handle = base64url_no_pad(&[74; 32]);
        remember_claimed_chat_route(
            live_owner,
            &live_handle,
            "Live",
            PENDING_CHAT_ROUTE_TTL_NS + 2,
        );
        let (expired_start, expired_end) = pending_chat_route_bounds(&expired_owner);
        assert_eq!(
            PENDING_CHAT_ROUTES
                .with(|routes| { routes.borrow().range(expired_start..expired_end).count() }),
            0,
        );
        clear_all_pending_chat_routes();
    }

    #[test]
    fn chat_routing_offers_only_active_sheets_with_explicit_sheet_consent() {
        let active = test_sheet(SheetState::Active);
        assert!(sheet_is_chat_routable(&active, p(1)));
        assert!(sheet_is_chat_routable(&active, p(2)));
        // A principal may have joined the Pair later, but Pair membership is not sheet consent.
        assert!(!sheet_is_chat_routable(&active, p(3)));
        assert!(!sheet_is_chat_routable(
            &test_sheet(SheetState::Closed),
            p(1),
        ));
        assert!(!sheet_is_chat_routable(&active, Principal::anonymous(),));
    }

    #[test]
    fn app_scoped_card_context_requires_exact_v1_handles() {
        let mut context = test_scoped_card_context();
        assert!(valid_app_scoped_card_context(&context));
        assert_eq!(
            scoped_chat_handle_key(&context.chat_handle).unwrap().len(),
            43
        );
        assert_eq!(
            scoped_chat_handle_key(&context.chat_handle).unwrap(),
            "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg"
        );
        context.context_version = 2;
        assert!(!valid_app_scoped_card_context(&context));
        context = test_scoped_card_context();
        context.app_subject.pop();
        assert!(!valid_app_scoped_card_context(&context));
        context = test_scoped_card_context();
        context.chat_handle.push(0);
        assert!(!valid_app_scoped_card_context(&context));
        context = test_scoped_card_context();
        context.message_handle.clear();
        assert!(!valid_app_scoped_card_context(&context));
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
        const {
            assert!(
                SCHEMA_VERSION >= 3,
                "SCHEMA_VERSION must be >= 3 after the v1.3.3 MemoryId move (issue #7)"
            )
        };
    }

    // ── v1.12.0: shared transaction types per account ──────────────────

    fn p(byte: u8) -> Principal {
        Principal::from_slice(&[byte])
    }

    fn test_add_entry_batch_req(count: usize) -> AddEntryBatchReq {
        AddEntryBatchReq {
            sheet_id: "0123456789abcdef".into(),
            import_id: vec![5; 32],
            entries: (0..count)
                .map(|index| EncryptedEntryInput {
                    entry_key: vec![index as u8; 32],
                    ciphertext: vec![index as u8 + 1; 32],
                    iv: vec![index as u8 + 2; 12],
                })
                .collect(),
        }
    }

    fn test_sheet(state: SheetState) -> Sheet {
        Sheet {
            id: "0123456789abcdef".into(),
            pair_id: "fedcba9876543210".into(),
            state,
            closing_window_days: 365,
            last_entry_at: None,
            wrapped_key_a: vec![1],
            wrapped_key_b: vec![2],
            member_a: p(1),
            member_b: p(2),
            created_at: 1,
            closed_at: None,
            closing_balances_key: None,
            closing_balances_enc: None,
            closing_balances_iv: None,
            name_enc: None,
            name_iv: None,
        }
    }

    #[test]
    fn config_bootstrap_never_trusts_the_first_random_signed_in_user() {
        let anonymous = Principal::anonymous();
        let installer = p(1);
        let stranger = p(2);
        assert!(!can_manage_config(anonymous, stranger, false));
        assert!(can_manage_config(anonymous, installer, true));
        assert!(can_manage_config(installer, installer, false));
        assert!(can_manage_config(installer, stranger, true));
        assert!(!can_manage_config(installer, stranger, false));
        assert!(!can_manage_config(installer, anonymous, true));
    }

    #[test]
    fn ai_app_attestation_requires_exact_configured_owner_and_name() {
        let owner = p(7);
        let correct = verify_ai_app(
            VerifyAiAppArgs {
                name: "iou".into(),
                owner,
            },
            Some(owner),
        );
        assert!(correct.vouched);
        assert_eq!(correct.owner, Some(owner));

        assert!(
            !verify_ai_app(
                VerifyAiAppArgs {
                    name: "IOU".into(),
                    owner
                },
                Some(owner),
            )
            .vouched
        );
        assert!(
            !verify_ai_app(
                VerifyAiAppArgs {
                    name: "iou".into(),
                    owner: p(8)
                },
                Some(owner),
            )
            .vouched
        );
        assert!(
            !verify_ai_app(
                VerifyAiAppArgs {
                    name: "iou".into(),
                    owner
                },
                None,
            )
            .vouched
        );
        assert!(
            !verify_ai_app(
                VerifyAiAppArgs {
                    name: "iou".into(),
                    owner: Principal::anonymous()
                },
                Some(Principal::anonymous()),
            )
            .vouched
        );
    }

    fn test_ai_app_v2_binding() -> AiAppVerificationBinding {
        AiAppVerificationBinding {
            user_index_canister_id: p(1),
            app_id: 7,
            app_revision: 99,
            owner: p(2),
            canonical_name: "iou".into(),
            app_canister_id: p(3),
            // Principal::from_slice(&[4]) is the anonymous principal, so use a distinct
            // non-anonymous fixture for the inbox authority.
            inbox_canister_id: Some(p(5)),
            manifest_hash: vec![5; 32],
        }
    }

    fn test_card_content() -> AiAppCardContentV1 {
        AiAppCardContentV1 {
            title: IOU_CARD_TITLE.into(),
            rows: vec![
                AttestedActionCardRow { label: "Amount".into(), value: "25".into() },
                AttestedActionCardRow { label: "Currency".into(), value: "USD".into() },
                AttestedActionCardRow { label: "Type".into(), value: "iou".into() },
                AttestedActionCardRow { label: "Direction".into(), value: "debt".into() },
                AttestedActionCardRow { label: "Date".into(), value: "2026-08-05".into() },
                AttestedActionCardRow { label: "Note".into(), value: "rent".into() },
            ],
            confirm_label: IOU_CARD_CONFIRM_LABEL.into(),
            cancel_label: IOU_CARD_CANCEL_LABEL.into(),
            action_id: IOU_CARD_ACTION_ID.into(),
            disclosure: None,
            expires_at: None,
            confirm_payload: Some(
                br#"{"kind":"iou","amount":25,"currency":"USD","direction":"debt","date":"2026-08-05","note":"rent","message":"I owe 25 USD rent"}"#.to_vec(),
            ),
        }
    }

    fn test_scoped_card_context() -> AppScopedCardContextV1 {
        AppScopedCardContextV1 {
            context_version: 1,
            app_subject: vec![7; 32],
            chat_handle: vec![8; 32],
            message_handle: vec![9; 32],
            app_id: 7,
            app_revision: 99,
            action_id: IOU_CARD_ACTION_ID.into(),
        }
    }

    fn test_card_attestation_binding() -> CardAttestationBindingV1 {
        let commitment = AppScopedCardContentCommitmentV1 {
            context: test_scoped_card_context(),
            content: test_card_content(),
        };
        CardAttestationBindingV1 {
            user_index_canister_id: p(1),
            app_canister_id: p(3),
            commitment,
            authority_content_hash: [10; 32],
        }
    }

    fn test_card_link() -> OpenChatBinding {
        OpenChatBinding {
            iou_principal: p(20),
            user_index_canister_id: p(1),
            app_id: 7,
            app_revision: Some(99),
            app_canister_id: Some(p(3)),
            key_version: Some(4),
            app_subject: Some(vec![7; 32]),
            subject_version: Some(1),
            consumer_queue_selector: Some(vec![8; 32]),
            consumer_queue_selector_version: Some(1),
            consumer_public_key_pem: Some("key-a".into()),
            openchat_user_id: Principal::anonymous(),
            linked_at: 1,
        }
    }

    fn test_recipient_config() -> Config {
        Config {
            creator_principal: p(99),
            deployed_at: 1,
            ai_app_owner: Some(p(2)),
            openchat_user_index_canister_id: Some(p(1)),
            ai_app_verification_binding: Some(test_ai_app_v2_binding()),
        }
    }

    fn test_recipient_link(principal: Principal, seed: u8) -> RecipientBindingState {
        let public_key =
            format!("-----BEGIN PUBLIC KEY-----\nkey-{seed}\n-----END PUBLIC KEY-----");
        RecipientBindingState {
            binding: OpenChatBinding {
                iou_principal: principal,
                user_index_canister_id: p(1),
                app_id: 7,
                app_revision: Some(99),
                app_canister_id: Some(p(3)),
                key_version: Some(u64::from(seed)),
                app_subject: Some(vec![seed; 32]),
                subject_version: Some(1),
                consumer_queue_selector: Some(vec![seed.wrapping_add(40); 32]),
                consumer_queue_selector_version: Some(1),
                consumer_public_key_pem: Some(public_key.clone()),
                openchat_user_id: Principal::anonymous(),
                linked_at: 1,
            },
            current_consumer_public_key: Some(public_key),
        }
    }

    fn test_recipient_args(confirmer_subject: u8) -> AuthorizeAiActionRecipientsArgs {
        let mut context = test_scoped_card_context();
        context.app_subject = vec![confirmer_subject; 32];
        AuthorizeAiActionRecipientsArgs {
            context,
            content_hash: vec![10; 32],
            confirm_payload_hash: vec![11; 32],
            confirmation_lease_generation: 3,
            // Confirmation provenance is immutable and may be old when UserIndex makes a fresh
            // authorization/deposit attempt.
            created_at: 100,
            authorization_created_at: 1_000,
        }
    }

    fn test_recipient_pair(sheet: &Sheet) -> Pair {
        Pair {
            id: sheet.pair_id.clone(),
            members: [sheet.member_a, sheet.member_b],
            invite_code: "unused".into(),
            created_at: 1,
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
        }
    }

    #[test]
    fn recipient_grant_uses_only_exact_routed_sheet_members_and_is_deterministic() {
        let sheet = test_sheet(SheetState::Active);
        let pair = test_recipient_pair(&sheet);
        let confirmer = test_recipient_link(sheet.member_a, 21);
        let partner = test_recipient_link(sheet.member_b, 22);
        let unrelated = test_recipient_link(p(23), 23);
        let args = test_recipient_args(21);
        let candidates = vec![unrelated, partner.clone(), confirmer.clone()];

        let first = authorize_ai_action_recipients_for_state(
            &args,
            &test_recipient_config(),
            p(3),
            p(1),
            1_001,
            &confirmer.binding,
            &sheet,
            &pair,
            &candidates,
        );
        let second = authorize_ai_action_recipients_for_state(
            &args,
            &test_recipient_config(),
            p(3),
            p(1),
            1_001,
            &confirmer.binding,
            &sheet,
            &pair,
            &candidates,
        );
        assert_eq!(first, second);
        let AuthorizeAiActionRecipientsResponse::Success(success) = first else {
            panic!("exact routed account should authorize");
        };
        assert_eq!(success.expires_at, 301_000);
        assert_eq!(success.recipients.len(), 2);
        assert_eq!(success.recipients[0].app_subject, vec![21; 32]);
        assert_eq!(success.recipients[1].app_subject, vec![22; 32]);
        assert_eq!(success.recipients[0].app_user_key_version, 21);
        assert_eq!(success.scope_commitment.len(), 32);
        assert!(!success
            .recipients
            .iter()
            .any(|recipient| { recipient.app_subject == vec![23; 32] }));

        // Pair membership is not recipient authority: a late pair member who is not recorded on
        // this exact sheet cannot displace or join its independently encrypted deliveries.
        let mut broader_pair = pair.clone();
        broader_pair.members[1] = p(23);
        let broader = authorize_ai_action_recipients_for_state(
            &args,
            &test_recipient_config(),
            p(3),
            p(1),
            1_001,
            &confirmer.binding,
            &sheet,
            &broader_pair,
            &candidates,
        );
        let AuthorizeAiActionRecipientsResponse::Success(broader) = broader else {
            panic!("pair churn must not broaden exact sheet access");
        };
        assert_eq!(broader.recipients.len(), 2);
    }

    #[test]
    fn recipient_grant_rejects_stale_authority_and_binds_every_security_coordinate() {
        let sheet = test_sheet(SheetState::Active);
        let pair = test_recipient_pair(&sheet);
        let confirmer = test_recipient_link(sheet.member_a, 31);
        let partner = test_recipient_link(sheet.member_b, 32);
        let args = test_recipient_args(31);
        let candidates = vec![confirmer.clone(), partner.clone()];
        let authorize = |request: &AuthorizeAiActionRecipientsArgs,
                         routed_sheet: &Sheet,
                         bindings: &[RecipientBindingState],
                         caller: Principal,
                         now_ms: u64| {
            authorize_ai_action_recipients_for_state(
                request,
                &test_recipient_config(),
                p(3),
                caller,
                now_ms,
                &confirmer.binding,
                routed_sheet,
                &pair,
                bindings,
            )
        };
        let AuthorizeAiActionRecipientsResponse::Success(base) =
            authorize(&args, &sheet, &candidates, p(1), 1_001)
        else {
            panic!("fixture should authorize");
        };

        let mut changed_args = args.clone();
        changed_args.confirm_payload_hash[0] ^= 1;
        let AuthorizeAiActionRecipientsResponse::Success(changed) =
            authorize(&changed_args, &sheet, &candidates, p(1), 1_001)
        else {
            panic!("changed valid request should still authorize");
        };
        assert_ne!(base.scope_commitment, changed.scope_commitment);

        let mut fresh_retry = args.clone();
        fresh_retry.authorization_created_at = 2_000;
        let AuthorizeAiActionRecipientsResponse::Success(fresh_retry) =
            authorize(&fresh_retry, &sheet, &candidates, p(1), 2_001)
        else {
            panic!("an old confirmation must accept a fresh authorization attempt");
        };
        assert_eq!(fresh_retry.expires_at, 302_000);
        assert_ne!(base.scope_commitment, fresh_retry.scope_commitment);

        let mut changed_sheet = test_sheet(SheetState::Active);
        changed_sheet.id = "1111111111111111".into();
        let AuthorizeAiActionRecipientsResponse::Success(changed) =
            authorize(&args, &changed_sheet, &candidates, p(1), 1_001)
        else {
            panic!("changed exact sheet should still authorize");
        };
        assert_ne!(base.scope_commitment, changed.scope_commitment);

        let mut stale_confirmer = confirmer.clone();
        stale_confirmer.current_consumer_public_key = Some("replaced".into());
        assert_eq!(
            authorize(
                &args,
                &sheet,
                &[stale_confirmer, partner.clone()],
                p(1),
                1_001
            ),
            AuthorizeAiActionRecipientsResponse::NotAuthorized,
        );
        let mut stale_partner = partner.clone();
        stale_partner.current_consumer_public_key = Some("replaced".into());
        assert_eq!(
            authorize(
                &args,
                &sheet,
                &[confirmer.clone(), stale_partner],
                p(1),
                1_001
            ),
            AuthorizeAiActionRecipientsResponse::NotAuthorized,
            "app-authorized delivery must never silently fall back to confirmer-only",
        );
        assert_eq!(
            authorize(&args, &sheet, &candidates, p(9), 1_001),
            AuthorizeAiActionRecipientsResponse::NotAuthorized,
        );
        assert_eq!(
            authorize(&args, &sheet, &candidates, p(1), 301_001),
            AuthorizeAiActionRecipientsResponse::Stale,
        );
        assert!(matches!(
            authorize(&args, &sheet, &candidates, p(1), 999),
            AuthorizeAiActionRecipientsResponse::Success(_)
        ));
        let mut cross_subnet_order = args.clone();
        cross_subnet_order.created_at = cross_subnet_order.authorization_created_at + 1;
        assert!(matches!(
            authorize(&cross_subnet_order, &sheet, &candidates, p(1), 1_001),
            AuthorizeAiActionRecipientsResponse::Success(_)
        ));
        let mut closed = test_sheet(SheetState::Closed);
        closed.closed_at = Some(1);
        assert_eq!(
            authorize(&args, &closed, &candidates, p(1), 1_001),
            AuthorizeAiActionRecipientsResponse::NotAuthorized,
        );
        let mut archived_pair = pair.clone();
        archived_pair.archived_at = Some(1);
        assert_eq!(
            authorize_ai_action_recipients_for_state(
                &args,
                &test_recipient_config(),
                p(3),
                p(1),
                1_001,
                &confirmer.binding,
                &sheet,
                &archived_pair,
                &candidates,
            ),
            AuthorizeAiActionRecipientsResponse::NotAuthorized,
        );
    }

    #[test]
    fn shared_chat_route_materialization_repairs_partner_and_preserves_newer_conflicts() {
        let chat_key = base64url_no_pad(&[91; 32]);
        let mut first = test_sheet(SheetState::Active);
        first.id = "9191919191919191".into();
        first.pair_id = "9191919191919100".into();
        first.member_a = p(91);
        first.member_b = p(92);
        let mut second = test_sheet(SheetState::Active);
        second.id = "9292929292929292".into();
        second.pair_id = "9292929292929200".into();
        second.member_a = p(91);
        second.member_b = p(93);
        let first_id = u64::from_str_radix(&first.id, 16).unwrap();
        let second_id = u64::from_str_radix(&second.id, 16).unwrap();
        let unrelated_sheet_id = 0x9393939393939393;
        SHEETS.with(|sheets| {
            sheets.borrow_mut().insert(first.id.clone(), first.clone());
            sheets
                .borrow_mut()
                .insert(second.id.clone(), second.clone());
        });
        for principal in [p(91), p(92), p(93), p(94)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&principal, &chat_key));
            });
        }

        // Legacy state has only the confirmer's row. Callback-time repair must materialize the
        // same opaque route for the exact partner, never an unrelated principal/account.
        CHAT_SHEET_LINKS.with(|links| {
            links.borrow_mut().insert(
                chat_link_key(&p(91), &chat_key),
                ChatSheetLink {
                    chat_key: chat_key.clone(),
                    sheet_id: first_id,
                    chat_name: Some("Family".into()),
                },
            );
        });
        repair_shared_chat_sheet_link(p(91), &chat_key, &first).expect("legacy route repair");
        assert_eq!(linked_sheet_for(p(92), &chat_key), Some(first.id.clone()));
        assert_eq!(linked_sheet_for(p(94), &chat_key), None);
        remember_claimed_chat_route(p(91), &chat_key, "Family renamed", 10);
        for member in [p(91), p(92)] {
            let linked_name = CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow()
                    .get(&chat_link_key(&member, &chat_key))
                    .and_then(|link| link.chat_name)
            });
            assert_eq!(linked_name.as_deref(), Some("Family renamed"));
        }

        // A newer partner-specific conflict must survive the old account's conditional removal.
        CHAT_SHEET_LINKS.with(|links| {
            links.borrow_mut().insert(
                chat_link_key(&p(92), &chat_key),
                ChatSheetLink {
                    chat_key: chat_key.clone(),
                    sheet_id: unrelated_sheet_id,
                    chat_name: None,
                },
            );
        });
        assert!(repair_shared_chat_sheet_link(p(91), &chat_key, &first).is_err());
        assert_eq!(
            linked_sheet_for(p(92), &chat_key),
            Some(format!("{unrelated_sheet_id:016x}")),
            "lazy callback repair must not overwrite a newer partner decision",
        );
        assert!(store_shared_chat_sheet_link(p(91), chat_key.clone(), second_id, None).is_err());
        assert_eq!(linked_sheet_for(p(91), &chat_key), Some(first.id.clone()));
        assert_eq!(linked_sheet_for(p(93), &chat_key), None);
        remove_shared_chat_sheet_link(p(91), &chat_key)
            .expect("explicitly unlink before changing account members");
        assert_eq!(linked_sheet_for(p(91), &chat_key), None);
        assert_eq!(
            linked_sheet_for(p(92), &chat_key),
            Some(format!("{unrelated_sheet_id:016x}")),
            "explicit unlink must preserve the partner's newer conflicting account",
        );
        store_shared_chat_sheet_link(p(91), chat_key.clone(), second_id, None)
            .expect("link new account after explicit unlink");
        assert_eq!(linked_sheet_for(p(91), &chat_key), Some(second.id.clone()));
        assert_eq!(linked_sheet_for(p(93), &chat_key), Some(second.id.clone()));
        assert_eq!(
            linked_sheet_for(p(92), &chat_key),
            Some(format!("{unrelated_sheet_id:016x}"))
        );
        assert_eq!(linked_sheet_for(p(94), &chat_key), None);

        remove_shared_chat_sheet_link(p(91), &chat_key).expect("remove shared route");
        assert_eq!(linked_sheet_for(p(91), &chat_key), None);
        assert_eq!(linked_sheet_for(p(93), &chat_key), None);
        assert_eq!(
            linked_sheet_for(p(92), &chat_key),
            Some(format!("{unrelated_sheet_id:016x}")),
            "conditional removal must preserve the partner's newer conflicting account",
        );

        for principal in [p(91), p(92), p(93), p(94)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&principal, &chat_key));
            });
        }
        SHEETS.with(|sheets| {
            sheets.borrow_mut().remove(&first.id);
            sheets.borrow_mut().remove(&second.id);
        });
        clear_pending_chat_routes_for_principal(p(91));
    }

    #[test]
    fn shared_chat_route_rejects_target_partner_bound_to_another_shared_account_atomically() {
        let chat_key = base64url_no_pad(&[101; 32]);
        let mut target_ab = test_sheet(SheetState::Active);
        target_ab.id = "a1a1a1a1a1a1a1a1".into();
        target_ab.pair_id = "a1a1a1a1a1a1a100".into();
        target_ab.member_a = p(101);
        target_ab.member_b = p(102);
        let mut existing_bc = test_sheet(SheetState::Active);
        existing_bc.id = "b2b2b2b2b2b2b2b2".into();
        existing_bc.pair_id = "b2b2b2b2b2b2b200".into();
        existing_bc.member_a = p(102);
        existing_bc.member_b = p(103);
        let target_id = u64::from_str_radix(&target_ab.id, 16).unwrap();
        let existing_id = u64::from_str_radix(&existing_bc.id, 16).unwrap();
        SHEETS.with(|sheets| {
            sheets
                .borrow_mut()
                .insert(target_ab.id.clone(), target_ab.clone());
            sheets
                .borrow_mut()
                .insert(existing_bc.id.clone(), existing_bc.clone());
        });
        for principal in [p(101), p(102), p(103)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&principal, &chat_key));
            });
        }
        CHAT_SHEET_LINKS.with(|links| {
            let mut links = links.borrow_mut();
            for member in [p(102), p(103)] {
                links.insert(
                    chat_link_key(&member, &chat_key),
                    ChatSheetLink {
                        chat_key: chat_key.clone(),
                        sheet_id: existing_id,
                        chat_name: Some("Existing B-C".into()),
                    },
                );
            }
        });
        let snapshot = |principal: Principal| {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow()
                    .get(&chat_link_key(&principal, &chat_key))
                    .map(|link| (link.sheet_id, link.chat_key, link.chat_name))
            })
        };
        let before: Vec<_> = [p(101), p(102), p(103)]
            .into_iter()
            .map(&snapshot)
            .collect();

        assert!(store_shared_chat_sheet_link(
            p(101),
            chat_key.clone(),
            target_id,
            Some("Target A-B".into()),
        )
        .is_err());
        let after: Vec<_> = [p(101), p(102), p(103)]
            .into_iter()
            .map(&snapshot)
            .collect();
        assert_eq!(
            after, before,
            "conflicting account topology must not mutate any row"
        );

        for principal in [p(101), p(102), p(103)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&principal, &chat_key));
            });
        }
        SHEETS.with(|sheets| {
            sheets.borrow_mut().remove(&target_ab.id);
            sheets.borrow_mut().remove(&existing_bc.id);
        });
    }

    #[test]
    fn shared_chat_route_rejects_ab_to_ac_account_topology_change_atomically() {
        let chat_key = base64url_no_pad(&[121; 32]);
        let mut old_ab = test_sheet(SheetState::Active);
        old_ab.id = "e1e1e1e1e1e1e1e1".into();
        old_ab.pair_id = "e1e1e1e1e1e1e100".into();
        old_ab.member_a = p(121);
        old_ab.member_b = p(122);
        let mut target_ac = test_sheet(SheetState::Active);
        target_ac.id = "f2f2f2f2f2f2f2f2".into();
        target_ac.pair_id = "f2f2f2f2f2f2f200".into();
        target_ac.member_a = p(121);
        target_ac.member_b = p(123);
        let old_id = u64::from_str_radix(&old_ab.id, 16).unwrap();
        let target_id = u64::from_str_radix(&target_ac.id, 16).unwrap();
        SHEETS.with(|sheets| {
            sheets
                .borrow_mut()
                .insert(old_ab.id.clone(), old_ab.clone());
            sheets
                .borrow_mut()
                .insert(target_ac.id.clone(), target_ac.clone());
        });
        for member in [p(121), p(122), p(123)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&member, &chat_key));
            });
        }
        CHAT_SHEET_LINKS.with(|links| {
            let mut links = links.borrow_mut();
            for member in [p(121), p(122)] {
                links.insert(
                    chat_link_key(&member, &chat_key),
                    ChatSheetLink {
                        chat_key: chat_key.clone(),
                        sheet_id: old_id,
                        chat_name: Some("Old A-B".into()),
                    },
                );
            }
        });
        let snapshot = |principal: Principal| {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow()
                    .get(&chat_link_key(&principal, &chat_key))
                    .map(|link| (link.sheet_id, link.chat_key, link.chat_name))
            })
        };
        let before: Vec<_> = [p(121), p(122), p(123)]
            .into_iter()
            .map(&snapshot)
            .collect();
        let result = store_shared_chat_sheet_link(
            p(121),
            chat_key.clone(),
            target_id,
            Some("Target A-C".into()),
        );
        let after: Vec<_> = [p(121), p(122), p(123)]
            .into_iter()
            .map(&snapshot)
            .collect();

        for member in [p(121), p(122), p(123)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&member, &chat_key));
            });
        }
        SHEETS.with(|sheets| {
            sheets.borrow_mut().remove(&old_ab.id);
            sheets.borrow_mut().remove(&target_ac.id);
        });

        assert!(result.is_err());
        assert_eq!(
            after, before,
            "a caller must explicitly unlink before changing the account member topology"
        );
    }

    #[test]
    fn shared_chat_route_never_cleans_members_of_an_unreadable_prior_sheet() {
        let chat_key = base64url_no_pad(&[131; 32]);
        let mut unrelated_bc = test_sheet(SheetState::Active);
        unrelated_bc.id = "b3b3b3b3b3b3b3b3".into();
        unrelated_bc.pair_id = "b3b3b3b3b3b3b300".into();
        unrelated_bc.member_a = p(132);
        unrelated_bc.member_b = p(133);
        let mut target_ad = test_sheet(SheetState::Active);
        target_ad.id = "a4a4a4a4a4a4a4a4".into();
        target_ad.pair_id = "a4a4a4a4a4a4a400".into();
        target_ad.member_a = p(131);
        target_ad.member_b = p(134);
        let unrelated_id = u64::from_str_radix(&unrelated_bc.id, 16).unwrap();
        let target_id = u64::from_str_radix(&target_ad.id, 16).unwrap();
        SHEETS.with(|sheets| {
            sheets
                .borrow_mut()
                .insert(unrelated_bc.id.clone(), unrelated_bc.clone());
            sheets
                .borrow_mut()
                .insert(target_ad.id.clone(), target_ad.clone());
        });
        for member in [p(131), p(132), p(133), p(134)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&member, &chat_key));
            });
        }
        CHAT_SHEET_LINKS.with(|links| {
            let mut links = links.borrow_mut();
            for member in [p(131), p(132), p(133)] {
                links.insert(
                    chat_link_key(&member, &chat_key),
                    ChatSheetLink {
                        chat_key: chat_key.clone(),
                        sheet_id: unrelated_id,
                        chat_name: Some("Unrelated B-C".into()),
                    },
                );
            }
        });

        let result = store_shared_chat_sheet_link(
            p(131),
            chat_key.clone(),
            target_id,
            Some("Target A-D".into()),
        );
        let a = linked_sheet_for(p(131), &chat_key);
        let b = linked_sheet_for(p(132), &chat_key);
        let c = linked_sheet_for(p(133), &chat_key);
        let d = linked_sheet_for(p(134), &chat_key);

        for member in [p(131), p(132), p(133), p(134)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&member, &chat_key));
            });
        }
        SHEETS.with(|sheets| {
            sheets.borrow_mut().remove(&unrelated_bc.id);
            sheets.borrow_mut().remove(&target_ad.id);
        });

        assert!(result.is_err());
        assert_eq!(a, Some(unrelated_bc.id.clone()));
        assert_eq!(d, None);
        assert_eq!(b, Some(unrelated_bc.id.clone()));
        assert_eq!(c, Some(unrelated_bc.id));
    }

    #[test]
    fn shared_chat_route_allows_exact_ab_old_sheet_to_ab_new_sheet_reassignment() {
        let chat_key = base64url_no_pad(&[111; 32]);
        let mut old_ab = test_sheet(SheetState::Active);
        old_ab.id = "c1c1c1c1c1c1c1c1".into();
        old_ab.pair_id = "c1c1c1c1c1c1c100".into();
        old_ab.member_a = p(111);
        old_ab.member_b = p(112);
        let mut new_ab = test_sheet(SheetState::Active);
        new_ab.id = "d2d2d2d2d2d2d2d2".into();
        new_ab.pair_id = old_ab.pair_id.clone();
        new_ab.member_a = p(111);
        new_ab.member_b = p(112);
        let old_id = u64::from_str_radix(&old_ab.id, 16).unwrap();
        let new_id = u64::from_str_radix(&new_ab.id, 16).unwrap();
        SHEETS.with(|sheets| {
            sheets
                .borrow_mut()
                .insert(old_ab.id.clone(), old_ab.clone());
            sheets
                .borrow_mut()
                .insert(new_ab.id.clone(), new_ab.clone());
        });
        for member in [p(111), p(112)] {
            CHAT_SHEET_LINKS.with(|links| {
                links.borrow_mut().insert(
                    chat_link_key(&member, &chat_key),
                    ChatSheetLink {
                        chat_key: chat_key.clone(),
                        sheet_id: old_id,
                        chat_name: Some("A-B".into()),
                    },
                );
            });
        }

        store_shared_chat_sheet_link(p(111), chat_key.clone(), new_id, None)
            .expect("caller may atomically move the same A-B route to A-B's new sheet");
        for member in [p(111), p(112)] {
            assert_eq!(linked_sheet_for(member, &chat_key), Some(new_ab.id.clone()));
        }

        for member in [p(111), p(112)] {
            CHAT_SHEET_LINKS.with(|links| {
                links
                    .borrow_mut()
                    .remove(&chat_link_key(&member, &chat_key));
            });
        }
        SHEETS.with(|sheets| {
            sheets.borrow_mut().remove(&old_ab.id);
            sheets.borrow_mut().remove(&new_ab.id);
        });
    }

    fn test_confirmation_binding(payload: Vec<u8>) -> CardConfirmationAttestationBindingV1 {
        CardConfirmationAttestationBindingV1 {
            user_index_canister_id: p(1),
            app_canister_id: p(3),
            context: test_scoped_card_context(),
            content_hash: [9; 32],
            confirm_payload: payload,
            app_user_key_version: Some(4),
        }
    }

    #[test]
    fn initial_card_attestation_requires_exact_rows_payload_binding_and_link() {
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        let binding = test_card_attestation_binding();
        assert!(attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
        ));

        let mut changed = binding.clone();
        changed.commitment.content.rows[2].value = "Private rent type".into();
        assert!(!attests_exact_iou_card(
            &changed,
            Some(&configured),
            Some(&link),
            p(3),
            p(1)
        ));

        let mut changed = binding.clone();
        changed.commitment.content.rows.swap(0, 1);
        assert!(!attests_exact_iou_card(
            &changed,
            Some(&configured),
            Some(&link),
            p(3),
            p(1)
        ));

        let mut changed = binding.clone();
        changed.commitment.content.disclosure = Some("Redundant acknowledgement".into());
        assert!(!attests_exact_iou_card(
            &changed,
            Some(&configured),
            Some(&link),
            p(3),
            p(1)
        ));

        let mut changed = binding.clone();
        changed.commitment.context.context_version = 2;
        assert!(!attests_exact_iou_card(
            &changed,
            Some(&configured),
            Some(&link),
            p(3),
            p(1)
        ));

        assert!(!attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(9)
        ));
        assert!(!attests_exact_iou_card(
            &binding,
            Some(&configured),
            None,
            p(3),
            p(1)
        ));
        let mut wrong_link = link.clone();
        wrong_link.app_subject = Some(vec![11; 32]);
        assert!(!attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&wrong_link),
            p(3),
            p(1)
        ));
    }

    #[test]
    fn source_grounded_reservation_range_card_passes_exact_attestation() {
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        let mut binding = test_card_attestation_binding();
        binding.commitment.content.confirm_payload = Some(
            br#"{"amount":700,"kind":"iou","direction":"debt","message":"Reservation 1-20 August 700 USD","currency":"USD","date":"2026-08-01","note":"Reservation"}"#.to_vec(),
        );
        binding.commitment.content.rows = vec![
            AttestedActionCardRow {
                label: "Amount".into(),
                value: "700".into(),
            },
            AttestedActionCardRow {
                label: "Currency".into(),
                value: "USD".into(),
            },
            AttestedActionCardRow {
                label: "Type".into(),
                value: "iou".into(),
            },
            AttestedActionCardRow {
                label: "Direction".into(),
                value: "debt".into(),
            },
            AttestedActionCardRow {
                label: "Date".into(),
                value: "2026-08-01".into(),
            },
            AttestedActionCardRow {
                label: "Note".into(),
                value: "Reservation".into(),
            },
        ];

        assert!(attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
        ));
    }

    #[test]
    fn source_interval_evidence_is_initial_only_and_final_note_is_reviewed() {
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        let mut binding = test_card_attestation_binding();
        // The app-local output for the reported message shape, with a synthetic property label.
        // The public card does
        // not yet have a Note row: IOU's renderer adds the reviewed range from the paired evidence.
        let initial_payload = br#"{"amount":26400,"kind":"iou","direction":"debt","message":"Reservation Confirmed\nSynthetic property UNIT-A1\nAugust 6-10\n26,400 EGP","currency":"EGP","date":"2026-08-06","interval_start":"2026-08-06","interval_end":"2026-08-10"}"#.to_vec();
        binding.commitment.content.confirm_payload = Some(initial_payload.clone());
        binding.commitment.content.rows = [
            ("Amount", "26400"),
            ("Currency", "EGP"),
            ("Type", "iou"),
            ("Direction", "debt"),
            ("Date", "2026-08-06"),
        ]
        .into_iter()
        .map(|(label, value)| AttestedActionCardRow {
            label: label.into(),
            value: value.into(),
        })
        .collect();
        assert!(attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
        ));

        let final_payload = br#"{"amount":26400,"direction":"debt","note":"From 2026-08-06 to 2026-08-10","currency":"EGP","message":"Reservation Confirmed\nSynthetic property UNIT-A1\nAugust 6-10\n26,400 EGP","kind":"iou","date":"2026-08-06"}"#.to_vec();
        assert!(attests_exact_iou_card_confirmation(
            &test_confirmation_binding(final_payload),
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            false,
        ));
        // Raw intermediates must not be carried forward as reviewed entry fields.
        assert!(!attests_exact_iou_card_confirmation(
            &test_confirmation_binding(initial_payload),
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            false,
        ));
        // Adding interval evidence must not weaken exact displayed-row validation.
        binding.commitment.content.rows[4].value = "2026-07-04".into();
        assert!(!attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
        ));
    }

    #[test]
    fn app_local_candidates_built_by_openchat_pass_exact_card_attestation() {
        #[derive(Deserialize)]
        struct Fixture {
            name: String,
            content: AiAppCardContentV1,
        }
        // The TypeScript cross-boundary check runs the real IOU local processor followed by the
        // real generic OpenChat card builder and compares their exact bytes to this shared fixture.
        // Consuming those same bytes here prevents app/host tests from bypassing the strict Rust
        // payload visitor by substituting an older, hand-written subset of extraction fields.
        let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
            "features/openchat/fixtures/initial-card-content-v1.json"
        ))
        .unwrap();
        assert_eq!(fixtures.len(), 5);
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        for fixture in fixtures {
            let mut binding = test_card_attestation_binding();
            binding.commitment.content = fixture.content;
            assert!(
                attests_exact_iou_card(&binding, Some(&configured), Some(&link), p(3), p(1),),
                "app-produced card rejected: {}",
                fixture.name,
            );
        }
    }

    #[test]
    fn source_interval_evidence_rejects_malformed_unpaired_and_ambiguous_fields() {
        let payload = |start: serde_json::Value, end: serde_json::Value| {
            serde_json::to_vec(&serde_json::json!({
                "amount": 26400, "kind": "iou", "direction": "debt",
                "interval_start": start, "interval_end": end,
            }))
            .unwrap()
        };
        for invalid in [
            serde_json::json!(""),
            serde_json::json!("   "),
            serde_json::json!("x".repeat(97)),
            serde_json::json!("ع".repeat(97)),
            serde_json::json!(null),
            serde_json::json!(20260806),
            serde_json::json!(true),
            serde_json::json!([]),
            serde_json::json!({"date": "2026-08-06"}),
        ] {
            assert!(parse_attested_entry_drafts(
                &payload(invalid.clone(), serde_json::json!("2026-08-10")),
                false,
            )
            .is_none());
            assert!(parse_attested_entry_drafts(
                &payload(serde_json::json!("2026-08-06"), invalid),
                false,
            )
            .is_none());
        }
        for control in (0..=0x1f)
            .chain([0x7f])
            .chain(0x202a..=0x202e)
            .chain(0x2066..=0x2069)
        {
            let endpoint = format!("August{}6", char::from_u32(control).unwrap());
            assert!(parse_attested_entry_drafts(
                &payload(serde_json::json!(endpoint), serde_json::json!("August 10")),
                false,
            )
            .is_none());
        }
        for fields in [
            r#""interval_start":"2026-08-06""#,
            r#""interval_end":"2026-08-10""#,
            r#""interval_start":"2026-08-06","interval_end":"2026-08-10","interval_start":"2026-08-06""#,
            r#""interval_start":"2026-08-06","interval_end":"2026-08-10","interval_end":"2026-08-11""#,
            r#""interval_start":"2026-08-06","interval_end":"2026-08-10","unknown":"ignored?""#,
        ] {
            let invalid = format!(r#"{{"amount":26400,"kind":"iou","direction":"debt",{fields}}}"#);
            for final_confirmation in [false, true] {
                assert!(
                    parse_attested_entry_drafts(invalid.as_bytes(), final_confirmation).is_none()
                );
            }
        }
        for endpoint in ["Thursday, August 6, 2026".to_string(), "ع".repeat(96)] {
            let valid = payload(
                serde_json::json!(endpoint),
                serde_json::json!("Monday, August 10, 2026"),
            );
            assert!(parse_attested_entry_drafts(&valid, false).is_some());
            assert!(parse_attested_entry_drafts(&valid, true).is_none());
        }
    }

    #[test]
    fn multi_card_attestation_requires_labeled_manifest_order_summaries() {
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        let mut binding = test_card_attestation_binding();
        binding.commitment.content.title = "Add to IOU (2 entries)".into();
        binding.commitment.content.confirm_payload = Some(
            br#"[{"kind":"iou","amount":20,"currency":"USD","direction":"debt","date":"2026-08-08","note":"rent","message":"rent 20 USD"},{"kind":"settlement","amount":30,"currency":"EGP","direction":"credit","note":"paid","message":"paid 30 EGP"}]"#.to_vec(),
        );
        binding.commitment.content.rows = vec![
            AttestedActionCardRow {
                label: "Entry 1".into(),
                value: "Amount: 20 · Currency: USD · Type: iou · Direction: debt · Date: 2026-08-08 · Note: rent".into(),
            },
            AttestedActionCardRow {
                label: "Entry 2".into(),
                value: "Amount: 30 · Currency: EGP · Type: settlement · Direction: credit · Note: paid".into(),
            },
        ];
        assert!(attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
        ));

        binding.commitment.content.rows[0].value = "20 USD iou debt 2026-08-08 rent rent 20".into();
        assert!(!attests_exact_iou_card(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
        ));
    }

    #[test]
    fn legacy_card_rows_never_authorize_two_independent_token_claims() {
        let link = test_card_link();
        clear_pending_chat_routes_for_principal(link.iou_principal);
        let legacy_handle = base64url_no_pad(&[40; 32]);
        let legacy_id = pending_chat_route_id(&link.iou_principal, &legacy_handle);
        PENDING_CHAT_ROUTES.with(|routes| {
            routes.borrow_mut().insert(
                pending_chat_route_key(&link.iou_principal, &legacy_id),
                PendingChatRoute {
                    chat_key: legacy_handle,
                    last_seen: 10,
                    claim_version: None,
                    chat_name: None,
                },
            );
        });
        let first_handle = base64url_no_pad(&[41; 32]);
        let second_handle = base64url_no_pad(&[42; 32]);
        let first_id = pending_chat_route_id(&link.iou_principal, &first_handle);
        let second_id = pending_chat_route_id(&link.iou_principal, &second_handle);
        remember_claimed_chat_route(link.iou_principal, &first_handle, "Mother", 11);
        remember_claimed_chat_route(link.iou_principal, &second_handle, "Manager", 12);

        assert!(actionable_pending_chat_route(link.iou_principal, &legacy_id, 12).is_none());
        assert!(actionable_pending_chat_route(link.iou_principal, &first_id, 12).is_some());
        assert!(actionable_pending_chat_route(link.iou_principal, &second_id, 12).is_some());
        clear_pending_chat_routes_for_principal(link.iou_principal);
    }

    #[test]
    fn initial_card_payload_rejects_private_type_unknown_duplicate_and_malformed_fields() {
        for payload in [
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","template":"Rent"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","template_ref":"ioutr1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","account_type":"Rent"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","amount":26}"#.as_slice(),
            br#"{"amount":0,"kind":"iou","direction":"debt","message":"I owe 0 USD"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 usd","currency":"usd"}"#.as_slice(),
            br#"{"amount":25,"kind":"Rent","direction":"debt","message":"I owe 25 USD"}"#.as_slice(),
        ] {
            assert!(parse_attested_entry_drafts(payload, false).is_none());
        }
    }

    #[test]
    fn card_attester_requires_registered_ledger_semantics_and_validates_optional_source_evidence() {
        for payload in [
            br#"{"amount":25,"direction":"debt","message":"I owe 25 USD"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","message":"I owe 25 USD"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":""}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"bad\u0000evidence"}"#
                .as_slice(),
        ] {
            assert!(parse_attested_entry_drafts(payload, false).is_none());
        }
        assert!(parse_attested_entry_drafts(
            br#"{"amount":25,"kind":"iou","direction":"debt"}"#,
            false,
        )
        .is_some());
        assert!(parse_attested_entry_drafts(
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD"}"#,
            false,
        )
        .is_some());
        let overlong = format!(
            r#"{{"amount":25,"kind":"iou","direction":"debt","message":"{}"}}"#,
            "x".repeat(201)
        );
        assert!(parse_attested_entry_drafts(overlong.as_bytes(), false).is_none());
    }

    #[test]
    fn initial_attester_recomputes_registered_text_currency_evidence_but_preserves_image_and_edits()
    {
        for payload in [
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt","message":"paid 20"}"#.as_slice(),
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt","message":"paid 20 EGP"}"#.as_slice(),
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt","message":"paid crusade"}"#.as_slice(),
        ] {
            assert!(parse_attested_entry_drafts(payload, false).is_none());
        }
        for payload in [
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt","message":"paid 20 USD"}"#.as_slice(),
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt","message":"paid $20"}"#.as_slice(),
            br#"{"amount":20,"kind":"settlement","currency":"GBP","direction":"debt","message":"paid 20 pounds sterling"}"#.as_slice(),
            r#"{"amount":20,"kind":"settlement","currency":"EGP","direction":"debt","message":"paid E£20"}"#.as_bytes(),
            r#"{"amount":20,"kind":"settlement","currency":"EGP","direction":"debt","message":"paid 20 ج.م"}"#.as_bytes(),
            // No model-authored text echo is the registered image-only shape.
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt"}"#.as_slice(),
        ] {
            assert!(parse_attested_entry_drafts(payload, false).is_some());
        }
        let registered_aliases: [(&str, &[&str]); 6] = [
            (
                "USD",
                &["$", "dollar", "dollars", "US dollar", "US dollars"],
            ),
            ("GBP", &["£", "pound sterling", "pounds sterling"]),
            ("EUR", &["€", "euro", "euros"]),
            ("JPY", &["¥", "yen"]),
            ("INR", &["₹", "rupee", "rupees"]),
            ("EGP", &["E£", "Egyptian pound", "Egyptian pounds", "ج.م"]),
        ];
        for (currency, aliases) in registered_aliases {
            for alias in aliases {
                let payload = format!(
                    r#"{{"amount":20,"kind":"settlement","currency":"{currency}","direction":"debt","message":"paid 20 {alias}"}}"#,
                );
                assert!(
                    parse_attested_entry_drafts(payload.as_bytes(), false).is_some(),
                    "registered currency alias was rejected: {currency} / {alias}",
                );
            }
        }
        // Final confirmation is a user-reviewed payload; an edited currency must not be rejected
        // merely because the original source text named a different one.
        assert!(parse_attested_entry_drafts(
            br#"{"amount":20,"kind":"settlement","currency":"USD","direction":"debt","message":"paid 20 EGP"}"#,
            true,
        )
        .is_some());
    }

    #[test]
    fn app_attester_rejects_unsanitized_image_style_optional_fields() {
        for payload in [
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","currency":"$"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","currency":"$$$"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 egp","currency":"egp"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 EGP","currency":"\uFF25\uFF27\uFF30"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 on 08/07/2026","date":"08/07/2026"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","date":"0000-01-01"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","date":"2026-13-40"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","date":"2026-02-29"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","date":"2026-04-31"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","note":"receipt\u0000hidden"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"message\u0000hidden"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","note":"\uD800"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"\uDC00"}"#.as_slice(),
            br#"{"amount":0.0049,"kind":"iou","direction":"debt","message":"I owe 0.0049"}"#.as_slice(),
            br#"{"amount":90071992547410,"kind":"iou","direction":"debt","message":"I owe too much"}"#.as_slice(),
        ] {
            assert!(parse_attested_entry_drafts(payload, false).is_none());
        }

        let overlong_note = format!(
            r#"{{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25","note":"{}"}}"#,
            "n".repeat(4_097)
        );
        assert!(parse_attested_entry_drafts(overlong_note.as_bytes(), false).is_none());
        let overlong_message = format!(
            r#"{{"amount":25,"kind":"iou","direction":"debt","message":"{}"}}"#,
            "m".repeat(201)
        );
        assert!(parse_attested_entry_drafts(overlong_message.as_bytes(), false).is_none());

        // Optional malformed fields can be omitted, but the registered ledger semantics remain
        // mandatory at the app attestation boundary. Source text is optional for image-only input.
        assert!(parse_attested_entry_drafts(
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25"}"#,
            false
        )
        .is_some());
        assert!(parse_attested_entry_drafts(
            br#"{"amount":0.005,"kind":"iou","direction":"debt","message":"I owe 0.005"}"#,
            false
        )
        .is_some());
        assert!(
            parse_attested_entry_drafts(br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 on leap day","date":"2024-02-29"}"#, false).is_some()
        );
        assert!(parse_attested_entry_drafts(br#"{"amount":90071992547409.9,"kind":"iou","direction":"debt","message":"I owe the maximum"}"#, false).is_some());
    }

    #[test]
    fn final_confirmation_accepts_only_opaque_type_ref_and_current_exact_account() {
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        let encrypted_ref = format!("ioutr1.{}", "A".repeat(39));
        let payload = format!(
            "{{\"amount\":25,\"kind\":\"iou\",\"direction\":\"debt\",\"message\":\"I owe 25 USD\",\"template_ref\":\"{encrypted_ref}\"}}"
        )
        .into_bytes();
        let binding = test_confirmation_binding(payload);
        assert!(attests_exact_iou_card_confirmation(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            true,
        ));
        assert!(!attests_exact_iou_card_confirmation(
            &binding,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            false,
        ));

        let no_private_ref = test_confirmation_binding(
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD"}"#.to_vec(),
        );
        assert!(attests_exact_iou_card_confirmation(
            &no_private_ref,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            false,
        ));

        let mut stale_key = binding.clone();
        stale_key.app_user_key_version = Some(3);
        assert!(!attests_exact_iou_card_confirmation(
            &stale_key,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            true,
        ));

        let mut wrong_chat = binding.clone();
        wrong_chat.context.chat_handle = vec![11; 32];
        assert!(!attests_exact_iou_card_confirmation(
            &wrong_chat,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            false,
        ));

        let mut malformed = binding.clone();
        malformed.context.message_handle.pop();
        assert!(!attests_exact_iou_card_confirmation(
            &malformed,
            Some(&configured),
            Some(&link),
            p(3),
            p(1),
            true,
        ));
    }

    #[test]
    fn final_confirmation_rejects_plaintext_or_malformed_type_and_ambiguous_json() {
        let configured = test_ai_app_v2_binding();
        let link = test_card_link();
        for payload in [
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","template":"Rent"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","type":"Rent"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","account_type":"Rent"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","template_ref":"Rent"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","template_ref":"ioutr1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"}"#.as_slice(),
            br#"{"amount":25,"kind":"iou","direction":"debt","message":"I owe 25 USD","amount":26}"#.as_slice(),
            br#"{"amount":0.001,"kind":"iou","direction":"debt","message":"I owe 0.001 USD"}"#.as_slice(),
            br#"[]"#.as_slice(),
        ] {
            let binding = test_confirmation_binding(payload.to_vec());
            assert!(!attests_exact_iou_card_confirmation(
                &binding,
                Some(&configured),
                Some(&link),
                p(3),
                p(1),
                true,
            ));
        }
    }

    #[test]
    fn ai_app_v2_attestation_requires_exact_stored_binding_and_registry_caller() {
        let binding = test_ai_app_v2_binding();
        let accepted = verify_ai_app_v2(
            binding.clone(),
            Some(binding.clone()),
            Some(binding.owner),
            Some(binding.user_index_canister_id),
            binding.app_canister_id,
            binding.user_index_canister_id,
        );
        assert!(accepted.vouched);
        assert_eq!(accepted.binding, binding);

        let mut changed = binding.clone();
        changed.app_revision += 1;
        let stale = verify_ai_app_v2(
            changed,
            Some(binding.clone()),
            Some(binding.owner),
            Some(binding.user_index_canister_id),
            binding.app_canister_id,
            binding.user_index_canister_id,
        );
        assert!(!stale.vouched);
        assert_eq!(
            stale.binding, binding,
            "mismatches return the stored commitment"
        );

        assert!(
            !verify_ai_app_v2(
                binding.clone(),
                Some(binding.clone()),
                Some(binding.owner),
                Some(binding.user_index_canister_id),
                binding.app_canister_id,
                p(9),
            )
            .vouched
        );
        assert!(
            !verify_ai_app_v2(
                binding.clone(),
                None,
                Some(binding.owner),
                Some(binding.user_index_canister_id),
                binding.app_canister_id,
                binding.user_index_canister_id,
            )
            .vouched
        );
    }

    #[test]
    fn ai_app_v2_binding_rejects_every_trust_coordinate_and_malformed_hash() {
        let binding = test_ai_app_v2_binding();
        assert!(verification_binding_is_valid(
            &binding,
            Some(binding.owner),
            Some(binding.user_index_canister_id),
            binding.app_canister_id,
        ));

        let mut cases = Vec::new();
        let mut value = binding.clone();
        value.app_id = 0;
        cases.push(value);
        let mut value = binding.clone();
        value.app_revision = 0;
        cases.push(value);
        let mut value = binding.clone();
        value.canonical_name = "IOU".into();
        cases.push(value);
        let mut value = binding.clone();
        value.manifest_hash.pop();
        cases.push(value);
        let mut value = binding.clone();
        value.inbox_canister_id = Some(Principal::anonymous());
        cases.push(value);
        let mut value = binding.clone();
        value.app_canister_id = p(8);
        cases.push(value);

        for candidate in cases {
            assert!(!verification_binding_is_valid(
                &candidate,
                Some(binding.owner),
                Some(binding.user_index_canister_id),
                binding.app_canister_id,
            ));
        }
        assert!(!verification_binding_is_valid(
            &binding,
            Some(p(8)),
            Some(binding.user_index_canister_id),
            binding.app_canister_id,
        ));
        assert!(!verification_binding_is_valid(
            &binding,
            Some(binding.owner),
            Some(p(8)),
            binding.app_canister_id,
        ));
    }

    fn test_openchat_user_binding() -> OpenChatBinding {
        OpenChatBinding {
            iou_principal: p(20),
            user_index_canister_id: p(21),
            // OpenChat's app-id allocator starts at zero; zero is valid and
            // must stay covered by the disconnect contract.
            app_id: 0,
            app_revision: Some(44),
            app_canister_id: Some(p(22)),
            key_version: Some(3),
            app_subject: Some(vec![23; 32]),
            subject_version: Some(1),
            consumer_queue_selector: Some(vec![24; 32]),
            consumer_queue_selector_version: Some(1),
            consumer_public_key_pem: Some("key-a".into()),
            openchat_user_id: Principal::anonymous(),
            linked_at: 55,
        }
    }

    #[test]
    fn pending_route_binding_must_match_every_current_manifest_coordinate() {
        let configured = test_ai_app_v2_binding();
        let mut binding = test_openchat_user_binding();
        binding.user_index_canister_id = configured.user_index_canister_id;
        binding.app_id = configured.app_id;
        binding.app_revision = Some(configured.app_revision);
        binding.app_canister_id = Some(configured.app_canister_id);
        assert!(openchat_binding_matches_verification(&binding, &configured));

        let mut cases = Vec::new();
        let mut value = binding.clone();
        value.user_index_canister_id = p(91);
        cases.push(value);
        let mut value = binding.clone();
        value.app_id = binding.app_id.saturating_add(1);
        cases.push(value);
        let mut value = binding.clone();
        value.app_revision = Some(configured.app_revision.saturating_add(1));
        cases.push(value);
        let mut value = binding.clone();
        value.app_canister_id = Some(p(92));
        cases.push(value);
        for stale in cases {
            assert!(!openchat_binding_matches_verification(&stale, &configured));
        }
    }

    #[test]
    fn redemption_success_candid_matches_openchat_producer_golden() {
        let expected = RedeemAiAppChatLinkTokenSuccess {
            app_subject: vec![0x11; 32],
            subject_version: 1,
            app_user_key_version: 13,
            app_id: 7,
            app_revision: 11,
            app_canister_id: Principal::from_slice(&[0x2a]),
            chat_handle: vec![0x22; 32],
            chat_handle_version: 1,
            chat_name: Some("Manager".to_string()),
        };
        let encoded =
            candid::encode_one(RedeemAiAppChatLinkTokenResponse::Success(expected.clone()))
                .unwrap();
        let encoded_hex = encoded
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            encoded_hex,
            "4449444c056b08a8f7dc3201a888d28c037ffacbddf2037fee82c1ea077fa39bfdac0803cca39e90097fcf82d6ba097fb8bafce40a716c02007a01026e716c09a2e5ea2a78c59cb79e057af9bcce970878f99fbdfe0879cec1e58d0a048892b4880c7ad5f4e3bd0d68d2c0c9f70e02ef82b5980f046d7b0100040d0000000000000001000b0000000000000007000000201111111111111111111111111111111111111111111111111111111111111111010001012a01074d616e61676572202222222222222222222222222222222222222222222222222222222222222222"
        );
        let decoded: RedeemAiAppChatLinkTokenResponse = candid::decode_one(&encoded).unwrap();
        match decoded {
            RedeemAiAppChatLinkTokenResponse::Success(value) => {
                assert_eq!(value, expected);
            }
            _ => panic!("golden response must decode as Success"),
        }
    }

    #[test]
    fn redeemed_chat_link_requires_exact_subject_app_revision_and_v1_handle() {
        let binding = test_card_link();
        let grant = RedeemAiAppChatLinkTokenSuccess {
            app_subject: binding.app_subject.clone().unwrap(),
            subject_version: binding.subject_version.unwrap(),
            app_user_key_version: binding.key_version.unwrap(),
            app_id: binding.app_id,
            app_revision: binding.app_revision.unwrap(),
            app_canister_id: binding.app_canister_id.unwrap(),
            chat_handle: vec![41; 32],
            chat_handle_version: 1,
            chat_name: Some("Manager".to_string()),
        };
        assert_eq!(
            redeemed_chat_link_handle(&grant, &binding, binding.app_canister_id.unwrap()),
            Some(base64url_no_pad(&[41; 32])),
        );

        let mut cases = Vec::new();
        let mut value = grant.clone();
        value.app_subject[0] ^= 1;
        cases.push(value);
        let mut value = grant.clone();
        value.subject_version += 1;
        cases.push(value);
        let mut value = grant.clone();
        value.app_user_key_version += 1;
        cases.push(value);
        let mut value = grant.clone();
        value.app_id += 1;
        cases.push(value);
        let mut value = grant.clone();
        value.app_revision += 1;
        cases.push(value);
        let mut value = grant.clone();
        value.app_canister_id = p(91);
        cases.push(value);
        let mut value = grant.clone();
        value.chat_handle.pop();
        cases.push(value);
        let mut value = grant.clone();
        value.chat_handle_version += 1;
        cases.push(value);
        for mismatched in cases {
            assert_eq!(
                redeemed_chat_link_handle(&mismatched, &binding, binding.app_canister_id.unwrap(),),
                None,
            );
        }
    }

    #[test]
    fn openchat_disconnect_requires_every_authoritative_scoped_binding_coordinate() {
        let binding = test_openchat_user_binding();
        assert!(disconnect_binding_is_valid(
            &binding,
            binding.iou_principal,
            Some(binding.user_index_canister_id),
            binding.app_canister_id.unwrap(),
        ));

        let mut cases = Vec::new();
        let mut value = binding.clone();
        value.user_index_canister_id = Principal::anonymous();
        cases.push(value);
        let mut value = binding.clone();
        value.app_revision = None;
        cases.push(value);
        let mut value = binding.clone();
        value.app_revision = Some(0);
        cases.push(value);
        let mut value = binding.clone();
        value.app_canister_id = None;
        cases.push(value);
        let mut value = binding.clone();
        value.key_version = None;
        cases.push(value);
        let mut value = binding.clone();
        value.key_version = Some(0);
        cases.push(value);
        let mut value = binding.clone();
        value.app_subject = None;
        cases.push(value);
        let mut value = binding.clone();
        value.app_subject = Some(vec![1; 31]);
        cases.push(value);
        let mut value = binding.clone();
        value.subject_version = None;
        cases.push(value);
        let mut value = binding.clone();
        value.subject_version = Some(2);
        cases.push(value);

        for candidate in cases {
            assert!(!disconnect_binding_is_valid(
                &candidate,
                binding.iou_principal,
                Some(binding.user_index_canister_id),
                binding.app_canister_id.unwrap(),
            ));
        }
        assert!(!disconnect_binding_is_valid(
            &binding,
            p(24),
            Some(binding.user_index_canister_id),
            binding.app_canister_id.unwrap(),
        ));
        assert!(!disconnect_binding_is_valid(
            &binding,
            binding.iou_principal,
            Some(p(24)),
            binding.app_canister_id.unwrap(),
        ));
        assert!(!disconnect_binding_is_valid(
            &binding,
            binding.iou_principal,
            Some(binding.user_index_canister_id),
            p(24),
        ));
    }

    #[test]
    fn normal_disconnect_removes_binding_only_for_clean_remote_outcomes_but_emergency_erase_is_explicit(
    ) {
        assert!(binding_removal_is_allowed(
            OpenChatBindingRemovalCause::CoordinatedRevoke(&RevokeAiAppUserKeyResponse::Success,),
        ));
        assert!(binding_removal_is_allowed(
            OpenChatBindingRemovalCause::CoordinatedRevoke(
                &RevokeAiAppUserKeyResponse::KeyNotFound,
            ),
        ));
        assert!(!binding_removal_is_allowed(
            OpenChatBindingRemovalCause::CoordinatedRevoke(&RevokeAiAppUserKeyResponse::Error((
                503,
                Some("unavailable".into())
            )),),
        ));
        assert!(binding_removal_is_allowed(
            OpenChatBindingRemovalCause::EmergencyLocalErase,
        ));
    }

    #[test]
    fn archived_sheet_keys_remain_available_only_to_recorded_members() {
        let active = test_sheet(SheetState::Active);
        assert!(principal_can_read_sheet(&active, p(1)));
        assert!(principal_can_read_sheet(&active, p(2)));
        assert!(!principal_can_read_sheet(&active, p(3)));
        assert!(!principal_can_read_sheet(&active, Principal::anonymous()));

        let mut closed = test_sheet(SheetState::Closed);
        assert!(principal_can_read_sheet(&closed, p(1)));
        assert!(principal_can_read_sheet(&closed, p(2)));
        assert!(!principal_can_read_sheet(&closed, p(3)));

        // Revocation/member replacement updates the recorded slots, so a former member stays out.
        closed.member_b = p(9);
        assert!(!principal_can_read_sheet(&closed, p(2)));
        assert!(principal_can_read_sheet(&closed, p(9)));
    }

    #[test]
    fn encrypted_closing_balance_envelope_survives_stable_round_trip() {
        let mut sheet = test_sheet(SheetState::Closed);
        sheet.closed_at = Some(2);
        sheet.closing_balances_key = Some(vec![7; 32]);
        sheet.closing_balances_enc = Some(vec![8; 64]);
        sheet.closing_balances_iv = Some(vec![9; 12]);

        let round = Sheet::from_bytes(sheet.to_bytes());
        assert_eq!(round.closing_balances_key, Some(vec![7; 32]));
        assert_eq!(round.closing_balances_enc, Some(vec![8; 64]));
        assert_eq!(round.closing_balances_iv, Some(vec![9; 12]));
    }

    #[test]
    fn entry_blob_validation_covers_tag_size_upper_bound_and_nonce_shape() {
        let key = vec![0u8; 32];
        assert!(validate_entry_blob(&key, &[0u8; 16], &[0u8; 12]).is_ok());
        assert!(
            validate_entry_blob(&key, &vec![0u8; MAX_ENTRY_CIPHERTEXT_BYTES], &[0u8; 16]).is_ok()
        );
        assert!(validate_entry_blob(&key[..31], &[0u8; 16], &[0u8; 12]).is_err());
        assert!(validate_entry_blob(&key, &[0u8; 15], &[0u8; 12]).is_err());
        assert!(
            validate_entry_blob(&key, &vec![0u8; MAX_ENTRY_CIPHERTEXT_BYTES + 1], &[0u8; 12],)
                .is_err()
        );
        assert!(validate_entry_blob(&key, &[0u8; 16], &[0u8; 11]).is_err());
        assert!(validate_entry_blob(&key, &[0u8; 16], &[0u8; 17]).is_err());
    }

    #[test]
    fn wrapped_keys_and_optional_names_are_bounded_and_well_formed() {
        assert!(validate_wrapped_key(&[1], false).is_ok());
        assert!(validate_wrapped_key(&[], true).is_ok());
        assert!(validate_wrapped_key(&[], false).is_err());
        assert!(validate_wrapped_key(&vec![0; MAX_WRAPPED_KEY_BYTES + 1], true).is_err());

        assert!(validate_optional_name(&None, &None).is_ok());
        assert!(validate_optional_name(&Some(vec![1]), &Some(vec![0; 12])).is_ok());
        assert!(validate_optional_name(&Some(vec![1]), &None).is_err());
        assert!(validate_optional_name(&None, &Some(vec![0; 12])).is_err());
        assert!(validate_optional_name(&Some(vec![0; 1_025]), &Some(vec![0; 12])).is_err());
    }

    #[test]
    fn composite_entry_range_excludes_other_sheets_and_honors_cursor_ceiling() {
        let mut rows = std::collections::BTreeMap::new();
        for id in 1..=4 {
            rows.insert(entry_key("sheet-a", id), id);
            rows.insert(entry_key("sheet-aa", id), 100 + id);
            rows.insert(entry_key("sheet-b", id), 200 + id);
        }
        let (start, end) = entry_key_bounds("sheet-a", 3);
        let ids: Vec<u64> = rows.range(start..=end).rev().map(|(_, id)| *id).collect();
        assert_eq!(ids, vec![3, 2, 1]);
    }

    #[test]
    fn chat_link_range_excludes_other_principals_and_keeps_control_suffixes() {
        let a = p(1);
        let b = p(2);
        let mut rows = std::collections::BTreeMap::new();
        rows.insert(chat_link_key(&a, "group:one"), 1);
        rows.insert(chat_link_key(&a, "\u{1}control"), 2);
        rows.insert(chat_link_key(&b, "group:one"), 3);
        let (start, end) = chat_link_bounds(&a);
        let values: Vec<u8> = rows.range(start..end).map(|(_, value)| *value).collect();
        assert_eq!(values, vec![2, 1]);
    }

    #[test]
    fn stored_entry_byte_accounting_includes_every_history_version() {
        let entry = Entry {
            id: 1,
            pair_id: "pair".into(),
            sheet_id: "sheet".into(),
            created_by: p(1),
            created_at_server: 1,
            updated_at_server: Some(2),
            entry_key: vec![0; 32],
            ciphertext: vec![0; 16],
            iv: vec![0; 12],
            history: Some(vec![
                EntryVersion {
                    entry_key: vec![0; 32],
                    ciphertext: vec![0; 20],
                    iv: vec![0; 12],
                    replaced_at: 1,
                },
                EntryVersion {
                    entry_key: vec![0; 32],
                    ciphertext: vec![0; 24],
                    iv: vec![0; 16],
                    replaced_at: 2,
                },
            ]),
            deleted_at: None,
        };
        assert_eq!(stored_entry_bytes(&entry), 60 + 64 + 72);
    }

    #[test]
    fn legacy_global_scan_guard_allows_the_limit_and_rejects_the_next_record() {
        let mut scanned = 0usize;
        for _ in 0..MAX_LEGACY_GLOBAL_SCAN_RECORDS {
            assert!(checked_legacy_scan_increment(&mut scanned).is_ok());
        }
        assert_eq!(scanned, MAX_LEGACY_GLOBAL_SCAN_RECORDS);
        assert!(checked_legacy_scan_increment(&mut scanned).is_err());
    }

    #[test]
    fn schema_version_covers_owner_binding_and_sheet_usage_counter() {
        const {
            assert!(
                SCHEMA_VERSION >= 11,
                "schema must record owner binding, usage counters, and encrypted closing balances"
            )
        };
    }

    #[test]
    fn consumer_key_epoch_rejects_stale_two_device_write() {
        let observed_by_both = 0;
        let committed_by_device_a = next_consumer_key_epoch(observed_by_both, observed_by_both)
            .expect("device A wins the compare-and-swap");
        assert_eq!(committed_by_device_a, 1);
        assert_eq!(
            next_consumer_key_epoch(committed_by_device_a, observed_by_both),
            Err(ConsumerKeyMutationError::StaleEpoch(
                ConsumerKeyEpochConflict {
                    expected_epoch: 0,
                    current_epoch: 1,
                }
            ))
        );
    }

    #[test]
    fn active_openchat_binding_allows_only_exact_consumer_key_rewrap() {
        assert!(consumer_key_update_preserves_binding(
            false, None, None, "key-a"
        ));
        assert!(consumer_key_update_preserves_binding(
            false,
            None,
            Some("key-a"),
            "key-b"
        ));
        assert!(consumer_key_update_preserves_binding(
            true,
            Some("key-a"),
            Some("key-a"),
            "key-a"
        ));
        assert!(!consumer_key_update_preserves_binding(
            true,
            Some("key-a"),
            Some("key-a"),
            "key-b"
        ));
        assert!(!consumer_key_update_preserves_binding(
            true,
            Some("key-a"),
            Some("key-b"),
            "key-b"
        ));
        assert!(!consumer_key_update_preserves_binding(
            true,
            None,
            Some("key-a"),
            "key-a"
        ));
    }

    #[test]
    fn openchat_connect_snapshot_rejects_missing_replaced_or_rewrapped_key() {
        assert!(consumer_key_snapshot_matches(7, "key-a", 7, Some("key-a")));
        assert!(!consumer_key_snapshot_matches(7, "key-a", 7, None));
        assert!(!consumer_key_snapshot_matches(7, "key-a", 7, Some("key-b")));
        assert!(!consumer_key_snapshot_matches(7, "key-a", 8, Some("key-a")));
    }

    #[test]
    fn openchat_binding_authorization_requires_persisted_matching_key() {
        assert!(openchat_binding_key_matches(Some("key-a"), Some("key-a")));
        assert!(!openchat_binding_key_matches(None, Some("key-a")));
        assert!(!openchat_binding_key_matches(Some("key-a"), Some("key-b")));
        assert!(!openchat_binding_key_matches(Some("key-a"), None));
    }

    #[test]
    fn consumer_key_epoch_tombstone_prevents_delete_reordering_and_aba() {
        let set_epoch = next_consumer_key_epoch(0, 0).expect("initial set");
        let tombstone_epoch = next_consumer_key_epoch(set_epoch, set_epoch).expect("delete");
        assert_eq!(tombstone_epoch, 2);
        assert!(matches!(
            next_consumer_key_epoch(tombstone_epoch, set_epoch),
            Err(ConsumerKeyMutationError::StaleEpoch(_))
        ));

        let reconnect_epoch = next_consumer_key_epoch(tombstone_epoch, tombstone_epoch)
            .expect("explicit reconnect with the tombstone epoch");
        assert_eq!(reconnect_epoch, 3);
        assert!(matches!(
            next_consumer_key_epoch(reconnect_epoch, set_epoch),
            Err(ConsumerKeyMutationError::StaleEpoch(
                ConsumerKeyEpochConflict {
                    expected_epoch: 1,
                    current_epoch: 3,
                }
            ))
        ));
    }

    #[test]
    fn consumer_key_epoch_tombstone_survives_stable_map_reopen() {
        let key_memory = VectorMemory::default();
        let epoch_memory = VectorMemory::default();
        let principal = p(42);
        {
            let mut keypairs =
                StableBTreeMap::<Principal, ConsumerKeypair, _>::init(key_memory.clone());
            keypairs.insert(
                principal,
                ConsumerKeypair {
                    wrapped_private_key: vec![1, 2, 3],
                    public_key_pem: "-----BEGIN PUBLIC KEY-----".into(),
                },
            );
            keypairs.remove(&principal);
            let mut epochs = StableBTreeMap::<Principal, u64, _>::init(epoch_memory.clone());
            epochs.insert(principal, 9);
        }
        let keypairs = StableBTreeMap::<Principal, ConsumerKeypair, _>::init(key_memory);
        let epochs = StableBTreeMap::<Principal, u64, _>::init(epoch_memory);
        assert!(keypairs.get(&principal).is_none());
        assert_eq!(epochs.get(&principal), Some(9));
    }

    #[test]
    fn consumer_key_epoch_never_wraps() {
        assert_eq!(
            next_consumer_key_epoch(u64::MAX, u64::MAX),
            Err(ConsumerKeyMutationError::EpochExhausted)
        );
    }

    #[test]
    fn schema_version_and_fresh_memory_cover_consumer_key_tombstones() {
        const {
            assert!(
                SCHEMA_VERSION >= 12,
                "schema must record MemoryId 25 consumer-key mutation tombstones"
            )
        };
    }

    #[test]
    fn consumer_key_candid_matches_frontend_epoch_variants() {
        // Bytes emitted by @dfinity/candid for the declarations.ts IDL. This
        // guards Rust enum labels/record hashes as well as the handwritten DID.
        let ok_wire = [
            68, 73, 68, 76, 3, 108, 2, 131, 195, 145, 228, 1, 120, 130, 218, 202, 218, 4, 120, 107,
            2, 160, 204, 247, 171, 7, 127, 144, 239, 134, 222, 8, 0, 107, 2, 188, 138, 1, 120, 197,
            254, 210, 1, 1, 1, 2, 0, 7, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert!(matches!(
            Decode!(&ok_wire, ConsumerKeyMutationResult).expect("decode frontend Ok"),
            ConsumerKeyMutationResult::Ok(7)
        ));

        let stale_wire = [
            68, 73, 68, 76, 3, 108, 2, 131, 195, 145, 228, 1, 120, 130, 218, 202, 218, 4, 120, 107,
            2, 160, 204, 247, 171, 7, 127, 144, 239, 134, 222, 8, 0, 107, 2, 188, 138, 1, 120, 197,
            254, 210, 1, 1, 1, 2, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert!(matches!(
            Decode!(&stale_wire, ConsumerKeyMutationResult).expect("decode frontend StaleEpoch"),
            ConsumerKeyMutationResult::Err(ConsumerKeyMutationError::StaleEpoch(
                ConsumerKeyEpochConflict {
                    expected_epoch: 1,
                    current_epoch: 2,
                }
            ))
        ));

        let tombstone_wire = [
            68, 73, 68, 76, 4, 109, 123, 108, 2, 233, 159, 216, 232, 5, 0, 162, 148, 172, 253, 14,
            113, 110, 1, 108, 2, 243, 200, 133, 155, 2, 120, 185, 194, 200, 202, 11, 2, 1, 3, 2, 0,
            0, 0, 0, 0, 0, 0, 0,
        ];
        let state = Decode!(&tombstone_wire, ConsumerKeypairState)
            .expect("decode frontend tombstone state");
        assert_eq!(state.mutation_epoch, 2);
        assert!(state.keypair.is_none());
    }

    #[test]
    fn chat_route_claim_candid_matches_frontend_variant_and_pending_record() {
        // Emitted by @dfinity/candid from declarations.ts for { WrongAccount = null }. The
        // variant's type table also contains Success { pending_id : text }, so this one golden
        // locks every public result label and payload type across the Rust/TypeScript boundary.
        let wrong_account_wire = [
            68, 73, 68, 76, 2, 108, 1, 131, 212, 177, 142, 12, 113, 107, 9, 194, 166, 149, 19, 127,
            172, 192, 130, 91, 127, 160, 214, 216, 136, 3, 127, 162, 137, 205, 140, 8, 127, 207,
            136, 216, 155, 8, 127, 163, 155, 253, 172, 8, 0, 145, 165, 252, 241, 10, 127, 174, 146,
            159, 186, 14, 127, 247, 227, 162, 207, 15, 127, 1, 1, 2,
        ];
        assert!(matches!(
            Decode!(&wrong_account_wire, ClaimOpenChatChatRouteResult)
                .expect("decode frontend WrongAccount"),
            ClaimOpenChatChatRouteResult::WrongAccount,
        ));
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
        assert!(check_templates_blob(&[1], &[0u8; 11]).is_err());
        assert!(check_templates_blob(&[1], &[0u8; 12]).is_ok());
        assert!(check_templates_blob(&[1], &[0u8; 16]).is_ok());
        assert!(check_templates_blob(&[1], &[0u8; 17]).is_err());
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
    fn config_decodes_minimal_legacy_records() {
        // Every current trust field remains optional, so the original Config CELL still decodes.
        #[derive(CandidType, Deserialize)]
        struct OldConfig {
            creator_principal: Principal,
            deployed_at: u64,
        }
        let old = OldConfig {
            creator_principal: p(1),
            deployed_at: 99,
        };
        let bytes = Encode!(&old).expect("encode old config");
        let new = Config::from_bytes(std::borrow::Cow::Owned(bytes));
        assert_eq!(new.creator_principal, p(1));
        assert_eq!(new.deployed_at, 99);
        assert_eq!(new.ai_app_owner, None);
        assert_eq!(new.openchat_user_index_canister_id, None);
        assert_eq!(new.ai_app_verification_binding, None);
    }

    #[test]
    fn config_ignores_the_removed_deployment_card_currency() {
        // Stable Candid records are width-subtyped: an old cell may carry the retired global
        // card_currency field, while the new Config decodes and preserves every remaining field.
        #[derive(CandidType, Deserialize)]
        struct OldConfigWithCardCurrency {
            creator_principal: Principal,
            deployed_at: u64,
            card_currency: Option<String>,
            ai_app_owner: Option<Principal>,
            openchat_user_index_canister_id: Option<Principal>,
            ai_app_verification_binding: Option<AiAppVerificationBinding>,
        }
        let old = OldConfigWithCardCurrency {
            creator_principal: p(2),
            deployed_at: 7,
            card_currency: Some("EGP".into()),
            ai_app_owner: Some(p(3)),
            openchat_user_index_canister_id: Some(p(4)),
            ai_app_verification_binding: None,
        };
        let back = Config::from_bytes(Cow::Owned(Encode!(&old).expect("encode old config")));
        assert_eq!(back.ai_app_owner, Some(p(3)));
        assert_eq!(back.openchat_user_index_canister_id, Some(p(4)));
        assert_eq!(back.ai_app_verification_binding, None);
        assert_eq!(back.creator_principal, p(2));
        assert_eq!(back.deployed_at, 7);
    }

    #[test]
    fn viewer_default_currency_is_normalized_with_one_product_fallback() {
        assert_eq!(effective_default_currency(Some(" egp ")), "EGP");
        assert_eq!(effective_default_currency(Some("EUR")), "EUR");
        assert_eq!(effective_default_currency(None), "USD");
        assert_eq!(effective_default_currency(Some("EGYPT")), "USD");
    }

    #[test]
    fn openchat_binding_decodes_pre_v2_links_but_leaves_them_unversioned() {
        #[derive(CandidType, Deserialize)]
        struct OldOpenChatBinding {
            iou_principal: Principal,
            user_index_canister_id: Principal,
            app_id: u32,
            openchat_user_id: Principal,
            linked_at: u64,
        }
        let old = OldOpenChatBinding {
            iou_principal: p(1),
            user_index_canister_id: p(2),
            app_id: 7,
            openchat_user_id: p(3),
            linked_at: 9,
        };
        let decoded = OpenChatBinding::from_bytes(Cow::Owned(Encode!(&old).unwrap()));
        assert_eq!(decoded.app_id, 7);
        assert_eq!(decoded.app_revision, None);
        assert_eq!(decoded.app_canister_id, None);
        assert_eq!(decoded.key_version, None);
        assert_eq!(decoded.app_subject, None);
        assert_eq!(decoded.subject_version, None);
        assert_eq!(decoded.consumer_public_key_pem, None);
        assert!(public_openchat_binding(&decoded).is_none());
    }

    #[test]
    fn openchat_binding_decodes_pre_key_pin_v2_links_as_unverified() {
        #[derive(CandidType, Deserialize)]
        struct PreKeyPinOpenChatBinding {
            iou_principal: Principal,
            user_index_canister_id: Principal,
            app_id: u32,
            app_revision: Option<u64>,
            app_canister_id: Option<Principal>,
            key_version: Option<u64>,
            app_subject: Option<Vec<u8>>,
            subject_version: Option<u16>,
            consumer_queue_selector: Option<Vec<u8>>,
            consumer_queue_selector_version: Option<u16>,
            openchat_user_id: Principal,
            linked_at: u64,
        }
        let old = PreKeyPinOpenChatBinding {
            iou_principal: p(1),
            user_index_canister_id: p(2),
            app_id: 7,
            app_revision: Some(8),
            app_canister_id: Some(p(4)),
            key_version: Some(9),
            app_subject: Some(vec![5; 32]),
            subject_version: Some(1),
            consumer_queue_selector: Some(vec![6; 32]),
            consumer_queue_selector_version: Some(1),
            openchat_user_id: Principal::anonymous(),
            linked_at: 10,
        };
        let decoded = OpenChatBinding::from_bytes(Cow::Owned(Encode!(&old).unwrap()));
        assert!(public_openchat_binding(&decoded).is_some());
        assert_eq!(decoded.consumer_public_key_pem, None);
        assert!(!openchat_binding_key_matches(
            decoded.consumer_public_key_pem.as_deref(),
            Some("key-a"),
        ));
    }

    #[test]
    fn schema_version_records_scoped_openchat_links() {
        const {
            assert!(
                SCHEMA_VERSION >= 15,
                "app-scoped OpenChat links require schema v15"
            )
        };
    }

    #[test]
    fn schema_version_records_openchat_binding_consumer_key_pin() {
        const {
            assert!(
                SCHEMA_VERSION >= 16,
                "consumer-key-pinned OpenChat links require schema v16"
            )
        };
    }

    #[test]
    fn schema_version_records_pending_chat_route_memory() {
        const {
            assert!(
                SCHEMA_VERSION >= 17,
                "MemoryId 28 pending chat routes require schema v17"
            )
        };
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
        enum LegacyDirection {
            Credit,
            Debt,
        }
        #[derive(CandidType, Deserialize)]
        struct LegacyClosingBalance {
            currency: String,
            amount_minor: u64,
            direction: LegacyDirection,
        }
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
            closing_balances: Option<Vec<LegacyClosingBalance>>,
            name_enc: Option<Vec<u8>>,
            name_iv: Option<Vec<u8>>,
        }
        let old = OldSheet {
            id: "c819f76d77f260b3".into(),
            pair_id: "pair-1".into(),
            state: SheetState::Closed,
            enabled_currencies: vec!["USD".into(), "EGP".into()],
            closing_window_days: 365,
            last_entry_at: Some(11),
            wrapped_key_a: vec![1, 2, 3],
            wrapped_key_b: vec![4, 5, 6],
            member_a: p(1),
            member_b: p(2),
            created_at: 42,
            closed_at: Some(43),
            closing_balances: Some(vec![LegacyClosingBalance {
                currency: "USD".into(),
                amount_minor: 12_345,
                direction: LegacyDirection::Credit,
            }]),
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
        assert_eq!(new.closing_balances_key, None);
        assert_eq!(new.closing_balances_enc, None);
        assert_eq!(new.closing_balances_iv, None);
        // And a fresh sheet still round-trips (no currency field to carry).
        let rewritten = new.to_bytes();
        assert!(
            !rewritten.as_ref().windows(3).any(|window| window == b"USD"),
            "rewriting a legacy sheet must drop the old plaintext balance"
        );
        let round = Sheet::from_bytes(rewritten);
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
