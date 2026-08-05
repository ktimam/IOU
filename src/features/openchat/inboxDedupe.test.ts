import { describe, it, expect } from "vitest";
import {
  collapseByMessageHandle,
  parseImportedMessageIds,
  serializeImportedMessageIds,
  isImportedIntoSheet,
  inboxDedupeStorageKey,
  OBSOLETE_INBOX_STORAGE_SCAN_CAP,
  planObsoleteInboxStorageCleanup,
} from "./inboxDedupe";

describe("inbox dedupe storage scope", () => {
  it("separates principals, IOU deployments, and OpenChat deployments", () => {
    const key = (principal: string, iou: string, oc: string) =>
      inboxDedupeStorageKey("handled", principal, oc, iou);
    expect(key("a", "iou-1", "oc-1")).not.toBe(key("b", "iou-1", "oc-1"));
    expect(key("a", "iou-1", "oc-1")).not.toBe(key("a", "iou-2", "oc-1"));
    expect(key("a", "iou-1", "oc-1")).not.toBe(key("a", "iou-1", "oc-2"));
  });

  it("purges v2 inbox keys from every old OpenChat deployment, not only the current one", () => {
    const obsolete = [
      "iou.openchat.handledInboxDrafts.v1",
      "iou.openchat.importedMessageIds.v1",
      "iou.openchat.handledInboxDrafts.v2.current-deployment",
      "iou.openchat.handledInboxDrafts.v2.previous-deployment",
      "iou.openchat.importedMessageIds.v2.previous-deployment",
      "iou.openchat.viewerUserId.v1.iou-principal-a",
      "iou.openchat.viewerUserId.v1.iou-principal-b",
    ];
    const retained = [
      "iou.openchat.handledInboxDrafts.v3.current-deployment:iou:alice",
      "iou.openchat.importedMessageIds.v3.current-deployment:iou:alice",
      "iou.openchat.handledInboxDrafts.v20.lookalike",
      "unrelated.key",
    ];

    const remove = planObsoleteInboxStorageCleanup([...obsolete, ...retained]);

    expect(remove).toEqual(expect.arrayContaining(obsolete));
    for (const key of retained) expect(remove).not.toContain(key);
  });

  it("bounds stale-key discovery even when the supplied key sequence is unbounded", () => {
    let yielded = 0;
    function* keys(): Generator<string> {
      while (true) {
        yielded += 1;
        yield `unrelated.${yielded}`;
      }
    }

    expect(planObsoleteInboxStorageCleanup(keys())).toEqual([
      "iou.openchat.handledInboxDrafts.v1",
      "iou.openchat.importedMessageIds.v1",
    ]);
    expect(yielded).toBe(OBSOLETE_INBOX_STORAGE_SCAN_CAP);
  });
});

type Draft = { id: string; context?: { messageHandle?: string } };
const d = (id: string, messageHandle?: string): Draft =>
  messageHandle === undefined ? { id } : { id, context: { messageHandle } };

describe("collapseByMessageHandle", () => {
  it("returns an empty list unchanged", () => {
    expect(collapseByMessageHandle([])).toEqual([]);
  });

  it("keeps a single draft", () => {
    const items = [d("a", "m1")];
    expect(collapseByMessageHandle(items)).toEqual(items);
  });

  it("collapses two drafts sharing a messageId to the FIRST (earliest) one", () => {
    const first = d("a", "m1");
    const second = d("b", "m1");
    expect(collapseByMessageHandle([first, second])).toEqual([first]);
  });

  it("keeps drafts with distinct messageIds and preserves input order", () => {
    const items = [d("a", "m1"), d("b", "m2"), d("c", "m3")];
    expect(collapseByMessageHandle(items)).toEqual(items);
  });

  it("NEVER collapses drafts without a messageId — each undefined stays distinct", () => {
    const items = [d("a"), d("b"), d("c")];
    expect(collapseByMessageHandle(items)).toEqual(items);
  });

  it("collapses only the messageId'd duplicates, leaving wrapper-less drafts intact", () => {
    const items = [d("a", "m1"), d("b"), d("c", "m1"), d("e"), d("f", "m2")];
    // b and e (no messageId) stay; the second m1 (c) is dropped.
    expect(collapseByMessageHandle(items).map((x) => x.id)).toEqual(["a", "b", "e", "f"]);
  });

  it("keeps the earliest of three siblings for the same messageId", () => {
    const items = [d("a", "m1"), d("b", "m1"), d("c", "m1")];
    expect(collapseByMessageHandle(items).map((x) => x.id)).toEqual(["a"]);
  });
});

