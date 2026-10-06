//! Native screenshot saving and image clipboard support. The mpv command is
//! acknowledged before decoding/copying, so failed captures never report success.
use super::{pipe_write, screenshot_format, setting_bool, wide, write_json, PlayerState};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{GlobalFree, HWND};
use windows_sys::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows_sys::Win32::Graphics::GdiPlus::{self as gdip, BitmapData, GdiplusStartupInput, GpBitmap, ImageLockModeRead};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

fn screenshot_directories(development: Option<&Path>, pictures: Option<&Path>, app_data: Option<&Path>) -> Vec<PathBuf> {
    // Development processes may only write within their configured data root.
    // Installed builds prefer Pictures, with a durable application-data fallback.
    if let Some(root) = development { return vec![root.join("screenshots")]; }
    let mut directories = Vec::new();
    if let Some(root) = pictures { directories.push(root.join("MyJellyfinClient")); }
    if let Some(root) = app_data { directories.push(root.join("screenshots")); }
    directories
}

struct CaptureTarget {
    path: PathBuf,
    complete: bool,
}
impl Drop for CaptureTarget {
    fn drop(&mut self) {
        // Remove only the file reserved for this request, including partial IPC failures.
        if !self.complete { let _ = std::fs::remove_file(&self.path); }
    }
}

fn prepare_capture_target(directories: &[PathBuf], format: &str) -> Result<CaptureTarget, String> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    for dir in directories {
        if std::fs::create_dir_all(dir).is_err() { continue; }
        let path = dir.join(format!("Screenshot-{stamp}.{format}"));
        // Existing directories can still deny writes. Reserve the actual output
        // filename to check access before handing it to mpv; never overwrite a user's file.
        if std::fs::OpenOptions::new().write(true).create_new(true).open(&path).is_ok() {
            return Ok(CaptureTarget { path, complete: false });
        }
    }
    Err("截图保存位置不可写，请检查图片或应用数据目录的访问权限".into())
}

/// Lua serializes captures with its UI state, bypassing only the glass shader
/// during GPU readback. A separate IPC reader waits for the actual result.
pub(super) fn capture_frame(pipe_path: &str, path: &Path, mode: &str) -> Result<(), String> {
    static NEXT_CAPTURE: AtomicU64 = AtomicU64::new(1);
    let token = NEXT_CAPTURE.fetch_add(1, Ordering::Relaxed).to_string();
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(pipe_path).map_err(|e| e.to_string())?;
    write_json(&mut file, &json!({"command": ["script-message", "mjc-capture", token, path.to_string_lossy(), mode], "request_id": 1}))
        .map_err(|e| e.to_string())?;
    for line in BufReader::new(file).lines() {
        let value: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if value["request_id"] == 1 && value["error"] != "success" { return Err("当前画面无法截图".into()); }
        if value["event"] == "client-message" && value["args"][0] == "mjc-capture-result" && value["args"][1] == token {
            return if value["args"][2] == "success" { Ok(()) } else { Err("当前画面无法截图".into()) };
        }
    }
    Err("播放器已结束，截图未生成".into())
}

pub(super) fn request(app: &AppHandle, pid: u32, pipe_path: &str, pipe: &Sender<Value>, settings: &Value) {
    let app = app.clone();
    let pipe_path = pipe_path.to_string();
    let pipe = pipe.clone();
    let format = screenshot_format(settings);
    let copy = setting_bool(settings, "copyScreenshotToClipboard", true);
    let development = std::env::var_os("MJC_WEBVIEW_DATA").filter(|path| !path.is_empty()).map(PathBuf::from);
    let pictures = app.path().picture_dir().ok();
    let app_data = app.path().app_local_data_dir().ok();
    let directories = screenshot_directories(development.as_deref(), pictures.as_deref(), app_data.as_deref());
    std::thread::spawn(move || {
        let result = (|| -> Result<(std::path::PathBuf, Option<Result<Vec<u8>, String>>), String> {
            if !app.state::<PlayerState>().session.lock().unwrap().as_ref().is_some_and(|s| s.pid == pid) { return Err("播放已结束".into()); }
            let mut target = prepare_capture_target(&directories, format)?;
            let path = target.path.clone();
            // A separate IPC connection returns the actual screenshot result.
            // The event reader and UI command worker remain responsive.
            if !app.state::<PlayerState>().session.lock().unwrap().as_ref().is_some_and(|s| s.pid == pid) { return Err("播放已结束".into()); }
            capture_frame(&pipe_path, &path, "subtitles")?;
            if std::fs::metadata(&path).map(|metadata| metadata.len() == 0).unwrap_or(true) { return Err("截图未生成".into()); }
            target.complete = true;
            let dib = if copy { Some(decode_dib(&path)) } else { None };
            Ok((path, dib))
        })();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if !app2.state::<PlayerState>().session.lock().unwrap().as_ref().is_some_and(|s| s.pid == pid) { return; }
            let message = match result {
                Ok((path, dib)) => {
                    if let Some(Ok(dib)) = dib {
                        let hwnd = app2.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as HWND).unwrap_or(std::ptr::null_mut());
                        match copy_dib(hwnd, &dib) {
                            Ok(()) => format!("截图已保存并复制到剪贴板\n{}", path.display()),
                            Err(error) => format!("截图已保存，{error}\n{}", path.display()),
                        }
                    } else if let Some(Err(error)) = dib {
                        format!("截图已保存，复制失败: {error}\n{}", path.display())
                    } else { format!("截图已保存\n{}", path.display()) }
                }
                Err(error) => format!("截图失败: {error}"),
            };
            pipe_write(&pipe, json!({"command": ["show-text", message, 3500]}));
        });
    });
}

