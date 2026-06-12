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
import { RecoveryKeyPage } from "../features/recovery/RecoveryKeyPage";
import { ToastProvider } from "../features/ui/Toasts";

export function App() {
  return (
    <AuthProvider>
      <SheetKeyProvider>
        <ToastProvider>
          <Layout>
            <Routes>
              <Route path="/" element={<Hello />} />
              <Route path="/sign-in" element={<SignIn />} />
              <Route path="/set-name" element={<SetDisplayName />} />
              <Route path="/pairs" element={<Pairs />} />
              <Route path="/pair/new" element={<NewPair />} />
              <Route path="/pair/:pairId" element={<Pair />} />
              <Route path="/sheet/new" element={<NewSheet />} />
              <Route path="/sheet/:sheetId" element={<SheetPage />} />
              <Route
                path="/pair/:pairId/archived"
                element={<ArchivedSheetsPage />}
              />
              <Route path="/recovery-key" element={<RecoveryKeyPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        </ToastProvider>
      </SheetKeyProvider>
    </AuthProvider>
  );
}
