import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { createLocalAppPublicDirectory, verifyCatalogOnlyProcessor } from "./local-app-publication.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase() : left === right;
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

function localHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\*\./, "").replace(/^\[|\]$/g, "");
  if (["localhost", "local", "internal", "ts.net"].includes(host) ||
    /\.(?:localhost|local|internal|ts\.net)$/.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) {
    return host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab])/.test(host) || host.startsWith("::ffff:");
  }
  return false;
}

function requirePublicOrigin(value) {
  if (typeof value !== "string" || value !== value.trim()) throw new Error("A canonical public HTTPS origin is required");
  let url;
  try { url = new URL(value); } catch { throw new Error("A canonical public HTTPS origin is required"); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/" || isIP(host.replace(/^\[|\]$/g, "")) || localHostname(host) ||
    !host.includes(".") || host.endsWith(".") ||
    !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("A canonical public HTTPS DNS origin is required; local, private and Tailscale origins are not mainnet destinations");
  }
  return value;
}

function requireCanister(value) {
  let principal;
  try { principal = Principal.fromText(value); } catch { throw new Error("A canonical backend canister ID is required"); }
  if (typeof value !== "string" || principal.toText() !== value || principal.isAnonymous() || value === "aaaaa-aa" ||
    principal.toUint8Array().at(-1) !== 1) {
    throw new Error("A canonical backend canister ID is required");
  }
  return value;
}

// Resolve existing ancestors too, so a staging symlink/junction cannot alias
// the source public directory even when the final destination does not exist.
function prospectiveRealPath(value) {
  if (existsSync(value)) return realpathSync(value);
  const parent = path.dirname(value);
  if (parent === value) throw new Error("Staging path has no existing filesystem ancestor");
  return path.join(prospectiveRealPath(parent), path.basename(value));
}

function requireOutput(root, outputDirectory) {
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory)) {
    throw new Error("An explicit absolute staging directory is required");
  }
  const output = path.resolve(outputDirectory), realOutput = prospectiveRealPath(output);
  const expected = path.join(root, ".icp", "mainnet-build", "dist");
  if (samePath(output, path.parse(output).root) || samePath(realOutput, path.parse(realOutput).root) ||
    within(output, root) || within(realOutput, root) ||
    (within(root, output) && !samePath(output, expected)) ||
    (within(root, realOutput) && !samePath(realOutput, expected))) {
    throw new Error("Mainnet publication must use .icp/mainnet-build/dist or an isolated staging directory outside the project; source/public paths are forbidden");
  }
  return { output, realOutput };
}

function requirePublicCatalog(catalog) {
  const app = catalog.apps[0]; // verifyCatalogOnlyProcessor already checked the one-app shape.
  if (Object.keys(catalog).some(key => !["version", "apps"].includes(key)) ||
    Object.keys(app).some(key => !["id", "revision", "name", "description", "destination", "processor", "actions", "setupScopes", "deliveryInbox"].includes(key)) ||
    !Array.isArray(app.actions) || !app.actions.length || app.actions.some(action => !plain(action) ||
      Object.keys(action).some(key => !["definition", "draftSchema", "handoff", "draftView", "draftPresentation"].includes(key)))) {
    throw new Error("Mainnet publication accepts only the public app catalog, never private account setup");
  }
  if (app.deliveryInbox && (!plain(app.deliveryInbox) ||
    Object.keys(app.deliveryInbox).sort().join(",") !== "canisterId,host,kind,version")) {
    throw new Error("Private inbox capabilities must never enter public publication");
  }
  for (const action of app.actions) {
    if (!plain(action.definition) || !Array.isArray(action.definition.rules) ||
      action.definition.rules.some(rule => rule.field === "typeId")) {
      throw new Error("Private saved-Type matching must never enter public publication");
    }
  }
}

