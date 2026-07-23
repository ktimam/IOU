import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider} from "../features/auth/AuthProvider";
import {SignIn} from "../features/auth/SignIn";
import {SetDisplayName} from "../features/auth/SetDisplayName";
import {Hello} from "../features/auth/Hello";
import {Layout} from "./Layout";
import {Pairs} from "../features/flows/Pairs";
import {NewPair} from "../features/flows/NewPair";
import {Pair} from "../features/flows/Pair";
import {NewSheet} from "../features/flows/NewSheet";
import { SheetKeyProvider } from "../features/flows/SheetKeyContext";
import { SheetPage } from "../features/entries/SheetPage";
import { ArchivedSheetsPage } from "../features/entries/ArchivedSheetsPage";
import { ToastProvider } from "../features/ui/Toasts";
import { ErrorBoundary } from "./ErrorBoundary";
import { PreferencesProvider } from "../features/settings/usePreferences";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TemplatesProvider } from "../features/templates/TemplatesContext";
import { ConsumerKeypairSync } from "../features/openchat/ConsumerKeypairSync";
import { ManifestTypesSync } from "../features/openchat/ManifestTypesSync";
import { EmbeddedBanner } from "../features/openchat/EmbeddedBanner";
import { LinkChatPage } from "../features/openchat/LinkChatPage";
import { AcceptInvitePage } from "../features/invite/AcceptInvitePage";
import { useDeepLinks } from "../features/deeplinks/deepLink";

// Registers the native deep-link listener (no-op on web). Lives inside the
// router so it can navigate; renders nothing.
function DeepLinks() {
  useDeepLinks();
  return null;
}

export function App() {
  return (
    <AuthProvider>
      <PreferencesProvider>
      <TemplatesProvider>
      <SheetKeyProvider>
        <ToastProvider>
          <Layout>
            <ErrorBoundary>
            <DeepLinks />
            <ConsumerKeypairSync />
            {/* App-load OpenChat manifest re-sync from ACCOUNT-SCOPED types
                (needs the sheet-key unwrapper, so it lives inside
                SheetKeyProvider — see ManifestTypesSync). */}
            <ManifestTypesSync />
            <EmbeddedBanner />
            <Routes>
              <Route path="/" element={<Hello />} />
              {/* /me is merged into /settings — keep the path (deep link iou://me)
                  as a redirect. */}
              <Route path="/me" element={<Navigate to="/settings" replace />} />
              <Route path="/sign-in" element={<SignIn />} />
              <Route path="/set-name" element={<SetDisplayName />} />
              <Route path="/pairs" element={<Pairs />} />
              <Route path="/pair/new" element={<NewPair />} />
              {/* invite-link accept surface (fragment carries the secret) */}
              <Route path="/pair/accept" element={<AcceptInvitePage />} />
              <Route path="/pair/:pairId" element={<Pair />} />
              <Route path="/sheet/new" element={<NewSheet />} />
              <Route path="/sheet/:sheetId" element={<SheetPage />} />
              <Route
                path="/pair/:pairId/archived"
                element={<ArchivedSheetsPage />}
              />
              <Route path="/settings" element={<SettingsPage />} />
              {/* OpenChat "chat_link" surface: opened by OpenChat (in a bottom-sheet
                  iframe) with ?chat=<chatKey> to map that chat to a sheet. */}
              <Route path="/openchat/link-chat" element={<LinkChatPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </ErrorBoundary>
          </Layout>
        </ToastProvider>
      </SheetKeyProvider>
      </TemplatesProvider>
      </PreferencesProvider>
    </AuthProvider>
  );
}
