import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createIouLocalAppPackage } from "./localAppPackage";

const directory = process.env.IOU_LOCAL_APP_TEST_ARTIFACT_DIRECTORY;
const bytes = (name: string) => readFileSync(directory ? resolve(directory, name)
  : new URL(`../../../public/openchat/${name}`, import.meta.url));
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("IOU-owned public client distribution", () => {
  it("publishes exact hashes/lengths for the public catalog and processor with same-origin endpoints", () => {
    const directory = JSON.parse(bytes("apps-v1.json").toString());
    const catalogBytes = bytes("local-app-v1.json");
    const catalog = JSON.parse(catalogBytes.toString());
    const processorBytes = bytes("local-processor-v1.js");
    const metadata = JSON.parse(bytes("local-processor-v1.sha256.json").toString());
    const app = catalog.apps[0];
    expect(directory).toEqual({ version: 1, apps: [{ id: app.id, name: app.name, description: app.description, revision: app.revision,
      catalog: { url: "/openchat/local-app-v1.json", sha256: digest(catalogBytes), byteLength: catalogBytes.byteLength },
      processor: { url: "/openchat/local-processor-v1.js", sha256: digest(processorBytes), byteLength: processorBytes.byteLength },
      setupUrl: "/openchat/connect.html",
    }] });
    expect(app.processor).toEqual({ sha256: metadata.sha256, byteLength: metadata.byteLength });
    expect(directory.apps[0].processor.sha256).toBe(metadata.sha256);
    expect(directory.apps[0].processor.byteLength).toBe(metadata.byteLength);
    for (const value of [directory.apps[0].catalog.url, directory.apps[0].processor.url, directory.apps[0].setupUrl]) {
      const url = new URL(value, "https://iou.example/openchat/apps-v1.json");
      expect(url.origin).toBe("https://iou.example"); expect(url.search).toBe(""); expect(url.hash).toBe("");
    }
  });
  it("is the public app-owned declaration, with no exported account, Type vocabulary or private context", () => {
    const catalog = JSON.parse(bytes("local-app-v1.json").toString());
    const app = catalog.apps[0];
    expect(catalog).toEqual(createIouLocalAppPackage(app.destination, app.processor, undefined, app.deliveryInbox));
    expect(app).not.toHaveProperty("recipientLabel");
    expect(app).not.toHaveProperty("deliveryEncryption"); // Public discovery cannot provision a recipient key.
    expect(app.revision).toBe("local-import-v2");
    for (const action of app.actions) {
      expect(action).not.toHaveProperty("processorContext");
      expect(action).not.toHaveProperty("draftEditor");
      expect(action.definition.rules.some((rule: { field?: string }) => rule.field === "typeId")).toBe(false);
    }
    expect(Object.keys(JSON.parse(bytes("apps-v1.json").toString()).apps[0]).sort()).toEqual(["catalog", "description", "id", "name", "processor", "revision", "setupUrl"]);
  });
});
