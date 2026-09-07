# desktop-notifier 项目长期记忆

mylogPC 桌面通知客户端（Electron 32，main.js）。主页面窗口加载 `https://data.tygps.com/mylog-pc/`（地址存 `settingsStore.mainPageUrl`，「关于」可改），视频会议 WebRTC 跑在该窗口。托盘左键弹主页面、右键菜单含「设置」/「下载中心」。

## 已修复关键坑（勿回退）
1. **屏幕共享**（腾讯会议 AbortError 根因全链路已解）：`setupScreenShare()` 在 app.whenReady 调用，含 `setDisplayMediaRequestHandler`（desktopCapturer 枚举源）+ `setPermissionRequestHandler`（仅 tygps.com/localhost/127.0.0.1 放行 media/display-capture）。
   - **P0**：`callback({video: sources})` 回**整个数组**必 AbortError——`Streams.video` 只接受单个 `DesktopCapturerSource`。必须由 `pickScreenShareSource()` 挑**单个**源返回。
   - **P1**：`Streams.audio` 只认 `'loopback'|'loopbackWithMute'`。页面要音频而回调不回 audio 同样 AbortError；`buildScreenShareStreams` 按 `request.audioRequested` 决定是否带合法 audio。勿回退：不能传数组、不能对音频请求永远不回 audio。
   - **P2（决定性）**：TRTC v3.5.9 检测到 Electron UA 后**只查 `chrome.desktopCapture.chooseDesktopMedia` 是否存在**，不存在就报"未知错误"、根本不调任何媒体 API。preload shim 因 `contextIsolation:true`（隔离 world）**完全无效**，勿放回；勿用 contextIsolation:false。
   - **正确修复**：`src/screenshare-shim.js` 由主进程在 dom-ready/did-finish-load 后经 `executeJavaScript()` 注入 main world，提供 A. `chrome.desktopCapture.chooseDesktopMedia` mock（TRTC 首要入口，直接回 SOURCE_ID）→ TRTC 随后调 `getUserMedia({chromeMediaSource:'desktop', chromeMediaSourceId})`；B. getUserMedia 包裹兜底；C. getDisplayMedia 纯埋点。源 id 经 `window.__SCREEN_SHARE_CFG__={sourceId,audioMode}` 预置，同源 iframe 由 MutationObserver 注入。setDisplayMediaRequestHandler 照常保留。
   - 另有 `app.commandLine.appendSwitch('enable-features','WebRtcDesktopCapture')`（config 后、app ready 前）。验证：主进程见 `[main-world-shim] ... chooseDesktopMedia called ... sourceId=screen:...` → getUserMedia OK 即通。
