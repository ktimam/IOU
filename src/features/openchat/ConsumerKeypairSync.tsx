// Wires the signed-in identity into consumerKeypair.ts so the OpenChat
// consumer keypair is canister-backed and provisioned automatically on
// first load — auto-created + vetkd-wrapped with no user action, and
// recovered from the canister on a new device. Renders nothing; mounted
// once in App (inside AuthProvider), mirroring the DeepLinks pattern.

import { useEffect } from "react";
import { useAuth } from "../auth/AuthProvider";
import { configureConsumerKeypairBackend, loadOrCreateConsumerKeypair } from "./consumerKeypair";

export function ConsumerKeypairSync() {
  const { identity, state } = useAuth();

  useEffect(() => {
    const authed = state.kind === "authenticated" && identity ? identity : null;
    configureConsumerKeypairBackend(authed);
    if (authed) {
      // Fire-and-forget: recover (or create + wrap + upload) the keypair so
      // it exists before any OpenChat flow needs it. Failures are non-fatal
      // — the next loadOrCreateConsumerKeypair() call retries.
      void loadOrCreateConsumerKeypair().catch((e) => {
        console.warn("[ConsumerKeypairSync] keypair provisioning failed:", e);
      });
    }
  }, [identity, state.kind]);

  return null;
}
