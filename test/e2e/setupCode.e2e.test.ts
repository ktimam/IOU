// Live local-canister transport acceptance. Reuses the strict explicit loopback target guard.
// Fresh identities and synthetic encrypted documents only: no users, sheets, grants, inbox
// entries, sign-in providers or threshold-key recovery are created/invoked. The row is cancelled.
import { AnonymousIdentity } from "@dfinity/agent";
import { expect, it } from "vitest";
import { createSetupCode, decryptSetupCode, encryptSetupCode } from "../../src/features/openchat/appSetupCodeCrypto";
import { claimLocalSetupCode, type SetupCodeActor } from "../../src/features/openchat/localSetupCode";
import { describeE2E, freshIdentity, iouActor } from "./localBatchEnv";

describeE2E("IOU backend — app-owned encrypted setup code", () => {
  it("admits authenticated updates, binds claimant, preserves exact retry result, and cleans up", async () => {
    const creator = await iouActor(freshIdentity()) as any;
    const claimant = await iouActor(freshIdentity()) as any;
    const outsider = await iouActor(freshIdentity()) as any;
    const anonymous = await iouActor(new AnonymousIdentity()) as any;
    const material = await createSetupCode();
    const setupUrl = "http://localhost:3000/openchat/connect";
    const expiresAtMs = Date.now() + 180_000;
    const context = { version: 2 as const, scope: "account" as const, routes: [] };
    const plaintext = JSON.stringify({ version: 1, appId: "iou", setupUrl,
      clientOrigin: "http://localhost:5190", expiresAtMs, setupContext: context });
    const encryptedContext = await encryptSetupCode(material.code, "context", plaintext);
    const request = { request_id: material.requestId, claim_hash: material.claimHash,
      encrypted_context: encryptedContext, expires_at_ms: BigInt(expiresAtMs) };
    let session: Awaited<ReturnType<typeof claimLocalSetupCode>> | undefined;
    try {
      await expect(anonymous.create_app_setup_code(request)).rejects.toThrow(/anonymous/i);
      expect(await creator.create_app_setup_code(request)).toEqual({ Ok: { expires_at_ms: BigInt(expiresAtMs) } });
      expect(await creator.create_app_setup_code(request)).toEqual({ Ok: { expires_at_ms: BigInt(expiresAtMs) } });
      expect(await creator.poll_app_setup_code(material.requestId)).toEqual({ Ok: { Waiting: { expires_at_ms: BigInt(expiresAtMs) } } });
      for (const actor of [claimant, outsider]) {
        expect(await actor.poll_app_setup_code(material.requestId)).toHaveProperty("Err");
        expect(await actor.cancel_app_setup_code(material.requestId)).toHaveProperty("Err");
      }
      await expect(anonymous.claim_app_setup_code(material.requestId, material.claimSecret)).rejects.toThrow(/anonymous/i);
      expect(await outsider.claim_app_setup_code(material.requestId, material.claimHash)).toHaveProperty("Err");
      session = await claimLocalSetupCode({ code: material.code, actor: claimant as SetupCodeActor,
        setupUrl, assertCurrent() {} });
      expect(session.context).toEqual(context);
      expect(session.clientOrigin).toBe("http://localhost:5190");
      expect(await creator.poll_app_setup_code(material.requestId)).toEqual({ Ok: { Claimed: { expires_at_ms: BigInt(expiresAtMs) } } });
      expect(await outsider.claim_app_setup_code(material.requestId, material.claimSecret)).toHaveProperty("Err");
      const syntheticResult = JSON.stringify({ version: 2, scope: "account", appId: "iou", accountId: "A".repeat(43),
        catalogJson: JSON.stringify({ syntheticTransportOnly: true }), routes: [] });
      await session.sendResult(syntheticResult);
      const first = await creator.poll_app_setup_code(material.requestId);
      expect(first).toHaveProperty("Ok.Completed");
      const completion = first.Ok.Completed;
      const encryptedResult = Uint8Array.from(completion.encrypted_result as number[]);
      const decrypted = JSON.parse(await decryptSetupCode(material.code, "result", encryptedResult));
      expect(decrypted).toEqual({ version: 1, appId: "iou", setupUrl, requestId: material.requestId, catalogJson: syntheticResult });
      await expect(decryptSetupCode(material.code, "context", encryptedResult)).rejects.toThrow();
      expect(await claimant.complete_app_setup_code(material.requestId, material.claimSecret, encryptedResult))
        .toEqual({ Ok: { expires_at_ms: BigInt(expiresAtMs) } });
      // A page reload/re-entered completed code must fail before a setup session can
      // reach app-owned preparation (which can write grants and chat mappings).
      let restartedSetup = false;
      await expect(claimLocalSetupCode({ code: material.code, actor: claimant as SetupCodeActor,
        setupUrl, assertCurrent() {} }).then(reopened => {
        restartedSetup = true; reopened.close();
      })).rejects.toThrow();
      expect(restartedSetup).toBe(false);
      expect(await creator.poll_app_setup_code(material.requestId)).toEqual(first);
      const conflicting = await encryptSetupCode(material.code, "result", "different synthetic reply");
      expect(await claimant.complete_app_setup_code(material.requestId, material.claimSecret, conflicting)).toHaveProperty("Err");
      expect(await outsider.complete_app_setup_code(material.requestId, material.claimSecret, encryptedResult)).toHaveProperty("Err");
      expect(await creator.poll_app_setup_code(material.requestId)).toEqual(first);
      await expect(anonymous.complete_app_setup_code(material.requestId, material.claimSecret, encryptedResult)).rejects.toThrow(/anonymous/i);
      await expect(anonymous.poll_app_setup_code(material.requestId)).rejects.toThrow(/anonymous/i);
      await expect(anonymous.cancel_app_setup_code(material.requestId)).rejects.toThrow(/anonymous/i);
      expect(await creator.cancel_app_setup_code(material.requestId)).toEqual({ Ok: true });
      expect(await creator.cancel_app_setup_code(material.requestId)).toEqual({ Ok: false });
      expect(await creator.poll_app_setup_code(material.requestId)).toHaveProperty("Err");
      expect(await claimant.claim_app_setup_code(material.requestId, material.claimSecret)).toHaveProperty("Err");
    } finally {
      session?.close();
      material.claimSecret.fill(0);
      const cleanup = await creator.cancel_app_setup_code(material.requestId);
      expect(cleanup).toHaveProperty("Ok");
    }
  }, 120_000);
});
