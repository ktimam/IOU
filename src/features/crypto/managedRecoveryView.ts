import { prepareManagedRecovery, readManagedRecoveryDescriptor, type AccountVaultActor,
  type AccountVaultScope, type ManagedRecoveryDescriptor } from "./accountVault";

export interface ManagedRecoveryView {
  descriptor: ManagedRecoveryDescriptor | null;
  prepared?: ManagedRecoveryDescriptor & { secret: string };
}

/** One visit checks the backup, then prepares only missing/unverified recovery on
 * an unlocked device. This never opens a password manager or verifies on its own. */
export async function loadManagedRecoveryView(actor: AccountVaultActor, scope: AccountVaultScope,
  origin: string, unlocked: boolean, current: () => void,
  preparing: () => void = () => {}): Promise<ManagedRecoveryView> {
  current();
  const descriptor = await readManagedRecoveryDescriptor(actor, scope, origin);
  current();
  if (!unlocked || descriptor?.verified) return { descriptor };
  preparing();
  current();
  const prepared = await prepareManagedRecovery(actor, scope, origin);
  current();
  // Another live view may have completed verification while this view was checking.
  if (prepared.verified) return { descriptor: { credentialId: prepared.credentialId, verified: true } };
  return { descriptor: { credentialId: prepared.credentialId, verified: prepared.verified }, prepared };
}
