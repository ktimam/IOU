import type { Identity } from "@dfinity/agent";
import type { AuthClient, AuthClientCreateOptions, AuthClientLoginOptions } from "@dfinity/auth-client";

export type AuthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "authenticated"; identity: Identity; principal: string };

type SessionClient = Pick<AuthClient, "isAuthenticated" | "getIdentity" | "login" | "logout">;
type SessionOptions = {
  createClient: (options: AuthClientCreateOptions) => Promise<SessionClient>;
  onState: (state: AuthState) => void;
  restoreDevIdentity: () => Identity | null;
  createDevIdentity: () => Identity;
  forgetDevIdentity: () => void;
  clearMemory: () => void;
  clearDevice: (principal: string) => Promise<void>;
};

/** Keep the SDK's persisted identity/delegation; idle time is not sign-out. */
export const REMEMBERED_AUTH_OPTIONS: AuthClientCreateOptions = { idleOptions: { disableIdle: true } };
export const REQUESTED_DELEGATION_TTL = 30n * 24n * 60n * 60n * 1_000_000_000n;
const MAX_TIMER_DELAY = 2_147_483_647;

/** The shortest granted delegation wins. The requested TTL is not its expiry. */
export function delegationExpiresAt(identity: Identity): number | undefined {
  const delegated = identity as Identity & { getDelegation?: () => unknown };
  if (typeof delegated.getDelegation !== "function") return undefined; // Local dev identity.
  try {
    const chain = delegated.getDelegation() as { delegations?: { delegation?: { expiration?: unknown } }[] };
    if (!Array.isArray(chain.delegations) || chain.delegations.length === 0) return 0;
    let earliest: bigint | undefined;
    for (const item of chain.delegations) {
      const expiration = item.delegation?.expiration;
      if (typeof expiration !== "bigint" || expiration <= 0n) return 0;
      if (earliest === undefined || expiration < earliest) earliest = expiration;
    }
    const milliseconds = Number(earliest! / 1_000_000n);
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  } catch {
    return 0;
  }
}

