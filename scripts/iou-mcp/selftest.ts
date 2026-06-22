// Headless self-test for the connector core (no MCP SDK, no replica, no Claude).
// Run: ./node_modules/.bin/tsx scripts/iou-mcp/selftest.ts   (or `pnpm mcp:selftest`)
import { buildDraftResult } from "./draftResult";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.error("  FAIL " + name); }
}

// settlement (transfer screenshot)
const s = buildDraftResult(
  {
    kind: "settlement",
    amount: "25.00",
    currency: "usd",
    direction: "credit",
    date: "2026-06-20",
    counterparty: "Sam",
    note: "lunch",
  },
  { host: "https://iou.example" },
);
check("settlement ok", s.ok);
if (s.ok) {
  check("amount major", s.draft.amount === 25);
  check("currency upper", s.draft.currency === "USD");
  check("kind", s.draft.kind === "settlement");
  check("note folds counterparty", s.draft.note === "lunch (Sam)");
  check("has draft_id", typeof s.draft.draft_id === "string" && s.draft.draft_id.length > 0);
  check("pasteJson re-parses", JSON.parse(s.pasteJson).currency === "USD");
  check("deepLink shape", s.deepLink.startsWith("https://iou.example/import#d="));
}

// iou with fee + schedule (reservation)
const i = buildDraftResult({
  kind: "iou",
  amount: 1000,
  currency: "EGP",
  fee_percent: 20,
  fee_fixed: "10.00",
  schedule: [
    { due_date: "2026-07-01", percent: 50 },
    { due_date: "2026-08-01", percent: 50 },
  ],
  note: "Reservation",
});
check("iou ok", i.ok);
if (i.ok) {
  check("iou kind", i.draft.kind === "iou");
  check("iou amount is gross", i.draft.amount === 1000);
  check("iou fee_percent", i.draft.fee_percent === 20);
  check("iou fee_fixed major", i.draft.fee_fixed === 10);
  check("iou schedule len", (i.draft.schedule?.length ?? 0) === 2);
}

// determinism: connector draft_id matches the app's parseDraft on the same fields
const a = buildDraftResult({ amount: 25, currency: "USD", date: "2026-06-20", note: "x" });
const b = buildDraftResult({ amount: "25.00", currency: "usd", date: "2026-06-20", note: "x" });
check("stable draft_id across equivalent inputs", a.ok && b.ok && a.draftId === b.draftId);

// validation: bad input rejected with errors (never throws)
const bad = buildDraftResult({ amount: -1 as unknown as number, currency: "zz" });
check("bad input rejected", !bad.ok && Array.isArray((bad as any).errors) && (bad as any).errors.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
