// P0-26: a signed-OUT invitee who opens an invite link must, after signing in INLINE, land back on
// the /pair/accept surface ready to accept — NOT get dumped on /pairs (the old bug: the anonymous
// branch linked out to /sign-in, whose post-login nav sent the invitee to /pairs, stranding the
// invite). We drive the signed-out path manually (NOT flows.acceptInvite, which pre-signs-in and
// would mask the bug).

import { test, expect } from "@playwright/test";
import { signInDev, createAccount, inviteLinkFromSheet } from "./flows";

test("signed-out invitee returns to /pair/accept after inline sign-in, not /pairs (P0-26)", async ({ browser }) => {
  // Alice (creator) makes an account + a shareable invite link.
  const aliceCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  await signInDev(alice);
  await createAccount(alice, "P0-26 Account", "Sheet");
  const link = await inviteLinkFromSheet(alice);

  // Bob: a FRESH, signed-OUT context opens the invite link directly.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await bob.goto(link, { waitUntil: "domcontentloaded" });

  // Anonymous branch: the invite is recognized and sign-in renders INLINE on /pair/accept.
  await bob.getByRole("heading", { name: /You've been invited/ }).waitFor({ timeout: 30_000 });
  expect(new URL(bob.url()).pathname).toBe("/pair/accept");
  await bob.getByRole("button", { name: /Sign in \(dev/ }).click();

  // After sign-in the SAME page re-renders in the authenticated ACCEPT state — the invitee is back to
  // accept, still on /pair/accept, never bounced to /pairs.
  await bob.getByRole("button", { name: /Accept invite/ }).waitFor({ timeout: 30_000 });
  expect(new URL(bob.url()).pathname).toBe("/pair/accept");
  expect(bob.url()).not.toContain("/pairs");

  // And it actually completes: accepting lands on the shared sheet. Use toHaveURL (polls the current
  // URL) rather than waitForURL (waits for a navigation event) — the SPA replace-nav can land before
  // the wait registers.
  await bob.getByRole("button", { name: /Accept invite/ }).click();
  await expect(bob).toHaveURL(/\/sheet\/[0-9a-f]{16}/, { timeout: 60_000 });

  await aliceCtx.close();
  await bobCtx.close();
});
