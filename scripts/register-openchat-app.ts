// ZERO-INPUT OpenChat registration for the IOU app (Phase A "one-tap linking").
//
// Registers IOU's single AiAppManifest (name, description, and its one action — the same
// AiActionDefinition docs/openchat-registration.json encodes) with OpenChat's user_index
// `register_ai_app` endpoint. The endpoint accepts PLAIN CANDID, so this script needs no
// OpenChat internals: the IDL and the manifest→wire conversion live in the shared, browser-safe
// module src/features/openchat/registerAiApp.ts (also used by the in-app "Link to OpenChat"
// button). Re-running upserts by (owner, name), so this is the post-deploy step of a deploy
// pipeline (pnpm deploy:local chains it; CI should do the same).
//
// PUBLISHING (OpenChat Directory Phase B): a registration starts UNPUBLISHED — visible only to
// its owner (this script's registrar), so it will NOT appear in chats' Apps lists or the explorer
// for users until published. Re-registering preserves the published flag, so this is a one-time
// step per environment. Publication is governance-gated on OpenChat (test_mode: also open over
// msgpack); on a local replica the dfx `default` identity IS governance:
//   dfx canister call <user_index> publish_ai_app '(record { app_id = <id> : nat32 })'
//
// Run:   pnpm register:openchat [-- --dry-run] [-- --key-file <pem-path>]
//
// Env:
//   OC_USER_INDEX_CANISTER_ID   (required for a live run) OpenChat user_index canister id
//   IC_URL                      IC replica URL (default http://127.0.0.1:8080 — OpenChat local dfx)
//   OC_APP_PUBLIC_ORIGIN        Public origin of the IOU app itself, baked into the manifest's
//                               surface URLs (the chat_link page OpenChat opens). Default
//                               http://127.0.0.1:3000 (the dev server origin). MUST be the EXACT
//                               scheme+host+port the user browses IOU on — the surface page reuses
//                               the signed-in session and browser storage is origin-scoped, so
//                               "localhost" and "127.0.0.1" are NOT interchangeable. Set it to the
//                               deployed app origin for a real deployment.
//   OC_CONSUMER_PUBLIC_KEY_PEM  OPTIONAL explicit app-level delivery key (P-256 SPKI PEM).
//                               The IOU manifest sets per_user_keys=true, so delivery always uses
//                               each user's own paired key and the app-level key is unused — the
//                               script registers consumer_public_key = "" by default. Only legacy
//                               / per_user_keys=false manifests need a real key here (literal
//                               "\n" sequences are unescaped, so a single-line env value works;
//                               alternatively pass --key-file <path>).
//
// Identity: a persistent Ed25519 registrar identity is kept at .openchat-registrar.json (repo
// root, gitignored) so the owner principal — and therefore the (owner, name) upsert key — is
// stable across runs. OpenChat's register guard accepts a non-user principal in test_mode, which
// is exactly what a deploy script needs locally.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { buildIdl, buildManifestWire, type CandidOpt } from "../src/features/openchat/registerAiApp";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY_FILE = resolve(REPO_ROOT, ".openchat-registrar.json");

const TAG = "[register-openchat-app]";

// ---------------------------------------------------------------------------------------------
// Config / args
// ---------------------------------------------------------------------------------------------

function usage(): string {
  return [
    "Usage: pnpm register:openchat [-- --dry-run] [-- --key-file <pem-path>]",
    "",
    "Zero-input post-deploy step: the IOU manifest sets per_user_keys=true, so OpenChat",
    "delivers to each user's own paired key and no app-level key is needed — the script",
    "registers with an empty consumer_public_key by default.",
    "",
    "Required configuration (live runs only):",
    "  OC_USER_INDEX_CANISTER_ID   (not needed with --dry-run)",
    "      The OpenChat user_index canister id to register with.",
    "",
    "Optional:",
    "  IC_URL      IC replica URL (default http://127.0.0.1:8080)",
    "  OC_APP_PUBLIC_ORIGIN        Public origin of the IOU app, baked into the manifest's",
    "      surface URLs (the chat_link page OpenChat opens in a chat). Default",
    "      http://127.0.0.1:3000 (dev origin). MUST match the exact scheme+host+port you browse",
    "      IOU on (localhost != 127.0.0.1 for browser storage); set it to the deployed app origin",
    "      for live runs.",
    "  OC_CONSUMER_PUBLIC_KEY_PEM  or  --key-file <path>",
    "      Explicit app-level delivery key (consumer P-256 SPKI PEM). Only needed for",
    "      legacy / per_user_keys=false manifests; when provided it is validated and",
    "      registered as-is.",
    "  --dry-run   build + candid-encode the manifest and print a summary without",
    "              touching the network (needs no env vars at all).",
  ].join("\n");
}

function parseArgs(argv: string[]): { keyFile?: string; dryRun: boolean; help: boolean } {
  let keyFile: string | undefined;
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // pnpm may forward the arg separator literally
    if (a === "--dry-run") dryRun = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--key-file") keyFile = argv[++i];
    else if (a.startsWith("--key-file=")) keyFile = a.slice("--key-file=".length);
    else {
      throw new Error(`unknown argument '${a}'\n\n${usage()}`);
    }
  }
  if (keyFile !== undefined && keyFile.trim() === "") {
    throw new Error(`--key-file needs a path\n\n${usage()}`);
  }
  return { keyFile, dryRun, help };
}

