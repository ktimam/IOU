import { describe, expect, it } from "vitest";
import { accountRootFingerprint, accountVaultScopeId, createAccountRecoveryCode, createAccountVaultPayload, createRecoveryBackup, createSheetKeyEnvelope, createSheetKeyId, decodeAccountVault, encodeAccountVault, openAccountVaultKeypair, openRecoveryBackup, openSheetKeyEnvelope, vaultB64, vaultUnb64, createManagedRecovery, openManagedRecoveryBackup, openManagedRecoverySecret, managedRecoveryCredentialId, validateManagedRecoveryOrigin, type AccountVaultScope, type SheetKeyEnvelopeContext } from "./accountVaultCrypto";

const scope: AccountVaultScope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
const root = new Uint8Array(32).fill(7);

describe("account vault cryptographic boundaries", () => {
  it("roundtrips the same high-entropy managed secret without plaintext in its payload", async () => {
    const { managedRecovery, secret } = await createManagedRecovery(root, scope);
    expect(secret).toMatch(/^IOU1-[A-Za-z0-9_-]{43}$/);
    expect(await openManagedRecoveryBackup(managedRecovery, scope, secret)).toEqual(root);
    expect(await openManagedRecoverySecret(managedRecovery, root, scope)).toBe(secret);
    const payload = { ...await createAccountVaultPayload(root, scope), managedRecovery };
    const serialized = encodeAccountVault(payload);
    expect(new TextDecoder().decode(serialized)).not.toContain(secret);
    expect(new TextDecoder().decode(serialized)).not.toContain(vaultB64(root));
    expect(decodeAccountVault(serialized, scope)).toEqual(payload);
    const username = await managedRecoveryCredentialId(scope, managedRecovery.id);
    expect(username).toMatch(/^iou-recovery-[A-Za-z0-9_-]{43}$/);
    expect(username).not.toContain(secret);
    expect(await managedRecoveryCredentialId({ ...scope, principal: "bob" }, managedRecovery.id)).not.toBe(username);
  });
  it("binds managed ciphertexts to backup ID, account scope and distinct purposes", async () => {
    const { managedRecovery, secret } = await createManagedRecovery(root, scope);
    const other = await createManagedRecovery(root, scope);
    for (const altered of [{ ...managedRecovery, id: other.managedRecovery.id }, { ...managedRecovery, backup: managedRecovery.protectedSecret }]) {
      await expect(openManagedRecoveryBackup(altered, scope, secret)).rejects.toThrow();
      await expect(openManagedRecoverySecret(altered, root, scope)).rejects.toThrow();
    }
    for (const changed of [{ ...scope, principal: "bob" }, { ...scope, canisterId: "other" }, { ...scope, host: "https://other.example" }]) {
      await expect(openManagedRecoveryBackup(managedRecovery, changed, secret)).rejects.toThrow();
      await expect(openManagedRecoverySecret(managedRecovery, root, changed)).rejects.toThrow();
    }
    await expect(openRecoveryBackup(managedRecovery.backup, scope, secret)).rejects.toThrow();
    await expect(openManagedRecoveryBackup(managedRecovery, scope, " " + secret)).rejects.toThrow();
    await expect(openManagedRecoverySecret(managedRecovery, new Uint8Array(32).fill(4), scope)).rejects.toThrow();
  });
  it("validates managed-record bounds while retaining payloads with no managed backup", async () => {
    const payload = await createAccountVaultPayload(root, scope);
    expect(decodeAccountVault(encodeAccountVault(payload), scope).managedRecovery).toBeUndefined();
    const { managedRecovery } = await createManagedRecovery(root, scope);
    for (const changed of [
      { ...managedRecovery, id: "bad" },
      { ...managedRecovery, backup: { ...managedRecovery.backup, iv: "" } },
      { ...managedRecovery, protectedSecret: { ...managedRecovery.protectedSecret, ciphertext: "" } },
      { ...managedRecovery, verifiedOrigins: ["https://iou.example", "https://iou.example"] },
      { ...managedRecovery, verifiedOrigins: Array.from({ length: 17 }, (_, i) => `https://${i}.example`) },
      { ...managedRecovery, verifiedOrigins: ["http://public.example"] },
    ]) expect(() => decodeAccountVault(encodeAccountVault({ ...payload, managedRecovery: changed }), scope)).toThrow();
  });
  it("accepts only canonical secure or local app origins", () => {
    for (const origin of ["https://iou.example", "https://iou.example:9443", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) expect(validateManagedRecoveryOrigin(origin)).toBe(origin);
    for (const origin of ["http://iou.example", "https://iou.example/", "https://iou.example/path", "https://user:pass@iou.example", "null", "javascript:alert(1)"]) expect(() => validateManagedRecoveryOrigin(origin)).toThrow();
  });
  it("roundtrips an encrypted dedicated keypair without putting root or private plaintext in its payload", async () => {
    const payload = await createAccountVaultPayload(root, scope);
    const pair = await openAccountVaultKeypair(decodeAccountVault(encodeAccountVault(payload), scope), root, scope);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.keyId).toBe(payload.sheetKey.keyId);
    expect(vaultUnb64(pair.publicKeyB64)).toHaveLength(65);
    expect(new TextDecoder().decode(encodeAccountVault(payload))).not.toContain(vaultB64(root));
    await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
  });
  it("separates users, canisters, hosts and purposes", async () => {
    const payload = await createAccountVaultPayload(root, scope);
    for (const other of [{ ...scope, principal: "bob" }, { ...scope, canisterId: "other" }, { ...scope, host: "http://localhost:4943" }]) {
      expect(await accountRootFingerprint(root, other)).not.toBe(payload.rootFingerprint);
      expect(() => decodeAccountVault(encodeAccountVault(payload), other)).toThrow();
      await expect(openAccountVaultKeypair(payload, root, other)).rejects.toThrow();
    }
    expect(() => accountVaultScopeId({ ...scope, principal: "2vxsx-fae" })).toThrow(/sign in/i);
  });
  it("rejects wrong root and tampered public/private key records", async () => {
    const payload = await createAccountVaultPayload(root, scope);
    await expect(openAccountVaultKeypair(payload, new Uint8Array(32).fill(8), scope)).rejects.toThrow(/root/);
    const damaged = structuredClone(payload);
    const ct = vaultUnb64(damaged.sheetKey.privateKey.ciphertext); ct[0] ^= 1;
    damaged.sheetKey.privateKey.ciphertext = vaultB64(ct);
    await expect(openAccountVaultKeypair(damaged, root, scope)).rejects.toThrow();
    const other = await createAccountVaultPayload(root, scope);
    await expect(openAccountVaultKeypair({ ...payload, sheetKey: { ...payload.sheetKey, publicKeyB64: other.sheetKey.publicKeyB64 } }, root, scope)).rejects.toThrow(/fingerprint/);
  });
  it("creates a high-entropy code backup and refuses wrong code or deployment", async () => {
    const code = createAccountRecoveryCode();
    expect(code).toMatch(/^IOU1-[A-Za-z0-9_-]{43}$/);
    const backup = await createRecoveryBackup(root, scope, code);
    expect(await openRecoveryBackup(backup, scope, code)).toEqual(root);
    await expect(openRecoveryBackup(backup, scope, createAccountRecoveryCode())).rejects.toThrow();
    await expect(openRecoveryBackup(backup, { ...scope, principal: "bob" }, code)).rejects.toThrow();
    await expect(openRecoveryBackup(backup, scope, "123456")).rejects.toThrow();
  });
  it("encrypts a sheet key for its recipient and authenticates every context field", async () => {
    const payload = await createAccountVaultPayload(root, scope);
    const pair = await openAccountVaultKeypair(payload, root, scope);
    const context: SheetKeyEnvelopeContext = { version: 1, pairId: "pair-a", keyId: createSheetKeyId(), recipientPrincipal: "alice", recipientKeyId: pair.keyId };
    const key = new Uint8Array(32).fill(19);
    const envelope = await createSheetKeyEnvelope(key, pair.publicKeyB64, context);
    expect(await openSheetKeyEnvelope(envelope, pair.privateKey, context)).toEqual(key);
    expect(await createSheetKeyEnvelope(key, pair.publicKeyB64, context)).not.toBe(envelope);
    for (const field of ["pairId", "keyId", "recipientPrincipal", "recipientKeyId"] as const) {
      await expect(openSheetKeyEnvelope(envelope, pair.privateKey, { ...context, [field]: "different" })).rejects.toThrow();
    }
    const other = await createAccountVaultPayload(root, scope);
    const otherPair = await openAccountVaultKeypair(other, root, scope);
    await expect(openSheetKeyEnvelope(envelope, otherPair.privateKey, context)).rejects.toThrow();
    await expect(createSheetKeyEnvelope(key, otherPair.publicKeyB64, context)).rejects.toThrow(/fingerprint/);
    const prefix = "iou-sheet-envelope-v1:";
    const parsed = JSON.parse(new TextDecoder().decode(vaultUnb64(envelope.slice(prefix.length))));
    expect(parsed).toMatchObject(context);
    parsed.pairId = "different";
    const swapped = prefix + vaultB64(new TextEncoder().encode(JSON.stringify(parsed)));
    await expect(openSheetKeyEnvelope(swapped, pair.privateKey, context)).rejects.toThrow();
  });
  it("rejects unsupported or oversized payloads", () => {
    expect(() => decodeAccountVault(new Uint8Array(65537), scope)).toThrow(/large/);
    expect(() => decodeAccountVault(new TextEncoder().encode('{"version":2}'), scope)).toThrow();
  });
});
