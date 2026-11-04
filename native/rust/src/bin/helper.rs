// Long-lived helper the pet talks to over stdin. Does what native/win-helper.ps1 does, in a
// process that costs a megabyte or two rather than a PowerShell and a .NET runtime.
//
// Commands (one per line; each answers one line, "ok ..." or "err ..."):
//   focus {"process":"claude","pathContains":"WindowsApps","titleContains":""}
//                   bring the first matching app window to the front
//   keys win+h      press a key combination (modifiers: ctrl, shift, alt, win)
//   wheel 120 0     scroll the window under the cursor (120 = one notch up; then horizontal)
//   uia-click {"window":{...},"names":["voice mode","dictation"]}
//                   press the first button in that window whose accessible name
//                   contains one of the names (tried in order)
//   foreground      the window that has focus now, as a number (0 = none)
//   foreground-app  the app that window belongs to: {"process":"claude","path":"...","title":"..."}
//   window-shown {"process":"Antigravity"}
//                   "ok true" while a matching app window is open on screen (not minimized or hidden)
//   context         the text caret and window rectangle of the window you are typing in
//   refocus 1234 5678
//                   give focus to window 1234, but only while window 5678 has it
//   restack 1234 5678
//                   put those always-on-top windows back in front if ordinary windows got
//                   above them; answers how many it moved
//   fullscreen      "ok true" while a full-screen game, video or presentation is in front
//   ping            "ok pong"
//
// It also announces, unprompted, lines the caller never asked for (see events):
//   ev foreground   another window came to the front
//   ev windows      an app window opened, closed, was minimized or restored
#![cfg_attr(windows, windows_subsystem = "windows")]

mod json {
    // Just enough JSON for the requests above, so the helper needs no parsing library.
    #[derive(Debug, PartialEq, Clone)]
    pub enum Json {
        Null,
        Bool(bool),
        Num(f64),
        Str(String),
        Arr(Vec<Json>),
        Obj(Vec<(String, Json)>),
    }

    impl Json {
        pub fn get(&self, key: &str) -> Option<&Json> {
            match self {
                Json::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
                _ => None,
            }
        }
        // a non-empty string field; absent, null and "" all mean "not set"
        pub fn text(&self, key: &str) -> Option<&str> {
            match self.get(key) {
                Some(Json::Str(s)) if !s.is_empty() => Some(s),
                _ => None,
            }
        }
    }

    pub fn parse(input: &str) -> Result<Json, String> {
        let chars: Vec<char> = input.chars().collect();
        let mut p = Parser { chars: &chars, at: 0, depth: 0 };
        let value = p.value()?;
        p.space();
        if p.at != chars.len() {
            return Err("trailing text".into());
        }
        Ok(value)
    }

