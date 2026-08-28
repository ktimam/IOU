// CDP pre-flight healer: long-driven Chrome/WebView instances occasionally wedge their DevTools
// WebSocket handshake (the HTTP /json endpoints still answer). Test each port with a real
// connectOverCDP and RELAUNCH any wedged profile (sessions are durable — a relaunch costs ~10s).
// Machine-specific paths are required either as CLI options or OC_LIVE_* environment variables:
//   pnpm exec tsx scripts/live/heal-cdp.ts --chrome-executable <chrome.exe> \
//     --profile-root <profiles-dir> 19241 19242
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";
import {
  assertLoopbackPortAvailable,
  CDP_PORTS,
  matchesExactCdpChromeProcess,
  type CdpProcessSnapshot,
} from "./cdpPorts";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const USAGE = `usage: heal-cdp.ts [options] <port> [port…]
  --chrome-executable <path>   or OC_LIVE_CHROME_EXECUTABLE
  --profile-root <path>        or OC_LIVE_PROFILE_ROOT
  --desktop-executable <path>  or OC_LIVE_DESKTOP_EXECUTABLE`;

type PathOption =
  | "chrome-executable"
  | "profile-root"
  | "desktop-executable";

type Invocation = Readonly<{
  ports: number[];
  paths: Partial<Record<PathOption, string>>;
}>;

type HarnessPaths = Readonly<{
  chromeExecutable?: string;
  profileRoot?: string;
  desktopExecutable?: string;
}>;

type Profile = { name: string; kind: "chrome" | "exe"; args: string[] };
const PROFILES: Record<number, Profile> = {
  [CDP_PORTS.manager]: { name: "manager", kind: "chrome", args: ["http://localhost:5003/", "http://127.0.0.1:3000/"] },
  // mother stays NARROW so she boots into the v2 (mobile) UI tree — the matrix depends on it.
  [CDP_PORTS.mother]: { name: "mother", kind: "chrome", args: ["--window-size=390,844", "http://localhost:5003/", "http://127.0.0.1:3000/"] },
  [CDP_PORTS.child]: { name: "child", kind: "chrome", args: ["http://localhost:5003/", "http://127.0.0.1:3000/"] },
  [CDP_PORTS.fatherIou]: { name: "father-iou", kind: "chrome", args: ["http://127.0.0.1:3000/"] },
  [CDP_PORTS.fatherOpenChat]: { name: "father-exe", kind: "exe", args: [] },
};

function parseInvocation(args: string[]): Invocation {
  const paths: Partial<Record<PathOption, string>> = {};
  const ports: number[] = [];
  const supported = new Set<PathOption>([
    "chrome-executable",
    "profile-root",
    "desktop-executable",
  ]);

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = token.slice(2, equals < 0 ? undefined : equals) as PathOption;
      if (!supported.has(name)) throw new Error(`unknown option --${name}\n${USAGE}`);
      if (paths[name] !== undefined) throw new Error(`duplicate option --${name}`);
      const value = equals < 0 ? args[++index] : token.slice(equals + 1);
      if (!value || value.startsWith("--")) {
        throw new Error(`--${name} requires a path\n${USAGE}`);
      }
      paths[name] = value;
      continue;
    }

    if (!/^\d+$/.test(token)) throw new Error(`invalid CDP port ${token}\n${USAGE}`);
    const port = Number(token);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`invalid CDP port ${token}\n${USAGE}`);
    }
    ports.push(port);
  }

  if (ports.length === 0) throw new Error(USAGE);
  if (new Set(ports).size !== ports.length) throw new Error("duplicate CDP port");
  return { ports, paths };
}

function configuredPath(
  invocation: Invocation,
  option: PathOption,
  environmentName: string,
  kind: "file" | "directory",
): string {
  const raw = invocation.paths[option] ?? process.env[environmentName];
  if (!raw?.trim()) {
    throw new Error(`--${option} or ${environmentName} is required\n${USAGE}`);
  }
  if (!win32.isAbsolute(raw)) {
    throw new Error(`Configured --${option} must be an absolute Windows path`);
  }
  const resolved = win32.normalize(raw.trim());
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`Configured --${option} does not exist: ${resolved}`);
  }
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(`Configured --${option} is not a ${kind}: ${resolved}`);
  }
  return resolved;
}

