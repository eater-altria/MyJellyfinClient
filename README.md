# MyJellyfinClient

一个受 Apple Liquid Glass 风格启发的 Jellyfin / Emby Windows 客户端。使用 **Tauri 2 + React 18 + TypeScript + Tailwind CSS** 构建。

## 功能

- 🖥️ 液态玻璃界面：浮动侧栏、药丸工具栏与半透明面板，圆角边缘折射、轻微 RGB 色散和高光；浅色主题与背景图沉浸详情页，窄窗口自动使用图标导航
- 🎬 服务器主页：背景图轮播 Hero、我的媒体、继续观看、接下来、最新内容
- 📚 媒体库浏览：排序、分页加载
- 🔖 类型与风格、标签、收藏浏览及年份等组合筛选，服务器执行筛选；接近列表末尾自动加载下一批，返回保留已加载内容和滚动位置
- 🎞️ 详情页：封面上的独立 Logo 与信息卡内的文字标题、演职人员、季/集列表、类似作品、收藏/已看标记
- ▶️ **内嵌原生 mpv 播放器**：硬件解码（d3d11va 自动）、原生渲染嵌入主窗口、快进/快退秒数可配置、断点续播、播放进度上报服务器（浏览器 dev 环境回退到 HTML5 播放器）
- ⚙️ 完整设置页：通用 / 列表 / 播放 / 界面 / 手势 / 视频 / 音频 / 字幕 等 10 个标签页，8 色主题切换
- ⬆️ 手动检查更新：在「设置 → 通用 → 关于与更新」点击检查 GitHub 最新正式 Release，新版提供发布页入口，由用户下载并安装
- 🔍 搜索、🕘 播放记录

## Jellyfin / Emby 服务器

添加时输入服务器地址、用户名和密码即可，服务器类型自动识别，无需选择协议。程序先请求公共系统信息，优先读取产品标识，再兼容没有产品标识的版本信息；也会探测 `/emby`、`/jellyfin` 和旧版 `/mediabrowser` API 路径。支持带反向代理路径的地址和复制的 `/web/index.html` 地址。

识别结果和实际 API 地址会与登录令牌一起保存，服务器卡片和侧栏使用不同图标。原有未记录类型的服务器按 Jellyfin 加载。修改服务器地址或重新登录时会重新识别。

两种协议共用媒体库、电影/剧集详情、演职人员、搜索、收藏、观看记录和播放进度上报。原生 mpv 优先直接播放；需要转码时使用服务器返回的转码地址，外部字幕地址也会保留代理前缀。服务器在线探测继续每 30 秒执行一次。

「设置 → 通用」可分别调整 Jellyfin / Emby 的客户端名称、版本和设备名称；默认使用 RodelPlayer / 2.2610.12.0 / Windows PC 兼容标识，已手动设置的值保持不变。桌面 WebView 的 HTTP User-Agent 统一使用相同名称和版本，并附带实际 Windows 版本及架构。这里的客户端兼容版本与本应用的 Release 版本不同；mpv 媒体请求仍使用原有 User-Agent。

部分 Emby 服务按首次设备登记限制播放。若登录正常但播放被拒绝，可在「编辑服务器」显式选择「重新登记此服务器的登录设备」，填写服务端支持的客户端名称并重新输入密码。成功后仅该连接保存新的固定设备 ID 和名称；不会重置其他连接或全局设备身份，也不会借用其他应用的令牌。

首页轮播提供当前服务器的搜索入口。搜索页保留服务器范围、查询内容和失败重试，空状态不会产生多余的空白滚动。

