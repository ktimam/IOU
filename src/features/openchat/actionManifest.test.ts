import { describe, it, expect } from "vitest";
import {
  iouActionManifest,
  renderManifestJson,
  IOU_EXTRACTION_PROMPT,
  buildIouRules,
  buildIouOutputSchema,
} from "./actionManifest";
import { parseDraft } from "../entries/draft";

describe("template routing", () => {
  const templates = [
    { id: "z9-abc123", name: "Reservation", keywords: ["reservation", "booking"] },
    { id: "y8-def456", name: "No Triggers", keywords: [] },
  ];

  it("routes by template NAME (not id) so it reads on the action card", () => {
    const rules = buildIouRules(templates);
    const km = rules.find((r) => r.kind === "keyword_map" && r.field === "template");
    expect(km, "a keyword_map on the `template` field").toBeDefined();
    if (km && km.kind === "keyword_map") {
      // The trigger-word-bearing template routes; its VALUE is the human name, and the keyword-less
      // one is omitted (nothing to route).
      expect(km.map).toEqual([{ value: "Reservation", keywords: ["reservation", "booking"] }]);
    }
  });

  it("advertises the `template` field in the schema only when something is routable", () => {
    expect((buildIouOutputSchema(templates).properties as Record<string, unknown>).template).toEqual({
      type: "string",
    });
    // No routable templates -> no `template` property (nothing would ever set it).
    expect(
      (buildIouOutputSchema([{ id: "x", name: "X", keywords: [] }]).properties as Record<string, unknown>)
        .template,
    ).toBeUndefined();
  });
});

describe("iouActionManifest", () => {
  it("declares an output the IOU draft parser accepts", () => {
    // A sample draft shaped exactly per the manifest's outputSchema.
    const sample = {
      kind: "settlement",
      amount: 42.5,
      currency: "USD",
      direction: "credit",
      date: "2026-06-24",
      note: "dinner",
    };
    const r = parseDraft(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.initial.amount_minor).toBe(4250);
      expect(r.value.initial.direction).toBe("credit");
    }
  });

  it("card direction labels cover exactly the parser's directions", () => {
    expect(Object.keys(iouActionManifest.card.directionLabels).sort()).toEqual(["credit", "debt"]);
    // both directions parse
    expect(parseDraft({ amount: 1, currency: "USD", direction: "credit" }).ok).toBe(true);
    expect(parseDraft({ amount: 1, currency: "USD", direction: "debt" }).ok).toBe(true);
  });

  it("forwards to the relay's OpenChat ingestion path with provenance auth", () => {
    expect(iouActionManifest.callback.path).toBe("/v1/openchat/drafts");
    expect(iouActionManifest.callback.auth).toBe("openchat-provenance");
  });

  it("renders valid JSON carrying the extraction prompt", () => {
    const json = renderManifestJson();
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("iou.entry.import");
    expect(parsed.prompt).toBe(IOU_EXTRACTION_PROMPT);
  });

  it("declares a chat_link surface pointing at the /openchat/link-chat page", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "chat_link");
    expect(s).toBeDefined();
    // External so the linking page runs first-party (its own IOU session/sheets); an embedded
    // iframe would be storage-partitioned by the OpenChat host origin.
    expect(s!.display).toBe("external");
    // Absolute origin (resolvable at registration time) + the app route + the {chatKey}
    // placeholder OpenChat substitutes with the canonical chat key.
    expect(s!.url).toMatch(/^https?:\/\/[^/]+\/openchat\/link-chat\?chat=\{chatKey\}$/);
  });

  it("declares a connect surface pointing at the pairing-code entry anchor", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "connect");
    expect(s).toBeDefined();
    // Same first-party reasoning as chat_link: the code entry needs the user's signed-in session.
    expect(s!.display).toBe("external");
    // The #openchat-connect hash scrolls to / focuses the code input in ActionInboxSettings.
    expect(s!.url).toMatch(/^https?:\/\/[^/]+\/settings#openchat-connect$/);
  });

  it("declares a home surface (the app's webpage, embedded in OpenChat)", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "home");
    expect(s).toBeDefined();
    // Embedded in OpenChat's in-window browser; needs no session (shows the landing state).
    expect(s!.display).toBe("sheet");
    expect(s!.url).toMatch(/^https?:\/\/[^/]+$/);
  });

  it("surface URL parses once the placeholder is substituted", () => {
    const s = iouActionManifest.surfaces.find((x) => x.kind === "chat_link")!;
    const substituted = s.url.replace("{chatKey}", "group:aaaaa-aa");
    const url = new URL(substituted);
    expect(url.pathname).toBe("/openchat/link-chat");
    expect(url.searchParams.get("chat")).toBe("group:aaaaa-aa");
  });
});
