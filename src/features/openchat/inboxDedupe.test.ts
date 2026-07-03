import { describe, it, expect } from "vitest";
import {
  collapseByMessageId,
  parseImportedMessageIds,
  serializeImportedMessageIds,
} from "./inboxDedupe";

type Draft = { id: string; context?: { messageId?: string } };
const d = (id: string, messageId?: string): Draft =>
  messageId === undefined ? { id } : { id, context: { messageId } };

describe("collapseByMessageId", () => {
  it("returns an empty list unchanged", () => {
    expect(collapseByMessageId([])).toEqual([]);
  });

  it("keeps a single draft", () => {
    const items = [d("a", "m1")];
    expect(collapseByMessageId(items)).toEqual(items);
  });

  it("collapses two drafts sharing a messageId to the FIRST (earliest) one", () => {
    const first = d("a", "m1");
    const second = d("b", "m1");
    expect(collapseByMessageId([first, second])).toEqual([first]);
  });

  it("keeps drafts with distinct messageIds and preserves input order", () => {
    const items = [d("a", "m1"), d("b", "m2"), d("c", "m3")];
    expect(collapseByMessageId(items)).toEqual(items);
  });

  it("NEVER collapses drafts without a messageId — each undefined stays distinct", () => {
    const items = [d("a"), d("b"), d("c")];
    expect(collapseByMessageId(items)).toEqual(items);
  });

  it("collapses only the messageId'd duplicates, leaving wrapper-less drafts intact", () => {
    const items = [d("a", "m1"), d("b"), d("c", "m1"), d("e"), d("f", "m2")];
    // b and e (no messageId) stay; the second m1 (c) is dropped.
    expect(collapseByMessageId(items).map((x) => x.id)).toEqual(["a", "b", "e", "f"]);
  });

  it("keeps the earliest of three siblings for the same messageId", () => {
    const items = [d("a", "m1"), d("b", "m1"), d("c", "m1")];
    expect(collapseByMessageId(items).map((x) => x.id)).toEqual(["a"]);
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
