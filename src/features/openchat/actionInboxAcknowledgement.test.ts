import { describe, expect, it } from "vitest";
import {
  InboxAcknowledgementQueue,
  isDurablyHandledInboxMessage,
  planHandledAcknowledgement,
  type InboxAcknowledgementCandidate,
} from "./actionInboxAcknowledgement";

const secret = (value: number) => Uint8Array.from({ length: 32 }, () => value);
const CONFIG = {
  canisterId: "2vxsx-fae",
  appId: 7,
  consumerKeySelector: new Uint8Array(32).fill(7),
  userIndexCanisterId: "aaaaa-aa",
  host: "http://127.0.0.1:8080",
  signingKeyIds: [],
} as const;
const candidate = (id: bigint, withSecret = true): InboxAcknowledgementCandidate => ({
  id,
  deliveryId: `delivery-${id}`,
  config: CONFIG,
  ...(withSecret ? { acknowledgementSecret: secret(Number(id)) } : {}),
});
const handled = (...ids: bigint[]) => new Set(ids.map((id) => `oc-delivery-${id}`));

describe("planHandledAcknowledgement", () => {
  it("never acknowledges a fetched but unhandled action", () => {
    expect(planHandledAcknowledgement([candidate(5n)], new Set())).toBeUndefined();
  });

  it("selects a handled exact capability despite global numeric-id gaps", () => {
    const candidates = [candidate(5n), candidate(20n), candidate(21n)];
    expect(planHandledAcknowledgement(candidates, handled(5n, 20n))).toEqual(candidate(20n));
  });

  it("can acknowledge a later handled action without deleting an earlier unhandled action", () => {
    const candidates = [candidate(5n), candidate(6n)];
    expect(planHandledAcknowledgement(candidates, handled(6n))).toEqual(candidate(6n));
  });

  it("skips candidates without exact v4 secrets", () => {
    const candidates = [candidate(5n, false), candidate(6n)];
    expect(planHandledAcknowledgement(candidates, handled(5n, 6n))).toEqual(candidate(6n));
  });

  it("deduplicates replica replays by signed delivery identity rather than numeric locator", () => {
    const original = candidate(3n);
    const replay = { ...original, id: 9_999n };
    expect(planHandledAcknowledgement([replay, original, replay], handled(3n))).toEqual(replay);
  });
});

describe("InboxAcknowledgementQueue", () => {
  it("acknowledges only after handling and removes the exact successful delivery", async () => {
    const queue = new InboxAcknowledgementQueue();
    queue.observe([candidate(3n)]);
    const acknowledged: bigint[] = [];
    const send = async ({ id }: { id: bigint }) => {
      acknowledged.push(id);
    };

    await queue.flush(new Set(), send);
    expect(acknowledged).toEqual([]);
    await queue.flush(handled(3n), send);
    await queue.flush(handled(3n), send);
    expect(acknowledged).toEqual([3n]);
  });

  it("acknowledges each handled action separately and retains an unhandled action", async () => {
    const queue = new InboxAcknowledgementQueue();
    queue.observe([candidate(3n), candidate(4n), candidate(5n)]);
    const acknowledged: bigint[] = [];
    await queue.flush(handled(3n, 5n), async ({ id }) => {
      acknowledged.push(id);
    });
    expect(acknowledged).toEqual([3n, 5n]);
    await queue.flush(handled(4n), async ({ id }) => {
      acknowledged.push(id);
    });
    expect(acknowledged).toEqual([3n, 5n, 4n]);
  });

  it("retains a failed update and lets an honest observation replace a forged numeric locator", async () => {
    const queue = new InboxAcknowledgementQueue();
    const valid = candidate(7n);
    queue.observe([{ ...valid, id: 18_446_744_073_709_551_615n }]);
    await expect(queue.flush(handled(7n), async () => Promise.reject(new Error("rejected locator")))).rejects.toThrow(
      "rejected locator",
    );

    queue.observe([valid]);
    const acknowledged: bigint[] = [];
    await queue.flush(handled(7n), async ({ id }) => {
      acknowledged.push(id);
    });
    expect(acknowledged).toEqual([7n]);
  });

  it("preserves each delivery's originating inbox route across re-registration", async () => {
    const queue = new InboxAcknowledgementQueue();
    const oldConfig = { ...CONFIG, canisterId: "2vxsx-fae" };
    const newConfig = { ...CONFIG, canisterId: "aaaaa-aa" };
    queue.observe([
      { ...candidate(12n), config: oldConfig },
      { ...candidate(13n), config: newConfig },
    ]);
    const routes: string[] = [];
    await queue.flush(handled(12n, 13n), async ({ config }) => {
      routes.push(config.canisterId);
    });
    expect(routes.sort()).toEqual([oldConfig.canisterId, newConfig.canisterId].sort());
  });

  it("coalesces concurrent flushes into one update", async () => {
    const queue = new InboxAcknowledgementQueue();
    queue.observe([candidate(11n)]);
    let release!: () => void;
    let attempts = 0;
    const send = async () => {
      attempts += 1;
      await new Promise<void>((resolve) => (release = resolve));
    };
    const first = queue.flush(handled(11n), send);
    const second = queue.flush(handled(11n), send);
    expect(attempts).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(attempts).toBe(1);
  });
});

describe("isDurablyHandledInboxMessage", () => {
  const noSheetMatch = () => false;

  it("recognizes this member's prior import", () => {
    expect(isDurablyHandledInboxMessage("42", new Set(["42"]), new Set(), noSheetMatch)).toBe(true);
  });

  it("recognizes another pair member's durable dismissal or import", () => {
    expect(isDurablyHandledInboxMessage("42", new Set(), new Set(["42"]), noSheetMatch)).toBe(true);
    expect(isDurablyHandledInboxMessage("42", new Set(), new Set(), (id) => id === "42")).toBe(true);
  });

  it("does not infer handling for another sheet or a wrapperless action", () => {
    expect(isDurablyHandledInboxMessage("42", new Set(), new Set(), noSheetMatch)).toBe(false);
    expect(isDurablyHandledInboxMessage(undefined, new Set(["42"]), new Set(["42"]), () => true)).toBe(false);
  });
});