function loadConsumerPublicKey(keyFile: string | undefined): string {
  let pem: string | undefined;
  if (keyFile) {
    const path = resolve(process.cwd(), keyFile);
    if (!existsSync(path)) {
      throw new Error(`--key-file '${keyFile}' does not exist (looked at ${path})`);
    }
    pem = readFileSync(path, "utf8");
  } else if (process.env.OC_CONSUMER_PUBLIC_KEY_PEM) {
    // Unescape literal \n so a single-line env value (common in .env files / CI) works.
    pem = process.env.OC_CONSUMER_PUBLIC_KEY_PEM.replace(/\\n/g, "\n");
  }
  if (!pem || pem.trim() === "") {
    // No explicit key: register with an empty app-level key. The IOU manifest sets
    // per_user_keys=true, so delivery always uses each user's own paired key and the app key
    // is unused; buildManifestWire rejects "" if the manifest ever drops per-user keys.
    return "";
  }
  pem = pem.trim() + "\n";
  // Mirror the backend's validation so failures surface here with a friendly message.
  if (!pem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      "the consumer public key must be a SPKI PEM (missing 'BEGIN PUBLIC KEY').\n" +
        "Copy it from the IOU app: Settings -> Action inbox -> 'Copy public key'.",
    );
  }
  if (pem.length > 2000) {
    throw new Error("the consumer public key PEM is too long (max 2000 chars)");
  }
  return pem;
}

/** Load (or create on first run) the persistent registrar identity — stable owner principal. */
function loadOrCreateRegistrarIdentity(): Ed25519KeyIdentity {
  if (existsSync(IDENTITY_FILE)) {
    return Ed25519KeyIdentity.fromJSON(readFileSync(IDENTITY_FILE, "utf8"));
  }
  const identity = Ed25519KeyIdentity.generate();
  writeFileSync(IDENTITY_FILE, JSON.stringify(identity.toJSON()), { encoding: "utf8", mode: 0o600 });
  console.log(`${TAG} created a new registrar identity at ${IDENTITY_FILE} (keep it: it owns the registration)`);
  return identity;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const consumerPublicKeyPem = loadConsumerPublicKey(args.keyFile);
  const manifest = buildManifestWire(consumerPublicKeyPem, () => {
    console.warn(`${TAG} WARNING: docs/openchat-registration.json promptTemplate has drifted from`);
    console.warn(`${TAG}          actionManifest.ts — registering the actionManifest.ts prompt.`);
  });
  const { RegisterAiAppArgs, service } = buildIdl();

  // Encode eagerly: proves the manifest conforms to the candid contract before (and without)
  // any network call.
  const encoded = IDL.encode([RegisterAiAppArgs], [{ manifest }]);
  const actions = manifest.actions as { name: string }[];
  const surfaces = manifest.surfaces as { kind: string; url: string }[];
  const appKey = consumerPublicKeyPem === "" ? "empty (per-user keys)" : "explicit PEM";
  console.log(
    `${TAG} manifest "iou" (${actions.length} action${actions.length === 1 ? "" : "s"}: ` +
      `${actions.map((a) => a.name).join(", ")}; per-user keys: ${manifest.per_user_keys ? "on" : "off"}; ` +
      `app key: ${appKey}) — candid-encoded ${encoded.byteLength} bytes`,
  );
  for (const s of surfaces) {
    console.log(`${TAG} surface "${s.kind}": ${s.url}`);
  }

  if (args.dryRun) {
    console.log(`${TAG} --dry-run: skipping registration.`);
    return;
  }

  const userIndexCanisterId = process.env.OC_USER_INDEX_CANISTER_ID;
  if (!userIndexCanisterId) {
    throw new Error(`OC_USER_INDEX_CANISTER_ID is not set.\n\n${usage()}`);
  }
  const icUrl = process.env.IC_URL || "http://127.0.0.1:8080";

  const identity = loadOrCreateRegistrarIdentity();
  console.log(`${TAG} user_index : ${userIndexCanisterId}`);
  console.log(`${TAG} ic url     : ${icUrl}`);
  console.log(`${TAG} registrar  : ${identity.getPrincipal().toText()}`);

  const agent = new HttpAgent({ identity, host: icUrl });
  if (icUrl.includes("127.0.0.1") || icUrl.includes("localhost")) {
    await agent.fetchRootKey();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(() => service, { agent, canisterId: userIndexCanisterId });

  const response = await actor.register_ai_app({ manifest });
  if ("InvalidRequest" in response) {
    throw new Error(`register_ai_app rejected the manifest: ${response.InvalidRequest}`);
  }
  if ("Error" in response) {
    const [code, message] = response.Error as [number, CandidOpt<string>];
    throw new Error(`register_ai_app failed: OCError ${code}${message.length ? ` — ${message[0]}` : ""}`);
  }
  const registration = response.Success;
  console.log(
    `${TAG} registered: id ${registration.id}, name "${registration.manifest.name}", ` +
      `owner ${registration.owner.toText()}`,
  );

  const listed = await actor.ai_apps({});
  const apps = listed.Success.apps as { id: number; manifest: { name: string } }[];
  const mine = apps.find((a) => a.id === registration.id);
  if (mine) {
    console.log(`${TAG} ai_apps confirms "iou" is listed (id ${mine.id}, ${apps.length} app(s) total).`);
  } else {
    throw new Error(`registration succeeded but ai_apps does not list app id ${registration.id}`);
  }
}

main().catch((err: unknown) => {
  console.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
