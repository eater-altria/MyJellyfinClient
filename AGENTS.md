# MyJellyfinClient：后续 AI 维护指南

## 使用规则

开始处理本仓库的任务前，完整阅读本文件。这里包含项目结构、开发命令、回归测试和需要保留的行为约定。

涉及界面、交互或代码风格时，同时阅读 [DESIGN.md](DESIGN.md)，其中详述设计美学、产品哲学、交互与播放器布局，以及分层编码和验证规范。

以用户当前指令和实际代码为准；如果指南与代码不一致，先核对并在完成相关修改后更新指南。不要把此文件当作推送、发布 Release、安装证书或修改系统设置的额外授权。

## 项目定位

这是一个 Windows x64 / macOS Jellyfin / Emby 桌面客户端，界面主要为中文，采用受 Apple Liquid Glass 启发的玻璃表面与浮动导航。前端使用 React 18、TypeScript、Vite、Tailwind CSS、Zustand 和 React Router；桌面壳使用 Tauri 2；Windows 原生播放使用独立 mpv 进程，macOS 使用同进程 libmpv OpenGL render API。macOS 当前为 SDR 输出，不能描述为已实现 Windows 的 HDR/gpu-next 行为。

macOS 的媒体库接入、内嵌播放与 GPU 玻璃控件已完成验收，当前实测平台为 Apple Silicon M4。后续维护应沿用主应用播放入口；`prototypes/macos-libmpv/` 仅用于独立渲染实验。HDR/EDR 输出、Intel Mac 和 Universal 包不属于已验证范围。

公开仓库：<https://github.com/eater-altria/MyJellyfinClient>。仓库源码、GitHub Release 和用户正在运行的安装版可能不是同一版本，排查前应核对提交和安装包来源。

目前「文件」页面的本地文件功能和 IPTV 仍有占位内容。弹幕已经接通服务器插件、自定义兼容 API 与当前播放的 XML 导入。不要把其余占位功能描述为已实现。

