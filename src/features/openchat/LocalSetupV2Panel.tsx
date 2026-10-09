import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { host as backendHost, canisterId as backendCanisterId } from "../auth/config";
import { useActor, unwrap } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { currencyFromUserRecord } from "../settings/defaultCurrency";
import { decryptName } from "../crypto/devVetkd";
import { useLocalDeliveryKey } from "./LocalDeliveryKeyProvider";
import { verifiedLocalSetupProcessor } from "./LocalSetupDownloads";
import { localConnectionLabel, localConnectionLabels } from "./localConnectionLabels";
import { createLocalAppSetupConsent, type LocalAppSetupState } from "./localAppSetupConsent";
import { localSetupAccountId } from "./localAppSetupV2";
import { LocalSetupV2Error, prepareLocalSetupV2, readLocalChatRoutes, type LocalSetupSheet, type LocalSetupV2Actor } from "./localSetupV2Service";
import { loadLocalSetupSheet } from "./localSetupSheet";
import { LocalSetupTypesPreview } from "./LocalSetupTypesPreview";

type Props = { principal: string; opener: Window; consent: ReturnType<typeof createLocalAppSetupConsent>;
  state: Extract<LocalAppSetupState, { kind: "pending" }>; close: (message: string) => void; onShared: () => void };
