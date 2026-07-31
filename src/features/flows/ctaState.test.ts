// ctaState — the actor-readiness guard on every "create / accept" button.
//
// The defect it stands against is a SILENT no-op: doCreate/onAccept both open with `if (!actor)
// return;`, so a click before the actor finishes building does nothing at all — no spinner, no error,
// no navigation, no clue. The button has to be disabled AND say why, or the app just looks broken.
//
// Nothing tested this. The mapping was hand-written three times (NewPair, NewSheet,
// AcceptInvitePage), so dropping the `!actor` arm from any one of them was a one-character edit that
// no suite would catch — Playwright's actionability auto-wait even makes an existing click test pass
// either way. Hence a pure function with the three states pinned.

import { describe, it, expect } from "vitest";
import { ctaState } from "./ctaState";

const LABELS = { idleLabel: "Create account", busyLabel: "Creating…" };

describe("ctaState", () => {
  it("blocks the click while the actor is still being built, and says why", () => {
    // THE assertion: this is what fails the moment `disabled={busy || !actor}` loses its second arm.
    // "Connecting…" is the part that turns a dead button into an explained wait.
    expect(ctaState({ busy: false, actorReady: false, ...LABELS })).toEqual({
      label: "Connecting…",
      disabled: true,
    });
  });

  it("shows the in-flight verb while the action runs", () => {
    expect(ctaState({ busy: true, actorReady: true, ...LABELS })).toEqual({
      label: "Creating…",
      disabled: true,
    });
  });

  it("RELEASES once the actor is up — the guard must not be a permanent lock", () => {
    // A guard that never opens is the same broken button with a different label.
    expect(ctaState({ busy: false, actorReady: true, ...LABELS })).toEqual({
      label: "Create account",
      disabled: false,
    });
  });

  it("prefers the busy verb when both are true (the more specific truth)", () => {
    // A submit that started before the actor settled is still a submit; "Connecting…" would read as
    // if nothing had happened.
    expect(ctaState({ busy: true, actorReady: false, ...LABELS })).toEqual({
      label: "Creating…",
      disabled: true,
    });
  });

  it("carries each flow's own verbs through untouched", () => {
    // The three call sites differ ONLY in wording; a shared function must not homogenise them.
    expect(ctaState({ busy: false, actorReady: true, idleLabel: "Create sheet", busyLabel: "Creating…" }).label).toBe(
      "Create sheet",
    );
    expect(ctaState({ busy: true, actorReady: true, idleLabel: "Accept invite", busyLabel: "Joining…" }).label).toBe(
      "Joining…",
    );
    // …but the not-ready state is deliberately the SAME sentence everywhere: it describes the app,
    // not the action.
    expect(
      ctaState({ busy: false, actorReady: false, idleLabel: "Accept invite", busyLabel: "Joining…" }).label,
    ).toBe("Connecting…");
  });
});
