# MyJellyfinClient

一个 SenPlayer 风格的 Jellyfin / Emby Windows 客户端。使用 **Tauri 2 + React 18 + TypeScript + Tailwind CSS** 构建。

## 功能

- 🖥️ SenPlayer 风格界面：左侧导航（文件 / 服务器 / IPTV / 记录 / 搜索 / 设置）、圆角卡片、浅色主题、背景图渐变沉浸页
- 🎬 服务器主页：背景图轮播 Hero、我的媒体、继续观看、接下来、最新内容
- 📚 媒体库浏览：排序、分页加载
- 🎞️ 详情页：Logo 标题、演职人员、季/集列表、类似作品、收藏/已看标记
- ▶️ **内嵌原生 mpv 播放器**：硬件解码（d3d11va 自动）、原生渲染嵌入主窗口、快进/快退秒数可配置、断点续播、播放进度上报服务器（浏览器 dev 环境回退到 HTML5 播放器）
- ⚙️ 完整设置页：通用 / 列表 / 播放 / 界面 / 手势 / 视频 / 音频 / 字幕 等 10 个标签页，8 色主题切换
- 🔍 搜索、🕘 播放记录

## Jellyfin / Emby 服务器

添加时输入服务器地址、用户名和密码即可，服务器类型自动识别，无需选择协议。程序先请求公共系统信息，优先读取产品标识，再兼容没有产品标识的版本信息；也会探测 `/emby`、`/jellyfin` 和旧版 `/mediabrowser` API 路径。支持带反向代理路径的地址和复制的 `/web/index.html` 地址。

识别结果和实际 API 地址会与登录令牌一起保存，服务器卡片和侧栏使用不同图标。原有未记录类型的服务器按 Jellyfin 加载。修改服务器地址或重新登录时会重新识别。

两种协议共用媒体库、电影/剧集详情、演职人员、搜索、收藏、观看记录和播放进度上报。原生 mpv 优先直接播放；需要转码时使用服务器返回的转码地址，外部字幕地址也会保留代理前缀。服务器在线探测继续每 30 秒执行一次。

兼容依据：[Emby 用户认证](https://dev.emby.media/doc/restapi/User-Authentication.html)、[播放信息 API](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html) 和[官方 JavaScript 客户端](https://github.com/MediaBrowser/Emby.ApiClient.Javascript)。本地协议检查：`npm run test:servers`。

## 内嵌播放器

应用内嵌 [mpv](https://mpv.io/)（shinchiro Windows 构建）作为播放内核：Rust 端在主窗口客户区创建 Win32 子窗口，mpv 通过 `--wid` 嵌入渲染，JSON IPC（命名管道）下发操作并回传播放位置。点击标题栏关闭按钮退出播放；Esc 优先关闭媒体信息或菜单，再退出播放。回车或 F 切换全屏，空格播放/暂停，K 锁定/解锁控制，鼠标操作可在设置中调整。

加载期间也可退出并取消请求。原生播放器使用 Windows 信任证书校验 HTTPS，支持音轨字幕偏好、截图、响应式控制栏，以及适应窗口/裁切填充。

mpv 二进制（约 120MB，不提交 Git）需放置在 `src-tauri/resources/mpv/`。从 [mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases) 下载 x86_64 构建，将 `mpv.exe`、`mpv.com` 和包内随附 DLL 放入该目录，保留仓库自带的 `portable_config/scripts/mjc-osc.lua`。

## 开发

需要：Node.js 20+、全局安装的 Rust/Cargo（Windows MSVC 工具链），以及 Visual Studio C++ Build Tools 和 Windows SDK。

```bash
npm ci
scripts\dev-tauri.ps1   # 启动 vite + tauri dev（沙箱环境可加 $env:MJC_WEBVIEW_DATA 指向可写目录）
npm run dev:web         # 仅浏览器中调试前端 (http://localhost:5173，回退 HTML5 播放器)
```

## 构建

```bash
scripts\build-tauri.ps1  # 产出 NSIS 安装包 (src-tauri/target/release/bundle/)
```

开发脚本使用全局 Cargo，不再携带工作区 Rust 工具链。开发账号和设置保存在 `.local/webview2/`（不提交 Git）；安装版使用系统应用数据目录。`node_modules/`、`dist/`、`src-tauri/target/` 和 TypeScript 增量缓存均可重新生成。mpv 二进制保留在 `src-tauri/resources/mpv/`，控制脚本 `portable_config/scripts/mjc-osc.lua` 属于应用源码。

## 验证

```powershell
npm run build
npm run test:servers
npm run test:playback
npm run test:settings
cargo test --manifest-path src-tauri/Cargo.toml --lib
& ./src-tauri/resources/mpv/mpv.com --no-config --vo=null --idle=yes --script=scripts/test-player-osc.lua
```

原生测试需要按上述步骤准备 mpv。

## 说明

- 「文件」「IPTV」「弹幕」为占位页，后续版本实现。
- 服务器账号凭据保存在 WebView localStorage 中。