## 从哪里开始读

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/main.tsx` | 路由、桌面/浏览器播放器选择、主题初始化 |
| `src/api/mediaServer.ts` | 稳定 API 入口、连接器工厂及旧构造调用兼容导出 |
| `src/api/connectors/index.ts`、`types.ts` | 连接器注册表、由注册键派生的协议类型、连接器及媒体 API 契约 |
| `src/api/connectors/jellyfin.ts`、`emby.ts` | 各自的鉴权方式、产品识别、API 别名、筛选接口与播放协商差异 |
| `src/api/connectors/MediaBrowserApi.ts`、`mediaBrowserDiscovery.ts`、`mediaBrowserAuth.ts` | 两种相关协议共用的 REST、公开探测、URL 与设备鉴权实现；其他后端可独立实现契约 |
| `src/api/types.ts`、`helpers.ts` | 页面使用的统一媒体模型、列表规则、URL 规范化、错误及格式化 |
| `src/api/detectServer.ts` | 按连接器调度公开探测；同一探测函数合并执行，手动协议保持优先 |
| `src/platform/mediaServerRequest.ts`、`src-tauri/src/media_server_http.rs` | 桌面媒体 API 的原生 HTTP、共享 UA、系统 TLS、取消和重定向边界；浏览器保留 fetch |
| `src/utils/clientIdentity.ts`、`src/utils/defaultClientIdentity.json` | 客户端名称预设、共享兼容默认标识和文本规范化；设备 ID 仍由 API 使用原有持久值 |
| `src-tauri/src/client_identity.rs` | 桌面 WebView 的真实 HTTP User-Agent、共享兼容版本、Windows 实际版本查询与 macOS 平台/架构 |
| `src/store/servers.ts` | 服务器登录状态、令牌、API 实例和持久化 |
| `src/components/ServerSync.tsx`、`src/sync/serverSync.ts`、`src/platform/webdav.ts`、`src-tauri/src/webdav_http.rs` | WebDAV 加密服务器会话同步、字段白名单、导入事务及独立传输 |
| `src/hooks/useServerReorder.ts`、`src/store/serverReorder.ts`、`src/components/ServerReorderFeedback.tsx` | 两处服务器排序的指针/键盘操作、临时拖拽状态、跟随预览及插入位置 |
| `src/store/settings.ts`、`src/pages/Settings.tsx` | 设置定义、默认值、持久化和设置界面 |
| `src/components/UpdateCheck.tsx`、`src/api/appUpdates.ts`、`src/platform/appUpdates.ts`、`src-tauri/src/app_updates.rs` | 手动检查 GitHub 正式 Release、版本比较和固定发布页的系统浏览器入口 |
| `src/store/libraryPreferences.ts`、`src/utils/librarySort.ts`、`src/components/LibrarySortMenu.tsx` | 媒体库排序字段、独立升降序、按服务器/账号/媒体库持久化及排序菜单 |
| `src/components/BrowsePageHost.tsx`、`src/hooks/useBrowseActivity.ts`、`src/utils/browseHistory.ts` | 全部路由类型的页面实例保留、滚动位置恢复、活动状态及用户数据变更通知 |
| `src/components/LibraryFilterDialog.tsx`、`src/utils/libraryFilters.ts`、`src/hooks/useAutoPagination.ts` | 媒体库分类/收藏入口、服务器筛选、URL 条件和可取消的自动分页 |
| `src/pages/Home.tsx`、`src/pages/Library.tsx` | 首页分类、最新内容、媒体库、合集和分页 |
| `src/pages/Search.tsx` | 媒体搜索、失败重试和迟到响应保护；轮播搜索按钮通过 `serverId` 查询参数指定当前主页的服务器范围 |
| `src/utils/listPresentation.ts` | 列表元信息、预览图片、HDR/分辨率、文件夹排序 |
| `src/components/PosterCard.tsx`、`EpisodeRow.tsx`、`SectionRow.tsx` | 共享卡片、剧集行、横向列表 |
| `src/components/MediaDetailHeader.tsx` | 电影/剧集 LOGO 在封面上的独立展示、轮廓阴影与文字标题回退 |
| `src/components/LiquidGlass.tsx`、`src/utils/liquidGlass.ts`、`src/index.css` | 网页玻璃表面、圆角边缘位移图、主题与材质；只折射背景，正文保持清晰 |
| `src/components/GlassButton.tsx` | 共用列表导航按钮的原生 button、独立玻璃背景与清晰文字；保留事件、禁用、焦点及表单语义 |
| `src/components/AppBackdrop.tsx`、`src/store/appBackdrop.ts` | 首页轮播/详情媒体背景的临时共享、路由/实例隔离和环境玻璃底色；不持久化图片 URL |
| `src/pages/NativePlayer.tsx` | 原生播放启动、事件订阅、进度上报和退出协调 |
| `src/pages/Player.tsx` | 浏览器 HTML5/HLS 播放回退 |
| `src/player/` | 播放偏好记忆、相邻媒体、键盘操作及退出事件 |
| `src/player/playbackTitle.ts` | 元数据标题格式化及当前窗口标题，不持久化 |
| `src/api/danmaku.ts`、`src/hooks/useDanmaku.ts`、`src/player/danmaku.ts`、`src/player/danmakuSettings.ts`、`src/components/DanmakuCanvas.tsx` | 弹幕来源、可取消请求与导入、XML/JSON 解析、轨道排布、设置边界和浏览器绘制；原生由 OSC 独立 ASS OSD 绘制 |
| `src/player/playbackDiagnostics.ts`、`src-tauri/src/playback_diagnostics.rs` | 分阶段播放诊断、HTTP 错误与 URL/凭据脱敏、非阻塞写入和日志轮转 |
| `src/components/TitleBar.tsx`、`WindowResizeHandles.tsx` | 窗口标题栏和边缘缩放 |
| `src/platform/window.ts` | Tauri 窗口 API 包装 |
| `src-tauri/src/lib.rs` | 窗口创建、Tauri 命令注册和窗口事件 |
| `src-tauri/src/player.rs` | Windows：Win32 mpv 宿主窗口、进程、IPC、光标、窗口比例和 TLS |
| `src-tauri/src/player_macos.rs`、`player_macos.m` | macOS：Tauri 命令/会话隔离、Cocoa/CGL 视图、libmpv 异步命令、Lua 控件输入、GPU 玻璃与截图 |
| `src-tauri/tauri.macos.conf.json`、`scripts/prepare-macos-runtime.py` | macOS 包配置、libmpv 动态库依赖图、相对加载路径、原生架构与真实最低系统版本 |
| `scripts/env.sh`、`dev-tauri.sh`、`build-tauri.sh`、`scripts/README-sh.md` | Bash 运行/打包入口、平台选择、进程环境与使用说明 |
| `scripts/test-macos-native.sh`、`test-macos-native.m`、`macos-fixture-server.cjs` | macOS 生产渲染桥回归与本地模拟服务器 |
| `src-tauri/src/player_screenshot.rs` | 截图及 Windows 图片剪贴板 |
| `src-tauri/src/player_osc_render.rs` | 原生控件、毛玻璃、截图隔离和开播窗口比例的真实渲染回归 |
| `src-tauri/resources/mpv/portable_config/scripts/mjc-osc.lua` | 原生播放控件的 ASS 绘制、菜单和输入 |
| `src-tauri/resources/mpv/portable_config/shaders/mjc-glass.glsl` | 原生控件背后视频的局部 GPU 模糊、边缘折射和色散 |

`src/api/jellyfin.ts` 是旧模块名的兼容导出，新代码优先使用 `mediaServer.ts`。

新增后端在 `src/api/connectors/` 实现 `ServerConnector` 和 `MediaServerApi`，再加入 `index.ts` 的注册表；注册键必须等于连接器 `id`。添加/编辑选项、名称、默认服务器图标、客户端标识分组/预设、API 创建和重建、设备重新登记入口及原生播放协商策略都读取注册表，不在页面或 store 增加协议分支。旧连接缺少协议时仍按 Jellyfin 处理，保存字段和设备 ID 不迁移。`createServerApi` 接受具名连接参数；旧 `new MediaServerApi(...)` 调用继续返回具体连接器实例。非 Jellyfin/Emby 后端应自行解析响应为统一媒体模型，并实现请求取消、鉴权与 URL 安全边界，不必继承 `MediaBrowserApi`。扩展说明见 `README.md`。

## 环境与启动

Windows 开发需要 Node.js 20+、全局 Rust/rustup/Cargo、Visual Studio C++ Build Tools、Windows SDK，以及本地 mpv。`rust-toolchain.toml` 指定 `stable-x86_64-pc-windows-msvc`；本项目不再携带 `.toolchain`，也不依赖旧的 GNU LLVM/MinGW 工具链。

```powershell
npm ci
. ./scripts/env.ps1
rustc -vV
./scripts/dev-tauri.ps1
```

macOS 需要 Node.js 20+、本机 stable Rust、Xcode Command Line Tools、`pkg-config` 和 libmpv（可用 `brew install mpv pkg-config` 安装）。运行 `./scripts/dev-tauri.sh --desktop`，打包运行 `./scripts/build-tauri.sh --desktop`；在 macOS 上默认即为桌面模式，`--web` 仍走浏览器。入口仅在本次进程设置 `RUSTUP_TOOLCHAIN=stable`，不修改仓库的 Windows 工具链文件或全局 rustup 配置。Windows Git Bash 入口仍调用原 `.ps1`。详见 `scripts/README-sh.md`。

```bash
brew install mpv pkg-config
./scripts/check-runtime.sh
./scripts/dev-tauri.sh --desktop
./scripts/build-tauri.sh --desktop
```

上述命令在 macOS 主机执行。shell 入口从任意目录定位仓库，前端工具缺失时按锁文件执行 `npm ci`，缓存写入 `.npm-cache/`；依赖锁文件更新后主动重新安装。macOS 不需要 Windows 的 EXE、DLL、WebView2Loader 或 MSVC。Linux 默认使用 `--web`，当前没有 Linux 原生播放后端。

仅调试前端：`npm run dev:web`。浏览器回退播放器无法替代原生 mpv 的验证，原生窗口、HDR、截图剪贴板等行为必须在桌面环境核对。

`scripts/env.ps1` 为项目进程选择 MSVC，处理旧工作区的 `CARGO_HOME`、`RUSTUP_HOME` 和 GNU 目标覆盖，并配置开发数据目录。如果提示找不到 `x86_64-w64-mingw32-clang`，先检查 `rustup show`、`rustc -vV`、终端环境变量和覆盖配置；不要为了旧配置重新把完整工具链放回仓库。

PowerShell 脚本需兼容 Windows PowerShell 5.1。无 BOM 的 UTF-8 中文可能被按本地编码误读；当前 `.ps1` 使用 ASCII 文本。新增中文时应使用兼容编码并实际验证解析。对确认可信的下载脚本可使用 `Unblock-File` 清除来源标记，不应为此修改系统范围的执行策略。

`dev-tauri.ps1` 和 `build-tauri.ps1` 通过 `scripts/ensure-mpv.ps1` 自动准备 `src-tauri/resources/mpv/mpv.exe`、`mpv.com` 及构建包随附 DLL。二进制缺失或为空时，从 shinchiro 最新 Release 下载普通 x86_64 包，校验大小、SHA-256 和 EXE 架构，再使用 Windows `curl.exe` / `tar.exe` 安装同一套二进制；完整资源不联网或自动升级。临时下载目录位于 `.tmp`，成功或失败均清理，安装失败尝试恢复原有二进制。保留仓库自带的 `mjc-osc.lua` 和 `mjc-glass.glsl`，不接触 `.local`。这些二进制被 Git 忽略，也可单独运行准备脚本或离线手动准备；控制脚本和 shader 是源码，必须提交。下载来源见 README。

自动准备 mpv 后，两个入口在启动开发服务、编译或签名前调用 `scripts/check-runtime.ps1`，检查 mpv EXE、COM、DLL、控制脚本、shader 和 WebView2Loader 是否存在且非空。仓库资源缺失时直接给出文件路径与恢复方法；也可从可信安装版的 `mpv` 目录复制同一套二进制，不能覆盖仓库控制脚本和 shader。

## 数据与清理

- Windows 开发脚本默认把 WebView2 数据保存在 `.local/webview2`；可通过 `MJC_WEBVIEW_DATA` 覆盖。安装版默认使用系统应用数据目录。
- Vite 文件监听排除 `.local`，避免 WebView2 独占 Cookie 等持久文件时触发 `EBUSY` 并终止开发服务；不能用删除开发数据解决监听问题。
- 开发版截图保存在 `MJC_WEBVIEW_DATA/screenshots`（Windows 默认 `.local/webview2/screenshots`，macOS 默认 `.local/macos/screenshots`）；安装版优先使用系统图片目录的 `MyJellyfinClient` 文件夹，不可写时回退到应用本地数据目录的 `screenshots`。保存前验证真实文件写入权限，失败时清理本次预留文件；截图属于用户数据。
- Windows 的 `.local/webview2` 包含开发账号、登录状态、设置和偏好，删除会重置开发版数据；macOS 的 `.local/macos` 保存开发日志与截图。两者均不能按纯构建缓存清理。
- 播放诊断默认写入 `MJC_WEBVIEW_DATA/logs/playback.log`（Windows 开发默认 `.local/webview2/logs/playback.log`，macOS 开发默认 `.local/macos/logs/playback.log`）；安装版使用应用本地数据目录的 `logs`，不可写时尝试应用缓存目录。每行 JSON 以独立播放诊断编号关联前端元数据/媒体源协商、所选协议标识、mpv 启动、真实版本/HTTP User-Agent、IPC 失败和警告/错误。约 2 MiB 后轮转为 `playback.log.1`，仅保留当前和上一份。密码、令牌、鉴权头与完整 URL 在前端和原生写入前脱敏；不记录账号、媒体标题、完整命令行或视频内容。后台限长队列不阻塞播放器，失败页面显示诊断编号和实际日志路径。已停止生成未脱敏的旧 `player/mpv-player.log`，不清理已有用户日志。Mac native 日志仅转交等级/前缀等安全字段，不直接输出 mpv 原始日志正文。
- `.local`、`.codex-remote-attachments`、环境文件、密钥、日志、构建产物及 mpv 二进制不应提交。不要把用户提供的服务器地址、密码、令牌或截图写入源码和测试。
- `node_modules`、`dist`、`src-tauri/target`、`src-tauri/gen`、`*.tsbuildinfo` 可重新生成。清理前先区分持久数据、运行资源和可再生产物；递归操作应验证绝对路径范围。
- Windows 必要运行资源包括 mpv EXE/COM/DLL、其控制脚本和毛玻璃 shader，以及 `src-tauri/resources/WebView2Loader.dll`。macOS 必要资源为 libmpv 及随附动态库、Lua 控件和 shader，不能删除已打包应用中的这些资源。
- Windows 安装包通过 `tauri.conf.json` 明确收录 mpv 的 EXE、COM、DLL、`mjc-osc.lua` 和 `mjc-glass.glsl`；macOS 的 `tauri.macos.conf.json` 覆盖 Windows 专用资源并收录 `.dylib`。不收录开发运行产生的缓存；不要为发布清空正在使用的开发数据。`.tmp/macos-runtime/` 是可通过准备脚本重建的构建副本，与用户持久数据分开。

macOS 的 WKWebView 不使用 WebView2 数据目录；开发版使用固定的独立 data store identifier，安装版使用默认应用数据存储，开发与安装账号分开。`MJC_WEBVIEW_DATA` 在 macOS 仅指定诊断和截图目录，默认开发日志/截图为 `.local/macos/`。设置 `MJC_NATIVE_TEST_MODE=1` 的显式测试会话使用不持久化的 WKWebView，不读写真实账号；测试同时指定 `.tmp/` 下的日志/截图目录。不能把这些行为描述为 macOS WebView 数据全部写入 `.local`。

## 媒体库与协议约定

1. 所有服务器返回的分类都应能展示，不要恢复 `views.slice(0, 3)` 一类分类上限。
   首页「我的媒体」卡片优先显示服务器返回的媒体库封面，有封面时只显示图片，按钮保留媒体库名称的可访问标签；无封面或图片加载失败时完整保留原有库内海报拼图、渐变与文字说明。遵守预览开关和缩略图铺满设置，封面 URL 更新或重新启用预览后可重试。
2. 首页和媒体库用批次分页加载，批次大小不是总数上限。继续观看、接下来也支持继续加载。保留总数、下一偏移、并发防重、取消和迟到响应保护。
   首页轮播的搜索与左右箭头之间提供刷新按钮，重新读取当前服务器的媒体库及全部首页列表第一页；刷新中保留现有内容，不追加「加载中」卡片，并防止重复请求，离开取消、返回补发，迟到结果不能污染页面。首次加载与普通分页仍保留原有加载反馈。
3. `CollectionType=boxsets` 的列表查询必须包含 `BoxSet`。具体合集 `Type=BoxSet` 应打开成员媒体列表，不能直接按电影播放。类型规则集中在 `libraryItemTypes`，不要各页面另写不一致的过滤条件。
4. `mixed` 混合库和 `boxsets` 合集库都可能显示为「合集」，应按服务端类型判断，不能根据中文名称推断。
5. 不要仅因「最新媒体」接口返回空数组就判断合集没有数据。分页的分类查询使用 `getLibraryItems` / `queryItems`，合集不是普通视频项目。
6. 分类加载失败、空数据和仍在加载应能区分，并提供重试。不要吞掉错误后隐藏整个分类。
   媒体库排序菜单提供名称、添加日期、年份、首播日期、评分、影评人评分、播放日期、播放次数与时长，排序字段和升序/降序独立选择。偏好按保存的服务器 ID、账号 ID 与媒体库/合集 ID 存于 `mjc:library-preferences`，返回页面和重启后在首次查询中恢复；没有偏好时保持名称升序。排序由服务器完成，所有分页共用字段和方向；切换排序、账号、媒体库或离开页面时取消旧请求并忽略迟到响应，保留文件夹优先设置。菜单支持键盘、Esc、点击外部关闭及短窗口滚动。
7. 保留反向代理前缀、服务器协议差异、已有鉴权参数和媒体源的必要 HTTP 头。不要把本站令牌无条件追加到外部 URL。
   添加/编辑服务器提供 Jellyfin、Emby 手动类型选择，新连接默认 Jellyfin，编辑恢复已保存类型。界面连接以所选协议为准，不根据公共接口的 `ProductName`、`ServerName` 或版本改变用户选择；按所选类型直接登录，登录后校验公开响应的 `Id`、`Version`；公开信息不可用不丢失有效登录，登录成功才保存类型。更改类型需重新认证，失败保留原连接。未传手动协议的兼容调用保留自动识别。
   公共识别接口跨域重定向时保留用户选择的入口，不将元数据域名保存为媒体服务器地址；同域前缀重定向和同主机默认端口的 HTTP→HTTPS 升级仍可采用。Emby 根接口识别成功后优先验证原入口下同一服务器 ID 的 `/emby` 或 `/mediabrowser` 前缀，未提供有效前缀时保留根接口。这段公开发现流程仅用于未手选协议的兼容调用。已有连接继续使用已验证入口，不按猜测批量改写路径；新建 Emby 连接的入口规则见下文。
8. 章节预览使用服务器已有章节图片；缺少图片时回退到服务器封面，不为列表下载完整视频。索引图片使用兼容两种协议的路径形式。
9. 取消数量上限不意味着一次渲染/下载全部轮播背景；当前轮播按需挂载临近图片，全部已加载项目仍可导航。
   剧集详情的季选择器右侧提供查看全部及左右滚动，查看全部进入所选季的完整剧集网格；季选择通过 `seasonId` 查询参数保留，返回时恢复。横向行与网格共用 `EpisodeRow` 的单集详情跳转和显示偏好，剧集请求失败保留重试。
   剧集、演职人员与类似作品的查看全部页继承外层媒体封面的临时应用背景，直接打开剧集网格时补取所属剧集背景；不持久化图片 URL，保留预览开关、路由/实例隔离与离开清理。
   电影/剧集 LOGO 独立放在封面背景上，仅保留贴近图形的轻微轮廓阴影，去掉整片底色与渐变；下方浅色玻璃信息卡顶部始终显示文字节目名，作为唯一的 h1。LOGO 原色和比例不变，无图、加载失败或关闭预览时仅移除外部 LOGO 区域；单集仍使用文字标题。关闭预览不请求详情背景或 LOGO，重新启用可重试图片；两页共用 `MediaDetailHeader`。
10. 「设置 → 通用」分别显示 Jellyfin / Emby 的固定 SenPlayer / 6.2.2 名称和版本，仅设备名称可编辑。旧 `clientIdentities` 名称/版本和连接的 `clientName` 仍保留在存储，但这两种连接器的实际 API 身份统一覆盖为 SenPlayer。其他连接器可继续使用其注册表预设与自定义标识。公开探测、登录、缓存/重建 API、连通性探测与播放协商名称一致，媒体能力仍按真实播放器生成，鉴权字段保持 URL 编码和稳定设备 ID。桌面媒体 API 使用固定 `SenPlayer/6.2.2` UA；WebView 的 RodelPlayer 平台 UA、图片和 mpv 视频请求保持原实现，浏览器 UA 由浏览器管理。不向外部图片/媒体 URL 追加本站凭据。
11. 已识别服务器的 `Authorization` 和 `X-Emby-Authorization` 必须使用同一协议前缀：两者均使用 `MediaBrowser`，Emby 默认只发 X-Emby-Authorization，Jellyfin 发两个同值头。账号密码通过 `/Users/AuthenticateByName` 的 `Username` / `Pw` / `Password` 换取服务器返回的 `AccessToken`，原样按服务器保存；客户端不生成、散列或跨应用借用令牌，也不为刷新令牌擅自重置持久设备 ID。
    桌面 Jellyfin/Emby 的公开探测、登录及 REST/服务器弹幕请求共用 `mediaServerRequest` 原生 HTTP，支持未配置浏览器 CORS 的服务器。媒体 API 的 HTTP User-Agent 固定为 SenPlayer/6.2.2；只允许这一精确覆盖值。使用系统 TLS 校验，不带 Cookie，不关闭 WebView 安全策略；请求不自动重试，超时 30 秒（公开探测仍受前端 5 秒窗口约束），响应最多 32 MiB。AbortSignal 取消原生任务，包括启动 IPC 尚未确认时的取消，迟到响应不能套用。公开重定向跨域时移除鉴权/设备头且不采用目标作为登录入口；带凭据 API 仅允许同源 GET 重定向，POST/DELETE 不跟随，HTTPS 不降级；服务器弹幕继续拒绝全部重定向。图片、mpv 视频、自定义弹幕 API 和更新检查保持各自请求路径。
    浏览器模式仍使用 fetch/CORS。部分代理仅允许 `Authorization`，不允许 `X-Emby-*`：公开探测遇到未取消、未超时的 fetch `TypeError` 时，可在同一超时窗口内仅用标准 `Authorization` 重试一次，仍不含账号、密码或令牌；只有此请求成功且公共响应有效才将 `authorizationOnly` 保存到该连接。此模式的登录及 API 请求仅发送标准鉴权头，令牌仍放在该头的 `Token` 字段，缓存/重建 API 保持一致。正常连接按所选协议发送上述 SenPlayer 头；新建手选连接不因 CORS 失败重放登录；登录与写操作不因网络错误自动重放，不关闭浏览器跨域或 TLS 校验。
12. 编辑 Emby 连接仍可显式勾选「重新登记此服务器的登录设备」并重新输入密码。固定使用 SenPlayer 身份，仅该连接生成新的 `deviceId`，保留原存储的 `clientName`；失败保留原连接。之后登录、缓存/重建 API、播放协商和流 URL 共用此固定 ID。普通新增、删除、编辑和重新登录不自动重置设备身份，其他连接及全局 ID 不变。

### SenPlayer 连接方式

Jellyfin / Emby 的连接和媒体 API 已统一采用 SenPlayer 6.2.2 的实测格式，不再提供模式复选框。旧连接的 `connectionMode`（缺失、standard、senplayer）均不影响行为，不迁移账号、令牌、设备 ID 或已验证服务器地址。旧 `authorizationOnly` 例外仍保留，避免破坏已确认的浏览器代理兼容。

连接器通过可选 `loginAddress` 提供手选协议的直接登录入口，通过独立 `fixedClientIdentity` 声明固定名称/版本；直接登录不意味着其他后端也应使用 SenPlayer 身份，不在 store/UI 增加协议分支。新建 Emby 连接保留代理前缀并幂等补 `/emby`，已有 `/emby`、`/mediabrowser` 不重复追加；Jellyfin 保留输入路径。已有连接的 API 重建和原地址重新认证沿用原有效入口，不盲目给根路径加 `/emby`。不传协议的旧调用仍先公开发现；其他连接器无 loginAddress 时保持其发现流程。

登录成功后尽力读取公开元数据，失败不丢有效登录；无效用户 ID/令牌拒绝保存。继续保持原子回滚、不存密码、不复制其他应用设备身份、不重放登录、系统 TLS 和凭据重定向边界。证据与未验证范围见 `docs/senplayer-connection.md`；`test:servers` 包含 SenPlayer 默认请求、旧连接/根路径/会话保留以及真实 React/Chromium 表单回归；原生 HTTP fixture 验证实际 UA 与传输边界。

## 页面保留与浏览筛选

服务器卡片与侧栏「已连接的服务器」共用 `servers` 数组顺序。两处均支持按住拖拽排序，也可跨区域拖放；超过 6 个逻辑像素后显示跟随鼠标的服务器卡片/行（图标、名称和协议）、原位置虚线占位与插入标记，松开后通过 `reorderServer` 原子更新并保存到原有 `mjc:servers`。Esc、失焦、指针取消、无效落点、页面隐藏/卸载和拖动源或目标被删除时不提交；拖动后抑制该次点击，普通点击和服务器管理页右键菜单仍可用，卡片不再常驻编辑/删除按钮。长列表在拖动到滚动容器边缘时自动滚动；Alt+↑/↓ 可移动焦点所在服务器，保留焦点并播报位置。排序不改变账号、令牌、设备身份、活动服务器或 API 实例；刷新、编辑和新增连接保留当前顺序，新增连接追加到末尾。预览状态只在内存中，重启只恢复已经提交的顺序。

全部路由类型经 `BrowsePageHost` 保留最近 20 个页面实例和 DOM，不将页面数据、媒体图片 URL 或位置写入持久化存储。切换页面时隐藏旧页面，保存并恢复各个垂直/横向滚动容器的位置；数据已加载时返回不重查第一页，保留分页、搜索、设置页标签和媒体库筛选。连续切换媒体共用一个播放器页面实例，播放会话仍每次重新建立。服务器/账号 API 身份变化时清除相关旧页面；正常刷新服务器元数据复用同一 API，服务器管理页的本地表单不因 API 刷新而重新挂载，避免刷新与卸载循环导致添加/编辑失效。

隐藏页面通过 `useBrowseActivity` 停止自动分页、轮播、背景发布、快捷键和未完成的媒体查询；重新显示只补发被取消的请求。离开原生或浏览器播放器仍取消协商、停止播放并解除监听，不能因页面保留而后台播放。图片背景仍遵循原有路由/实例隔离。添加/编辑服务器弹窗的快捷键只在其页面活动时执行。

媒体库提供全部媒体、收藏、类型与风格、标签四个入口及筛选面板。Jellyfin 使用 `/Items/Filters` 取得包含年份的选项；Emby 使用官方客户端的 `/Genres`（音乐库为 `/MusicGenres`）、`/Tags`、`/Years` 独立接口，按账号、媒体库和媒体类型查询，分页读取全部选项，兼容 `Items` 查询结果和直接数组、`Name` 对象及年份名称字符串。只有独立接口不支持（404/405/501）且其他接口无鉴权、网络或解析错误时，才回退到旧 `/Items/Filters`；多个并行失败需全部检查，不能由先返回的 404 掩盖其他 401/403。不要对所有 Emby 版本直接套用 Jellyfin 筛选接口，也不从已加载的第一页推算完整选项。按 `Genres`/`Tags` 的管道分隔、`Years` 的逗号分隔和 `Filters=IsFavorite` 在服务器筛选，同组多选满足其一，跨组同时生效。条件保存在当前路由查询参数中，返回恢复；全部分页沿用排序和筛选，切换时取消并忽略旧响应。空选项、搜索无匹配、无符合条件媒体和加载失败分别显示，筛选选项和分页均支持重试，保留 BoxSet 成员浏览及文件夹优先。

媒体库/人物作品的垂直列表和首页横向行接近末尾时自动请求下一批；保留原生「加载更多」作为手动及无 IntersectionObserver 环境的备用入口。请求防重，失败停止自动重试，离开页面取消。分页偏移按服务端返回条目数推进，项目按 ID 去重，不把空页反复加载。收藏/已看操作同步更新已保留列表及详情；在收藏列表取消收藏时移除对应项目并调整偏移和总数。

## 右键菜单与媒体状态

`ContextMenuHost` 全局禁用网页默认右键菜单；`contextMenuProps` 统一处理指针及 Context Menu/Shift+F10 入口。首批仅服务器管理卡片提供编辑/删除菜单、首页媒体（轮播、继续观看、接下来和最新分类）及媒体库资源提供收藏/已看切换；首页媒体库入口、其他页面与侧栏不打开菜单。删除使用 `DeleteServerDialog` 应用内玻璃确认弹窗，不依赖 macOS WKWebView 未提供的 `window.confirm`；展示服务器名称，默认聚焦取消，支持 Esc、取消按钮与 Tab 焦点约束，点击遮罩不关闭，离开页面或目标消失时关闭。确认只移除本客户端连接及登录信息，不删除服务器上的媒体。菜单支持视口边界调整、键盘导航、Esc/Tab 与焦点恢复、外部点击/滚动/失焦/导航关闭；源条目删除或隐藏时清理。异步保存防重、失败保留重试，完成后按 API 身份通过 `updateBrowseUserData` 同步保留页面，旧账号不污染新账号。

共用 `PosterCard` 在左上角显示收藏星标、右下角显示已看勾选，采用共用图标与轻量玻璃圆底；无封面或关闭预览仍显示。New 和剩余时长避免与状态标记重叠。`test:home` 的真实组件回归覆盖菜单键盘/边界、失败重试、防重、状态切换和其他页面禁用；`test:servers` 覆盖服务器菜单编辑、删除确认/取消与原有拖拽排序。

## WebDAV 服务器会话同步

「设置 → 通用 → WebDAV 服务器同步」手动上传/下载自己的客户端配置，包含媒体令牌及其实际设备 ID，接收端合并后直接重建 API 并可播放，不要求再次输入媒体密码。旧全局设备 ID 在导出时解析为每个连接的显式值，既不迁移源连接，也不修改接收端全局设备 ID。保留已验证地址、代理前缀、协议、账号、客户端名称和 authorizationOnly；不重新发现或追加 `/emby`。同一令牌/设备 ID 共享同一服务器登录会话，撤销后需重新登录并上传；不能借用其他应用的身份。

只同步白名单字段，不包含媒体密码、活动服务器、错误、统计、日志、图片和其他设置。载荷格式带版本并在解密后严格校验，未知连接器、无效地址/身份、重复 ID 或超限拒绝整个导入。PBKDF2-SHA256 600000 次、16 字节随机盐与 AES-256-GCM 12 字节随机 nonce，加密口令至少 10 字符；云端只收到密文。WebDAV 目录/账号存于 `mjc:webdav`，密码和加密口令只在当前设置视图内存中，隐藏/卸载时清理并取消请求，迟到结果不能导入或更新 UI。

固定读写已有目录下 `myjellyfinclient-servers-v1.json`，公网须 HTTPS；RFC1918 私有 IPv4、IPv6 ULA、链路本地 IP 和本机回环/localhost 可 HTTP，IPv4 映射 IPv6 按内嵌 IPv4 分类。前端及原生均按 URL 解析后的 IP 判断，不按域名前缀或 DNS 结果猜测；共用 `scripts/fixtures/webdav-addresses.json` 验证网段边界与伪装域名。桌面独立命令仅支持此文件 GET/条件 PUT；HTTPS 保持系统 TLS、不带 Cookie、不跟随重定向、不重试、30 秒、2 MiB 上限，不放宽媒体 HTTP 桥。浏览器保留 fetch/CORS 及混合内容限制；需服务端允许方法/鉴权/条件头并暴露 ETag。上传准备先读取并解密原文件，确认后使用强 ETag 的 If-Match；首次创建使用 If-None-Match: *，412 提示重新读取，不覆盖冲突。服务器不提供强 ETag 时拒绝覆盖已有文件。

下载确认显示新增/更新/保留数量，采用云端顺序并保留本机独有连接。按连接 ID 优先匹配，唯一的同协议/地址/账号连接复用本机 ID；不混合不同账号的令牌/设备身份。提交前检查本机列表仍为预览时版本，先完成验证和 API 构造再一次更新，替换相关旧 API 以清除旧浏览页面身份，活动服务器保持本机选择。只在明确点击时传输，不增加后台或自动同步。

`npm run test:sync` 覆盖合成两设备/重启、Jellyfin/Emby 的免登录媒体库与播放协商、旧/显式设备身份、原地址/代理、密文随机性/篡改/错误口令/版本、原子合并、条件创建/冲突、IPC 取消竞态和真实 Settings/React/Chromium 的 CORS/确认/重试/隐藏/窄窗口及 DPI。Rust `webdav_http` 使用真实本机 HTTP fixture 验证条件头、凭据隔离、错误正文不转发、大小、重定向和任务取消。不能将 fixture 验证描述为真实网盘、Windows 原生传输或 Mac 解码已验收。

## 弹幕

「设置 → 弹幕」配置启用状态（默认关闭）、服务器插件/自定义 API、API 地址、不透明度、逻辑字号、显示区域、显示时长与 ±600 秒时间偏移，保存和读取均校验边界。原生和浏览器控制栏提供开关，关闭使用斜杠图标，状态保存到原有设置。原生窄窗口增加按钮后重新计算布局，保留原有倍速/字幕/音轨入口。
弹幕移动速度统一降低 30%。原有 `danmakuDuration` 保存值保持稳定，实际显示时长为该值除以 0.7，默认 8 对应约 11.43 秒；设置页展示实际秒数。浏览器与原生的移动、可见范围和轨道避让共用各自的同一换算，顶部/底部弹幕也使用这一显示时长；不改变视频时间和弹幕出现时间。

连接器可选 `getDanmakuXml` 读取配置入口下 `/api/danmu/{itemId}/raw`，不采用插件返回的绝对 URL，不丢代理前缀，不跟随携带凭据的重定向。缺失（404/204）、空文件、HTTP/网络/解析失败分别反馈。自定义弹弹play兼容 API 优先 POST `/api/v2/match`，仅发送由媒体元数据生成的片名/年份/SxxExx 和已有时长，`matchMode=fileNameOnly`，不下载视频、算哈希或发送真实路径；服务明确返回唯一匹配才自动加载。缺少季集编号、404/405/501 或未确定匹配时回退搜索供手选，不擅自选第一条搜索结果；鉴权、网络和无效响应保留错误与手动更换入口，不自动重放 POST。不附媒体服务器凭据、Cookie 或鉴权头。两种播放器的「更多 / 播放设置」可更换来源、重新获取或导入 XML；原生来源项按集数标题/来源双行显示，当前项勾选。原生动作和数据更新绑定播放诊断编号，旧会话不能影响新播放。

原生菜单再次点击自己的触发按钮只关闭，不能在同次点击重新打开；弹幕来源子菜单也可通过「更多」关闭。点击菜单外的视频区域只关闭并抑制该次背景播放动作，其他控制按钮仍可切换菜单或执行操作。菜单顶部提供 ×，Esc 优先关闭菜单，关闭后清理命中和材质区域。

XML `<i><d p="时间,类型,字号,颜色,...">正文</d></i>` 的时间为秒，JSON `p` 的颜色位于第三项而非 XML 的第四项。支持 1/2/3 滚动、4 底部、5 顶部、6 反向；跳过 7/8/9 等类型，不执行弹幕代码。拒绝文档类型/实体声明，正文为纯文本，原生 ASS 再转义；限制 16 MB / 50000 条。Canvas 和独立 ASS OSD 跟随真实媒体时间，暂停/缓冲冻结、倍速同步、跳转恢复可见范围，轨道不足跳过碰撞，不唤醒隐藏控件，不捕获画面输入，保存视频截图排除弹幕，正常字幕轨道不变。

请求具有 20 秒超时、取消及迟到响应保护，关闭、隐藏、换媒体和来源时释放或忽略旧工作。导入文件只保留当前播放内存，不上传、不持久化，不跨媒体或离开后迟到套用。使用 `npm run test:danmaku`（也含于 `test:playback`）验证解析/布局、真实 React/Chromium 绘制和原生组件 IPC；Rust/Lua 覆盖原生颜色/文本转义、时钟/跳转、DPI、图标、生命周期、真实 GPU/ASS 像素与截图隔离。调研、格式示例和使用说明见 README。

## 手动检查更新

「设置 → 通用 → 关于与更新」显示当前运行版本，只有点击「检查更新」才请求公开仓库的 `/releases/latest`，不在启动、打开设置或后台自动检查，不下载或安装更新。桌面版本来自 Tauri `getVersion`，浏览器版本来自打包的 `package.json`。只比较非草稿、非预发布的正式 Release；按语义版本数值及预发布规则比较，不将低版本提示为更新。无正式 Release、无需更新、新版本、超时、网络/限流及无效响应分别显示，可手动重试。检查期间防止重复请求，离开通用设置取消并忽略迟到结果；结果不持久化。GitHub 请求不附带媒体账号、令牌或鉴权头。发布页仅打开本项目固定的 GitHub Release URL；Windows 使用 `open_project_releases` 命令调用默认浏览器，macOS 同一命令通过 `/usr/bin/open` 打开该固定地址；不接受任意 URL 或程序参数。

## 播放器不能退化的行为

### 退出与生命周期

- 标题栏关闭按钮在播放页表示退出播放、回到上一页，不是关闭整个应用；其他页面的关闭按钮仍关闭窗口。
- 播放页不单独显示「退出播放」/返回按钮。Esc 优先关闭搜索、媒体信息或菜单；无浮层时才退出播放。
- WebView 获得焦点后的 Esc，也必须经 `player_escape` 交给原生控件处理浮层；加载尚未完成时仍应能立即取消退出。
- 网络慢或正在协商媒体源时，关闭必须取消请求；迟到回调不能重新启动播放或把用户导航回播放器。
- mpv 宿主窗口在媒体就绪前保持隐藏，让客户端窗口控件可用。初始/失败退出的零位置不能覆盖服务器的续播位置。
- 原生与浏览器播放器停止时，通过 `playbackProgress` 按当前 API 身份和媒体 ID 将有效播放位置及百分比同步给保留页面；返回详情后立即更新播放按钮的续播时间，再次播放沿用该位置。同步不等待服务器停止上报，不重载详情及类似作品，迟到上报不回写旧进度；加载未就绪或零进度不覆盖原位置。
- Windows 保留 `StartupGuard` 的启动失败回滚、正常停止清理和唯一的每次播放 IPC 名称；截图等异步任务不能串入下一次播放。
- Windows 创建进程时保留启动句柄，连接 IPC 期间检查真实退出码。`0xC0000142` 初始化失败只自动重试一次，超时或失败清理对应进程；继承应用的错误处理模式，避免阻塞式系统初始化弹窗，不修改系统设置。

### macOS 原生后端

- 媒体源协商、续播、字幕偏好、进度上报与播放退出继续由 `NativePlayer` 共用；macOS 使用透明 Overlay 原生标题栏和左上角系统红黄绿按钮，浏览背景与视频延伸至标题栏下。非全屏视频顶部 36px 用于窗口拖动，窗口比例不添加标题栏高度。红色按钮在播放页取消原生关闭并退出播放，其他页面关闭窗口；Tauri 关闭监听的默认动作使用 `destroy`，能力清单需同时保留 `allow-close` 与 `allow-destroy`；不带独立原型的「打开视频 / OpenGL」工具区。Windows 保持原有标题栏。
- Cocoa/CGL 视图的创建、渲染、输入和销毁均在主线程。开启 libmpv advanced render control 支持 GPU 截图；运行期主线程只使用异步命令、观察属性和非阻塞事件，不能添加阻塞式 `mpv_get_property`/`mpv_command`，避免截图/渲染互相等待。native callbacks 只调度并合并主线程任务，不能在回调内调用 mpv。
- `mjc-osc.lua` 以可选 `options/script-opts` 开启 Mac 玻璃桥，默认 Windows 行为保持不变。Mac 将 Lua 发布的六个面板几何转换为临时常量 shader，复用源 shader 的 OUTPUT pass；不在 CPU 或 JS 传输视频帧。控件隐藏时移除相应材质；截图期间隔离玻璃，保留字幕并排除 OSC/弹幕。
- Mac 的停止、消息、Esc、WebView 按键和弹幕携带诊断编号，并在主线程再次检查播放代次。先收到停止、后进入启动处理器时也必须拒绝迟到启动；旧会话清理不能停止新会话。`file-loaded` 事件在 Rust 确认会话仍有效后才显示 native view；销毁后队列内回调不能访问已释放的 Rust context。
- Mac 的 HTTPS 保持 `tls-verify=yes`，通过 Security.framework 只读取得系统默认根证书，写入本次播放临时 PEM 后设置 `tls-ca-file`；停止时清理临时目录。打包后不能依赖 Homebrew 编译时的 CA 文件路径，不自动导入证书或关闭校验。该实现不等同于同步全部用户 Keychain 信任策略，不能把未单测的自定义证书兼容描述为已验证。
- Mac 当前目标为 SDR sRGB/BT.709，设置页禁用 HDR 字幕亮度调节并说明。不能承诺 Metal、gpu-next、HDR/EDR 或杜比视界显示已验证。

### Windows 原生窗口与 IPC

- mpv 通过 `--wid` 渲染到 Win32 子窗口。子窗口应为 React 标题栏预留 36 个逻辑像素，全屏时恢复完整视频区域。
- 窗口比例计算应排除标题栏；最小化、最大化、全屏和还原不能互相破坏。窗口关闭时需清理 mpv。
- 窗口自适应由原生端直接订阅 `video-params`，视频尺寸可用时立即调整，不等待 Lua 绘制或截图采样。比例遵循完整视频的显示尺寸和旋转信息；保留编码在视频内的黑边，不再自动检测或裁切。
- 鼠标、键盘和光标命中区域来自原生控件；隐藏和模态遮挡的控件不能留下可点击提示。Alt+Tab 激活窗口后恢复可见原生宿主的键盘焦点。宿主每 250 ms 在所属 UI 线程修复迟到/重新启用的 mpv 子窗口输入状态；仅在应用前台且焦点丢失或落入 mpv 子窗口时恢复宿主，不抢其他应用、文件对话框或 WebView 输入焦点，销毁时清理定时器。普通鼠标移动与拖动都通过 `mjc-pointer` 直接唤醒 OSC，不只依赖 mpv `mouse-pos` 属性通知。WebView 持焦点时转发全部播放快捷键，方向键保留按下/释放及失焦清理，带修饰键和表单输入不劫持；新增按键 IPC 绑定当前播放诊断编号，旧会话不能干扰新播放。
- Win32 回调不能直接做阻塞管道读写。命令写入和事件读取使用独立 IPC 连接；同步句柄克隆不能替代独立连接。命令连接先发送 `disable_event all` 并确认应答，再传输业务命令，只接收命令应答；事件仍由独立连接持续读取。否则大段中文弹幕的 `script-message` 广播可能填满反向管道，与下一批写入互相等待，导致全部控制失灵。回归需使用超过管道缓冲区的真实 UTF-8 负载，不能只用短英文模拟大量弹幕。
- 创建、销毁和修改宿主窗口时注意所属 UI 线程。现有进程启动兼容逻辑也有实际用途，修改后验证真实 mpv 启动。

### UI、设置、TLS 与缩放

- 控件字号和点击尺寸跟随 Windows DPI 或 macOS backing scale，不随窗口高宽整体缩小。小窗口通过分行、折叠到「更多」和菜单滚动适配。
- 窗口标题、原生画面标题及开播提示使用服务器元数据，不能回退到带鉴权参数的流 URL。双击画面按设置暂停/播放，控制面板和菜单的双击不触发背景播放动作。
- Windows 的 `WM_LBUTTONDBLCLK` 替代第二次按下，仍需建立鼠标捕获并通过 `mjc-pointer double` 传入真实坐标。Lua 将控件/菜单上的第二次按下作为普通点击处理，滑块可继续拖动；只有视频背景执行双击播放手势。不能把控件上的双击消息直接丢弃，导致快速连续点击漏掉每第二次操作。
- 播放器控制使用白色图标、半透明底栏和不同透明度的白色进度条，文字标签只在悬浮时出现；菜单选中项使用白色勾选。暂停不锁定控件，保留切换媒体、全屏、进度和音轨等操作；已移除暂停锁定设置、解锁提示和 K 锁定快捷键，旧设置迁移时删除此字段。
- 控制栏进度条按未缓存底轨、真实缓存段、已播放进度依次叠加，白色不透明度分别为 18%、40%、82%。Windows 与 macOS 原生均显式开启 `cache=yes`，读取 `demuxer-cache-state/seekable-ranges`，合并重叠段并保留间断；浏览器读取媒体元素的 `buffered`。不按缓存字节数或下载速度推算位置；未知时长不画缓存段，缓存失效及切换/停止媒体时清除旧段，后台缓存更新不唤醒隐藏控件。
- Windows 原生玻璃由 `gpu-next` 的 `mjc-glass.glsl` 在低分辨率纹理上模糊，并在可见面板边缘做实时透镜折射和 RGB 色散；Lua 同步范围、圆角、DPI、视频显示区域和 `GLASS_MATERIAL` 参数，图标与文字仍由 ASS 清晰绘制。macOS 通过 OpenGL render API 和玻璃桥复用这些 OUTPUT pass。无可见玻璃面板时跳过玻璃处理，不用 CPU 截图实现背景效果。Windows 的 PQ、HLG 和线性 HDR 输出跳过 SDR 饱和度及亮背景压暗处理。Windows 截图通过 Lua 的 `mjc-capture`，Mac 截图通过异步 render API 命令暂时隔离玻璃并恢复，均保留 GPU 色彩和字幕处理。
- 空格仅切换播放/暂停，不更新控制栏活动时间或重新显示控制 UI；首次激活应用后也应直接可用。
- 自动隐藏默认 3 秒，旧设置通过一次性版本迁移采用 3 秒；之后用户重新选择的间隔保持持久化。菜单、媒体信息和进度拖动期间保持控件可见。
- ASS 行级对齐标签不要重复或冲突：文字应使用对应 `an7/an8/an9`，矢量绘制明确使用 `an7`。视觉位置与点击区域要同步。
- 新设置必须接通保存、读取、执行和平台适用范围；不能只有设置页开关。浏览器不能实现的桌面设置应明确标注。
- 「设置 → 播放 → 缓存」支持 1–8192 MB 的整数预读缓存上限，默认 150 MB，按十进制 MB 转为 `demuxer-max-bytes`（1 MB = 1,000,000 字节）；不改变后向缓存配置。回车或输入框失焦后保存，下次开始原生播放时生效；浏览器中禁用。旧设置补默认值，保存/读取及原生边界均校验范围。
- 简繁字幕偏好不能只靠通用中文语言码；轨道记忆在同媒体源优先 ID，跨媒体源按语言、名称等元数据匹配。
- 外挂字幕规则只过滤真正的外部字幕，不应误删服务器提取出的内嵌字幕。
- mpv 的 HTTPS 使用对应平台只读导出的根证书，保留 TLS 校验；不要用关闭校验来掩盖证书配置问题。
- Windows 原生媒体网络沿用 mpv 默认网络后端；诊断日志记录实际 `curl-enabled` 值，不能仅凭 HTTP 522 或不同后端推定原因。Windows FFmpeg/Lavf 的本地兼容回归覆盖跨端口 302 重定向、媒体读取、必要请求头及不向跳转目标追加原 URL 的令牌，保持 TLS 校验与 Windows 信任根配置。不能将这组 Windows 回归直接记为 Mac 网络后端已通过相同检查。
- 「适应窗口」保持完整视频帧的比例，宽屏显示含内嵌上下黑边的 16:9 视频时，左右留黑可能是正常比例结果；「裁切填充」由用户主动选择并完整铺满，不能恢复旧的 `panscan=0.4`。

## 验证命令

按修改范围选择相应检查，功能变更增加能复现问题的回归，避免只检查字段是否出现在源码中。

```powershell
npm run typecheck
npm run build
npm run test:home
npm run test:servers
npm run test:settings
npm run test:sync
npm run test:playback
npm run test:ui
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/test-mpv-setup.ps1

