# Long-lived helper the pet talks to over stdin. Keeping one PowerShell process
# alive means setup happens once at startup, so button clicks stay instant.
#
# Commands (one per line):
#   focus {"process":"claude","pathContains":"WindowsApps","titleContains":""}
#                   bring the first matching app window to the front
#   keys win+h      press a key combination (modifiers: ctrl, shift, alt, win)
#   wheel 120 0     scroll the window under the cursor (120 = one notch up; then horizontal)
#   uia-click {"window":{...},"names":["voice mode","dictation"]}
#                   press the first button in that window whose accessible name
#                   contains one of the names (tried in order)
#   foreground      the window that has focus now, as a number (0 = none)
#   context         the text caret and window rectangle of the window you are typing in
#   refocus 1234 5678
#                   give focus to window 1234, but only while window 5678 has it
# Each command answers one line: "ok ..." or "err ...".

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class PetWin {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const uint KEYUP = 0x2;

    public static bool Focus(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        IntPtr fg = GetForegroundWindow();
        if (fg == h) return true;
        // Windows only lets the foreground thread hand focus away. Borrow its
        // input queue (the pet just got clicked, so that is usually the pet).
        uint me = GetCurrentThreadId();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        if (attached) AttachThreadInput(me, fgThread, false);
        return GetForegroundWindow() == h;
    }

    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

    public static long Foreground() { return GetForegroundWindow().ToInt64(); }

    // Hand focus back to the window a pet popup took it from, but only while
    // `from` (the pet) still has it: if the user has moved on, leave them there.
    public static string Refocus(IntPtr h, IntPtr from) {
        if (h == IntPtr.Zero || !IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) return "gone";
        if (from != IntPtr.Zero && GetForegroundWindow() != from) return "moved";
        return Focus(h) ? "done" : "refused";
    }

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    public struct POINT { public int X; public int Y; }

    // Mouse wheel at the cursor: vertical then horizontal, 120 per notch.
    public static void Wheel(int dy, int dx) {
        if (dy != 0) mouse_event(0x0800, 0, 0, unchecked((uint)dy), UIntPtr.Zero);
        if (dx != 0) mouse_event(0x01000, 0, 0, unchecked((uint)dx), UIntPtr.Zero);
    }

    // Left-click at physical screen coordinates, then put the cursor back.
    public static void Click(int x, int y) {
        SetProcessDPIAware();
        POINT old; GetCursorPos(out old);
        SetCursorPos(x, y);
        mouse_event(0x2, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
        SetCursorPos(old.X, old.Y);
    }

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
    [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
        public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret;
    }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);

    // "caret cx cy cw ch  fx fy fw fh" in physical pixels: the text caret of the window you are
    // typing in (caret = 0 when the app does not report one) and that window's rectangle.
    public static string Context() {
        SetProcessDPIAware();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return "none";
        RECT w;
        if (!GetWindowRect(fg, out w)) return "none";
        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        int caret = 0, cx = 0, cy = 0, cw = 0, ch = 0;
        if (GetGUIThreadInfo(GetWindowThreadProcessId(fg, IntPtr.Zero), ref info) && info.hwndCaret != IntPtr.Zero) {
            POINT p; p.X = info.rcCaret.L; p.Y = info.rcCaret.T;
            if (ClientToScreen(info.hwndCaret, ref p)) {
                caret = 1; cx = p.X; cy = p.Y; cw = info.rcCaret.R - info.rcCaret.L; ch = info.rcCaret.B - info.rcCaret.T;
            }
        }
        return caret + " " + cx + " " + cy + " " + cw + " " + ch + " " + w.L + " " + w.T + " " + (w.R - w.L) + " " + (w.B - w.T);
    }

    public static void Combo(byte[] mods, byte key) {
        foreach (var m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 0, UIntPtr.Zero);
        Thread.Sleep(30);
        keybd_event(key, 0, KEYUP, UIntPtr.Zero);
        for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], 0, KEYUP, UIntPtr.Zero);
    }
}
'@

# Compiling C# takes ~20 s on some machines, so the result is cached as a DLL
# and rebuilt only when this script changes.
$cacheDir = Join-Path $env:LOCALAPPDATA 'harness-pet'
$hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 12)
$dll = Join-Path $cacheDir "PetWin-$hash.dll"
if (-not (Test-Path $dll)) {
    New-Item -ItemType Directory -Force $cacheDir | Out-Null
    Get-ChildItem $cacheDir -Filter 'PetWin-*.dll' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition $source -OutputAssembly $dll
}
Add-Type -Path $dll

