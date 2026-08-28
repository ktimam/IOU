// Read-only readiness gate for the published IOU app in OpenChat's UserIndex.
//
// This deliberately uses an anonymous `ai_apps` query. UserIndex exposes only published apps to an
// anonymous caller, so finding the exact registration proves substantially more than a generic
// `/api/v2/status` response: the expected UserIndex canister exists, answers the expected API, and
// the IOU registration is public. Optional strict checks compare the complete response schema and
// the backend's manifest commitment. It never calls register_ai_app, publish_ai_app, or any update.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Actor, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { idlFactory as iouIdlFactory } from "../../src/backend/declarations";
import { buildIdl, type CandidOpt } from "../../src/features/openchat/registerAiApp";
import {
  encodeManifestCommitmentV2,
  MANIFEST_COMMITMENT_DOMAIN_V2,
} from "../../src/features/openchat/manifestCommitmentV2";

type Options = {
  host: string;
  userIndex: string;
  appName: string;
  expectedAppId?: number;
  expectedAppCanister?: string;
  expectedInbox?: string;
  expectedSurfaceOrigin?: string;
  expectedResponseSchemaFile?: string;
  verifyAppBinding: boolean;
};

function usage(): string {
  return [
    "Usage: tsx scripts/live/check-openchat-ai-app.ts --host <url> --user-index <principal>",
    "  [--app-name iou] [--expected-app-id <nat32>]",
    "  [--expected-app-canister <principal>] [--expected-inbox <principal>]",
    "  [--expected-surface-origin <https-origin>]",
    "  [--expected-response-schema-file <registration-json>] [--verify-app-binding true]",
    "",
    "Read-only: performs only fetchRootKey + anonymous UserIndex ai_apps query.",
  ].join("\n");
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const known = new Set([
    "--host",
    "--user-index",
    "--app-name",
    "--expected-app-id",
    "--expected-app-canister",
    "--expected-inbox",
    "--expected-surface-origin",
    "--expected-response-schema-file",
    "--verify-app-binding",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!known.has(argv[index])) throw new Error(`unknown argument '${argv[index]}'\n${usage()}`);
    if (argv[index + 1] === undefined) throw new Error(`${argv[index]} requires a value`);
  }

  const host = option(argv, "host");
  const userIndex = option(argv, "user-index");
  if (!host || !userIndex) throw new Error(usage());
  new URL(host);
  Principal.fromText(userIndex);

  const expectedAppIdText = option(argv, "expected-app-id");
  const expectedAppId = expectedAppIdText === undefined ? undefined : Number(expectedAppIdText);
  if (
    expectedAppId !== undefined &&
    (!Number.isSafeInteger(expectedAppId) || expectedAppId < 0 || expectedAppId > 0xffff_ffff)
  ) {
    throw new Error("--expected-app-id must be a nat32");
  }

  const expectedAppCanister = option(argv, "expected-app-canister");
  const expectedInbox = option(argv, "expected-inbox");
  if (expectedAppCanister) Principal.fromText(expectedAppCanister);
  if (expectedInbox) Principal.fromText(expectedInbox);

  const expectedSurfaceOriginText = option(argv, "expected-surface-origin");
  const expectedSurfaceOrigin = expectedSurfaceOriginText
    ? new URL(expectedSurfaceOriginText).origin
    : undefined;
  if (expectedSurfaceOriginText && expectedSurfaceOrigin !== expectedSurfaceOriginText) {
    throw new Error("--expected-surface-origin must be an exact origin without a path");
  }

  return {
    host,
    userIndex,
    appName: option(argv, "app-name") ?? "iou",
    expectedAppId,
    expectedAppCanister,
    expectedInbox,
    expectedSurfaceOrigin,
    expectedResponseSchemaFile: option(argv, "expected-response-schema-file"),
    verifyAppBinding: option(argv, "verify-app-binding") === "true",
  };
}

