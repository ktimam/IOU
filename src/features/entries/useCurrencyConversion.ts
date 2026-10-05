import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRate } from "./fx";
import { savedConversion, type ConversionDraft } from "./conversion";
import type { ConvertPayload } from "./types";

export function useCurrencyConversion(
  enabled: boolean, base: string, quote: string, initial?: ConvertPayload,
) {
  const [draft, setDraft] = useState(() => savedConversion(initial));
  const currentDraft = useRef(draft);
  const originalDraft = useRef(draft);
  const request = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const store = useCallback((next: ConversionDraft | null) => {
    currentDraft.current = next;
    setDraft(next);
  }, []);

  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    cancel();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setLoading(true);
    try {
      const result = await fetchRate(base, quote, controller.signal);
      // Some transports resolve after abort. Never replace a manual edit or a new pair.
      if (request.current !== controller || controller.signal.aborted) return;
      store({ base, quote, kind: "rate", value: String(result.rate),
        source: result.source, updatedAt: result.fetchedAt });
    } catch (e) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "Could not fetch an exchange rate.");
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [base, quote, cancel, store]);

  useEffect(() => {
    setError(null);
    if (enabled) {
      const existing = currentDraft.current;
      const samePair = existing?.base === base && existing.quote === quote;
      // Never change a saved/manual agreement implicitly. A session's fetched quote,
      // however, is refreshed each time conversion is enabled (the no-cache contract).
      if (!samePair || (existing !== originalDraft.current && existing?.source !== "manual")) {
        if (!samePair) store(null);
        void refresh();
      }
    }
    return cancel;
  }, [enabled, base, quote, refresh, cancel, store]);

  const edit = (kind: ConversionDraft["kind"], value: string) => {
    cancel();
    setError(null);
    store({ base, quote, kind, value, source: "manual", updatedAt: Date.now() });
  };

  return {
    draft: draft?.base === base && draft.quote === quote ? draft : null,
    error, loading, refresh, edit,
  };
}
