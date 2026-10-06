/** Select a WindowProxy, not an authority: callers still require exact origin/nonce and consent. */
export function localAppSenderWindow(target: Pick<Window, "parent" | "opener">): Window | undefined {
  const sender = target.parent !== target ? target.parent : target.opener as Window | null;
  return sender && !sender.closed ? sender : undefined;
}