fn dib_from_rows(width: u32, height: u32, rows: &[u8]) -> Result<Vec<u8>, String> {
    let bytes = (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4)).ok_or("截图尺寸过大")?;
    if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 || rows.len() != bytes || bytes > u32::MAX as usize { return Err("无效截图尺寸".into()); }
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: width as i32,
        biHeight: -(height as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB,
        biSizeImage: bytes as u32, ..Default::default()
    };
    let mut output = unsafe { std::slice::from_raw_parts(&header as *const _ as *const u8, std::mem::size_of::<BITMAPINFOHEADER>()).to_vec() };
    output.extend_from_slice(rows);
    Ok(output)
}

pub(super) fn decode_dib(path: &std::path::Path) -> Result<Vec<u8>, String> {
    unsafe {
        let mut token = 0;
        let input = GdiplusStartupInput { GdiplusVersion: 1, ..Default::default() };
        if gdip::GdiplusStartup(&mut token, &input, std::ptr::null_mut()) != gdip::Ok { return Err("无法初始化截图解码".into()); }
        struct Decoder(usize);
        impl Drop for Decoder { fn drop(&mut self) { unsafe { gdip::GdiplusShutdown(self.0); } } }
        let _decoder = Decoder(token);
        let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
        if gdip::GdipCreateBitmapFromFile(wide(&path.to_string_lossy()).as_ptr(), &mut bitmap) != gdip::Ok { return Err("无法读取截图图像".into()); }
        struct Bitmap(*mut GpBitmap);
        impl Drop for Bitmap { fn drop(&mut self) { unsafe { gdip::GdipDisposeImage(self.0 as _); } } }
        let _bitmap = Bitmap(bitmap);
        let (mut width, mut height) = (0, 0);
        gdip::GdipGetImageWidth(bitmap as _, &mut width);
        gdip::GdipGetImageHeight(bitmap as _, &mut height);
        let rect = gdip::Rect { X: 0, Y: 0, Width: width as i32, Height: height as i32 };
        let mut data = BitmapData::default();
        // GDI+ PixelFormat32bppARGB stores BGRA bytes, matching a Windows DIB.
        if gdip::GdipBitmapLockBits(bitmap, &rect, ImageLockModeRead as u32, 0x26200A, &mut data) != gdip::Ok { return Err("无法解码截图像素".into()); }
        let row_bytes = width as usize * 4;
        let mut rows = Vec::with_capacity(row_bytes * height as usize);
        for y in 0..height as isize {
            rows.extend_from_slice(std::slice::from_raw_parts((data.Scan0 as *const u8).offset(y * data.Stride as isize), row_bytes));
        }
        gdip::GdipBitmapUnlockBits(bitmap, &mut data);
        dib_from_rows(width, height, &rows)
    }
}

