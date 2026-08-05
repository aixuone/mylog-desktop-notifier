# desktop-notifier 项目长期记忆

mylogPC 桌面通知客户端（Electron 32，main.js 入口）。主页面窗口加载 `https://data.tygps.com/mylog-pc/`，视频会议 WebRTC 跑在该窗口内。托盘左键弹主页面，右键菜单含「设置」。

## 已修复的关键坑（勿回退）
  1. **屏幕共享不可用**：Electron 远程页调 `getDisplayMedia` 必须由主进程提供屏幕源。已加 `setupScreenShare()`（app.whenReady 调用）：
   - `session.defaultSession.setDisplayMediaRequestHandler` 内用 `desktopCapturer.getSources({types:['screen','window']})` 返回源；
   - 配套 `setPermissionRequestHandler` 仅对可信域名（tygps.com/localhost/127.0.0.1）放行 `media` 与 `display-capture`，其余默认拒绝。
   - ⚠️ **根因（腾讯会议“意外出错 / AbortError: Error starting capture”）已定位并修复**：
     - **P0（真正的病根）**：`setDisplayMediaRequestHandler` 的回调 `callback({video: sources})` 把**整个数组**回给 Electron，但 `Streams.video` 类型要求单个 `DesktopCapturerSource`（见 electron.d.ts 第 20943 行 `video?: Video | WebFrameMain`）。传数组 → Electron 无法解析唯一源 → 捕获启动即 `AbortError`，**音视频同求与纯视频都会失败**（这也正是“环境层枚举 N 个源正常、端到端却 AbortError”的原因）。修复：`pickScreenShareSource()` 按请求类型挑单个源返回。
     - **P1（次要）**：`Streams.audio` 只接受 `'loopback' | 'loopbackWithMute'`。腾讯会议 SDK 调 `getDisplayMedia({audio:true})` 请求系统音频，若页面要音频而回调不回 audio，Electron 同样 `AbortError`。`buildScreenShareStreams` 读 `request.audioRequested`，为真时给合法 audio（用户选 loopback/loopbackWithMute 用之，否则兜底 `loopbackWithMute`）；为假才回纯 `{video: 单源}`。
     - **勿回退**：①不能把数组回给 callback（必 AbortError）；②不能对音频请求“永远不回 audio”（必 AbortError）。Windows 系统音频 loopback 走 WASAPI，客户机 Chrome 能正常共享系统声音即说明可用；个别机器若 loopback 真失败，诊断窗④切模式验证。
     - 另：`app.commandLine.appendSwitch('enable-features','WebRtcDesktopCapture')` 已加（config 加载后、app ready 前），稳定捕获链路。仍不生效且确需时再考虑 `--no-sandbox`（有安全回退，本应用加载远程页且 preload 桥接 IPC，默认不关沙箱）。
   - **P2（诊断窗 getDisplayMedia 通过、腾讯会议室仍失败 → 决定性根因）**：DevTools 日志铁证——TRTC/TUICallEngine v3.5.9 在检测到 Electron UA（`Electron/32.3.3`）后，**优先检查 `chrome.desktopCapture.chooseDesktopMedia` API 是否存在**。找不到 → 认定屏共享不可用 → 直接报"未知错误"，**根本不调任何 getDisplayMedia/getUserMedia API**（这也解释了为什么日志里从未出现 `[ScreenShare]` handler 记录、也从未出现 `chromeMediaSource:'desktop'` 的 getUserMedia 调用）。Agora RTC_AMBULANCE 只打了 `getUserMedia` 的"非原生"警告，未干扰 `getDisplayMedia`。
   - **⚠️ P2 修正1（preload shim 完全无效）**：`makeWebPrefs()` 开了 `contextIsolation:true`，preload 运行在**隔离 world**，对 `navigator.mediaDevices.getUserMedia` 和 `chrome.desktopCapture` 的包裹**渗透不到网页 main world**。腾讯 SDK 在 main world 调的是网页自己的 API，永远绕过 preload 的 shim。**勿回退**：① 不要把 shim 放回 preload（contextIsolation 下必然无效）；② 不要用 `contextIsolation:false` 替代（安全回退）。
   - **⚠️ P2 修正2（chrome.desktopCapture 是关键入口）**：正确修复必须在 main world 提供 `chrome.desktopCapture.chooseDesktopMedia` mock——让 TRTC 检测到"扩展可用" →  `chooseDesktopMedia` 获取 `streamId`（实际返回主进程枚举的首选屏幕源 id）→ 调 `getUserMedia({chromeMediaSource:'desktop', chromeMediaSourceId: streamId})` → 原生 Electron getUserMedia 支持 `chromeMediaSource` 约束 → 捕获成功。**勿回退**：不能去掉 `chrome.desktopCapture` mock（去掉后 TRTC 会认定屏共享不可用、不调任何 API）。
   - **正确修复**：`src/screenshare-shim.js` 在 main world 提供三项关键能力：
     A. `chrome.desktopCapture.chooseDesktopMedia` mock（TRTC 屏共享的首要入口，直接回 SOURCE_ID）
     B. `getUserMedia` 包裹（兜底注入 chromeMediaSourceId，对 TRTC 已带 sourceId 的调用透传）
     C. `getDisplayMedia` 包裹（纯埋点，handler 已在主进程正常工作）
     由主进程在 `dom-ready`+`did-finish-load` 后经 `webContents.executeJavaScript()` 注入。源 id 通过 `window.__SCREEN_SHARE_CFG__={sourceId,audioMode}` 预置。同源 iframe 也注入（MutationObserver 监控动态 iframe）。`setDisplayMediaRequestHandler` 照常保留（覆盖新版 SDK 若用 getDisplayMedia 的情形）。
   - **验证预期**：主进程控制台应出现 `[MainPage Media] [main-world-shim] chrome.desktopCapture.chooseDesktopMedia called | types=... | sourceId=screen:...`（证实 TRTC 走 Chrome 扩展路径并拿到 sourceId），随后 `getUserMedia request {video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId:'screen:...'}}}`（证实 TRTC 带完整约束调 getUserMedia）→ `getUserMedia OK` → 屏共享可用。
