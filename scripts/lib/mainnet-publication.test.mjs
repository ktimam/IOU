import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Principal } from "@dfinity/principal";
import { createLocalAppPublicDirectory, verifyCatalogOnlyProcessor } from "./local-app-publication.mjs";
import { stageMainnetPublication } from "./mainnet-publication.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporaryRoot = path.resolve(process.env.IOU_TEST_TEMP_ROOT ?? tmpdir());
mkdirSync(temporaryRoot, { recursive: true });
const work = mkdtempSync(path.join(temporaryRoot, "iou-mainnet-publication-"));
after(() => {
  const relative = path.relative(temporaryRoot, work);
  assert.ok(relative.startsWith("iou-mainnet-publication-") && !relative.includes(path.sep));
  rmSync(work, { recursive: true, force: true });
});
const names = ["local-app-v1.json", "apps-v1.json", "local-processor-v1.js", "local-processor-v1.sha256.json"];
const hash = value => createHash("sha256").update(value).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const origin = "https://iou.example.net", canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
let sequence = 0;
function fixture() {
  const base = path.join(work, String(++sequence)), root = path.join(base, "project");
  const source = path.join(root, "public", "openchat"), outputDirectory = path.join(base, "staging");
  mkdirSync(source, { recursive: true });
  for (const name of names) cpSync(path.join(repository, "public", "openchat", name), path.join(source, name));
  cpSync(path.join(repository, "public", ".ic-assets.json5"), path.join(root, "public", ".ic-assets.json5"));
  return { base, root, source, outputDirectory, publicOrigin: origin, backendCanisterId: canisterId };
}
function sourceHashes(f) {
  return [...names.map(name => path.join(f.source, name)), path.join(f.root, "public", ".ic-assets.json5")]
    .map(file => hash(readFileSync(file)));
}
function replaceCatalog(f, mutate) {
  const catalog = json(path.join(f.source, "local-app-v1.json"));
  mutate(catalog.apps[0]);
  const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(path.join(f.source, "local-app-v1.json"), bytes);
  writeFileSync(path.join(f.source, "apps-v1.json"), JSON.stringify(createLocalAppPublicDirectory(catalog, bytes,
    json(path.join(f.source, "local-processor-v1.sha256.json")))));
}

test("stages exact reviewed processor and actions, changing only public destination/inbox routing", () => {
  const f = fixture(), before = sourceHashes(f), original = json(path.join(f.source, "local-app-v1.json"));
  const result = stageMainnetPublication(f), staged = path.join(f.outputDirectory, "openchat");
  assert.deepEqual(sourceHashes(f), before);
  assert.equal(result.outputDirectory, f.outputDirectory);
  assert.equal(result.destination, `${origin}/openchat/import`);
  assert.equal(result.files.length, 5);
  for (const name of ["local-processor-v1.js", "local-processor-v1.sha256.json"]) {
    assert.deepEqual(readFileSync(path.join(staged, name)), readFileSync(path.join(f.source, name)));
  }
  const expected = structuredClone(original);
  expected.apps[0].destination = `${origin}/openchat/import`;
  expected.apps[0].deliveryInbox = { version: 1, kind: "ic-canister", host: "https://icp-api.io", canisterId };
  assert.deepEqual(json(path.join(staged, "local-app-v1.json")), expected);
  const processor = verifyCatalogOnlyProcessor({
    processorBytes: readFileSync(path.join(staged, "local-processor-v1.js")),
    metadataBytes: readFileSync(path.join(staged, "local-processor-v1.sha256.json")),
    catalogBytes: readFileSync(path.join(staged, "local-app-v1.json")), directoryBytes: readFileSync(path.join(staged, "apps-v1.json")),
  });
  assert.deepEqual(result.processor, { sha256: processor.sha256, byteLength: processor.byteLength });
  for (const file of result.files) {
    const bytes = readFileSync(path.join(f.outputDirectory, file.path));
    assert.equal(file.sha256, hash(bytes)); assert.equal(file.byteLength, bytes.byteLength);
  }
});

