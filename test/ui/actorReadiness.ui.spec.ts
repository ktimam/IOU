// The three "create" CTAs must say Connecting… — and stay disabled — until the actor exists.
//
// doCreate()/onAccept() all begin `if (!actor) return;`, so a click made while the agent is still
// being built (agent + root key fetch) does NOTHING: no spinner, no error, no navigation. The user
// presses the button, nothing happens, and there is no way to tell whether it worked. The guard is
// `disabled={busy || !actor}` plus the "Connecting…" label, duplicated across NewPair, NewSheet and
// AcceptInvitePage — three copies of the same latent bug, none of them pinned until now.
//
// Playwright's actionability auto-wait is why the existing flows never covered this: flows.ts clicks
// "Create account" and simply waits for the button to become enabled, which behaves IDENTICALLY with
// and without the guard. Only an assertion taken DURING the build window can tell them apart.
//
// HOW THE WINDOW IS OPENED: not with a production seam, but by delaying the one network call the
// actor build makes. useActor → buildAgent → agent.fetchRootKey() → GET <replica>/api/v2/status
// (dev/local only). Holding that request holds the actor and nothing else, needs no DEV-only branch
// shipped in the app, and cannot be defeated by a query param that an SPA navigation drops.

import { expect, test, type Page } from "@playwright/test";
import { signInDev } from "./flows";

// Long enough to survive a slow first render on a loaded machine, short enough not to pad the suite.
// Every assertion in the window is a ~10ms round-trip, so the margin is generous.
const ACTOR_DELAY_MS = 4_000;

/** Hold `agent.fetchRootKey()` — and therefore the actor — for ACTOR_DELAY_MS. */
async function delayActorBuild(page: Page): Promise<void> {
  await page.route(/\/api\/v2\/status/, async (route) => {
    await new Promise((r) => setTimeout(r, ACTOR_DELAY_MS));
    await route.continue();
  });
}

/** Load a CTA page with the actor build held open, and assert the guard blocks then RELEASES. */
async function expectGuardedCta(page: Page, path: string, idleLabel: string): Promise<void> {
  await delayActorBuild(page);
  await page.goto(path, { waitUntil: "domcontentloaded" });

  const cta = page.locator(".cta button");
  await expect(cta).toHaveText("Connecting…");
  await expect(cta).toBeDisabled();

  // The guard must RELEASE, not just block — a permanently dead button would satisfy the half above.
  await expect(cta).toHaveText(idleLabel, { timeout: 20_000 });
  await expect(cta).toBeEnabled();
}

test("new account: the CTA waits for the actor", async ({ page }) => {
  await signInDev(page);
  await expectGuardedCta(page, "/pair/new", "Create account");
});

test("new sheet: the CTA waits for the actor", async ({ page }) => {
  await signInDev(page);
  // The pairId only ever reaches create_sheet, which this test never calls — the CTA's readiness
  // state does not depend on it, so no account has to be built to observe it.
  await expectGuardedCta(page, "/sheet/new?pairId=probe", "Create sheet");
});

test("accept invite: the CTA waits for the actor", async ({ page }) => {
  await signInDev(page);
  // A synthetic fragment: AcceptInvitePage only needs `c` and `s` to parse before it renders the
  // accept CTA, and this test never clicks it — so no invite is minted and none is consumed.
  await expectGuardedCta(page, "/pair/accept#c=probe&s=0000000000000000&k=AAAA", "Accept invite");
});
