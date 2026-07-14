// Deployment-scoped dedup keys — the restart-safe inbox fix. A dedup set from an EARLIER OpenChat
// deployment must NOT suppress a fresh deployment's low-/reused-id deposits ("confirmed in OpenChat
// but never imported after an environment restart"). Both sets are scoped by the user_index id, and
// stale keys (other deployments + the pre-scoping legacy key) are purged.

import { describe, it, expect } from "vitest";
import { deriveDeployTag, planScopedInboxKey } from "./inboxDedupe";

describe("deriveDeployTag", () => {
  it("uses the trimmed user_index id, or 'default' when absent", () => {
    expect(deriveDeployTag("uzt4z-lp777-77774-qaabq-cai")).toBe("uzt4z-lp777-77774-qaabq-cai");
    expect(deriveDeployTag("  abc  ")).toBe("abc");
    expect(deriveDeployTag(undefined)).toBe("default");
    expect(deriveDeployTag(null)).toBe("default");
    expect(deriveDeployTag("")).toBe("default");
    expect(deriveDeployTag("   ")).toBe("default");
  });
});

describe("planScopedInboxKey", () => {
  const PREFIX = "iou.openchat.handledInboxDrafts.v2";
  const LEGACY = "iou.openchat.handledInboxDrafts.v1";

  it("keeps prefix.tag and always plans to drop the pre-scoping legacy key", () => {
    const { keep, remove } = planScopedInboxKey(PREFIX, "dep1", LEGACY, []);
    expect(keep).toBe(`${PREFIX}.dep1`);
    expect(remove).toEqual([LEGACY]);
  });

  it("purges keys from OTHER deployments but never the current one", () => {
    const existing = [
      `${PREFIX}.dep1`, // current — keep
      `${PREFIX}.dep0`, // stale deployment — remove
      `${PREFIX}.depX`, // stale deployment — remove
      LEGACY, // pre-scoping — remove
      "iou.openchat.importedMessageIds.v2.dep0", // different prefix — untouched
      "unrelated.key",
    ];
    const { keep, remove } = planScopedInboxKey(PREFIX, "dep1", LEGACY, existing);
    expect(keep).toBe(`${PREFIX}.dep1`);
    expect(remove).toContain(LEGACY);
    expect(remove).toContain(`${PREFIX}.dep0`);
    expect(remove).toContain(`${PREFIX}.depX`);
    expect(remove).not.toContain(`${PREFIX}.dep1`); // current deployment survives
    expect(remove).not.toContain("iou.openchat.importedMessageIds.v2.dep0"); // other set untouched
    expect(remove).not.toContain("unrelated.key");
  });

  it("a fresh deployment (its key not present) plans no removal of a current key and reads empty", () => {
    // Simulate an environment restart: the browser still holds dep0's set; dep1 is the new tag.
    const existing = [`${PREFIX}.dep0`, LEGACY];
    const { keep, remove } = planScopedInboxKey(PREFIX, "dep1", LEGACY, existing);
    expect(keep).toBe(`${PREFIX}.dep1`); // dep1 has no stored set → the poller reads it empty → imports
    expect(remove.sort()).toEqual([`${PREFIX}.dep0`, LEGACY].sort());
  });

  it("dedupes the removal list", () => {
    // If the legacy key also matches the prefix scan it must appear once.
    const { remove } = planScopedInboxKey(PREFIX, "dep1", `${PREFIX}.old`, [`${PREFIX}.old`]);
    expect(remove.filter((k) => k === `${PREFIX}.old`)).toHaveLength(1);
  });
});
