//! Detect symmetric black padding in a few original video frames. Cropping is
//! applied by mpv's renderer, without installing a software video filter.
use super::{pipe_write, screenshot, write_json, PlayerState};
use std::io::{BufRead, BufReader};
use std::sync::mpsc::Sender;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Crop { w: usize, h: usize, x: usize, y: usize, source_w: usize, source_h: usize }

fn detect_padding(dib: &[u8]) -> Option<Crop> {
    if dib.len() < 40 { return None; }
    let w = i32::from_le_bytes(dib[4..8].try_into().ok()?);
    let h = -i32::from_le_bytes(dib[8..12].try_into().ok()?);
    if w < 64 || h < 64 { return None; }
    let (w, h) = (w as usize, h as usize);
    let pixels = dib.get(40..)?;
    if pixels.len() != w.checked_mul(h)?.checked_mul(4)? { return None; }
    let black = |x: usize, y: usize| {
        let p = &pixels[(y * w + x) * 4..][..3];
        p.iter().all(|v| *v <= 8)
    };
    let black_row = |y: usize| (0..64).all(|s| black((s * (w - 1)) / 63, y));
    let black_col = |x: usize, y0: usize, y1: usize| (0..64).all(|s| black(x, y0 + s * (y1 - y0 - 1) / 63));
    let top = (0..h / 5).take_while(|y| black_row(*y)).count();
    let bottom = (0..h / 5).take_while(|y| black_row(h - y - 1)).count();
    // A fade, title card, or dark scene must not be mistaken for padding.
    if top.abs_diff(bottom) > (h / 200).max(4) || top + bottom >= h * 35 / 100 { return None; }
    let y1 = h - bottom;
    let left = (0..w / 5).take_while(|x| black_col(*x, top, y1)).count();
    let right = (0..w / 5).take_while(|x| black_col(w - x - 1, top, y1)).count();
    if left.abs_diff(right) > (w / 200).max(4) || left + right >= w * 35 / 100 { return None; }
    if top + bottom < 4 && left + right < 4 { return None; }
    let x = left & !1;
    let y = top & !1;
    let width = (w - right - x) & !1;
    let height = (h - bottom - y) & !1;
    // Ensure the remaining frame actually contains non-black image content.
    let colored = (0..64).filter(|s| !black(x + s * (width - 1) / 63, y + s * (height - 1) / 63)).count();
    if colored < 16 { return None; }
    Some(Crop { w: width, h: height, x, y, source_w: w, source_h: h })
}

fn active(app: &AppHandle, pid: u32) -> bool {
    app.state::<PlayerState>().session.lock().unwrap().as_ref().is_some_and(|s| s.pid == pid)
}