. ./scripts/env.ps1
cargo test --manifest-path src-tauri/Cargo.toml --lib
& ./src-tauri/resources/mpv/mpv.com --no-config --vo=null --idle=yes --script=scripts/test-player-osc.lua
```

`test:home` 覆盖全部分类、8 个合集、成员浏览、多页加载、重试和取消；排序回归使用真实 React/Chromium 验证独立字段与方向、返回及重启恢复、服务器/账号/媒体库隔离、分页取消与迟到响应、菜单焦点及普通/窄窗口和 100% / 125% / 150% DPI。`test:servers` 使用本地 HTTP fixture，并用真实 Chromium 检查登录接收端看到的统一 UA、默认鉴权标识和手动覆盖；`test:playback` 覆盖关闭、元数据标题及慢网络生命周期；`test:settings` 覆盖真实组件、偏好和 3 秒迁移。Rust/Lua 测试覆盖原生输入、启动重试、TLS、截图目录回退、真实 GPU/ASS 渲染、毛玻璃像素效果和截图隔离、开播窗口比例及响应式控件，需本地 mpv 和 Windows 环境；`client_identity` 原生测试覆盖共享标识与实际 Windows 平台的 UA 格式。Rust 回归同时运行 Lua 控件交互测试；原生控件渲染使用 `scripts/test-player-osc-render.lua` 的合成媒体状态，不读取账号或服务器截图。
`test:home` 中的 Issue #2 回归使用真实 React 路由/Chromium，检查保留同一 DOM、自动加载后全部项目、首页/媒体库/搜索/设置的垂直与横向返回位置、服务端类型/标签/年份/收藏组合、加载失败与重试、取消与迟到响应、收藏同步、筛选 Esc、账号隔离及普通/窄窗口和不同 DPI。服务器管理回归测量按钮真实命中、打开添加/编辑弹窗、输入并保存，以及 API 更新不重置表单或造成刷新循环；`test:servers` 另用真实 HTTP fixture 验证元数据刷新复用 API。NativePlayer 活动/隐藏/再激活回归使用真实 React 组件和完全模拟的 Tauri IPC，验证取消、停止、解除快捷键和新播放会话，不能将它描述为新的真实 mpv 渲染验证。
播放诊断回归覆盖脱敏、完整响应体中的 HTTP 错误、独立编号、取消后的迟到响应、日志轮转与满队列非阻塞；真实 mpv 从本地 HTTP 522 fixture 接收日志事件并与 `end-file/error` 关联。
`test:playback` 中的 `test-playback-resume.cjs` 使用真实 React 路由、保留页面和隔离 Chromium，模拟 Tauri IPC 或浏览器媒体事件，覆盖 Jellyfin/Emby 播放退出后的详情进度更新、再次续播、向后跳转、上报延迟/失败、加载取消及账号隔离；不读取真实账号，也不替代原生解码验证。

`test-mpv-setup.ps1` 在 Windows PowerShell 5.1 下使用离线传输 fixture 和真实 `tar.exe` 验证缺失下载、完整资源复用、部分资源修复、控制脚本保留、校验失败、架构与压缩包检查、安装回滚和临时目录清理，不使用账号或访问网络。

`test:servers` 先运行 `test-connectors.cjs`，仅在测试编译时给注册表注入独立的第三连接器，使用不同端点/鉴权/响应格式的本地 HTTP fixture 验证完整应用的 TypeScript 编译、自动/手动探测、登录、持久化、API 缓存及重建、实时标识、失败回滚、取消、真实 React 静态渲染的连接选项/设置分组和默认图标。测试连接器不进入生产注册表；这不属于新增真实后端支持。

`test:servers` 中的 `test-media-server-request.cjs` 验证桌面请求桥的探测/登录/媒体库与 API 重建、启动确认前取消、迟到响应、HTTP 状态、失败不重放与浏览器回退；使用模拟 IPC。Rust `media_server_http` 测试使用无 CORS 的本地 HTTP fixture，验证实际请求 UA、鉴权与正文、状态/响应大小、重定向凭据隔离及原生任务取消，不使用真实账号。

`test:servers` 的 `test-server-order.cjs` 使用真实 React、隔离 Chromium profile 与原生鼠标/键盘事件，验证卡片、侧栏及跨区域拖动、真实指针捕获、跟随预览的可见位置与服务器身份、同步顺序、仅落下保存、焦点和普通点击/编辑、Esc/指针取消/落点无效、隐藏/卸载清理、拖动中删除/新增、刷新与编辑、两处自动滚动、持久化及全新页面/store 恢复。覆盖普通/窄窗口和 100% / 125% / 150% DPI；只使用合成服务器，不读取用户浏览器、账号或地址，不属于真实 Tauri/mpv 验证。

`test:settings` 的更新检查回归使用离线 GitHub 响应及真实 React/Chromium 设置页面，验证仅点击请求、当前版本、新旧/无效版本、无 Release、网络/HTTP/限流错误、超时、防重、取消/迟到响应及普通/窄窗口和 100% / 125% / 150% DPI 布局，不访问 GitHub 或用户服务器。

`test:ui` 覆盖圆角玻璃透镜的中性中心、增强边缘折射、长面板采样、纹理尺寸与缓存、ResizeObserver/动画帧清理，首页/详情临时背景的路由/实例隔离、预览开关与图片失败重试，以及搜索/记录失败重试、迟到响应和弹窗 StrictMode 焦点恢复。玻璃材质需另用实际 Chromium/WebView2 视觉核对；其他浏览器保留模糊和高光回退。海报、头像与轨道卡片使用轻量静态表面，不为每个媒体项目创建 SVG 透镜；首页媒体区只用一个随滚动保持在可见窗口内的玻璃层，避免无限分页扩大 GPU 材质尺寸。减少动态效果、高对比度与减少透明度偏好有 CSS 回退。

`test:ui` 中的玻璃按钮回归使用真实 React 与无头 Chromium 验证原生点击、禁用、ref、表单类型、事件透传和列表导航。默认查找本机 Chrome / Edge，可用 `MJC_TEST_CHROMIUM` 指定可信浏览器路径；测试只用合成页面与独立临时 profile，不使用用户浏览器账号或访问服务器，结束后清理经过路径校验的临时目录。
原生输入回归通过真实 Win32 宿主消息、独立 IPC 和实际 OSC/GPU 播放合成视频，对比弹幕关闭和开启 50000 条长中文弹幕，重复验证自动隐藏、空格暂停、鼠标唤醒及播放按钮点击、全屏按钮/回车/F 的命令传递，并模拟 mpv 子窗口重新启用输入后恢复宿主接管。独立 IPC 回归复现并防止大消息广播造成的管道死锁，同时检查事件连接仍完整收到广播。宿主消息注入不等于真实桌面鼠标命中或 Tauri 全屏切换验证。
搜索页布局回归同样使用真实 React 与 Chromium，测量默认空状态、加载、无结果、错误、清空和未选择服务器时的滚动高度，并验证普通/窄窗口中结果列表可滚动到最后一项。
剧集导航回归验证真实左右滚动、切季重置、当前季完整网格、单集详情跳转与返回、加载/空数据/重试、取消和迟到响应、季下拉、继承/直接打开的封面背景与预览开关，以及普通/窄窗口和 100% / 125% / 150% DPI 的控件布局。
详情 LOGO 回归使用合成透明 PNG 与真实电影/剧集组件，在普通/窄窗口和不同 DPI 下验证独立布局、比例、可访问标题、无图/失败/URL 更新/预览开关的回退、单集链接和操作；实际 Chromium 截图验证白色图形的可辨轮廓、品牌原色与透明区无整片暗底，不读取服务器图片。

若受限执行环境无法读取构建工具目录或系统临时目录，应区分权限问题和代码问题。必要时为本次验证指定可写的临时目录，不能据此改坏用户正常构建配置；不要在敏感输出中打印令牌。

macOS 回归：`./scripts/test-macos-native.sh` 用合成 4K 10-bit HEVC、真实 WKWebView 与生产 Cocoa/libmpv bridge 验证 GPU 玻璃、OSC 几何、截图、缩放和销毁；截图像素读回仅用于测试。Rust 的 Mac 会话代次/取消回归不替代真实原生渲染。端到端本地模拟服务器可用 `node scripts/macos-fixture-server.cjs`，并在显式隔离测试会话内添加 `http://127.0.0.1:5199`，不使用真实账号。Mac 播放验证需核对菜单 Esc、标题栏退出、实际进度上报和没有原型工具区。

