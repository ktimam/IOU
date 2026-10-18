import React from "react";
import ReactDOM from "react-dom/client";
import { LocalConnectPage } from "./features/openchat/LocalConnectPage";
import "./styles/global.css";

// Separate top-level IOU connection document. Sign-in, storage and autofill use
// IOU's own origin; the code flow never runs inside a client-owned setup frame.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocalConnectPage />
  </React.StrictMode>,
);
