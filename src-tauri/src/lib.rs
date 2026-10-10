mod player;
mod playback_diagnostics;
mod client_identity;
mod app_updates;

use player::{on_main_window_resized, PlayerState};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PlayerState::default())
        .invoke_handler(tauri::generate_handler![
            app_updates::open_project_releases,
            player::start_playback,
            player::stop_playback,
            player::player_status,
            player::player_message,
            player::player_escape,
            player::player_keyboard_action,
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
            if let Ok(dir) = std::env::var("MJC_WEBVIEW_DATA") {
                builder = builder.data_directory(std::path::PathBuf::from(dir));
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
                        if let Ok(hwnd) = w.hwnd() {
                            on_main_window_resized(&state, hwnd.0 as _);
                        }
                    }
                }
                if let WindowEvent::CloseRequested { .. } = event {
                    player::on_main_window_closing(&handle, &handle.state::<PlayerState>());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