test("accepts only the dedicated project build output and leaves Vite assets intact", () => {
  const f = fixture(); f.outputDirectory = path.join(f.root, ".icp", "mainnet-build", "dist");
  mkdirSync(f.outputDirectory, { recursive: true });
  writeFileSync(path.join(f.outputDirectory, "index.html"), "reviewed Vite output");
  stageMainnetPublication(f);
  assert.equal(readFileSync(path.join(f.outputDirectory, "index.html"), "utf8"), "reviewed Vite output");
  assert.ok(existsSync(path.join(f.outputDirectory, "openchat", "apps-v1.json")));
});

test("rejects noncanonical, insecure, local, private and Tailscale destinations before writing", () => {
  const f = fixture();
  for (const publicOrigin of ["http://iou.example.net", "https://localhost", "https://app.localhost", "https://local",
    "https://app.local", "https://app.internal", "https://device.ts.net", "https://ts.net", "https://127.0.0.1",
    "https://10.1.2.3", "https://172.20.0.1", "https://192.168.1.2", "https://100.64.0.1", "https://169.254.1.2",
    "https://[::1]", "https://[fd00::1]", "https://2130706433", "https://0x7f000001", "https://8.8.8.8",
    "https://user:pass@iou.example.net", "https://iou.example.net/openchat", "https://iou.example.net?x=1",
    "https://iou.example.net#x", "https://iou.example.net/", " https://iou.example.net", "https://IOU.example.net",
    "https://iou.example.net.", "https://iou", "https://*.example.net"]) {
    assert.throws(() => stageMainnetPublication({ ...f, publicOrigin }), /public HTTPS/, publicOrigin);
    assert.equal(existsSync(f.outputDirectory), false);
  }
});

test("requires a canonical nonanonymous backend canister principal", () => {
  const f = fixture();
  for (const backendCanisterId of ["iou_backend", "aaaaa-aa", "2vxsx-fae", "rrkah-fqaaa-aaaaa-aaaaq-cai ", "RRKAH-FQAAA-AAAAA-AAA AQ-CAI", "fake-canister",
    Principal.selfAuthenticating(new Uint8Array(32)).toText()]) {
    assert.throws(() => stageMainnetPublication({ ...f, backendCanisterId }), /backend canister ID/);
  }
  assert.equal(existsSync(f.outputDirectory), false);
});

test("refuses project/source/ancestor paths and traversal back into public", () => {
  const f = fixture(), before = sourceHashes(f);
  for (const outputDirectory of [f.root, path.join(f.root, "public"), f.source, path.join(f.root, "src"),
    path.join(f.root, ".icp"), path.join(f.root, "public", "..", "public", "nested"), f.base,
    path.parse(f.root).root, "relative-output"]) {
    assert.throws(() => stageMainnetPublication({ ...f, outputDirectory }), /staging|publication/);
  }
  assert.deepEqual(sourceHashes(f), before);
});

test("refuses staging directory junctions/symlinks pointing into public", () => {
  const f = fixture(), before = sourceHashes(f), alias = path.join(f.base, "public-alias");
  symlinkSync(path.join(f.root, "public"), alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => stageMainnetPublication({ ...f, outputDirectory: alias }), /source\/public paths are forbidden/);
  assert.deepEqual(sourceHashes(f), before);
});

