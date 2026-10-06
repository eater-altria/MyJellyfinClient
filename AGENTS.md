# MyJellyfinClient：后续 AI 维护指南

## 使用规则

开始处理本仓库的任务前，完整阅读本文件。这里包含项目结构、开发命令、回归测试和需要保留的行为约定。

以用户当前指令和实际代码为准；如果指南与代码不一致，先核对并在完成相关修改后更新指南。不要把此文件当作推送、发布 Release、安装证书或修改系统设置的额外授权。

## 项目定位

这是一个 Windows x64 Jellyfin / Emby 桌面客户端，界面主要为中文，采用 SenPlayer 风格。前端使用 React 18、TypeScript、Vite、Tailwind CSS、Zustand 和 React Router；桌面壳使用 Tauri 2，原生播放使用独立 mpv 进程。

公开仓库：<https://github.com/eater-altria/MyJellyfinClient>。仓库源码、GitHub Release 和用户正在运行的安装版可能不是同一版本，排查前应核对提交和安装包来源。

目前「文件」页面的本地文件功能、IPTV 和弹幕仍有占位内容。不要把现有占位功能描述为已实现。

## 从哪里开始读

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/main.tsx` | 路由、桌面/浏览器播放器选择、主题初始化 |
| `src/api/mediaServer.ts` | Jellyfin/Emby 共用 API、媒体类型、URL 解析、查询及分页 |
| `src/api/detectServer.ts` | 服务器产品识别及 API 路径探测 |
| `src/store/servers.ts` | 服务器登录状态、令牌、API 实例和持久化 |
| `src/store/settings.ts`、`src/pages/Settings.tsx` | 设置定义、默认值、持久化和设置界面 |
| `src/pages/Home.tsx`、`src/pages/Library.tsx` | 首页分类、最新内容、媒体库、合集和分页 |
| `src/utils/listPresentation.ts` | 列表元信息、预览图片、HDR/分辨率、文件夹排序 |
| `src/components/PosterCard.tsx`、`EpisodeRow.tsx`、`SectionRow.tsx` | 共享卡片、剧集行、横向列表 |
| `src/pages/NativePlayer.tsx` | 原生播放启动、事件订阅、进度上报和退出协调 |
| `src/pages/Player.tsx` | 浏览器 HTML5/HLS 播放回退 |
| `src/player/` | 播放偏好记忆、相邻媒体、键盘操作及退出事件 |
| `src/components/TitleBar.tsx`、`WindowResizeHandles.tsx` | 窗口标题栏和边缘缩放 |
| `src/platform/window.ts` | Tauri 窗口 API 包装 |
| `src-tauri/src/lib.rs` | 窗口创建、Tauri 命令注册和窗口事件 |
| `src-tauri/src/player.rs` | Win32 mpv 宿主窗口、进程、IPC、光标、窗口比例和 TLS |
| `src-tauri/src/player_screenshot.rs` | 截图及 Windows 图片剪贴板 |
| `src-tauri/src/player_framing.rs` | 保守黑边检测和真实渲染回归 |
| `src-tauri/resources/mpv/portable_config/scripts/mjc-osc.lua` | 原生播放控件的 ASS 绘制、菜单和输入 |

`src/api/jellyfin.ts` 是旧模块名的兼容导出，新代码优先使用 `mediaServer.ts`。

## 环境与启动

需要 Node.js 20+、全局 Rust/rustup/Cargo、Visual Studio C++ Build Tools、Windows SDK，以及本地 mpv。`rust-toolchain.toml` 指定 `stable-x86_64-pc-windows-msvc`；本项目不再携带 `.toolchain`，也不依赖旧的 GNU LLVM/MinGW 工具链。

```powershell
npm ci
. ./scripts/env.ps1
rustc -vV
./scripts/dev-tauri.ps1
```

仅调试前端：`npm run dev:web`。浏览器回退播放器无法替代原生 mpv 的验证，原生窗口、HDR、截图剪贴板等行为必须在桌面环境核对。

`scripts/env.ps1` 为项目进程选择 MSVC，处理旧工作区的 `CARGO_HOME`、`RUSTUP_HOME` 和 GNU 目标覆盖，并配置开发数据目录。如果提示找不到 `x86_64-w64-mingw32-clang`，先检查 `rustup show`、`rustc -vV`、终端环境变量和覆盖配置；不要为了旧配置重新把完整工具链放回仓库。

PowerShell 脚本需兼容 Windows PowerShell 5.1。无 BOM 的 UTF-8 中文可能被按本地编码误读；当前 `.ps1` 使用 ASCII 文本。新增中文时应使用兼容编码并实际验证解析。对确认可信的下载脚本可使用 `Unblock-File` 清除来源标记，不应为此修改系统范围的执行策略。

准备 `src-tauri/resources/mpv/mpv.exe`、`mpv.com` 及构建包随附 DLL，保留仓库自带的 `mjc-osc.lua`。这些二进制被 Git 忽略，克隆仓库后需自行准备；控制脚本是源码，必须提交。下载来源见 README。

## 数据与清理

- 开发脚本默认把 WebView2 数据保存在 `.local/webview2`；可通过 `MJC_WEBVIEW_DATA` 覆盖。安装版默认使用系统应用数据目录。
- `.local` 包含开发账号、登录状态、设置和偏好，删除会重置开发版数据。它不是纯构建缓存。
- `.local`、`.codex-remote-attachments`、环境文件、密钥、日志、构建产物及 mpv 二进制不应提交。不要把用户提供的服务器地址、密码、令牌或截图写入源码和测试。
- `node_modules`、`dist`、`src-tauri/target`、`src-tauri/gen`、`*.tsbuildinfo` 可重新生成。清理前先区分持久数据、运行资源和可再生产物；递归操作应验证绝对路径范围。
- 必要运行资源包括 mpv、其控制脚本和 `src-tauri/resources/WebView2Loader.dll`，不能按普通临时文件删除。

## 媒体库与协议约定

1. 所有服务器返回的分类都应能展示，不要恢复 `views.slice(0, 3)` 一类分类上限。
2. 首页和媒体库用批次分页加载，批次大小不是总数上限。继续观看、接下来也支持继续加载。保留总数、下一偏移、并发防重、取消和迟到响应保护。
3. `CollectionType=boxsets` 的列表查询必须包含 `BoxSet`。具体合集 `Type=BoxSet` 应打开成员媒体列表，不能直接按电影播放。类型规则集中在 `libraryItemTypes`，不要各页面另写不一致的过滤条件。
4. `mixed` 混合库和 `boxsets` 合集库都可能显示为「合集」，应按服务端类型判断，不能根据中文名称推断。
5. 不要仅因「最新媒体」接口返回空数组就判断合集没有数据。分页的分类查询使用 `getLibraryItems` / `queryItems`，合集不是普通视频项目。
6. 分类加载失败、空数据和仍在加载应能区分，并提供重试。不要吞掉错误后隐藏整个分类。
7. 保留反向代理前缀、服务器协议差异、已有鉴权参数和媒体源的必要 HTTP 头。不要把本站令牌无条件追加到外部 URL。
8. 章节预览使用服务器已有章节图片；缺少图片时回退到服务器封面，不为列表下载完整视频。索引图片使用兼容两种协议的路径形式。
9. 取消数量上限不意味着一次渲染/下载全部轮播背景；当前轮播按需挂载临近图片，全部已加载项目仍可导航。

## 播放器不能退化的行为

### 退出与生命周期

- 标题栏关闭按钮在播放页表示退出播放、回到上一页，不是关闭整个应用；其他页面的关闭按钮仍关闭窗口。
- 播放页不单独显示「退出播放」/返回按钮。Esc 优先关闭搜索、媒体信息或菜单；无浮层时才退出播放。
- WebView 获得焦点后的 Esc，也必须经 `player_escape` 交给原生控件处理浮层；加载尚未完成时仍应能立即取消退出。
- 网络慢或正在协商媒体源时，关闭必须取消请求；迟到回调不能重新启动播放或把用户导航回播放器。
- mpv 宿主窗口在媒体就绪前保持隐藏，让客户端窗口控件可用。初始/失败退出的零位置不能覆盖服务器的续播位置。
- 保留 `StartupGuard` 的启动失败回滚、正常停止清理和唯一的每次播放 IPC 名称；截图等异步任务不能串入下一次播放。

### 原生窗口与 IPC

- mpv 通过 `--wid` 渲染到 Win32 子窗口。子窗口应为 React 标题栏预留 36 个逻辑像素，全屏时恢复完整视频区域。
- 窗口比例计算应排除标题栏；最小化、最大化、全屏和还原不能互相破坏。窗口关闭时需清理 mpv。
- 鼠标、键盘和光标命中区域来自原生控件；隐藏、锁定和模态遮挡的控件不能留下可点击提示。
- Win32 回调不能直接做阻塞管道读写。命令写入和事件读取使用独立 IPC 连接；同步句柄克隆不能替代独立连接。
- 创建、销毁和修改宿主窗口时注意所属 UI 线程。现有进程启动兼容逻辑也有实际用途，修改后验证真实 mpv 启动。

### UI、设置、TLS 与缩放

- 控件字号和点击尺寸跟随 Windows DPI，不随窗口高宽整体缩小。小窗口通过分行、折叠到「更多」和菜单滚动适配。
- ASS 行级对齐标签不要重复或冲突：文字应使用对应 `an7/an8/an9`，矢量绘制明确使用 `an7`。视觉位置与点击区域要同步。
- 新设置必须接通保存、读取、执行和平台适用范围；不能只有设置页开关。浏览器不能实现的桌面设置应明确标注。
- 简繁字幕偏好不能只靠通用中文语言码；轨道记忆在同媒体源优先 ID，跨媒体源按语言、名称等元数据匹配。
- 外挂字幕规则只过滤真正的外部字幕，不应误删服务器提取出的内嵌字幕。
- mpv 的 HTTPS 使用只读导出的 Windows 信任根证书，保留 TLS 校验；不要用关闭校验来掩盖证书配置问题。
- 「适应窗口」保持有效画面的比例；「裁切填充」应完整铺满，不能恢复旧的 `panscan=0.4`。黑边检测需保守，不能把黑场或标题卡裁掉。

## 验证命令

按修改范围选择相应检查，功能变更增加能复现问题的回归，避免只检查字段是否出现在源码中。

```powershell
npm run typecheck
npm run build
npm run test:home
npm run test:servers
npm run test:settings
npm run test:playback