    struct Parser<'a> {
        chars: &'a [char],
        at: usize,
        depth: u32,
    }

    impl Parser<'_> {
        fn space(&mut self) {
            while self.chars.get(self.at).is_some_and(|c| c.is_whitespace()) {
                self.at += 1;
            }
        }
        fn eat(&mut self, c: char) -> Result<(), String> {
            self.space();
            if self.chars.get(self.at) == Some(&c) {
                self.at += 1;
                Ok(())
            } else {
                Err(format!("expected {c}"))
            }
        }
        fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
            for c in word.chars() {
                if self.chars.get(self.at) != Some(&c) {
                    return Err("bad value".into());
                }
                self.at += 1;
            }
            Ok(value)
        }
        fn value(&mut self) -> Result<Json, String> {
            self.space();
            match self.chars.get(self.at) {
                Some('{') | Some('[') if self.depth >= 16 => Err("too deep".into()),
                Some('{') => self.object(),
                Some('[') => self.array(),
                Some('"') => self.string().map(Json::Str),
                Some('t') => self.word("true", Json::Bool(true)),
                Some('f') => self.word("false", Json::Bool(false)),
                Some('n') => self.word("null", Json::Null),
                Some(c) if *c == '-' || c.is_ascii_digit() => {
                    let start = self.at;
                    while self.chars.get(self.at).is_some_and(|c| "+-.eE0123456789".contains(*c)) {
                        self.at += 1;
                    }
                    let text: String = self.chars[start..self.at].iter().collect();
                    text.parse().map(Json::Num).map_err(|_| "bad number".to_string())
                }
                _ => Err("bad value".into()),
            }
        }
        fn object(&mut self) -> Result<Json, String> {
            self.eat('{')?;
            self.depth += 1;
            let mut items = Vec::new();
            self.space();
            if self.chars.get(self.at) == Some(&'}') {
                self.at += 1;
            } else {
                loop {
                    self.space();
                    let key = self.string()?;
                    self.eat(':')?;
                    items.push((key, self.value()?));
                    self.space();
                    match self.chars.get(self.at) {
                        Some(',') => self.at += 1,
                        Some('}') => {
                            self.at += 1;
                            break;
                        }
                        _ => return Err("expected , or }".into()),
                    }
                }
            }
            self.depth -= 1;
            Ok(Json::Obj(items))
        }
        fn array(&mut self) -> Result<Json, String> {
            self.eat('[')?;
            self.depth += 1;
            let mut items = Vec::new();
            self.space();
            if self.chars.get(self.at) == Some(&']') {
                self.at += 1;
            } else {
                loop {
                    items.push(self.value()?);
                    self.space();
                    match self.chars.get(self.at) {
                        Some(',') => self.at += 1,
                        Some(']') => {
                            self.at += 1;
                            break;
                        }
                        _ => return Err("expected , or ]".into()),
                    }
                }
            }
            self.depth -= 1;
            Ok(Json::Arr(items))
        }
        fn hex4(&mut self) -> Result<u32, String> {
            let mut n = 0;
            for _ in 0..4 {
                let c = self.chars.get(self.at).ok_or("short escape")?;
                n = n * 16 + c.to_digit(16).ok_or("bad escape")?;
                self.at += 1;
            }
            Ok(n)
        }
        fn string(&mut self) -> Result<String, String> {
            if self.chars.get(self.at) != Some(&'"') {
                return Err("expected string".into());
            }
            self.at += 1;
            let mut out = String::new();
            loop {
                let c = *self.chars.get(self.at).ok_or("unterminated string")?;
                self.at += 1;
                match c {
                    '"' => return Ok(out),
                    '\\' => {
                        let e = *self.chars.get(self.at).ok_or("short escape")?;
                        self.at += 1;
                        match e {
                            '"' | '\\' | '/' => out.push(e),
                            'b' => out.push('\u{8}'),
                            'f' => out.push('\u{c}'),
                            'n' => out.push('\n'),
                            'r' => out.push('\r'),
                            't' => out.push('\t'),
                            'u' => {
                                let mut n = self.hex4()?;
                                if (0xD800..0xDC00).contains(&n) && self.chars.get(self.at) == Some(&'\\') && self.chars.get(self.at + 1) == Some(&'u') {
                                    self.at += 2;
                                    let low = self.hex4()?;
                                    n = 0x10000 + ((n - 0xD800) << 10) + (low.wrapping_sub(0xDC00) & 0x3FF);
                                }
                                out.push(char::from_u32(n).unwrap_or('\u{FFFD}'));
                            }
                            _ => return Err("bad escape".into()),
                        }
                    }
                    _ => out.push(c),
                }
            }
        }
    }

    pub fn quote(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }
}

// `Get-Process -Name` takes wildcards, so matchers in people's links.json may use them.
fn wildcard(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

// a key name as in "win+h": its virtual-key code
fn vk_of(key: &str) -> Option<u8> {
    let key = key.to_lowercase();
    match key.as_str() {
        "space" => return Some(0x20),
        "enter" | "return" => return Some(0x0D),
        "tab" => return Some(0x09),
        "esc" | "escape" => return Some(0x1B),
        "capslock" => return Some(0x14),
        "." | "period" => return Some(0xBE),
        _ => {}
    }
    if let Some(n) = key.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
        return (1..=24).contains(&n).then(|| 0x6F + n);
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => Some(c.to_ascii_uppercase() as u8),
        _ => None,
    }
}