pub(super) fn request(app: &AppHandle, pid: u32, pipe_path: &str, commands: &Sender<Value>, busy: &Arc<AtomicBool>) {
    if busy.swap(true, Ordering::SeqCst) { return; }
    let busy = busy.clone();
    let app = app.clone(); let pipe_path = pipe_path.to_string(); let commands = commands.clone();
    std::thread::spawn(move || {
        struct BusyGuard(Arc<AtomicBool>);
        impl Drop for BusyGuard { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
        let _busy = BusyGuard(busy);
        let mut previous: Option<Crop> = None;
        for attempt in 0..4 {
            std::thread::sleep(Duration::from_millis(800));
            if !active(&app, pid) { return; }
            let result = (|| -> Option<Crop> {
                let dir = match std::env::var_os("MJC_WEBVIEW_DATA") {
                    Some(dir) => std::path::PathBuf::from(dir).join("player"),
                    None => app.path().app_cache_dir().ok()?,
                };
                std::fs::create_dir_all(&dir).ok()?;
                let path = dir.join(format!("frame-padding-{pid}-{attempt}.png"));
                struct TemporaryFrame(std::path::PathBuf);
                impl Drop for TemporaryFrame { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
                let _frame = TemporaryFrame(path.clone());
                let mut file = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path).ok()?;
                write_json(&mut file, &json!({"command": ["screenshot-to-file", path.to_string_lossy(), "video"], "request_id": 1})).ok()?;
                for line in BufReader::new(file).lines() {
                    let reply: Value = serde_json::from_str(&line.ok()?).ok()?;
                    if reply["request_id"] == 1 {
                        if reply["error"] != "success" { return None; }
                        return detect_padding(&screenshot::decode_dib(&path).ok()?);
                    }
                }
                None
            })();
            if let Some(crop) = result {
                if let Some(old) = previous.filter(|old| old.source_w == crop.source_w && old.source_h == crop.source_h
                    && old.x.abs_diff(crop.x) <= 4 && old.y.abs_diff(crop.y) <= 4 && old.w.abs_diff(crop.w) <= 4 && old.h.abs_diff(crop.h) <= 4) {
                    if !active(&app, pid) { return; }
                    // Use the larger stable area to avoid clipping a scene edge.
                    let x = old.x.min(crop.x); let y = old.y.min(crop.y);
                    let w = (old.x + old.w).max(crop.x + crop.w) - x;
                    let h = (old.y + old.h).max(crop.y + crop.h) - y;
                    pipe_write(&commands, json!({"command": ["script-message", "mjc-frame-crop",
                        w.to_string(), h.to_string(), x.to_string(), y.to_string(), crop.source_w.to_string(), crop.source_h.to_string()]}));
                    return;
                }
                previous = Some(crop);
            } else { previous = None; }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(width: usize, height: usize, pad_x: usize, pad_y: usize) -> Vec<u8> {
        let mut dib = vec![0; 40 + width * height * 4];
        dib[4..8].copy_from_slice(&(width as i32).to_le_bytes());
        dib[8..12].copy_from_slice(&(-(height as i32)).to_le_bytes());
        for y in pad_y..height-pad_y { for x in pad_x..width-pad_x {
            dib[40+(y*width+x)*4..][..4].copy_from_slice(&[120, 80, 40, 255]);
        } }
        dib
    }
    #[test]
    fn film_padding_is_removed_but_title_cards_and_full_frames_are_preserved() {
        let crop = detect_padding(&frame(320, 180, 0, 22)).unwrap();
        assert_eq!((crop.w, crop.h, crop.x, crop.y), (320, 136, 0, 22));
        let crop = detect_padding(&frame(320, 180, 38, 0)).unwrap();
        assert_eq!((crop.w, crop.h, crop.x, crop.y), (244, 180, 38, 0));
        assert!(detect_padding(&frame(320, 180, 0, 0)).is_none());
        assert!(detect_padding(&frame(320, 180, 100, 70)).is_none());
        assert!(detect_padding(&vec![0; 40 + 320 * 180 * 4]).is_none());
        let mut asymmetric = frame(320, 180, 0, 22);
        asymmetric[40..40+320*4].fill(120);
        assert!(detect_padding(&asymmetric).is_none());
    }

    #[test]
    fn real_mpv_fit_and_fill_use_the_visible_frame_without_a_black_border_ring() {
        use super::super::{create_host_window, reposition_host, register_host_class, spawn_hosted, mpv_exe_path, kill_pid, wide, HOST_CLASS};
        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, GetClientRect};
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        unsafe { register_host_class(); }
        let parent = unsafe { CreateWindowExW(0, wide(HOST_CLASS).as_ptr(), std::ptr::null(), 0,
            0, 0, 1400, 590, std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null()) };
        assert!(!parent.is_null());
        let mut client = windows_sys::Win32::Foundation::RECT::default();
        unsafe { GetClientRect(parent, &mut client); }
        let host = unsafe { create_host_window(parent, 36) };
        assert_ne!(host, 0);
        struct WindowCleanup(isize, isize);
        impl Drop for WindowCleanup { fn drop(&mut self) { unsafe { DestroyWindow(self.0 as _); DestroyWindow(self.1 as _); } } }
        let _windows = WindowCleanup(host, parent as isize);
        let dir = std::env::temp_dir().join(format!("mjc-framing-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("letterboxed.ppm");
        let mut ppm = b"P6\n320 180\n255\n".to_vec();
        for y in 0..180 { for _ in 0..320 { ppm.extend_from_slice(if (22..158).contains(&y) { &[30, 100, 190] } else { &[0, 0, 0] }); } }
        std::fs::write(&input, ppm).unwrap();
        let mpv = mpv_exe_path().unwrap();
        let pipe_path = format!("\\\\.\\pipe\\mjc-framing-render-{}", std::process::id());
        let args = vec!["--no-config".into(), "--load-scripts=no".into(), "--vo=gpu-next".into(),
            "--ao=null".into(), "--osc=no".into(), "--osd-level=0".into(), "--pause=yes".into(),
            "--keep-open=always".into(), "--image-display-duration=inf".into(),
            format!("--wid={host}"), format!("--input-ipc-server={pipe_path}"), input.to_string_lossy().into_owned()];
        let pid = unsafe { spawn_hosted(&mpv, &args, mpv.parent().unwrap()) }.unwrap();
        struct ProcessCleanup(u32);
        impl Drop for ProcessCleanup { fn drop(&mut self) { kill_pid(self.0); } }
        let _process = ProcessCleanup(pid);
        let mut file = None;
        for _ in 0..100 {
            if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) { file = Some(f); break; }
            std::thread::sleep(Duration::from_millis(30));
        }
        let mut reader = BufReader::new(file.expect("mpv IPC"));
        let mut serial = 0;
        let mut command = |value: Value| -> Value {
            let mut retries = 0;
            loop {
                serial += 1;
                write_json(reader.get_mut(), &json!({"command": value, "request_id": serial})).unwrap();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0, "mpv closed IPC");
                    let reply: Value = serde_json::from_str(&line).unwrap();
                    if reply["request_id"] != serial { continue; }
                    if reply["error"] == "success" { return reply["data"].clone(); }
                    // GPU initialization can take longer when several native
                    // tests run concurrently. Wait for its first renderable frame.
                    if value[0] == "screenshot-to-file" && retries < 100 {
                        retries += 1;
                        std::thread::sleep(Duration::from_millis(30));
                        break;
                    }
                    panic!("mpv command failed: {reply}");
                }
            }
        };
        let source = dir.join("source.png");
        std::thread::sleep(Duration::from_millis(400));
        command(json!(["screenshot-to-file", source.to_string_lossy(), "video"]));
        let crop = detect_padding(&screenshot::decode_dib(&source).unwrap()).expect("encoded letterbox padding");
        assert_eq!((crop.w, crop.h, crop.y), (320, 136, 22));
        command(json!(["set_property", "video-crop", format!("{}x{}+{}+{}", crop.w, crop.h, crop.x, crop.y)]));
        command(json!(["set_property", "panscan", 0]));
        std::thread::sleep(Duration::from_millis(100));
        let fitted = dir.join("fitted.png");
        command(json!(["screenshot-to-file", fitted.to_string_lossy(), "window"]));
        let dib = screenshot::decode_dib(&fitted).unwrap();
        let w = i32::from_le_bytes(dib[4..8].try_into().unwrap()) as usize;
        let h = -i32::from_le_bytes(dib[8..12].try_into().unwrap()) as usize;
        assert_eq!((w, h), ((client.right-client.left) as usize, (client.bottom-client.top-36) as usize));
        let colored = |dib: &[u8], x: usize, y: usize| dib[40+(y*w+x)*4..][..3].iter().any(|v| *v > 30);
        assert!(colored(&dib, w/2, 2), "fit must reach the window height after trimming the source bars");
        command(json!(["set_property", "panscan", 1]));
        std::thread::sleep(Duration::from_millis(100));
        let filled = dir.join("filled.png");
        command(json!(["screenshot-to-file", filled.to_string_lossy(), "window"]));
        let dib = screenshot::decode_dib(&filled).unwrap();
        for (x, y) in [(2,2), (w-3,2), (2,h-3), (w-3,h-3)] {
            assert!(colored(&dib, x, y), "crop-fill left a black margin at {x},{y}");
        }
        unsafe { reposition_host(parent, host, 0); }
        std::thread::sleep(Duration::from_millis(100));
        let fullscreen = dir.join("fullscreen.png");
        command(json!(["screenshot-to-file", fullscreen.to_string_lossy(), "window"]));
        let dib = screenshot::decode_dib(&fullscreen).unwrap();
        let full_h = -i32::from_le_bytes(dib[8..12].try_into().unwrap()) as usize;
        assert_eq!(full_h, h + 36, "fullscreen must reclaim the title bar area");
        assert!(colored(&dib, w-3, full_h-3));
        command(json!(["quit"]));
    }
}