```bash
./scripts/test-macos-native.sh
RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib
```

已完成的 Mac 验收覆盖媒体库原生播放与玻璃界面；自动回归分别覆盖生产渲染桥、会话取消/代次隔离及共用 React 播放/设置行为。浏览器回归可用 `MJC_TEST_CHROMIUM` 指定可信 Chrome/Chromium 或 chrome-headless-shell；这不替代 WKWebView/CGL 实机验证。HDR/EDR 色彩准确性、Intel 硬件和 Universal 打包需要独立记录验证结果，不从普通播放验收推断。

## 提交与发布

- Windows Actions 的 checkout 通过步骤级 Git 配置保留 LF，避免旧标签中的工具被 CRLF 转换影响；`release-version.mjs` 同时接受 LF/CRLF，并保留 Cargo 文件原换行与依赖版本。工作流修复后可从默认分支手动触发并传入原 release tag，仍构建原标签源码；不移动标签、不覆盖现有附件，直接重跑旧任务不会采用新版工作流。

- 一键发布入口为 `./scripts/release.sh X.Y.Z`（或 `npm run release -- X.Y.Z`），在 macOS 默认分支的干净工作区执行；`--dry-run` 只展示计划，`--resume` 恢复同版本/同 HEAD。先直接调用 PATH 中已登录的 `codex exec`，以只读模式依据当前源码与最近已发布正式版生成覆盖 macOS/Windows 的中文发布文档；失败在修改版本前停止。同步 npm/Tauri/Cargo 及两个锁文件，只提交五个版本文件，不更改客户端兼容标识；创建标签并原子推送分支/标签后才构建 macOS。验证 App 签名、隔离启动与 DMG，上传 App ZIP、DMG、SHA-256 和 Markdown 文档到草稿，同一文档作为 Release 正文，核对后发布。随后显式触发 `.github/workflows/release-windows.yml` 的 `workflow_dispatch`，从同一标签构建 NSIS 安装版和单 EXE 便携版，全部成功后追加两包及校验文件；不监听 Release published，不安装证书。需要 Codex/gh 登录、Actions 启用、允许追加附件（不可开启 immutable releases）。`.tmp/releases/vX.Y.Z/` 保存文档、哈希及原始/版本提交恢复状态，未完成前不要清理；恢复复用原文档，不重复生成或提交。构建失败可能已推送版本与标签，不自动回滚；源码改变应使用新版本。已发布时恢复仅触发 Windows，公开资产不覆盖、标签不移动，草稿仅在显式恢复时可替换附件。前提与恢复见 README；离线回归为 `npm run test:release`，不等同真实 Codex/Windows/GitHub 发布验收。

