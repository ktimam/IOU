import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "./useActor";
import { deriveUserKeypair, newSheetKey, wrapSheetKey } from "../crypto/devVetkd";

const COMMON_CURRENCIES = ["USD", "Eur", "Egp", "Gbp", "Jpy", "Aud", "Cad", "Chf"];

export function NewSheet() {
  const [params] = useSearchParams();
  const pairId = params.get("pairId") || "";
  const { state } = useAuth();
  const { actor, err } = useActor();
  const nav = useNavigate();
  const [currencies, setCurrencies] = useState<string[]>(["Usd", "Egp"]);
  const [closingDays, setClosingDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

  function toggleCurrency(c: string) {
    setCurrencies((cur) =>
      cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c],
    );
  }

  async function doCreate() {
    if (!actor || !pairId) return;
    if (state.kind !== "authenticated") {
      setError("Please sign in first");
      return;
    }
    if (currencies.length === 0) {
      setError("Pick at least one currency");
      return;
    }
    setBusy(true);
      setError(null);
    try {
      // In v1 dev: wrap K_sheet for the two members of the pair.
      // We get the pair to find member_a and member_b.
      const pair = await actor.get_pair(pairId);
      const pairObj = Array.isArray(pair) ? pair[0] : pair;
      if (!pairObj) {
        setError("Pair not found or not a member.");
        setBusy(false);
        return;
      }
      const memberA = pairObj.members[0];
      const memberB = pairObj.members[1];
      // Reference memberA/memberB to keep TS happy; the actual
      // wrap uses our own keypair (dev collapse).
      void memberA;
      void memberB;
      // Each member has a P-256 keypair in localStorage; we read
      // our own and (in v1 dev) use it for both wraps. In
      // production, the wrap key is the chain key and each member
      // can recover it via their own vetkd_derive_key.
      const myPrincipal = state.identity.getPrincipal().toText();
      const myKp = await deriveUserKeypair(myPrincipal);
      // Dev collapse: use the local keypair for both members'
      // wrap targets. The other member's browser does the same on
      // their side, so the dev fallback is symmetric.
      const memberApub = myKp.publicKey;
      const memberBpub = myKp.publicKey;
      const K_sheet = newSheetKey();
      const wrapA = await wrapSheetKey(K_sheet, memberApub, myKp.privateKey);
      const wrapB = await wrapSheetKey(K_sheet, memberBpub, myKp.privateKey);
      const currenciesUpper = currencies.map((c) => c.toUpperCase());
      const sheet = await actor.create_sheet({
        pair_id: pairId,
        enabled_currencies: currenciesUpper,
        closing_window_days: Math.max(30, Math.min(730, closingDays)),
        wrapped_key_a: Array.from(wrapA),
        wrapped_key_b: Array.from(wrapB),
      });
      // In v1 dev the PWA doesn't yet store K_sheet in session
      // storage; that's Phase 3 work. For now we just navigate to
      // the pair page so the user sees the sheet was created.
      void K_sheet;
      nav(`/pair/${pairId}`, { replace: true });
      void sheet;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to={`/pair/${pairId}`} className="muted">
        ← Back to pair
      </Link>
      <h1>New sheet</h1>
      {err && <p style={{ color: "var(--debt)" }}>{err}</p>}

      <div className="card">
        <h2>Currencies</h2>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Pick the currencies you'll use in this sheet. You can add more
          later.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {COMMON_CURRENCIES.map((c) => (
            <button
              key={c}
              className={currencies.includes(c) ? "" : "secondary"}
              onClick={() => toggleCurrency(c)}
              style={{ fontSize: "0.875rem", padding: "6px 12px" }}
            >
              {c.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Closing window</h2>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          After this many days of inactivity, the sheet can be closed and a
          new one started.
        </p>
        <input
          type="number"
          min={30}
          max={730}
          value={closingDays}
          onChange={(e) => setClosingDays(Number(e.target.value))}
        />
      </div>

      {error && <p style={{ color: "var(--debt)" }}>{error}</p>}

      <div className="cta">
        <button onClick={doCreate} disabled={busy || currencies.length === 0}>
          {busy ? "Creating…" : "Create sheet"}
        </button>
      </div>
    </div>
  );
}
