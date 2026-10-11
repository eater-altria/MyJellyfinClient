# Shell 运行与打包

入口使用 Bash，兼容 macOS 自带的 Bash 3.2，可从任意目录调用。Windows Git Bash 继续复用现有 PowerShell 流程；macOS 已接入主项目的媒体库与原生 libmpv 播放。

## macOS 桌面版

需要 Node.js 20+、npm、本机 stable Rust、Xcode Command Line Tools、`pkg-config` 和 libmpv：

```bash
brew install mpv pkg-config
./scripts/check-runtime.sh
./scripts/dev-tauri.sh --desktop
./scripts/build-tauri.sh --desktop
```

macOS 上省略模式默认选择桌面版。脚本只为本次进程设置 `RUSTUP_TOOLCHAIN=stable`，保留仓库的 Windows 工具链文件。前端工具缺少时自动执行 `npm ci`，缓存放在 `.npm-cache/`；锁文件更新后应手动重新执行 `npm ci --cache .npm-cache`。

播放共用现有 `NativePlayer` 的服务器协商、续播和进度上报，Mac 在 Cocoa/CGL 视图中运行 libmpv OpenGL render API；复用 Lua OSC 与 GPU 玻璃 shader。不带独立原型的「打开视频 / OpenGL 渲染」工具区，只保留现有媒体标题栏和播放控件。

输出：

- `src-tauri/target/release/bundle/macos/MyJellyfinClient.app`
- `src-tauri/target/release/bundle/dmg/MyJellyfinClient_<版本>_aarch64.dmg`（Apple Silicon；Intel 本机构建命名不同）

打包把已安装 libmpv 的完整 Mach-O 依赖图复制到 `.tmp/macos-runtime/`，只修改副本的相对加载路径和本地 ad-hoc 签名，应用中收录库、Lua 和 shader。无需目标机器安装 Homebrew；不打包账号、日志或开发缓存。
最低系统版本依据所有依赖的 `minos` 计算，至少 14.0；**当前本机 Tahoe bottle 要求 macOS 26.0**。不能把该产物当作 macOS 14 的安装包。当前实际验证为 Apple Silicon M4，不支持用单套本机库自动生成 Universal 包，Intel Mac 尚未实测。

Mac 包默认使用本地 ad-hoc 签名，并在此配置关闭应用的 Hardened Runtime，避免无 Team ID 的 libmpv 被库校验拒绝；不修改系统安全设置，不安装证书、不做 Developer ID 公证或发布。Release 的库搜索路径只指向包内资源，debug 才使用工作区动态库。构建后运行 `node scripts/test-macos-bundle.cjs` 验证实际签名包启动；使用非持久化 WebView 和临时诊断目录，不读取真实账号。DMG 默认采用 CI 模式跳过 Finder 美化 AppleScript，避免要求系统 Automation 权限，仍含应用与 Applications 快捷入口。可用 `CI=false` 显式选择 Tauri 的普通 DMG 生成方式；不要为构建自动修改系统权限。

Mac 当前为 SDR sRGB/BT.709 输出，设置页禁用 HDR 字幕亮度调节。GPU 玻璃与硬解已经验证，不代表 gpu-next、Metal、HDR/EDR 或杜比视界输出已经迁移。

WKWebView 的开发版使用固定独立 data store identifier，账号与安装版分开。Mac 的 `MJC_WEBVIEW_DATA` 仅指定日志和截图目录，开发默认 `.local/macos/`，不能用它指定 WKWebView 账号目录。

## 验证与模拟服务器

```bash
./scripts/test-macos-native.sh
RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run typecheck
npm run test:playback
npm run test:settings
```

原生回归使用合成 4K 10-bit HEVC、真实 WKWebView 和生产 Cocoa/libmpv bridge，验证 GPU 玻璃、OSC 几何、截图、缩放和销毁。播放与设置的浏览器回归可通过 `MJC_TEST_CHROMIUM` 指定可信 Chrome/Chromium 路径；测试使用独立 profile，勿指向用户 profile。

端到端演示可先生成独立原型的合成媒体，然后启动本地 fixture：

```bash
./scripts/prototype-macos-mpv.sh --self-test-hevc
node scripts/macos-fixture-server.cjs
# 另一个终端：显式临时 WKWebView 会话，日志/截图也隔离
MJC_NATIVE_TEST_MODE=1 MJC_WEBVIEW_DATA="$PWD/.tmp/macos-integration-data" ./scripts/dev-tauri.sh --desktop
```

在测试会话内添加 `http://127.0.0.1:5199`，用户名/密码均填 `fixture`，进入合成媒体详情播放。它不是真实服务器。`MJC_NATIVE_TEST_MODE=1` 只在显式测试时启用不持久化 WKWebView；正常运行不设这个变量。测试不会读写真实账号，重启后临时连接不保留。
独立原型仍可用于单独对比玻璃效果，见 `prototypes/macos-libmpv/README.md`；它与当前媒体库应用不是同一个入口。

## Web 模式与 Linux

Web 模式需要 Node.js 20+ 和 npm，打包另需 `tar`，不需要 Rust 或 mpv。

```bash
./scripts/check-runtime.sh --web
./scripts/dev-tauri.sh --web
./scripts/build-tauri.sh --web
./node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strictPort
```

开发地址为 `http://127.0.0.1:5173`，Ctrl+C 停止；剩余开发参数传给 Vite，例如 `--web -- --port 5180`。
生产资源在 `dist/`，压缩包与 SHA-256 在 `.tmp/web-packages/`。解压后通过 HTTP 服务访问，不直接双击 `index.html`。
Web 使用现有 HTML5/HLS 回退播放器，支持编码由浏览器决定，服务器需允许跨域；账号位于当前浏览器源的本地存储。
Linux 默认选择 Web，当前没有 Linux 原生播放后端。

## Windows Git Bash

需要原项目的 Node.js 20+、Rust MSVC、Visual Studio C++ Build Tools、Windows SDK、Windows PowerShell 和 Git Bash（含 `cygpath`）：

```bash
./scripts/ensure-mpv.sh
./scripts/check-runtime.sh
./scripts/dev-tauri.sh --desktop
./scripts/build-tauri.sh --desktop
./scripts/build-portable.sh
```

Windows 上默认选择桌面版；参数以数组调用对应 `.ps1`，保留下载/资源校验、签名、MSVC 环境及失败退出行为。PowerShell 路径参数使用 Windows 路径。NSIS 与便携输出仍在 `bundle/nsis/`、`bundle/portable/`。
Mac 的 `ensure-mpv.sh` 收集已安装 libmpv，Windows 则通过原 `ensure-mpv.ps1` 下载播放器；不自动运行 `brew install` 或安装证书。
所有入口支持 `--help`。可在 Bash 中 `source ./scripts/env.sh`，zsh 用户直接运行入口即可。
