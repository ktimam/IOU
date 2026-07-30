// The card iframe's ONE lookup: which currency should it pre-select?
//
// IOU's confirmable card is embedded by OpenChat as a storage-partitioned `credentialless` iframe. It
// has NO IOU session and — measured, not assumed — no localStorage, IndexedDB, caches,
// BroadcastChannel delivery or Storage Access from IOU's first-party context, so it cannot read
// `prefs.defaultCurrency` and cannot tell one viewer from another. Nor can it key off the chat: an
// OpenChat direct-chat key names only the COUNTERPARTY, so `direct:<X>` is the same string for every
// user who chats with X and any per-chat value is contested between them (that design was built and
// reverted — see the MemoryId 21 note in lib.rs).
//
// What IS resolvable identically by every viewer is a single deployment-wide value, so that is what
// this reads: `Config.card_currency`, via the ANONYMOUS `get_config` query. Both members of a card
// therefore see the same pre-selected code, and — because a non-empty currency travels in the confirm
// payload — both import it. That is the accepted trade-off: it is a pre-selection, visible and
// editable in the dropdown before anyone confirms.
//
// Best-effort throughout: any failure (offline, older canister, unset value) resolves to undefined and
// the card falls back to deferring the currency to whoever imports it.
import { Actor, HttpAgent } from "@dfinity/agent";
import { host, canisterId } from "../auth/config";

const CURRENCY_RE = /^[A-Z]{3}$/;

// Minimal IDL — just the one anonymous query, and only the field we need. Declaring it locally keeps
// the card page off the app's full actor/declarations surface (and its session-shaped imports).
// Candid ignores record fields the caller does not declare, so this stays valid as Config grows.
const idl = ({ IDL }: { IDL: any }) =>
  IDL.Service({
    get_config: IDL.Func([], [IDL.Record({ card_currency: IDL.Opt(IDL.Text) })], ["query"]),
  });

/**
 * The deployment's card currency, or undefined when it is unset, unreachable, or not a plain ISO code.
 */
export async function fetchCardCurrency(): Promise<string | undefined> {
  try {
    const agent = new HttpAgent({ host });
    // Local replicas serve a self-signed root key the agent must fetch before any query.
    if (host.includes("127.0.0.1") || host.includes("localhost")) {
      await agent.fetchRootKey();
    }
    const actor = Actor.createActor(idl as never, { agent, canisterId }) as {
      get_config: () => Promise<{ card_currency: [] | [string] }>;
    };
    const cfg = await actor.get_config();
    const opt = cfg?.card_currency;
    const code = Array.isArray(opt) && opt.length > 0 ? String(opt[0]).trim().toUpperCase() : "";
    return CURRENCY_RE.test(code) ? code : undefined;
  } catch {
    // Offline, wrong host, un-upgraded canister — all non-fatal.
    return undefined;
  }
}