2. **上传铃声不响**：`ringtoneResolver.toFile()` 曾把 userDataDir(已含/ringtones) 再拼 `ringtones/<hash>.mp3` → 路径重复。已先去 `ringtones/` 前缀再 join。
3. **离线/被踢提醒常驻**：`nc-close` 有 sticky 系统通知时不收窗；`NET_ONLINE` 同时 dismiss 'kick'。
4. **主窗口 openMainPage()**：关闭=隐藏非销毁、加载失败切 `src/mainpage-error.html`、点击切换语义(可见聚焦→hide)、bounds 记忆 `settingsStore.mainPageBounds`(默认 1300×700)。构造（2026-09-05 改）：`frame:true + title:'我的日志' + resizable/minimizable/maximizable:true`（系统标题栏，跟设置/诊断/工作台窗口一致）；显式去掉 `thickFrame:true`（frame:true 默认就是厚边框）。close 事件拦截为 hide（isQuitting 才真退）。`titlebar:win/state/drag`、`pushTitlebarState()`、AppHeader 自绘相关 IPC 全部保留兼容旧版页面，远程 mylog-pc 项目需同步移除 `.ah-winctrl` 三个按钮避免与系统标题栏重复（窗口控制已由 OS 提供）。
5. **托盘图标（2026-09-04 关闭闪烁）**：`setTrayState` 的 'unread' 分支不再 default↔transparent 交替，清除 blinkInterval、恒显静态彩色图标；未读数改由 tooltip 体现。
6. **会话免打扰不通知（2026-09-04）**：web 端 `layout.vue isConvMuted()`（`messageRemindType==='AcceptNotNotify'|'Discard'`，兼容 `conversationProfile?.messageRemindType`）→ `showMessage({muted})` 与 `syncUnread` 条目 `muted`（desktop-notifier.ts 两处类型已加 `muted?: boolean`）→ 桌面 `notificationCenter.pushMessage` 中 muted 会话不 showWindow/不响铃但**仍入 unreadMap 列表**（手动可查）；`syncUnread` 用 `addedNonMuted`（新增且非免打扰才弹窗）。web 自带 HTML5 通知/响铃（`sendMessageNotification`/`triggerMessageAlert`）也加 `&& !isConvMuted(newConv)` 门控。
   - ⚠️ 2026-09-04 复测仍弹窗加固：TUIKit conversationList 项可能**不带 messageRemindType**（engine-lite proxy 才暴露）。加**免打扰权威叠加层**——GroupChatSettingPanel `handleToggleMute` 成功广播 `mylog:conv-muted`{conversationId:'GROUP'+id,muted}；layout.vue 维护 `mutedConvOverride` Map，isConvMuted 优先取 override（开启置 true 防漏；取消 delete 回落 SDK 字段，勿改成布尔覆盖——会压制其它端状态）。

## 约定
- **header 架构（AppHeader.vue 统一头部）**：左区头像(用户名+状态点)+应用名隐藏+快捷操作(无审批角标)；中区搜索框绝对居中(Ctrl K)；右区消息中心+窗口控制。头像菜单含桌面端项(铃声/特别关注/下载中心/调试窗口,调 `electronAPI.titlebarMenu`)。layout.vue 仅转发 @join-meeting/@dismiss/@view-comment/@change-password/@logout。desktop-notifier 已删全部注入 CSS（TITLEBAR_CSS 等，titlebar-inpage.js=死文件）。**勿回退**：勿恢复 TITLEBAR_CSS 注入（隐藏 .app-header 致双头错位）；勿恢复审批角标。
  - **拖拽（2026-09-04 已解）**：`.app-header` 加 `-webkit-app-region: drag`；交互控件 no-drag——`.ah-user/.ah-msg/.ah-winctrl/.ah-menu` + 兜底 `.app-header :is(button,a,input,textarea,[role='button'],[contenteditable='true']){no-drag}`；`HeaderSearch.vue .hs-wrap` no-drag（搜索框居中仍可拖其外空白）。
    - ⚠️ **远程页 CSS drag 可能失效**（main.js titlebar:drag 注释先例：注入样式/页面合成层影响）。AppHeader 已加 **JS 拖拽兜底**：header 空白 mousedown(左键)→`electronAPI.titlebarDrag('begin')`，window mouseup/blur→'end'，双击空白→winAction('maximize')；阻断选择器 `.ah-user,.ah-msg,.ah-winctrl,.ah-menu,.hs-wrap,button,a,input,textarea,[role='button'],[contenteditable='true']`。原生 drag 生效时 mousedown 被系统吞→兜底静默，二者互补。主进程接收端 main.js `titlebar:drag`（16ms setBounds、begin 先还原最大化、15s 安全上限）+ preload `titlebarDrag` 本就绪，勿删。
  - **窗口状态推送（2026-09-04）**：main.js `pushTitlebarState()`（maximized = isMaximized||isFullScreen）监听 maximize/unmaximize/enter-full-screen/leave-full-screen，ready-to-show 初始推一次；preload 暴露 `onTitlebarState`；AppHeader 用 `isMaximized` 切换"最大化/还原"图标。winctrl 高度 40px、`.ah-wc` height:100%。IPC：`titlebar:win`(minimize/maximize/close)/`titlebar:quick-action`/`titlebar:menu`/`titlebar:drag` 保留。
  - ⚠️ 遗留：设备状态事件源(TUICallKit/TRTC 桥接)未接；"创建执行"业务指向未确认(预留 `mylog:open-exec`)；StatusIndicator.vue 死文件。web 构建需 `NODE_OPTIONS=--max-old-space-size=16384`。
