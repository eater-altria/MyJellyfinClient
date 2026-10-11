fn main() {
    #[cfg(target_os = "macos")]
    {
        // Compile only on macOS. Windows keeps the existing external mpv path.
        let mpv = pkg_config::Config::new().cargo_metadata(false).probe("mpv")
            .expect("libmpv development files are required: brew install mpv");
        let mut build = cc::Build::new();
        build.file("src/player_macos.m").flag("-fobjc-arc").flag("-Wno-deprecated-declarations");
        for include in &mpv.include_paths { build.include(include); }
        build.compile("mjc_macos_player");
        let staged = std::path::Path::new("../.tmp/macos-runtime").canonicalize();
        if let Ok(staged) = staged {
            println!("cargo:rustc-link-search=native={}", staged.display());
            // Development binaries run outside the bundle. Release packages
            // must load their own libraries, never a workspace staging copy.
            if std::env::var("PROFILE").as_deref() == Ok("debug") {
                println!("cargo:rustc-link-arg=-Wl,-rpath,{}", staged.display());
            }
        } else {
            for path in mpv.link_paths { println!("cargo:rustc-link-search=native={}", path.display()); }
        }
        println!("cargo:rustc-link-lib=mpv");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=OpenGL");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources/mpv/lib");
        println!("cargo:rerun-if-changed=src/player_macos.m");
        println!("cargo:rerun-if-changed=../.tmp/macos-runtime/libmpv.2.dylib");
    }
    tauri_build::build()
}
