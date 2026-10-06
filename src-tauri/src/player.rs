//! Embedded native mpv player.
//!
//! A Win32 child window is created over the main window's client area and
//! mpv renders into it via `--wid`. Communication uses mpv's JSON IPC over a
//! named pipe. Position events are forwarded to the frontend as Tauri events
//! so Jellyfin playback progress can be reported.

use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

#[path = "player_screenshot.rs"]
mod screenshot;

#[cfg(test)]
#[path = "player_osc_render.rs"]
mod osc_render;

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, LRESULT, LocalFree, POINT, RECT, WPARAM, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, ScreenToClient, BLACK_BRUSH, HBRUSH};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::Cryptography::{
    CertCloseStore, CertEnumCertificatesInStore, CertOpenStore,
    CryptBinaryToStringA, CRYPT_STRING_BASE64HEADER, CERT_STORE_PROV_SYSTEM_W,
    CERT_STORE_READONLY_FLAG, CERT_STORE_OPEN_EXISTING_FLAG, CERT_SYSTEM_STORE_CURRENT_USER,
};
use windows_sys::Win32::Security::{
    InitializeSecurityDescriptor, SetSecurityDescriptorDacl,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Diagnostics::Debug::{GetErrorMode, SetErrorMode, SEM_FAILCRITICALERRORS};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, OpenProcess, TerminateProcess, WaitForSingleObject,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, PROCESS_TERMINATE, STARTUPINFOW,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SetActiveWindow, SetFocus, GetFocus, SetCapture, ReleaseCapture, GetDoubleClickTime, VK_DOWN, VK_ESCAPE, VK_RETURN, VK_LEFT, VK_RIGHT, VK_UP, VK_BACK,
};
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, EnumChildWindows, GetClassNameW, GetClientRect,
    GetWindowLongPtrW, GetWindowRect, GetCursorPos, GetParent, IsIconic, IsZoomed, IsWindowVisible, LoadCursorW, MoveWindow, RegisterClassW, WindowFromPoint, SendMessageW,
    SetCursor, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, GWL_STYLE, HTCLIENT, HWND_TOP, IDC_ARROW, IDC_HAND, IDC_IBEAM,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, SW_SHOW, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_DISABLED,
    WM_KEYDOWN, WM_KEYUP, WM_CHAR, WM_KILLFOCUS, WM_CAPTURECHANGED, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_NCDESTROY, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR,
    WM_NCHITTEST, WM_NCLBUTTONDOWN, HTLEFT, HTRIGHT, HTTOP, HTBOTTOM, HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT,
};

const HOST_CLASS: &str = "MjcMpvHostWindow";
/// Height of the custom title bar in CSS px (multiplied by scale factor).
const TITLEBAR_CSS_PX: f64 = 36.0;
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------
// Hosted process spawn (identical to what Rust std's Command::spawn does on
// this machine, which anti-cheat filters allow — a plain CreateProcessW with
// STARTUPINFO + restricted-token SECURITY_ATTRIBUTES).
// ---------------------------------------------------------------------------

/// SIDs Rust std puts into lpProcessAttributes on affected systems:
/// S-1-19-128-67 (cb:13) and S-1-19-128-58 (cb:13).
const HOSTED_TOKEN_SIDS: [&str; 2] = ["S-1-19-128-67", "S-1-19-128-58"];

struct HostedAttrs {
    sd: Box<SECURITY_DESCRIPTOR>,
    sids: Vec<PSID>,
}

impl HostedAttrs {
    fn new() -> Option<Self> {
        unsafe {
            let mut sd: Box<SECURITY_DESCRIPTOR> = Box::new(std::mem::zeroed());
            let sd_ptr: PSECURITY_DESCRIPTOR = &mut *sd as *mut SECURITY_DESCRIPTOR as *mut _;
            if InitializeSecurityDescriptor(sd_ptr, 1) == 0 {
                return None;
            }
            // Empty DACL — same as std's hosted spawn
            if SetSecurityDescriptorDacl(sd_ptr, 0, std::ptr::null(), 0) == 0 {
                return None;
            }
            let mut sids: Vec<PSID> = Vec::new();
            for s in HOSTED_TOKEN_SIDS {
                let sw = wide(s);
                let mut psid: PSID = std::ptr::null_mut();
                if ConvertStringSidToSidW(sw.as_ptr(), &mut psid) == 0 {
                    for p in sids {
                        LocalFree(p);
                    }
                    return None;
                }
                sids.push(psid);
            }
            Some(Self { sd, sids })
        }
    }

    fn sa(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: &*self.sd as *const SECURITY_DESCRIPTOR as *mut _,
            bInheritHandle: 0,
        }
    }
}

impl Drop for HostedAttrs {
    fn drop(&mut self) {
        unsafe {
            for p in &self.sids {
                LocalFree(*p);
            }
        }
    }
}

/// Retain the creation handle: opening the process again can be denied by a
/// process filter, and CreateProcessW success does not imply DLL initialization.
struct StartedProcess {
    pid: u32,
    handle: HANDLE,
}
impl StartedProcess {
    fn exit_code(&self) -> Option<u32> {
        unsafe {
            if WaitForSingleObject(self.handle, 0) != WAIT_OBJECT_0 { return None; }
            let mut code = 0;
            (GetExitCodeProcess(self.handle, &mut code) != 0).then_some(code)
        }
    }
    fn terminate(&self) {
        unsafe { TerminateProcess(self.handle, 1); }
    }
}
impl Drop for StartedProcess {
    fn drop(&mut self) { unsafe { CloseHandle(self.handle); } }
}

/// Keep the existing hosted-process compatibility path. The process error mode
/// is set once, inherited by children, and never changes Windows system settings.
/// Loader failures then return an exit code instead of a blocking Windows dialog.
unsafe fn spawn_hosted_tracked(exe: &std::path::Path, args: &[String], cwd: &std::path::Path) -> Result<StartedProcess, String> {
    static ERROR_MODE: Once = Once::new();
    ERROR_MODE.call_once(|| unsafe { SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS); });
    let attrs = HostedAttrs::new().ok_or_else(|| "无法创建进程安全属性".to_string())?;
    let sa = attrs.sa();

    let mut cmdline = quote_windows_arg(&exe.to_string_lossy());
    for a in args {
        cmdline.push(' ');
        cmdline.push_str(&quote_windows_arg(a));
    }
    let mut cmd_w = wide(&cmdline);
    let exe_w = wide(&exe.to_string_lossy());
    let cwd_w = wide(&cwd.to_string_lossy());

    let mut si: STARTUPINFOW = std::mem::zeroed();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi: PROCESS_INFORMATION = std::mem::zeroed();

    let ok = CreateProcessW(
        exe_w.as_ptr(),
        cmd_w.as_mut_ptr(),
        &sa,
        std::ptr::null(),
        0,
        CREATE_UNICODE_ENVIRONMENT,
        std::ptr::null(),
        cwd_w.as_ptr(),
        &si,
        &mut pi,
    );
    if ok == 0 {
        return Err(format!("CreateProcessW 失败: {}", std::io::Error::last_os_error()));
    }
    CloseHandle(pi.hThread);
    Ok(StartedProcess { pid: pi.dwProcessId, handle: pi.hProcess })
}

#[cfg(test)]
unsafe fn spawn_hosted(exe: &std::path::Path, args: &[String], cwd: &std::path::Path) -> Result<u32, String> {
    Ok(spawn_hosted_tracked(exe, args, cwd)?.pid)
}

const STATUS_DLL_INIT_FAILED: u32 = 0xc0000142;

fn startup_exit_message(code: u32) -> String {
    if code == STATUS_DLL_INIT_FAILED {
        "播放器初始化失败（0xC0000142），自动重试后仍无法启动，请稍后重试".into()
    } else {
        format!("播放器在启动时退出（0x{code:08X}）")
    }
}

