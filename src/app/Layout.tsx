import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../features/auth/AuthProvider";
import { usePreferences } from "../features/settings/usePreferences";

// Persistent username badge shown top-right of every page. It doubles as the
// settings entry point (tap → /settings, the merged profile+settings hub), so
// the accounts page no longer needs its own Settings button. Hidden until you're
// signed in (nothing to show, and /settings requires auth).
function UserBadge() {
  const { state } = useAuth();
  const { prefs } = usePreferences();
  const nav = useNavigate();
  if (state.kind !== "authenticated") return null;
  const name = prefs.profileName.trim();
  const initial = (name || "?").slice(0, 1).toUpperCase();
  return (
    <div className="topbar">
      <button
        className="user-badge"
        onClick={() => nav("/settings")}
        title="Profile & settings"
      >
        <span className="user-badge-avatar" aria-hidden>
          {initial}
        </span>
        <span className="user-badge-name">{name || "Set username"}</span>
      </button>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <UserBadge />
      {children}
    </div>
  );
}