function mainnetAssetPolicy(source) {
  let policyCount = 0;
  // Preserve the JSON5 file and every unrelated header/directive byte-for-byte.
  // Only explicitly local connect-src URLs are removed; no source is added.
  const result = source.replace(/("Content-Security-Policy"\s*:\s*)("(?:[^"\\]|\\.)*")/g, (_match, prefix, encoded) => {
    policyCount++;
    const policy = JSON.parse(encoded);
    let connections = 0;
    const transformed = policy.replace(/(^|;)(\s*connect-src\s+)([^;]*)/g, (_directive, separator, name, sources) => {
      connections++;
      const retained = sources.trim().split(/\s+/).filter(value => {
        try {
          // CSP permits wildcard ports, unlike the URL parser.
          const url = new URL(value.replace(/:\*$/, ""));
          return !localHostname(url.hostname);
        } catch { return true; } // Keywords such as 'self' are not URL origins.
      });
      if (!retained.length) throw new Error("Asset connect-src must retain its existing public policy");
      return separator + name + retained.join(" ");
    });
    if (connections !== 1) throw new Error("Each asset CSP must have exactly one connect-src directive");
    return prefix + JSON.stringify(transformed);
  });
  if (!policyCount) throw new Error("Asset policy has no explicit Content-Security-Policy headers");
  return Buffer.from(result);
}

/**
 * Offline, post-Vite-build mainnet staging. Reuses reviewed public artifacts;
 * does not build/execute the processor or import the potentially dirty TS
 * catalog generator. Does not modify public/, accounts, canisters or runtime.
 */
export function stageMainnetPublication({ root, outputDirectory, publicOrigin, backendCanisterId }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("An absolute project root is required");
  const projectRoot = realpathSync(root);
  const origin = requirePublicOrigin(publicOrigin), canisterId = requireCanister(backendCanisterId);
  const { output, realOutput } = requireOutput(projectRoot, outputDirectory);
  const source = name => readFileSync(path.join(projectRoot, "public", "openchat", name));
  const processorBytes = source("local-processor-v1.js");
  const metadataBytes = source("local-processor-v1.sha256.json");
  const originalCatalog = source("local-app-v1.json");
  const processor = verifyCatalogOnlyProcessor({ processorBytes, metadataBytes,
    catalogBytes: originalCatalog, directoryBytes: source("apps-v1.json") });
  const catalog = JSON.parse(originalCatalog.toString("utf8"));
  requirePublicCatalog(catalog);
  const destination = `${origin}/openchat/import`;
  catalog.apps[0].destination = destination;
  catalog.apps[0].deliveryInbox = { version: 1, kind: "ic-canister", host: "https://icp-api.io", canisterId };
  const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + "\n");
  const directoryBytes = Buffer.from(JSON.stringify(createLocalAppPublicDirectory(catalog, catalogBytes, processor), null, 2) + "\n");
  // Check the complete staged chain before writing any output.
  verifyCatalogOnlyProcessor({ processorBytes, metadataBytes, catalogBytes, directoryBytes });
  const artifacts = [
    ["openchat/local-processor-v1.js", processorBytes],
    ["openchat/local-processor-v1.sha256.json", metadataBytes],
    ["openchat/local-app-v1.json", catalogBytes],
    ["openchat/apps-v1.json", directoryBytes],
    [".ic-assets.json5", mainnetAssetPolicy(readFileSync(path.join(projectRoot, "public", ".ic-assets.json5"), "utf8"))],
  ];
  for (const [relative] of artifacts) {
    const target = path.join(output, relative);
    if (!within(realOutput, prospectiveRealPath(target)) ||
      (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile() || lstatSync(target).nlink > 1))) {
      throw new Error("Publication target must be an isolated regular staged file, not a linked source asset");
    }
  }
  for (const [relative, bytes] of artifacts) {
    const target = path.join(output, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return Object.freeze({ outputDirectory: output, publicOrigin: origin, backendCanisterId: canisterId, destination,
    processor: Object.freeze({ sha256: processor.sha256, byteLength: processor.byteLength }),
    files: Object.freeze(artifacts.map(([relative, bytes]) => Object.freeze({ path: relative, sha256: digest(bytes), byteLength: bytes.byteLength }))),
  });
}