fn copy_dib(hwnd: HWND, bytes: &[u8]) -> Result<(), String> {
    unsafe {
        let allocation = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if allocation.is_null() { return Err("剪贴板内存分配失败".into()); }
        let target = GlobalLock(allocation);
        if target.is_null() { GlobalFree(allocation); return Err("无法写入剪贴板图像".into()); }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, bytes.len());
        GlobalUnlock(allocation);
        if OpenClipboard(hwnd) == 0 { GlobalFree(allocation); return Err("剪贴板正被其他程序占用".into()); }
        let ok = EmptyClipboard() != 0 && !SetClipboardData(8 /* CF_DIB */, allocation).is_null();
        CloseClipboard();
        if !ok { GlobalFree(allocation); return Err("无法复制截图到剪贴板".into()); }
        // Windows owns the allocation after SetClipboardData succeeds.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_paths_respect_development_data_and_fall_back_after_directory_failure() {
        let root = std::env::temp_dir().join(format!("mjc-screenshot-path-test-{}", std::process::id()));
        let development = root.join("development");
        let pictures = root.join("pictures");
        let app_data = root.join("app-data");
        let directories = screenshot_directories(Some(&development), Some(&pictures), Some(&app_data));
        assert_eq!(directories, vec![development.join("screenshots")]);
        let target = prepare_capture_target(&directories, "png").unwrap();
        assert!(target.path.starts_with(&development));
        let incomplete = target.path.clone();
        drop(target);
        assert!(!incomplete.exists(), "a failed screenshot must not leave an empty file");

        // A file occupying the first directory reproduces a real create_dir_all
        // failure without changing Windows ACLs or touching the user's Pictures.
        std::fs::create_dir_all(&pictures).unwrap();
        std::fs::write(pictures.join("MyJellyfinClient"), b"fixture").unwrap();
        let directories = screenshot_directories(None, Some(&pictures), Some(&app_data));
        let mut target = prepare_capture_target(&directories, "jpg").unwrap();
        assert_eq!(target.path.parent().unwrap(), app_data.join("screenshots"));
        std::fs::write(&target.path, b"saved screenshot fixture").unwrap();
        target.complete = true;
        let saved = target.path.clone();
        drop(target);
        assert!(saved.exists(), "a completed capture must be preserved");
        std::fs::remove_file(saved).unwrap();
        assert_eq!(std::fs::read(pictures.join("MyJellyfinClient")).unwrap(), b"fixture");
        assert!(prepare_capture_target(&directories[..1], "png").is_err(), "all unwritable candidates must report failure");
    }
    #[test]
    fn clipboard_dib_preserves_bgra_pixels_and_top_down_orientation() {
        let pixels = [0, 0, 255, 255, 255, 0, 0, 255];
        let dib = dib_from_rows(1, 2, &pixels).unwrap();
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 1);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), -2);
        assert_eq!(&dib[40..], &pixels);
        assert!(dib_from_rows(2, 2, &pixels).is_err());
    }

    #[test]
    fn png_and_jpeg_screenshots_decode_to_a_pasteable_windows_image() {
        unsafe {
            let mut token = 0;
            let input = GdiplusStartupInput { GdiplusVersion: 1, ..Default::default() };
            assert_eq!(gdip::GdiplusStartup(&mut token, &input, std::ptr::null_mut()), gdip::Ok);
            let mut pixels = [0_u8, 0, 255, 255].repeat(16);
            let mut bitmap = std::ptr::null_mut();
            assert_eq!(gdip::GdipCreateBitmapFromScan0(4, 4, 16, 0x26200A, pixels.as_mut_ptr(), &mut bitmap), gdip::Ok);
            for (extension, encoder) in [
                ("png", windows_sys::core::GUID::from_u128(0x557cf406_1a04_11d3_9a73_0000f81ef32e)),
                ("jpg", windows_sys::core::GUID::from_u128(0x557cf401_1a04_11d3_9a73_0000f81ef32e)),
            ] {
                let path = std::env::temp_dir().join(format!("mjc-image-clipboard-test-{}.{}", std::process::id(), extension));
                assert_eq!(gdip::GdipSaveImageToFile(bitmap as _, wide(&path.to_string_lossy()).as_ptr(), &encoder, std::ptr::null()), gdip::Ok);
                let dib = decode_dib(&path).expect("JPEG/PNG screenshot must decode for clipboard");
                assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 4);
                assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), -4);
                assert_eq!(dib.len(), 40 + 64);
                assert!(dib[40] < 5 && dib[41] < 5 && dib[42] > 250, "Decoded red pixels must remain red");
                std::fs::remove_file(path).unwrap();
            }
            gdip::GdipDisposeImage(bitmap as _);
            gdip::GdiplusShutdown(token);
        }
    }
}
