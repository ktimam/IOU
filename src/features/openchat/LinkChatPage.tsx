// /openchat/link-chat?chat=<chatKey> — the OpenChat "chat_link" surface.
//
// OpenChat opens this page (embedded in a bottom-sheet iframe, or in a plain browser tab) after
// the first confirmed action in a chat, substituting the canonical chat key into ?chat=
// ("group:<principal>" / "channel:<principal>:<id>" — the same format the delivery provenance
// carries). The page lets the user pick which sheet that chat's confirmed drafts are imported
// into:
//
//   - requires sign-in (same auth flow as the rest of the app, rendered inline so the ?chat
//     query survives — a redirect through /sign-in would drop it);
//   - lists the user's active sheets with their DECRYPTED display names — the same
//     prefs-cache-first + K_sheet decryptName resolution the accounts list / sheet page use;
//   - preselects the current mapping when one exists (fetchChatSheetLinks);
//   - on save calls the EXISTING canister-backed mapping (storeChatSheetLink) and refreshes the
//     localStorage cache. No canister changes.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SignInButtons } from "../auth/SignInButtons";
import { useActor, unwrap } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import { decryptName } from "../crypto/devVetkd";
import {
  fetchChatSheetLinks,
  storeChatSheetLink,
  removeChatSheetLink,
  readCachedLinks,
  writeCachedLinks,
} from "./chatSheetLinks";

// Mirrors the backend's chat-key bounds (opaque text, kept short); anything longer is a mangled
// link, not a real chat key.
const MAX_CHAT_KEY_LENGTH = 200;

type SheetOption = {
  sheetId: string;
  name: string; // best display name we could resolve (decrypted when possible)
  subtitle: string; // account / partner hint ("" when it would repeat the name)
};

function principalToText(p: unknown): string {
  if (!p) return "";
  const anyP = p as { toText?: () => string };
  if (typeof anyP.toText === "function") return anyP.toText();
  if (typeof p === "string") return p;
  return String(p);
}

// Candid opt<text | record{id}> → string | null (same shape Pairs.tsx unwraps).
function optToString(o: unknown): string | null {
  const v = unwrap(o as string | string[] | null);
  if (!v) return null;
  if (typeof v === "string") return v;
  return (v as { id?: string }).id ?? null;
}

// Unwrap a Candid opt<vec nat8> to a Uint8Array (or null).
function optBytes(o: unknown): Uint8Array | null {
  const v = Array.isArray(o) ? o[0] : o;
  return v == null ? null : new Uint8Array(v as number[]);
}

