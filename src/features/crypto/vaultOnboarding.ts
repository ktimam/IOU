import { getAccountVaultSheetKeypair, loadAccountRoot, loadAccountVault,
  readAccountVaultSessionGeneration, assertAccountVaultSessionGeneration,
  VaultUnlockRequiredError, isAccountPasskeyEnrollmentRequired, type AccountVaultActor } from "./accountVault";
import { accountVaultScope, recoverAccountVaultPaid } from "./vaultAccess";
import { validateManagedRecoveryOrigin } from "./accountVaultCrypto";

export type VaultOnboardingState = "setup" | "unlock" | "recovery" | "ready";

/** Only a confirmed absent vault may bootstrap automatically. Missing device keys
 * are an unlock condition, never permission to purchase emergency recovery. */
export async function prepareVaultOnboarding(actor: AccountVaultActor, principal: string, origin: string,
  allowInitialSetup: boolean, isCurrent: () => boolean = () => true,
  onInitialSetup: () => void = () => {}): Promise<VaultOnboardingState> {
  validateManagedRecoveryOrigin(origin);
  const generation = readAccountVaultSessionGeneration();
  const current = () => {
    assertAccountVaultSessionGeneration(generation);
    if (!isCurrent()) throw new Error("Account session changed");
  };
  const scope = accountVaultScope(principal);
  let record = await loadAccountVault(actor, scope);
  current();
  if (!record) {
    if (!allowInitialSetup) return "setup";
    onInitialSetup();
    await recoverAccountVaultPaid(actor, principal, false);
    current();
    record = await loadAccountVault(actor, scope);
    current();
    if (!record) throw new Error("Account encryption setup could not be confirmed. Retry to check the same setup request.");
  }
  try {
    const root = await loadAccountRoot(actor, scope);
    try {
      current();
      if (!root) throw new Error("Account encryption changed. Retry to check its saved state.");
    } finally { root?.fill(0); }
  } catch (cause) {
    current();
    if (cause instanceof VaultUnlockRequiredError) return "unlock";
    throw cause;
  }
  await getAccountVaultSheetKeypair(actor, scope);
  current();
  // A provider prompt alone is not proof that its backup reached IOU.
  record = await loadAccountVault(actor, scope);
  current();
  if (!record) throw new Error("Account encryption backup could not be confirmed.");
  const replacementRequired = await isAccountPasskeyEnrollmentRequired(scope);
  current();
  if (replacementRequired) return "recovery";
  const verifiedManager = record.payload.managedRecovery?.verifiedOrigins.includes(origin) === true;
  return verifiedManager ? "ready" : "recovery";
}
