# Put the OpenChat desktop exe into the v1 (classic) UI: the tree is chosen at page load by
# `width < 768 → v2` (main.ts, OC_MOBILE_LAYOUT=v2 dev toggle), so resize the native window WIDE.
# The caller must then RELOAD the WebView page (CDP) so main.ts re-evaluates.
#   powershell -ExecutionPolicy Bypass -File scripts/live/oc-exe-v1.ps1
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32V1 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$proc = Get-Process open-chat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { "no open-chat window"; exit 1 }
[Win32V1]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null   # SW_RESTORE (un-maximize/minimize)
# 1280x900 client area comfortably clears the 768px breakpoint.
[Win32V1]::SetWindowPos($proc.MainWindowHandle, [IntPtr]::Zero, 60, 40, 1280, 900, 0x0004) | Out-Null  # SWP_NOZORDER
"resized open-chat window to 1280x900 (PID $($proc.Id)); reload the page to re-evaluate the UI tree"
