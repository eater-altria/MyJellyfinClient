const RELEASES_PAGE_URL: &str = "https://github.com/eater-altria/MyJellyfinClient/releases/latest";

/// No arbitrary URL or executable is accepted from the WebView.
#[tauri::command]
pub fn open_project_releases() -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let url: Vec<u16> = RELEASES_PAGE_URL.encode_utf16().chain(Some(0)).collect();
    // Both strings are NUL-terminated and remain alive throughout the call;
    // Windows chooses the user's registered browser for this fixed HTTPS URL.
    let result = unsafe {
        ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), url.as_ptr(),
            std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
    } as isize;
    if result <= 32 { Err("无法打开默认浏览器".into()) } else { Ok(()) }
}
