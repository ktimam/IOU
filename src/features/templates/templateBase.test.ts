// templateToInitial — the template → entry-defaults mapping SheetPage uses as the parseDraft `base`
// and the manual "+ Add" seed. Covers fee currency handling and the RELATIVE-schedule → absolute
// due-date anchoring (offset days, start-of-next-month, December rollover, default-today).

import { describe, it, expect } from "vitest";
import { templateToInitial } from "./templateBase";
import type { TxnTemplate } from "./TemplatesContext";

const DAY = 86_400_000;
const JUN10 = Date.UTC(2026, 5, 10);

function tpl(over: Partial<TxnTemplate>): TxnTemplate {
  return { id: "t1", name: "T", direction: "credit", txn_type: "iou", ...over };
}

describe("templateToInitial — fields + fees", () => {
  it("maps a settlement template with no fee/schedule", () => {
    const init = templateToInitial(tpl({ txn_type: "settlement", currency: "USD", amount_minor: 2500, note: "coffee" }));
    expect(init.txn_type).toBe("settlement");
    expect(init.currency).toBe("USD");
    expect(init.amount_minor).toBe(2500);
    expect(init.note).toBe("coffee");
    expect(init.fee).toBeUndefined();
    expect(init.schedule).toBeUndefined();
  });

  it("folds a same-currency fixed fee into the fee (no fixed_currency key)", () => {
    const init = templateToInitial(tpl({ currency: "USD", amount_minor: 100000, fee_percent: 10, fee_fixed_minor: 5000 }));
    expect(init.fee).toEqual({ percent: 10, fixed_minor: 5000, gross_amount_minor: 100000 });
    expect(init.fee).not.toHaveProperty("fixed_currency");
  });

  it("carries a foreign fixed-fee currency", () => {
    const init = templateToInitial(tpl({ currency: "USD", amount_minor: 100000, fee_fixed_minor: 50000, fee_fixed_currency: "EGP" }));
    expect(init.fee).toEqual({ percent: 0, fixed_minor: 50000, fixed_currency: "EGP", gross_amount_minor: 100000 });
  });

  it("omits the fee when neither percent nor fixed is set (or for a settlement)", () => {
    expect(templateToInitial(tpl({ currency: "USD", amount_minor: 100000 })).fee).toBeUndefined();
    expect(templateToInitial(tpl({ txn_type: "settlement", fee_percent: 20 })).fee).toBeUndefined();
  });

  it("defaults gross to 0 when the template carries no amount but has a fee", () => {
    expect(templateToInitial(tpl({ fee_percent: 20 })).fee?.gross_amount_minor).toBe(0);
  });
});

describe("templateToInitial — relative-schedule anchoring", () => {
  it("resolves offset_days relative to the anchor date", () => {
    const init = templateToInitial(
      tpl({
        amount_minor: 100000,
        schedule: [
          { offset_days: 0, percent: 50 },
          { offset_days: 30, percent: 50 },
        ],
      }),
      JUN10,
    );
    expect(init.schedule).toEqual([
      { due_ts: JUN10, percent: 50 },
      { due_ts: JUN10 + 30 * DAY, percent: 50 },
    ]);
  });

  it("resolves start_of_next_month, rolling over correctly in December", () => {
    const july1 = templateToInitial(
      tpl({ amount_minor: 1, schedule: [{ offset_days: 0, percent: 100, anchor: "start_of_next_month" }] }),
      JUN10,
    );
    expect(july1.schedule).toEqual([{ due_ts: Date.UTC(2026, 6, 1), percent: 100 }]);

    const dec15 = Date.UTC(2026, 11, 15);
    const jan1 = templateToInitial(
      tpl({ amount_minor: 1, schedule: [{ offset_days: 0, percent: 100, anchor: "start_of_next_month" }] }),
      dec15,
    );
    expect(jan1.schedule).toEqual([{ due_ts: Date.UTC(2027, 0, 1), percent: 100 }]); // rolls into next year
  });

  it("ignores a schedule on a settlement template", () => {
    const init = templateToInitial(tpl({ txn_type: "settlement", schedule: [{ offset_days: 0, percent: 100 }] }), JUN10);
    expect(init.schedule).toBeUndefined();
  });

  it("anchors at today when no anchorTs is given (deterministic day math)", () => {
    const init = templateToInitial(tpl({ amount_minor: 1, schedule: [{ offset_days: 0, percent: 100 }] }));
    const todayUtcMidnight = (() => {
      const n = new Date();
      return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    })();
    expect(init.schedule?.[0].due_ts).toBe(todayUtcMidnight);
  });
});