test("refuses a nested output link pointing to source artifacts", () => {
  const f = fixture(), before = sourceHashes(f);
  mkdirSync(f.outputDirectory, { recursive: true });
  symlinkSync(f.source, path.join(f.outputDirectory, "openchat"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => stageMainnetPublication(f), /isolated regular staged file/);
  assert.deepEqual(sourceHashes(f), before);
});

test("refuses hard-linked staged assets instead of overwriting their source", () => {
  const f = fixture(), before = sourceHashes(f);
  mkdirSync(path.join(f.outputDirectory, "openchat"), { recursive: true });
  linkSync(path.join(f.source, "local-app-v1.json"), path.join(f.outputDirectory, "openchat", "local-app-v1.json"));
  assert.throws(() => stageMainnetPublication(f), /isolated regular staged file/);
  assert.deepEqual(sourceHashes(f), before);
  assert.equal(existsSync(path.join(f.outputDirectory, "openchat", "local-processor-v1.js")), false);
});

test("rejects a broken processor/catalog/directory integrity chain before writing", () => {
  for (const name of names) {
    const f = fixture(), target = path.join(f.source, name);
    if (name.endsWith(".js")) writeFileSync(target, readFileSync(target, "utf8") + "\n// changed\n");
    else {
      const value = json(target);
      if (name === "local-app-v1.json") value.apps[0].destination = "https://changed.example.net/openchat/import";
      else if (name === "apps-v1.json") value.apps[0].catalog.byteLength++;
      else value.byteLength++;
      writeFileSync(target, JSON.stringify(value));
    }
    assert.throws(() => stageMainnetPublication(f), /match/, name);
    assert.equal(existsSync(f.outputDirectory), false);
  }
});

test("never publishes private recipient setup, capabilities or saved-Type matching", () => {
  for (const mutate of [
    app => { app.recipientLabel = "Private account"; },
    app => { app.deliveryEncryption = { key: "private-recipient" }; },
    app => { app.actions[0].processorContext = { types: [{ name: "Private saved Type" }] }; },
    app => { app.actions[0].draftEditor = { choices: [{ label: "Private Type" }] }; },
    app => { app.deliveryInbox = { version: 1, kind: "ic-canister", host: "https://icp-api.io", canisterId, writeCapability: "private" }; },
    app => { app.actions[0].definition.rules.push({ field: "typeId", map: [{ value: "private" }] }); },
  ]) {
    const f = fixture(); replaceCatalog(f, mutate);
    assert.throws(() => stageMainnetPublication(f), /private|Private/);
    assert.equal(existsSync(f.outputDirectory), false);
  }
});

test("removes only local connect-src origins and preserves framing/security headers", () => {
  const f = fixture();
  const policy = [{ match: "index.html", headers: {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' http://127.0.0.1:40436 http://localhost:* https://device.ts.net ws://[::1]:8080 https://10.0.0.2 https://192.168.1.2 https://icp-api.io https://*.icp0.io https://api.frankfurter.dev; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; frame-ancestors https://oc.app http://localhost:5190;",
    "X-Frame-Options": "", "X-Content-Type-Options": "nosniff", "Permissions-Policy": "camera=()",
  } }];
  writeFileSync(path.join(f.root, "public", ".ic-assets.json5"), JSON.stringify(policy, null, 2));
  const original = readFileSync(path.join(f.root, "public", ".ic-assets.json5"), "utf8");
  stageMainnetPublication(f);
  const staged = json(path.join(f.outputDirectory, ".ic-assets.json5"));
  const expected = structuredClone(policy);
  expected[0].headers["Content-Security-Policy"] = policy[0].headers["Content-Security-Policy"].replace(
    "http://127.0.0.1:40436 http://localhost:* https://device.ts.net ws://[::1]:8080 https://10.0.0.2 https://192.168.1.2 ", "");
  assert.deepEqual(staged, expected);
  assert.equal(readFileSync(path.join(f.root, "public", ".ic-assets.json5"), "utf8"), original);
});

test("fails closed when an explicit asset CSP/connect policy is absent or ambiguous", () => {
  for (const policy of ["[]", '[{"headers":{"Content-Security-Policy":"default-src self;"}}]',
    '[{"headers":{"Content-Security-Policy":"connect-src self; connect-src https://icp-api.io;"}}]']) {
    const f = fixture(); writeFileSync(path.join(f.root, "public", ".ic-assets.json5"), policy);
    assert.throws(() => stageMainnetPublication(f), /asset CSP|Asset policy/);
    assert.equal(existsSync(f.outputDirectory), false);
  }
});
