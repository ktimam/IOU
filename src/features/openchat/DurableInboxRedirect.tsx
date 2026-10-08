import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SignInButtons } from "../auth/SignInButtons";
import { host as backendHost, canisterId as backendCanisterId } from "../auth/config";
import { useActor } from "../flows/useActor";
import { localInboxLaunch } from "./localImportLaunch";
import { resolveDurableInboxSheet } from "./durableInboxNavigation";

/** Routes an existing-card Open app action to the normal sheet, with no transport/review page. */
export function DurableInboxRedirect() {
  const { state, identity } = useAuth();
  const { actor } = useActor();
  const principal = state.kind === "authenticated" ? state.principal : undefined;
  const [resolved, setResolved] = useState<{ principal: string; actor: unknown; identity: unknown; path?: string; error?: boolean }>();
  const launch = localInboxLaunch();
  useEffect(() => {
    if (!principal || !actor || !launch) return;
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error("Account changed"); };
    void resolveDurableInboxSheet({ actor, inboxId: launch.inboxId,
      context: { principal, backendHost, backendCanisterId }, destination: `${location.origin}/openchat/import`, assertCurrent })
      .then(path => { if (current) setResolved({ principal, actor, identity, path }); })
      .catch(() => { if (current) setResolved({ principal, actor, identity, error: true }); });
    return () => { current = false; };
  }, [principal, actor, identity, launch]);
  if (!launch) return <Navigate to="/" replace />;
  if (state.kind === "anonymous") return <div className="card"><h1>Sign in to IOU</h1>
    <p>Sign in to the account connected in OpenChat.</p><SignInButtons /></div>;
  if (resolved && resolved.principal === principal && resolved.actor === actor && resolved.identity === identity) {
    if (resolved.path) return <Navigate to={resolved.path} replace />;
    if (resolved.error) return <p role="status">The connected sheet could not be opened in this account. Nothing was saved. <Link to="/">Open IOU</Link></p>;
  }
  return <p className="muted">Opening the connected sheet…</p>;
}
