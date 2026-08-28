# Make a specific durable-profile window the SOLE OS foreground window (minimize all competitors),
# so WebAuthn ceremonies don't fail with "page does not have focus".
#   powershell -File focus-window.ps1 -Match "profiles\manager"
#   powershell -File focus-window.ps1 -Match "open-chat.exe" -ProcName open-chat
param([Parameter(Mandatory)][string]$Match, [string]$ProcName = "chrome")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$SW_MINIMIZE = 6; $SW_RESTORE = 9

# Minimize every OTHER top-level app window that could steal focus (all chrome + open-chat windows).
Get-Process -Name chrome, open-chat -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  ForEach-Object {
    $isTarget = $false
    try { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine; if ($cl -match [regex]::Escape($Match)) { $isTarget = $true } } catch {}
    if (-not $isTarget) { [Win32]::ShowWindow($_.MainWindowHandle, $SW_MINIMIZE) | Out-Null }
  }

$proc = Get-CimInstance Win32_Process -Filter "Name='$ProcName.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match [regex]::Escape($Match) } |
  ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { "no window for '$Match'"; exit 1 }

$h = $proc.MainWindowHandle
$fg = [Win32]::GetForegroundWindow()
$fgThread = [Win32]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$myThread = [Win32]::GetCurrentThreadId()
[Win32]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
[Win32]::ShowWindow($h, $SW_RESTORE) | Out-Null
[Win32]::BringWindowToTop($h) | Out-Null
[Win32]::SetForegroundWindow($h) | Out-Null
[Win32]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
"foregrounded PID $($proc.Id) (sole foreground: $Match)"