. ./scripts/env.ps1
cargo test --manifest-path src-tauri/Cargo.toml --lib
& ./src-tauri/resources/mpv/mpv.com --no-config --vo=null --idle=yes --script=scripts/test-player-osc.lua
```

`test:home` 覆盖全部分类、8 个合集、成员浏览、多页加载、重试和取消；`test:servers` 使用本地 HTTP fixture；`test:playback` 覆盖关闭及慢网络生命周期；`test:settings` 覆盖真实组件和偏好。Rust/Lua 测试覆盖原生输入、TLS、截图、渲染、响应式控件等，需本地 mpv 和 Windows 环境。

若受限执行环境无法读取构建工具目录或系统临时目录，应区分权限问题和代码问题。必要时为本次验证指定可写的临时目录，不能据此改坏用户正常构建配置；不要在敏感输出中打印令牌。

## 提交与发布

- 工作前检查 `git status`、相关文件和当前用户修改。保留无关变更，不使用强制重置来制造干净工作区。
- 提交前检查差异、相关测试、忽略规则和私密数据。提交、推送和 Release 按用户授权执行；成功必须以远程实际状态验证，网络失败不能报告已推送。
- 当前仓库使用本地 `gh`。Git TLS 握手失败时可重试或检查连接，不要关闭证书校验。
- 打包使用 `./scripts/build-tauri.ps1`；默认 x64 MSVC 的 NSIS 输出在 `src-tauri/target/release/bundle/nsis/`。
- `scripts/sign.ps1` 可使用已有本机开发证书，但这不等于所有用户机器都信任它。`make-dev-cert.ps1` 会修改证书库，不应作为普通构建步骤自动运行。
- 发布前核对源码提交、版本、程序架构、包内 mpv/控制脚本和附件 SHA-256。版本定义位于 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，Cargo 锁文件中的本项目版本也需一致。
- Release 是构建快照；推送源码不会自动更新已发布安装包。不要擅自覆盖已有标签或资产；发布完成后验证公开状态、附件上传状态、大小和校验值。

## 维护这份指南

改变构建入口、关键接口、数据路径或产品行为时同步更新本文件。记录经过验证的约定，不记录用户账号、临时环境绝对路径和对话中的未经确认猜测。用户当轮要求与实际代码优先于过时的指南。
