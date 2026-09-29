import type { TxnTemplate } from "../templates/TemplatesContext";

export type LocalProcessorContext = Readonly<{
  version: 1;
  defaultCurrency?: string;
  draftEditorDefaults?: "host-v1";
  types: readonly Readonly<Pick<TxnTemplate, "id" | "name" | "direction" | "txn_type"> & { keywords: readonly string[] }>[];
}>;

const safeText = (value: unknown): value is string => typeof value === "string" &&
  value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" &&
  !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));

/** Private browser export only. The sandbox receives vocabulary, not keys, fees or account access. */
export function parseLocalProcessorContext(value: unknown): LocalProcessorContext | undefined {
  try {
    if (!record(value) || Object.keys(value).some((key) => !["version", "defaultCurrency", "draftEditorDefaults", "types"].includes(key)) ||
      value.version !== 1 || !Array.isArray(value.types) || value.types.length > 64 ||
      (Object.hasOwn(value, "draftEditorDefaults") && value.draftEditorDefaults !== "host-v1") ||
      (value.defaultCurrency !== undefined && (typeof value.defaultCurrency !== "string" || !/^[A-Z]{3}$/.test(value.defaultCurrency))) ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768) return undefined;
    const ids = new Set<string>();
    const types: LocalProcessorContext["types"][number][] = [];
    for (const item of value.types) {
      if (!record(item) || Object.keys(item).sort().join(",") !== "direction,id,keywords,name,txn_type" ||
        typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || ids.has(item.id) ||
        !safeText(item.name) || !["credit", "debt"].includes(String(item.direction)) ||
        !["iou", "settlement"].includes(String(item.txn_type)) || !Array.isArray(item.keywords) ||
        item.keywords.length > 32 || !item.keywords.every(safeText)) return undefined;
      ids.add(item.id);
      types.push(Object.freeze({ id: item.id, name: item.name,
        direction: item.direction as "credit" | "debt", txn_type: item.txn_type as "iou" | "settlement",
        keywords: Object.freeze([...item.keywords]) }));
    }
    return Object.freeze({ version: 1, ...(value.defaultCurrency === undefined ? {} : { defaultCurrency: value.defaultCurrency }),
      ...(value.draftEditorDefaults === "host-v1" ? { draftEditorDefaults: "host-v1" as const } : {}), types: Object.freeze(types) });
  } catch { return undefined; }
}

export function createLocalProcessorContext(templates: readonly TxnTemplate[], defaultCurrency: string): LocalProcessorContext {
  const context = parseLocalProcessorContext({ version: 1,
    ...(defaultCurrency ? { defaultCurrency } : {}),
    types: templates.map(({ id, name, direction, txn_type, keywords }) => ({ id, name, direction, txn_type, keywords: keywords ?? [] })),
  });
  if (!context) throw new Error("This private Type vocabulary is too large or invalid for a local export.");
  return context;
}
