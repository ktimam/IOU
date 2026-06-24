// Deep-link handling (v1.1.5).
//
// Maps an external URL that launches the app — a custom-scheme link
// `iou://<host>/<path>` (Android intent-filter + iOS, see capacitor.config /
// AndroidManifest) — to an in-app react-router path, then navigates.
//
// The mapping (`deepLinkToPath`) is a PURE function so it's unit-testable
// without the native bridge. `useDeepLinks` wires it to Capacitor's
// `App.appUrlOpen` event on native and is a no-op on web (the listener never
// fires in a browser). Only an allowlisted set of hosts is honored — an
// unknown link resolves to null and is ignored, so a malicious link can't push
// the user to an arbitrary route.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Hosts we accept from a deep link → how to build the in-app path.
// Everything else is rejected (returns null).
const SCHEME = "iou:";

/**
 * Map a launch URL to an in-app path, or null if it isn't a link we handle.
 *
 * Examples:
 *   iou://sheet/abc123        → /sheet/abc123
 *   iou://pair/xyz            → /pair/xyz
 *   iou://pairs               → /pairs
 *   iou://settings            → /settings
 *   iou://join/ABCD-1234      → /pair/new?join=ABCD-1234
 *   iou://join?code=ABCD-1234 → /pair/new?join=ABCD-1234
 */
export function deepLinkToPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== SCHEME) return null;

  const host = url.host.toLowerCase();
  // pathname is like "/abc123" (may be empty) and is already percent-encoded by
  // the URL parser; decode to the raw value so the per-route encodeURIComponent
  // below single-encodes (not double-encodes). Bad encoding → reject.
  let rest: string;
  try {
    rest = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }

  switch (host) {
    case "sheet":
      return rest ? `/sheet/${encodeURIComponent(rest)}` : null;
    case "pair":
      return rest ? `/pair/${encodeURIComponent(rest)}` : null;
    case "pairs":
      return "/pairs";
    case "settings":
      return "/settings";
    case "me":
      return "/me";
    case "join": {
      // code may be in the path (iou://join/CODE) or query (?code=CODE)
      const code = rest || url.searchParams.get("code") || "";
      const clean = code.trim().toUpperCase();
      return clean ? `/pair/new?join=${encodeURIComponent(clean)}` : "/pair/new";
    }
    default:
      return null;
  }
}

/**
 * Register the native deep-link listener and navigate when one arrives.
 * No-op on web. Safe to mount once near the router root.
 */
export function useDeepLinks(): void {
  const navigate = useNavigate();
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      // Lazy import so the web bundle doesn't hard-require the native plugin.
      let App: typeof import("@capacitor/app").App;
      try {
        ({ App } = await import("@capacitor/app"));
      } catch {
        return; // plugin not available (pure web/dev) → nothing to listen to
      }
      const handle = await App.addListener("appUrlOpen", (event) => {
        const path = deepLinkToPath(event.url);
        if (path) navigate(path);
      });
      if (cancelled) handle.remove();
      else cleanup = () => void handle.remove();
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [navigate]);
}
