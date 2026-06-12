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

export function App() {
  return (
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Hello />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/set-name" element={<SetDisplayName />} />
          <Route path="/pairs" element={<Pairs />} />
          <Route path="/pair/new" element={<NewPair />} />
          <Route path="/pair/:pairId" element={<Pair />} />
          <Route path="/sheet/new" element={<NewSheet />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthProvider>
  );
}
