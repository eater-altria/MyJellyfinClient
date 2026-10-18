#[cfg(windows)]
mod player;
#[cfg(target_os = "macos")]
#[path = "player_macos.rs"]
mod player;
#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("Desktop playback currently supports Windows and macOS only.");
mod playback_diagnostics;
mod client_identity;
mod app_updates;
mod media_server_http;
mod webdav_http;

use player::PlayerState;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PlayerState::default())
        .manage(media_server_http::MediaServerHttp::default())
        .manage(webdav_http::WebDavHttp::default())
        .invoke_handler(tauri::generate_handler![
            webdav_http::start_webdav_request,
            webdav_http::cancel_webdav_request,
            media_server_http::start_media_server_request,
            media_server_http::cancel_media_server_request,
            app_updates::open_project_releases,
            player::start_playback,
            player::stop_playback,
            player::player_status,
            player::player_message,
            player::player_danmaku,
            player::player_escape,
            player::player_keyboard_action,
            player::player_keyboard_input,
            playback_diagnostics::record_playback_diagnostic,
            playback_diagnostics::get_playback_log_path,
        ])
        .setup(|app| {
            app.manage(playback_diagnostics::PlaybackDiagnostics::new(app.handle()));
            // Create the main window programmatically so the WebView2 data
            // directory can be overridden via MJC_WEBVIEW_DATA (useful when
            // %APPDATA% is not writable, e.g. sandboxed dev environments).
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("MyJellyfinClient")
                    .user_agent(&client_identity::http_user_agent())
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(960.0, 640.0)
                    .decorations(false)
                    .resizable(true)
                    .fullscreen(false)
                    .center();
            #[cfg(windows)]
            if let Ok(dir) = std::env::var("MJC_WEBVIEW_DATA") {
                builder = builder.data_directory(std::path::PathBuf::from(dir));
            }
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .decorations(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    // Wry's Y inset changes the native titlebar container height,
                    // rather than the button's distance from the top. These
                    // insets put the 14px buttons 20px inside the sidebar at (12, 6).
                    .traffic_light_position(tauri::LogicalPosition::new(32.0, 36.0))
                    .initialization_script("window.__MJC_PLATFORM__ = 'macos';");
                // WKWebView does not support data_directory. Keep development
                // accounts separate from the installed app with a stable store.
                if cfg!(debug_assertions) {
                    builder = builder.data_store_identifier(*b"mjc-macos-dev-01");
                }
                // An explicit native regression session never reads or writes
                // the user's persistent WKWebView accounts, including release QA.
                if std::env::var_os("MJC_NATIVE_TEST_MODE").is_some() { builder = builder.incognito(true); }
            }
            let window = builder.build()?;

            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(focused) = event {
                    player::on_main_window_focused(&handle.state::<PlayerState>(), *focused);
                }
                if let WindowEvent::Resized(_) = event {
                    let state = handle.state::<PlayerState>();
                    if let Some(w) = handle.get_webview_window("main") {
                        state.sync_fullscreen(w.is_fullscreen().unwrap_or(false));
                        #[cfg(windows)]
                        if let Ok(hwnd) = w.hwnd() {
                            player::on_main_window_resized(&state, hwnd.0 as _);
                        }
                        #[cfg(target_os = "macos")]
                        player::on_main_window_resized(&state);
                    }
                }
                #[cfg(windows)]
                if let WindowEvent::CloseRequested { .. } = event {
                    player::on_main_window_closing(&handle, &handle.state::<PlayerState>());
                }
                // The native Mac close button can be cancelled by the playback
                // page. Release native resources only when the window is destroyed.
                #[cfg(target_os = "macos")]
                if let WindowEvent::Destroyed = event {
                    player::on_main_window_closing(&handle, &handle.state::<PlayerState>());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