function principalOpt(value: CandidOpt<Principal> | undefined): string | undefined {
  return value && value.length === 1 ? value[0].toText() : undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const agent = new HttpAgent({ host: options.host });
  await agent.fetchRootKey();
  const { service } = buildIdl();
  // The checked-in IDL is intentionally the same one used by registration and browser linking.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(() => service, {
    agent,
    canisterId: options.userIndex,
  });
  const response = await actor.ai_apps({});
  if (!("Success" in response)) fail("UserIndex ai_apps did not return Success");

  // An anonymous caller receives published registrations only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps: any[] = response.Success.apps ?? [];
  const named = apps.filter((app) => app?.manifest?.name === options.appName);
  if (named.length !== 1) {
    fail(`expected one anonymously visible published '${options.appName}' app, found ${named.length}`);
  }
  const app = named[0];
  const appId = Number(app.id);
  const revision = app.updated;
  if (!Number.isSafeInteger(appId) || appId < 0 || typeof revision !== "bigint") {
    fail("UserIndex returned invalid app coordinates");
  }

  const appCanister = principalOpt(app.manifest.app_canister_id);
  const inbox = principalOpt(app.manifest.inbox_canister_id);
  if (options.expectedAppId !== undefined && appId !== options.expectedAppId) {
    fail(`published app id mismatch: expected ${options.expectedAppId}, got ${appId}`);
  }
  if (options.expectedAppCanister && appCanister !== options.expectedAppCanister) {
    fail(
      `published app canister mismatch: expected ${options.expectedAppCanister}, got ${appCanister ?? "none"}`,
    );
  }
  if (options.expectedInbox && inbox !== options.expectedInbox) {
    fail(`published inbox mismatch: expected ${options.expectedInbox}, got ${inbox ?? "none"}`);
  }
  if (app.manifest.per_user_keys !== true) fail("published IOU app does not require per-user keys");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = app.manifest.actions ?? [];
  if (actions.length < 1) fail("published IOU app has no actions");
  let responseSchemaVerified = false;
  if (options.expectedResponseSchemaFile !== undefined) {
    let expectedSchema: unknown;
    let liveSchema: unknown;
    try {
      expectedSchema = JSON.parse(
        readFileSync(options.expectedResponseSchemaFile, "utf8"),
      ).responseSchema;
      liveSchema = JSON.parse(actions[0]?.response_schema ?? "");
    } catch {
      fail("published IOU response schema or expected registration JSON is invalid");
    }
    if (!isDeepStrictEqual(liveSchema, expectedSchema)) {
      fail("published IOU response schema does not match the local registration contract");
    }
    responseSchemaVerified = true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const surfaces: any[] = app.manifest.surfaces ?? [];
  const secureSurfaces = surfaces.filter((surface) => {
    try {
      const url = new URL(surface.url);
      return (
        (url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
        (surface.kind === "card" || surface.kind === "chat_link" || surface.kind === "home")
      );
    } catch {
      return false;
    }
  });
  if (secureSurfaces.length < 1) fail("published IOU app has no usable secure app surface");
  if (
    options.expectedSurfaceOrigin &&
    !secureSurfaces.some((surface) => new URL(surface.url).origin === options.expectedSurfaceOrigin)
  ) {
    fail(`published IOU app has no surface at ${options.expectedSurfaceOrigin}`);
  }

  let appBindingVerified = false;
  if (options.verifyAppBinding) {
    if (!options.expectedAppCanister) {
      fail("--verify-app-binding requires --expected-app-canister");
    }
    const backend = Actor.createActor(iouIdlFactory, {
      agent,
      canisterId: options.expectedAppCanister,
    }) as any;
    const config = await backend.get_config();
    const configured = config.ai_app_verification_binding?.[0];
    if (configured === undefined) fail("IOU backend has no AI app verification binding");

    const encodedCommitment = encodeManifestCommitmentV2({
      user_index_canister_id: Principal.fromText(options.userIndex),
      app_id: appId,
      app_revision: revision,
      owner: app.owner,
      canonical_name: options.appName,
      manifest: app.manifest,
    });
    const expectedHash = createHash("sha256")
      .update(Buffer.from(MANIFEST_COMMITMENT_DOMAIN_V2))
      .update(Buffer.from(encodedCommitment))
      .digest();
    const configuredInbox = principalOpt(configured.inbox_canister_id);
    const bindingMatches =
      configured.user_index_canister_id.toText() === options.userIndex &&
      Number(configured.app_id) === appId &&
      configured.app_revision === revision &&
      configured.owner.toText() === app.owner.toText() &&
      configured.canonical_name === options.appName &&
      configured.app_canister_id.toText() === options.expectedAppCanister &&
      configuredInbox === inbox &&
      Buffer.from(configured.manifest_hash).equals(expectedHash);
    if (!bindingMatches) {
      fail("IOU backend verification binding does not match the exact published manifest");
    }
    appBindingVerified = true;
  }

  console.log(
    JSON.stringify({
      ready: true,
      scope: "anonymous-published-registration",
      endToEndReady: false,
      userIndex: options.userIndex,
      app: {
        id: appId,
        revision: revision.toString(),
        name: app.manifest.name,
        owner: app.owner.toText(),
        appCanister,
        inbox,
        perUserKeys: true,
        responseSchemaVerified,
        appBindingVerified,
        actions: actions.map((action) => action.name),
        surfaces: secureSurfaces.map((surface) => ({ kind: surface.kind, url: surface.url })),
      },
      accountConnection: {
        checked: false,
        ready: false,
        reason:
          "not checked: each signed-in account must have an exact-current-revision app link; manifest updates require reconnect verification",
      },
    }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ready: false, error: message }));
  process.exitCode = 1;
});
