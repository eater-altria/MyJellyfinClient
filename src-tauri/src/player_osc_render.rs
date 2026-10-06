//! Render the bundled OSC in hidden native windows at real viewport sizes/DPI.
use super::*;

fn horizontal_detail(dib: &[u8], width: i32, x: i32, y: i32, w: i32, h: i32) -> f64 {
    let mut detail = 0;
    for py in y..y + h { for px in x..x + w - 1 {
        let i = 40 + ((py * width + px) * 4) as usize;
        detail += (dib[i] as i32 - dib[i + 4] as i32).abs();
    } }
    detail as f64 / ((w - 1) * h) as f64
}

fn region_difference(a: &[u8], b: &[u8], width: i32, x: i32, y: i32, w: i32, h: i32) -> f64 {
    let mut difference = 0;
    for py in y..y + h { for px in x..x + w {
        let i = 40 + ((py * width + px) * 4) as usize;
        for c in 0..3 { difference += a[i + c].abs_diff(b[i + c]) as u64; }
    } }
    difference as f64 / (w * h * 3) as f64
}

#[test]
fn lua_controller_controls_and_glass_backing_follow_layout() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let dir = root.join(".tmp/osc-glass");
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("lua-controls.log");
    let mpv = mpv_exe_path().unwrap();
    let args = vec!["--no-config".into(), "--load-scripts=no".into(), "--vo=null".into(), "--idle=yes".into(),
        format!("--script={}", root.join("scripts/test-player-osc.lua").display()), format!("--log-file={}", log.display())];
    let process = unsafe { spawn_hosted_tracked(&mpv, &args, &root) }.unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(code) = process.exit_code() {
            assert_eq!(code, 0, "Lua regressions failed: {}", std::fs::read_to_string(&log).unwrap_or_default());
            break;
        }
        if Instant::now() >= deadline { process.terminate(); panic!("Lua regressions timed out"); }
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn decoder_geometry_resizes_the_hidden_host_during_startup() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let dir = root.join(".tmp/osc-startup");
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("letterboxed.ppm");
    let mut ppm = b"P6\n320 180\n255\n".to_vec();
    for y in 0..180 { for _ in 0..320 {
        ppm.extend_from_slice(if (22..158).contains(&y) { &[90, 130, 160] } else { &[0, 0, 0] });
    } }
    std::fs::write(&input, ppm).unwrap();
    unsafe { register_host_class(); }
    let parent = unsafe { CreateWindowExW(0, wide(HOST_CLASS).as_ptr(), std::ptr::null(), 0,
        0, 0, 960, 800, std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null()) };
    assert!(!parent.is_null());
    let host = unsafe { create_host_window(parent, 36) };
    struct Windows(isize, HWND);
    impl Drop for Windows {
        fn drop(&mut self) { unsafe { DestroyWindow(self.0 as _); DestroyWindow(self.1); } }
    }
    let _windows = Windows(host, parent);
    let pipe_path = format!("\\\\.\\pipe\\mjc-ratio-startup-{}-{}", std::process::id(), NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst));
    let args = vec!["--no-config".into(), "--load-scripts=no".into(), "--vo=gpu-next".into(),
        "--ao=null".into(), "--osc=no".into(), "--idle=yes".into(), "--pause=yes".into(),
        format!("--wid={host}"), format!("--input-ipc-server={pipe_path}")];
    let mpv = mpv_exe_path().unwrap();
    let process = unsafe { spawn_hosted_tracked(&mpv, &args, &root) }.unwrap();
    struct Process(StartedProcess);
    impl Drop for Process { fn drop(&mut self) { if self.0.exit_code().is_none() { self.0.terminate(); } } }
    let _process = Process(process);
    let mut connected = None;
    for _ in 0..100 {
        if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_path) { connected = Some(file); break; }
        std::thread::sleep(Duration::from_millis(30));
    }
    let mut file = connected.expect("startup geometry IPC");
    write_json(&mut file, &json!({"command": ["observe_property", 4, "video-params"]})).unwrap();
    write_json(&mut file, &json!({"command": ["loadfile", input.to_string_lossy()]})).unwrap();
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) { let _ = send.send((Instant::now(), value)); }
        }
    });
    let state = PlayerState::default();
    state.host.store(host, Ordering::SeqCst);
    let mut loaded = None;
    let mut resized = None;
    while loaded.is_none() || resized.is_none() {
        let (at, event) = receive.recv_timeout(Duration::from_secs(5)).expect("decoder geometry must arrive at startup");
        if event["event"] == "file-loaded" { loaded = Some(at); }
        if event["event"] == "property-change" && event["name"] == "video-params" {
            if let Some(ratio) = decoded_video_ratio(&event["data"], &json!({})) {
                assert!((ratio - 16.0 / 9.0).abs() < 0.00001, "encoded black bars must not change the video's ratio");
                *state.video_ratio.lock().unwrap() = Some(ratio);
                on_main_window_resized(&state, parent);
                resized = Some(at);
            }
        }
    }
    assert!(resized.unwrap() <= loaded.unwrap() + Duration::from_millis(500), "resize must not wait for image sampling or OSC rendering");
    let mut client = RECT::default();
    unsafe { GetClientRect(parent, &mut client); }
    let tb = state.titlebar_px.load(Ordering::SeqCst);
    assert!((client.right as f64 / (client.bottom - tb) as f64 - 16.0 / 9.0).abs() < 0.01);
    assert_eq!(unsafe { IsWindowVisible(host as HWND) }, 0, "loading host must remain hidden while its geometry is corrected");
    // Maximized/fullscreen windows keep their bounds; restoring reapplies ratio.
    state.fullscreen.store(true, Ordering::SeqCst);
    unsafe { SetWindowPos(parent, std::ptr::null_mut(), 0, 0, 1200, 600, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE); }
    let mut before = RECT::default();
    unsafe { GetClientRect(parent, &mut before); }
    on_main_window_resized(&state, parent);
    unsafe { GetClientRect(parent, &mut client); }
    assert_eq!((client.right, client.bottom), (before.right, before.bottom));
    assert_eq!(state.titlebar_px.load(Ordering::SeqCst), 0);
}

