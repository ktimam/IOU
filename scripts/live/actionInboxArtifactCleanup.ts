import type { Page } from "@playwright/test";

export type ExactActionInboxEntry = {
  kind: string;
  amount: number;
  currency: string | null;
  direction: string;
  note: string;
};

export type ExactActionInboxEnvelope = {
  shape: "single" | "batch";
  entries: ExactActionInboxEntry[];
};

export type ActionInboxCleanupTarget = {
  label: string;
  page: Page;
};

export type ActionInboxArtifactCleanupReport = {
  matched: number;
  acknowledged: number;
  errors: string[];
};

export interface ActionInboxArtifactCleaner {
  cleanup(): Promise<ActionInboxArtifactCleanupReport>;
}

type InboxProbe = {
  matched: number;
  matchIds: string[];
  acknowledged: number;
};

function evidenceError(evidence: ExactActionInboxEnvelope): string | undefined {
  if (evidence.shape === "single" && evidence.entries.length !== 1) {
    return "single-envelope evidence must contain exactly one entry";
  }
  if (evidence.shape === "batch" && evidence.entries.length < 2) {
    return "batch-envelope evidence must contain at least two entries";
  }
  const notes = new Set<string>();
  for (const entry of evidence.entries) {
    if (
      typeof entry.kind !== "string" ||
      entry.kind.trim() === "" ||
      !Number.isFinite(entry.amount) ||
      typeof entry.direction !== "string" ||
      entry.direction.trim() === "" ||
      typeof entry.note !== "string" ||
      entry.note.trim() === "" ||
      (entry.currency !== null &&
        (typeof entry.currency !== "string" || entry.currency.trim() === ""))
    ) {
      return "entry evidence must contain non-empty exact fields and a finite amount";
    }
    if (notes.has(entry.note)) return "entry evidence notes must be unique";
    notes.add(entry.note);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesEntry(candidate: unknown, expected: ExactActionInboxEntry): boolean {
  if (!isRecord(candidate)) return false;
  const currencyMatches =
    expected.currency === null
      ? !("currency" in candidate) ||
        candidate.currency === null ||
        candidate.currency === ""
      : candidate.currency === expected.currency;
  return (
    candidate.kind === expected.kind &&
    candidate.amount === expected.amount &&
    candidate.direction === expected.direction &&
    candidate.note === expected.note &&
    currencyMatches
  );
}

/** Pure exact-payload matcher shared with unit tests; optional extra fields never weaken evidence. */
export function matchesExactActionInboxDraft(
  draft: unknown,
  evidence: ExactActionInboxEnvelope,
): boolean {
  if (evidenceError(evidence)) return false;
  const entries =
    evidence.shape === "batch"
      ? Array.isArray(draft)
        ? draft
        : null
      : isRecord(draft)
        ? [draft]
        : null;
  return (
    entries !== null &&
    entries.length === evidence.entries.length &&
    entries.every((candidate, index) => matchesEntry(candidate, evidence.entries[index]))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Captures matching envelope ids before confirmation, then acknowledges only one fresh exact
 * nonce/payload match per target. A duplicate is intentionally left intact for diagnosis.
 */
export class ActionInboxArtifactScope implements ActionInboxArtifactCleaner {
  private readonly baselines = new Map<Page, string[]>();
  private armed = false;

  constructor(
    private readonly targets: readonly ActionInboxCleanupTarget[],
    private readonly evidence: ExactActionInboxEnvelope,
    private readonly label: string,
  ) {}

  async begin(): Promise<void> {
    const invalid = evidenceError(this.evidence);
    if (invalid) throw new Error(`${this.label}: ${invalid}`);
    if (this.targets.length === 0) throw new Error(`${this.label}: no inbox cleanup targets`);
    if (new Set(this.targets.map((target) => target.page)).size !== this.targets.length) {
      throw new Error(`${this.label}: duplicate inbox cleanup target page`);
    }
    for (const target of this.targets) {
      const baseline = await this.probe(target, [], false);
      this.baselines.set(target.page, baseline.matchIds);
    }
  }

  arm(): void {
    if (this.baselines.size !== this.targets.length) {
      throw new Error(`${this.label}: inbox cleanup baseline was not captured`);
    }
    this.armed = true;
  }

  async cleanup(): Promise<ActionInboxArtifactCleanupReport> {
    const report: ActionInboxArtifactCleanupReport = {
      matched: 0,
      acknowledged: 0,
      errors: [],
    };
    if (!this.armed) return report;

    for (const target of this.targets) {
      const baselineIds = this.baselines.get(target.page);
      if (!baselineIds) {
        report.errors.push(`${this.label}/${target.label}: missing pre-confirm baseline`);
        continue;
      }
      try {
        let probe: InboxProbe = { matched: 0, matchIds: [], acknowledged: 0 };
        for (let attempt = 0; attempt < 12 && probe.matched === 0; attempt++) {
          probe = await this.probe(target, baselineIds, false);
          if (probe.matched === 0) await target.page.waitForTimeout(1_000);
        }
        report.matched += probe.matched;
        if (probe.matched === 0) {
          report.errors.push(
            `${this.label}/${target.label}: no fresh exact inbox envelope appeared`,
          );
          continue;
        }
        if (probe.matched !== 1) {
          report.errors.push(
            `${this.label}/${target.label}: refusing ambiguous acknowledgement of ${probe.matched} exact envelopes`,
          );
          continue;
        }

        const acknowledged = await this.probe(target, baselineIds, true);
        if (acknowledged.matched !== 1 || acknowledged.acknowledged !== 1) {
          report.errors.push(
            `${this.label}/${target.label}: exact envelope changed or was not acknowledged`,
          );
          continue;
        }
        report.acknowledged += acknowledged.acknowledged;
        const remaining = await this.probe(target, baselineIds, false);
        if (remaining.matched !== 0) {
          report.errors.push(
            `${this.label}/${target.label}: exact envelope remained after acknowledgement`,
          );
        }
      } catch (error) {
        report.errors.push(
          `${this.label}/${target.label}: inbox cleanup failed: ${errorMessage(error)}`,
        );
      }
    }
    return report;
  }

  private async probe(
    target: ActionInboxCleanupTarget,
    baselineIds: readonly string[],
    shouldAcknowledge: boolean,
  ): Promise<InboxProbe> {
    const input = JSON.stringify({
      evidence: this.evidence,
      excludedIds: baselineIds,
      shouldAcknowledge,
    });
    return (await target.page.evaluate(`(async ({ evidence, excludedIds, shouldAcknowledge }) => {
      const inbox = await import("/src/features/openchat/actionInboxClient.ts");
      const auth = await import("/src/features/auth/AuthProvider.tsx");
      const declarations = await import("/src/backend/declarations.ts");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("signed-in local development identity is required");
      const actor = declarations.createActor(await auth.buildAgent(identity));
      const config = await inbox.getActionInboxConfig(actor);
      if (!config) throw new Error("OpenChat binding is not configured");
      const isRecord = (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      const matchesEntry = (candidate, expected) => {
        if (!isRecord(candidate)) return false;
        const currencyMatches =
          expected.currency === null
            ? !("currency" in candidate) ||
              candidate.currency === null ||
              candidate.currency === ""
            : candidate.currency === expected.currency;
        return (
          candidate.kind === expected.kind &&
          candidate.amount === expected.amount &&
          candidate.direction === expected.direction &&
          candidate.note === expected.note &&
          currencyMatches
        );
      };
      const matchesDraft = (draft) => {
        const entries =
          evidence.shape === "batch"
            ? Array.isArray(draft) ? draft : null
            : isRecord(draft) ? [draft] : null;
        return (
          entries !== null &&
          entries.length === evidence.entries.length &&
          entries.every((candidate, index) =>
            matchesEntry(candidate, evidence.entries[index]),
          )
        );
      };
      const excluded = new Set(excludedIds);
      const drafts = await inbox.pollActionInbox({
        config,
        identity,
        maxResults: 120,
      });
      const matches = drafts.filter(
        (candidate) =>
          !excluded.has(candidate.id.toString()) && matchesDraft(candidate.draft),
      );
      let acknowledged = 0;
      if (shouldAcknowledge && matches.length === 1) {
        const match = matches[0];
        const result = await inbox.acknowledgeActionInbox({
          config,
          identity,
          throughId: match.id,
          acknowledgementSecret: match.acknowledgementSecret,
        });
        acknowledged = result.acknowledged;
      }
      return {
        matched: matches.length,
        matchIds: matches.map((match) => match.id.toString()),
        acknowledged,
      };
    })(${input})`)) as InboxProbe;
  }
}

/**
 * Cleanup failures fail an otherwise-passing harness, but never replace its original failure.
 */
export async function finalizeActionInboxArtifactCleanup(
  cleaner: ActionInboxArtifactCleaner | undefined,
  primaryFailed: boolean,
  label: string,
): Promise<void> {
  if (!cleaner) return;
  let report: ActionInboxArtifactCleanupReport;
  try {
    report = await cleaner.cleanup();
  } catch (error) {
    report = {
      matched: 0,
      acknowledged: 0,
      errors: [`${label}: cleanup crashed: ${errorMessage(error)}`],
    };
  }
  if (report.acknowledged > 0) {
    console.log(
      `[cleanup] ${label}: acknowledged ${report.acknowledged} exact inbox envelope(s)`,
    );
  }
  if (report.errors.length === 0) return;
  const failure = new Error(report.errors.join("; "));
  console.error(`[cleanup] ${failure.message}`);
  if (!primaryFailed) throw failure;
}
