// Shown when IOU is running inside another app's iframe (e.g. OpenChat's in-window browser
// opening our "home" surface). Browsers PARTITION third-party iframe storage by the host origin,
// so this copy has its own, initially-empty storage: it can never see the first-party browser
// session, and signing in here mints a SEPARATE sandboxed identity — a different principal whose
// pairs/sheets are invisible to the real account (and vice versa). Warn up front so nobody signs
// in and creates orphaned data without realizing.

function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on window.top access — which itself proves we're embedded.
    return true;
  }
}

export function EmbeddedBanner() {
  if (!isEmbedded()) return null;
  return (
    <div
      role="note"
      style={{
        background: "rgba(255, 193, 7, 0.15)",
        border: "1px solid rgba(255, 193, 7, 0.5)",
        borderRadius: 8,
        padding: "8px 12px",
        margin: "8px 0",
        fontSize: "0.85rem",
        lineHeight: 1.4,
      }}
    >
      You're viewing IOU <strong>embedded inside another app</strong>. This is a separate, sandboxed
      session — signing in here creates a <strong>different account</strong> from the one in your
      browser. For your real account, use the host's <em>"Open in browser"</em> button.
    </div>
  );
}
