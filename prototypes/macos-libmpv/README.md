# macOS libmpv GPU 嵌入原型

这是独立的 Cocoa 原型，用来先验证 macOS 原生视图、libmpv OpenGL render API 和视频上的 GPU 玻璃效果。
这个独立实验窗口不连接 Jellyfin/Emby。主项目现在已有独立的 macOS Cocoa/libmpv 后端，使用 `./scripts/dev-tauri.sh --desktop` 运行媒体库应用；该应用不带本原型的顶部白色工具区。见 `scripts/README-sh.md`。

## 运行

需要 macOS、Xcode Command Line Tools、`pkg-config` 和 libmpv。Homebrew 可通过 `brew install mpv` 安装；
演示与合成回归另需 FFmpeg（Homebrew mpv 的依赖）。

在仓库根目录执行：

```bash
./scripts/prototype-macos-mpv.sh --demo
./scripts/prototype-macos-mpv.sh '/path/to/local-video.mkv'
./scripts/prototype-macos-mpv.sh --build-only
```

`--demo` 生成 30 秒合成测试图并启动窗口；播放结束保留最后一帧，仍可拖动进度条或打开视频。
不带参数时启动空窗口，点击「打开视频」选择本地文件。
编译产物位于 `.tmp/macos-libmpv/MyJellyfinClient-GPU-Prototype.app`，可在本机打开。
它依赖本机 Homebrew 动态库以及构建时的仓库路径，**不是可分发的独立安装包**；
移动仓库后重新构建，不会自动打包或签名所有依赖。

操作：

- 空格或「播放 / 暂停」切换播放状态。
- G 或「玻璃开关」比较 GPU 效果；不是截图模糊或 CSS 模拟。
- F 切换 macOS 原生全屏，左右方向键前后跳转 5 秒。
- 拖动进度条跳转；窗口可调整大小。
- 关闭窗口销毁 GPU 渲染上下文和 mpv 实例，清理本次临时 shader。

## 渲染方式和边界

使用 libmpv 的 `vo=libmpv` 和 OpenGL 3.2 Core render API，在 NSOpenGLView/CGL 中直接 GPU 渲染。
硬件解码采用 `hwdec=auto-safe`；实际是否硬解由编码、硬件与构建决定。
视频帧没有通过 JavaScript、CPU 截图或 Canvas 传输。

玻璃读取仓库的 `mjc-glass.glsl`，复用其三道 OUTPUT pass：低分辨率分离模糊、圆角边缘折射和 RGB 色散。
稳定版 OpenGL 后端不能直接接受原 shader 的 `DYNAMIC` 参数声明，因此原型按窗口几何生成常量版临时 shader，
不修改源文件。尺寸或开关变化时重载；视频每一帧仍由 GPU 处理。文字和按钮独立绘制。
玻璃只采样视频纹理，黑边区域没有视频可折射；生产整合需要进一步协调控制栏的位置。

当前目标为 SDR sRGB/BT.709。这证明了 **GPU 渲染 + 视频玻璃效果**，不证明 `gpu-next`、Metal、
HDR/EDR 输出、杜比视界或当前 Windows HDR 字幕行为已经迁移。
原型也尚未接入完整 Lua OSC、弹幕、音轨/字幕菜单、媒体服务鉴权和进度上报。
这一步故意先隔离渲染风险，后续 Tauri 整合需处理原生视图与 WebView 层级、输入、线程与会话生命周期。

## 可复现验证

```bash
./scripts/prototype-macos-mpv.sh --self-test
./scripts/prototype-macos-mpv.sh --self-test-hevc
```

两种测试均使用合成媒体，在 960×600 与 720×450 的窗口中暂停到固定位置，比较玻璃关闭/开启的真实 framebuffer 像素。
要求玻璃内部平均变化大于 2/255，外部平均变化小于 1/255，GPU 已产生帧且未记录 GPU 错误；失败退出非零。
只有此合成验证会做 `glReadPixels`，播放与效果实现不依赖像素读回。
PNG 与 JSON 结果仅位于 `.tmp/macos-libmpv/test/` 或 `test-hevc/`；不读取账号或用户媒体。

本次 Apple Silicon M4、libmpv 0.41.0 实测：

| 媒体 | 两种窗口像素验证 | 实际解码 | GPU |
| --- | --- | --- | --- |
| 合成 H.264 | 通过 | 初次回归未记录解码后端 | Apple M4 OpenGL |
| 合成 4K 10-bit HEVC | 通过 | videotoolbox | Apple M4 OpenGL |

HEVC 两种窗口内部平均变化约 15.70 / 10.92，外部约 0.037 / 0.025，GPU 错误为 0。
原生 UI 另核对了玻璃开关、进度跳转和全屏画面。该回归不代表已测真实网络播放、长期性能、Intel Mac 或 HDR 色彩准确性。

参考：[libmpv render API](https://github.com/mpv-player/mpv/blob/master/include/mpv/render.h)、
[OpenGL/CGL 接入约束](https://github.com/mpv-player/mpv/blob/master/include/mpv/render_gl.h)。
