import { decryptEntryPayload, encryptEntryPayload } from "../crypto/devVetkd";

const MAX_CLOSING_BALANCES = 64;

export type ClosingBalanceSnapshot = {
  currency: string;
  amount_minor: number;
  direction: "credit" | "debt";
};

export type EncryptedClosingBalances = {
  entry_key: number[];
  ciphertext: number[];
  iv: number[];
};

function validateClosingBalances(value: unknown): ClosingBalanceSnapshot[] {
  if (!Array.isArray(value) || value.length > MAX_CLOSING_BALANCES) {
    throw new Error("invalid closing balance snapshot");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid closing balance");
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.currency !== "string" ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      seen.has(row.currency) ||
      typeof row.amount_minor !== "number" ||
      !Number.isSafeInteger(row.amount_minor) ||
      row.amount_minor <= 0 ||
      (row.direction !== "credit" && row.direction !== "debt")
    ) {
      throw new Error("invalid closing balance");
    }
    seen.add(row.currency);
    return {
      currency: row.currency,
      amount_minor: row.amount_minor,
      direction: row.direction,
    };
  });
}

export function encodeClosingBalances(
  balances: readonly ClosingBalanceSnapshot[],
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(validateClosingBalances(balances)));
}

export function decodeClosingBalances(payload: Uint8Array): ClosingBalanceSnapshot[] {
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  return validateClosingBalances(decoded);
}

export async function encryptClosingBalances(
  balances: readonly ClosingBalanceSnapshot[],
  K_sheet: Uint8Array,
): Promise<EncryptedClosingBalances> {
  const encrypted = await encryptEntryPayload(encodeClosingBalances(balances), K_sheet);
  return {
    entry_key: Array.from(encrypted.entryKey),
    ciphertext: Array.from(encrypted.ciphertext),
    iv: Array.from(encrypted.iv),
  };
}

export async function decryptClosingBalances(
  encrypted: EncryptedClosingBalances,
  K_sheet: Uint8Array,
): Promise<ClosingBalanceSnapshot[]> {
  const plaintext = await decryptEntryPayload(
    new Uint8Array(encrypted.entry_key),
    new Uint8Array(encrypted.iv),
    new Uint8Array(encrypted.ciphertext),
    K_sheet,
  );
  return decodeClosingBalances(plaintext);
}
