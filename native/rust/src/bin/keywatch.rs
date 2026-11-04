// Long-lived keyboard watcher. Reports two things on stdout, one line each:
//   t             a key was pressed (sent at most every 250 ms; says nothing about which key)
//   k <vk> <fl>   a key press while Caps Lock is on: virtual-key code and modifier bits
//                 (1 shift, 2 ctrl, 4 alt, 8 win, 16 caps). Used only to spot capital-letter
//                 commands such as GO AWAY; with Caps Lock off no key identity leaves here.
// Keys sent by other programs (not typed) are ignored. Every key is passed on untouched.
// Exits when stdin closes. This file is the whole hook: nothing is stored or sent anywhere.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod watch {
    use std::io::{BufRead, Write};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    static LINES: OnceLock<Sender<String>> = OnceLock::new();
    static ALLOW_INJECTED: AtomicBool = AtomicBool::new(false);
    static LAST_PULSE: AtomicU64 = AtomicU64::new(0);

    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12;
    const VK_CAPITAL: i32 = 0x14;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;

    fn down(vk: i32) -> bool {
        unsafe { GetKeyState(vk) as u16 & 0x8000 != 0 }
    }

    // Windows drops a hook that takes too long and every keystroke waits on it, so all
    // this does is note the key; a separate thread does the writing.
    unsafe extern "system" fn hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 && (w.0 == WM_KEYDOWN as usize || w.0 == WM_SYSKEYDOWN as usize) {
            let key = &*(l.0 as *const KBDLLHOOKSTRUCT);
            let injected = key.flags.0 & LLKHF_INJECTED.0 != 0;
            if !injected || ALLOW_INJECTED.load(Ordering::Relaxed) {
                if let Some(lines) = LINES.get() {
                    let now = GetTickCount64();
                    let last = LAST_PULSE.load(Ordering::Relaxed);
                    if now.wrapping_sub(last) >= 250 {
                        LAST_PULSE.store(now, Ordering::Relaxed);
                        let _ = lines.send("t".to_string());
                    }
                    if GetKeyState(VK_CAPITAL) & 1 != 0 {
                        let fl = down(VK_SHIFT) as u32
                            | (down(VK_CONTROL) as u32) << 1
                            | (down(VK_MENU) as u32) << 2
                            | ((down(VK_LWIN) || down(VK_RWIN)) as u32) << 3
                            | 16;
                        let _ = lines.send(format!("k {} {}", key.vkCode, fl));
                    }
                }
            }
        }
        CallNextHookEx(None, code, w, l)
    }

    fn say(line: &str) -> bool {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{line}").and_then(|_| out.flush()).is_ok()
    }

    pub fn run() -> i32 {
        ALLOW_INJECTED.store(std::env::args().any(|a| a == "--allow-injected"), Ordering::Relaxed);
        let (tx, rx) = channel::<String>();
        let _ = LINES.set(tx);
        std::thread::spawn(move || {
            for line in rx {
                if !say(&line) {
                    std::process::exit(0);
                }
            }
        });
        // the parent closing our stdin is the signal to stop
        std::thread::spawn(|| {
            let mut sink = String::new();
            let mut stdin = std::io::stdin().lock();
            while matches!(stdin.read_line(&mut sink), Ok(n) if n > 0) {
                sink.clear();
            }
            std::process::exit(0);
        });
        unsafe {
            let module = GetModuleHandleW(None).unwrap_or_default();
            if let Err(err) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), Some(module.into()), 0) {
                eprintln!("hook-failed {err}");
                return 1;
            }
            say("ready");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        }
        0
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(watch::run());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("harness-pet-keywatch only runs on Windows");
    std::process::exit(1);
}