/** Auth-only lifecycle. No key derivation, backend actor, or account bootstrap belongs here. */
export class AuthSession {
  state: AuthState = { kind: "loading" };
  private active = false;
  private generation = 0;
  private client?: Promise<SessionClient>;
  private logoutPending: Promise<void> = Promise.resolve();
  private loginPending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: SessionOptions) {}

  private current(ticket: number): boolean { return this.active && ticket === this.generation; }

  private publish(state: AuthState): void {
    if (!this.active) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const previous = this.state.kind === "authenticated" ? this.state.principal : undefined;
    const next = state.kind === "authenticated" ? state.principal : undefined;
    if (previous !== next) this.options.clearMemory();
    this.state = state;
    this.options.onState(state);
    if (state.kind === "authenticated") {
      const expiry = delegationExpiresAt(state.identity);
      if (expiry !== undefined) {
        this.timer = setTimeout(() => this.checkExpiry(), Math.max(0, Math.min(expiry - Date.now(), MAX_TIMER_DELAY)));
      }
    }
  }

  private async getClient(): Promise<SessionClient> {
    await this.logoutPending;
    if (!this.client) {
      const pending = this.options.createClient(REMEMBERED_AUTH_OPTIONS);
      this.client = pending;
      void pending.catch(() => { if (this.client === pending) this.client = undefined; });
    }
    return this.client;
  }

  private accept(identity: Identity): boolean {
    const expiry = delegationExpiresAt(identity);
    if (identity.getPrincipal().isAnonymous() || (expiry !== undefined && expiry <= Date.now())) return false;
    this.publish({ kind: "authenticated", identity, principal: identity.getPrincipal().toText() });
    return true;
  }

  async restore(delay = 0): Promise<void> {
    this.active = true;
    const ticket = ++this.generation;
    try {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 10_000)));
      if (!this.current(ticket)) return;
      const client = await this.getClient();
      const authenticated = await client.isAuthenticated();
      if (!this.current(ticket)) return;
      if (authenticated) {
        if (!this.accept(client.getIdentity())) this.expire();
        return;
      }
      const dev = this.options.restoreDevIdentity();
      if (!dev || !this.accept(dev)) this.publish({ kind: "anonymous" });
    } catch {
      if (this.current(ticket)) {
        this.options.clearMemory();
        this.publish({ kind: "anonymous" });
      }
    }
  }

  signIn(loginOptions: Pick<AuthClientLoginOptions, "identityProvider" | "maxTimeToLive">): Promise<void> {
    // A previous II popup can still complete after sign-out. Never overlap it with a new login.
    if (this.loginPending) return this.loginPending;
    const ticket = ++this.generation;
    const pending = (async () => {
      const client = await this.getClient();
      if (!this.current(ticket)) return;
      await new Promise<void>((resolve, reject) => {
        void Promise.resolve(client.login({ ...loginOptions, onSuccess: resolve, onError: reject })).catch(reject);
      });
      if (!this.current(ticket)) {
        // The SDK persists the delegation before onSuccess. Remove a late, cancelled login too.
        await client.logout();
        throw new Error("Sign-in was cancelled because the authentication session changed.");
      }
      if (!(await client.isAuthenticated()) || !this.current(ticket) || !this.accept(client.getIdentity())) {
        if (this.current(ticket)) this.expire();
        throw new Error("The Internet Identity delegation has expired. Sign in again.");
      }
    })();
    this.loginPending = pending;
    void pending.finally(() => { if (this.loginPending === pending) this.loginPending = undefined; }).catch(() => {});
    return pending;
  }

  signInDev(): void {
    ++this.generation;
    if (!this.accept(this.options.createDevIdentity())) throw new Error("Development identity is unavailable.");
  }

  private end(clearDevice: boolean): Promise<void> {
    ++this.generation;
    const principal = this.state.kind === "authenticated" ? this.state.principal : undefined;
    const previousLogout = this.logoutPending;
    const client = this.client;
    this.client = undefined; // A new AuthClient must persist a fresh SDK session key after logout.
    this.options.clearMemory();
    this.publish({ kind: "anonymous" });
    if (clearDevice) this.options.forgetDevIdentity();
    const pending = (async () => {
      await previousLogout.catch(() => {});
      const results = await Promise.allSettled([
        (async () => { const value = await (client ?? this.options.createClient(REMEMBERED_AUTH_OPTIONS)); await value.logout(); })(),
        clearDevice && principal ? this.options.clearDevice(principal) : Promise.resolve(),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    this.logoutPending = pending;
    return pending;
  }

  signOut(): Promise<void> { return this.end(true); }

  /** Another tab cleared the shared SDK store. Re-read it; never delete another account's session. */
  async refreshAfterRemoteSignOut(principal: string): Promise<void> {
    if (!this.active || this.state.kind === "anonymous" ||
      (this.state.kind === "authenticated" && this.state.principal !== principal)) return;
    const ticket = ++this.generation;
    this.options.clearMemory();
    this.publish({ kind: "anonymous" });
    this.client = undefined;
    // Another tab may have committed a previously queued IDB write after the
    // originating tab's purge. Invalidate this tab first, then repeat only this
    // principal's purge before reading the shared SDK store. Never log out a
    // different account's SDK session from this notification handler.
    await this.options.clearDevice(principal);
    if (!this.current(ticket)) return;
    await this.restore();
  }

  /** Expiry locks active work but retains the protected device vault for a later sign-in. */
  private expire(): void { void this.end(false).catch(() => {}); }

  checkExpiry(): void {
    if (!this.active || this.state.kind !== "authenticated") return;
    const expiry = delegationExpiresAt(this.state.identity);
    if (expiry !== undefined && expiry <= Date.now()) this.expire();
    else this.publish(this.state); // Long delegations and resumed/backgrounded tabs reschedule safely.
  }

  suspend(): void {
    this.active = false;
    ++this.generation;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.options.clearMemory();
  }
}