/// Retry only a transient DLL initialization failure, before any media is loaded.
/// Each failed child is fully cleaned up; media errors are never retried here.
fn connect_player_process(pipe_path: &str, timeout: Duration,
    mut launch: impl FnMut() -> Result<StartedProcess, String>,
) -> Result<(StartedProcess, std::fs::File), String> {
    for attempt in 0..2 {
        let process = launch()?;
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(code) = process.exit_code() {
                if code == STATUS_DLL_INIT_FAILED && attempt == 0 {
                    std::thread::sleep(Duration::from_millis(150));
                    break;
                }
                return Err(startup_exit_message(code));
            }
            if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(pipe_path) {
                return Ok((process, file));
            }
            if Instant::now() >= deadline {
                process.terminate();
                return Err("播放器启动超时，无法连接控制通道，请重试".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    unreachable!("the second startup attempt either connects or returns an error")
}

// Windows argv escaping preserves quoted HTTP header values and file titles.
fn quote_windows_arg(arg: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        quoted.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
        quoted.push(ch);
        slashes = 0;
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

/// Check whether a process is still alive using the Toolhelp snapshot API
/// (OpenProcess is blocked by anti-cheat on this machine).
fn pid_alive(pid: u32) -> bool {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return true; // can't tell; assume alive
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                if e.th32ProcessID == pid {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        found
    }
}

fn kill_pid(pid: u32) {
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

#[derive(Default, Clone, Serialize)]
pub struct PlayerStatus {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub active: bool,
}

struct MpvSession {
    pid: u32,
    host_hwnd: isize,
    pipe: Sender<serde_json::Value>,
    window_before: Option<(bool, tauri::PhysicalSize<u32>)>,
}

pub struct PlayerState {
    session: Mutex<Option<MpvSession>>,
    status: Arc<Mutex<PlayerStatus>>,
    /// hwnd of the current host child window (0 = none), for resize handling
    host: AtomicIsize,
    /// titlebar offset in physical px for child window placement
    titlebar_px: std::sync::atomic::AtomicI32,
    video_ratio: Mutex<Option<f64>>,
    fullscreen: Arc<AtomicBool>,
    last_size: Mutex<(i32, i32)>,
    ui_dpi: std::sync::atomic::AtomicU32,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            status: Arc::new(Mutex::new(PlayerStatus::default())),
            host: AtomicIsize::new(0),
            titlebar_px: std::sync::atomic::AtomicI32::new(0),
            video_ratio: Mutex::new(None),
            fullscreen: Arc::new(AtomicBool::new(false)),
            last_size: Mutex::new((0, 0)),
            ui_dpi: std::sync::atomic::AtomicU32::new(96),
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// Host window input forwarding.
// mpv's embedded window gets WS_DISABLED so the host receives all mouse and
// keyboard input; events are injected into mpv via its JSON IPC (`mouse`
// command + regular commands). This is required because mpv's window does
// not receive input reliably in this embedded/anti-cheat environment.
// ---------------------------------------------------------------------------

struct MpvHostData {
    pipe: Sender<serde_json::Value>,
    last_move: Instant,
    high_surrogate: Option<u16>,
    mouse_captured: bool,
    captured_cursor: CursorKind,
    cursor_zones: Arc<Mutex<Vec<CursorZone>>>,
    fullscreen: Arc<AtomicBool>,
}

impl PlayerState {
    pub fn sync_fullscreen(&self, value: bool) { self.fullscreen.store(value, Ordering::SeqCst); }
}

#[derive(Clone, Copy, Default, PartialEq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum CursorKind { #[default] Default, Pointer, Text }

#[derive(serde::Deserialize)]
struct CursorZone { x0: f64, y0: f64, x1: f64, y1: f64, cursor: CursorKind }

impl MpvHostData {
    fn cursor_at(&self, x: i32, y: i32) -> CursorKind {
        self.cursor_zones.lock().ok().and_then(|zones| zones.iter().find(|z|
            x as f64 >= z.x0 && x as f64 <= z.x1 && y as f64 >= z.y0 && y as f64 <= z.y1
        ).map(|z| z.cursor)).unwrap_or_default()
    }
}

unsafe fn set_player_cursor(kind: CursorKind) {
    let id = match kind { CursorKind::Pointer => IDC_HAND, CursorKind::Text => IDC_IBEAM, CursorKind::Default => IDC_ARROW };
    SetCursor(LoadCursorW(std::ptr::null_mut(), id));
}

unsafe fn refresh_host_cursor(host: isize) {
    let hwnd = host as HWND;
    let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const MpvHostData;
    if data.is_null() { return; }
    let mut point = POINT { x: 0, y: 0 };
    if GetCursorPos(&mut point) == 0 { return; }
    if !(*data).mouse_captured && WindowFromPoint(point) != hwnd { return; }
    ScreenToClient(hwnd, &mut point);
    set_player_cursor(if (*data).mouse_captured { (*data).captured_cursor } else { (*data).cursor_at(point.x, point.y) });
}

fn ipc(pipe: &Sender<serde_json::Value>, value: serde_json::Value) {
    // Never perform blocking pipe I/O inside a Win32 mouse/keyboard callback.
    let _ = pipe.send(value);
}

fn write_json(file: &mut std::fs::File, value: &serde_json::Value) -> std::io::Result<()> {
    writeln!(file, "{value}")?;
    file.flush()
}

/// Commands use a separate connection from the blocking event reader. A cloned
/// synchronous Windows handle still shares I/O serialization with its original:
/// a pending ReadFile can prevent WriteFile from completing while mpv is paused.
/// This worker alternates writes and replies on its own connection, also draining
/// responses so mpv's output buffer cannot fill during mouse movement.
fn command_sender(file: std::fs::File) -> Sender<serde_json::Value> {
    let (sender, receiver) = mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(file);
        let mut request_id = 1000_u64;
        for mut value in receiver {
            request_id += 1;
            value["request_id"] = json!(request_id);
            if write_json(reader.get_mut(), &value).is_err() {
                break;
            }
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {
                        if let Ok(reply) = serde_json::from_str::<serde_json::Value>(&line) {
                            if reply.get("request_id").and_then(|v| v.as_u64()) == Some(request_id) {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
    sender
}

fn mouse_xy(lparam: LPARAM) -> (i32, i32) {
    (
        (lparam & 0xFFFF) as i16 as i32,
        ((lparam >> 16) & 0xFFFF) as i16 as i32,
    )
}

fn pointer_message(event: &str, x: i32, y: i32) -> serde_json::Value {
    json!({"command": ["script-message", "mjc-pointer", event, x.to_string(), y.to_string()]})
}

unsafe extern "system" fn host_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut MpvHostData;

    match msg {
        WM_NCHITTEST if !data.is_null() => {
            let parent = GetParent(hwnd);
            if !(*data).fullscreen.load(Ordering::SeqCst) && IsZoomed(parent) == 0 {
                let mut rect = RECT::default();
                if GetClientRect(parent, &mut rect) != 0 {
                    let (x, y) = mouse_xy(lparam);
                    let mut point = POINT { x, y };
                    ScreenToClient(parent, &mut point);
                    let edge = (5.0 * GetDpiForWindow(parent) as f64 / 96.0).ceil() as i32;
                    return resize_hit(point.x, point.y, rect.right - rect.left, rect.bottom - rect.top, edge) as LRESULT;
                }
            }
            return HTCLIENT as LRESULT;
        }
        WM_NCLBUTTONDOWN if matches!(wparam as u32, HTLEFT | HTRIGHT | HTTOP | HTBOTTOM | HTTOPLEFT | HTTOPRIGHT | HTBOTTOMLEFT | HTBOTTOMRIGHT) => {
            ReleaseCapture();
            return SendMessageW(GetParent(hwnd), msg, wparam, lparam);
        }
        WM_NCDESTROY => {
            if !data.is_null() {
                drop(Box::from_raw(data));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        WM_SETCURSOR => {
            if (lparam & 0xFFFF) == HTCLIENT as isize {
                if data.is_null() { set_player_cursor(CursorKind::Default); }
                else { refresh_host_cursor(hwnd as isize); }
                return 1;
            }
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        _ => {}
    }

    if data.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    let d = &mut *data;

    match msg {
        WM_MOUSEMOVE => {
            let (x, y) = mouse_xy(lparam);
            set_player_cursor(if d.mouse_captured { d.captured_cursor } else { d.cursor_at(x, y) });
            if d.last_move.elapsed() >= Duration::from_millis(33) {
                d.last_move = Instant::now();
                let (x, y) = mouse_xy(lparam);
                ipc(&d.pipe, json!({"command": ["mouse", x, y]}));
                if d.mouse_captured {
                    // Pass captured client coordinates directly. mpv's mouse
                    // key sections may cancel their binding outside its area.
                    ipc(&d.pipe, pointer_message("move", x, y));
                }
            }
            0
        }
        WM_LBUTTONDOWN => {
            SetFocus(hwnd);
            d.mouse_captured = true;
            let (x, y) = mouse_xy(lparam);
            d.captured_cursor = d.cursor_at(x, y);
            SetCapture(hwnd);
            ipc(&d.pipe, json!({"command": ["mouse", x, y]}));
            ipc(&d.pipe, pointer_message("down", x, y));
            0
        }
        WM_LBUTTONUP => {
            let (x, y) = mouse_xy(lparam);
            ipc(&d.pipe, json!({"command": ["mouse", x, y]}));
            ipc(&d.pipe, pointer_message("up", x, y));
            d.mouse_captured = false;
            ReleaseCapture();
            set_player_cursor(d.cursor_at(x, y));
            0
        }
        WM_RBUTTONDOWN => {
            let (x, y) = mouse_xy(lparam);
            ipc(&d.pipe, json!({"command": ["mouse", x, y]}));
            ipc(&d.pipe, json!({"command": ["keydown", "MBTN_RIGHT"]}));
            0
        }
        WM_RBUTTONUP => {
            let (x, y) = mouse_xy(lparam);
            ipc(&d.pipe, json!({"command": ["mouse", x, y]}));
            ipc(&d.pipe, json!({"command": ["keyup", "MBTN_RIGHT"]}));
            0
        }
        WM_LBUTTONDBLCLK => {
            let (x, y) = mouse_xy(lparam);
            ipc(&d.pipe, json!({"command": ["script-message", "mjc-double-click", x.to_string(), y.to_string()]}));
            0
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam >> 16) as i16) as i32;
            // wheel messages carry SCREEN coordinates
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            let (sx, sy) = mouse_xy(lparam);
            pt.x = sx;
            pt.y = sy;
            ScreenToClient(hwnd, &mut pt);
            let btn = if delta > 0 { 3 } else { 4 };
            ipc(&d.pipe, json!({"command": ["mouse", pt.x, pt.y, btn]}));
            0
        }
        WM_KEYDOWN | WM_KEYUP => {
            let Some(key) = player_key(wparam as u16) else { return DefWindowProcW(hwnd, msg, wparam, lparam); };
            if msg == WM_KEYDOWN && lparam & (1 << 30) != 0 { return 0; }
            let event = if msg == WM_KEYDOWN { "mjc-key-down" } else { "mjc-key-up" };
            ipc(&d.pipe, json!({"command": ["script-message", event, key]}));
            0
        }
        WM_CHAR => {
            let unit = wparam as u16;
            if (0xD800..=0xDBFF).contains(&unit) { d.high_surrogate = Some(unit); }
            else if unit >= 32 {
                let units = if let Some(high) = d.high_surrogate.take() { vec![high, unit] } else { vec![unit] };
                ipc(&d.pipe, json!({"command": ["script-message", "mjc-text-input", String::from_utf16_lossy(&units)]}));
            }
            0
        }
        WM_KILLFOCUS | WM_CAPTURECHANGED => {
            if msg == WM_KILLFOCUS || d.mouse_captured {
                d.mouse_captured = false;
                ipc(&d.pipe, json!({"command": ["script-message", "mjc-cancel-input"]}));
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn player_key(vk: u16) -> Option<String> {
    Some(match vk {
        VK_ESCAPE => "ESC".into(), VK_RETURN => "ENTER".into(), VK_BACK => "BACKSPACE".into(),
        VK_LEFT => "LEFT".into(), VK_RIGHT => "RIGHT".into(), VK_UP => "UP".into(), VK_DOWN => "DOWN".into(),
        0x20 => "SPACE".into(), 0x4B => "K".into(), 0x46 => "F".into(), 0x4D => "M".into(),
        0x41 => "A".into(), 0x53 => "S".into(),
        0x30..=0x39 => char::from_u32(vk as u32)?.to_string(),
        0x60..=0x69 => char::from_u32((vk - 0x30) as u32)?.to_string(),
        _ => return None,
    })
}

fn setting_bool(settings: &serde_json::Value, key: &str, default: bool) -> bool {
    settings[key].as_bool().unwrap_or(default)
}

fn screenshot_format(settings: &serde_json::Value) -> &'static str {
    if settings["screenshotFormat"] == "png" { "png" } else { "jpg" }
}

fn playback_setting_args(opts: &StartOptions) -> Vec<String> {
    vec![
        if opts.hw_decode { "--hwdec=auto-safe".into() } else { "--hwdec=no".into() },
        if opts.precise_seek { "--hr-seek=yes".into() } else { "--hr-seek=no".into() },
        if opts.audio_boost { "--volume-max=200".into() } else { "--volume-max=100".into() },
        // gpu-next exposes HDR subtitle reference-white controls.
        "--vo=gpu-next".into(),
        if setting_bool(&opts.settings, "hdrSubtitle", true) { "--sub-hdr-peak=auto".into() } else { "--sub-hdr-peak=sdr".into() },
        if setting_bool(&opts.settings, "hdrSubtitle", true) { "--image-subs-hdr-peak=video".into() } else { "--image-subs-hdr-peak=sdr".into() },
        format!("--screenshot-format={}", screenshot_format(&opts.settings)),
        format!("--screenshot-jpeg-quality={}", opts.settings["jpegQuality"].as_u64().unwrap_or(80).clamp(1, 100)),
    ]
}

unsafe fn register_host_class() {
    let hinstance = GetModuleHandleW(std::ptr::null());
    let class_name = wide(HOST_CLASS);
    let brush = GetStockObject(BLACK_BRUSH as i32);
    let wc = WNDCLASSW {
        style: CS_DBLCLKS | CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(host_wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: brush as HBRUSH,
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    RegisterClassW(&wc); // fails if already registered; fine
}

/// Keep the host hidden until file-loaded so the webview's cancel button and
/// Escape handler remain accessible while network I/O is pending.
unsafe fn create_host_window(parent: HWND, titlebar_px: i32) -> isize {
    register_host_class();
    let mut rc: RECT = std::mem::zeroed();
    GetClientRect(parent, &mut rc);
    let class_name = wide(HOST_CLASS);
    let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        std::ptr::null(),
        WS_CHILD | WS_CLIPSIBLINGS,
        0,
        titlebar_px,
        rc.right - rc.left,
        (rc.bottom - rc.top) - titlebar_px,
        parent,
        std::ptr::null_mut(),
        GetModuleHandleW(std::ptr::null()),
        std::ptr::null(),
    );
    if hwnd.is_null() {
        return 0;
    }
    // Make sure we sit above the WebView2 child window
    SetWindowPos(hwnd, HWND_TOP, 0, titlebar_px, rc.right - rc.left, rc.bottom - rc.top - titlebar_px, SWP_NOACTIVATE);
    hwnd as isize
}

unsafe extern "system" fn enum_find_mpv(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n > 0 {
        let name = String::from_utf16_lossy(&buf[..n as usize]).to_lowercase();
        if name.contains("mpv") {
            let out = lparam as *mut isize;
            *out = hwnd as isize;
            return 0; // stop enumeration
        }
    }
    1
}

pub unsafe fn find_mpv_window(host: isize) -> isize {
    let mut found: isize = 0;
    EnumChildWindows(host as HWND, Some(enum_find_mpv), &mut found as *mut isize as LPARAM);
    found
}

/// Reposition the host window (called when the main window resizes).
pub unsafe fn reposition_host(parent: HWND, host: isize, titlebar_px: i32) {
    if host == 0 {
        return;
    }
    let mut rc: RECT = std::mem::zeroed();
    GetClientRect(parent, &mut rc);
    MoveWindow(
        host as HWND,
        0,
        titlebar_px,
        rc.right - rc.left,
        (rc.bottom - rc.top) - titlebar_px,
        1,
    );
}

fn mpv_exe_path() -> Option<std::path::PathBuf> {
    // Dev: always use <src-tauri>/resources/mpv/mpv.exe — this is the only
    // copy guaranteed to have portable_config (uosc). The tauri CLI also
    // mirrors top-level resources into target/<profile>/mpv/ WITHOUT
    // portable_config, so it must not win in debug builds.
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("mpv")
        .join("mpv.exe");
    if cfg!(debug_assertions) && dev.exists() {
        return Some(dev);
    }
    // Release: bundled next to the exe (tauri resources)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("mpv").join("mpv.exe"),
                dir.join("mpv.exe"),
                dir.join("resources").join("mpv").join("mpv.exe"),
            ] {
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    if dev.exists() {
        return Some(dev);
    }
    // Fallback: mpv on PATH
    Some(std::path::PathBuf::from("mpv.exe"))
}

#[derive(serde::Deserialize)]
pub struct StartOptions {
    pub url: String,
    pub title: String,
    pub start_seconds: f64,
    pub rewind_seconds: i64,
    pub forward_seconds: i64,
    pub hw_decode: bool,
    pub audio_boost: bool,
    pub precise_seek: bool,
    #[serde(default)]
    pub sub_files: Vec<String>,
    #[serde(default)]
    pub alang: Option<String>,
    #[serde(default)]
    pub slang: Option<String>,
    #[serde(default)]
    pub media_info: serde_json::Value,
    #[serde(default)]
    pub settings: serde_json::Value,
    #[serde(default)]
    pub http_headers: Option<std::collections::HashMap<String, String>>,
}

/// Disable direct input on mpv's window (all input goes through the host)
/// and give the host keyboard focus.
unsafe fn prepare_mpv_window(host: isize) {
    let mpv = find_mpv_window(host);
    if mpv == 0 {
        return;
    }
    let style = GetWindowLongPtrW(mpv as HWND, GWL_STYLE);
    SetWindowLongPtrW(mpv as HWND, GWL_STYLE, style | WS_DISABLED as isize);
    SetForegroundWindow(host as HWND);
    SetActiveWindow(host as HWND);
    SetFocus(host as HWND);
}

fn pipe_write(pipe: &Sender<serde_json::Value>, value: serde_json::Value) {
    ipc(pipe, value);
}

#[tauri::command]
pub fn player_status(state: tauri::State<'_, PlayerState>) -> PlayerStatus {
    state.status.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn stop_playback(app: AppHandle, state: tauri::State<'_, PlayerState>) -> Result<(), String> {
    stop_internal(&app, &state);
    Ok(())
}

fn stop_internal(app: &AppHandle, state: &PlayerState) {
    let session = state.session.lock().unwrap().take();
    if let Some(s) = session {
        let before = s.window_before;
        stop_session(s);
        state.host.store(0, Ordering::SeqCst);
        restore_window(app, state, before);
    }
    if let Ok(mut st) = state.status.lock() {
        st.active = false;
    }
    let _ = app.emit("mpv://stopped", ());
}

#[tauri::command]
pub fn player_escape(state: tauri::State<'_, PlayerState>) -> bool {
    let session = state.session.lock().unwrap();
    if let Some(session) = session.as_ref() {
        pipe_write(&session.pipe, json!({"command": ["script-message", "mjc-escape"]}));
        true
    } else { false }
}

#[tauri::command]
pub fn player_keyboard_action(state: tauri::State<'_, PlayerState>, key: String) -> bool {
    if !matches!(key.as_str(), "SPACE" | "ENTER") { return false; }
    let session = state.session.lock().unwrap();
    if let Some(session) = session.as_ref() {
        // Use the same Lua input path as the native host, including menu priority.
        pipe_write(&session.pipe, json!({"command": ["script-message", "mjc-key-down", key]}));
        pipe_write(&session.pipe, json!({"command": ["script-message", "mjc-key-up", key]}));
        true
    } else { false }
}

/// Window events run on the window's UI thread. Restore the input host after
/// activation, while leaving hidden/loading and minimized windows alone.
pub fn on_main_window_focused(state: &PlayerState, focused: bool) {
    if !focused {
        if let Ok(session) = state.session.try_lock() {
            if let Some(session) = session.as_ref() {
                pipe_write(&session.pipe, json!({"command": ["script-message", "mjc-cancel-input"]}));
            }
        }
        return;
    }
    let host = state.host.load(Ordering::SeqCst);
    unsafe {
        if host != 0 && IsWindowVisible(host as HWND) != 0 && IsIconic(GetParent(host as HWND)) == 0
            && GetFocus() != host as HWND {
            SetFocus(host as HWND);
        }
    }
}

fn restore_window(app: &AppHandle, state: &PlayerState, before: Option<(bool, tauri::PhysicalSize<u32>)>) {
    *state.video_ratio.lock().unwrap() = None;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(960.0, 640.0)));
        if let Some((fullscreen, size)) = before {
            state.fullscreen.store(fullscreen, Ordering::SeqCst);
            let _ = window.set_fullscreen(fullscreen);
            if !fullscreen { let _ = window.set_size(size); }
        }
    }
}

/// Every startup error (including a closed IPC during observe_property) must
/// undo both native resources and any playback window adjustments.
struct StartupGuard<'a> {
    app: &'a AppHandle,
    state: &'a PlayerState,
    before: Option<(bool, tauri::PhysicalSize<u32>)>,
    host: isize,
    process: Option<StartedProcess>,
    armed: bool,
}
impl Drop for StartupGuard<'_> {
    fn drop(&mut self) {
        if !self.armed { return; }
        if let Some(process) = &self.process { process.terminate(); }
        if self.host != 0 { unsafe { DestroyWindow(self.host as HWND); } }
        self.state.host.store(0, Ordering::SeqCst);
        restore_window(self.app, self.state, self.before);
    }
}

#[tauri::command]
pub fn player_message(state: tauri::State<'_, PlayerState>, message: String) {
    if let Some(session) = state.session.lock().unwrap().as_ref() {
        pipe_write(&session.pipe, json!({"command": ["show-text", message, 2500]}));
    }
}

/// The bundled mpv's OpenSSL backend does not automatically use Windows' trust
/// store. Supply the same trusted roots used by WebView2 without disabling TLS.
fn windows_trusted_roots_pem() -> Result<Vec<u8>, String> {
    unsafe {
        let store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
            CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG | CERT_STORE_OPEN_EXISTING_FLAG,
            wide("ROOT").as_ptr() as *const _);
        if store.is_null() {
            return Err(format!("无法读取 Windows 受信任根证书: {}", std::io::Error::last_os_error()));
        }
        let mut pem = Vec::new();
        let mut context = std::ptr::null_mut();
        loop {
            // Enumeration releases the previous context, including at EOF.
            context = CertEnumCertificatesInStore(store, context);
            if context.is_null() { break; }
            let cert = &*context;
            let mut len = 0;
            if CryptBinaryToStringA(cert.pbCertEncoded, cert.cbCertEncoded,
                CRYPT_STRING_BASE64HEADER, std::ptr::null_mut(), &mut len) == 0 {
                continue;
            }
            let mut encoded = vec![0; len as usize];
            if CryptBinaryToStringA(cert.pbCertEncoded, cert.cbCertEncoded,
                CRYPT_STRING_BASE64HEADER, encoded.as_mut_ptr(), &mut len) != 0 {
                encoded.truncate(len as usize);
                while encoded.last() == Some(&0) { encoded.pop(); }
                pem.extend_from_slice(&encoded);
            }
        }
        CertCloseStore(store, 0);
        if pem.is_empty() { return Err("Windows 受信任根证书为空".into()); }
        Ok(pem)
    }
}

fn player_ca_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let pem = windows_trusted_roots_pem()?;
    let dir = match std::env::var_os("MJC_WEBVIEW_DATA") {
        Some(data_dir) => std::path::PathBuf::from(data_dir).join("player"),
        None => app.path().app_cache_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建播放器证书目录: {e}"))?;
    let path = dir.join("mpv-windows-roots.pem");
    std::fs::write(&path, pem).map_err(|e| format!("无法写入播放器证书: {e}"))?;
    Ok(path)
}

fn stop_session(s: MpvSession) {
    // Remove the native overlay immediately, before waiting for network I/O
    // in mpv to unwind. This runs on the window's owning thread.
    unsafe {
        if s.host_hwnd != 0 { DestroyWindow(s.host_hwnd as HWND); }
    }
    pipe_write(&s.pipe, json!({"command": ["quit"]}));
    let deadline = Instant::now() + Duration::from_millis(800);
    while pid_alive(s.pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if pid_alive(s.pid) { kill_pid(s.pid); }
}

#[tauri::command]
pub fn start_playback(
    app: AppHandle,
    state: tauri::State<'_, PlayerState>,
    opts: StartOptions,
) -> Result<(), String> {
    // Only one playback at a time
    stop_internal(&app, &state);

    let mpv = mpv_exe_path().ok_or("未找到 mpv 播放器")?;
    if !mpv.exists() {
        return Err(format!("mpv 不存在: {}", mpv.display()));
    }
    let ca_file = player_ca_file(&app)?;

    let window = app
        .get_webview_window("main")
        .ok_or("主窗口不存在")?;
    let parent_hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    state.ui_dpi.store((scale * 96.0).round() as u32, Ordering::SeqCst);
    let window_before = window.inner_size().ok().map(|size| (window.is_fullscreen().unwrap_or(false), size));
    let mut startup = StartupGuard { app: &app, state: &state, before: window_before, host: 0, process: None, armed: true };
    state.fullscreen.store(window.is_fullscreen().unwrap_or(false), Ordering::SeqCst);
    *state.last_size.lock().unwrap() = (0, 0);
    if setting_bool(&opts.settings, "matchWindowToVideoRatio", true) {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(320.0, 240.0)));
    }
    let titlebar_px = (TITLEBAR_CSS_PX * scale) as i32;
    state.titlebar_px.store(titlebar_px, Ordering::SeqCst);

    let host = unsafe { create_host_window(parent_hwnd.0 as HWND, titlebar_px) };
    if host == 0 {
        return Err("创建播放窗口失败".into());
    }
    state.host.store(host, Ordering::SeqCst);
    startup.host = host;

    let pipe_name = format!("mjc-mpv-{}-{}", std::process::id(), NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst));
    let mut args: Vec<String> = vec![
        format!("--wid={}", host),
        format!("--input-ipc-server=\\\\.\\pipe\\{}", pipe_name),
        format!("--tls-ca-file={}", ca_file.display()),
        "--tls-verify=yes".into(),
        "--keep-open=yes".into(),
        // Connect IPC and install all handlers before asking mpv to open media.
        "--idle=yes".into(),
        "--force-window=immediate".into(),
        "--keepaspect=yes".into(), "--video-unscaled=no".into(), "--video-zoom=0".into(),
        "--video-pan-x=0".into(), "--video-pan-y=0".into(), "--panscan=0".into(),
        // Our ASS controller replaces the stock OSC. Load only the bundled
        // script so stale portable configs cannot draw a second controller.
        "--load-scripts=no".into(),
        format!("--script={}", mpv.parent().unwrap().join("portable_config/scripts/mjc-osc.lua").display()),
        format!("--glsl-shaders-append={}", mpv.parent().unwrap().join("portable_config/shaders/mjc-glass.glsl").display()),
        "--osc=no".into(),
        "--osd-level=1".into(),
        "--osd-duration=2000".into(),
        "--cursor-autohide=1000".into(),
        "--cache=yes".into(),
        "--ytdl=no".into(),
        format!("--title={}", opts.title),
        // --title only names the mpv window. OSC media-title must use server metadata too.
        format!("--force-media-title={}", opts.title),
        format!("--start={}", opts.start_seconds.max(0.0)),
    ];
    args.extend(playback_setting_args(&opts));
    if let Some(headers) = &opts.http_headers {
        for (name, value) in headers {
            if name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !value.contains(['\r', '\n']) {
                args.push(format!("--http-header-fields-append={name}: {value}"));
            }
        }
    }
    if let Some(alang) = &opts.alang {
        args.push(format!("--alang={}", alang));
    }
    if let Some(slang) = &opts.slang {
        args.push(format!("--slang={}", slang));
    }
    for sub in &opts.sub_files {
        args.push(format!("--sub-file={}", sub));
    }
    // Debug: log mpv output for diagnosing script/UI issues
    if cfg!(debug_assertions) {
        let directory = std::env::var_os("MJC_WEBVIEW_DATA").map(|path| std::path::PathBuf::from(path).join("player"))
            .or_else(|| app.path().app_cache_dir().ok());
        if let Some(directory) = directory {
            let _ = std::fs::create_dir_all(&directory);
            args.push(format!("--log-file={}", directory.join("mpv-player.log").display()));
        }
    }

    let pipe_path = format!("\\\\.\\pipe\\{}", pipe_name);
    let (process, mut pipe_file) = connect_player_process(&pipe_path, Duration::from_secs(6), || {
        unsafe { spawn_hosted_tracked(&mpv, &args, mpv.parent().unwrap()) }
            .map_err(|e| format!("启动播放器失败: {e}"))
    })?;
    let pid = process.pid;
    startup.process = Some(process);

    let mut command_file = None;
    for _ in 0..60 {
        if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) {
            command_file = Some(file);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let command_file = command_file.ok_or_else(|| {
        let _ = write_json(&mut pipe_file, &json!({"command": ["quit"]}));
        "无法连接 mpv 命令通道".to_string()
    })?;
    let pipe = command_sender(command_file);

    let cursor_zones = Arc::new(Mutex::new(Vec::new()));
    // Attach input-forwarding data to the host window
    {
        let host_data = Box::new(MpvHostData {
            pipe: pipe.clone(),
            last_move: Instant::now() - Duration::from_secs(1),
            high_surrogate: None,
            mouse_captured: false,
            captured_cursor: CursorKind::Default,
            cursor_zones: cursor_zones.clone(),
            fullscreen: state.fullscreen.clone(),
        });
        unsafe {
            SetWindowLongPtrW(host as HWND, GWLP_USERDATA, Box::into_raw(host_data) as isize);
        }
    }

    // Keep the native mouse controller and keyboard shortcuts on the same settings.
    pipe_write(&pipe, json!({"command": ["script-message", "mjc-seek-settings",
        opts.rewind_seconds.to_string(), opts.forward_seconds.to_string(), opts.precise_seek.to_string()]}));
    // Lua owns keyboard/mouse bindings so locks and hold gestures apply equally
    // to the native host and mpv input. Direct seek bindings bypass those rules.
    pipe_write(&pipe, json!({"command": ["script-message", "mjc-media-details", opts.media_info.to_string()]}));
    let mut script_settings = opts.settings.clone();
    if !script_settings.is_object() { script_settings = json!({}); }
    script_settings["doubleClickMilliseconds"] = json!(unsafe { GetDoubleClickTime() }.clamp(100, 1500));
    script_settings["uiScale"] = json!(scale);
    pipe_write(&pipe, json!({"command": ["script-message", "mjc-settings", script_settings.to_string()]}));
    // Observe properties for progress reporting
    // Subscribe on the event connection before its read loop begins.
    write_json(&mut pipe_file, &json!({"command": ["observe_property", 1, "time-pos"]})).map_err(|e| e.to_string())?;
    write_json(&mut pipe_file, &json!({"command": ["observe_property", 2, "duration"]})).map_err(|e| e.to_string())?;
    write_json(&mut pipe_file, &json!({"command": ["observe_property", 3, "pause"]})).map_err(|e| e.to_string())?;
    // Decoder geometry is available before the rendered frame/OSC. Do not wait
    // for Lua or sample image contents to choose the playback window's ratio.
    write_json(&mut pipe_file, &json!({"command": ["observe_property", 4, "video-params"]})).map_err(|e| e.to_string())?;
    // Initial queries
    write_json(&mut pipe_file, &json!({"command": ["get_property", "duration"], "request_id": 100})).map_err(|e| e.to_string())?;

    if let Ok(mut st) = state.status.lock() {
        *st = PlayerStatus { active: true, position: opts.start_seconds.max(0.0), ..Default::default() };
    }
    *state.session.lock().unwrap() = Some(MpvSession {
        pid,
        host_hwnd: host,
        pipe: pipe.clone(),
        window_before,
    });
    startup.armed = false;

    // Reader thread: events from mpv
    {
        let status = state.status.clone();
        let app2 = app.clone();
        let settings = opts.settings.clone();
        let screenshot_pipe = pipe_path.clone();
        let command_pipe = pipe.clone();
        let reader = BufReader::new(pipe_file);
        std::thread::spawn(move || {
            let mut last_emit = Instant::now() - Duration::from_secs(2);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                // Ignore late events from a stopped or replaced player.
                if !app2.state::<PlayerState>().session.lock().unwrap()
                    .as_ref().is_some_and(|s| s.pid == pid) {
                    break;
                }
                match v.get("event").and_then(|e| e.as_str()) {
                    Some("file-loaded") => {
                        let app3 = app2.clone();
                        let ready_settings = settings.clone();
                        let _ = app2.run_on_main_thread(move || {
                            let state = app3.state::<PlayerState>();
                            let guard = state.session.lock().unwrap();
                            if !guard.as_ref().is_some_and(|s| s.pid == pid) { return; }
                            if setting_bool(&ready_settings, "autoFullscreenOnPlay", false) {
                                if let Some(window) = app3.get_webview_window("main") {
                                    state.fullscreen.store(true, Ordering::SeqCst);
                                    let _ = window.set_fullscreen(true);
                                }
                            }
                            unsafe {
                                on_main_window_resized(&state, GetParent(host as HWND));
                                ShowWindow(host as HWND, SW_SHOW);
                                prepare_mpv_window(host);
                            }
                            let _ = app3.emit("mpv://ready", ());
                        });
                    }
                    Some("end-file") if v["reason"] == "error" => {
                        let message = v["file_error"].as_str().unwrap_or("视频加载失败");
                        let _ = app2.emit("mpv://error", message);
                    }
                    Some("property-change") => {
                        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
                        if name == "video-params" {
                            if let Some(ratio) = decoded_video_ratio(&data, &settings) {
                                update_video_ratio(&app2, pid, ratio);
                            }
                            continue;
                        }
                        if let Ok(mut st) = status.lock() {
                            match name {
                                "time-pos" => st.position = data.as_f64().unwrap_or(st.position),
                                "duration" => st.duration = data.as_f64().unwrap_or(st.duration),
                                "pause" => st.paused = data.as_bool().unwrap_or(st.paused),
                                _ => {}
                            }
                        }
                        if last_emit.elapsed() >= Duration::from_millis(1000) {
                            last_emit = Instant::now();
                            if let Ok(st) = status.lock() {
                                let _ = app2.emit("mpv://position", st.clone());
                            }
                        }
                    }
                    Some("client-message") => {
                        if let Some(arg) = v.get("args").and_then(|a| a.get(0)).and_then(|a| a.as_str()) {
                            match arg {
                                "mjc-quit" => {
                                    let _ = app2.emit("mpv://request-stop", ());
                                }
                                "mjc-fullscreen" => {
                                    if let Some(w) = app2.get_webview_window("main") {
                                        let fs = w.is_fullscreen().unwrap_or(false);
                                        app2.state::<PlayerState>().fullscreen.store(!fs, Ordering::SeqCst);
                                        let _ = w.set_fullscreen(!fs);
                                    }
                                }
                                "mjc-switch-media" => {
                                    if let Some(direction @ ("prev" | "next")) = v["args"][1].as_str() {
                                        let _ = app2.emit("mpv://switch-media", direction);
                                    }
                                }
                                "mjc-track-selected" => {
                                    if let (Some(kind @ ("audio" | "sub")), Some(track)) = (v["args"][1].as_str(), v["args"][2].as_str().and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())) {
                                        let _ = app2.emit("mpv://track-selected", json!({"kind": kind, "track": track}));
                                    }
                                }
                                "mjc-subtitle-search-history" => {
                                    if let Some(queries) = v["args"][1].as_str().and_then(|text| serde_json::from_str::<Vec<String>>(text).ok()) {
                                        let _ = app2.emit("mpv://subtitle-search-history", queries);
                                    }
                                }
                                "mjc-screenshot" => screenshot::request(&app2, pid, &screenshot_pipe, &command_pipe, &settings),
                                "mjc-cursor-zones" => {
                                    if let Some(zones) = v["args"][1].as_str().and_then(|s| serde_json::from_str::<Vec<CursorZone>>(s).ok()) {
                                        *cursor_zones.lock().unwrap() = zones;
                                        let app3 = app2.clone();
                                        let _ = app2.run_on_main_thread(move || {
                                            if !app3.state::<PlayerState>().session.lock().unwrap().as_ref().is_some_and(|s| s.pid == pid) { return; }
                                            unsafe { refresh_host_cursor(host); }
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {
                        if v.get("request_id").and_then(|r| r.as_i64()) == Some(100) {
                            if let Some(d) = v.get("data").and_then(|d| d.as_f64()) {
                                if let Ok(mut st) = status.lock() {
                                    st.duration = d;
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // Watchdog: emit exit event with final position when mpv exits
    {
        let status = state.status.clone();
        let app2 = app.clone();
        let host_copy = host;
        std::thread::spawn(move || {
            let state_host = app2.state::<PlayerState>();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let done = {
                    let guard = state_host.session.lock().unwrap();
                    !guard.as_ref().is_some_and(|s| s.pid == pid)
                };
                if done {
                    break;
                }
                // check if process exited
                let exited = {
                    let guard = state_host.session.lock().unwrap();
                    match guard.as_ref() {
                        Some(s) => !pid_alive(s.pid),
                        None => true,
                    }
                };
                if exited {
                    // Win32 windows must be destroyed on their owning thread.
                    let app3 = app2.clone();
                    let _ = app2.run_on_main_thread(move || {
                        let state = app3.state::<PlayerState>();
                        let mut guard = state.session.lock().unwrap();
                        if !guard.as_ref().is_some_and(|s| s.pid == pid) { return; }
                        let before = guard.take().and_then(|s| s.window_before);
                        drop(guard);
                        restore_window(&app3, &state, before);
                        unsafe { DestroyWindow(host_copy as HWND); }
                        state.host.store(0, Ordering::SeqCst);
                        let st = status.lock().map(|mut s| {
                            s.active = false;
                            s.clone()
                        }).unwrap_or_default();
                        let _ = app3.emit("mpv://exit", st);
                    });
                    break;
                }
            }
        });
    }

    pipe_write(&pipe, json!({"command": ["loadfile", opts.url]}));

    Ok(())
}

fn decoded_video_ratio(params: &serde_json::Value, settings: &serde_json::Value) -> Option<f64> {
    if !setting_bool(settings, "matchWindowToVideoRatio", true) { return None; }
    let valid = |n: f64| n.is_finite() && n > 0.0;
    let mut ratio = params["aspect"].as_f64().filter(|n| valid(*n)).or_else(|| {
        let w = params["dw"].as_f64().filter(|n| valid(*n))?;
        let h = params["dh"].as_f64().filter(|n| valid(*n))?;
        Some(w / h)
    })?;
    if params["rotate"].as_i64().unwrap_or(0).rem_euclid(180) == 90 { ratio = 1.0 / ratio; }
    (ratio.is_finite() && ratio > 0.1 && ratio < 10.0).then_some(ratio)
}

fn update_video_ratio(app: &AppHandle, pid: u32, ratio: f64) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app2.state::<PlayerState>();
        if !state.session.lock().unwrap().as_ref().is_some_and(|s| s.pid == pid) { return; }
        {
            let mut previous = state.video_ratio.lock().unwrap();
            if previous.is_some_and(|old| (old - ratio).abs() < 0.00001) { return; }
            *previous = Some(ratio);
        }
        if let Some(window) = app2.get_webview_window("main") {
            if let Ok(hwnd) = window.hwnd() { on_main_window_resized(&state, hwnd.0 as HWND); }
        }
    });
}

/// Called from the window resize handler in lib.rs
pub fn on_main_window_resized(state: &PlayerState, parent: HWND) {
    if unsafe { IsIconic(parent) } != 0 { return; }
    let host = state.host.load(Ordering::SeqCst);
    let tb = if state.fullscreen.load(Ordering::SeqCst) { 0 } else {
        (TITLEBAR_CSS_PX * unsafe { GetDpiForWindow(parent) } as f64 / 96.0).round() as i32
    };
    state.titlebar_px.store(tb, Ordering::SeqCst);
    if host == 0 { return; }
    let dpi = unsafe { GetDpiForWindow(parent) }.max(96);
    if dpi != state.ui_dpi.load(Ordering::SeqCst) {
        // Resize may run inside another window operation holding session.
        if let Ok(session) = state.session.try_lock() {
            if let Some(session) = session.as_ref() {
                pipe_write(&session.pipe, json!({"command": ["script-message", "mjc-ui-scale", (dpi as f64 / 96.0).to_string()]}));
                state.ui_dpi.store(dpi, Ordering::SeqCst);
            }
        }
    }
    let ratio = *state.video_ratio.lock().unwrap();
    unsafe {
        if let Some(ratio) = ratio.filter(|_| !state.fullscreen.load(Ordering::SeqCst) && IsZoomed(parent) == 0) {
            let mut client: RECT = std::mem::zeroed();
            let mut outer: RECT = std::mem::zeroed();
            if GetClientRect(parent, &mut client) != 0 && GetWindowRect(parent, &mut outer) != 0 {
                let total = (client.right - client.left, client.bottom - client.top);
                let current = (total.0, (total.1 - tb).max(1));
                let previous = *state.last_size.lock().unwrap();
                let raw = ratio_size(current, previous, ratio);
                let scale = (GetDpiForWindow(parent) as f64 / 96.0).max(1.0);
                let multiplier = (320.0 * scale / raw.0.max(1) as f64).max(240.0 * scale / raw.1.max(1) as f64).max(1.0);
                let desired = ((raw.0 as f64 * multiplier).ceil() as i32, (raw.1 as f64 * multiplier).ceil() as i32);
                *state.last_size.lock().unwrap() = desired;
                if (current.0 - desired.0).abs() > 1 || (current.1 - desired.1).abs() > 1 {
                    SetWindowPos(parent, std::ptr::null_mut(), 0, 0,
                        desired.0 + (outer.right - outer.left - total.0),
                        desired.1 + tb + (outer.bottom - outer.top - total.1),
                        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }
        }
        reposition_host(parent, host, tb);
    }
}

fn resize_hit(x: i32, y: i32, w: i32, h: i32, edge: i32) -> u32 {
    let left = x >= 0 && x < edge; let right = x >= w - edge && x < w;
    let top = y >= 0 && y < edge; let bottom = y >= h - edge && y < h;
    match (left, right, top, bottom) {
        (true, _, true, _) => HTTOPLEFT, (_, true, true, _) => HTTOPRIGHT,
        (true, _, _, true) => HTBOTTOMLEFT, (_, true, _, true) => HTBOTTOMRIGHT,
        (true, _, _, _) => HTLEFT, (_, true, _, _) => HTRIGHT,
        (_, _, true, _) => HTTOP, (_, _, _, true) => HTBOTTOM, _ => HTCLIENT,
    }
}

pub fn on_main_window_closing(app: &AppHandle, state: &PlayerState) { stop_internal(app, state); }

fn ratio_size(current: (i32, i32), previous: (i32, i32), ratio: f64) -> (i32, i32) {
    if previous == (0, 0) {
        if current.0 as f64 / current.1.max(1) as f64 > ratio {
            ((current.1 as f64 * ratio).round() as i32, current.1)
        } else { (current.0, (current.0 as f64 / ratio).round() as i32) }
    } else if (current.0 - previous.0).abs() >= (current.1 - previous.1).abs() {
        (current.0, (current.0 as f64 / ratio).round() as i32)
    } else { ((current.1 as f64 * ratio).round() as i32, current.1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_exit_fixture() {
        // Run this exact test in a child process to produce a controlled exit
        // code without a shell, environment mutation or a real broken DLL.
        if let Some(code) = std::env::args().find_map(|arg| {
            arg.strip_prefix("mjc-exit-code=").and_then(|value| value.parse::<u32>().ok())
        }) { std::process::exit(code as i32); }
    }

    #[test]
    fn startup_detects_exited_children_and_retries_only_dll_initialization() {
        let fixture = std::env::current_exe().unwrap();
        let cwd = fixture.parent().unwrap();
        let mpv = mpv_exe_path().expect("bundled mpv");
        let pipe_path = format!("\\\\.\\pipe\\mjc-startup-retry-{}", std::process::id());
        let fixture_args = |code: u32| vec!["--exact".into(), "player::tests::startup_exit_fixture".into(),
            "--skip".into(), format!("mjc-exit-code={code}"), "--quiet".into()];
        let failed_args = fixture_args(STATUS_DLL_INIT_FAILED);
        let mpv_args = vec!["--no-config".into(), "--load-scripts=no".into(), "--idle=yes".into(),
            "--vo=null".into(), "--ao=null".into(), format!("--input-ipc-server={pipe_path}")];
        let mut attempts = 0;
        let (process, mut file) = connect_player_process(&pipe_path, Duration::from_secs(3), || {
            attempts += 1;
            unsafe {
                if attempts == 1 { spawn_hosted_tracked(&fixture, &failed_args, cwd) }
                else { spawn_hosted_tracked(&mpv, &mpv_args, mpv.parent().unwrap()) }
            }
        }).unwrap();
        assert_eq!(attempts, 2, "a transient DLL initialization failure must recover once");
        assert_ne!(unsafe { GetErrorMode() } & SEM_FAILCRITICALERRORS, 0);
        write_json(&mut file, &json!({"command": ["quit"]})).unwrap();
        unsafe { WaitForSingleObject(process.handle, 3000); }
        if process.exit_code().is_none() { process.terminate(); }

        for (code, expected_attempts) in [(7, 1), (STATUS_DLL_INIT_FAILED, 2)] {
            let args = fixture_args(code);
            let mut attempts = 0;
            let start = Instant::now();
            let error = connect_player_process(&pipe_path, Duration::from_secs(3), || {
                attempts += 1;
                unsafe { spawn_hosted_tracked(&fixture, &args, cwd) }
            }).err().expect("fixture child must fail before IPC connects");
            assert_eq!(attempts, expected_attempts);
            assert!(error.contains(&format!("0x{code:08X}")));
            assert!(start.elapsed() < Duration::from_secs(2), "exit detection must not wait for IPC timeout");
        }
    }

    #[test]
    fn startup_timeout_terminates_the_owned_process() {
        let mpv = mpv_exe_path().expect("bundled mpv");
        let args = vec!["--no-config".into(), "--load-scripts=no".into(), "--vo=null".into(), "--idle=yes".into()];
        let pipe_path = format!("\\\\.\\pipe\\mjc-no-ipc-{}", std::process::id());
        let mut pid = 0;
        let error = connect_player_process(&pipe_path, Duration::from_millis(250), || {
            let process = unsafe { spawn_hosted_tracked(&mpv, &args, mpv.parent().unwrap()) }?;
            pid = process.pid;
            Ok(process)
        }).err().expect("fixture intentionally has no IPC server");
        assert!(error.contains("启动超时"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while pid_alive(pid) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
        assert!(!pid_alive(pid), "a timed-out startup must not leave mpv running");
    }

    #[test]
    fn keyboard_keys_and_video_ratio_follow_native_input() {
        assert_eq!(player_key(VK_LEFT).as_deref(), Some("LEFT"));
        assert_eq!(player_key(0x35).as_deref(), Some("5"));
        assert_eq!(player_key(0x65).as_deref(), Some("5"));
        assert_eq!(player_key(VK_BACK).as_deref(), Some("BACKSPACE"));
        assert_eq!(ratio_size((1280, 800), (0, 0), 16.0 / 9.0), (1280, 720));
        assert_eq!(ratio_size((1280, 800), (0, 0), 9.0 / 16.0), (450, 800));
        assert_eq!(ratio_size((1440, 720), (1280, 720), 16.0 / 9.0), (1440, 810));
        assert_eq!(ratio_size((1280, 900), (1280, 720), 16.0 / 9.0), (1600, 900));
        let video_size = ratio_size((1280, 800 - 36), (0, 0), 16.0 / 9.0);
        assert_eq!((video_size.0, video_size.1 + 36), (1280, 756), "title bar must be excluded from video aspect calculation");
        assert_eq!(resize_hit(2, 400, 1280, 800, 5), HTLEFT);
        assert_eq!(resize_hit(1278, 798, 1280, 800, 5), HTBOTTOMRIGHT);
        assert_eq!(resize_hit(640, 2, 1280, 800, 5), HTTOP);
        assert_eq!(resize_hit(640, 400, 1280, 800, 5), HTCLIENT);
    }

    #[test]
    fn window_ratio_uses_decoded_display_size_and_rotation_without_cropping() {
        let settings = json!({});
        assert_eq!(decoded_video_ratio(&json!({"aspect": 16.0 / 9.0, "crop-w": 1920, "crop-h": 816}), &settings), Some(16.0 / 9.0));
        assert_eq!(decoded_video_ratio(&json!({"aspect": 4.0 / 3.0, "w": 720, "h": 576}), &settings), Some(4.0 / 3.0));
        assert_eq!(decoded_video_ratio(&json!({"dw": 1920, "dh": 1080, "rotate": 90}), &settings), Some(9.0 / 16.0));
        assert_eq!(decoded_video_ratio(&json!({"dw": 1920, "dh": 1080, "rotate": 270}), &settings), Some(9.0 / 16.0));
        assert_eq!(decoded_video_ratio(&json!({"aspect": 16.0 / 9.0}), &json!({"matchWindowToVideoRatio": false})), None);
        for params in [json!(null), json!({"aspect": 0}), json!({"dw": 1920, "dh": 0}), json!({"aspect": 99})] {
            assert_eq!(decoded_video_ratio(&params, &settings), None);
        }
    }

    #[test]
    fn bundled_mpv_accepts_hardware_audio_hdr_and_screenshot_settings() {
        for enabled in [true, false] {
            let opts: StartOptions = serde_json::from_value(json!({
                "url": "fixture", "title": "fixture", "start_seconds": 0,
                "rewind_seconds": 5, "forward_seconds": 30, "hw_decode": enabled,
                "audio_boost": enabled, "precise_seek": enabled,
                "settings": {"hdrSubtitle": enabled, "screenshotFormat": if enabled {"png"} else {"jpg"}, "jpegQuality": 70}
            })).unwrap();
            let mpv = mpv_exe_path().unwrap();
            let pipe_path = format!("\\\\.\\pipe\\mjc-setting-test-{}-{enabled}", std::process::id());
            let mut args = vec!["--no-config".into(), "--load-scripts=no".into(), "--idle=yes".into(), "--ao=null".into(), format!("--input-ipc-server={pipe_path}")];
            args.extend(playback_setting_args(&opts));
            let pid = unsafe { spawn_hosted(&mpv, &args, mpv.parent().unwrap()) }.unwrap();
            struct Cleanup(u32);
            impl Drop for Cleanup { fn drop(&mut self) { kill_pid(self.0); } }
            let _cleanup = Cleanup(pid);
            let mut connected = None;
            for _ in 0..100 {
                if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) { connected = Some(file); break; }
                if !pid_alive(pid) { panic!("bundled mpv rejected settings {enabled}"); }
                std::thread::sleep(Duration::from_millis(30));
            }
            let mut reader = BufReader::new(connected.expect("mpv IPC did not start"));
            let properties = [
                ("volume-max", json!(if enabled {200} else {100})),
                ("sub-hdr-peak", json!(if enabled {"auto"} else {"sdr"})),
                ("image-subs-hdr-peak", json!(if enabled {"video"} else {"sdr"})),
                ("screenshot-format", json!(if enabled {"png"} else {"jpg"})),
                ("screenshot-jpeg-quality", json!(70)),
                ("hr-seek", json!(enabled)),
            ];
            for (index, (property, expected)) in properties.iter().enumerate() {
                let request_id = index as u64 + 1;
                write_json(reader.get_mut(), &json!({"command": ["get_property", format!("options/{property}")], "request_id": request_id})).unwrap();
                loop {
                    let mut line = String::new();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if reply["request_id"] == request_id {
                        assert_eq!(reply["error"], "success", "{property} is unsupported");
                        if expected.is_number() { assert_eq!(reply["data"].as_f64(), expected.as_f64(), "{property} did not apply"); }
                        else { assert_eq!(reply["data"], *expected, "{property} did not apply"); }
                        break;
                    }
                }
            }
            write_json(reader.get_mut(), &json!({"command": ["quit"]})).unwrap();
        }
    }

    #[test]
    fn windows_trusted_roots_export_as_a_valid_pem_bundle() {
        let pem = windows_trusted_roots_pem().unwrap();
        assert!(!pem.contains(&0), "PEM must not contain C string terminators");
        let text = std::str::from_utf8(&pem).unwrap();
        assert!(text.starts_with("-----BEGIN CERTIFICATE-----"));
        assert_eq!(text.matches("-----BEGIN CERTIFICATE-----").count(),
            text.matches("-----END CERTIFICATE-----").count());
        // Optional real-server diagnostics can use the exact native bundle.
        if let Some(path) = std::env::var_os("MJC_TEST_CA_EXPORT") {
            std::fs::write(path, pem).unwrap();
        }
    }

    #[test]
    fn cancelling_a_stalled_http_load_stops_mpv_without_waiting_for_the_server() {
        use std::io::Read;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stalled.mp4", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let (requested_send, requested_receive) = mpsc::channel();
        let (release_send, release_receive) = mpsc::channel();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut request = [0; 2048];
                    let _ = stream.read(&mut request);
                    let _ = requested_send.send(());
                    // Accept the request but never send headers or video data.
                    let _ = release_receive.recv_timeout(Duration::from_secs(10));
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let mpv = mpv_exe_path().expect("bundled mpv");
        let pipe_path = format!("\\\\.\\pipe\\mjc-stalled-load-test-{}", std::process::id());
        let args = vec!["--no-config".into(), "--load-scripts=no".into(),
            "--idle=yes".into(), "--vo=null".into(), "--ao=null".into(),
            format!("--input-ipc-server={pipe_path}")];
        let pid = unsafe { spawn_hosted(&mpv, &args, mpv.parent().unwrap()) }.unwrap();
        struct Cleanup(u32);
        impl Drop for Cleanup { fn drop(&mut self) { kill_pid(self.0); } }
        let _cleanup = Cleanup(pid);
        let connect = || {
            for _ in 0..100 {
                if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) {
                    return file;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            panic!("mpv pipe did not start");
        };
        let events = connect();
        let commands = command_sender(connect());
        let (loaded_send, loaded_receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(events).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if value["event"] == "file-loaded" { let _ = loaded_send.send(()); }
                }
            }
        });
        pipe_write(&commands, json!({"command": ["loadfile", url]}));
        requested_receive.recv_timeout(Duration::from_secs(5)).expect("mpv did not request the stalled video");
        assert!(loaded_receive.try_recv().is_err(), "fixture must still be loading");
        let start = Instant::now();
        stop_session(MpvSession { pid, host_hwnd: 0, pipe: commands, window_before: None });
        assert!(start.elapsed() < Duration::from_secs(2), "cancel waited for the HTTP server");
        let deadline = Instant::now() + Duration::from_secs(2);
        while pid_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!pid_alive(pid), "cancel left mpv running");
        let _ = release_send.send(());
    }

    #[test]
    fn windows_arguments_preserve_header_quotes_and_trailing_slashes() {
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(quote_windows_arg("--title=Test film"), "\"--title=Test film\"");
        assert_eq!(quote_windows_arg("--http-header-fields-append=Test: \"value\""),
            "\"--http-header-fields-append=Test: \\\"value\\\"\"");
        assert_eq!(quote_windows_arg("C:\\Video Folder\\"), "\"C:\\Video Folder\\\\\"");
    }

    #[test]
    fn commands_remain_responsive_with_an_idle_event_reader() {
        let mpv = mpv_exe_path().expect("bundled mpv");
        let pipe_path = format!("\\\\.\\pipe\\mjc-pause-test-{}", std::process::id());
        let args = vec![
            "--no-config".into(), "--load-scripts=no".into(),
            "--idle=yes".into(), "--vo=null".into(), "--ao=null".into(),
            format!("--input-ipc-server={pipe_path}"),
        ];
        let pid = unsafe { spawn_hosted(&mpv, &args, mpv.parent().unwrap()) }.unwrap();
        struct Cleanup(u32);
        impl Drop for Cleanup { fn drop(&mut self) { kill_pid(self.0); } }
        let _cleanup = Cleanup(pid);
        let connect = || {
            for _ in 0..100 {
                if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) {
                    return file;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            panic!("mpv pipe did not start");
        };
        let mut events = connect();
        let commands = command_sender(connect());
        write_json(&mut events, &json!({"command": ["observe_property", 1, "pause"]})).unwrap();
        let (send, receive) = mpsc::channel();
        let (message_send, message_receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(events).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if value["event"] == "property-change" && value["name"] == "pause" {
                    if let Some(paused) = value["data"].as_bool() { let _ = send.send(paused); }
                }
                if value["event"] == "client-message" {
                    let _ = message_send.send(value["args"].clone());
                }
            }
        });
        let timeout = Duration::from_secs(5);
        let _initial = receive.recv_timeout(timeout).unwrap();
        for _ in 0..3 {
            commands.send(json!({"command": ["set_property", "pause", true]})).unwrap();
            assert!(receive.recv_timeout(timeout).expect("pause command blocked"));
            // While paused the event thread is waiting for new input. Mouse
            // traffic and resume must still get through the command connection.
            for x in 0..100 {
                commands.send(json!({"command": ["mouse", x, 20]})).unwrap();
            }
            commands.send(json!({"command": ["set_property", "pause", false]})).unwrap();
            assert!(!receive.recv_timeout(timeout).expect("resume command blocked"));
        }
        commands.send(json!({"command": ["script-message", "mjc-quit"]})).unwrap();
        assert_eq!(message_receive.recv_timeout(timeout).expect("exit message was not delivered"), json!(["mjc-quit"]));
        commands.send(json!({"command": ["quit"]})).unwrap();
    }
}
