// preload.js - Preload script (secure IPC bridge)
// Call & toast windows use this to safely communicate with the main process

const { contextBridge, ipcRenderer } = require('electron')

console.log('[Preload] Loaded')

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Call window ──────────────────────────────
  /** Send user action (accept/reject/ignore/timeout) for audio/video calls */
  sendCallAction: (action) => ipcRenderer.send('call-action', action),

  /** Receive call data (caller info + ringtone path) */
  onCallData: (callback) => ipcRenderer.on('call-data', (_, data) => callback(data)),

  /** Receive stop ringtone command */
  onStopRingtone: (callback) => ipcRenderer.on('stop-ringtone', () => callback()),

  /** Receive ringtone preload (sent on page load, before any call arrives) */
  onPreloadRingtone: (callback) => ipcRenderer.on('preload-ringtone', (_, data) => callback(data)),

  /** Receive call closed command (reset timer state) */
  onCallClosed: (callback) => ipcRenderer.on('call-closed', () => callback()),

  // ─── Meeting window ───────────────────────────
  /** Send user action (accept/reject/timeout) for meeting invitations */
  sendMeetingAction: (action) => ipcRenderer.send('meeting-action', action),

  /** Receive meeting invite data */
  onMeetingData: (callback) => ipcRenderer.on('meeting-data', (_, data) => callback(data)),

  /** Receive meeting closed command (reset timer state) */
  onMeetingClosed: (callback) => ipcRenderer.on('meeting-closed', () => callback()),

  // ─── Toast window (legacy, kept for compat) ──
  /** Close message toast */
  closeToast: () => ipcRenderer.send('close-toast'),

  /** Receive toast data (sender info + message) */
  onToastData: (callback) => ipcRenderer.on('toast-data', (_, data) => callback(data)),

  // ─── Notification center window ──────────────
  /** 首帧初始化数据 */
  onNcInit: (callback) => ipcRenderer.on('nc-init', (_, data) => callback(data)),
  /** 会话未读列表刷新 */
  onNcUnread: (callback) => ipcRenderer.on('nc-unread', (_, data) => callback(data)),
  /** 新增/更新系统卡 */
  onNcSysAlert: (callback) => ipcRenderer.on('nc-sysalert', (_, data) => callback(data)),
  /** 移除系统卡 */
  onNcSysAlertDismiss: (callback) => ipcRenderer.on('nc-sysalert-dismiss', (_, data) => callback(data)),
  /** 设置变更（实时响应显示方式/时长） */
  onNcSettingsChanged: (callback) => ipcRenderer.on('nc-settings-changed', (_, data) => callback(data)),
  /** 播放消息/系统铃声（path 为 null 则不播） */
  onNcPlay: (callback) => ipcRenderer.on('nc-play', (_, data) => callback(data)),

  /** 打开会话（主进程 shell.openExternal） */
  openConversation: (conversationId, url) => ipcRenderer.send('nc-open-conversation', { conversationId, url }),
  /** 标记已读（id 或 'all'） */
  markRead: (id) => ipcRenderer.send('nc-mark-read', id),
  /** 消隐系统卡 */
  dismissSysAlert: (id) => ipcRenderer.send('nc-dismiss-sysalert', id),
  /** 重新登录（被踢） */
  reconnect: () => ipcRenderer.send('nc-reconnect'),
  /** 收起窗口 */
  closeNc: () => ipcRenderer.send('nc-close'),
  /** 动态调整通知中心高度 */
  resizeNc: (height) => ipcRenderer.send('nc-resize', height),

  // ─── Settings window ─────────────────────────
  /** 读取全部设置（invoke，返回 { settings, presets, names, localRingtones, contacts }） */
  settingsLoad: () => ipcRenderer.invoke('settings-load'),
  /** 局部保存设置 */
  settingsSave: (partial) => ipcRenderer.send('settings-save', partial),
  /** 删除指定联系人的专属铃声设置（真正移除 key，区别于合并式 settingsSave） */
  removeContactRingtone: (cid) => ipcRenderer.send('settings-remove-contact', cid),
  /** 上传自定义铃声（invoke，返回 { path, name }） */
  pickRingtone: () => ipcRenderer.invoke('pick-ringtone'),
  /** 设置开机启动 */
  setAutoStart: (value) => ipcRenderer.send('set-auto-start', value),
  /** 拉取当前在线用户列表（与托盘右键菜单一致） */
  trayUsersGet: () => ipcRenderer.invoke('tray-users-get'),
  /** 订阅在线用户列表实时更新 */
  onTrayUsers: (callback) => ipcRenderer.on('tray-users-update', (_, data) => callback(data)),

  // ─── Diagnostics (自检：自动 + 手工) ──────────
  /** 打开诊断测试窗口 */
  openDiagnostics: () => ipcRenderer.send('open-diagnostics'),
  /** 拉取显示环境信息 + 权限矩阵 + 窗口状态 + 铃声校验 */
  diagDisplayInfo: () => ipcRenderer.invoke('diag:display-info'),
  /** 仅拉取主页面域权限矩阵 */
  diagPermissionMatrix: () => ipcRenderer.invoke('diag:permission-matrix'),
  /** 运行自动检查（arg.fullscreenOk 由渲染进程回填 requestFullscreen 结果） */
  diagRunAuto: (arg) => ipcRenderer.invoke('diag:run-auto', arg),
  /** 推送一条测试通知卡（手工"触发弹窗"） */
  diagPushTest: () => ipcRenderer.send('diag:push-test'),
  /** 试播消息铃声（手工"播放铃声"） */
  diagPlayRingtone: () => ipcRenderer.send('diag:play-ringtone'),
  /** 关闭测试弹窗（手工"关闭弹窗"） */
  diagCloseTest: () => ipcRenderer.send('diag:close-test'),

  // ─── 诊断扩展（P0+P1 补充项）──
  /** 屏幕共享源获取实测 */
  diagScreenCapture: () => ipcRenderer.invoke('diag:screencapture'),
  /** 运行时切换屏幕共享音频模式（mute / loopback / loopbackWithMute），排查 SDK 是否需音频轨道 */
  diagSetScreenShareAudio: (mode) => ipcRenderer.invoke('diag:set-screenshare-audio', mode),
  /** 通知点击聚焦验证（FOCUS_CONVERSATION / 回退 openExternal） */
  diagFocus: (data) => ipcRenderer.invoke('diag:focus', data),
  /** 网页端离线/被踢常驻通知验证 */
  diagSysAlert: () => ipcRenderer.invoke('diag:sysalert'),
  /** 铃声多场景解析（message/call/meeting/联系人专属） */
  diagRingtoneScenes: () => ipcRenderer.invoke('diag:ringtone-scenes'),
  /** 来电浮窗弹出验证 */
  diagShowCall: () => ipcRenderer.invoke('diag:show-call'),
  /** 会议浮窗弹出验证 */
  diagShowMeeting: () => ipcRenderer.invoke('diag:show-meeting'),
  /** 通知模式联动验证（dnd 下弹窗抑制 + 铃声静音） */
  diagModeLinkage: () => ipcRenderer.invoke('diag:mode-linkage'),

  // ─── Screen-share shim 埋点（main world 注入的 shim 调用）──
  /** 上报主页面实际使用的媒体捕获路径，便于定位屏幕共享失败原因 */
  logMedia: (msg) => ipcRenderer.send('page-media-log', msg),

  // ─── Browser ──────────────────────────────────
  /** Open browser to conversation page */
  openBrowser: (url) => ipcRenderer.send('open-browser', url),
})

// 屏幕共享 main-world shim 已迁移到 src/screenshare-shim.js，由主进程在页面加载完成后
// 通过 webContents.executeJavaScript 注入（contextIsolation=true 下 preload 包裹无法影响网页，
// 故必须注入 main world）。此处仅保留埋点上报通道供其调用。
