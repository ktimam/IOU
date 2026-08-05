import { describe, expect, it } from "vitest";
import { encryptTemplateRef } from "./templateRef";
import {
  restoreOpenChatTemplateRefs,
  type OpenChatTemplateRefContext,
} from "./templateRefImport";

const KEY = new Uint8Array(32).map((_, index) => index + 1);
const OTHER_KEY = new Uint8Array(32).fill(99);
const CONTEXT: OpenChatTemplateRefContext = {
  sheetId: "000000000000002a",
  contextVersion: 1,
  appSubject: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
  chatHandle: Buffer.from(new Uint8Array(32).fill(2)).toString("base64url"),
  messageHandle: Buffer.from(new Uint8Array(32).fill(3)).toString("base64url"),
  appId: 17,
  appRevision: 23n,
  actionId: "expense.import",
};

async function reference(templateId: string, entryIndex = 0): Promise<string> {
  return encryptTemplateRef(templateId, KEY, { ...CONTEXT, entryIndex });
}

describe("restoreOpenChatTemplateRefs", () => {
  it("restores one authenticated private type id without mutating the inbox payload", async () => {
    const input = {
      amount: 100,
      note: "reservation",
      template_ref: await reference("private-reservation-id"),
    };
    const restored = (await restoreOpenChatTemplateRefs(input, KEY, CONTEXT)) as Record<string, unknown>;
    expect(restored.template).toBe("private-reservation-id");
    expect("template_ref" in restored).toBe(false);
    expect(input).not.toHaveProperty("template");
    expect(input).toHaveProperty("template_ref");
  });

  it("restores different types independently by exact multi-card row", async () => {
    const input = [
      { amount: 100, template_ref: await reference("private-a", 0) },
      { amount: 200 },
      { amount: 300, template_ref: await reference("private-b", 2) },
    ];
    const restored = (await restoreOpenChatTemplateRefs(input, KEY, CONTEXT)) as Record<string, unknown>[];
    expect(restored.map((row) => row.template)).toEqual(["private-a", undefined, "private-b"]);
    expect(restored.every((row) => !("template_ref" in row))).toBe(true);
  });

  it("strips an untrusted plaintext template when no encrypted reference exists", async () => {
    const restored = (await restoreOpenChatTemplateRefs(
      { amount: 100, template: "foreign-account-type" },
      KEY,
      CONTEXT,
    )) as Record<string, unknown>;
    expect("template" in restored).toBe(false);
  });

  it("requires authenticated card provenance whenever a template reference is present", async () => {
    const withReference = { amount: 100, template_ref: await reference("private-a") };
    await expect(restoreOpenChatTemplateRefs(withReference, KEY)).rejects.toThrow(
      "invalid encrypted account type selection",
    );
    const stripped = (await restoreOpenChatTemplateRefs(
      { amount: 100, template: "untrusted-name" },
      KEY,
    )) as Record<string, unknown>;
    expect("template" in stripped).toBe(false);
  });

  it("lets a valid encrypted selection replace an injected plaintext field", async () => {
    const restored = (await restoreOpenChatTemplateRefs(
      {
        amount: 100,
        template: "attacker-choice",
        template_ref: await reference("authenticated-choice"),
      },
      KEY,
      CONTEXT,
    )) as Record<string, unknown>;
    expect(restored.template).toBe("authenticated-choice");
  });

  it("rejects a type that was deleted from the current account before import", async () => {
    const input = { template_ref: await reference("deleted-private-id") };
    await expect(
      restoreOpenChatTemplateRefs(input, KEY, CONTEXT, new Set(["still-current-id"])),
    ).rejects.toThrow("invalid encrypted account type selection");
    const restored = (await restoreOpenChatTemplateRefs(
      input,
      KEY,
      CONTEXT,
      new Set(["deleted-private-id"]),
    )) as Record<string, unknown>;
    expect(restored.template).toBe("deleted-private-id");
  });

  it("fails closed for the wrong sheet key or card coordinates", async () => {
    const input = { amount: 100, template_ref: await reference("private-a") };
    await expect(restoreOpenChatTemplateRefs(input, OTHER_KEY, CONTEXT)).rejects.toThrow(
      "invalid encrypted account type selection",
    );
    await expect(
      restoreOpenChatTemplateRefs(input, KEY, { ...CONTEXT, sheetId: "000000000000002b" }),
    ).rejects.toThrow("invalid encrypted account type selection");
    await expect(
      restoreOpenChatTemplateRefs(input, KEY, {
        ...CONTEXT,
        chatHandle: Buffer.from(new Uint8Array(32).fill(4)).toString("base64url"),
      }),
    ).rejects.toThrow("invalid encrypted account type selection");
    await expect(
      restoreOpenChatTemplateRefs(input, KEY, {
        ...CONTEXT,
        messageHandle: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url"),
      }),
    ).rejects.toThrow("invalid encrypted account type selection");
  });

  it("rejects moving a valid reference between multi-card rows", async () => {
    const rowOneReference = await reference("private-a", 1);
    await expect(
      restoreOpenChatTemplateRefs([{ template_ref: rowOneReference }], KEY, CONTEXT),
    ).rejects.toThrow("invalid encrypted account type selection");
  });

  it("rejects malformed references, non-string references, and oversized batches", async () => {
    await expect(
      restoreOpenChatTemplateRefs({ template_ref: "ioutr1.invalid=" }, KEY, CONTEXT),
    ).rejects.toThrow("invalid encrypted account type selection");
    await expect(
      restoreOpenChatTemplateRefs({ template_ref: 123 }, KEY, CONTEXT),
    ).rejects.toThrow("invalid encrypted account type selection");
    await expect(
      restoreOpenChatTemplateRefs(Array.from({ length: 101 }, () => ({})), KEY, CONTEXT),
    ).rejects.toThrow("invalid encrypted account type selection");
  });
});
