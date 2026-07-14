import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "./useActor";
import { useMyKeypair } from "./useMyKeypair";
import { useSheetKey } from "./SheetKeyContext";
import { grantPartnerAccess } from "./grantPartnerAccess";
import { usePreferences } from "../settings/usePreferences";
import { encryptName } from "../crypto/devVetkd";

export function Pair() {
  const { pairId } = useParams<{ pairId: string }>();
  const { state } = useAuth();
  const { actor } = useActor();
  const { keypair: myKp } = useMyKeypair();
  const { registerPartnerKey, unwrapFor } = useSheetKey();
  const { prefs, cacheAccountName } = usePreferences();
  const nav = useNavigate();
  const [pair, setPair] = useState<any | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  useEffect(() => {
    // Redirect only when DEFINITIVELY anonymous — never during "loading" (avoids the refresh /
    // deep-link bounce through /sign-in). While loading, fall through and wait.
    if (state.kind === "anonymous") {
      nav("/sign-in", { replace: true });
      return;
    }
    if (state.kind !== "authenticated" || !actor || !pairId) return;
    setLoading(true);
    (async () => {
      try {
        const p = unwrap(await actor.get_pair(pairId));
        if (!p) {
          setError("You're not a member of this pair.");
          setPair(null);
        } else {
          setPair(p);
          // Find the active sheet for this pair (if any).
          const summaries = await actor.get_my_pairs();
          const sum = (summaries as any[]).find((s) => s.id === pairId);
          const sid = sum ? unwrap(sum.active_sheet_id) : null;
          setActiveSheetId(sid);
          // Publish my wrap pubkey on-canister so the other member can fetch
          // it (used to grant / to read a granted sheet).
          if (myKp) {
            try {
              await actor.register_sheet_pubkey(
                Array.from(new TextEncoder().encode(myKp.publicKeyB64)),
              );
            } catch {
              /* non-fatal */
            }
          }
          // Cache the wrap-sender for the active sheet. The creator (member_a)
          // self-wrapped it; a granted partner (member_b) must use the
          // creator's attested key as the wrap-sender.
          const meText =
            state.kind === "authenticated"
              ? state.identity.getPrincipal().toText()
              : "";
          const creator = p.members?.[0];
          const creatorText =
            creator && typeof creator.toText === "function"
              ? creator.toText()
              : String(creator ?? "");
          if (sid) {
            if (meText === creatorText && myKp) {
              registerPartnerKey(sid, myKp.publicKeyB64);
            } else if (meText !== creatorText) {
              try {
                const raw = unwrap(await actor.get_sheet_pubkey(creator));
                if (raw) {
                  registerPartnerKey(
                    sid,
                    new TextDecoder().decode(new Uint8Array(raw as number[])),
                  );
                }
              } catch {
                /* partner key not published yet */
              }
            }
          }
          setArchivedCount(Number(sum?.archived_sheet_count ?? 0));
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, state, nav, pairId, myKp?.publicKeyB64]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) {
    return (
      <div>
        <p style={{ color: "var(--debt)" }}>{error}</p>
        <Link to="/pairs">Back to accounts</Link>
      </div>
    );
  }
  if (!pair) return <p className="muted">No pair.</p>;

  // A pair is only "active" once a second member has joined. Until then
  // members[1] is the anonymous principal (2vxsx-fae) and the backend
  // rejects create_sheet ("pair is not active"). Detect it so we offer the
  // invite flow instead of a button that traps.
  const ANON = "2vxsx-fae";
  const partner = pair.members?.[1];
  const partnerText =
    partner && typeof partner.toText === "function"
      ? partner.toText()
      : String(partner ?? "");
  const pairActive = partnerText !== "" && partnerText !== ANON;
  const meText =
    state.kind === "authenticated"
      ? state.identity.getPrincipal().toText()
      : "";
  const creatorText =
    pair.members?.[0] && typeof pair.members[0].toText === "function"
      ? pair.members[0].toText()
      : String(pair.members?.[0] ?? "");
  const iAmCreator = meText !== "" && meText === creatorText;

  async function doGrant() {
    if (!actor || !activeSheetId || state.kind !== "authenticated") return;
    setGrantBusy(true);
    setGrantMsg(null);
    try {
      const n = await grantPartnerAccess({
        actor,
        identity: state.identity,
        pairId: pairId ?? "",
        partnerPrincipalText: partnerText,
        activeSheetId,
        getKSheet: (s) => unwrapFor(s),
      });
      setGrantMsg(
        n > 0
          ? "Done — your partner now has access to this sheet."
          : "Nothing to grant.",
      );
    } catch (e) {
      const m = (e as Error).message;
      setGrantMsg(
        m.includes("already has a partner")
          ? "Your partner already has access to this sheet."
          : m,
      );
    } finally {
      setGrantBusy(false);
    }
  }

  async function saveAccountName() {
    if (!actor || !activeSheetId || !pairId) return;
    setRenameBusy(true);
    try {
      // Account names are E2E-encrypted under the active sheet's K_sheet.
      const K = await unwrapFor(activeSheetId);
      const { enc, iv } = await encryptName(K, nameDraft.trim());
      await actor.set_pair_name(pairId, enc, iv);
      cacheAccountName(pairId, nameDraft.trim());
      setRenaming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  }

  const accountName =
    (pairId && prefs.accountNames[pairId]) || `Account ${pairId?.slice(0, 12)}…`;

  return (
    <div>
      <Link to="/pairs" className="muted">
        ← All accounts
      </Link>
      {renaming ? (
        <div className="row" style={{ gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={48}
            placeholder="Account name"
            autoFocus
          />
          <button
            className="small"
            onClick={() => void saveAccountName()}
            disabled={renameBusy || !nameDraft.trim()}
          >
            {renameBusy ? "Saving…" : "Save"}
          </button>
          <button
            className="secondary small"
            onClick={() => setRenaming(false)}
            disabled={renameBusy}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <h1 style={{ margin: 0 }}>{accountName}</h1>
          {activeSheetId && (
            <button
              className="secondary small"
              onClick={() => {
                setNameDraft(prefs.accountNames[pairId ?? ""] ?? "");
                setRenaming(true);
              }}
            >
              Rename
            </button>
          )}
        </div>
      )}
      <div className="card">
        <p className="muted">Invite code</p>
        <h2>{pair.invite_code}</h2>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Created {new Date(Number(pair.created_at) / 1_000_000).toLocaleString()}
        </p>
      </div>
      {activeSheetId ? (
        <div className="cta">
          <Link to={`/sheet/${activeSheetId}`}>
            <button>Open active sheet →</button>
          </Link>
        </div>
      ) : (
        <div>
          <div className="cta">
            <Link to={`/sheet/new?pairId=${pairId}`}>
              <button>+ New sheet</button>
            </Link>
          </div>
          {!pairActive && (
            <p className="muted" style={{ marginTop: 8 }}>
              Solo mode — start sheets now and invite a partner anytime with
              the invite code above. When they join you can grant them access
              to everything.
            </p>
          )}
        </div>
      )}
      {pairActive && activeSheetId && iAmCreator && (
        <div className="card">
          <p className="muted" style={{ fontSize: "0.875rem" }}>
            Your partner has joined. Grant them access to the current sheet —
            they'll be able to read its full history.
          </p>
          <button
            className="secondary"
            disabled={grantBusy}
            onClick={() => void doGrant()}
          >
            {grantBusy ? "Granting…" : "Grant partner access"}
          </button>
          {grantMsg && (
            <p className="muted" style={{ marginTop: 8 }}>
              {grantMsg}
            </p>
          )}
        </div>
      )}
      {archivedCount > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          <Link to={`/pair/${pairId}/archived`}>
            📦 {archivedCount} archived sheet
            {archivedCount === 1 ? "" : "s"}
          </Link>
        </p>
      )}
      <div className="card small">
        <p className="muted">Your public key (share with partner if needed)</p>
        <code style={{ wordBreak: "break-all", fontSize: "0.75rem" }}>
          {myKp?.publicKeyB64 ?? "(loading…)"}
        </code>
      </div>
      <div className="cta-row">
        <Link to={`/pair/${pairId}/replace`}>
          <button className="secondary">Replace member (leaving)</button>
        </Link>
        <Link to={`/pair/${pairId}/accept-replace`}>
          <button className="secondary">Accept replacement (staying)</button>
        </Link>
      </div>
    </div>
  );
}
