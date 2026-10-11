//! macOS libmpv backend. AppKit/CGL stays on the main thread; the Windows
//! external-process backend remains selected by cfg(windows).
use crate::playback_diagnostics::PlaybackTrace;
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};

extern "C" {
    fn mjc_macos_create(
        parent: *mut c_void,
        options: *const c_char,
        script: *const c_char,
        shader: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const c_char, *const c_char) -> bool,
    ) -> *mut c_void;
    fn mjc_macos_destroy(view: *mut c_void);
    fn mjc_macos_command(view: *mut c_void, command: *const c_char);
    fn mjc_macos_layout(view: *mut c_void, fullscreen: bool, focus: bool);
    fn mjc_macos_capture(view: *mut c_void, path: *const c_char, copy: bool);
}

#[derive(Clone, Default, Serialize)]
pub struct PlayerStatus {
    pub active: bool,
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
}
struct Session {
    view: usize,
    // The native view's event callbacks are unregistered before this Box drops.
    _context: Box<EventContext>,
    before: Option<(bool, tauri::PhysicalSize<u32>)>,
}
struct EventContext {
    app: AppHandle,
    generation: u64,
    diagnostic_id: String,
    settings: Value,
    trace: PlaybackTrace,
}
#[derive(Default)]
pub struct PlayerState {
    session: Mutex<Option<Session>>,
    current_id: Mutex<Option<String>>,
    cancelled_ids: Mutex<std::collections::VecDeque<String>>,
    generation: AtomicU64,
    status: Mutex<PlayerStatus>,
    fullscreen: AtomicBool,
    loaded: AtomicBool,
}
impl PlayerState {
    pub fn sync_fullscreen(&self, value: bool) {
        self.fullscreen.store(value, Ordering::SeqCst);
    }
    fn handle(&self) -> Option<usize> {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s._context.generation == self.generation.load(Ordering::SeqCst))
            .map(|s| s.view)
    }
    fn reserve(&self, id: String) -> Option<u64> {
        let mut current = self.current_id.lock().unwrap();
        // Tauri IPC handlers may begin out of order. A stop received before
        // start has entered must also prevent that late start from opening video.
        if self.cancelled_ids.lock().unwrap().contains(&id) {
            return None;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *current = Some(id);
        Some(generation)
    }
    fn cancel(&self, id: Option<&str>) -> Option<u64> {
        let mut current = self.current_id.lock().unwrap();
        if let Some(id) = id {
            let mut cancelled = self.cancelled_ids.lock().unwrap();
            if !cancelled.iter().any(|entry| entry == id) {
                cancelled.push_back(id.to_owned());
                if cancelled.len() > 64 {
                    cancelled.pop_front();
                }
            }
            if current.is_some() && current.as_deref() != Some(id) {
                return None;
            }
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *current = None;
        Some(generation)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
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
    #[serde(default)]
    pub diagnostic_id: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct DanmakuComment {
    time: f64,
    mode: u8,
    color: u32,
    text: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct DanmakuChoice {
    id: String,
    label: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    episode: String,
}

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "播放参数包含无效字符".into())
}
fn send(state: &PlayerState, command: Value) {
    let Some(view) = state.handle() else { return };
    let Ok(command) = cstring(&command.to_string()) else {
        return;
    };
    // SAFETY: callers run on the owning UI thread; no view can be destroyed
    // concurrently. Native code copies the JSON and arguments synchronously.
    unsafe {
        mjc_macos_command(view as _, command.as_ptr());
    }
}
async fn on_ui<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|_| "无法调度原生播放器".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "原生播放器任务已结束".to_owned())
    })
    .await
    .map_err(|_| "原生播放器任务失败".to_owned())?
}
fn current(context: &EventContext) -> bool {
    context
        .app
        .state::<PlayerState>()
        .generation
        .load(Ordering::SeqCst)
        == context.generation
}
extern "C" fn native_event(
    pointer: *mut c_void,
    name: *const c_char,
    payload: *const c_char,
) -> bool {
    // Never unwind across the C boundary. The Box outlives native teardown and
    // all queued native blocks check disposed before accessing this callback.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let context = unsafe { &*(pointer as *const EventContext) };
        if !current(context) {
            return false;
        }
        let name = unsafe { CStr::from_ptr(name) }.to_string_lossy();
        let Ok(value) =
            serde_json::from_slice::<Value>(unsafe { CStr::from_ptr(payload) }.to_bytes())
        else {
            return false;
        };
        let app = &context.app;
        let state = app.state::<PlayerState>();
        match name.as_ref() {
            "version" => context.trace.record("mpv.version", value),
            "ready" => {
                state.loaded.store(true, Ordering::SeqCst);
                if context.settings["autoFullscreenOnPlay"].as_bool() == Some(true) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_fullscreen(true);
                    }
                    state.sync_fullscreen(true);
                    on_main_window_resized(&state);
                }
                context
                    .trace
                    .record("mpv.file-loaded", json!({"backend":"libmpv-opengl"}));
                let _ = app.emit("mpv://ready", ());
            }
            "position" => {
                if let Ok(status) = serde_json::from_value::<Position>(value) {
                    let status = PlayerStatus {
                        active: true,
                        position: status.position,
                        duration: status.duration,
                        paused: status.paused,
                    };
                    *state.status.lock().unwrap() = status.clone();
                    let _ = app.emit("mpv://position", status);
                }
            }
            "video-ratio" => {
                if context.settings["matchWindowToVideoRatio"]
                    .as_bool()
                    .unwrap_or(true)
                    && !state.fullscreen.load(Ordering::SeqCst)
                {
                    if let (Some(ratio), Some(window)) = (
                        value["ratio"]
                            .as_f64()
                            .filter(|r| r.is_finite() && *r > 0.1 && *r < 20.0),
                        app.get_webview_window("main"),
                    ) {
                        if !window.is_maximized().unwrap_or(false) {
                            if let (Ok(size), Ok(scale)) =
                                (window.inner_size(), window.scale_factor())
                            {
                                let width = size.width as f64 / scale;
                                let height = width / ratio;
                                let _ = window
                                    .set_min_size(Some(tauri::LogicalSize::new(320.0, 240.0)));
                                let _ = window
                                    .set_size(tauri::LogicalSize::new(width, height.max(240.0)));
                            }
                        }
                    }
                }
            }
            "error" => {
                context
                    .trace
                    .record("mpv.end-file.error", json!({"message":value}));
                let _ = app.emit("mpv://error", value);
            }
            "log" => context.trace.record("mpv.log", value),
            "command-error" => context.trace.record("mpv.command.failed", value),
            "capture-result" => {
                let text = if value["success"] == true {
                    "截图已保存"
                } else {
                    "截图失败，请重试"
                };
                send(&state, json!(["show-text", text, "3500"]));
            }
            "message" => {
                let Some(args) = value.as_array() else { return false };
                match args.first().and_then(Value::as_str) {
                    Some("mjc-quit") => {
                        let _ = app.emit("mpv://request-stop", ());
                    }
                    Some("mjc-fullscreen") => {
                        if let Some(window) = app.get_webview_window("main") {
                            let full = !window.is_fullscreen().unwrap_or(false);
                            let _ = window.set_fullscreen(full);
                            state.sync_fullscreen(full);
                            on_main_window_resized(&state);
                        }
                    }
                    Some("mjc-switch-media") => {
                        if let Some(direction @ ("prev" | "next")) =
                            args.get(1).and_then(Value::as_str)
                        {
                            let _ = app.emit("mpv://switch-media", direction);
                        }
                    }
                    Some("mjc-track-selected") => {
                        if let (Some(kind @ ("audio" | "sub")), Some(track)) = (
                            args.get(1).and_then(Value::as_str),
                            args.get(2)
                                .and_then(Value::as_str)
                                .and_then(|s| serde_json::from_str::<Value>(s).ok()),
                        ) {
                            let _ = app
                                .emit("mpv://track-selected", json!({"kind":kind,"track":track}));
                        }
                    }
                    Some("mjc-subtitle-search-history") => {
                        if let Some(queries) = args
                            .get(1)
                            .and_then(Value::as_str)
                            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                        {
                            let _ = app.emit("mpv://subtitle-search-history", queries);
                        }
                    }
                    Some("mjc-danmaku-action") => {
                        let _ = app.emit("mpv://danmaku-action", json!({"diagnosticId":context.diagnostic_id,"action":args.get(1),"id":args.get(2)}));
                    }
                    Some("mjc-screenshot") => capture(app, &state, &context.settings),
                    _ => {}
                }
            }
            _ => {}
        }
        true
    })).unwrap_or(false)
}
#[derive(serde::Deserialize)]
struct Position {
    position: f64,
    duration: f64,
    paused: bool,
}

