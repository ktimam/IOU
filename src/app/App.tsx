import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "../features/auth/AuthProvider";
import { authSessionScope } from "../features/auth/sessionIsolation";
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
import { DefaultCurrencySync } from "../features/settings/DefaultCurrencySync";
import { ManifestTypesSync } from "../features/openchat/ManifestTypesSync";
import { EmbeddedBanner } from "../features/openchat/EmbeddedBanner";
import { OpenChatCardPage } from "../features/openchat/OpenChatCardPage";
import { OpenChatPrivateMatchPage } from "../features/openchat/OpenChatPrivateMatchPage";
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
    <Routes>
      {/* OpenChat anonymous surfaces: IOU's confirmable card and private matcher, embedded by
          OpenChat as a storage-partitioned iframe in the chat bubble. It has NO
          IOU session (partitioned cross-origin), so it renders OUTSIDE every
          auth/session provider — it only renders + collects values over the
          postMessage bridge and never touches the canister or identity. Kept as
          siblings of the splat below so neither mounts AuthProvider et al. */}
      <Route path="/openchat/card" element={<OpenChatCardPage />} />
      <Route path="/openchat/private-match" element={<OpenChatPrivateMatchPage />} />
      <Route path="/*" element={<AuthedApp />} />
    </Routes>
  );
}

// The full, session-backed IOU app: everything below lives inside the auth and
// data providers. Rendered for every route except the two anonymous OpenChat surfaces above.
function AuthedApp() {
  return (
    <AuthProvider>
      <AuthenticatedSession />
    </AuthProvider>
  );
}

function AuthenticatedSession() {
  const { state } = useAuth();
  const scope = authSessionScope(
    state.kind,
    state.kind === "authenticated" ? state.principal : undefined,
  );
  return <SessionProviders key={scope} />;
}

function SessionProviders() {
  return (
      <PreferencesProvider>
      <TemplatesProvider>
      <SheetKeyProvider>
        <ToastProvider>
          <Layout>
            <ErrorBoundary>
            <DeepLinks />
            <ConsumerKeypairSync />
            {/* Pulls the user's ONE default currency from the canister (and pushes a
                browser-only value up once), so it follows them across devices. */}
            <DefaultCurrencySync />
            {/* Refreshes IOU's static public OpenChat manifest. Private
                account templates never enter registration. */}
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
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </ErrorBoundary>
          </Layout>
        </ToastProvider>
      </SheetKeyProvider>
      </TemplatesProvider>
      </PreferencesProvider>
  );
}