// Cross-member "already imported" predicate: the fan-out deposits one envelope per member with the
// SAME context.messageId, so a partner's import — which persists that messageId on the shared entry
// as payload.import_message_id — must hide the card for EVERY member, not just the importer.
describe("isImportedIntoSheet", () => {
  type Entry = { deleted: boolean; payload: { draft_id?: string; import_message_id?: string } };
  const entry = (payload: Entry["payload"], deleted = false): Entry => ({ deleted, payload });

  it("hides a card whose messageId matches a non-deleted entry's import_message_id", () => {
    const entries = [entry({ draft_id: "d:aaa", import_message_id: "m1" })];
    expect(isImportedIntoSheet(entries, "m1", "d:aaa")).toBe(true);
  });

  it("does NOT hide a mid-bearing card on a same-content entry that lacks import_message_id", () => {
    // Two same-price bookings share a content-hash draft_id but are distinct cards. A mid-bearing
    // card must ONLY match on import_message_id — never fall back to the content hash.
    const entries = [entry({ draft_id: "d:same" })];
    expect(isImportedIntoSheet(entries, "m1", "d:same")).toBe(false);
  });

  it("hides a wrapper-less card (no messageId) when a non-deleted entry carries its draft_id", () => {
    // Paste-path parity: wrapper-less deposits have no messageId, so the content-hash draft_id is
    // the only key (isDuplicateDraft semantics).
    const entries = [entry({ draft_id: "d:xyz" })];
    expect(isImportedIntoSheet(entries, undefined, "d:xyz")).toBe(true);
  });

  it("a DELETED entry with a matching import_message_id does not hide the card", () => {
    // Deleting the imported entry must resurrect the card so it can be re-imported.
    const entries = [entry({ draft_id: "d:aaa", import_message_id: "m1" }, true)];
    expect(isImportedIntoSheet(entries, "m1", "d:aaa")).toBe(false);
  });

  it("a DELETED entry with a matching draft_id does not hide a wrapper-less card", () => {
    const entries = [entry({ draft_id: "d:xyz" }, true)];
    expect(isImportedIntoSheet(entries, undefined, "d:xyz")).toBe(false);
  });

  it("two identical-content cards with different messageIds: importing one hides only that one", () => {
    const entries = [entry({ draft_id: "d:same", import_message_id: "m1" })];
    expect(isImportedIntoSheet(entries, "m1", "d:same")).toBe(true);
    expect(isImportedIntoSheet(entries, "m2", "d:same")).toBe(false);
  });

  it("returns false when the card has neither a messageId nor a parsed draftId", () => {
    // An unparseable wrapper-less card has no key at all — never suppress it.
    const entries = [entry({ draft_id: "d:aaa", import_message_id: "m1" })];
    expect(isImportedIntoSheet(entries, undefined, undefined)).toBe(false);
  });

  it("returns false on an empty sheet", () => {
    expect(isImportedIntoSheet([], "m1", "d:aaa")).toBe(false);
  });
});

describe("parseImportedMessageIds", () => {
  it("returns an empty set for null (nothing persisted yet)", () => {
    expect([...parseImportedMessageIds(null)]).toEqual([]);
  });

  it("parses a JSON string array into a Set", () => {
    expect([...parseImportedMessageIds(JSON.stringify(["m1", "m2"]))].sort()).toEqual(["m1", "m2"]);
  });

  it("degrades to empty on malformed JSON — never throws", () => {
    expect([...parseImportedMessageIds("{not json")]).toEqual([]);
  });

  it("degrades to empty when the payload is not an array", () => {
    expect([...parseImportedMessageIds(JSON.stringify({ m1: true }))]).toEqual([]);
  });

  it("filters out non-string entries", () => {
    expect([...parseImportedMessageIds(JSON.stringify(["m1", 42, null, "m2"]))].sort()).toEqual(["m1", "m2"]);
  });

  it("dedupes duplicate ids via the Set", () => {
    expect([...parseImportedMessageIds(JSON.stringify(["m1", "m1"]))]).toEqual(["m1"]);
  });
});

describe("serializeImportedMessageIds", () => {
  it("keeps all ids when under the cap", () => {
    expect(JSON.parse(serializeImportedMessageIds(["m1", "m2"], 10))).toEqual(["m1", "m2"]);
  });

  it("caps to the most-recent N (insertion order, oldest dropped)", () => {
    const ids = ["m1", "m2", "m3", "m4"];
    expect(JSON.parse(serializeImportedMessageIds(ids, 2))).toEqual(["m3", "m4"]);
  });

  it("round-trips through parseImportedMessageIds", () => {
    const set = new Set(["m1", "m2", "m3"]);
    const round = parseImportedMessageIds(serializeImportedMessageIds(set, 1000));
    expect([...round].sort()).toEqual(["m1", "m2", "m3"]);
  });
});