function configuredProfilePath(profileRoot: string, profile: Profile): string {
  const profilePath = win32.join(profileRoot, profile.name);
  let stats;
  try {
    stats = statSync(profilePath);
  } catch {
    throw new Error(`Configured durable profile does not exist: ${profilePath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Configured durable profile is not a directory: ${profilePath}`);
  }
  return profilePath;
}

function resolveHarnessPaths(invocation: Invocation): HarnessPaths {
  const profiles = invocation.ports.map((port) => {
    const profile = PROFILES[port];
    if (!profile) throw new Error(`unknown port ${port}`);
    return profile;
  });
  const needsChrome = profiles.some((profile) => profile.kind === "chrome");
  const needsDesktop = profiles.some((profile) => profile.kind === "exe");
  const paths: HarnessPaths = {
    chromeExecutable: needsChrome
      ? configuredPath(
          invocation,
          "chrome-executable",
          "OC_LIVE_CHROME_EXECUTABLE",
          "file",
        )
      : undefined,
    profileRoot: needsChrome
      ? configuredPath(
          invocation,
          "profile-root",
          "OC_LIVE_PROFILE_ROOT",
          "directory",
        )
      : undefined,
    desktopExecutable: needsDesktop
      ? configuredPath(
          invocation,
          "desktop-executable",
          "OC_LIVE_DESKTOP_EXECUTABLE",
          "file",
        )
      : undefined,
  };

  if (paths.profileRoot) {
    for (const profile of profiles.filter((item) => item.kind === "chrome")) {
      configuredProfilePath(paths.profileRoot, profile);
    }
  }
  return paths;
}

function ps(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function processSnapshots(imageName: string): CdpProcessSnapshot[] {
  const encodedName = powershellLiteral(imageName);
  const raw = ps(
    `@(Get-CimInstance Win32_Process -Filter "Name=${encodedName}" | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`,
  );
  if (!raw) return [];
  const decoded = JSON.parse(raw) as
    | Record<string, unknown>
    | Array<Record<string, unknown>>;
  return (Array.isArray(decoded) ? decoded : [decoded]).flatMap((entry) => {
    const processId = Number(entry.ProcessId);
    const executablePath = typeof entry.ExecutablePath === "string" ? entry.ExecutablePath : "";
    const commandLine = typeof entry.CommandLine === "string" ? entry.CommandLine : "";
    return Number.isSafeInteger(processId) && processId > 0
      ? [{ processId, executablePath, commandLine }]
      : [];
  });
}

function sameExecutablePath(actual: string, expected: string): boolean {
  return win32.normalize(actual).toLocaleLowerCase("en-US") ===
    win32.normalize(expected).toLocaleLowerCase("en-US");
}

function exactChromeOwners(
  port: number,
  profilePath: string,
  chromeExecutable: string,
): CdpProcessSnapshot[] {
  return processSnapshots(win32.basename(chromeExecutable)).filter((process) =>
    matchesExactCdpChromeProcess(process, {
      executablePath: chromeExecutable,
      profilePath,
      port,
    }),
  );
}

function exactDesktopOwners(desktopExecutable: string): CdpProcessSnapshot[] {
  return processSnapshots(win32.basename(desktopExecutable)).filter((process) =>
    sameExecutablePath(process.executablePath, desktopExecutable),
  );
}

function requireUnambiguousOwner(
  matches: CdpProcessSnapshot[],
  label: string,
): CdpProcessSnapshot | undefined {
  if (matches.length > 1) {
    throw new Error(`Refusing ambiguous ${label}: found ${matches.length} matching processes`);
  }
  return matches[0];
}

function stopExactProcess(process: CdpProcessSnapshot): void {
  ps(`Stop-Process -Id ${process.processId} -Force -ErrorAction Stop; Start-Sleep 3`);
}

function loopbackListenerBelongsToProcessTree(port: number, rootProcessId: number): boolean {
  const result = ps(`
$allProcesses = @(Get-CimInstance Win32_Process)
$parents = @{}
foreach ($process in $allProcesses) { $parents[[int]$process.ProcessId] = [int]$process.ParentProcessId }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
if ($listeners.Count -ne 1) { 'false'; exit }
$candidatePid = [int]$listeners[0].OwningProcess
$seen = @{}
while ($candidatePid -gt 0 -and -not $seen.ContainsKey($candidatePid)) {
  if ($candidatePid -eq ${rootProcessId}) { 'true'; exit }
  $seen[$candidatePid] = $true
  if (-not $parents.ContainsKey($candidatePid)) { break }
  $candidatePid = [int]$parents[$candidatePid]
}
'false'
`);
  return result.trim().toLowerCase() === "true";
}

function stopExactConfiguredExecutable(executablePath: string): void {
  const owner = requireUnambiguousOwner(
    exactDesktopOwners(executablePath),
    "OpenChat desktop owner",
  );
  if (owner) stopExactProcess(owner);
}

function requirePath(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing validated ${label}`);
  return value;
}

async function healthy(
  port: number,
  profile: Profile,
  paths: HarnessPaths,
): Promise<boolean> {
  try {
    const owner =
      profile.kind === "chrome"
        ? requireUnambiguousOwner(
            exactChromeOwners(
              port,
              configuredProfilePath(
                requirePath(paths.profileRoot, "profile root"),
                profile,
              ),
              requirePath(paths.chromeExecutable, "Chrome executable"),
            ),
            `${profile.name} Chrome owner`,
          )
        : requireUnambiguousOwner(
            exactDesktopOwners(
              requirePath(paths.desktopExecutable, "desktop executable"),
            ),
            "OpenChat desktop owner",
          );
    if (!owner || !loopbackListenerBelongsToProcessTree(port, owner.processId)) return false;
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 12000 });
    await b.close(); // connectOverCDP close() only disconnects; the browser keeps running
    return true;
  } catch {
    return false;
  }
}

async function relaunch(
  port: number,
  p: Profile,
  paths: HarnessPaths,
): Promise<void> {
  if (p.kind === "chrome") {
    const chromeExecutable = requirePath(
      paths.chromeExecutable,
      "Chrome executable",
    );
    const udd = configuredProfilePath(
      requirePath(paths.profileRoot, "profile root"),
      p,
    );
    const owner = requireUnambiguousOwner(
      exactChromeOwners(port, udd, chromeExecutable),
      `${p.name} Chrome owner`,
    );
    if (owner) stopExactProcess(owner);
    ps(`Get-ChildItem ${powershellLiteral(udd)} -Filter 'Singleton*' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue`);
    await assertLoopbackPortAvailable(port);
    const args = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", "--restore-last-session=false", ...p.args];
    ps(`Start-Process -FilePath ${powershellLiteral(chromeExecutable)} -ArgumentList @(${args.map(powershellLiteral).join(",")})`);
  } else {
    const desktopExecutable = requirePath(
      paths.desktopExecutable,
      "desktop executable",
    );
    stopExactConfiguredExecutable(desktopExecutable);
    await assertLoopbackPortAvailable(port);
    ps(`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1'; Start-Process ${powershellLiteral(desktopExecutable)}`);
  }
}

