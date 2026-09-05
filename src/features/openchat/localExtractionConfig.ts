import { iouActionManifest } from "./actionManifest";

// IOU's private deterministic reader configuration. These policies never enter the registered
// OpenChat response schema; the app surface alone assigns financial meanings to their field names.
const baseProperties = iouActionManifest.outputSchema.properties as Record<string, unknown>;

export const IOU_LOCAL_EXTRACTION_SCHEMA: Record<string, unknown> = {
    ...iouActionManifest.outputSchema,
    "x-iou-source-grounded-transactions": {
      version: 1,
      amountField: "amount",
      currencyField: "currency",
      kindField: "kind",
      directionField: "direction",
      dateField: "date",
      noteField: "note",
      sourceField: "message",
      // Typed monetary source without an explicit paid/sent/received cue is an obligation in IOU.
      fallbackKind: "iou",
      ocrDefaultDirection: "credit",
      requireOcrEvidenceFields: ["kind"],
      maximumItems: 16,
      authoritativeAmountLabels: ["amount due", "total", "transfer amount"],
      dateLabels: ["due date", "date"],
      noteLabels: ["note", "description", "memo"],
      ignoredLineLabels: ["reference"],
      titleLineKeywords: [
        "receipt",
        "request",
        "transaction successful",
        "transaction was successful",
        "powered by",
      ],
      relationshipLabelPrefixes: ["status", "direction"],
    },
    // IOU's own rules/defaults supply and validate semantics for amount/label shorthand.
    "x-iou-text-sequence": {
      numberField: "amount",
      labelField: "note",
      minimumItems: 2,
      // These complete command phrases continue to authorize shorthand embedded after an anchor.
      anchors: ["owe me", "owe"],
    },
    // Read each explicit `label amount ISO; ...` row directly from its source span.
    "x-iou-delimited-text-sequence": {
      delimiter: "semicolon",
      numberField: "amount",
      labelField: "note",
      currencyField: "currency",
      minimumItems: 2,
    },

    properties: {
        ...baseProperties,
        date: {
            ...(baseProperties.date as Record<string, unknown>),
            type: "string",
            minLength: 10,
            maxLength: 10,
            format: "date",
            "x-iou-normalize-date": true,
            "x-iou-date-from-text": true,
            "x-openchat-property-aliases": [
                "due_date", "transaction_date", "payment_date", "start_date",
                "Date", "TransactionDate", "PaymentDate", "StartDate",
            ],
        },
    },
};
