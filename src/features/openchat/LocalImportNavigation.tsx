import { createContext, useContext, type ReactNode } from "react";

// Only the authenticated /openchat/import sheet is framed. Ordinary IOU routes keep their
// existing navigation; never relax their frame-ancestors policy to follow a link from here.
const LocalImportNavigation = createContext(false);

export function LocalImportNavigationProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <LocalImportNavigation.Provider value={enabled}>{children}</LocalImportNavigation.Provider>;
}

export function useLocalImportNavigation(): boolean { return useContext(LocalImportNavigation); }

export function localImportNavigationUrl(path: string, origin: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid IOU navigation");
  const destination = new URL(path, origin);
  if (destination.origin !== origin || destination.username || destination.password) throw new Error("Invalid IOU navigation");
  return destination.href;
}

/** Invoke only from the existing user click. Carries a route, never identity/session or fields. */
export function openLocalImportNavigation(path: string): void {
  window.open(localImportNavigationUrl(path, window.location.origin), "_blank", "noopener,noreferrer");
}