async function main() {
  const invocation = parseInvocation(process.argv.slice(2));
  const paths = resolveHarnessPaths(invocation);
  const { ports } = invocation;
  let healed = 0;
  for (const port of ports) {
    const p = PROFILES[port];
    if (!p) throw new Error(`unknown port ${port}`);
    if (await healthy(port, p, paths)) {
      console.log(`[heal] :${port} (${p.name}) OK`);
      continue;
    }
    console.log(`[heal] :${port} (${p.name}) WEDGED — relaunching`);
    await relaunch(port, p, paths);
    await new Promise((r) => setTimeout(r, p.kind === "exe" ? 12000 : 9000));
    if (p.kind === "exe") {
      // Per preference the desktop exe runs the v1 (classic) tree: widen past the 768px breakpoint
      // and reload so main.ts re-picks the tree (it boots narrow → v2 otherwise).
      try {
        execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${HERE}/oc-exe-v1.ps1`], { encoding: "utf8", timeout: 30000 });
        execFileSync("pnpm", ["exec", "tsx", `${HERE}/oc-exe-reload.ts`], { encoding: "utf8", timeout: 60000, shell: true });
      } catch (e) {
        console.log(`[heal] exe v1 restore step failed (non-fatal): ${(e as Error).message.slice(0, 100)}`);
      }
    }
    if (!(await healthy(port, p, paths))) {
      console.error(`[heal] :${port} STILL WEDGED after relaunch`);
      process.exit(1);
    }
    console.log(`[heal] :${port} healed`);
    healed++;
  }
  console.log(`[heal] done — ${healed} relaunched, ${ports.length - healed} already healthy`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
