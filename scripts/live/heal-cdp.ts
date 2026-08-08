// CDP pre-flight healer: long-driven Chrome/WebView instances occasionally wedge their DevTools
// WebSocket handshake (the HTTP /json endpoints still answer). Test each port with a real
// connectOverCDP and RELAUNCH any wedged profile (sessions are durable — a relaunch costs ~10s).
//   pnpm exec tsx scripts/live/heal-cdp.ts 19241 19242 [19243 19231 19222]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import {
  assertLoopbackPortAvailable,
  CDP_PORTS,
  matchesExactCdpChromeProcess,
  type CdpProcessSnapshot,
} from "./cdpPorts";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXE = "C:\\Kiko\\MyProjects\\Blockchain\\ICP\\open-chat-cycle\\target\\debug\\open-chat.exe";
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

type Profile = { name: string; kind: "chrome" | "exe"; args: string[] };
const PROFILES: Record<number, Profile> = {
  [CDP_PORTS.manager]: { name: "manager", kind: "chrome", args: ["http://localhost:5003/", "http://127.0.0.1:3000/"] },
  // mother stays NARROW so she boots into the v2 (mobile) UI tree — the matrix depends on it.
  [CDP_PORTS.mother]: { name: "mother", kind: "chrome", args: ["--window-size=390,844", "http://localhost:5003/", "http://127.0.0.1:3000/"] },
  [CDP_PORTS.child]: { name: "child", kind: "chrome", args: ["http://localhost:5003/", "http://127.0.0.1:3000/"] },
  [CDP_PORTS.fatherIou]: { name: "father-iou", kind: "chrome", args: ["http://127.0.0.1:3000/"] },
  [CDP_PORTS.fatherOpenChat]: { name: "father-exe", kind: "exe", args: [] },
};

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

function exactChromeOwners(port: number, profilePath: string): CdpProcessSnapshot[] {
  return processSnapshots("chrome.exe").filter((process) =>
    matchesExactCdpChromeProcess(process, {
      executablePath: CHROME,
      profilePath,
      port,
    }),
  );
}

function exactDesktopOwners(): CdpProcessSnapshot[] {
  return processSnapshots("open-chat.exe").filter((process) =>
    sameExecutablePath(process.executablePath, EXE),
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
  if (!sameExecutablePath(executablePath, EXE)) {
    throw new Error("Refusing to stop an executable outside the configured OpenChat desktop path");
  }
  const owner = requireUnambiguousOwner(exactDesktopOwners(), "OpenChat desktop owner");
  if (owner) stopExactProcess(owner);
}

async function healthy(port: number, profile: Profile): Promise<boolean> {
  try {
    const owner =
      profile.kind === "chrome"
        ? requireUnambiguousOwner(
            exactChromeOwners(port, `C:\\Kiko\\oc-live\\profiles\\${profile.name}`),
            `${profile.name} Chrome owner`,
          )
        : requireUnambiguousOwner(exactDesktopOwners(), "OpenChat desktop owner");
    if (!owner || !loopbackListenerBelongsToProcessTree(port, owner.processId)) return false;
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 12000 });
    await b.close(); // connectOverCDP close() only disconnects; the browser keeps running
    return true;
  } catch {
    return false;
  }
}

async function relaunch(port: number, p: Profile): Promise<void> {
  if (p.kind === "chrome") {
    const udd = `C:\\Kiko\\oc-live\\profiles\\${p.name}`;
    const owner = requireUnambiguousOwner(
      exactChromeOwners(port, udd),
      `${p.name} Chrome owner`,
    );
    if (owner) stopExactProcess(owner);
    ps(`Get-ChildItem ${powershellLiteral(udd)} -Filter 'Singleton*' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue`);
    await assertLoopbackPortAvailable(port);
    const args = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", "--restore-last-session=false", ...p.args];
    ps(`Start-Process -FilePath '${CHROME}' -ArgumentList @(${args.map((a) => `'${a}'`).join(",")})`);
  } else {
    stopExactConfiguredExecutable(EXE);
    await assertLoopbackPortAvailable(port);
    ps(`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1'; Start-Process '${EXE}'`);
  }
}

async function main() {
  const ports = process.argv.slice(2).map(Number).filter(Boolean);
  if (ports.length === 0) throw new Error("usage: heal-cdp.ts <port> [port…]");
  let healed = 0;
  for (const port of ports) {
    const p = PROFILES[port];
    if (!p) throw new Error(`unknown port ${port}`);
    if (await healthy(port, p)) {
      console.log(`[heal] :${port} (${p.name}) OK`);
      continue;
    }
    console.log(`[heal] :${port} (${p.name}) WEDGED — relaunching`);
    await relaunch(port, p);
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
    if (!(await healthy(port, p))) {
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