fn resource(app: &AppHandle, path: &str) -> Result<CString, String> {
    let development = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/mpv/portable_config")
        .join(path);
    let file = if cfg!(debug_assertions) && development.is_file() {
        development
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "无法定位播放器资源".to_owned())?
            .join("mpv/portable_config")
            .join(path)
    };
    if !file.is_file() {
        return Err("原生播放器资源缺失，请重新构建应用".into());
    }
    cstring(&file.to_string_lossy())
}
#[tauri::command]
pub async fn start_playback(
    app: AppHandle,
    state: tauri::State<'_, PlayerState>,
    mut opts: StartOptions,
) -> Result<(), String> {
    if !opts.start_seconds.is_finite() || opts.start_seconds < 0.0 || opts.url.len() > 32768 {
        return Err("播放参数无效".into());
    }
    if !opts.settings.is_object() {
        opts.settings = json!({});
    }
    if !opts.media_info.is_object() {
        opts.media_info = json!({});
    }
    let parsed = tauri::Url::parse(&opts.url).map_err(|_| "媒体地址无效".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("媒体地址必须使用 HTTP 或 HTTPS".into());
    }
    let id = opts.diagnostic_id.clone().unwrap_or_default();
    let Some(generation) = state.reserve(id.clone()) else {
        return Ok(());
    };
    let trace = PlaybackTrace::new(&app, id.clone(), &opts.url, opts.http_headers.as_ref());
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        destroy_session(&app2, &state);
        state.loaded.store(false, Ordering::SeqCst);
        let window = app2.get_webview_window("main").ok_or("主窗口不存在")?;
        let script = resource(&app2, "scripts/mjc-osc.lua")?;
        let shader = resource(&app2, "shaders/mjc-glass.glsl")?;
        let before = window
            .inner_size()
            .ok()
            .map(|size| (window.is_fullscreen().unwrap_or(false), size));
        let options = cstring(&serde_json::to_string(&opts).map_err(|_| "无法编码播放参数")?)?;
        *state.status.lock().unwrap() = PlayerStatus {
            active: true,
            position: opts.start_seconds,
            ..Default::default()
        };
        let mut context = Box::new(EventContext {
            app: app2.clone(),
            generation,
            diagnostic_id: id,
            settings: opts.settings.clone(),
            trace,
        });
        let parent = window.ns_view().map_err(|_| "无法取得 macOS 播放视图")?;
        // SAFETY: all pointers stay valid through create. Native copies strings,
        // retains the NSView and only calls back while the context Box exists.
        let handle = unsafe {
            mjc_macos_create(
                parent,
                options.as_ptr(),
                script.as_ptr(),
                shader.as_ptr(),
                (&mut *context as *mut EventContext).cast(),
                native_event,
            )
        };
        if handle.is_null() {
            state.status.lock().unwrap().active = false;
            return Err("无法初始化 libmpv GPU 播放器".into());
        }
        *state.session.lock().unwrap() = Some(Session {
            view: handle as usize,
            _context: context,
            before,
        });
        on_main_window_resized(&state);
        Ok(())
    })
    .await?
}
fn destroy_session(app: &AppHandle, state: &PlayerState) {
    let session = state.session.lock().unwrap().take();
    if let Some(session) = session {
        unsafe {
            mjc_macos_destroy(session.view as _);
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_min_size(Some(tauri::LogicalSize::new(960.0, 640.0)));
            if let Some((fullscreen, size)) = session.before {
                state.sync_fullscreen(fullscreen);
                let _ = window.set_fullscreen(fullscreen);
                if !fullscreen {
                    let _ = window.set_size(size);
                }
            }
        }
    }
    state.loaded.store(false, Ordering::SeqCst);
    state.status.lock().unwrap().active = false;
}
#[tauri::command]
pub async fn stop_playback(
    app: AppHandle,
    state: tauri::State<'_, PlayerState>,
    diagnostic_id: Option<String>,
) -> Result<(), String> {
    let generation = state.cancel(diagnostic_id.as_deref());
    let Some(generation) = generation else {
        return Ok(());
    };
    // A newer start may reserve its generation before this UI task executes.
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if state.generation.load(Ordering::SeqCst) == generation {
            destroy_session(&app2, &state);
            let _ = app2.emit("mpv://stopped", ());
        }
    })
    .await
}
#[tauri::command]
pub fn player_status(state: tauri::State<'_, PlayerState>) -> PlayerStatus {
    state.status.lock().unwrap().clone()
}
#[tauri::command]
pub async fn player_message(
    app: AppHandle,
    message: String,
    diagnostic_id: Option<String>,
) -> Result<(), String> {
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if diagnostic_id
            .as_ref()
            .is_some_and(|id| state.current_id.lock().unwrap().as_ref() != Some(id))
        {
            return;
        }
        send(&state, json!(["show-text", message, "3500"]))
    })
    .await
}
#[tauri::command]
pub async fn player_escape(app: AppHandle, diagnostic_id: Option<String>) -> Result<bool, String> {
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if diagnostic_id
            .as_ref()
            .is_some_and(|id| state.current_id.lock().unwrap().as_ref() != Some(id))
        {
            return false;
        }
        if state.handle().is_none() {
            return false;
        }
        send(&state, json!(["script-message", "mjc-escape"]));
        true
    })
    .await
}
#[tauri::command]
pub async fn player_keyboard_action(
    app: AppHandle,
    key: String,
    diagnostic_id: Option<String>,
) -> Result<bool, String> {
    if !matches!(key.as_str(), "SPACE" | "ENTER") {
        return Ok(false);
    }
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if diagnostic_id
            .as_ref()
            .is_some_and(|id| state.current_id.lock().unwrap().as_ref() != Some(id))
        {
            return false;
        }
        if state.handle().is_none() {
            return false;
        }
        send(&state, json!(["script-message", "mjc-key-down", key]));
        send(&state, json!(["script-message", "mjc-key-up", key]));
        true
    })
    .await
}
#[tauri::command]
pub async fn player_keyboard_input(
    app: AppHandle,
    diagnostic_id: String,
    key: String,
    down: bool,
) -> Result<bool, String> {
    if !matches!(
        key.as_str(),
        "LEFT"
            | "RIGHT"
            | "UP"
            | "DOWN"
            | "SPACE"
            | "ENTER"
            | "ESC"
            | "F"
            | "M"
            | "A"
            | "S"
            | "BS"
            | "0"
            | "1"
            | "2"
            | "3"
            | "4"
            | "5"
            | "6"
            | "7"
            | "8"
            | "9"
    ) {
        return Ok(false);
    }
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if state.current_id.lock().unwrap().as_ref() != Some(&diagnostic_id) {
            return false;
        }
        send(
            &state,
            json!([
                "script-message",
                if down { "mjc-key-down" } else { "mjc-key-up" },
                key
            ]),
        );
        true
    })
    .await
}
#[tauri::command]
pub async fn player_danmaku(
    app: AppHandle,
    diagnostic_id: String,
    comments: Vec<DanmakuComment>,
    settings: Value,
    choices: Vec<DanmakuChoice>,
    status: String,
) -> Result<bool, String> {
    if comments.len() > 50_000
        || comments.iter().any(|c| {
            !c.time.is_finite()
                || c.time < 0.0
                || c.time > 604800.0
                || !matches!(c.mode, 1 | 4 | 5 | 6)
                || c.color > 0xffffff
                || c.text.chars().count() > 300
        })
        || comments.windows(2).any(|c| c[0].time > c[1].time)
        || choices.len() > 20_000
        || choices.iter().any(|c| {
            c.id.chars().count() > 512
                || c.label.chars().count() > 620
                || c.title.chars().count() > 300
                || c.episode.chars().count() > 300
        })
        || status.len() > 2000
    {
        return Err("弹幕数据超出范围".into());
    }
    let app2 = app.clone();
    on_ui(app, move || {
        let state = app2.state::<PlayerState>();
        if state.current_id.lock().unwrap().as_ref() != Some(&diagnostic_id)
            || state.handle().is_none()
        {
            return false;
        }
        send(
            &state,
            json!([
                "script-message",
                "mjc-danmaku-begin",
                settings.to_string(),
                status
            ]),
        );
        for chunk in comments.chunks(40) {
            send(
                &state,
                json!([
                    "script-message",
                    "mjc-danmaku-chunk",
                    serde_json::to_string(chunk).unwrap()
                ]),
            );
        }
        for chunk in choices.chunks(5) {
            send(
                &state,
                json!([
                    "script-message",
                    "mjc-danmaku-choices",
                    serde_json::to_string(chunk).unwrap()
                ]),
            );
        }
        send(&state, json!(["script-message", "mjc-danmaku-end"]));
        true
    })
    .await
}
pub fn on_main_window_resized(state: &PlayerState) {
    if let Some(handle) = state.handle() {
        unsafe {
            mjc_macos_layout(handle as _, state.fullscreen.load(Ordering::SeqCst), false);
        }
    }
}
pub fn on_main_window_focused(state: &PlayerState, focused: bool) {
    if let Some(handle) = state.handle() {
        if focused {
            unsafe {
                mjc_macos_layout(handle as _, state.fullscreen.load(Ordering::SeqCst), true);
            }
        } else {
            send(state, json!(["script-message", "mjc-cancel-input"]));
        }
    }
}
pub fn on_main_window_closing(app: &AppHandle, state: &PlayerState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    destroy_session(app, state);
}
fn capture(app: &AppHandle, state: &PlayerState, settings: &Value) {
    let Some(handle) = state.handle() else { return };
    let development = std::env::var_os("MJC_WEBVIEW_DATA")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("screenshots"));
    let pictures = app
        .path()
        .picture_dir()
        .ok()
        .map(|p| p.join("MyJellyfinClient"));
    let fallback = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|p| p.join("screenshots"));
    let extension = if settings["screenshotFormat"] == "jpeg" {
        "jpg"
    } else {
        "png"
    };
    for directory in development.into_iter().chain(pictures).chain(fallback) {
        if std::fs::create_dir_all(&directory).is_err() {
            continue;
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = directory.join(format!("MyJellyfinClient-{stamp}.{extension}"));
        if std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .is_err()
        {
            continue;
        }
        if let Ok(path) = cstring(&path.to_string_lossy()) {
            unsafe {
                mjc_macos_capture(
                    handle as _,
                    path.as_ptr(),
                    settings["copyScreenshotToClipboard"]
                        .as_bool()
                        .unwrap_or(true),
                );
            }
            return;
        }
        let _ = std::fs::remove_file(path);
    }
    send(state, json!(["show-text", "无法写入截图目录", "3500"]));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_invalidates_an_unstarted_ui_task() {
        let state = PlayerState::default();
        let queued_start = state.reserve("first".into()).unwrap();
        let cancelled = state.cancel(Some("first")).unwrap();
        assert!(cancelled > queued_start);
        assert_ne!(state.generation.load(Ordering::SeqCst), queued_start);
        assert!(state.current_id.lock().unwrap().is_none());
    }
    #[test]
    fn old_effect_cleanup_cannot_cancel_the_next_playback() {
        let state = PlayerState::default();
        state.reserve("first".into());
        let next = state.reserve("second".into()).unwrap();
        assert_eq!(state.cancel(Some("first")), None);
        assert_eq!(state.generation.load(Ordering::SeqCst), next);
        assert_eq!(state.current_id.lock().unwrap().as_deref(), Some("second"));
    }
    #[test]
    fn a_stop_before_handler_entry_blocks_a_late_start() {
        let state = PlayerState::default();
        state.cancel(Some("cancelled-before-start"));
        assert_eq!(state.reserve("cancelled-before-start".into()), None);
        assert!(state.current_id.lock().unwrap().is_none());
        assert!(state.reserve("new-playback".into()).is_some());
        assert_eq!(state.reserve("cancelled-before-start".into()), None);
        assert_eq!(
            state.current_id.lock().unwrap().as_deref(),
            Some("new-playback")
        );
    }
    #[test]
    fn queued_stop_is_ignored_after_a_new_start_reservation() {
        let state = PlayerState::default();
        state.reserve("first".into());
        let queued_stop = state.cancel(Some("first")).unwrap();
        let next = state.reserve("second".into()).unwrap();
        assert_ne!(queued_stop, state.generation.load(Ordering::SeqCst));
        assert_eq!(next, state.generation.load(Ordering::SeqCst));
    }
}
