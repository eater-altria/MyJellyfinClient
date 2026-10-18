# SenPlayer 连接行为与兼容实现

本次分析对象为本机 macOS SenPlayer 6.2.2（249），bundle ID 为 `com.wuziqi.SenPlayer`。主程序 SHA-256、筛选后的真实请求记录见 [证据 JSON](senplayer-connection-evidence.json)。只使用监听 127.0.0.1 的模拟服务器及虚构账号，设备名称和设备 ID 在记录前脱敏。

## 已观察的行为

在添加界面分别选择 Emby / Jellyfin，填写主机、端口、代理路径及虚构用户名密码。模拟登录先返回 401，再返回有效的用户、令牌和会话信息，通过进入连接/刷新验证后续请求。

| 行为 | Emby | Jellyfin |
| --- | --- | --- |
| 输入代理路径 | `/proxy` | `/jelly-proxy` |
| 首个请求 | POST `/proxy/emby/Users/AuthenticateByName` | POST `/jelly-proxy/Users/AuthenticateByName` |
| 登录 JSON | `Username`、`Pw`、`Password`，后两项为同一输入密码 | 相同 |
| 鉴权方案 | `MediaBrowser` | `MediaBrowser` |
| 登录请求头 | `X-Emby-Authorization` | `X-Emby-Authorization` 与同值 `Authorization` |
| 客户端与版本 | `SenPlayer` / `6.2.2` | 相同 |
| HTTP User-Agent | `SenPlayer/6.2.2` | 相同 |
| 登录后 | 鉴权头增加 `UserId` 与 `Token`，另发 `X-Emby-Token` | 相同，仍保留双头 |

登录前未出现 `/System/Info/Public`。有效登录后才请求该端点，然后观察到 `/System/Ext/ServerDomains`、用户视图库、继续观看和接下来。两个协议在模拟公开信息返回 Emby 标识时仍沿用手选的请求头差异。

静态 `strings` 检查发现 `System/Info/Public`、`Users/AuthenticateByName`、`X-Emby-Authorization` 等字符串，只用于定位问题；请求行为结论来自接收端记录。REA CLI 诊断确认本机缺少 Hopper / Ghidra / IDA 引擎，本次没有反编译函数，也没有 REA 原生 Evidence ID。

## 本项目的实现选择

所有 Jellyfin / Emby 的连接和 API 请求直接使用上述 SenPlayer 格式，表单不再提供兼容模式复选框。旧 connectionMode 无论缺失、standard 或 senplayer 都不改变这一行为；不批量迁移令牌、账号、设备 ID 或已验证入口。手选协议后直接登录，登录后尽力读取公开元数据；未指定协议的旧调用仍保留公开发现流程。

设备名称沿用本项目设置，名称/版本固定为 SenPlayer / 6.2.2，设备 ID 沿用本项目稳定 ID，不复制其他应用身份。新建 Emby 登录地址幂等补 `/emby`，已有 `/emby` 或 `/mediabrowser` 不追加；已有连接的 API 重建与同入口重新认证保持已验证路径。这是本项目对旧连接和代理的兼容选择，未声称 SenPlayer 有相同的迁移逻辑。

原生 HTTP 仅允许固定 `SenPlayer/6.2.2` UA 覆盖；WebView UA、图片和 mpv 请求保持原实现。浏览器管理自身 UA，已验证的 authorizationOnly 旧连接继续使用标准头。设置中的旧自定义名称/版本保留存储，实际 API 身份统一覆盖；设备名称仍可编辑。

继续保留系统 TLS 校验、凭据重定向边界、失败不自动重放、有效字符串令牌/用户 ID 验证、登录成功才原子保存、不持久化密码。没有照搬 SenPlayer 在 401 后仍保留连接条目的行为。未实现备用线路同步（`System/Ext/ServerDomains`），也没有更改本项目媒体浏览和播放器能力协商。

## 覆盖范围与未验证项

已验证的 SenPlayer 行为限于上述安装包、两种协议、普通本机 HTTP、默认高级设置、代理前缀、401 和成功响应。未推断它的 TLS/证书、跨域重定向、所有错误回退或设备 ID 生成算法；SenPlayer 逆向阶段未读取真实账号、令牌或服务器数据。该格式不保证所有服务器的设备登记或客户端限制都能通过。

回归入口：`npm run test:servers`（包含 `test-senplayer-connection.cjs` 和 `test-senplayer-dialog.cjs`），以及 `RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --lib media_server_http::tests`。Node/IPC 用于请求及状态链路，Rust 本机 HTTP 用于实际 UA 与传输边界；均不是完整 SenPlayer 代码重建或真实服务器兼容认证。

界面回归使用真实 React、隔离 Chromium 和虚构连接，验证默认直接登录、历史模式标记不生效、连接器能力、添加/保存参数、加载禁用，以及普通/窄窗口和 100% / 125% / 150% 缩放下的滚动可达性。
