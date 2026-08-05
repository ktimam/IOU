import type { ActionInboxConfig } from "./actionInboxClient";

export type InboxAcknowledgementCandidate = {
  id: bigint;
  deliveryId: string;
  config: ActionInboxConfig;
  acknowledgementSecret?: Uint8Array;
};

export function isDurablyHandledInboxMessage(
  messageHandle: string | undefined,
  locallyImported: ReadonlySet<string>,
  pairDismissed: ReadonlySet<string>,
  importedIntoCurrentSheet: (messageHandle: string) => boolean,
): boolean {
  return (
    messageHandle !== undefined &&
    (locallyImported.has(messageHandle) ||
      pairDismissed.has(messageHandle) ||
      importedIntoCurrentSheet(messageHandle))
  );
}

/**
 * Select the oldest handled action for which this consumer has the exact encrypted capability.
 * A v4 capability authorizes deletion of one action id only; it never authorizes a numeric prefix,
 * so an unrelated earlier unhandled action does not block cleanup of a later handled action.
 */
export function planHandledAcknowledgement(
  candidates: readonly InboxAcknowledgementCandidate[],
  handledIds: ReadonlySet<string>,
): InboxAcknowledgementCandidate | undefined {
  const byDeliveryId = new Map<string, InboxAcknowledgementCandidate>();
  for (const candidate of candidates) {
    const existing = byDeliveryId.get(candidate.deliveryId);
    if (!existing || (!existing.acknowledgementSecret && candidate.acknowledgementSecret)) {
      byDeliveryId.set(candidate.deliveryId, candidate);
    }
  }

  for (const candidate of [...byDeliveryId.values()].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId))) {
    if (handledIds.has(`oc-${candidate.deliveryId}`) && candidate.acknowledgementSecret) return candidate;
  }
  return undefined;
}

/**
 * Keeps acknowledgement capabilities in memory until the update succeeds. Concurrent flushes share
 * one promise, and a failed update deliberately leaves the candidate in place for the next poll or
 * user action to retry.
 */
export class InboxAcknowledgementQueue {
  private readonly candidates = new Map<string, InboxAcknowledgementCandidate>();
  private flushing: Promise<void> | undefined;

  observe(candidates: readonly InboxAcknowledgementCandidate[]): void {
    for (const candidate of candidates) {
      const existing = this.candidates.get(candidate.deliveryId);
      if (!existing || (!existing.acknowledgementSecret && candidate.acknowledgementSecret)) {
        this.candidates.set(candidate.deliveryId, candidate);
      } else if (candidate.acknowledgementSecret) {
        // The numeric locator is not signed. A later honest observation of the same authenticated
        // delivery identity must be able to replace a replica-forged locator after an ack failure.
        this.candidates.set(candidate.deliveryId, candidate);
      }
    }
  }

  flush(
    handledIds: ReadonlySet<string>,
    acknowledge: (candidate: InboxAcknowledgementCandidate & { acknowledgementSecret: Uint8Array }) => Promise<unknown>,
  ): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = async () => {
      while (true) {
        const candidate = planHandledAcknowledgement([...this.candidates.values()], handledIds);
        if (!candidate?.acknowledgementSecret) return;
        await acknowledge({ ...candidate, acknowledgementSecret: candidate.acknowledgementSecret });
        this.candidates.delete(candidate.deliveryId);
      }
    };
    const current = run().finally(() => {
      if (this.flushing === current) this.flushing = undefined;
    });
    this.flushing = current;
    return current;
  }
}
