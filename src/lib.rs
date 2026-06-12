// IOU backend canister - Phase 1 skeleton.
// Full spec: docs/01-specification.md

use candid::{CandidType, Deserialize, Principal};

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

thread_local! {
    static USERS: std::cell::RefCell<std::collections::BTreeMap<Principal, UserRecord>> =
        std::cell::RefCell::new(std::collections::BTreeMap::new());
    static CONFIG: std::cell::RefCell<Config> = std::cell::RefCell::new(Config {
        creator_principal: Principal::anonymous(),  // sentinel: "unset"
        deployed_at: 0,
    });
}

fn require_authed() {
    if ic_cdk::caller() == Principal::anonymous() {
        ic_cdk::trap("anonymous call rejected");
    }
}

// -------- public endpoints --------

#[ic_cdk::query]
fn whoami() -> Option<String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        None
    } else {
        Some(caller.to_text())
    }
}

#[ic_cdk::query]
fn get_my_user() -> Option<UserRecord> {
    USERS.with(|u| u.borrow().get(&ic_cdk::caller()).cloned())
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
        user_principal: ic_cdk::caller(),
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
    let caller = ic_cdk::caller();
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
