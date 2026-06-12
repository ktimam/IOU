import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "../features/auth/AuthProvider";
import { SignIn } from "../features/auth/SignIn";
import { SetDisplayName } from "../features/auth/SetDisplayName";
import { Hello } from "../features/auth/Hello";
import { Layout } from "./Layout";

export function App() {
  return (
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Hello />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/set-name" element={<SetDisplayName />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthProvider>
  );
}