export function LinkChatPage() {
  const [params] = useSearchParams();
  const chatKey = (params.get("chat") ?? "").trim();
  const chatKeyError =
    chatKey === ""
      ? "This link is missing its chat reference — open it from OpenChat (it appears after you confirm an action in a chat)."
      : chatKey.length > MAX_CHAT_KEY_LENGTH
        ? "The chat reference in this link is not valid — open the page from OpenChat again."
        : null;

  const { state } = useAuth();
  const { actor, err: actorErr } = useActor();
  const { get, unwrapFor } = useSheetKey();
  const { prefs, cacheSheetName } = usePreferences();

  const [sheets, setSheets] = useState<SheetOption[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null); // sheet display name on success
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinked, setUnlinked] = useState(false); // "this chat is no longer linked" confirmation

  // Load the sheet list (with decrypted names, best-effort) and the current mapping.
  useEffect(() => {
    if (!actor || chatKeyError) return;
    let cancelled = false;
    (async () => {
      try {
        // Existing mapping first, so the preselection is ready when the list lands.
        let mapped: string | null = null;
        try {
          const links = await fetchChatSheetLinks(actor);
          mapped = links[chatKey] ?? null;
        } catch {
          mapped = readCachedLinks()[chatKey] ?? null; // canister unreachable — cached copy
        }

        const list = await actor.get_my_pairs();
        const opts: SheetOption[] = [];
        for (const p of Array.isArray(list) ? list : []) {
          const sheetId = optToString(p.active_sheet_id);
          if (!sheetId) continue;
          const pairId = p.id as string;
          // Decrypted-name resolution, same order the accounts list uses: plaintext cache
          // first; else decrypt name_enc under K_sheet (and cache it); else fall back to the
          // account / partner name / partner principal.
          let sheetName = prefs.sheetNames[sheetId] || "";
          if (!sheetName) {
            try {
              const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
              const sh = unwrap(await actor.get_sheet(sheetId));
              const enc = sh ? optBytes(sh.name_enc) : null;
              const iv = sh ? optBytes(sh.name_iv) : null;
              if (enc && iv) {
                const nm = await decryptName(K_sheet, iv, enc);
                if (nm) {
                  sheetName = nm;
                  cacheSheetName(sheetId, nm);
                }
              }
            } catch {
              /* names are best-effort — fall through to account/partner labels */
            }
          }
          const accountName = prefs.accountNames[pairId] || "";
          const partnerName = prefs.partnerNames[pairId] || "";
          const other = principalToText(p.other_principal);
          const fallback = accountName || partnerName || (other ? `${other.slice(0, 12)}…` : sheetId);
          const name = sheetName || fallback;
          const subtitle = sheetName ? fallback : partnerName && name !== partnerName ? partnerName : "";
          opts.push({ sheetId, name, subtitle: subtitle === name ? "" : subtitle });
        }

        if (cancelled) return;
        setSheets(opts);
        setExisting(mapped);
        setSelected(mapped && opts.some((o) => o.sheetId === mapped) ? mapped : null);
      } catch (e) {
        if (!cancelled) setLoadErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // prefs/cacheSheetName are read/written inside but must not retrigger the load (caching a
    // name updates prefs, which would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, chatKey, chatKeyError]);

  const save = async () => {
    if (!actor || !selected || chatKeyError) return;
    setSaving(true);
    setSaveErr(null);
    setSavedTo(null);
    setUnlinked(false);
    try {
      await storeChatSheetLink(actor, chatKey, selected);
      // Refresh the optimistic cache the sheet page seeds from.
      writeCachedLinks({ ...readCachedLinks(), [chatKey]: selected });
      setExisting(selected);
      setSavedTo(sheets?.find((s) => s.sheetId === selected)?.name ?? selected);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Remove this chat's mapping: OpenChat still delivers confirmed drafts (that is controlled from
  // the chat's Apps settings in OpenChat), but they stop auto-importing into any sheet here. Backed
  // by the caller-keyed remove_chat_sheet_link, so it follows the user across devices.
  const unlink = async () => {
    if (!actor || chatKeyError) return;
    setUnlinking(true);
    setSaveErr(null);
    setSavedTo(null);
    try {
      await removeChatSheetLink(actor, chatKey);
      const next = { ...readCachedLinks() };
      delete next[chatKey];
      writeCachedLinks(next);
      setExisting(null);
      setSelected(null);
      setUnlinked(true);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setUnlinking(false);
    }
  };

  // ---- render ---------------------------------------------------------------------------------

  if (chatKeyError) {
    return (
      <div className="card" style={{ marginTop: 24 }}>
        <h2>Link a chat to a sheet</h2>
        <p style={{ color: "var(--debt)" }}>{chatKeyError}</p>
      </div>
    );
  }

  if (state.kind === "loading") {
    return <p className="muted">Loading…</p>;
  }

  if (state.kind !== "authenticated") {
    // Inline sign-in (same auth flow as /sign-in) so the ?chat parameter survives.
    return (
      <div className="card" style={{ textAlign: "center", marginTop: 24 }}>
        <h2>Link a chat to a sheet</h2>
        <p className="muted">
          Sign in to choose which sheet this OpenChat chat's drafts are imported into.
        </p>
        <SignInButtons />
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Link this chat to a sheet</h2>
        <p className="muted small">
          Entries you confirm in this OpenChat chat will be imported into the sheet you pick here.
          You can change the sheet any time by reopening this page from the chat's Apps settings.
        </p>
        <p className="muted small" style={{ fontFamily: "monospace" }}>
          chat: {chatKey.length > 48 ? `${chatKey.slice(0, 48)}…` : chatKey}
        </p>

        {actorErr && <p style={{ color: "var(--debt)" }}>Actor error: {actorErr}</p>}
        {loadErr && <p style={{ color: "var(--debt)" }}>Could not load your sheets: {loadErr}</p>}
        {!sheets && !loadErr && <p className="muted">Loading your sheets…</p>}

        {sheets && sheets.length === 0 && (
          <p className="muted">
            You don't have any active sheets yet — create an account (and a sheet) in the IOU app
            first, then reopen this page from OpenChat.
          </p>
        )}

        {sheets && sheets.length > 0 && (
          <div className="col" style={{ gap: 8 }}>
            {existing && !sheets.some((s) => s.sheetId === existing) && (
              <p className="muted small">
                This chat is currently linked to a sheet that is no longer active
                (<span style={{ fontFamily: "monospace" }}>{existing}</span>) — pick a new one.
              </p>
            )}
            {sheets.map((s) => (
              <label
                key={s.sheetId}
                className="row"
                style={{ gap: 8, alignItems: "center", cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="link-chat-sheet"
                  checked={selected === s.sheetId}
                  onChange={() => {
                    setSelected(s.sheetId);
                    setUnlinked(false);
                  }}
                />
                <span>
                  {s.name}
                  {s.sheetId === existing && (
                    <span className="muted small"> (current)</span>
                  )}
                  {s.subtitle && (
                    <span className="muted small" style={{ display: "block" }}>
                      {s.subtitle}
                    </span>
                  )}
                </span>
              </label>
            ))}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button type="button" onClick={() => void save()} disabled={!selected || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}

        {savedTo && (
          <p className="small" style={{ color: "var(--credit)", marginTop: 8 }}>
            Drafts from this chat will be imported into {savedTo}.
          </p>
        )}
        {saveErr && (
          <p className="small" style={{ color: "var(--debt)", marginTop: 8 }}>
            Could not save the mapping: {saveErr}
          </p>
        )}

        {existing && (
          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
            <button
              type="button"
              className="secondary"
              onClick={() => void unlink()}
              disabled={unlinking}
            >
              {unlinking ? "Unlinking…" : "Unlink this chat"}
            </button>
            <span className="muted small">Stop importing this chat's drafts into a sheet.</span>
          </div>
        )}

        {unlinked && (
          <p className="small" style={{ color: "var(--txt-light, inherit)", marginTop: 8 }}>
            This chat is no longer linked to a sheet — its confirmed drafts won't auto-import. You
            can re-link it any time, or turn the app off for this chat from OpenChat's Apps settings.
          </p>
        )}
      </div>
    </div>
  );
}
