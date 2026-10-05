import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Existing directory shape: the catalog hash binds all static view metadata. */
export function createLocalAppPublicDirectory(catalog, catalogBytes, processor) {
  if (!plain(catalog) || catalog.version !== 1 || !Array.isArray(catalog.apps) || catalog.apps.length !== 1)
    throw new Error("Expected exactly one public IOU catalog entry");
  const app = catalog.apps[0];
  if (!plain(app) || app.id !== "iou") throw new Error("Expected public IOU app");
  return { version: 1, apps: [{ id: app.id, name: app.name, description: app.description, revision: app.revision,
    catalog: { url: "/openchat/local-app-v1.json", sha256: digest(catalogBytes), byteLength: catalogBytes.byteLength },
    processor: { url: "/openchat/local-processor-v1.js", sha256: processor.sha256, byteLength: processor.byteLength },
    setupUrl: "/openchat/connect",
  }] };
}

/**
 * Offline catalog-only rebuild: do not execute/rebuild the existing processor.
 * Require its exact bytes, metadata and current directory/catalog bindings to
 * agree before reusing the descriptor. This is consistency, not publisher trust.
 */
export function verifyCatalogOnlyProcessor({ processorBytes, metadataBytes, catalogBytes, directoryBytes }) {
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const identity = { sha256: digest(processorBytes), byteLength: processorBytes.byteLength };
  if (identity.byteLength < 1 || identity.byteLength > 512 * 1024 || !isDeepStrictEqual(metadata, {
    version: 1, ...identity, protocol: "oc:local-process:request",
  })) throw new Error("Existing local processor bytes/metadata do not match");
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const expectedDirectory = createLocalAppPublicDirectory(catalog, catalogBytes, identity);
  if (!isDeepStrictEqual(catalog.apps[0].processor, identity) ||
    !isDeepStrictEqual(JSON.parse(directoryBytes.toString("utf8")), expectedDirectory))
    throw new Error("Existing local catalog/directory integrity chain does not match");
  return Object.freeze({ ...metadata });
}
