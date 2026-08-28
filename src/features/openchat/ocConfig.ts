// Shared OpenChat user_index connection config. The OpenChat user_index lives on a DIFFERENT replica
// than IOU's own backend — never reuse IOU's agent/host for it. Both the "Link to OpenChat" button
// (ActionInboxSettings) and the auto re-register on a template change (TemplatesContext) import these,
// so they always target the SAME replica (avoids VITE_OC_IC_URL vs VITE_OPENCHAT_HOST env drift).

import { DEV_LAN_QC_IC_ORIGIN } from "../../config/devLanQcRuntime";

export const OC_IC_URL =
  DEV_LAN_QC_IC_ORIGIN ??
  (import.meta.env.VITE_OC_IC_URL as string | undefined) ??
  "http://127.0.0.1:8080";

export const OC_USER_INDEX_CANISTER_ID = (
  import.meta.env.VITE_OC_USER_INDEX_CANISTER_ID as string | undefined
)?.trim();

// IOU's own action_inbox canister — the per-app inbox override registered in the manifest so
// OpenChat routes IOU's confirmed-action deposits HERE (not its global inbox). This MUST be sent on
// every register_ai_app: register_ai_app is an upsert, so re-registering without it silently drops
// the inbox override, and subsequent confirms fail deposit with `NotConfigured` (nothing reaches
// IOU). Mirrors the Node CLI's OC_ACTION_INBOX_CANISTER_ID and IOU's VITE_ACTION_INBOX_CANISTER_ID
// poller fallback (actionInboxClient), so registry and poller agree on the same canister.
export const OC_ACTION_INBOX_CANISTER_ID = (
  import.meta.env.VITE_ACTION_INBOX_CANISTER_ID as string | undefined
)?.trim();

// Written (value = the linked principal text) on a successful "Link to OpenChat". The auto
// re-register on a template change only fires when this matches the current identity — so a template
// edit re-registers ONLY for the user who actually linked, never hijacking the global "iou" entry.
export const OC_LINKED_KEY = "iou.openchat.linked.v1";

// Written (value = the connected principal text) after IOU's signed-in backend successfully performs
// c2c_claim_ai_app_link_code as the registered app canister. This is the OTHER way a user participates:
// people commonly Connect but never tap the separate "Link to OpenChat", so static manifest refresh
// must also recognize this principal. Private account templates are never part of that refresh.
export const OC_CONNECTED_KEY = "iou.openchat.connected.v1";