# Matcher fields (all optional, all must match): process, pathContains, titleContains.
function Find-AppWindow($m) {
    if (-not $m -or -not ($m.process -or $m.pathContains -or $m.titleContains)) { return $null }
    $procs = if ($m.process) { Get-Process -Name $m.process -ErrorAction SilentlyContinue } else { Get-Process }
    $procs | Where-Object {
        $_.MainWindowHandle -ne 0 -and
        (-not $m.pathContains -or ($_.Path -and $_.Path.ToLower().Contains(([string]$m.pathContains).ToLower()))) -and
        (-not $m.titleContains -or $_.MainWindowTitle.ToLower().Contains(([string]$m.titleContains).ToLower()))
    } | Select-Object -First 1
}

$mods = @{ ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; meta = 0x5B }
$named = @{ space = 0x20; enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; capslock = 0x14 }

function Get-Vk([string]$k) {
    $k = $k.ToLower()
    if ($named.ContainsKey($k)) { return [byte]$named[$k] }
    if ($k -match '^f([1-9]|1[0-9]|2[0-4])$') { return [byte](0x6F + [int]$Matches[1]) }
    if ($k -match '^[a-z0-9]$') { return [byte][char]$k.ToUpper() }
    if ($k -eq '.' -or $k -eq 'period') { return [byte]0xBE }
    throw "unknown key '$k'"
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Claude Desktop is Chromium: its button tree appears only after the first
# accessibility query, and a freshly opened chat may still be loading, so retry.
function Invoke-AppButton($matcher, [string[]]$names) {
    # An empty name would match every button, so refuse anything that short.
    $names = @($names | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -ge 3 })
    if (-not $names) { return 'err no-names' }
    $p = Find-AppWindow $matcher
    if (-not $p) { return 'err no-window' }
    $root = [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $win = $root.Current.BoundingRectangle
    $isButton = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    for ($try = 0; $try -lt 5; $try++) {
        $buttons = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, $isButton) | Where-Object {
            $r = $_.Current.BoundingRectangle
            # skip the sidebar, where chat titles are buttons too
            -not $_.Current.IsOffscreen -and $r.Width -gt 0 -and ($r.X + $r.Width / 2) -gt ($win.X + $win.Width * 0.25)
        })
        foreach ($n in $names) {
            $hit = $buttons | Where-Object { $_.Current.Name -and $_.Current.Name.ToLower().Contains($n.ToLower()) } | Select-Object -First 1
            if (-not $hit) { continue }
            $label = $hit.Current.Name
            try {
                $hit.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
            } catch {
                $r = $hit.Current.BoundingRectangle
                [PetWin]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
            }
            return "ok clicked $label"
        }
        Start-Sleep -Milliseconds 400
    }
    'err not-found'
}

[Console]::Out.WriteLine('ready')
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if (-not $line) { continue }
    try {
        $parts = $line -split '\s+', 2
        switch ($parts[0]) {
            'focus' {
                if ($parts.Count -lt 2) { [Console]::Out.WriteLine('err no-matcher'); break }
                $p = Find-AppWindow ($parts[1] | ConvertFrom-Json)
                if (-not $p) { [Console]::Out.WriteLine('err no-window'); break }
                $ok = [PetWin]::Focus($p.MainWindowHandle)
                [Console]::Out.WriteLine("ok focus $ok")
            }
            'keys' {
                $tokens = $parts[1].ToLower() -split '\+'
                $modVks = @($tokens | Select-Object -SkipLast 1 | ForEach-Object {
                    if (-not $mods.ContainsKey($_)) { throw "unknown modifier '$_'" }
                    [byte]$mods[$_]
                })
                [PetWin]::Combo([byte[]]$modVks, (Get-Vk $tokens[-1]))
                [Console]::Out.WriteLine('ok keys')
            }
            'uia-click' {
                if ($parts.Count -lt 2) { [Console]::Out.WriteLine('err no-names'); break }
                $req = $parts[1] | ConvertFrom-Json
                [Console]::Out.WriteLine((Invoke-AppButton $req.window ([string[]]$req.names)))
            }
            'wheel' {
                $n = @(($parts[1] -split '\s+') | ForEach-Object { [int]$_ })
                [PetWin]::Wheel($n[0], $(if ($n.Count -gt 1) { $n[1] } else { 0 }))
                [Console]::Out.WriteLine('ok wheel')
            }
            'context' { [Console]::Out.WriteLine("ok $([PetWin]::Context())") }
            'foreground' { [Console]::Out.WriteLine("ok $([PetWin]::Foreground())") }
            'refocus' {
                $n = @(($parts[1] -split '\s+') | ForEach-Object { [long]$_ })
                $from = if ($n.Count -gt 1) { $n[1] } else { 0 }
                [Console]::Out.WriteLine("ok refocus $([PetWin]::Refocus([IntPtr]::new($n[0]), [IntPtr]::new($from)))")
            }
            'ping' { [Console]::Out.WriteLine('ok pong') }
            default { [Console]::Out.WriteLine("err unknown-command $($parts[0])") }
        }
    } catch {
        [Console]::Out.WriteLine("err $($_.Exception.Message)")
    }
}
