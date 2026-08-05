import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

/**
 * Read an HTTP body without ever retaining more than maxBytes. IncomingMessage
 * chunks are counted as bytes (not UTF-16 characters). On overflow the request
 * is paused and every accumulating listener is removed immediately; callers
 * should answer 413 with Connection: close.
 */
export function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  positiveSafeInteger(maxBytes, "maxBytes");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const fail = (error: Error, pause: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pause) {
        req.pause();
        // A later socket error must not become an unhandled EventEmitter error
        // after the accumulating listener has deliberately been removed.
        req.once("error", () => undefined);
      }
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.byteLength > maxBytes - received) {
        fail(new BodyTooLargeError(maxBytes), true);
        return;
      }
      received += bytes.byteLength;
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, received).toString("utf8"));
    };
    const onError = (error: Error) => fail(error, false);

    const declaredLength = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      fail(new BodyTooLargeError(maxBytes), true);
      return;
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function canInsertMapKey<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
  maxEntries: number,
): boolean {
  positiveSafeInteger(maxEntries, "maxEntries");
  return map.has(key) || map.size < maxEntries;
}

export function pruneInactivePairings<K, V extends { last_seen_at: number }>(
  map: Map<K, V>,
  now: number,
  maxAgeMs: number,
): number {
  positiveSafeInteger(maxAgeMs, "maxAgeMs");
  let removed = 0;
  for (const [key, value] of map) {
    if (now - value.last_seen_at >= maxAgeMs) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

export class FixedWindowRateLimiter {
  private readonly clients = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxClients: number,
  ) {
    positiveSafeInteger(maxRequests, "maxRequests");
    positiveSafeInteger(windowMs, "windowMs");
    positiveSafeInteger(maxClients, "maxClients");
  }

  private prune(now: number): void {
    for (const [key, window] of this.clients) {
      if (now - window.startedAt >= this.windowMs) this.clients.delete(key);
    }
  }

  consume(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    this.prune(now);
    const current = this.clients.get(key);
    if (!current) {
      if (this.clients.size >= this.maxClients) {
        return { allowed: false, retryAfterMs: this.windowMs };
      }
      this.clients.set(key, { startedAt: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1, current.startedAt + this.windowMs - now),
      };
    }
    current.count++;
    return { allowed: true, retryAfterMs: 0 };
  }
}