- **托盘未读来源**：`unreadCount` 只由 web `UPDATE_UNREAD_COUNT`（layout.vue 监听 filteredUnReadCount 实时推 + onConnectionChange 补发）写入；`onUnreadChange=()=>{}` **勿再接回**（syncUnread 聚合残留陈旧项致"无未读也闪"）。通知弹窗列表仍由 SYNC_UNREAD→`nc-unread` 提供，与托盘解耦。
- **下载中心**：`setWindowOpenHandler` 按 `DOWNLOAD_EXT_RE` 白名单(40+ 类)命中即 downloadURL，外链 openExternal；`handleWillDownload()` 落盘用户下载目录、同名加序号、`global.__dlSessionBound` 防重复注册；面板 `src/downloads-window.html`(无边框 400×480，锚定主页面右上角)，入口：主窗口「下载」子菜单+托盘；IPC `downloads:list/open/open-folder/cancel/clear`。
- 设置窗口 icon=`assets/icon.ico`；call/meeting 浮窗 `frame:false+skipTaskbar:true+minimizable:false` icon 不可见无需补。联系人添加候选浮层支持中文名模糊搜索(`openContactPicker`)。
- 打包：files 含 `assets/**/*` 与 `src/**/*`，新增本地 html 无需改打包配置。
- 安全提醒（用户曾要求忽略）：主页面窗口复用 makeWebPrefs，preload 把 electronAPI 桥暴露给远程页，发布前建议做远程内容隔离。

## 工作台（workbench-window）
- 主题蓝色系；象限配色 `#E11D48/#1D4ED8/#B45309/#64748B`。
- 类型 20 类（工程机械）：event/meeting/call/business/report/repair/find + customer/sales/contract/delivery/excavator/loader/crane/parts/training/rent + task/cycle-meeting/cycle-task。**三处白名单同步**：store TASK_TYPES / JS TYPE_ICONS+TYPE_LABELS+TYPE_ORDER / 筛选面板。
- 筛选模型 `filterTypes(Set)+filterDone('all'|'todo'|'done')+filterOverdue`，勿回退旧 filterType+hideDone。
- 侧栏通知数据源=notificationCenter.js：sysAlerts/unreadMap/approvals(SYNC_APPROVALS 整表替换)；渲染层 `workbench-nc-data` 30s 轮询+focus 刷新。
- 地图=高德 JS API 2.0（webapi.amap.com），Key 用户自备存 `settingsStore.mapKey`，**禁止内置 Key**；locateMe HTML5 geolocation→CitySearch 兜底；SAFE_PERMISSIONS 放行 geolocation；GCJ-02 仅存本机。
- 预览=浏览器 mock（无 electronAPI 自动降级）；真实能力需重启 Electron。

## 桌面↔网页 通话协调
- **铃声单一来源**：桌面已连接(`isAgentAvailable()`)时网页不播被叫铃声——layout.vue `TUICallKitAPI.enableMuteMode(isAgentAvailable())` 关 TUICallKit 来电铃音(仅被叫铃音，主叫等待音不受影响)，onConnectionChange 实时切换；会议铃声 alertService.startRingtoneLoop 在 handleMeetingReceived 用 `if(!isAgentAvailable())` 门控。
- **接听置顶**：桌面点「接听」→ main.js `focusMainPage()`（show+focus+短暂 alwaysOnTop）；**勿用** openMainPage()（可见聚焦→hide 会误隐藏）。
- 链路：网页 SHOW_CALL_NOTIFICATION → 桌面弹窗 → 用户接听 → IPC call-action/meeting-action → 广播 USER_ACTION{accept} → 网页 onUserAction → TUICallKitAPI.accept()/会议 handler。