兼容依据：[Emby 用户认证](https://dev.emby.media/doc/restapi/User-Authentication.html)、[播放信息 API](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html) 和[官方 JavaScript 客户端](https://github.com/MediaBrowser/Emby.ApiClient.Javascript)。本地协议检查：`npm run test:servers`。

## 内嵌播放器

应用内嵌 [mpv](https://mpv.io/)（shinchiro Windows 构建）作为播放内核：Rust 端在主窗口客户区创建 Win32 子窗口，mpv 通过 `--wid` 嵌入渲染，JSON IPC（命名管道）下发操作并回传播放位置。点击标题栏关闭按钮退出播放；Esc 优先关闭媒体信息或菜单，再退出播放。回车或 F 切换全屏，空格播放/暂停；暂停时其他操作保持可用，空格不会重新显示控制栏。双击画面播放/暂停，鼠标操作可在设置中调整。

加载期间也可退出并取消请求。原生播放器使用 Windows 信任证书校验 HTTPS，支持音轨字幕偏好、截图、响应式控制栏，以及适应窗口/裁切填充。

「设置 → 播放 → 缓存」可调整 1–8192 MB 的前向预读缓存上限，默认 150 MB，下次开始原生播放时生效；浏览器中禁用。

控制栏进度条使用三种白色深浅区分已播放、真实已缓存范围与未缓存区域；跳转后按实际缓存段更新，保留分段缓存之间的空白。桌面与浏览器播放器均支持。

播放失败页面显示诊断编号和日志路径。分阶段诊断关联元数据、播放协商、mpv 启动、HTTP 错误和 IPC，写入前脱敏 URL、密码和令牌，并采用非阻塞队列与约 2 MiB 的两份日志轮转。开发版路径为 `.local/webview2/logs/playback.log`，安装版使用应用本地数据目录的 `logs`；无需清空账号数据来收集日志。

播放器标题使用媒体元数据；原生控制栏和菜单采用半透明玻璃背景，包含实时背景模糊、边缘折射及轻微色散，配合白色图标及悬浮文字提示，默认静止 3 秒后隐藏。窗口在视频尺寸可用时按完整视频的显示比例自适应，保留视频内的黑边，不自动裁切。Alt+Tab 返回应用后可直接使用空格、回车。截图保存清晰视频画面；优先使用系统图片目录的 `MyJellyfinClient` 文件夹，不可写时使用应用本地数据目录；开发版使用开发数据目录下的 `screenshots`，保存成功会显示实际路径。

mpv 二进制（解压后约 120MB，不提交 Git）放置在 `src-tauri/resources/mpv/`。开发与打包脚本在 EXE、COM 或 DLL 缺失或为空时，会自动从 [mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases) 的最新 Release 下载普通 x86_64 构建，校验包大小和 SHA-256，再使用 Windows 自带的 `tar.exe` 解压并安装完整的同版本二进制。已有完整资源时直接使用，不联网或自动升级。仅安装 `mpv.exe`、`mpv.com` 和全部随附 DLL，保留仓库中的 `portable_config/scripts/mjc-osc.lua` 和 `portable_config/shaders/mjc-glass.glsl`。

也可单独运行 `./scripts/ensure-mpv.ps1` 准备播放器。自动下载需要访问 GitHub，以及 Windows 自带的 `curl.exe` 和 `tar.exe`；下载或校验失败会停止后续启动/打包，并给出重试与手动准备提示。下载与解压临时文件位于 `.tmp/`，完成或失败后清理，不接触 `.local/` 开发数据。离线时可以手动下载 x86_64 包并将同一套二进制放入上述目录。

如果本机已有可信的 MyJellyfinClient 安装版，也可从安装目录的 `mpv/` 复制同一套 `mpv.exe`、`mpv.com` 和全部 DLL 到上述开发目录，仅复制这些二进制，保留仓库中的控制脚本和 shader。开发与打包脚本会先检查运行资源；出现 `Required runtime files are missing or empty` 时按提示补齐文件。如果直接运行 Cargo 或 Tauri 时出现 `glob pattern resources/mpv/*.exe path not found`，同样表示缺少本地 mpv 文件。

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
scripts\build-portable.ps1  # 在安装包构建后生成单 EXE 便携版 (bundle/portable/)
```

开发脚本使用全局 Cargo，不再携带工作区 Rust 工具链。开发账号和设置保存在 `.local/webview2/`（不提交 Git）；安装版使用系统应用数据目录。`node_modules/`、`dist/`、`src-tauri/target/` 和 TypeScript 增量缓存均可重新生成。mpv 二进制保留在 `src-tauri/resources/mpv/`，控制脚本 `portable_config/scripts/mjc-osc.lua` 属于应用源码。

Vite 不监听 `.local/`，避免 WebView2 锁定 Cookie 等数据文件时出现 `EBUSY`。这类监听错误应检查排除规则，不要删除账号和设置数据。

构建脚本先处理 mpv 运行资源签名，再由 Tauri 在打包过程中签名应用程序、卸载程序和安装包。签名只使用已有的本机开发证书，未找到时跳过；不会自动安装证书。开发证书不等同于公开受信任的商业代码签名证书。

Release 提供 `x64-setup.exe` 安装包和 `x64-portable.exe` 单文件便携版。便携版无需安装或管理员权限，启动时将主程序、mpv、DLL、控制脚本和 shader 解包到独立临时目录，退出后清理。账号、设置、截图和播放诊断保存在 EXE 旁的 `MyJellyfinClient-data/`，移动到其他位置时应携带该目录；不能把这份用户数据当作临时缓存删除。请放在可写目录中运行。

便携版需要系统已有 [Microsoft Edge WebView2 Runtime](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)，不会安装运行时或修改系统配置；缺少 WebView2 时可使用常规安装包。单文件封装使用 [NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html) 的临时解包与等待进程退出机制，并非将 mpv 静态链接进主程序。两种包均不包含 `.local/` 账号、开发日志或播放器缓存。

## 验证

```powershell
npm run build
npm run test:servers
npm run test:playback
npm run test:settings
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/test-mpv-setup.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/test-portable.ps1
cargo test --manifest-path src-tauri/Cargo.toml --lib
& ./src-tauri/resources/mpv/mpv.com --no-config --vo=null --idle=yes --script=scripts/test-player-osc.lua
```

原生测试需要按上述步骤准备 mpv。

## 说明

- 「文件」「IPTV」「弹幕」为占位页，后续版本实现。
- 服务器账号凭据保存在 WebView localStorage 中。
