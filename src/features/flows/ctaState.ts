// The label + disabled state of a "do the thing" button that needs a live actor.
//
// THE BUG THIS ENCODES. Every create/accept handler starts `if (!actor) return;` — the actor is built
// asynchronously (agent + root key), so a click during that window did NOTHING: no spinner, no error,
// no navigation. The user taps "Create account", the app appears to ignore them, and the only way to
// find out it silently no-opped is to tap again and get lucky. The button therefore has to gate on
// the ACTOR as well as on `busy`, and say WHY it is gated — "Connecting…" is the difference between
// "this app is broken" and "wait a second".
//
// Extracted because the same three lines were hand-written in NewPair, NewSheet and AcceptInvitePage
// — three chances to drop the `!actor` arm, and no test anywhere that would notice. See
// ctaState.test.ts.

export type CtaState = {
  /** What the button reads right now. */
  label: string;
  /** Whether it accepts a click. */
  disabled: boolean;
};

export type CtaStateInput = {
  /** An action is already in flight (the handler's own busy flag). */
  busy: boolean;
  /** The canister actor has finished building — until then every handler returns silently. */
  actorReady: boolean;
  /** The verb when the button is ready ("Create account", "Create sheet", "Accept invite"). */
  idleLabel: string;
  /** The verb while the action runs ("Creating…", "Joining…"). */
  busyLabel: string;
};

/**
 * Busy wins over not-ready (an in-flight action is the more specific truth), and either one disables.
 * The guard must also RELEASE: once the actor is up and nothing is in flight, the button says its
 * verb and accepts the click.
 */
export function ctaState({ busy, actorReady, idleLabel, busyLabel }: CtaStateInput): CtaState {
  return {
    label: busy ? busyLabel : actorReady ? idleLabel : "Connecting…",
    disabled: busy || !actorReady,
  };
}
