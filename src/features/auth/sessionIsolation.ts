export type AuthSessionKind = "loading" | "anonymous" | "authenticated";

export function authSessionScope(
  kind: AuthSessionKind,
  principal?: string,
): string {
  if (kind !== "authenticated") return kind;
  if (!principal) throw new Error("authenticated session is missing its principal");
  return "authenticated:" + principal;
}

/** Invalidates asynchronous secret work when its owning React session unmounts. */
export class SessionGeneration {
  private generation = 0;
  private active = true;

  capture(): number {
    if (!this.active) throw new Error("authentication changed");
    return this.generation;
  }

  activate(): void {
    this.active = true;
  }

  invalidate(secrets: Iterable<Uint8Array> = []): void {
    this.active = false;
    this.generation++;
    for (const secret of secrets) secret.fill(0);
  }

  assertCurrent(ticket: number, secret?: Uint8Array): void {
    if (!this.active || ticket !== this.generation) {
      secret?.fill(0);
      throw new Error("authentication changed while loading a secret");
    }
  }
}