- macOS 打包将已安装 libmpv 的实际 Mach-O 依赖图收集到 `.tmp/macos-runtime/`，修改副本的 install name 为 `@loader_path`/`@rpath` 并做本地 ad-hoc 签名，不改 Homebrew 原件。App 中明确收录这些库与 Lua/shader；不递归收录用户数据。最低系统版本取全部动态库的 `minos` 最大值（至少 14.0），同步到构建配置与 deployment target；不能把 macOS 26 bottle 打包成宣称兼容 macOS 14 的应用。当前只验证 Apple Silicon，本机库不支持自动生成 Universal 包。
- macOS `build-tauri.sh` 默认使用 CI 模式跳过 DMG 的 Finder 美化 AppleScript，不请求或修改系统 Automation 权限；保留应用和 Applications 快捷入口。产物为 `src-tauri/target/release/bundle/macos/MyJellyfinClient.app` 与 `bundle/dmg/`；当前 Apple Silicon 依赖构建的最低系统版本为 macOS 26.0，后续以实际库的计算结果为准。
- macOS 配置使用 `signingIdentity: "-"` 为完整应用做 ad-hoc 签名，配套 `hardenedRuntime: false`，避免没有 Team ID 的 libmpv 被库校验拒绝；仅影响此应用，不修改系统安全设置。未来 Developer ID 发布需重新核对全部动态库签名与 Hardened Runtime。Release 不嵌入工作区动态库搜索路径，debug 才保留。不能只签可执行文件而遗漏 `.app` 的资源签名；构建后运行 `codesign --verify --deep --strict src-tauri/target/release/bundle/macos/MyJellyfinClient.app`、`node scripts/test-macos-bundle.cjs`，并对实际 DMG 文件运行 `hdiutil verify`。启动回归使用非持久化 WebView 与临时诊断目录；核对包内库、Lua/shader、架构和最低系统版本，独立运行检查不得依赖工作区 `.tmp/macos-runtime/` 或 Homebrew 绝对路径。本地签名不等同 Developer ID 签名/公证，本地验收也不代表已推送或发布。
- 工作前检查 `git status`、相关文件和当前用户修改。保留无关变更，不使用强制重置来制造干净工作区。
- 提交前检查差异、相关测试、忽略规则和私密数据。提交、推送和 Release 按用户授权执行；成功必须以远程实际状态验证，网络失败不能报告已推送。
- 当前仓库使用本地 `gh`。Git TLS 握手失败时可重试或检查连接，不要关闭证书校验。
- 打包使用 `./scripts/build-tauri.ps1`；默认 x64 MSVC 的 NSIS 输出在 `src-tauri/target/release/bundle/nsis/`。
- 安装包构建后可运行 `./scripts/build-portable.ps1`，生成 `src-tauri/target/release/bundle/portable/` 下的单 EXE 便携版。复用 Tauri 缓存的 NSIS，检查主程序版本/x64 架构和完整资源，按显式清单嵌入程序、mpv EXE/COM/DLL、控制脚本、shader 及 WebView2Loader；不递归打包开发数据或缓存。编译/签名成功才替换输出，工作区 `.tmp/portable-build-*` 在结束时按范围校验清理。
- 便携启动器以当前用户权限解包到 NSIS 独立临时目录，等待主程序退出后清理；不写安装注册表或快捷方式，不安装 WebView2 Runtime。账号、设置、截图和诊断位于 EXE 旁的 `MyJellyfinClient-data/`，通过子进程 `MJC_WEBVIEW_DATA` 统一指定，属于用户持久数据；只读目录明确失败，不偷偷改用安装版或开发版账号。Windows PowerShell 5.1 的 `scripts/test-portable.ps1` 使用合成 x64 程序和实际 NSIS，验证完整资源、缓存排除、Unicode/空格路径、退出码、连续启动数据保持、临时清理和缺失资源/错误架构的失败保护。
- `scripts/sign.ps1` 显式加载当前 PowerShell 自带的 Security 模块，兼容 Node/Tauri 启动 Windows PowerShell 时继承其他 PowerShell 的模块路径；可使用已有本机开发证书，但这不等于所有用户机器都信任它。`make-dev-cert.ps1` 会修改证书库，不应作为普通构建步骤自动运行。
- `build-tauri.ps1` 先签名 mpv 运行资源；Tauri 的 `bundle.windows.signCommand` 调用 `sign.ps1 -Paths`，在二进制补丁之后、压入安装包之前签名程序，并签名卸载程序与最终安装包。不要恢复只在打包完成后签名源码目录程序的流程；保留已有有效签名，未找到开发证书时跳过，签名失败时终止构建。
- 发布前核对源码提交、版本、程序架构、包内 mpv/控制脚本/shader 和附件 SHA-256。版本定义位于 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，Cargo 锁文件中的本项目版本也需一致。
- Release 是构建快照；推送源码不会自动更新已发布安装包。不要擅自覆盖已有标签或资产；发布完成后验证公开状态、附件上传状态、大小和校验值。

## 维护这份指南

改变构建入口、关键接口、数据路径或产品行为时同步更新本文件。记录经过验证的约定，不记录用户账号、临时环境绝对路径和对话中的未经确认猜测。用户当轮要求与实际代码优先于过时的指南。