#[test]
fn real_mpv_controller_renders_at_wide_small_and_high_dpi_sizes() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let dir = std::env::var_os("MJC_TEST_OSC_RENDER_DIR").map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("mjc-osc-render-{}", std::process::id())));
    std::fs::create_dir_all(&dir).unwrap();
    let mpv = mpv_exe_path().unwrap();
    unsafe { register_host_class(); }

    for (width, height, scale, mode) in [(1280, 720, 1.0, "default"), (1280, 720, 1.0, "sub"),
        (1280, 720, 1.0, "hover"), (1280, 720, 1.0, "bright"),
        (1280, 720, 1.0, "letterbox"), (1280, 720, 1.0, "pillar"),
        (800, 450, 1.0, "default"), (480, 320, 1.0, "paused"),
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
        let source_w = if mode == "pillar" { width / 2 } else { width };
        let source_h = if mode == "letterbox" { height / 2 } else { height };
        let mut ppm = format!("P6\n{source_w} {source_h}\n255\n").into_bytes();
        for y in 0..source_h { for x in 0..source_w {
            let light = (1.0 - ((x as f64 / source_w as f64 - 0.6).powi(2)
                + (y as f64 / source_h as f64 - 0.35).powi(2)) * 3.0).max(0.0);
            let stripe = if (x / 8 + y / 8) % 2 == 0 { 45.0 } else { 0.0 };
            if mode == "bright" { ppm.extend_from_slice(&[(210.0 + stripe) as u8; 3]); }
            else { ppm.extend_from_slice(&[(16.0 + light * 20.0 + stripe) as u8, (25.0 + light * 50.0 + stripe) as u8, (38.0 + light * 65.0 + stripe) as u8]); }
        } }
        std::fs::write(&input, ppm).unwrap();
        let pipe_path = format!("\\\\.\\pipe\\mjc-osc-render-{}-{}", std::process::id(), NEXT_SESSION_ID.fetch_add(1, Ordering::SeqCst));
        let args = vec!["--no-config".into(), "--load-scripts=no".into(), "--vo=gpu-next".into(),
            "--ao=null".into(), "--osc=no".into(), "--osd-level=0".into(), "--pause=yes".into(), "--volume-max=200".into(),
            "--keep-open=always".into(), "--image-display-duration=inf".into(),
            "--force-media-title=Fixture metadata title".into(),
            format!("--script={}", root.join("scripts/test-player-osc-render.lua").display()),
            format!("--glsl-shaders-append={}", root.join("src-tauri/resources/mpv/portable_config/shaders/mjc-glass.glsl").display()),
            format!("--log-file={}", dir.join(format!("render-{width}-{height}-{scale}-{mode}.log")).display()),
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
        let opts = command(json!(["get_property", "glsl-shader-opts"]));
        let bar_top = (1..=6).find_map(|i| {
            let read = |name: &str| opts[format!("mjc-glass/r{i}_{name}")].as_str().unwrap().parse::<f64>().unwrap();
            (read("w") == width as f64).then(|| read("y") as i32)
        }).expect("full-width controller glass surface");
        let white_pixels = dib[40 + (bar_top * width * 4) as usize..].chunks_exact(4).filter(|pixel|
            pixel[0] > 210 && pixel[1] > 210 && pixel[2] > 210).count();
        assert!(white_pixels > 100, "the icon controls and timeline must render in white");
        let sample = 40 + (((height - (6.0 * scale) as i32) * width + width / 2) * 4) as usize;
        let contrast = |pixels: &[u8]| *pixels.iter().max().unwrap() as i32 - *pixels.iter().min().unwrap() as i32;
        if mode == "bright" {
            assert!(*dib[sample..sample + 3].iter().max().unwrap() < 180, "bright SDR must retain readable contrast behind white controls");
        } else if mode != "letterbox" {
            assert!(contrast(&dib[sample..sample + 3]) > contrast(&background[sample..sample + 3]) / 4,
                "the underlying video's color must remain visible through the translucent bar");
        }
        assert!(opts["mjc-glass/surface_count"].as_str().unwrap().parse::<f64>().unwrap() > 0.0);
        // Compare the same ASS controls and blur with lensing removed. Opacity
        // changes alone cannot pass this test: real video pixels must move.
        let mut no_lens = opts.clone();
        no_lens["mjc-glass/displacement_scale"] = json!("0");
        command(json!(["set_property", "glsl-shader-opts", no_lens]));
        let lens_baseline = dir.join(format!("no-lens-{width}-{height}-{scale}-{mode}.png"));
        command(json!(["screenshot-to-file", lens_baseline.to_string_lossy(), "window"]));
        let no_lens_dib = screenshot::decode_dib(&lens_baseline).unwrap();
        let (edge_x, edge_top, edge_w) = if mode == "letterbox" {
            // The bar sits over black padding; test the menu bevel over actual
            // video pixels instead, using the exact OSC-published rectangle.
            let i = opts["mjc-glass/surface_count"].as_str().unwrap().parse::<f64>().unwrap() as i32;
            let value = |field: &str| opts[format!("mjc-glass/r{i}_{field}")].as_str().unwrap().parse::<f64>().unwrap() as i32;
            let menu_w = value("w");
            (value("x") + menu_w / 3, value("y"), menu_w / 3)
        } else { (width / 3, bar_top, width / 3) };
        // Sample the full 12-logical-pixel bevel, excluding its outer AA rim.
        // Checkerboard transitions can put the strongest channel separation
        // in the first two rows, especially over a letterboxed video's menu.
        let edge_y = edge_top + scale as i32;
        let edge_h = (11.0 * scale) as i32;
        let edge_difference = region_difference(&dib, &no_lens_dib, width, edge_x, edge_y, edge_w, edge_h);
        assert!(edge_difference > 0.5, "the glass bevel must refract the checkerboard: {edge_difference}, {width}x{height}, {scale}x");
        let center_y = if mode == "letterbox" { edge_top + (21.0 * scale) as i32 } else { height - (21.0 * scale) as i32 };
        assert!(region_difference(&dib, &no_lens_dib, width, edge_x, center_y, edge_w, (3.0 * scale) as i32) <= 1.0,
            "refraction must not warp the clear middle of the control bar");
        let mut no_aberration = opts.clone();
        no_aberration["mjc-glass/aberration_intensity"] = json!("0");
        command(json!(["set_property", "glsl-shader-opts", no_aberration]));
        command(json!(["screenshot-to-file", lens_baseline.to_string_lossy(), "window"]));
        let no_aberration_dib = screenshot::decode_dib(&lens_baseline).unwrap();
        let aberration_difference = region_difference(&dib, &no_aberration_dib, width, edge_x, edge_y, edge_w, edge_h);
        assert!(aberration_difference > 0.05,
            "chromatic aberration must use different channel sampling positions: {aberration_difference}, {mode}");
        command(json!(["set_property", "glsl-shader-opts", opts]));
        let capture = dir.join(format!("capture-{width}-{height}-{scale}-{mode}.png"));
        screenshot::capture_frame(&pipe_path, &capture, "subtitles").unwrap();
        let video_with_glass = screenshot::decode_dib(&capture).unwrap();
        let mut disabled = opts.clone();
        disabled["mjc-glass/surface_count"] = json!("0");
        command(json!(["set_property", "glsl-shader-opts", disabled]));
        std::thread::sleep(Duration::from_millis(80));
        let sharp = dir.join(format!("sharp-{width}-{height}-{scale}-{mode}.png"));
        command(json!(["screenshot-to-file", sharp.to_string_lossy(), "window"]));
        let sharp_dib = screenshot::decode_dib(&sharp).unwrap();
        // Isolate blur in a background-only test surface. Narrow control bars
        // have icons in the center; their sharp pixels must not be counted as
        // failed background blur, and the refractive bevel is deliberately sharp.
        let mut probe = opts.clone();
        probe["mjc-glass/surface_count"] = json!("1");
        probe["mjc-glass/displacement_scale"] = json!("0");
        probe["mjc-glass/aberration_intensity"] = json!("0");
        probe["mjc-glass/saturation"] = json!("1");
        probe["mjc-glass/r1_x"] = json!((width / 5).to_string());
        probe["mjc-glass/r1_y"] = json!((height / 3).to_string());
        probe["mjc-glass/r1_w"] = json!((width / 5).to_string());
        probe["mjc-glass/r1_h"] = json!((height / 4).to_string());
        for i in 2..=6 { probe[format!("mjc-glass/r{i}_w")] = json!("0"); }
        command(json!(["set_property", "glsl-shader-opts", probe]));
        let probe_file = dir.join(format!("blur-{width}-{height}-{scale}-{mode}.png"));
        command(json!(["screenshot-to-file", probe_file.to_string_lossy(), "window"]));
        let probe_dib = screenshot::decode_dib(&probe_file).unwrap();
        let patch_x = width * 3 / 10 - 12;
        let patch_y = height / 2;
        let soft_detail = horizontal_detail(&probe_dib, width, patch_x, patch_y, 24, 5);
        let sharp_detail = horizontal_detail(&sharp_dib, width, patch_x, patch_y, 24, 5);
        assert!(soft_detail < sharp_detail * 0.5, "real background blur must suppress checkerboard detail: {soft_detail} vs {sharp_detail}");
        let untouched = 40 + ((height / 2 * width + width / 4) * 4) as usize;
        for channel in 0..3 {
            assert!(dib[untouched + channel].abs_diff(sharp_dib[untouched + channel]) <= 1, "video outside the surfaces must stay sharp at {width}x{height}, {scale}x, {mode}");
        }
        probe["mjc-glass/surface_count"] = json!("0");
        command(json!(["set_property", "glsl-shader-opts", probe]));
        command(json!(["screenshot-to-file", capture.to_string_lossy(), "subtitles"]));
        let video_without_glass = screenshot::decode_dib(&capture).unwrap();
        assert!(video_with_glass[40..].iter().zip(&video_without_glass[40..]).all(|(a, b)| a.abs_diff(*b) <= 1),
            "saved video screenshots must not contain the glass backing");
        command(json!(["set_property", "glsl-shader-opts", opts]));
        // screenshot-to-file must also overwrite the empty file reserved by the
        // screenshot path/access check and produce a real pasteable image.
        std::fs::remove_file(&capture).unwrap();
        std::fs::OpenOptions::new().write(true).create_new(true).open(&capture).unwrap();
        screenshot::capture_frame(&pipe_path, &capture, "subtitles").unwrap();
        assert!(std::fs::metadata(&capture).unwrap().len() > 0);
        assert!(screenshot::decode_dib(&capture).is_ok());
        std::fs::remove_file(capture).unwrap();
        command(json!(["quit"]));
    }
}
