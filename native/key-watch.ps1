# Long-lived keyboard watcher. Reports two things on stdout, one line each:
#   t             a key was pressed (sent at most every 250 ms; says nothing about which key)
#   k <vk> <fl>   a key press while Caps Lock is on: virtual-key code and modifier bits
#                 (1 shift, 2 ctrl, 4 alt, 8 win, 16 caps). Used only to spot capital-letter
#                 commands such as GO AWAY; with Caps Lock off no key identity leaves here.
# Keys sent by other programs (not typed) are ignored. Exits when stdin closes.
param([switch]$AllowInjected)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class KeyWatch {
    delegate IntPtr Proc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern short GetKeyState(int vk);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }

    static Proc proc;
    static bool allowInjected;
    static long lastPulse;
    static readonly BlockingCollection<string> lines = new BlockingCollection<string>();

    static bool Down(int vk) { return (GetKeyState(vk) & 0x8000) != 0; }

    static IntPtr Hook(int code, IntPtr w, IntPtr l) {
        // WM_KEYDOWN / WM_SYSKEYDOWN
        if (code >= 0 && (w.ToInt32() == 0x100 || w.ToInt32() == 0x104)) {
            KBD k = (KBD)Marshal.PtrToStructure(l, typeof(KBD));
            bool injected = (k.flags & 0x10) != 0;
            if (allowInjected || !injected) {
                long now = Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000);
                if (now - lastPulse >= 250) { lastPulse = now; lines.Add("t"); }
                if ((GetKeyState(0x14) & 1) != 0) {
                    int fl = (Down(0x10) ? 1 : 0) | (Down(0x11) ? 2 : 0) | (Down(0x12) ? 4 : 0) | ((Down(0x5B) || Down(0x5C)) ? 8 : 0) | 16;
                    lines.Add("k " + k.vk + " " + fl);
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, w, l);
    }

    public static void Run(bool injected) {
        allowInjected = injected;
        var writer = new Thread(() => {
            var o = Console.Out;
            foreach (var s in lines.GetConsumingEnumerable()) { o.WriteLine(s); o.Flush(); }
        });
        writer.IsBackground = true;
        writer.Start();
        // the parent closing our stdin is the signal to stop
        var reader = new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
        reader.IsBackground = true;
        reader.Start();
        proc = Hook;
        IntPtr hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0); // WH_KEYBOARD_LL
        if (hook == IntPtr.Zero) { Console.Error.WriteLine("hook-failed " + Marshal.GetLastWin32Error()); return; }
        Console.Out.WriteLine("ready");
        Console.Out.Flush();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    }
}
'@

# Compiled once and cached, like win-helper.ps1.
$cacheDir = Join-Path $env:LOCALAPPDATA 'harness-pet'
$hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 12)
$dll = Join-Path $cacheDir "KeyWatch-$hash.dll"
if (-not (Test-Path $dll)) {
    New-Item -ItemType Directory -Force $cacheDir | Out-Null
    Get-ChildItem $cacheDir -Filter 'KeyWatch-*.dll' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition $source -OutputAssembly $dll
}
Add-Type -Path $dll
[KeyWatch]::Run([bool]$AllowInjected)
