# Keep ONE window RESTORED + OS-foreground continuously, from a SINGLE long-lived process.
#
# Why this exists (and why focus-window.ps1 alone isn't enough for WebAuthn):
#   * WebAuthn refuses with "the page does not have focus" unless the page is BOTH focused AND
#     visible. A MINIMIZED window is `document.visibilityState === "hidden"`, which fails the check
#     even when SetForegroundWindow reported success — and focus-window.ps1 MINIMIZES every competing
#     chrome/open-chat window, so provisioning profile B leaves profile A minimized.
#   * The ceremony is not instantaneous: OpenChat fetches a registration challenge and only then calls
#     navigator.credentials.create(). Focus asserted once before the click is routinely lost in that
#     gap — including by the transient console window each `powershell.exe` spawn creates.
# So: restore + foreground in a loop, from one process, for the whole ceremony.
#
#   powershell -File hold-focus.ps1 -Match "profiles\manager" -Seconds 120
#   powershell -File hold-focus.ps1 -Match "open-chat.exe" -ProcName open-chat -Seconds 120
param([Parameter(Mandatory)][string]$Match, [string]$ProcName = "chrome", [int]$Seconds = 120)

Add-Type @"
using System; using System.Runtime.InteropServices;
public class HoldFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$SW_RESTORE = 9

$target = Get-CimInstance Win32_Process -Filter "Name='$ProcName.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match [regex]::Escape($Match) } |
  ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $target) { "hold-focus: no window for '$Match'"; exit 1 }
$h = $target.MainWindowHandle
"hold-focus: holding '$Match' (PID $($target.Id)) for ${Seconds}s"

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  # Un-minimize FIRST: a minimized window can be "foreground" yet still visibilityState=hidden.
  if ([HoldFg]::IsIconic($h)) { [void][HoldFg]::ShowWindow($h, $SW_RESTORE) }
  if ([HoldFg]::GetForegroundWindow() -ne $h) {
    $p = 0; $fgT = [HoldFg]::GetWindowThreadProcessId([HoldFg]::GetForegroundWindow(), [ref]$p)
    $my = [HoldFg]::GetCurrentThreadId()
    [void][HoldFg]::AttachThreadInput($fgT, $my, $true)
    [void][HoldFg]::ShowWindow($h, $SW_RESTORE)
    [void][HoldFg]::BringWindowToTop($h)
    [void][HoldFg]::SetForegroundWindow($h)
    [void][HoldFg]::AttachThreadInput($fgT, $my, $false)
  }
  Start-Sleep -Milliseconds 300
}
"hold-focus: done"
