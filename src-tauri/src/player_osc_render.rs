//! Render the bundled OSC in hidden native windows at real viewport sizes/DPI.
use super::*;

#[test]
fn real_mpv_controller_renders_at_wide_small_and_high_dpi_sizes() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let dir = std::env::var_os("MJC_TEST_OSC_RENDER_DIR").map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("mjc-osc-render-{}", std::process::id())));
    std::fs::create_dir_all(&dir).unwrap();
    let mpv = mpv_exe_path().unwrap();
    unsafe { register_host_class(); }

    for (width, height, scale, mode) in [(1280, 720, 1.0, "default"), (1280, 720, 1.0, "sub"),
        (1280, 720, 1.0, "hover"), (800, 450, 1.0, "default"), (480, 320, 1.0, "paused"),
        (320, 240, 1.0, "sub"), (1000, 563, 1.25, "default"), (720, 480, 1.5, "sub"), (640, 480, 2.0, "default")] {
        let parent = unsafe { CreateWindowExW(0, wide(HOST_CLASS).as_ptr(), std::ptr::null(), 0,
            0, 0, width, height, std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null()) };
        assert!(!parent.is_null());
        let mut client = RECT::default();
        unsafe {
            GetClientRect(parent, &mut client);
            SetWindowPos(parent, std::ptr::null_mut(), 0, 0,
                width + width - client.right, height + height - client.bottom,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
        let host = unsafe { create_host_window(parent, 0) };
        assert_ne!(host, 0);
        struct Windows(isize, isize);
        impl Drop for Windows {
            fn drop(&mut self) { unsafe { DestroyWindow(self.0 as _); DestroyWindow(self.1 as _); } }
        }
        let _windows = Windows(host, parent as isize);
        let input = dir.join("background.ppm");
        let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
        for y in 0..height { for x in 0..width {
            let light = (1.0 - ((x as f64 / width as f64 - 0.6).powi(2)
                + (y as f64 / height as f64 - 0.35).powi(2)) * 3.0).max(0.0);
            ppm.extend_from_slice(&[(16.0 + light * 20.0) as u8, (25.0 + light * 50.0) as u8, (38.0 + light * 65.0) as u8]);
        } }
        std::fs::write(&input, ppm).unwrap();
        let pipe_path = format!("\\\\.\\pipe\\mjc-osc-render-{}-{}", std::process::id(), NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst));
        let args = vec!["--no-config".into(), "--load-scripts=no".into(), "--vo=gpu-next".into(),
            "--ao=null".into(), "--osc=no".into(), "--osd-level=0".into(), "--pause=yes".into(),
            "--keep-open=always".into(), "--image-display-duration=inf".into(),
            "--force-media-title=Fixture metadata title".into(),
            format!("--script={}", root.join("scripts/test-player-osc-render.lua").display()),
            format!("--wid={host}"), format!("--input-ipc-server={pipe_path}"), input.to_string_lossy().into_owned()];
        let process = unsafe { spawn_hosted_tracked(&mpv, &args, &root) }.unwrap();
        struct Process(StartedProcess);
        impl Drop for Process { fn drop(&mut self) { if self.0.exit_code().is_none() { self.0.terminate(); } } }
        let _process = Process(process);
        let mut file = None;
        for _ in 0..100 {
            if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) { file = Some(f); break; }
            std::thread::sleep(Duration::from_millis(30));
        }
        let mut reader = BufReader::new(file.expect("mpv render IPC"));
        let mut serial = 0;
        let mut command = |value: serde_json::Value| -> serde_json::Value {
            for _ in 0..100 {
                serial += 1;
                write_json(reader.get_mut(), &json!({"command": value, "request_id": serial})).unwrap();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0, "mpv closed render IPC");
                    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if reply["request_id"] != serial { continue; }
                    if reply["error"] == "success" { return reply["data"].clone(); }
                    assert_eq!(value[0], "screenshot-to-file", "mpv command failed: {reply}");
                    std::thread::sleep(Duration::from_millis(30));
                    break;
                }
            }
            panic!("mpv renderer never became ready");
        };
        // Wait for a real GPU frame before asking Lua to use osd-dimensions.
        let output = dir.join(format!("osc-{width}x{height}-{scale}x-{mode}.png"));
        command(json!(["screenshot-to-file", output.to_string_lossy(), "window"]));
        let background = screenshot::decode_dib(&output).unwrap();
        assert_eq!(command(json!(["get_property", "media-title"])), "Fixture metadata title");
        command(json!(["script-message", "mjc-render-fixture", scale.to_string(), mode]));
        std::thread::sleep(Duration::from_millis(200));
        command(json!(["screenshot-to-file", output.to_string_lossy(), "window"]));
        let dib = screenshot::decode_dib(&output).unwrap();
        let w = i32::from_le_bytes(dib[4..8].try_into().unwrap());
        let h = -i32::from_le_bytes(dib[8..12].try_into().unwrap());
        assert_eq!((w, h), (width, height));
        let bar_top = height - ((if width as f64 / scale < 640.0 { 88.0 } else { 52.0 }) * scale) as i32;
        let white_pixels = dib[40 + (bar_top * width * 4) as usize..].chunks_exact(4).filter(|pixel|
            pixel[0] > 210 && pixel[1] > 210 && pixel[2] > 210).count();
        assert!(white_pixels > 100, "the icon controls and timeline must render in white");
        let sample = 40 + (((height - (6.0 * scale) as i32) * width + width / 2) * 4) as usize;
        let contrast = |pixels: &[u8]| *pixels.iter().max().unwrap() as i32 - *pixels.iter().min().unwrap() as i32;
        assert!(contrast(&dib[sample..sample + 3]) > contrast(&background[sample..sample + 3]) / 4,
            "the underlying video's color must remain visible through the translucent bar");
        // screenshot-to-file must also overwrite the empty file reserved by the
        // screenshot path/access check and produce a real pasteable image.
        let capture = dir.join(format!("capture-{width}-{height}-{scale}-{mode}.png"));
        std::fs::OpenOptions::new().write(true).create_new(true).open(&capture).unwrap();
        command(json!(["screenshot-to-file", capture.to_string_lossy(), "subtitles"]));
        assert!(std::fs::metadata(&capture).unwrap().len() > 0);
        assert!(screenshot::decode_dib(&capture).is_ok());
        std::fs::remove_file(capture).unwrap();
        command(json!(["quit"]));
    }
}
