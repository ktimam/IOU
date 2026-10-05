import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createIouLocalCardView } from "./localCardView";
import { createLocalProcessorContext } from "./localProcessorContext";
import { createLocalAppSetupConsent } from "./localAppSetupConsent";

const directory = process.env.IOU_LOCAL_APP_TEST_ARTIFACT_DIRECTORY;
const artifact = (name: string) => readFileSync(directory ? resolve(directory, name)
  : new URL(`../../../public/openchat/${name}`, import.meta.url));
const loadPublication = () => import(new URL("../../../scripts/lib/local-app-publication.mjs", import.meta.url).href);
const metadata = JSON.parse(artifact("local-processor-v1.sha256.json").toString("utf8"));
const publicPackage = () => createIouLocalAppPackage("http://localhost:3000/openchat/import", metadata);

describe("static original card distribution through normal connect/update", () => {
  it("uses the identical static view for public, empty and privately configured setup", () => {
    const view = createIouLocalCardView();
    const contexts = [[], [{ id: "private-type", name: "Private synthetic Type", keywords: ["private-keyword"], direction: "debt" as const, txn_type: "iou" as const }]];
    expect(publicPackage().apps[0].actions[0].draftView).toEqual(view);
    for (const types of contexts) {
      const pkg = createIouLocalAppPackage("http://localhost:3000/openchat/import", metadata, {
        recipientLabel: "Private synthetic sheet", processorContext: createLocalProcessorContext(types, "EGP"),
      });
      expect(pkg.apps[0].actions[0].draftView).toEqual(view);
      expect(JSON.stringify(pkg.apps[0].actions[0].draftView)).not.toMatch(/private-type|Private synthetic|private-keyword|EGP/u);
      expect(pkg.apps[0].actions[0].draftSchema).toEqual(publicPackage().apps[0].actions[0].draftSchema);
    }
  });

  it("travels in the existing one-time consented setup response, without a view URL or extra capability", () => {
    const opener = {} as Window, consent = createLocalAppSetupConsent({ opener, appId: "iou", now: () => 1000 });
    const state = consent.receive({ source: opener, origin: "http://localhost:5190", data: {
      type: "oc:app-setup:connect", version: 1, appId: "iou", connectionId: "A".repeat(43),
    } });
    if (state.kind !== "pending") throw new Error("Expected consent candidate");
    const response = consent.approve(state.binding, JSON.stringify(publicPackage()));
    expect(Object.keys(response).sort()).toEqual(["appId", "catalogJson", "connectionId", "type", "version"]);
    expect(JSON.parse(response.catalogJson).apps[0].actions[0].draftView).toEqual(createIouLocalCardView());
    expect(consent.state().kind).toBe("shared");
    expect(() => consent.approve(state.binding, response.catalogJson)).toThrow();
    expect(JSON.stringify(createIouLocalCardView())).not.toMatch(/https?:|url|credentials|payload|callback/u);
  });

  it("binds the view to the existing catalog digest without changing processor bytes", async () => {
    const { verifyCatalogOnlyProcessor, createLocalAppPublicDirectory } = await loadPublication();
    const inputs = { processorBytes: artifact("local-processor-v1.js"), metadataBytes: artifact("local-processor-v1.sha256.json"), catalogBytes: artifact("local-app-v1.json"), directoryBytes: artifact("apps-v1.json") };
    expect(verifyCatalogOnlyProcessor(inputs)).toEqual(metadata);
    const catalog = publicPackage(), bytes = Buffer.from(JSON.stringify(catalog));
    const directory = createLocalAppPublicDirectory(catalog, bytes, metadata);
    const changed = structuredClone(catalog);
    changed.apps[0].actions[0].draftView = { ...changed.apps[0].actions[0].draftView, nodes: [] };
    expect(createLocalAppPublicDirectory(changed, Buffer.from(JSON.stringify(changed)), metadata).apps[0].catalog.sha256).not.toBe(directory.apps[0].catalog.sha256);
    expect(directory.apps[0].processor).toEqual({ url: "/openchat/local-processor-v1.js", sha256: metadata.sha256, byteLength: metadata.byteLength });
    expect(Object.keys(directory.apps[0]).sort()).toEqual(["catalog", "description", "id", "name", "processor", "revision", "setupUrl"]);
  });

  it("fails catalog-only verification for tampered bytes or any inconsistent existing binding", async () => {
    const { verifyCatalogOnlyProcessor } = await loadPublication();
    const inputs = { processorBytes: artifact("local-processor-v1.js"), metadataBytes: artifact("local-processor-v1.sha256.json"), catalogBytes: artifact("local-app-v1.json"), directoryBytes: artifact("apps-v1.json") };
    for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
      expect(() => verifyCatalogOnlyProcessor({ ...inputs, [key]: Buffer.from("invalid") })).toThrow();
    }
    for (const patch of [{ version: 2 }, { byteLength: metadata.byteLength + 1 }, { protocol: "other" }, { extra: true }])
      expect(() => verifyCatalogOnlyProcessor({ ...inputs, metadataBytes: Buffer.from(JSON.stringify({ ...metadata, ...patch })) })).toThrow();
    const changed = JSON.parse(inputs.catalogBytes.toString()); changed.apps[0].processor.sha256 = "0".repeat(64);
    expect(() => verifyCatalogOnlyProcessor({ ...inputs, catalogBytes: Buffer.from(JSON.stringify(changed)) })).toThrow();
    const changedDirectory = JSON.parse(inputs.directoryBytes.toString()); changedDirectory.apps[0].processor.url = "https://other.example/processor.js";
    expect(() => verifyCatalogOnlyProcessor({ ...inputs, directoryBytes: Buffer.from(JSON.stringify(changedDirectory)) })).toThrow();
  });
});
