import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export type OpenChatWebSocket = {
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
};

export type OpenChatWebSocketConstructor = new (
  url: string,
  options?: { maxPayload?: number },
) => OpenChatWebSocket;

function optionValue(argv: readonly string[], name: string): string | undefined {
  const exact = argv.flatMap((value, index) =>
    value === `--${name}` ? [index] : [],
  );
  const inline = argv.filter((value) => value.startsWith(`--${name}=`));
  if (exact.length + inline.length > 1) {
    throw new Error(`duplicate --${name}`);
  }
  if (inline.length === 1) return inline[0].slice(name.length + 3);
  if (exact.length === 0) return undefined;
  const value = argv[exact[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a path`);
  }
  return value;
}

function requirePathKind(
  path: string,
  kind: "file" | "directory",
  label: string,
): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(`${label} is not a ${kind}: ${path}`);
  }
}

function isOutsideRoot(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return (
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..\\`) ||
    candidateRelative.startsWith("../") ||
    isAbsolute(candidateRelative)
  );
}

/** Resolve the explicit OpenChat frontend whose pinned `ws` dependency owns raw CDP transport. */
export function resolveOpenChatFrontend(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw =
    optionValue(argv, "openchat-frontend") ??
    environment.OC_LIVE_OPENCHAT_FRONTEND;
  if (!raw) {
    throw new Error(
      "--openchat-frontend or OC_LIVE_OPENCHAT_FRONTEND is required",
    );
  }
  if (raw !== raw.trim() || !isAbsolute(raw)) {
    throw new Error(
      "Configured OpenChat frontend must be an exact absolute path",
    );
  }
  const frontend = normalize(raw);
  requirePathKind(frontend, "directory", "Configured OpenChat frontend");
  requirePathKind(
    join(frontend, "package.json"),
    "file",
    "Configured OpenChat frontend package",
  );
  return frontend;
}

/** Resolve one fixed browser module below the explicitly configured OpenChat frontend. */
export function resolveOpenChatViteFsModule(
  frontendRelativePath: string,
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (
    !frontendRelativePath ||
    frontendRelativePath !== frontendRelativePath.trim() ||
    isAbsolute(frontendRelativePath)
  ) {
    throw new Error("OpenChat browser module path must be a non-empty relative path");
  }
  const frontend = resolveOpenChatFrontend(argv, environment);
  const modulePath = resolve(frontend, frontendRelativePath);
  if (isOutsideRoot(frontend, modulePath)) {
    throw new Error("Refusing an OpenChat browser module outside the configured frontend");
  }
  requirePathKind(modulePath, "file", "Configured OpenChat browser module");
  return `/@fs/${modulePath.replaceAll("\\", "/")}`;
}

export function loadOpenChatWebSocket(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OpenChatWebSocketConstructor {
  const frontend = resolveOpenChatFrontend(argv, environment);
  const requireFromFrontend = createRequire(join(frontend, "package.json"));
  let resolved: string;
  try {
    resolved = requireFromFrontend.resolve("ws");
  } catch {
    throw new Error(
      `Configured OpenChat frontend does not provide its required ws dependency: ${frontend}`,
    );
  }
  if (isOutsideRoot(frontend, resolved)) {
    throw new Error(
      "Refusing a ws dependency resolved outside the configured OpenChat frontend",
    );
  }
  const candidate = requireFromFrontend("ws") as unknown;
  if (typeof candidate !== "function") {
    throw new Error("Configured OpenChat ws dependency has an invalid export");
  }
  return candidate as OpenChatWebSocketConstructor;
}
