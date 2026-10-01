import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "../flows/useActor";
import { captureConsumerKeypairSession, configureConsumerKeypairBackend, loadExistingConsumerKeypair, loadOrCreateConsumerKeypair,
  type ConsumerKeypair, type ConsumerKeypairSession } from "./consumerKeypair";

type Keys = { ready: boolean; load: (allowProvision: boolean) => Promise<ConsumerKeypair> };
const DeliveryKeys = createContext<Keys | undefined>(undefined);

/** Shares the established account delivery key, never a sheet secret or a signed-out fallback. */
export function LocalDeliveryKeyProvider({ children }: { children: ReactNode }) {
  const { state, identity } = useAuth();
  const { actor } = useActor();
  const principal = state.kind === "authenticated" ? state.principal : undefined;
  const [ticket, setTicket] = useState<ConsumerKeypairSession>();
  const live = useRef({ principal, identity, actor, ticket });
  live.current = { principal, identity, actor, ticket };
  useEffect(() => {
    const signedIn = principal && identity && !identity.getPrincipal().isAnonymous() ? identity : null;
    configureConsumerKeypairBackend(signedIn);
    setTicket(signedIn ? captureConsumerKeypairSession(principal) : undefined);
    return () => { configureConsumerKeypairBackend(null); };
  }, [principal, identity]);
  async function load(allowProvision: boolean): Promise<ConsumerKeypair> {
    const captured = live.current;
    const assertCurrent = () => {
      if (!captured.principal || !captured.identity || !captured.actor || !captured.ticket ||
        live.current.principal !== captured.principal || live.current.identity !== captured.identity ||
        live.current.actor !== captured.actor || live.current.ticket !== captured.ticket) throw new Error("IOU delivery-key session changed");
      const current = captureConsumerKeypairSession(captured.principal);
      if (current.generation !== captured.ticket.generation) throw new Error("IOU delivery-key session expired");
    };
    assertCurrent();
    // Decryption must not create a replacement key merely because a recipient key is missing.
    if (!allowProvision) {
      const before = await captured.actor!.get_consumer_keypair();
      assertCurrent();
      if (!Array.isArray(before.keypair) || before.keypair.length !== 1) throw new Error("Reconnect IOU: its delivery key is unavailable");
    }
    const key = await (allowProvision ? loadOrCreateConsumerKeypair(captured.ticket!) : loadExistingConsumerKeypair(captured.ticket!));
    assertCurrent();
    // A stale secure cache may recover ordinary legacy work; it must not export/decrypt using a
    // key that differs from the current account's authoritative delivery public key.
    const state = await captured.actor!.get_consumer_keypair();
    assertCurrent();
    if (!Array.isArray(state.keypair) || state.keypair.length !== 1 || state.keypair[0]?.public_key_pem !== key.publicKeySpkiPem) {
      throw new Error("Reconnect IOU: its delivery key changed");
    }
    return key;
  }
  return <DeliveryKeys.Provider value={{ ready: !!principal && !!identity && !!actor && !!ticket && ticket.principal === principal, load }}>{children}</DeliveryKeys.Provider>;
}

export function useLocalDeliveryKey(): Keys {
  const keys = useContext(DeliveryKeys);
  if (!keys) throw new Error("Missing authenticated IOU delivery-key provider");
  return keys;
}
