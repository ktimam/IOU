// IOU MCP connector (stdio transport) — Milestone 1.
//
// The chat (Claude Desktop / Claude Code) does the screenshot vision/extraction
// on the user's OWN subscription and calls `prepare_iou_entry` with the
// extracted fields. This server validates + normalizes them into a canonical
// IOU draft (KEY-BLIND: no K_sheet, no IC identity, no canister) and returns it
// for the user to import into the IOU app's "✨ From AI draft" confirm screen,
// where the on-device encrypted write happens.
//
// Local stdio works in Claude Desktop / Claude Code today. The SAME handler
// moves behind a remote Streamable-HTTP transport (+ OAuth + relay + push) for
// the mobile flow — see README.md.
//
// Requires the MCP SDK:  pnpm add -D @modelcontextprotocol/sdk
// Run:                   pnpm mcp:serve   (or register via `claude mcp add`)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildDraftResult, type PrepareInput } from "./draftResult";

const TOOL_NAME = "prepare_iou_entry";

const inputSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["settlement", "iou"],
      description:
        "settlement = a completed money transfer; iou = a debt with due date(s) (e.g. a reservation). Omit to infer from fee/schedule.",
    },
    amount: {
      type: "number",
      description:
        "GROSS / face value in MAJOR units, e.g. 25.00. For an IOU with a fee this is the amount BEFORE the fee.",
    },
    currency: { type: "string", description: "3-letter ISO-4217 code, e.g. USD, EUR, EGP." },
    direction: {
      type: "string",
      enum: ["credit", "debt"],
      description:
        "From the IOU app user's perspective: 'credit' = the money is owed to them (they paid / are owed); 'debt' = they owe it. A HINT the user confirms.",
    },
    date: { type: "string", description: "Transaction date, YYYY-MM-DD. Omit for today." },
    counterparty: {
      type: "string",
      description: "The other person/business (informational; folded into the note).",
    },
    note: { type: "string", description: "Short description." },
    fee_percent: { type: "number", description: "IOU only: fee as a percent of gross, 0..100." },
    fee_fixed: { type: "number", description: "IOU only: flat fee in MAJOR units." },
    schedule: {
      type: "array",
      description:
        "IOU only: due-date schedule; percents must total 100 (a single entry ⇒ 100%).",
      items: {
        type: "object",
        properties: {
          due_date: { type: "string", description: "YYYY-MM-DD" },
          percent: { type: "number" },
        },
        required: ["due_date"],
      },
    },
  },
  required: ["amount", "currency"],
};

const server = new Server(
  { name: "iou-connector", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        "Prepare an IOU ledger entry from a money-transfer screenshot or reservation the user shared. Extract the fields from the image yourself, then call this tool. It validates them into a draft the user imports into the IOU app to review and confirm — it does NOT write to the ledger.",
      inputSchema,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    return {
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  const res = buildDraftResult((req.params.arguments ?? {}) as PrepareInput);
  if (!res.ok) {
    return {
      content: [
        { type: "text", text: "Could not prepare the entry:\n- " + res.errors.join("\n- ") },
      ],
      isError: true,
    };
  }
  const text =
    `Prepared: ${res.summary}\n\n` +
    `To add it: open the IOU app → "✨ Import" → paste this JSON → review & confirm:\n\n` +
    "```json\n" +
    res.pasteJson +
    "\n```\n";
  return { content: [{ type: "text", text }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio uses stdout for the protocol — only ever log to stderr.
  console.error("iou-connector MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
