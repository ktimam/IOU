import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIouLocalAppPackage, iouLocalDraftSchema } from "./localAppPackage";
import { createIouLocalCardView, IOU_ORIGINAL_CARD_TOUCH_TARGET_PX, type IouLocalCardViewNode } from "./localCardView";
import { IOU_CARD_STYLE, IOU_CARD_THEME_VARS } from "./cardPresentation";
import { createLocalProcessorContext } from "./localProcessorContext";

const allNodes = (nodes: readonly IouLocalCardViewNode[]): IouLocalCardViewNode[] =>
  nodes.flatMap(node => [node, ...("children" in node ? allNodes(node.children) : [])]);

describe("IOU original static card view", () => {
  it("preserves original wrapping row order and single-line Note without copying canonical values", () => {
    const view = createIouLocalCardView(), outer = view.nodes[0];
    expect(view.version).toBe(1);
    expect(outer).toMatchObject({ kind: "group", gap: "none", padding: "medium" });
    if (!("children" in outer)) throw new Error("Expected outer page group");
    expect(outer.children).toHaveLength(1);
    const group = outer.children[0];
    expect(group).toMatchObject({ kind: "group", gap: "small", padding: "medium", surface: "card", radius: "medium" });
    if (!("children" in group)) throw new Error("Expected entry group");
    expect(group.children).toEqual([
      { kind: "row", gap: "small", children: [
        { kind: "field", field: "amount", minWidth: 96 },
        { kind: "field", field: "currency", minWidth: 96 },
        { kind: "field", field: "direction", minWidth: 124 },
      ] },
      { kind: "row", gap: "small", children: [
        { kind: "field", field: "kind", minWidth: 108 },
        { kind: "field", field: "typeId", minWidth: 128 },
        { kind: "field", field: "date", minWidth: 112 },
      ] },
      { kind: "field", field: "note", fullWidth: true, control: "single-line" },
    ]);
    expect(allNodes(view.nodes).every(node => node.kind !== "text")).toBe(true);
  });

  it("binds unique existing canonical row fields and leaves labels/choices authoritative", () => {
    const fields = allNodes(createIouLocalCardView().nodes).flatMap(node => node.kind === "field" ? [node.field] : []);
    expect(new Set(fields).size).toBe(fields.length);
    for (const field of fields) expect(iouLocalDraftSchema.properties.entries.items.properties).toHaveProperty(field);
    const action = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "0".repeat(64), byteLength: 1 }).apps[0].actions[0];
    expect(action.definition.card.rows.filter(row => fields.includes(row.valueKey)).map(row => row.label)).toEqual([
      "Amount", "Currency", "Direction", "Type", "Saved type", "Date", "Note",
    ]);
    // typeName is a canonical companion field, never silently removed from the
    // payload. The generic validator must report it for complete host review.
    expect(Object.keys(iouLocalDraftSchema.properties.entries.items.properties).filter(field => !fields.includes(field))).toEqual(["typeName"]);
  });

  it("uses the original shared style values without importing React or capability-bearing code", () => {
    const original = readFileSync(new URL("./OpenChatCardPage.tsx", import.meta.url), "utf8");
    expect(IOU_CARD_STYLE).toEqual({ outerPadding: 16, cardPadding: 16, cardRadius: 14,
      cardMaxWidth: 460, cardShadow: "0 1px 3px rgba(0,0,0,0.35)", rowGap: 8,
      labelControlGap: 2, labelFontSize: "0.6875rem", controlFontSize: "0.9375rem",
      controlPadding: "7px 10px", controlRadius: 10, touchTarget: 44 });
    expect(IOU_ORIGINAL_CARD_TOUCH_TARGET_PX).toBe(44);
    expect(original).toContain("const TOUCH_TARGET = IOU_CARD_STYLE.touchTarget;");
    expect(original).toContain("padding: IOU_CARD_STYLE.outerPadding");
    expect(original).toContain("padding: IOU_CARD_STYLE.cardPadding");
    expect(original).toContain("gap: IOU_CARD_STYLE.labelControlGap");
    expect(original).toContain("= IOU_CARD_THEME_VARS;");
    const constants = readFileSync(new URL("./cardPresentation.ts", import.meta.url), "utf8");
    expect(constants).not.toMatch(/^import\s|window\.|fetch\(|postMessage|localStorage|indexedDB/mu);
    for (const [theme, palette] of Object.entries(createIouLocalCardView().theme!)) {
      const tokens = IOU_CARD_THEME_VARS[theme as "dark" | "light"];
      expect(palette).toEqual({ background: tokens["--bg"], surface: tokens["--surface"], field: tokens["--surface-2"],
        text: tokens["--text"], muted: tokens["--text-dim"], border: tokens["--border"], accent: tokens["--accent"] });
      for (const value of Object.values(palette)) {
        expect(value).toMatch(/^#[a-f0-9]{6}$/u);
      }
    }
  });

  it("keeps the original None and Add to IOU labels without changing destinations or defaults", () => {
    for (const types of [[], [{ id: "synthetic", name: "Synthetic type", keywords: [], direction: "debt" as const, txn_type: "iou" as const }]]) {
      const app = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "0".repeat(64), byteLength: 1 }, {
        recipientLabel: "Synthetic sheet", processorContext: createLocalProcessorContext(types, "EGP"),
      }).apps[0];
      expect(app.destination).toBe("http://localhost:3000/openchat/import");
      expect(app.actions[0].definition.card.confirmLabel).toBe("Add to IOU");
      expect(app.actions[0].draftEditor?.choices[0].noneLabel).toBe("None");
      expect(app.actions[0].draftEditor?.choices[0].options.map(option => option.defaults)).toEqual(types.map(type => [{ field: "direction", value: type.direction }]));
      expect(app.actions[0].handoff).toEqual({ kind: "wrapped-list", field: "entries" });
    }
  });

  it("cannot enable editing, overwrite data, hide canonical review or request delivery", () => {
    const view = createIouLocalCardView();
    const allowed = new Set(["version", "nodes", "theme", "light", "dark", "background", "surface", "field", "text", "muted", "border", "accent", "kind", "children", "gap", "padding", "radius", "minWidth", "fullWidth", "control"]);
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) {
        expect(allowed.has(key), key).toBe(true); inspect(item);
      }
      else expect(["string", "number", "boolean"].includes(typeof value)).toBe(true);
    };
    inspect(view);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(createIouLocalCardView.length).toBe(0);
    // This proves absence of app-granted capabilities, not rendered read-only
    // behavior. Host-side readonly and final-review tests remain mandatory.
    expect(JSON.stringify(view)).not.toMatch(/https?:|iframe|script|onclick|callback|readonly|payload|destination/u);
  });

  it("returns independent data and exports only static action metadata", () => {
    const first = createIouLocalCardView(), second = createIouLocalCardView();
    expect(first).toEqual(second); expect(first).not.toBe(second); expect(first.nodes).not.toBe(second.nodes);
    Object.assign(first.theme!.dark!, { accent: "#000000" });
    expect(second.theme!.dark!.accent).toBe("#5fe3b3");
    const source = readFileSync(new URL("./localCardView.ts", import.meta.url), "utf8");
    expect(source.match(/^import[^\n]+/gmu)).toEqual(['import { IOU_CARD_STYLE, IOU_CARD_THEME_VARS } from "./cardPresentation";']);
    const pkg = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "0".repeat(64), byteLength: 1 });
    const action = pkg.apps[0].actions[0];
    expect(action.draftView).toEqual(second);
    expect(action.definition).not.toHaveProperty("draftView");
    expect(action.draftSchema).not.toHaveProperty("draftView");
    expect(action.processorContext ?? {}).not.toHaveProperty("draftView");
  });
});
