import React from "react";
import ReactDOM from "react-dom/client";
import { LocalConnectPage } from "./features/openchat/LocalConnectPage";
import "./styles/global.css";

// Separate physical document for the APK setup frame. Reuse the normal connection
// UI and its consent/authentication checks, never the main SPA's routes/providers.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocalConnectPage />
  </React.StrictMode>,
);