fn modifier_of(key: &str) -> Option<u8> {
    match key {
        "ctrl" | "control" => Some(0x11),
        "shift" => Some(0x10),
        "alt" => Some(0x12),
        "win" | "meta" => Some(0x5B),
        _ => None,
    }
}

#[cfg(windows)]
mod win {
    use super::json::{self, Json};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::io::{BufRead, Write};
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationInvokePattern, SetWinEventHook, TreeScope_Descendants, HWINEVENTHOOK, UIA_ButtonControlTypeId,
        UIA_ControlTypePropertyId, UIA_InvokePatternId,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, mouse_event, KEYEVENTF_KEYUP, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_WHEEL};
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetAncestor, GetCursorPos, GetForegroundWindow, GetGUIThreadInfo, GetMessageW, GetWindow, GetWindowLongPtrW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KillTimer, SetCursorPos, SetForegroundWindow, SetProcessDPIAware, SetTimer,
        SetWindowPos, ShowWindow, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GA_ROOT, GUITHREADINFO, GWL_EXSTYLE, GW_HWNDPREV, GW_OWNER, HWND_TOPMOST, MSG, OBJID_WINDOW, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SW_RESTORE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_TIMER, WS_EX_TOPMOST,
    };

    fn say(line: &str) {
        // one locked write per line, so an event can never land inside an answer
        let mut out = std::io::stdout().lock();
        if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
            std::process::exit(0);
        }
    }

    fn hwnd_of(value: i64) -> HWND {
        HWND(value as isize as *mut c_void)
    }

    fn visible(h: HWND) -> bool {
        unsafe { IsWindowVisible(h).as_bool() }
    }

    fn iconic(h: HWND) -> bool {
        unsafe { IsIconic(h).as_bool() }
    }

    fn cloaked(h: HWND) -> bool {
        let mut value = 0i32;
        let got = unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut value as *mut i32 as *mut c_void, 4) };
        got.is_ok() && value != 0
    }

    fn owner(h: HWND) -> HWND {
        unsafe { GetWindow(h, GW_OWNER).unwrap_or_default() }
    }

    fn pid_of(h: HWND) -> u32 {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        pid
    }

    fn title_of(h: HWND) -> String {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    struct Proc {
        pid: u32,
        name: String,
    }

    // The name Get-Process shows for an exe file or path.
    fn name_from_file(file: &str) -> String {
        let file = file.rsplit('\\').next().unwrap_or(file);
        if file.to_lowercase().ends_with(".exe") { file[..file.len() - 4].to_string() } else { file.to_string() }
    }

    // Every process, in the order Get-Process lists them.
    fn processes() -> Vec<Proc> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut e).is_ok();
            while more {
                let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..len]);
                out.push(Proc { pid: e.th32ProcessID, name: name_from_file(&name) });
                more = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out.sort_by_key(|p| (p.name.to_lowercase(), p.pid));
        out
    }

    // A process's exe path with limited query rights, which is enough even for packaged apps.
    fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut n = buf.len() as u32;
            let got = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n);
            let _ = CloseHandle(h);
            got.ok()?;
            Some(String::from_utf16_lossy(&buf[..n as usize]))
        }
    }

    fn enum_windows(mut f: impl FnMut(HWND) -> bool) {
        unsafe extern "system" fn call(h: HWND, data: LPARAM) -> BOOL {
            let f = &mut *(data.0 as *mut &mut dyn FnMut(HWND) -> bool);
            BOOL::from(f(h))
        }
        let mut f: &mut dyn FnMut(HWND) -> bool = &mut f;
        unsafe {
            let _ = EnumWindows(Some(call), LPARAM(&mut f as *mut _ as isize));
        }
    }

    // pid → the window .NET calls its "main window": the first visible, unowned one in z-order.
    fn main_windows() -> HashMap<u32, HWND> {
        let mut found = HashMap::new();
        enum_windows(|h| {
            if visible(h) && owner(h).is_invalid() {
                found.entry(pid_of(h)).or_insert(h);
            }
            true
        });
        found
    }

    fn main_window_of(pid: u32) -> Option<HWND> {
        let mut found = None;
        enum_windows(|h| {
            if pid_of(h) != pid || !visible(h) || !owner(h).is_invalid() {
                return true;
            }
            found = Some(h);
            false
        });
        found
    }

    fn path_matches(pid: u32, needle: Option<&str>) -> bool {
        match needle {
            None => true,
            Some(n) => image_path(pid).is_some_and(|p| p.to_lowercase().contains(&n.to_lowercase())),
        }
    }

    fn matcher_empty(m: &Json) -> bool {
        m.text("process").is_none() && m.text("pathContains").is_none() && m.text("titleContains").is_none()
    }

    fn named_processes(m: &Json) -> Vec<Proc> {
        let all = processes();
        match m.text("process") {
            Some(name) => all.into_iter().filter(|p| super::wildcard(name, &p.name)).collect(),
            None => all,
        }
    }

    // Matcher fields (all optional, all must match): process, pathContains, titleContains.
    fn find_app_window(m: &Json) -> Option<HWND> {
        if matcher_empty(m) {
            return None;
        }
        let windows = main_windows();
        let title = m.text("titleContains").map(str::to_lowercase);
        named_processes(m).into_iter().find_map(|p| {
            let h = *windows.get(&p.pid)?;
            if !path_matches(p.pid, m.text("pathContains")) {
                return None;
            }
            match &title {
                Some(t) if !title_of(h).to_lowercase().contains(t) => None,
                _ => Some(h),
            }
        })
    }

    fn focus(h: HWND) -> bool {
        if h.is_invalid() {
            return false;
        }
        unsafe {
            if iconic(h) {
                let _ = ShowWindow(h, SW_RESTORE);
            }
            let fg = GetForegroundWindow();
            if fg == h {
                return true;
            }
            // Windows only lets the foreground thread hand focus away. Borrow its
            // input queue (the pet just got clicked, so that is usually the pet).
            let me = GetCurrentThreadId();
            let fg_thread = GetWindowThreadProcessId(fg, None);
            let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
            let _ = BringWindowToTop(h);
            let _ = SetForegroundWindow(h);
            if attached {
                let _ = AttachThreadInput(me, fg_thread, false);
            }
            GetForegroundWindow() == h
        }
    }

    // Hand focus back to the window a pet popup took it from, but only while
    // `from` (the pet) still has it: if the user has moved on, leave them there.
    fn refocus(h: HWND, from: HWND) -> &'static str {
        unsafe {
            if h.is_invalid() || !IsWindow(Some(h)).as_bool() || !visible(h) || iconic(h) {
                return "gone";
            }
            if !from.is_invalid() && GetForegroundWindow() != from {
                return "moved";
            }
        }
        if focus(h) { "done" } else { "refused" }
    }

    // Mouse wheel at the cursor: vertical then horizontal, 120 per notch.
    fn wheel(dy: i32, dx: i32) {
        unsafe {
            if dy != 0 {
                mouse_event(MOUSEEVENTF_WHEEL, 0, 0, dy, 0);
            }
            if dx != 0 {
                mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, dx, 0);
            }
        }
    }

    // Left-click at physical screen coordinates, then put the cursor back.
    fn click(x: i32, y: i32) {
        unsafe {
            let mut old = POINT::default();
            let _ = GetCursorPos(&mut old);
            let _ = SetCursorPos(x, y);
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            std::thread::sleep(std::time::Duration::from_millis(30));
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            let _ = SetCursorPos(old.x, old.y);
        }
    }

    fn combo(mods: &[u8], key: u8) {
        unsafe {
            for m in mods {
                keybd_event(*m, 0, Default::default(), 0);
            }
            keybd_event(key, 0, Default::default(), 0);
            std::thread::sleep(std::time::Duration::from_millis(30));
            keybd_event(key, 0, KEYEVENTF_KEYUP, 0);
            for m in mods.iter().rev() {
                keybd_event(*m, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }

    // "caret cx cy cw ch  fx fy fw fh" in physical pixels: the text caret of the window you are
    // typing in (caret = 0 when the app does not report one) and that window's rectangle.
    fn context() -> String {
        unsafe {
            let fg = GetForegroundWindow();
            if fg.is_invalid() {
                return "none".into();
            }
            let mut w = RECT::default();
            if GetWindowRect(fg, &mut w).is_err() {
                return "none".into();
            }
            let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
            let (mut caret, mut cx, mut cy, mut cw, mut ch) = (0, 0, 0, 0, 0);
            if GetGUIThreadInfo(GetWindowThreadProcessId(fg, None), &mut info).is_ok() && !info.hwndCaret.is_invalid() {
                let mut p = POINT { x: info.rcCaret.left, y: info.rcCaret.top };
                if ClientToScreen(info.hwndCaret, &mut p).as_bool() {
                    caret = 1;
                    cx = p.x;
                    cy = p.y;
                    cw = info.rcCaret.right - info.rcCaret.left;
                    ch = info.rcCaret.bottom - info.rcCaret.top;
                }
            }
            format!("{caret} {cx} {cy} {cw} {ch} {} {} {} {}", w.left, w.top, w.right - w.left, w.bottom - w.top)
        }
    }

    // Whether this process is the one a matcher means. Listing every process costs about
    // 20 ms on a busy PC, and this gets asked often, so its name comes from its exe path. Only
    // a process that won't open needs the list, which `listed` then keeps for the whole check.
    fn process_matches(pid: u32, m: &Json, listed: &mut Option<Vec<Proc>>) -> bool {
        let path = if m.text("process").is_some() || m.text("pathContains").is_some() { image_path(pid) } else { None };
        if let Some(wanted) = m.text("process") {
            let name = match &path {
                Some(p) => Some(name_from_file(p)),
                None => listed.get_or_insert_with(processes).iter().find(|p| p.pid == pid).map(|p| p.name.clone()),
            };
            if !name.is_some_and(|n| super::wildcard(wanted, &n)) {
                return false;
            }
        }
        m.text("pathContains").is_none_or(|n| path.is_some_and(|p| p.to_lowercase().contains(&n.to_lowercase())))
    }

    // Whether a process the matcher means has a window open on screen: visible, not minimized,
    // not cloaked (on another virtual desktop, or a hidden app frame), titled and not tiny.
    fn any_shown(m: &Json) -> bool {
        let needle = m.text("titleContains").map(str::to_lowercase);
        let mut listed = None;
        let mut asked: HashMap<u32, bool> = HashMap::new();
        let mut found = false;
        enum_windows(|h| {
            if !visible(h) || iconic(h) || !owner(h).is_invalid() {
                return true;
            }
            let mut r = RECT::default();
            if unsafe { GetWindowRect(h, &mut r) }.is_err() || r.right - r.left < 50 || r.bottom - r.top < 50 {
                return true;
            }
            let title = title_of(h);
            if title.is_empty() || needle.as_ref().is_some_and(|n| !title.to_lowercase().contains(n)) {
                return true;
            }
            let pid = pid_of(h);
            if !*asked.entry(pid).or_insert_with(|| process_matches(pid, m, &mut listed)) || cloaked(h) {
                return true;
            }
            found = true;
            false
        });
        found
    }

    fn topmost(h: HWND) -> bool {
        unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0 }
    }

    // Windows can strand always-on-top windows under ordinary ones: the flag stays set, yet
    // every app you switch to lands in front of them. Seen as a visible, uncloaked window
    // without the flag somewhere above this one.
    fn sunk(h: HWND) -> bool {
        let mut above = unsafe { GetWindow(h, GW_HWNDPREV).unwrap_or_default() };
        let mut n = 0;
        while !above.is_invalid() && n < 2048 {
            if !topmost(above) && visible(above) && !cloaked(above) {
                return true;
            }
            above = unsafe { GetWindow(above, GW_HWNDPREV).unwrap_or_default() };
            n += 1;
        }
        false
    }

    // busy, Direct3D full-screen or presentation mode
    fn fullscreen() -> bool {
        matches!(unsafe { SHQueryUserNotificationState() }, Ok(state) if (2..=4).contains(&state.0))
    }

    // Puts each stranded always-on-top window back in front without activating it, and
    // returns how many it moved. Leaves a full-screen game, video or presentation alone.
    fn restack(hwnds: &[i64]) -> i32 {
        if fullscreen() {
            return 0;
        }
        let mut moved = 0;
        for v in hwnds {
            let h = hwnd_of(*v);
            let alive = unsafe { IsWindow(Some(h)).as_bool() };
            if !alive || !visible(h) || !topmost(h) || !sunk(h) {
                continue;
            }
            if unsafe { SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE) }.is_ok() {
                moved += 1;
            }
        }
        moved
    }

    // Claude Desktop is Chromium: its button tree appears only after the first
    // accessibility query, and a freshly opened chat may still be loading, so retry.
    fn click_app_button(matcher: &Json, names: &[String]) -> String {
        // An empty name would match every button, so refuse anything that short.
        let names: Vec<String> = names.iter().map(|n| n.trim().to_lowercase()).filter(|n| n.chars().count() >= 3).collect();
        if names.is_empty() {
            return "err no-names".into();
        }
        let Some(hwnd) = find_app_window(matcher) else { return "err no-window".into() };
        match press_button(hwnd, &names) {
            Ok(answer) => answer,
            Err(err) => format!("err {}", err.message().to_string().replace(['\r', '\n'], " ")),
        }
    }

    fn press_button(hwnd: HWND, names: &[String]) -> windows::core::Result<String> {
        unsafe {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let root = uia.ElementFromHandle(hwnd)?;
            let win = root.CurrentBoundingRectangle()?;
            let is_button = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_ButtonControlTypeId.0))?;
            let sidebar = win.left as f64 + (win.right - win.left) as f64 * 0.25;
            for attempt in 0..5 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
                let all = root.FindAll(TreeScope_Descendants, &is_button)?;
                let mut buttons = Vec::new();
                for i in 0..all.Length()? {
                    let Ok(e) = all.GetElement(i) else { continue };
                    let Ok(r) = e.CurrentBoundingRectangle() else { continue };
                    let width = r.right - r.left;
                    // skip the sidebar, where chat titles are buttons too
                    let offscreen = e.CurrentIsOffscreen().map(|b| b.as_bool()).unwrap_or(true);
                    if offscreen || width <= 0 || (r.left as f64 + width as f64 / 2.0) <= sidebar {
                        continue;
                    }
                    let name = e.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                    buttons.push((e, r, name));
                }
                for wanted in names {
                    let Some((e, r, label)) = buttons.iter().find(|(_, _, n)| n.to_lowercase().contains(wanted)) else { continue };
                    let invoked = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).and_then(|p| p.Invoke());
                    if invoked.is_err() {
                        click((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                    }
                    return Ok(format!("ok clicked {}", label.replace(['\r', '\n'], " ")));
                }
            }
            Ok("err not-found".into())
        }
    }

    fn numbers(text: &str) -> Result<Vec<i64>, String> {
        text.split_whitespace().map(|n| n.parse::<i64>().map_err(|_| format!("not a number: {n}"))).collect()
    }

    fn foreground_app() -> String {
        let pid = pid_of(unsafe { GetForegroundWindow() });
        if pid == 0 {
            return "ok {}".into();
        }
        let path = image_path(pid);
        let name = match &path {
            Some(p) => Some(name_from_file(p)),
            None => processes().into_iter().find(|p| p.pid == pid).map(|p| p.name),
        };
        let Some(name) = name else { return "ok {}".into() };
        let path = path.map_or("null".to_string(), |s| json::quote(&s));
        let title = main_window_of(pid).map_or(String::new(), title_of);
        format!("ok {{\"process\":{},\"path\":{},\"title\":{}}}", json::quote(&name), path, json::quote(&title))
    }

    fn handle(command: &str, rest: &str) -> Result<String, String> {
        match command {
            "focus" => {
                if rest.is_empty() {
                    return Ok("err no-matcher".into());
                }
                let Some(h) = find_app_window(&json::parse(rest)?) else { return Ok("err no-window".into()) };
                Ok(format!("ok focus {}", if focus(h) { "True" } else { "False" }))
            }
            "keys" => {
                let lower = rest.to_lowercase();
                let tokens: Vec<&str> = lower.split('+').collect();
                let (key, mods) = tokens.split_last().ok_or("no keys")?;
                let mods = mods.iter().map(|m| super::modifier_of(m).ok_or(format!("unknown modifier '{m}'"))).collect::<Result<Vec<u8>, String>>()?;
                combo(&mods, super::vk_of(key).ok_or(format!("unknown key '{key}'"))?);
                Ok("ok keys".into())
            }
            "uia-click" => {
                if rest.is_empty() {
                    return Ok("err no-names".into());
                }
                let req = json::parse(rest)?;
                let names: Vec<String> = match req.get("names") {
                    Some(Json::Arr(items)) => items.iter().filter_map(|v| if let Json::Str(s) = v { Some(s.clone()) } else { None }).collect(),
                    _ => Vec::new(),
                };
                let empty = Json::Obj(Vec::new());
                Ok(click_app_button(req.get("window").unwrap_or(&empty), &names))
            }
            "wheel" => {
                let n = numbers(rest)?;
                wheel(n.first().copied().unwrap_or(0) as i32, n.get(1).copied().unwrap_or(0) as i32);
                Ok("ok wheel".into())
            }
            "context" => Ok(format!("ok {}", context())),
            "foreground" => Ok(format!("ok {}", unsafe { GetForegroundWindow() }.0 as isize)),
            "foreground-app" => Ok(foreground_app()),
            "window-shown" => {
                let m = if rest.is_empty() { Json::Null } else { json::parse(rest)? };
                if matcher_empty(&m) {
                    return Ok("err no-matcher".into());
                }
                Ok(format!("ok {}", any_shown(&m)))
            }
            "refocus" => {
                let n = numbers(rest)?;
                Ok(format!("ok refocus {}", refocus(hwnd_of(n.first().copied().unwrap_or(0)), hwnd_of(n.get(1).copied().unwrap_or(0)))))
            }
            "restack" => Ok(format!("ok {}", restack(&numbers(rest)?))),
            "fullscreen" => Ok(format!("ok {}", fullscreen())),
            "ping" => Ok("ok pong".into()),
            other => Ok(format!("err unknown-command {other}")),
        }
    }

    // ---------- events ----------
    // Windows says when these happen, so the app need not keep asking. An app opening
    // or closing raises a burst of them, which goes out as one line.

    const WINDOWS_GAP_MS: u64 = 150;
    static LAST_WINDOWS: AtomicU64 = AtomicU64::new(0);
    static PENDING: AtomicBool = AtomicBool::new(false);
    static TIMER: AtomicUsize = AtomicUsize::new(0);

    fn windows_changed() {
        let now = unsafe { GetTickCount64() };
        if now.saturating_sub(LAST_WINDOWS.load(Ordering::Relaxed)) >= WINDOWS_GAP_MS {
            LAST_WINDOWS.store(now, Ordering::Relaxed);
            say("ev windows");
        } else if !PENDING.swap(true, Ordering::Relaxed) {
            TIMER.store(unsafe { SetTimer(None, 0, WINDOWS_GAP_MS as u32, None) }, Ordering::Relaxed);
        }
    }

    unsafe extern "system" fn on_event(_hook: HWINEVENTHOOK, event: u32, h: HWND, object: i32, child: i32, _thread: u32, _time: u32) {
        if event == EVENT_SYSTEM_FOREGROUND {
            say("ev foreground");
            return;
        }
        // only whole windows, not the controls inside them
        if object != OBJID_WINDOW.0 || child != 0 {
            return;
        }
        // a destroyed window can no longer be asked anything
        if event != EVENT_OBJECT_DESTROY && (h.is_invalid() || GetAncestor(h, GA_ROOT) != h || !owner(h).is_invalid()) {
            return;
        }
        windows_changed();
    }

    fn watch_events() {
        std::thread::spawn(|| unsafe {
            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            for (from, to) in [
                (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
                (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
                (EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE), // destroy, show, hide
                (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
            ] {
                let _ = SetWinEventHook(from, to, None, Some(on_event), 0, 0, flags);
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_TIMER {
                    let _ = KillTimer(None, TIMER.swap(0, Ordering::Relaxed));
                    PENDING.store(false, Ordering::Relaxed);
                    LAST_WINDOWS.store(GetTickCount64(), Ordering::Relaxed);
                    say("ev windows");
                }
            }
        });
    }

    pub fn run() {
        unsafe {
            let _ = SetProcessDPIAware();
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        say("ready events");
        watch_events();
        let mut stdin = std::io::stdin().lock();
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match stdin.read_until(b'\n', &mut bytes) {
                Ok(n) if n > 0 => {}
                _ => return,
            }
            let line = String::from_utf8_lossy(&bytes);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let (command, rest) = match line.split_once(char::is_whitespace) {
                Some((c, r)) => (c, r.trim()),
                None => (line, ""),
            };
            match handle(command, rest) {
                Ok(answer) => say(&answer),
                Err(err) => say(&format!("err {}", err.replace(['\r', '\n'], " "))),
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    win::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("harness-pet-helper only runs on Windows");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::json::{parse, quote, Json};
    use super::*;

    #[test]
    fn parses_matchers() {
        let m = parse(r#"{"process":"claude","pathContains":"Windows\\Apps","titleContains":""}"#).unwrap();
        assert_eq!(m.text("process"), Some("claude"));
        assert_eq!(m.text("pathContains"), Some("Windows\\Apps"));
        assert_eq!(m.text("titleContains"), None, "an empty field means not set");
        assert_eq!(m.text("missing"), None);
    }

    #[test]
    fn parses_click_requests() {
        let r = parse(r#" { "window" : {"process":"x"}, "names":["voice mode", "dictation"], "n": 1.5e1, "ok": true, "z": null } "#).unwrap();
        assert_eq!(r.get("window").unwrap().text("process"), Some("x"));
        assert_eq!(r.get("names"), Some(&Json::Arr(vec![Json::Str("voice mode".into()), Json::Str("dictation".into())])));
        assert_eq!(r.get("n"), Some(&Json::Num(15.0)));
        assert_eq!(r.get("ok"), Some(&Json::Bool(true)));
        assert_eq!(r.get("z"), Some(&Json::Null));
    }

    #[test]
    fn decodes_escapes_and_non_ascii() {
        assert_eq!(parse(r#""a\n\"\u00e9\ud83d\ude00é""#).unwrap(), Json::Str("a\n\"é😀é".into()));
    }

    #[test]
    fn refuses_broken_json_without_panicking() {
        for bad in ["", "{", "[1,", r#"{"a"}"#, r#"{"a":}"#, r#""abc"#, r#""\u12"#, r#""\q""#, "tru", "1 2", "--", "{}x"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        assert!(parse(&"[".repeat(100000)).is_err(), "deep nesting stops early");
    }

    #[test]
    fn quoted_text_round_trips_on_one_line() {
        let s = "C:\\Program Files\\\"x\"\n\ttitle é";
        let q = quote(s);
        assert!(!q.contains('\n'));
        assert_eq!(parse(&q).unwrap(), Json::Str(s.into()));
    }

    #[test]
    fn process_names_match_like_get_process() {
        assert!(wildcard("claude", "Claude"));
        assert!(!wildcard("claude", "claude2"));
        assert!(wildcard("Anti*", "Antigravity"));
        assert!(wildcard("*gravity", "antigravity"));
        assert!(wildcard("c?de", "code"));
        assert!(!wildcard("c?de", "coode"));
        assert!(wildcard("*", ""));
        assert!(!wildcard("a", ""));
    }

    #[test]
    fn key_names() {
        assert_eq!(vk_of("H"), Some(b'H'));
        assert_eq!(vk_of("5"), Some(b'5'));
        assert_eq!(vk_of("f1"), Some(0x70));
        assert_eq!(vk_of("F24"), Some(0x87));
        assert_eq!(vk_of("f25"), None);
        assert_eq!(vk_of("esc"), Some(0x1B));
        assert_eq!(vk_of("hello"), None);
        assert_eq!(modifier_of("win"), Some(0x5B));
        assert_eq!(modifier_of("hyper"), None);
    }
}
