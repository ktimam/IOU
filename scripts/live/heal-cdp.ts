// CDP pre-flight healer: long-driven Chrome/WebView instances occasionally wedge their DevTools
// WebSocket handshake (the HTTP /json endpoints still answer). Test each port with a real
// connectOverCDP and RELAUNCH any wedged profile (sessions are durable — a relaunch costs ~10s).
//   pnpm exec tsx scripts/live/heal-cdp.ts 9241 9242 [9243 9231 9222]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXE = "C:\\Kiko\\MyProjects\\Blockchain\\ICP\\open-chat-cycle\\target\\debug\\open-chat.exe";
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

type Profile = { name: string; kind: "chrome" | "exe"; args: string[] };
const PROFILES: Record<number, Profile> = {
  9241: { name: "manager", kind: "chrome", args: ["http://localhost:5003/", "http://127.0.0.1:3000/"] },
  // mother stays NARROW so she boots into the v2 (mobile) UI tree — the matrix depends on it.
  9242: { name: "mother", kind: "chrome", args: ["--window-size=390,844", "http://localhost:5003/", "http://127.0.0.1:3000/"] },
  9243: { name: "child", kind: "chrome", args: ["http://localhost:5003/", "http://127.0.0.1:3000/"] },
  9231: { name: "father-iou", kind: "chrome", args: ["http://127.0.0.1:3000/"] },
  9222: { name: "father-exe", kind: "exe", args: [] },
};

function ps(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
}

async function healthy(port: number): Promise<boolean> {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 12000 });
    await b.close(); // connectOverCDP close() only disconnects; the browser keeps running
    return true;
  } catch {
    return false;
  }
}

function relaunch(port: number, p: Profile): void {
  if (p.kind === "chrome") {
    const udd = `C:\\Kiko\\oc-live\\profiles\\${p.name}`;
    ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'oc-live\\\\profiles\\\\${p.name}\\\\?' -or $_.CommandLine -match 'remote-debugging-port=${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 3; Get-ChildItem '${udd}' -Filter 'Singleton*' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue`);
    const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, "--no-first-run", "--no-default-browser-check", "--restore-last-session=false", ...p.args];
    ps(`Start-Process -FilePath '${CHROME}' -ArgumentList @(${args.map((a) => `'${a}'`).join(",")})`);
  } else {
    ps(`Get-Process open-chat -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 3; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${port}'; Start-Process '${EXE}'`);
  }
}

async function main() {
  const ports = process.argv.slice(2).map(Number).filter(Boolean);
  if (ports.length === 0) throw new Error("usage: heal-cdp.ts <port> [port…]");
  let healed = 0;
  for (const port of ports) {
    const p = PROFILES[port];
    if (!p) throw new Error(`unknown port ${port}`);
    if (await healthy(port)) {
      console.log(`[heal] :${port} (${p.name}) OK`);
      continue;
    }
    console.log(`[heal] :${port} (${p.name}) WEDGED — relaunching`);
    relaunch(port, p);
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
    if (!(await healthy(port))) {
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
