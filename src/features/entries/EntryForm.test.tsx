import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EntryForm } from "./EntryForm";
import type { EntryPayload } from "./types";

vi.mock("../settings/usePreferences", () => ({
  usePreferences: () => ({ prefs: { defaultCurrency: "USD" } }),
}));

const initial: Partial<EntryPayload> = {
  currency: "EGP", amount_minor: 442080, ts: 1700000000000,
  fee: { percent: 10, fixed_minor: 0, gross_amount_minor: 491200 },
  convert: {
    from_currency: "USD", from_amount_minor: 10000,
    to_currency: "EGP", to_amount_minor: 491200,
    rate: 49.12, rate_source: "manual", rate_fetched_at: 1700000000000,
  },
};

describe("entry conversion UI", () => {
  it("restores original amount/currency and saved conversion for an edit", () => {
    const html = renderToStaticMarkup(<EntryForm myPrincipal="author" partnerPrincipal="partner"
      initial={initial} isEdit onCancel={() => {}} onSubmit={async () => {}} />);
    expect(html).toContain('<option value="USD" selected="">USD</option>');
    expect(html).toContain('value="100.00"');
    expect(html).toContain('value="49.12"');
    expect(html).toContain('value="4912.00"');
    expect(html).toContain("Manual conversion");
    expect(html).toContain("Exchange rate (1 USD in EGP)");
    expect(html).toContain("Converted amount (EGP)");
    expect(html).toContain('class="conversion-toggle"');
    expect(html).toContain("including offline");
  });
  it("allows the FX endpoint in both deployed CSPs without allowing arbitrary HTTPS connections", () => {
    const assets = readFileSync(new URL("../../../public/.ic-assets.json5", import.meta.url), "utf8");
    const policies = [...assets.matchAll(/"Content-Security-Policy": "([^"]+)"/g)];
    expect(policies).toHaveLength(2);
    for (const [, policy] of policies) {
      const connect = policy.match(/connect-src ([^;]+);/)![1].split(" ");
      expect(connect).toContain("https://api.frankfurter.dev");
      expect(connect).not.toContain("https:");
      expect(connect).not.toContain("*");
    }
  });
});