2. **上传铃声不响**：`lib/ringtoneResolver.js` 的 `toFile()` 旧逻辑把 `userDataDir`(已含/ringtones) 与 `ringtones/<hash>.mp3` 拼接成 `.../ringtones/ringtones/...`，文件不存在。已改为先去掉 `ringtones/` 前缀再 join。
3. **离线/被踢提醒常驻**：`nc-close` 在有 sticky 系统通知时不再收起窗口；`NET_ONLINE` 时同时 dismiss 'kick'；渲染层离线/被踢卡片加常驻提示。
4. **主页面窗口 `openMainPage()`**：关闭=隐藏(非销毁)、加载失败切本地兜底页 `src/mainpage-error.html`、点击切换语义(可见聚焦→hide)、窗口尺寸位置记忆到 `settingsStore.mainPageBounds`(首次默认 1300×700)。

## 约定
- 设置窗口 `icon` 已设 `assets/icon.ico`；call/meeting 浮窗为 `frame:false`+`skipTaskbar:true`+`minimizable:false`，icon 不可见，**无需补**（之前已核查）。
- 联系人专属设置：添加联系人候选浮层支持按中文名称(name)模糊搜索（`src/settings-window.html` openContactPicker）。
- 主页地址存 `settingsStore.mainPageUrl`，默认 `https://data.tygps.com/mylog-pc/`，在「关于」面板可编辑。
- 打包：`package.json` 的 files 含 `assets/**/*` 与 `src/**/*`，新增本地 html 资源无需改打包配置。
- 安全提醒（用户曾要求忽略）：主页面窗口复用 `makeWebPrefs()`，preload 把业务 IPC 桥(`electronAPI`)暴露给远程网页，正式发布前建议做远程内容隔离。