type Choice = { sheetId: string; label: string };
export function LocalSetupV2Panel({ principal, opener, consent, state, close, onShared }: Props) {
  const context = state.binding.setupContext!;
  const { actor, err } = useActor(), { identity } = useAuth(), keys = useLocalDeliveryKey(), keyring = useSheetKey();
  const [loaded, setLoaded] = useState<{ actor: unknown; identity: unknown; currency: string; choices: Choice[] }>();
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ actor: unknown; identity: unknown; sheet: LocalSetupSheet }>();
  const [previewError, setPreviewError] = useState(false);
  const mounted = useRef(true), pending = useRef(false);
  const live = useRef({ actor, identity, principal, selected, binding: state.binding, keyring, preview });
  live.current = { actor, identity, principal, selected, binding: state.binding, keyring, preview };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoaded(undefined); setSelected(""); setNotice("");
    if (!actor || !identity) return;
    const check = () => { if (cancelled || !mounted.current || live.current.actor !== actor || live.current.identity !== identity ||
      live.current.principal !== principal || !consent.isCurrent(state.binding)) throw new Error("Setup session changed"); };
    void (async () => {
      const accountId = await localSetupAccountId({ principal, backendHost, backendCanisterId }); check();
      if (context.accountId && context.accountId !== accountId) throw new LocalSetupV2Error("Sign in to the IOU account already connected in OpenChat. No key or chat route was changed.");
      if (context.scope === "account") { setLoaded({ actor, identity, currency: "", choices: [] }); return; }
      const [pairs, user, links, routable] = await Promise.all([
        actor.get_my_pairs(), actor.get_my_user(), readLocalChatRoutes(actor, check), actor.chat_routable_sheet_ids(),
      ]); check();
      const allowed = new Set(Array.from(routable as ArrayLike<bigint>, id => id.toString(16).padStart(16, "0")));
      const choices: Choice[] = [];
      for (const pair of pairs) {
        const sheetId = unwrap(pair.active_sheet_id);
        if (typeof sheetId !== "string" || !allowed.has(sheetId) || unwrap(pair.archived_at) != null) continue;
        let names = localConnectionLabels(choices.length);
        try {
          const [sheet, account, key] = await Promise.all([actor.get_sheet(sheetId), actor.get_pair(pair.id), live.current.keyring.unwrapFor(sheetId)]); check();
          const s = unwrap<any>(sheet), a = unwrap<any>(account);
          const [sheetName, accountName] = await Promise.all([
            decryptName(key, new Uint8Array(unwrap<any>(s?.name_iv) ?? []), new Uint8Array(unwrap<any>(s?.name_enc) ?? [])),
            decryptName(key, new Uint8Array(unwrap<any>(a?.name_iv) ?? []), new Uint8Array(unwrap<any>(a?.name_enc) ?? [])),
          ]); check(); names = localConnectionLabels(choices.length, accountName, sheetName);
        } catch { check(); }
        choices.push({ sheetId, label: localConnectionLabel(names) });
      }
      check(); setLoaded({ actor, identity, currency: currencyFromUserRecord(unwrap(user)) ?? "", choices });
      const current = links.get(context.handle);
      setSelected(current && choices.some(choice => choice.sheetId === current) ? current : "");
    })().catch(error => { if (!cancelled) setNotice(error instanceof LocalSetupV2Error ? error.message : "IOU could not load this setup. Nothing was shared."); });
    return () => { cancelled = true; };
  }, [actor, identity, principal, context, consent, state.binding]);

  useEffect(() => {
    let cancelled = false;
    setPreview(undefined); setPreviewError(false);
    if (context.scope !== "chat" || !selected || !loaded || loaded.actor !== actor || loaded.identity !== identity) return;
    const check = () => {
      if (cancelled || !mounted.current || !consent.isCurrent(state.binding) || live.current.actor !== actor ||
        live.current.identity !== identity || live.current.principal !== principal || live.current.selected !== selected) throw new Error("Setup preview changed");
    };
    void loadLocalSetupSheet({ actor, principal, sheetId: selected, defaultCurrency: loaded.currency,
      unwrapFor: id => live.current.keyring.unwrapFor(id), assertCurrent: check }).then(sheet => {
      check(); setPreview({ actor, identity, sheet });
    }).catch(() => { if (!cancelled) setPreviewError(true); });
    return () => { cancelled = true; };
  }, [actor, identity, principal, context.scope, selected, loaded, consent, state.binding]);

  const previewReady = !!preview && preview.actor === actor && preview.identity === identity && preview.sheet.sheetId === selected;

  async function share() {
    if (pending.current || !keys.ready || !loaded || loaded.actor !== actor || loaded.identity !== identity ||
      (context.scope === "chat" && (!selected || !previewReady))) return;
    const captured = live.current;
    const check = () => {
      if (!mounted.current || opener.closed || !consent.isCurrent(state.binding) || live.current.actor !== captured.actor ||
        live.current.identity !== captured.identity || live.current.principal !== captured.principal || live.current.selected !== captured.selected ||
        live.current.binding !== captured.binding || (context.scope === "chat" && live.current.preview !== captured.preview)) throw new Error("Setup session changed");
    };
    pending.current = true; setBusy(true); setNotice("");
    try {
      let currency = loaded.currency;
      const json = await prepareLocalSetupV2({ context, actor: actor as LocalSetupV2Actor,
        identity: { principal, backendHost, backendCanisterId }, destination: `${location.origin}/openchat/import`,
        selectedSheetId: context.scope === "chat" ? selected : undefined, assertCurrent: check,
        loadKey: () => keys.load(true), loadProcessor: verifiedLocalSetupProcessor,
        loadSheet: async (sheetId, guard) => {
          if (context.scope === "account") { const user = await actor.get_my_user(); guard(); currency = currencyFromUserRecord(unwrap(user)) ?? ""; }
          const sheet = await loadLocalSetupSheet({ actor, principal, sheetId, defaultCurrency: currency,
            unwrapFor: id => live.current.keyring.unwrapFor(id), assertCurrent: guard });
          guard();
          if (context.scope === "chat" && JSON.stringify(sheet) !== JSON.stringify(captured.preview?.sheet)) {
            throw new LocalSetupV2Error("This sheet's setup changed after its preview. Reopen setup and review it again; nothing was shared.");
          }
          return sheet;
        },
      }); check();
      opener.postMessage(consent.approve(state.binding, json), state.binding.senderOrigin); onShared();
    } catch (error) {
      if (mounted.current) {
        if (consent.state().kind === "shared") close("The setup delivery outcome is unknown. Check OpenChat before starting another connection.");
        else setNotice(error instanceof LocalSetupV2Error ? error.message : "IOU could not finish this setup. No entries were sent or saved. Check the current chat mapping before trying again.");
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const ready = !!loaded && loaded.actor === actor && loaded.identity === identity;
  return <section aria-label={context.scope === "account" ? "IOU account connection" : "IOU chat setup"}>
    <h2>{context.scope === "account" ? "Connect your IOU account" : "Choose this chat's account and sheet"}</h2>
    {context.scope === "account" ? <p>Reconnect your account without changing any chat's sheet. Choose or change a sheet through Open setup in that chat.</p> : <label>Sheet <select value={selected} disabled={!ready || busy} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a sheet…</option>{loaded?.choices.map(choice => <option key={choice.sheetId} value={choice.sheetId}>{choice.label}</option>)}
    </select></label>}
    {context.scope === "chat" && selected && <LocalSetupTypesPreview defaultCurrency={loaded?.currency ?? ""}
      loading={!previewReady && !previewError} ready={previewReady} error={previewError} types={previewReady ? preview.sheet.processorContext.types : []} />}
    {!ready && !notice && !err && <p>Checking the connected IOU account…</p>}
    {(notice || err) && <p role="status">{notice || "IOU could not prepare the connection."}</p>}
    <p>OpenChat will remember this connection on this device. It may deliver encrypted drafts for 90 days; pending drafts stay in IOU for up to 30 days and still need your review and Save.</p>
    <button disabled={!ready || !keys.ready || busy || (context.scope === "chat" && (!selected || !previewReady))} onClick={() => void share()}>{busy ? "Connecting…" : context.scope === "account" ? "Connect" : "Save setup"}</button>
  </section>;
}
