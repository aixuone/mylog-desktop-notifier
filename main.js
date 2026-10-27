// main.js - Electron main process: tray + WS server + HTTP server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage, dialog, session, desktopCapturer, globalShortcut, clipboard, Notification, screen, safeStorage } = require('electron')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const http = require('http')
const https = require('https')
const fs = require('fs')
const url = require('url')
const net = require('net')
const zlib = require('zlib')
const { execFile } = require('child_process')

// ─── Feature modules (M1+) ──────────────────────
const settingsStore = require('./lib/settingsStore')
const workbenchStore = require('./lib/workbenchStore')
const { createRingtoneResolver } = require('./lib/ringtoneResolver')
const { createNotificationCenter } = require('./lib/notificationCenter')
const appLog = require('./lib/appLog')

// ─── Single instance lock ──────────────────────────
// Prevent multiple instances of the notifier from running,
// which would cause self-conflict on ports.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.log('[App] Another instance of MyLog Notifier is already running. Exiting.')
  app.quit()
  process.exit(0)
}

// Handle second instance: focus the existing tray (no-op, just log)
app.on('second-instance', (event, commandLine, workingDirectory) => {
  console.log('[App] Second instance detected, focus ignored (tray app)')
})

// ─── Load config ──────────────────────────────────────────
const config = require('./config.js')
console.log('[Config] Loaded from config.js')

// ─── 屏幕共享捕获管线修复（getDisplayMedia AbortError）──
// 启用 WebRTC 桌面捕获特性，稳定 Electron 内 getDisplayMedia 的捕获启动链路。
// 注意：刻意不关闭 Chromium 沙箱——本应用会加载远程页面并通过 preload 桥接 IPC，
// 关沙箱是安全回退，仅当此开关仍不生效、且确认需要时再考虑 --no-sandbox。
app.commandLine.appendSwitch('enable-features', 'WebRtcDesktopCapture')

// ─── 关闭 Chromium「窗口被遮挡即停渲染」（保护本应用自己的窗口）──
// 【作用范围要说清】这些开关只影响**本应用（Electron）自己的窗口**，对浏览器等其它进程无效。
//   真正导致「一开画笔、浏览器里的视频就卡住」的是别的进程的遮挡判定，解法是给覆盖窗补
//   WS_EX_TOOLWINDOW（见 forceToolWindowStyle）——那份豁免对任何 Chromium 应用都成立。
//   这几个开关是给**我们自己的窗口**留的保险：会议主窗口被别的应用盖住时，别把它的渲染/定时器
//   降级，否则会议里对方的视频也会卡住 —— 对会议类应用，这个取舍是必要的。
//   （注：主窗口已设 backgroundThrottling:false，但那**只**保证 visibilityState 不被置 hidden，
//    挡不住遮挡侧的停渲染，故仍需这几个开关。）
// 开关：① disable-features=CalculateNativeWinOcclusion 关闭遮挡计算
//       ② disable-backgrounding-occluded-windows      被遮挡的窗口不再被 backgrounded
//       ③ disable-renderer-backgrounding              渲染进程不因后台化而降级
// 代价：被遮挡的窗口不再自动省电（多耗少量 GPU/CPU）。
// 注意：① 必须与其它 disable-features 值合并，直接 appendSwitch 会覆盖已有值；
//       ② 这里刻意用「函数声明 + 调用」，不用 `(function(){...})()` 的 IIFE ——
//          上一行 appendSwitch(...) 没写分号时，以 `(` 开头的下一行会被解析为「调用上一行的返回值」
//          （ASI 陷阱），运行时报 `appendSwitch(...) is not a function`；`node --check` 查不出来。
function applyAntiOcclusionSwitches() {
  var SWITCH = 'disable-features'
  var FEATURE = 'CalculateNativeWinOcclusion'
  var existing = app.commandLine.hasSwitch(SWITCH) ? app.commandLine.getSwitchValue(SWITCH) : ''
  var all = (existing ? existing.split(',') : []).filter(function (f) { return f && f !== FEATURE })
  all.push(FEATURE)
  app.commandLine.appendSwitch(SWITCH, all.join(','))
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}
applyAntiOcclusionSwitches()

// ─── Global state ──────────────────────────────────────────
let tray = null
let wsServer = null
let httpServer = null
let callWindow = null        // incoming audio/video call popup (screen center)
let meetingWindow = null     // incoming meeting invitation popup
let toastWindow = null       // message toast (bottom right)
let isQuitting = false
let currentWsPort = config.wsPort
let currentHttpPort = 0
const version = config.version

// ─── Feature module instances (assigned in whenReady) ──
let ringtoneResolver = null
let notificationCenter = null
let settingsWindow = null      // 设置面板单例窗口
let diagnosticsWindow = null   // 诊断测试窗口单例
let workbenchWindow = null     // 个人工作台窗口单例
let downloadsWindow = null     // 下载中心面板窗口单例
let boardOverlayWindow = null  // 画板「真·OS 全屏」透明覆盖窗口单例
let emailWindow = null         // 邮箱窗口单例
let lastSharedScreen = null    // 共享源（选源窗口路径，优先级高）：{ type:'screen'|'window', displayId, name }
let shimShareSource = null     // 共享源（shim 路径：SDK 实际共享的那个源，桌面端的主路径）
// 本机（桌面端）当前是否真的在共享屏幕。
// ⚠ 真机实测（userData/board-overlay.log）：桌面端会议共享走 getDisplayMedia →
//   setDisplayMediaRequestHandler（选源窗口也在那里），而 shim 的
//   chrome.desktopCapture.chooseDesktopMedia 从未被 SDK 调用
//   —— 日志中 'IPC board-overlay:share-started' 出现 0 次。
//   因此「共享已开始」的唯一可靠时机是 setDisplayMediaRequestHandler 授予源的那一刻。
let screenShareActive = false
let downloads = []             // 下载任务：[{ id, filename, savePath, url, state, receivedBytes, totalBytes, item }]
let downloadSeq = 0            // 自增 id
// ─── Tray icon state management ───────────────────────────
// States: 'default' (connected, normal) | 'gray' (disconnected) | 'ringing' (incoming call) | 'unread' (unread messages)
let trayIconState = 'gray'    // Start gray (no connections yet)
let blinkInterval = null      // setInterval reference for blinking
let blinkPhase = false        // true = showing alternate icon, false = showing primary icon
let isRinging = false         // 来电/会议响铃瞬态：结束后必须显式清除，否则 deriveTrayState 会一直返回 ringing

// Pre-loaded nativeImage cache for tray icons (avoids disk I/O on every blink)
const iconCache = {}

function loadIconCache() {
  for (const [key, relPath] of Object.entries(config.icons)) {
    const fullPath = path.join(__dirname, relPath)
    if (fs.existsSync(fullPath)) {
      iconCache[key] = nativeImage.createFromPath(fullPath)
      console.log('[Tray] Loaded icon:', key, '→', relPath)
    } else {
      console.warn('[Tray] Icon file not found:', fullPath)
    }
  }
  // Fallback: if gray icon missing, create from default by desaturating
  if (!iconCache.gray && iconCache.default) {
    iconCache.gray = iconCache.default
  }

  // Generate transparent icon for "unread" blinking (toggles default ↔ transparent)
  const TRANSPARENT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const transBase = nativeImage.createFromBuffer(Buffer.from(TRANSPARENT_PNG_B64, 'base64'))
  if (transBase && !transBase.isEmpty() && iconCache.default) {
    const sz = iconCache.default.getSize()
    if (sz.width > 0 && sz.height > 0) {
      iconCache.transparent = transBase.resize({ width: sz.width, height: sz.height })
    }
  }
  if (!iconCache.transparent) {
    iconCache.transparent = transBase
  }
}

// ─── 单色关机(电源)图标：零依赖手写 PNG 编码 ─────────────
function crc32(buf) {
  if (!crc32.t) {
    crc32.t = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      crc32.t[n] = c >>> 0
    }
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.t[(crc ^ buf[i]) & 0xFF]
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const cd = Buffer.concat([t, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0)
  return Buffer.concat([len, cd, crc])
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}
// 绘制电源符号：开口圆环 + 顶部竖线，单色 (90,90,90) 透明底
function makeShutdownIcon(size) {
  size = size || 64
  const s = size, cx = s / 2, cy = s / 2
  const R = s * 0.33, w = Math.max(2, Math.round(s * 0.12))
  const gap = (32 * Math.PI) / 180, ext = s * 0.16
  const buf = Buffer.alloc(s * s * 4)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4
      const dx = x - cx, dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      let on = false
      if (Math.abs(d - R) <= w / 2) {
        let ang = Math.atan2(-dy, dx)            // 0=右, π/2=上
        if (ang < 0) ang += 2 * Math.PI
        let diff = Math.abs(ang - Math.PI / 2)
        if (diff > Math.PI) diff = 2 * Math.PI - diff
        if (diff > gap) on = true
      }
      if (!on && Math.abs(dx) <= w / 2 && y <= cy && y >= cy - (R + ext)) on = true
      if (on) { buf[i] = 90; buf[i + 1] = 90; buf[i + 2] = 90; buf[i + 3] = 255 }
      else buf[i + 3] = 0
    }
  }
  return nativeImage.createFromBuffer(encodePNG(s, s, buf))
}
let SHUTDOWN_ICON = null
function getShutdownIcon() {
  if (!SHUTDOWN_ICON) {
    try { SHUTDOWN_ICON = makeShutdownIcon(64).resize({ width: 16, height: 16 }) } catch (e) { SHUTDOWN_ICON = null }
  }
  return SHUTDOWN_ICON
}

// 头像落盘后：写入连接项 + userId 缓存 + 触发菜单重建
function storeClientIcon(wsClient, iconPath) {
  const entry = connectedClients.get(wsClient)
  if (entry) {
    entry.localIconPath = iconPath
    connectedClients.set(wsClient, entry)
    if (entry.userId) userIconCache.set(entry.userId, iconPath)
    updateTrayMenu()
    if (entry.userId === currentUser.userId) localUserIconPath = iconPath
  }
}

// 防御性加载菜单图标：空图/损坏格式返回 null，绝不抛异常
function loadMenuIcon(p) {
  if (!p || !fs.existsSync(p)) return null
  try {
    const img = nativeImage.createFromPath(p)
    if (img.isEmpty()) return null
    const r = img.resize({ width: 18, height: 18 })
    return (r && !r.isEmpty()) ? r : img
  } catch (_) { return null }
}

/** Check if any client is currently connected via WebSocket */
function hasConnectedClients() {
  return Array.from(connectedClients.values()).some(u => u.connected)
}

/** Mark a WS client as offline and update tray icon to gray (if no clients left) */
function markClientOffline(ws, reason) {
  if (!ws || !connectedClients.has(ws)) return
  const entry = connectedClients.get(ws)
  entry.connected = false
  entry.lastSeenAt = Date.now()
  connectedClients.set(ws, entry)
  updateTrayMenu()

  // If no more connected clients and not ringing → switch to gray with reason in tooltip
  if (!hasConnectedClients() && !isRinging) {
    setTrayState('gray')
    tray?.setToolTip(`e日志-通知助手 | ${reason}`)
  }
}

/**
 * Set tray icon state with optional blinking.
 * - 'default':  solid default icon (no blink)
 * - 'gray':     solid gray icon (no blink)
 * - 'ringing':  solid ringing icon (NO blink — 来电/会议期间不闪烁)
 * - 'unread':   ONLY blink condition: default ↔ transparent (500ms)
 */
function setTrayState(state) {
  if (!tray) return

  // Stop any existing blink
  if (blinkInterval) {
    clearInterval(blinkInterval)
    blinkInterval = null
  }
  blinkPhase = false

  const prevState = trayIconState
  trayIconState = state
  isRinging = (state === 'ringing')

  switch (state) {
    case 'default':
      tray.setImage(trayIcon(iconCache.default || iconCache.ringing || iconCache.unread))
      break

    case 'gray':
      tray.setImage(trayIcon(iconCache.gray || iconCache.default))
      break

    case 'ringing':
      // 来电/会议期间：显示静态彩色图标，不闪烁（按需求：闪烁仅在「有未读消息」时触发）
      tray.setImage(trayIcon(iconCache.ringing || iconCache.default))
      break

    case 'unread':
      // 不闪烁：始终显示静态彩色图标（按需求：托盘图标关闭闪烁、保持一直显示）。
      // 仅靠图标无法表达"有未读"，未读数改由 UPDATE_UNREAD_COUNT 文案(托盘 tooltip)体现。
      if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null }
      tray.setImage(trayIcon(iconCache.default))
      break

    default:
      console.warn('[Tray] Unknown state:', state)
      tray.setImage(trayIcon(iconCache.default))
  }

  if (prevState !== state) {
    console.log('[Tray] Icon state:', prevState, '→', state)
  }
  // 标题栏连接状态与托盘图标同源
  try { pushTitlebarStatus() } catch (e) {}
}

/** 来电/会议提醒结束后，显式清除响铃瞬态并恢复真实图标状态 */
function endRingingState() {
  isRinging = false
  setTrayState(deriveTrayState())
}

/** Derive the correct icon state based on current conditions */
function deriveTrayState() {
  // Priority: ringing > unread(IM+邮件) > default/gray
  if (isRinging) return 'ringing'  // Don't auto-override ringing
  if (unreadCount > 0) return 'unread'
  return hasConnectedClients() ? 'default' : 'gray'
}

let unreadCount = 0

// ─── Cross-platform tray icon helper ─────────────────────
// macOS menu bar icons should be 16×16 (template image); Windows uses native size
function trayIcon(img) {
  if (!img) return img
  if (process.platform === 'darwin') {
    return img.resize({ width: 16, height: 16 })
  }
  return img
}

// User info from browser - supports multiple users (keyed by ws client id)
// connectedClients: Map<ws, { clientId, userId, userName, userIcon, browserType, connected, localIconPath, lastSeenAt }>
let connectedClients = new Map()

// 头像按 userId 缓存（与易失的 connectedClients 条目解耦，避免重连 reclaim 时丢失）
const userIconCache = new Map()

// ─── Stale entry cleanup config ────────────────────────────
// Disconnected entries older than this will be removed from the tray
const STALE_ENTRY_TTL_MS = 300_000   // 5 minutes
let cleanupTimer = null               // reference for interval timer

// Legacy single-user reference (for backward compat with tray icon logic)
let currentUser = {
  userId: '',
  userName: '',
  userIcon: '',
  browserType: ''
}

// Local path for downloaded user icon (primary user)
let localUserIconPath = ''

// Client ID counter
let clientIdCounter = 0

const PRELOAD_PATH = path.join(__dirname, 'src', 'preload.js')
const CALL_W = config.callWindow.width
const CALL_H = config.callWindow.height
const MEETING_W = config.meetingWindow.width
const MEETING_H = config.meetingWindow.height

// Ringtone configuration from config
const RINGTONE_FILE = path.join(__dirname, config.ringtone.path)
function getRingtonePath() {
  if (fs.existsSync(RINGTONE_FILE)) {
    return 'file:///' + RINGTONE_FILE.replace(/\\/g, '/')
  }
  return ''
}

// Deduplication: prevent duplicate notifications from multiple browser tabs
const recentCalls = new Map()
const recentToasts = new Map()
const DEDUP_CALL_WINDOW_MS = config.deduplication.callWindowMs
const DEDUP_TOAST_WINDOW_MS = config.deduplication.toastWindowMs

// 消息通知已统一走通知中心（notificationCenter），不再使用逐条重建的 toast 窗口

// Check if acrylic material is supported (Win10 1803+)
function supportsAcrylic() {
  return process.platform === 'win32'
}

// Shared webPreferences for notification windows
function makeWebPrefs() {
  return {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    autoplayPolicy: 'no-user-gesture-required',
  }
}

// ─── Permission policy (shared) ──────────────────
// 可信来源：官方域名 / 本地回环 / 本机内置页面(file://，仅我们自己的 UI)。
// 仅对可信来源放行一组"安全"Web API；危险权限(camera 等)即便可信也默认拒绝。
var TRUSTED_RE = /^https?:\/\/(?:[^\/]+\.)?tygps\.com|^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)|^file:\/\//i
var SAFE_PERMISSIONS = ['media', 'display-capture', 'fullscreen', 'clipboard-read', 'clipboard-write', 'pointerLock', 'notifications', 'geolocation']
function permissionAllowed(url, permission) {
  return TRUSTED_RE.test(url || '') && SAFE_PERMISSIONS.indexOf(permission) !== -1
}

// ─── Screen sharing (getDisplayMedia) ─────────────
// Electron 不会把屏幕/窗口源直接暴露给调用 navigator.mediaDevices.getDisplayMedia() 的页面，
// 必须由主进程注册 display media request handler 来提供候选源，否则屏幕共享会静默失败。
// 视频会议运行在主页面窗口（加载远程会议页），使用的是 defaultSession，故在此注册。
//
// audio 模式说明（Electron Streams.audio 类型已确认仅接受 'loopback' | 'loopbackWithMute'，
// NOT 'mute'/布尔）。取值行为：
//   'mute'            —— 用户未要求系统音频时的“纯视频”偏好
//   'loopback'        —— 附带系统循环音频（Windows 支持）
//   'loopbackWithMute'—— 附带系统循环音频且可静音（Windows 支持）
// 关键根因（客户“屏幕共享意外出错 / AbortError: Error starting capture”）：
//   腾讯会议 Web SDK 调用 getDisplayMedia({ audio: true }) 请求系统音频。Electron 的
//   setDisplayMediaRequestHandler 里，若回调只回 { video: sources }（不传 audio），Electron
//   无法满足页面请求的音频约束 → 直接 AbortError。因此当 request.audioRequested 为真时，
//   必须提供合法 audio 值（用户选了 loopback 类就用之，否则兜底 loopbackWithMute）。
//   页面只要视频时则纯视频（不传 audio），最安全。默认 'loopback'（捕获系统音频，本地不静音）。
let screenShareAudioMode = 'loopback'
// 根据【页面请求】与当前音频模式，构造合法的 Streams 响应。
// audioRequested 为真 → 必须给合法 audio；否则纯视频。
// 从源列表里挑【单个】源返回。关键：Electron 的 Streams.video 类型要求是
// 单个 DesktopCapturerSource（NOT 数组）——上一版把整个数组回给 callback，Electron
// 无法解析出唯一源 → getDisplayMedia 启动捕获即 AbortError（音视频/纯视频都会失败，
// 也解释了“环境层能枚举 7 个源、端到端却 AbortError”的现象）。
// 按页面请求的类型顺序挑第一个匹配源（屏幕优先于窗口），无匹配则回落 sources[0]。
function pickScreenShareSource(sources, request) {
  if (!sources || !sources.length) return null
  var want = (request && request.types) || ['screen', 'window']
  for (var i = 0; i < want.length; i++) {
    var prefix = want[i] + ':'
    var hit = sources.filter(function (s) { return s && s.id && s.id.indexOf(prefix) === 0 })[0]
    if (hit) return hit
  }
  return sources[0]
}
function buildScreenShareStreams(sources, request) {
  var src = pickScreenShareSource(sources, request)
  var resp = { video: src }
  var audioRequested = !!(request && request.audioRequested)
  if (audioRequested && src) {
    // 页面请求了系统音频：必须给合法 audio 值，否则 Electron 无法满足音频约束 → AbortError。
    if (screenShareAudioMode === 'loopback') resp.audio = 'loopback'
    else resp.audio = 'loopbackWithMute' // loopbackWithMute / 默认 mute → 兜底合法值
  }
  return resp
}

// ─── 屏幕共享 shim 注入（main world）───
// 必须走 executeJavaScript 注入到网页 main world，而不是 preload：
// contextIsolation=true 时 preload 运行在隔离 world，对 navigator.mediaDevices.getUserMedia
// 的包裹渗透不到网页 main world，腾讯 TRTC SDK 在 main world 调用会完全绕过 preload 的 shim。
const SCREEN_SHARE_SHIM_PATH = path.join(__dirname, 'src', 'screenshare-shim.js')
let _screenShareShimCache = null
function loadScreenShareShimSource() {
  if (_screenShareShimCache == null) {
    try { _screenShareShimCache = fs.readFileSync(SCREEN_SHARE_SHIM_PATH, 'utf8') } catch (e) { _screenShareShimCache = '' }
  }
  return _screenShareShimCache
}
// 把兼容 shim 注入指定窗口的 main world；枚举首选屏幕源作为 chromeMediaSourceId 注入 SDK
async function injectScreenShareShim(win) {
  if (!win || win.isDestroyed()) return
  const src = loadScreenShareShimSource()
  if (!src) { console.error('[ScreenShare] shim file empty, skip inject'); return }
  let sourceId = ''
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } })
    const picked = sources.find((s) => s.id && s.id.indexOf('screen:') === 0) || sources[0]
    sourceId = picked ? picked.id : ''
    // ★ 关键：桌面端共享走 shim 的 chrome.desktopCapture.chooseDesktopMedia 路径，
    //   不会触发 setDisplayMediaRequestHandler → lastSharedScreen 永远为空
    //   → 覆盖窗「拿不到 bounds 就拒绝打开」→ 表现就是「测多少次都没有系统级画板」。
    //   这里记录 SDK 实际会共享的那个源，作为覆盖窗定位的可靠依据。
    if (picked) {
      shimShareSource = {
        type: (picked.id && picked.id.indexOf('screen:') === 0) ? 'screen' : 'window',
        displayId: (picked.display_id != null) ? picked.display_id : null,
        name: picked.name || '',
      }
      boardLog('shim share source recorded | id=' + picked.id + ' | display_id=' + picked.display_id + ' | name=' + picked.name)
    }
  } catch (e) { console.error('[ScreenShare] enumerate for shim failed:', e && e.message) }
  const cfg = JSON.stringify({ sourceId: sourceId, audioMode: screenShareAudioMode })
  try {
    await win.webContents.executeJavaScript('(function(){window.__SCREEN_SHARE_CFG__=' + cfg + ';})()')
    await win.webContents.executeJavaScript(src)
    console.log('[ScreenShare] shim injected to main world | sourceId=' + (sourceId ? sourceId.slice(0, 16) + '…' : '(none)'))
  } catch (e) {
    console.error('[ScreenShare] shim executeJavaScript failed:', e && e.message)
  }
}

// ─── 屏幕共享源选择窗口 ─────────────────────────
// 弹出模态窗口让用户选择要分享的屏幕/窗口，替代原先"自动选第一个源"。
// 返回用户选中的 source 对象；用户取消或超时返回 null。
// parentWin: 父窗口（来自 request.webContents），用于真正模态阻止父窗口操作。
async function showScreenSharePicker(sources, parentWin) {
  return new Promise(function (resolve) {
    // 唯一 IPC channel，避免并发 getDisplayMedia 请求相互冲突
    var channel = 'screen-share-select-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    var settled = false   // 防止 closed/超时/handle 重复 resolve
    var picker = null
    var timeoutTimer = null

    function finish(result) {
      if (settled) return
      settled = true
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      try { ipcMain.removeHandler(channel) } catch (e) { /* handler 可能已移除 */ }
      if (picker && !picker.isDestroyed()) { picker.destroy() }
      resolve(result)
    }

    // 选择窗口 webPreferences：在 makeWebPrefs() 基础上覆写 nodeIntegration/contextIsolation。
    // 原因：选择窗口加载内联 data URL，内联脚本需 require('electron').ipcRenderer.invoke 回传选择结果；
    // makeWebPrefs() 默认 contextIsolation:true 下 main world 无法访问 ipcRenderer，而 preload
    // （src/preload.js，不在本次修改范围）未暴露通用 invoke 通道。本窗口仅加载主进程本地构造的
    // 可信内容、不加载任何远程页面，故安全风险可控。
    var webPrefs = Object.assign(makeWebPrefs(), {
      nodeIntegration: true,
      contextIsolation: false,
      preload: undefined,
    })

    picker = new BrowserWindow({
      width: 820,
      height: 620,
      modal: !!parentWin,
      parent: parentWin || undefined,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '选择要分享的内容',
      backgroundColor: '#1e1e1e',
      show: true,
      center: true,
      autoHideMenuBar: true,
      webPreferences: webPrefs,
    })

    // 一次性接收渲染进程回传的选择结果
    ipcMain.handle(channel, function (e, sourceId) {
      var picked = null
      for (var i = 0; i < sources.length; i++) {
        if (sources[i].id === sourceId) { picked = sources[i]; break }
      }
      finish(picked)
    })

    // 用户点 X 关闭 → 取消
    picker.on('closed', function () { finish(null) })

    // 60 秒未选择 → 自动关闭并取消共享
    timeoutTimer = setTimeout(function () { finish(null) }, 60000)

    picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildScreenSharePickerHTML(sources, channel)))
  })
}

// 构造源选择窗口的内联 HTML（深色主题）：屏幕 / 应用窗口分组 + 缩略图卡片网格
function buildScreenSharePickerHTML(sources, channel) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function card(s) {
    var thumb = (s.thumbnail && s.thumbnail.toDataURL) ? s.thumbnail.toDataURL() : ''
    var name = esc(s.name || s.id)
    var id = esc(s.id)
    return '<div class="card" data-id="' + id + '" tabindex="0">' +
      '<div class="thumb">' + (thumb ? '<img src="' + thumb + '" alt="">' : '<div class="nothumb">无预览</div>') + '</div>' +
      '<div class="name" title="' + name + '">' + name + '</div>' +
      '</div>'
  }
  function group(title, items) {
    if (!items || !items.length) return ''
    return '<section class="group"><h2>' + esc(title) + '</h2><div class="grid">' +
      items.map(card).join('') + '</div></section>'
  }
  var screens = sources.filter(function (s) { return s.id && s.id.indexOf('screen:') === 0 })
  var windows = sources.filter(function (s) { return s.id && s.id.indexOf('window:') === 0 })
  var others = sources.filter(function (s) { return !s.id || (s.id.indexOf('screen:') !== 0 && s.id.indexOf('window:') !== 0) })

  var p = []
  p.push('<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>选择要分享的内容</title>')
  p.push('<style>',
    'html,body{margin:0;padding:0;height:100%;background:#1e1e1e;color:#e6e6e6;font-family:"Microsoft YaHei",Segoe UI,sans-serif;overflow:hidden}',
    'body{display:flex;flex-direction:column}',
    'header{padding:16px 20px 12px;border-bottom:1px solid #333}',
    'header h1{margin:0;font-size:16px;font-weight:600}',
    'header p{margin:4px 0 0;font-size:12px;color:#9aa}',
    '.wrap{flex:1;overflow:auto;padding:12px 20px 20px}',
    '.group{margin-bottom:18px}',
    '.group h2{margin:0 0 10px;font-size:13px;color:#bbb;font-weight:600}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}',
    '.card{background:#2a2a2a;border:2px solid transparent;border-radius:8px;overflow:hidden;cursor:pointer;transition:transform .08s ease,border-color .12s ease,background .12s ease}',
    '.card:hover{border-color:#3a9bff;background:#303030}',
    '.card:focus{outline:none;border-color:#3a9bff}',
    '.card.selected{border-color:#3a9bff;background:#1f3a5f;transform:scale(.98)}',
    '.thumb{width:100%;height:104px;background:#000;display:flex;align-items:center;justify-content:center}',
    '.thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.nothumb{color:#666;font-size:12px}',
    '.name{padding:6px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    'footer{padding:10px 20px;border-top:1px solid #333;font-size:11px;color:#777;text-align:center}',
    '</style></head><body>')
  p.push('<header><h1>选择要分享的屏幕或窗口</h1><p>点击下方卡片选择要分享的内容，按 Esc 取消</p></header>')
  p.push('<div class="wrap">',
    group('屏幕', screens),
    group('应用窗口', windows),
    group('其他', others),
    '</div>')
  p.push('<footer>60 秒内未选择将自动取消</footer>')
  p.push('<script>')
  // channel 通过 JSON.stringify 注入，避免引号注入
  p.push('var CH=' + JSON.stringify(channel) + ';')
  p.push(
    'var cards=document.querySelectorAll(".card");',
    'for(var i=0;i<cards.length;i++){(function(c){',
    '  c.addEventListener("click",function(){',
    '    var id=c.getAttribute("data-id");',
    '    for(var j=0;j<cards.length;j++){cards[j].classList.remove("selected");}',
    '    c.classList.add("selected");',
    '    try{require("electron").ipcRenderer.invoke(CH,id);}catch(e){window.close();}',
    '  });',
    '  c.addEventListener("keydown",function(e){if(e.key==="Enter"){c.click();}});',
    '})(cards[i]);}')
  p.push('document.addEventListener("keydown",function(e){if(e.key==="Escape"){window.close();}});')
  p.push('</script></body></html>')
  return p.join('')
}

function setupScreenShare() {
  var saved = settingsStore.get() && settingsStore.get().screenShareAudio
  // loopbackWithMute 会静音本地系统输出（喇叭无声），不符合"默认分享声音"需求，迁移为 loopback
  if (saved === 'loopbackWithMute') {
    saved = 'loopback'
    try { settingsStore.set({ screenShareAudio: 'loopback' }) } catch (e) {}
  }
  if (saved === 'mute' || saved === 'loopback') screenShareAudioMode = saved

  session.defaultSession.setDisplayMediaRequestHandler(function (request, callback) {
    var reqWc = request && request.webContents
    var url = reqWc ? reqWc.getURL() : '(unknown)'
    var audioRequested = !!(request && request.audioRequested)
    var videoRequested = !!(request && request.videoRequested)
    var types = (request && request.types) ? request.types : ['screen', 'window']
    console.log('[ScreenShare] getDisplayMedia requested from:', url,
      '| videoRequested:', videoRequested, '| audioRequested:', audioRequested, '| audioMode:', screenShareAudioMode)
    // 父窗口：用于模态选择窗口（阻止用户在选择期间操作会议页）
    var parentWin = reqWc ? BrowserWindow.fromWebContents(reqWc) : null
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    }).then(async function (sources) {
      if (!sources || !sources.length) {
        console.warn('[ScreenShare] no sources available, cancel share')
        callback({})
        return
      }
      // 仅一个源时跳过选择窗口，直接返回（优化体验）；多源时弹窗让用户选
      var picked = (sources.length === 1) ? sources[0] : await showScreenSharePicker(sources, parentWin)
      if (!picked) {
        // 用户取消或 60 秒超时
        console.log('[ScreenShare] user cancelled source selection')
        callback({})
        return
      }
      // 记录共享源类型与所在显示器（供画板覆盖窗口定位，保证笔迹与画面不错位）
      lastSharedScreen = {
        type: (picked.id && picked.id.indexOf('screen:') === 0) ? 'screen' : 'window',
        displayId: (picked.display_id != null) ? picked.display_id : null,
        // 窗口标题：共享「某个窗口」时用它定位该窗口在屏幕上的矩形
        name: picked.name || '',
      }
      // 复用 buildScreenShareStreams 的音频逻辑构造响应
      var streams = { video: picked }
      if (audioRequested) {
        if (screenShareAudioMode === 'loopback') streams.audio = 'loopback'
        else streams.audio = 'loopbackWithMute' // mute / loopbackWithMute 兜底合法值
      }
      console.log('[ScreenShare] sources resolved:', sources.length,
        '| picked:', (picked.id + ' (' + picked.name + ')'),
        '| callback(audio:' + (streams.audio || 'omitted-video-only') + ')')
      callback(streams)
      // ★ 桌面端会议共享的「已开始」判定点：getDisplayMedia 已拿到用户选中的源。
      //   通知网页端「本机共享中」→ 用户随后点「画板」时才会开系统级屏幕画板而非网页画板。
      notifySelfScreenShare(true)
      // 注意：共享源确定后【不再】自动打开画板覆盖窗口（需求4：开启屏幕共享不可自动开屏板，
      // 必须用户主动点击才开）。记录共享源即可，供用户后续主动开屏板时精确定位。
    }).catch(function (err) {
      console.error('[ScreenShare] getSources failed:', err && err.message)
      callback({})
    })
  })

  session.defaultSession.setPermissionRequestHandler(function (webContents, permission, cb, details) {
    // 仅对可信来源放行一组安全的 Web API（媒体/采集/全屏/剪贴板/指针锁定/通知）；
    // 主帧 URL 或请求来源（子上下文/worker 可能为非主页面 URL）任一是可信来源即放行 media/display-capture，
    // 避免 WASM/worker 内部以非主页面 URL 请求媒体时被误杀。
    var url = webContents.getURL()
    var reqOrigin = (details && details.requestingUrl) || ''
    var allow = permissionAllowed(url, permission) || permissionAllowed(reqOrigin, permission)
    console.log('[Permission]', allow ? 'allow' : 'deny', permission, 'url:', url, reqOrigin ? ('req:' + reqOrigin) : '')
    cb(allow)
  })

  // 程序化权限查询（WASM/worker/子上下文走此路径，setPermissionRequestHandler 不一定被触发）：
  // 对可信来源的 media/display-capture 直接放行，覆盖 TRTC 内部采集路径。
  // 这是修复"麦克风没声音"的关键一环——腾讯会议/通话引擎在内部以程序化方式查询权限，
  // 不触发 request handler，导致被静默拒绝（日志表现为无任何 [Permission] 行却直接 NotAllowedError）。
  try {
    session.defaultSession.setPermissionCheckHandler(function (webContents, permission, requestingOrigin) {
      var url = (webContents && webContents.getURL && webContents.getURL()) || ''
      var allow = permissionAllowed(url, permission) || permissionAllowed(requestingOrigin || '', permission)
      console.log('[PermissionCheck]', allow ? 'allow' : 'deny', permission, 'url:', url || requestingOrigin)
      return allow
    })
  } catch (e) { console.error('[PermissionCheck] setPermissionCheckHandler failed:', e && e.message) }
}

// ─── 麦克风手动激活（兜底）───
// 在主页面 origin 内执行 getUserMedia，把媒体权限置为 granted，覆盖被缓存的拒绝/不同步状态。
// 必须在【主页面】webContents 内执行，而非设置/诊断窗口：Electron 权限按 origin 存储，
// 在 file:// 诊断窗口授权对 https://data.tygps.com 主页面无效。
let mediaPreAuthed = false
// 在主页面 origin 内分别请求音频/视频权限并立即关闭，把媒体权限置为 granted。
// 音频与视频【独立两次】请求：避免"无摄像头机器上 video:true 整体报错、连麦克风也授权不了"的回归
// （多数机器只有麦克风、没有摄像头）。返回 { ok, audio:{ok,label}, video:{ok,label} }。
// 必须在【主页面】webContents 内执行，而非设置/诊断窗口：Electron 权限按 origin 存储，
// 在 file:// 诊断窗口授权对 https://data.tygps.com 主页面无效。
async function activateMediaInMainPage() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) {
    return { ok: false, error: '主页面窗口不存在，请先打开应用主窗口', errorName: 'NoMainPage' }
  }
  try {
    var res = await mainPageWindow.webContents.executeJavaScript(
      '(async () => { ' +
      'function tryGet(c){ return navigator.mediaDevices.getUserMedia(c).then(function(s){ ' +
      '  var r = { ok: true, label: "" }; ' +
      '  try { r.label = (c.audio ? (s.getAudioTracks()[0] && s.getAudioTracks()[0].label) : (s.getVideoTracks()[0] && s.getVideoTracks()[0].label)) || ""; } catch(e){} ' +
      '  s.getTracks().forEach(function(t){ t.stop(); }); ' +
      '  return r; ' +
      '}).catch(function(e){ return { ok: false, error: (e && e.message) || String(e), name: (e && e.name) || "Error" }; }); } ' +
      'const audio = await tryGet({ audio: true }); ' +
      'const video = await tryGet({ video: true }); ' +
      'return JSON.stringify({ ok: audio.ok && video.ok, audio: audio, video: video }); ' +
      '})()'
    )
    var parsed = JSON.parse(res)
    var aL = (parsed.audio && parsed.audio.label) || ''
    var vL = (parsed.video && parsed.video.label) || ''
    console.log('[MediaActivate]', parsed.ok ? 'granted' : 'partial',
      'audio=' + ((parsed.audio && parsed.audio.ok) ? ('ok ' + aL) : 'fail'),
      'video=' + ((parsed.video && parsed.video.ok) ? ('ok ' + vL) : 'fail'))
    return parsed
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), errorName: 'ExecuteError' }
  }
}

// Shared BrowserWindow options for center-popup notification windows
function makePopupWindowOpts(w, h) {
  return {
    width: w,
    height: h,
    show: false,
    frame: false,
    // 与通知中心一致的纯色 app 灰底（无 acrylic/透明），白卡浮于其上，视觉统一
    backgroundColor: '#F5F6F8',
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    hasShadow: true,
    webPreferences: makeWebPrefs(),
  }
}

// ─── Active display (光标当前所在显示器) ──
function getActiveDisplay() {
  const { screen } = require('electron')
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

// ─── Notification center window rect (bottom-right of PRIMARY display) ──
// 稳定版要求：消息弹窗固定落在主屏右下角，不再跟随鼠标所在显示器。
function getNcRect(w, h) {
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workArea
  const margin = 20
  return { x: wa.x + wa.width - w - margin, y: wa.y + wa.height - h - margin }
}

// ─── Broadcast helper (main → all web clients) ──
function broadcast(msg) {
  if (!wsServer) return
  const raw = JSON.stringify(msg)
  wsServer.clients.forEach((c) => { if (c.readyState === 1) c.send(raw) })
}

// ─── App-window targeted helpers ──────────────────────
// 向应用窗口连接定向发送消息（不广播给外部浏览器）
function sendToAppClient(msg) {
  if (!wsServer) return
  const raw = JSON.stringify(msg)
  wsServer.clients.forEach((c) => {
    if (c.readyState !== 1) return
    const entry = connectedClients.get(c)
    if (entry && entry.isAppWindow && entry.connected) c.send(raw)
  })
}

// 检查是否有应用窗口连接
function hasAppClient() {
  return Array.from(connectedClients.values()).some(u => u.isAppWindow && u.connected)
}

// 多客户端消歧：桌面主窗口在线时，忽略外部浏览器标签页发来的「消息/未读」事件。
// 同一个账号同时开在两个客户端时，两边各自维护 conversation.unreadCount 并发全量下发，
// 桌面端会看到数字在 3/1/3/1 之间来回跳（表现为提醒框里的未读数闪动）。
// 只屏蔽这两类事件：MARK_READ 等用户主动行为仍然全客户端生效。
function isMirrorClient(ws) {
  const e = connectedClients.get(ws)
  if (!e) return false
  if (e.isAppWindow) return false
  return hasAppClient()
}

// ─── Agent 中继（WorkBuddy 连接器 ↔ 应用窗口）──────────────
// 无 token：WS 仅绑 127.0.0.1，本地边界由该绑定 + 文件 ACL 提供。
// Agent 连接通过 REGISTER 时 browserType==='agent' 标识，不另设鉴权。
const AGENT_REQUEST_TIMEOUT_MS = 30000
// requestId -> { ws: 来自 Agent 的连接, timer }
const pendingAgentRequests = new Map()
// requestId -> { resolve, reject, timer }：HTTP /api/agent/intent 发起的请求（复用同一 WS 中继，供轻量客户端如 curl 直连）
const pendingHttpRequests = new Map()

// 向所有已识别的 Agent 连接广播（用于 AGENT_EVENT 异步事件）
function broadcastToAgentClients(msg) {
  if (!wsServer) return
  const raw = JSON.stringify(msg)
  wsServer.clients.forEach((c) => {
    if (c.readyState !== 1) return
    const entry = connectedClients.get(c)
    if (entry && entry.isAgent) c.send(raw)
  })
}

// 清理某连接上所有未完成的 Agent 请求（连接断开时调用）
function clearAgentRequestsFor(ws) {
  for (const [requestId, pending] of pendingAgentRequests) {
    if (pending.ws === ws) {
      clearTimeout(pending.timer)
      pendingAgentRequests.delete(requestId)
    }
  }
}

// 置前主页面窗口，并可选地跳转到指定 url（SPA 路由跳转，不刷新页面）
//
// ⚠️ 2026-10 修复「点未读提醒进入会话，聊天记录空白」：
//   url 由网页端拼成 `origin + '/message?conv=' + encodeURIComponent(convID)`。
//   C2C 会话 id 形如 `C2Cadministrator`、群会话形如 `@TGS#aBcDe`，encode 后分别变成
//   `C2Cadministrator` / `%40TGS%23aBcDe` —— **`:` `@` `#` `/` `?` `%` 在路径/查询里都可能被浏览器再解码一次**，
//   一旦会话 id 被改写，网页端 setActiveConversation 找不到会话 → 右侧空白。
//   （v5 → v6 换 IM SDK 后会话 id 口径变了，这个隐患才被暴露出来，见 docs 说明。）
//   所以这里**不再靠字符串拼接猜会话 id**，而是把 convId 作为独立参数注入：
//     · 优先用调用方直接给的 convId（通知中心从 unreadMap 里拿的原始会话 id，最权威）；
//     · 否则从 url 里解析 `conv=` 再 decodeURIComponent；
//     · history API 不经过 URL 规范化，`?conv=` 用原文（未 encode）写入；
//     · 网页端优先读 `window.__MYLOG_FOCUS_CONV__`（最稳），读不到再退回 route.query.conv。
//   仅当 url 与 convId 都没有时直接返回。
function focusMainWindow(url, convId) {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  if (mainPageWindow.isMinimized()) mainPageWindow.restore()
  mainPageWindow.show()
  mainPageWindow.focus()
  const hint = convId ? String(convId) : ''
  if (!url && !hint) return
  try {
    mainPageWindow.webContents.executeJavaScript(
      '(function(full, hint){' +
      '  try {' +
      '    var u = full || "";' +
      '    var cid = hint || "";' +
      '    if (!cid) {' +
      '      var m = /[?&]conv=([^&]*)/.exec(u);' +
      '      var raw = m ? m[1] : "";' +
      '      try { cid = raw ? decodeURIComponent(raw) : ""; } catch (e0) { cid = raw }' +
      '    }' +
      // origin 去掉后取 path（保留部署 base，如 /mylog-pc）
      '    var path = u.replace(/^https?:\\/\\/[^/]+/i, "").replace(/\\?[^#]*$/, "");' +
      '    if (!path || path.charAt(0) !== "/") path = "";' +
      '    var target = cid ? ((path && path.indexOf("/message") !== -1 ? path : (path ? path.replace(/\\/[^\\/]*$/, "") : "") + "/message") || "/message") + "?conv=" + cid : (u.replace(/^https?:\\/\\/[^/]+/i, "") || "/message");' +
      '    if (cid) window.__MYLOG_FOCUS_CONV__ = { conversationId: cid, at: Date.now() };' +
      '    var cur = window.location.pathname + window.location.search;' +
      // 已是同一个会话：不重复 pushState（相同 URL 不触发路由更新），改为派发事件让网页端聚焦。
      // 判定只看 pathname 是否停在 /message + conv 是否一致（不比较 base，防止部署路径差异导致误判）。
      '    var curConv = "";' +
      '    try { curConv = new URLSearchParams(window.location.search).get("conv") || ""; } catch (e3) {}' +
      '    if (cid && curConv === cid) {' +
      '      try { window.dispatchEvent(new CustomEvent("mylog:focus-conversation", { detail: { conversationId: cid } })) } catch (e1) {}' +
      '      return "same";' +
      '    }' +
      '    window.history.pushState({}, "", target);' +
      '    window.dispatchEvent(new PopStateEvent("popstate"));' +
      '    return "navigated:" + target;' +
      '  } catch (e) {' +
      '    try { window.location.href = full } catch (e2) {}' +
      '    return "fallback";' +
      '  }' +
      '})(' + JSON.stringify(url || '') + ',' + JSON.stringify(hint) + ')'
    ).catch((e) => { console.warn('[FocusMain] deep-link evaluate failed:', e && e.message) })
  } catch (e) { console.warn('[FocusMain] executeJavaScript failed:', e && e.message) }
}

// ─── Safe open external ──
function safeOpenExternal(url) {
  if (!url) return
  try { shell.openExternal(url) } catch (e) { console.warn('[Open] failed:', e && e.message) }
}

// ─── Port finder ──────────────────────────────────────────
function findAvailablePort(startPort, maxAttempts, callback) {
  let attempts = 0
  let currentPort = startPort

  function tryNextPort() {
    if (attempts >= maxAttempts) {
      callback(null, null)
      return
    }

    const server = net.createServer()
    server.unref()

    server.on('error', () => {
      attempts++
      currentPort++
      console.log('[Port] Port', currentPort - 1, 'is in use, trying port', currentPort)
      tryNextPort()
    })

    server.on('listening', () => {
      server.close(() => {
        callback(null, currentPort)
      })
    })

    server.listen(currentPort, '127.0.0.1')
  }

  tryNextPort()
}

// ─── Download user icon from URL ───────────────────────────
function downloadUserIcon(iconUrl) {
  if (!iconUrl || typeof iconUrl !== 'string') {
    localUserIconPath = ''
    return
  }

  // Check if it's a network URL
  if (!iconUrl.startsWith('http://') && !iconUrl.startsWith('https://')) {
    // It's already a local path or invalid
    localUserIconPath = ''
    return
  }

  const client = iconUrl.startsWith('https://') ? https : http
  const iconDir = path.join(app.getPath('userData'), 'icons')
  const iconFileName = `user-icon-${Date.now()}.png`
  const iconPath = path.join(iconDir, iconFileName)

  // Ensure directory exists
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true })
  }

  console.log('[Icon] Downloading user icon from:', iconUrl)

  const request = client.get(iconUrl, {
    timeout: 10000,
    headers: {
      'User-Agent': 'MyLog-Desktop-Notifier/1.0'
    }
  }, (res) => {
    // Handle redirects
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log('[Icon] Redirect to:', res.headers.location)
      downloadUserIcon(res.headers.location)
      return
    }

    if (res.statusCode !== 200) {
      console.error('[Icon] Download failed, status:', res.statusCode)
      localUserIconPath = ''
      return
    }

    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const buffer = Buffer.concat(chunks)
      fs.writeFile(iconPath, buffer, (err) => {
        if (err) {
          console.error('[Icon] Failed to save icon:', err)
          localUserIconPath = ''
          return
        }
        console.log('[Icon] User icon saved to:', iconPath)
        localUserIconPath = iconPath
      })
    })
  })

  request.on('error', (err) => {
    console.error('[Icon] Download error:', err.message)
    localUserIconPath = ''
  })

  request.on('timeout', () => {
    request.destroy()
    console.error('[Icon] Download timeout')
    localUserIconPath = ''
  })
}

// ─── (getIconPath removed — tray icons now use nativeImage cache) ──────

function updateUnreadCount(count) {
  unreadCount = Math.max(0, count)
  // ringing 状态优先级最高，不自动覆盖
  if (trayIconState === 'ringing') return

  if (unreadCount > 0) {
    setTrayState('unread')
  } else if (trayIconState === 'unread') {
    setTrayState(deriveTrayState())
  }

  updateTrayTooltip()
}

// 托盘 tooltip 统一出口：IM 未读 + 邮件未读 都体现在这里
function updateTrayTooltip() {
  if (!tray) return
  const onlineCount = Array.from(connectedClients.values()).filter(u => u.connected).length
  if (onlineCount > 0) {
    const names = Array.from(connectedClients.values())
      .filter(u => u.connected)
      .map(u => u.userName || u.userId)
      .join(', ')
    tray.setToolTip(`e日志-通知助手 | ${onlineCount} 人在线${unreadCount > 0 ? ` | ${unreadCount} 条未读` : ''}`)
  } else {
    tray.setToolTip(`e日志-通知助手 | 未连接${unreadCount > 0 ? ` | ${unreadCount} 条未读` : ''}`)
  }
}

// ─── Cleanup stale disconnected entries ───────────────────
// Remove entries that have been disconnected for longer than STALE_ENTRY_TTL_MS
function cleanupStaleEntries() {
  const now = Date.now()
  let removed = 0
  for (const [ws, entry] of connectedClients) {
    if (!entry.connected && (now - entry.lastSeenAt) > STALE_ENTRY_TTL_MS) {
      console.log(`[Cleanup] Removing stale entry: ${entry.userName || entry.userId} (disconnected ${(now - entry.lastSeenAt) / 1000}s ago)`)
      connectedClients.delete(ws)
      removed++
    }
  }
  if (removed > 0) {
    updateTrayMenu()
  }
}

// Start periodic cleanup (every 60 seconds)
function startStaleCleanup() {
  if (cleanupTimer) return   // already running
  cleanupTimer = setInterval(() => {
    try { cleanupStaleEntries() } catch (_) {}
  }, 60000)
}

function stopStaleCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}

// ─── 当前在线用户数据（供设置面板「通用」页与托盘菜单同步展示） ───
function getTrayUsersData() {
  const connectedUsers = Array.from(connectedClients.values()).filter(u => u.connected)
  if (connectedUsers.length > 0) {
    return connectedUsers.map((u) => ({
      name: u.userName || u.userId || '未知用户',
      iconPath: (u.userId && userIconCache.get(u.userId)) || u.localIconPath ||
        (u.userId === currentUser.userId ? localUserIconPath : ''),
      online: true,
    }))
  } else if (currentUser.userName) {
    return [{ name: currentUser.userName, iconPath: localUserIconPath, online: false }]
  }
  return []
}

// ─── Tray custom menu (HTML popup) ───────────────
// 用无边框 BrowserWindow 渲染玻璃卡片菜单，替代原生 Menu.buildFromTemplate，
// 托盘右键菜单：原生 Menu.buildFromTemplate（清晰、可控、与系统风格一致）。
// 规则：除「开机自启」(checkbox 自带对勾) 与「退出」(左侧退出图标) 外，其余项不显示图标。

// 在线用户菜单项（禁用，纯信息展示）。托盘右键菜单与顶部窗口菜单共用。
function userMenuItems() {
  const items = []
  const connectedUsers = Array.from(connectedClients.values()).filter(u => u.connected)
  if (connectedUsers.length > 0) {
    connectedUsers.forEach((u) => {
      const displayName = u.userName || u.userId || '未知用户'
      const item = { label: `${displayName} 🟢`, enabled: false }
      const iconPath = (u.userId && userIconCache.get(u.userId)) || u.localIconPath ||
        (u.userId === currentUser.userId ? localUserIconPath : '')
      const ic = loadMenuIcon(iconPath)
      if (ic) item.icon = ic
      items.push(item)
    })
  } else if (currentUser.userName) {
    const item = { label: `${currentUser.userName} ⚪（离线）`, enabled: false }
    const ic = loadMenuIcon(localUserIconPath)
    if (ic) item.icon = ic
    items.push(item)
  }
  return items
}

// 主页面窗口顶部菜单栏：在线用户 + 设置（复用托盘逻辑，不碰远程页）
function buildWindowMenu() {
  const userItems = userMenuItems()
  if (userItems.length === 0) userItems.push({ label: '（无在线用户）', enabled: false })

  return Menu.buildFromTemplate([
    { label: '在线用户', submenu: userItems },
    {
      label: '设置',
      submenu: [
        { label: '通用', click: () => openSettingsWindow('general') },
        { label: '铃声', click: () => openSettingsWindow('ringtone') },
        { label: '特别关注', click: () => openSettingsWindow('contacts') },
        { label: '自动测试', click: () => { try { openDiagnosticsWindow() } catch (e) { console.error('[Menu] openDiagnostics failed:', e) } } },
        { label: '调试窗口', click: () => {
          if (mainPageWindow && !mainPageWindow.isDestroyed()) {
            mainPageWindow.webContents.openDevTools()
            mainPageWindow.show(); mainPageWindow.focus()
          }
        } },
        { type: 'separator' },
        { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => { setAutoStart(item.checked); settingsStore.set({ autoStart: item.checked }); updateTrayMenu() } },
        { label: '退出', click: () => { isQuitting = true; quitApp() } },
      ],
    },
    { label: '刷新', click: () => reloadMainPage() },
    (() => {
      const n = visibleDownloads().filter(d => d.state === 'progressing').length
      return { label: n > 0 ? `下载 (${n})` : '下载', submenu: buildDownloadsMenu() }
    })(),
  ])
}

// 下载菜单：进行中任务快速入口 + 下载中心（每次 setMenu 重建，保持最新状态）
function buildDownloadsMenu() {
  const items = []
  const vis = visibleDownloads()
  const active = vis.filter(d => d.state === 'progressing')
  if (active.length > 0) {
    active.slice(0, 8).forEach((d) => {
      const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0
      items.push({
        label: `${d.filename}  ${pct}%`,
        click: () => openDownloadsWindow(),
      })
    })
    items.push({ type: 'separator' })
  }
  items.push({ label: '下载中心', click: () => openDownloadsWindow() })
  const finished = vis.filter(d => d.state === 'completed')
  if (finished.length > 0) {
    items.push({ type: 'separator' })
    items.push({ label: `清空已完成 (${finished.length})`, click: () => clearDownloads() })
  }
  return items
}

// 轻量系统通知（用于托盘菜单等无 UI 上下文的反馈）
function notify(title, body, isError) {
  try {
    if (Notification.isSupported && Notification.isSupported()) {
      const n = new Notification({ title, body, silent: !!isError })
      n.show()
    }
  } catch (e) { /* 通知失败不影响主流程 */ }
}

function updateTrayMenu() {
  if (!tray) return

  const menuItems = []

  // ── Header（第一行标题 + 版本号） ──
  menuItems.push({ label: `e日志（v${version}）`, enabled: false })
  menuItems.push({ type: 'separator' })

  // ── Connected users（显示头像 + 在线状态标识，禁用项） ──
  const userItems = userMenuItems()
  if (userItems.length) {
    const connectedCount = Array.from(connectedClients.values()).filter(u => u.connected).length
    if (connectedCount > 0) menuItems.push({ label: `在线用户 (${connectedCount})`, enabled: false })
    menuItems.push(...userItems)
    menuItems.push({ type: 'separator' })
  }

  // ── Actions ──

  // 下载中心：查看网页下载任务，打开文件 / 打开所在目录
  menuItems.push({ label: '下载中心', click: () => openDownloadsWindow() })
  // 邮箱：打开阿里企业邮箱（固定地址窗口）
  menuItems.push({ label: '邮箱', click: () => openEmailWindow() })
  // 屏幕画板（桌面端专属）：把透明涂鸦层开到被共享的屏幕 / 当前显示器上。
  // 仅手动入口（需求4：开启屏幕共享不再自动开屏板，必须用户主动点击才开）。
  // menuItems.push({
  //   label: '屏幕画板（开/关）',
  //   click: () => {
  //     if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) closeBoardOverlay()
  //     else safeOpenBoardOverlay()
  //   },
  // })
  // // 网页画板（测试）：独立打开画板浮层 —— 不必先开一个会议就能直接用/自测画板
  // menuItems.push({
  //   label: '网页画板（测试）',
  //   click: () => {
  //     if (mainPageWindow && !mainPageWindow.isDestroyed()) {
  //       mainPageWindow.show()
  //       mainPageWindow.webContents.send('quick-action', 'open-board')
  //     }
  //   },
  // })
  // 调试窗口：打开主页面窗口的 Chrome DevTools，查看 TRTC SDK 内部日志（或用 Ctrl+Shift+I）
  // menuItems.push({ label: '调试窗口', click: () => {
  //   if (mainPageWindow && !mainPageWindow.isDestroyed()) {
  //     mainPageWindow.webContents.openDevTools()
  //     mainPageWindow.show()
  //     mainPageWindow.focus()
  //   }
  // }})
  
  // ── 手动授予麦克风/摄像头权限（兜底：对因缓存拒绝/子上下文漏放而"没声音/无画面"的机器，
  //     在主页面 origin 内分别执行 getUserMedia 把权限置 granted）。点击后系统通知回显结果。 ──
  menuItems.push({
    label: '激活麦克风',
    click: async () => {
      try {
        const res = await activateMediaInMainPage()
        const aOk = !!(res && res.audio && res.audio.ok)
        const vOk = !!(res && res.video && res.video.ok)
        if (aOk && vOk) {
          notify('麦克风与摄像头已开启', '已成功授予麦克风与摄像头权限，可正常通话/视频。')
        } else if (aOk && !vOk) {
          // 多数机器只有麦克风、无摄像头：麦克风成功即达标，摄像头失败不报警
          const vErr = (res && res.video && res.video.name) || ''
          const camMsg = /NotFound|DevicesNotFound|No mandatory|Overconstrained/i.test(vErr)
            ? '本机未检测到摄像头（不影响语音通话）。'
            : '摄像头未能开启，可在系统设置→隐私中检查摄像头授权（不影响语音通话）。'
          notify('麦克风已开启', camMsg)
        } else if (!aOk) {
          const detail = (res && res.audio && res.audio.error) ? `\n${res.audio.error}` : ((res && res.error) ? `\n${res.error}` : '')
          notify('开启失败', '未能授予麦克风权限，请检查系统麦克风设置或重试。' + detail, true)
        } else {
          notify('开启失败', '未能授予媒体权限，请检查系统设置或重试。', true)
        }
      } catch (e) {
        notify('开启失败', '发生异常：' + (e && e.message ? e.message : String(e)), true)
      }
    },
  })
  menuItems.push({ type: 'separator' })
  // 日志目录：排查「没有消息提示」时可直接把最新日志发给开发
  menuItems.push({
    label: '打开日志目录',
    click: () => {
      try {
        const d = appLog.getDir()
        console.log('[TrayMenu] open log dir:', d)
        if (d) shell.openPath(d)
      } catch (e) { console.error('[TrayMenu] open log dir failed:', e) }
    },
  })
  menuItems.push({ label: '设置', click: () => openSettingsWindow() })
  menuItems.push({
    label: '开机自启',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => {
      setAutoStart(item.checked)
      settingsStore.set({ autoStart: item.checked })
      updateTrayMenu()
    },
  })
  menuItems.push({ type: 'separator' })

  // ── Exit（左侧单色关机图标，与「开机自启」对勾左列对齐） ──
  const exitItem = { label: '退出', click: () => { isQuitting = true; quitApp() } }
  const si = getShutdownIcon()
  if (si) exitItem.icon = si
  menuItems.push(exitItem)

  const contextMenu = Menu.buildFromTemplate(menuItems)
  if (process.platform === 'darwin') {
    // macOS 关键修复：setContextMenu 会把左键点击变成"弹出菜单"，导致 tray.on('click') 不触发，
    // 表现就是"点托盘没反应、窗口唤不醒"。改为：左键走 click 事件（toggle 主窗口），
    // 右键才弹菜单（popUpContextMenu）。updateTrayMenu 会被多次调用，先 removeAllListeners 防重复绑定。
    tray.removeAllListeners('right-click')
    tray.on('right-click', () => { try { tray.popUpContextMenu(contextMenu) } catch (e) {} })
  } else {
    tray.setContextMenu(contextMenu)
  }

  // 同步刷新主窗口顶部菜单（在线用户列表会随连接状态变动）
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    try { mainPageWindow.setMenu(null) } catch (e) {}
  }

  // 实时同步在线用户列表给设置面板「通用」页（与托盘菜单展示完全一致）
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('tray-users-update', getTrayUsersData())
  }
  // 标题栏头像首字与在线用户同源
  try { pushTitlebarUser() } catch (e) {}

  // Tooltip：显示在线数量
  const onlineCount = Array.from(connectedClients.values()).filter(u => u.connected).length
  if (onlineCount > 0) {
    tray.setToolTip(`e日志-通知助手 | ${onlineCount} 个用户在线`)
  } else {
    tray.setToolTip(currentUser.userName ? `${currentUser.userName} - e日志通知助手` : 'e日志-通知助手')
  }
}

function setUserInfo(userData, wsClient) {
  const userId = userData.userId || ''
  const userName = userData.userName || ''
  const userIcon = userData.userIcon || ''
  const browserType = userData.browserType || ''
  const now = Date.now()

  // Legacy single-user reference update (use most recently registered)
  const prevUserId = (currentUser && currentUser.userId) || ''
  currentUser = { userId, userName, userIcon, browserType }
  console.log('[User] Updated:', userName, browserType)
  // 切换登录用户时，下载中心需立即刷新为对应用户的记录（避免不同用户记录混显）
  if (prevUserId !== userId) {
    broadcastDownloads()
    try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setMenu(buildWindowMenu()) } catch (e) {}
    sendDownloadsUser()
  }

  if (wsClient) {
    // ── Multi-user: userId-based deduplication ─────────────
    const currentEntry = connectedClients.get(wsClient)

    // Case A: This ws already has an entry with the same userId → update in-place (normal re-REGISTER)
    if (currentEntry && currentEntry.userId === userId && currentEntry.connected) {
      const needIconDownload = userIcon && userIcon !== (currentEntry.userIcon || '')
      connectedClients.set(wsClient, {
        ...currentEntry,
        userName,
        userIcon,
        browserType,
        lastSeenAt: now,
      })
      if (needIconDownload) {
        downloadUserIconForClient(wsClient, userIcon)
      }
      updateTrayMenu()
      return
    }

    // Case B: This ws is a NEW connection — look for a stale disconnected entry with the same userId to reclaim
    if (userId) {
      for (const [oldWs, oldEntry] of connectedClients) {
        if (
          oldWs !== wsClient &&
          !oldEntry.connected &&
          oldEntry.userId === userId &&
          (now - oldEntry.lastSeenAt) < STALE_ENTRY_TTL_MS   // only reclaim if not too old
        ) {
          // Reclaim: transfer data from old entry to new ws, delete old key
          const needIconDownload = userIcon && userIcon !== (oldEntry.userIcon || '')
          // isAppWindow 以新 ws 的 UA 标记为准（用户可能换了连接方式）
          const newIsAppWindow = currentEntry ? !!currentEntry.isAppWindow : false
          const reclaimed = {
            clientId: oldEntry.clientId,     // keep same clientId (stable identity)
            userId,
            userName,
            userIcon,
            browserType,
            connected: true,
            localIconPath: oldEntry.localIconPath,  // reuse downloaded icon
            lastSeenAt: now,
            isAppWindow: newIsAppWindow,
          }
          connectedClients.delete(oldWs)       // remove old ws mapping
          connectedClients.set(wsClient, reclaimed)  // map new ws to reclaimed entry

          console.log(`[User] Reclaimed disconnected entry "${userName}" (clientId=${reclaimed.clientId})`)
          if (needIconDownload) {
            downloadUserIconForClient(wsClient, userIcon)
          }
          updateTrayMenu()
          return
        }
      }
    }

    // Case C: No reusable entry found — create a brand new one
    const existing = currentEntry || { clientId: ++clientIdCounter, localIconPath: '' }
    const needIconDownloadNew = userIcon && userIcon !== (existing.userIcon || '')

    connectedClients.set(wsClient, {
      ...existing,
      userId,
      userName,
      userIcon,
      browserType,
      connected: true,
      lastSeenAt: now,
    })

    if (needIconDownloadNew) {
      downloadUserIconForClient(wsClient, userIcon)
    }
  } else {
    // HTTP handshake path: update legacy icon only
    if (userIcon) {
      downloadUserIcon(userIcon)
    } else {
      localUserIconPath = ''
    }
  }

  updateTrayMenu()
  // If just registered a connected client, ensure we're not stuck in gray
  if (trayIconState === 'gray' && hasConnectedClients()) {
    setTrayState('default')
  }
}

/** Download icon for a specific ws client and store in its entry */
function downloadUserIconForClient(wsClient, iconUrl) {
  if (!iconUrl || typeof iconUrl !== 'string') return

  // data: URL（base64 内联头像）直接解码落盘，无需网络请求
  if (iconUrl.startsWith('data:image')) {
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.*)$/i.exec(iconUrl)
    if (m) {
      const ext = (m[1] === 'jpeg') ? 'jpg' : m[1]
      const iconDir = path.join(app.getPath('userData'), 'icons')
      if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true })
      const iconPath = path.join(iconDir, `user-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
      fs.writeFile(iconPath, Buffer.from(m[2], 'base64'), (err) => {
        if (err) { console.error('[Icon] dataURL save failed:', err); return }
        storeClientIcon(wsClient, iconPath)
      })
      return
    }
  }

  if (!iconUrl.startsWith('http://') && !iconUrl.startsWith('https://')) return

  const client = iconUrl.startsWith('https://') ? https : http
  const iconDir = path.join(app.getPath('userData'), 'icons')
  const iconFileName = `user-icon-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  const iconPath = path.join(iconDir, iconFileName)

  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true })
  }

  console.log('[Icon] Downloading icon for client:', iconUrl)

  const request = client.get(iconUrl, {
    timeout: 10000,
    headers: { 'User-Agent': 'MyLog-Desktop-Notifier/1.0' }
  }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      downloadUserIconForClient(wsClient, res.headers.location)
      return
    }
    if (res.statusCode !== 200) {
      console.error('[Icon] Download failed, status:', res.statusCode)
      return
    }
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const buffer = Buffer.concat(chunks)
      fs.writeFile(iconPath, buffer, (err) => {
        if (err) { console.error('[Icon] Save failed:', err); return }
        console.log('[Icon] Saved to:', iconPath)
        const entry = connectedClients.get(wsClient)
        if (entry) {
          storeClientIcon(wsClient, iconPath)
        }
      })
    })
  })

  request.on('error', (err) => console.error('[Icon] Download error:', err.message))
  request.on('timeout', () => { request.destroy(); console.error('[Icon] Timeout') })
}

// ─── HTTP server for handshake ────────────────────────────
const HTTP_DEFAULT_PORT = 19789       // High port to avoid conflicts (was 8080)
const HTTP_MAX_PORT_ATTEMPTS = 10    // Try up to 10 ports (19789~19798), enough for high port

/** Create the HTTP request handler (reused across port retries) */
function createHttpHandler() {
  return (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'OPTIONS') {
      res.statusCode = 200
      res.end()
      return
    }

    if (req.url === '/api/handshake' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          console.log('[HTTP] Handshake request:', data.userName, data.browserType)

          // HTTP handshake: update legacy user info (no ws client context here)
          setUserInfo({
            userId: data.userId,
            userName: data.userName,
            userIcon: data.userIcon,
            browserType: data.browserType
          }, null)

          res.writeHead(200)
          res.end(JSON.stringify({
            success: true,
            wsPort: currentWsPort,
            version: version,
            message: 'Handshake successful'
          }))
        } catch (error) {
          res.writeHead(400)
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }))
        }
      })
    } else if (req.url === '/api/port' && req.method === 'GET') {
      res.writeHead(200)
      res.end(JSON.stringify({
        success: true,
        wsPort: currentWsPort,
        version: version
      }))
    } else if (req.url === '/api/agent/intent' && req.method === 'POST') {
      // 常驻进程直连：轻量客户端（如 curl）POST 到这里，复用桌面端已常驻的 WS 中继
      // 把意图转给应用窗口执行，省去每次新起 Node 进程（冷启动 ~0.8s）与 WS 重连。
      // 安全：本接口可执行任意意图，必须阻止浏览器跨域滥用（Csrf）——
      //   ① 去掉 CORS 通配头；② 要求自定义头 X-ELog-Client（触发预检且浏览器无法凭空添加），curl 可带。
      res.removeHeader('Access-Control-Allow-Origin')
      if (!req.headers['x-elog-client']) {
        res.writeHead(403)
        return res.end(JSON.stringify({ ok: false, error: 'FORBIDDEN: missing X-ELog-Client header' }))
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', async () => {
        let pl = {}
        try { pl = JSON.parse(body || '{}') } catch (e) {
          res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'BAD_JSON_BODY' }))
        }
        const intent = pl.intent
        if (!intent) return res.end(JSON.stringify({ ok: false, error: 'MISSING_INTENT' }))
        if (!hasAppClient()) return res.end(JSON.stringify({ ok: false, error: 'WEB_OFFLINE' }))
        const requestId = crypto.randomUUID()
        const timeoutMs = Math.min(Math.max(Number(pl.timeoutMs) || AGENT_REQUEST_TIMEOUT_MS, 1000), 120000)
        try {
          const data = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingHttpRequests.delete(requestId)
              reject(new Error('TIMEOUT'))
            }, timeoutMs)
            pendingHttpRequests.set(requestId, { resolve, reject, timer })
            sendToAppClient({ type: 'AGENT_INTENT', payload: { requestId, intent, slots: pl.slots || {} }, timestamp: Date.now() })
          })
          res.end(JSON.stringify({ ok: true, data }))
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      })
    } else if (req.url === '/api/desktop/activate' && req.method === 'GET') {
      // 大文件上传等场景：激活桌面端窗口，提示用户在桌面窗口操作
      try {
        let activated = null
        if (emailWindow && !emailWindow.isDestroyed()) {
          if (!emailWindow.isVisible()) emailWindow.show()
          emailWindow.focus()
          activated = 'email'
        }
        if (mainPageWindow && !mainPageWindow.isDestroyed()) {
          if (!mainPageWindow.isVisible()) mainPageWindow.show()
          mainPageWindow.focus()
          activated = activated ? activated + '+main' : 'main'
        }
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, activated }))
      } catch (e) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
      }
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: 'Not found' }))
    }
  }
}

/**
 * Start the HTTP server with automatic port retry.
 * Each failed attempt creates a FRESH server instance to avoid
 * the "cannot call listen on an errored server" problem.
 */
function startHttpServer(callback) {
  let attempt = 0

  function tryListen(port) {
    if (attempt >= HTTP_MAX_PORT_ATTEMPTS) {
      const err = new Error(`[HTTP] No available port found after ${HTTP_MAX_PORT_ATTEMPTS} attempts`)
      console.error(err.message)
      callback(err)
      return
    }

    // Create a FRESH server for every attempt
    const server = http.createServer(createHttpHandler())

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        attempt++
        console.log('[HTTP] Port', port, 'in use, trying', port + 1)
        server.close()          // clean up the failed server
        tryListen(port + 1)     // create a new server on next port
      } else {
        console.error('[HTTP] Server error:', err)
        callback(err)
      }
    })

    server.once('listening', () => {
      currentHttpPort = server.address().port
      httpServer = server
      console.log('[HTTP] Server listening on http://127.0.0.1:' + currentHttpPort)
      callback(null)
    })

    server.listen(port, '127.0.0.1')
  }

  currentHttpPort = HTTP_DEFAULT_PORT
  tryListen(currentHttpPort)
}

// ─── App lifecycle ────────────────────────────────────────
// 注意：保持 app 出现在 macOS Dock / Windows 任务栏（与钉钉/微信一致），
// 点 × 走 close 拦截 + hide() 隐藏窗口，状态保留在 renderer 进程里；
// 真退出由菜单「退出」或 Cmd+Q 触发 isQuitting 控制。

app.whenReady().then(() => {
  // ── 关键日志落盘（排查「没有消息提示」类问题）──
  // 打包后没有可见 stdout，只能让 [NC]/[WS]/[Dedup]/[NCR] 等前缀的日志留在磁盘上。
  // 位置：%APPDATA%\mylog-desktop-notifier\logs\notify-YYYYMMDD.log
  try {
    const logInfo = appLog.init(app.getPath('userData'))
    appLog.patchConsole()
    appLog.log('Log', 'file=' + logInfo.file)
  } catch (e) {}

  // 邮箱：启动时恢复上次登录的 SSO 会话 Cookie（重启免登），并定时兜底保存
  restoreEmailSession()
  const emailSaveTimer = setInterval(() => { saveEmailSession() }, 60000)
  if (emailSaveTimer.unref) emailSaveTimer.unref()

  // Windows 系统通知（下载完成等）必须设置 AppUserModelId，否则 Notification 不显示
  try { app.setAppUserModelId('com.tianyuan.mylog.desktop-notifier') } catch (e) {}

  // 覆盖 UA，移除 Electron 字样，让 TRTC Web SDK 认为是标准 Chrome 浏览器
  // TRTC 在 startScreenCapture 内部检测到 Electron 环境后直接报 -1005 not supported
  try {
    const origUA = session.defaultSession.getUserAgent()
    // 末尾追加 MylogDesktop/1.0 标记：不含 Electron 字样，不影响 TRTC 检测，
    // 但能让 WS server 识别应用窗口连接（外部浏览器 UA 不含此标记）
    const cleanUA = origUA
      .replace(/\s*Electron\/[\d.]+/i, '')
      .replace(/\s*mylog-desktop-notifier\/[\d.]+/i, '')
      + ' MylogDesktop/1.0'
    session.defaultSession.setUserAgent(cleanUA)
    console.log('[UA] Original:', origUA)
    console.log('[UA] Cleaned: ', cleanUA)
  } catch (e) { console.error('[UA] override failed:', e) }

  findAvailablePort(config.wsPort, config.handshake.maxAttempts, (err, wsPort) => {
    if (err || !wsPort) {
      console.error('[Port] No available ports found, exiting')
      app.quit()
      return
    }

    currentWsPort = wsPort
    createTray()

    // ── 屏幕共享支持（getDisplayMedia 需在会话层注册源提供器）──
    setupScreenShare()

    // ── Feature init (M1+) ──────────────────────
    settingsStore.load()
    // 回灌上次会话的下载历史（终态记录），重启后下载中心仍有记录
    downloads = settingsStore.loadDownloads()
    ringtoneResolver = createRingtoneResolver({
      settingsStore,
      assetsDir: __dirname,                       // assets/ 位于项目根
      userDataDir: settingsStore.getRingtoneDir(),
      presets: config.ringtonePresets,
    })
    notificationCenter = createNotificationCenter({
      BrowserWindow,
      webPreferences: makeWebPrefs(),
      getWindowRect: getNcRect,
      settingsStore,
      ringtoneResolver,
      // 托盘闪烁的未读来源改为「网页端消息页真实未读数」：由网页经 UPDATE_UNREAD_COUNT 下发
      // （layout.vue 监听 filteredUnReadCount 实时推送），不再由 SYNC_UNREAD 聚合（易残留陈旧项）。
      onUnreadChange: () => {},
      openExternal: safeOpenExternal,
      broadcast,
      isWebConnected: hasConnectedClients,
      // 应用窗口定向能力（用于通知点击分流：应用窗口连接 → 置前 + FOCUS_CONVERSATION）
      sendToAppClient,
      hasAppClient,
      focusMainWindow,
    })
    notificationCenter.preCreate()
    // ─────────────────────────────────────────────

    // 工作台数据预载（功能入口已移除，仅保留数据层以备后续复用）
    workbenchStore.load()

    // 首开提速①：提前预热到主页的 DNS/TCP/TLS（省去渲染进程发起首个请求时的建连 RTT）
    try {
      const preUrl = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
      if (typeof session.defaultSession.preconnect === 'function') session.defaultSession.preconnect({ url: preUrl })
    } catch (e) { /* 老版本 Electron 无此 API 时静默跳过 */ }

    // 校正开机自启项：若用户已开启自启，确保注册表/登录项带 --hidden（旧版本可能漏写），
    // 避免系统登录后自动启动仍弹出主窗口。
    if (settingsStore.get() && settingsStore.get().autoStart) {
      setAutoStart(true)
    }

    // 启动即打开主页面窗口（默认展示网页，符合"启动时网页窗口应默认打开"）
    openMainPage()

    startHttpServer((err) => {
      if (err) {
        console.error('[HTTP] Failed to start HTTP server:', err)
      }
      startWSServer()
      registerProtocol()
      preCreateCallWindow()
      preCreateMeetingWindow()
      console.log('[MyLog Notifier] Ready | WS port:', currentWsPort, '| HTTP port:', currentHttpPort)
    })
  })
})

app.on('window-all-closed', () => {
  // 普通应用 + close 拦截：所有窗口都关时仍驻留后台（与钉钉/微信一致）。
  // 仅在用户主动「退出」（菜单 / Cmd+Q）触发 isQuitting 后才真退。
  if (isQuitting) {
    app.quit()
  }
})

// macOS: 用户点 Dock 图标重新激活 app 时唤起主窗口（与钉钉/微信一致）
// macOS：用户点 Dock 图标重新激活 app 时唤起主窗口（与钉钉/微信一致）。
// 注意：Dock 点击只负责"show"，不 toggle——否则窗口已显示时再点 Dock 反而会把它隐藏，体验怪异。
app.on('activate', () => {
  if (process.platform !== 'darwin') return
  try { app.show() } catch (e) {}
  if (!mainPageWindow || mainPageWindow.isDestroyed()) { openMainPage(); return }
  if (mainPageWindow.isMinimized()) mainPageWindow.restore()
  mainPageWindow.show()
  mainPageWindow.focus()
})

app.on('before-quit', () => {
  isQuitting = true
  // 退出前把邮箱 SSO 会话落盘（关窗时已存过，这里兜底确保最新）
  saveEmailSession()
  stopStaleCleanup()
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null }
  // Force-close all WebSocket connections
  if (wsServer) {
    wsServer.clients.forEach(client => client.close())
    wsServer.close()
    wsServer = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
  // Destroy all windows
  if (callWindow && !callWindow.isDestroyed()) { callWindow.destroy(); callWindow = null }
  if (meetingWindow && !meetingWindow.isDestroyed()) { meetingWindow.destroy(); meetingWindow = null }
  if (toastWindow && !toastWindow.isDestroyed()) { toastWindow.destroy(); toastWindow = null }
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.destroy(); settingsWindow = null }
  if (workbenchWindow && !workbenchWindow.isDestroyed()) { workbenchWindow.destroy(); workbenchWindow = null }
})

// ─── System tray ──────────────────────────────────────────
let mainPageWindow = null
const MAIN_PAGE_DEFAULT = 'https://data.tygps.com/mylog-pc/'
// 主窗口「远程主页加载超时」计时器。★ 必须是模块级：错误页的 mainpage-retry 处理器在顶层，
//   之前它引用了 openMainPage() 里的同名局部变量 → ReferenceError → 点「重试」直接弹
//   "A JavaScript error occurred in the main process"。
let mainLoadTimer = null

// 读取/保存主页面窗口尺寸与位置（记忆上次状态，首次才用默认 1300x700）
function loadMainPageBounds() {
  const b = settingsStore.get() && settingsStore.get().mainPageBounds
  if (b && typeof b.width === 'number' && typeof b.height === 'number') return b
  return null
}
let _boundsTimer = null
function saveMainPageBounds() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  const b = mainPageWindow.getBounds()
  if (_boundsTimer) clearTimeout(_boundsTimer)
  _boundsTimer = setTimeout(() => {
    settingsStore.set({ mainPageBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
  }, 300)
}

// 托盘点击 → 切换主页面窗口显示/隐藏（Ctrl/⌘+Shift+M）
function toggleMainPage() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) {
    if (process.platform === 'darwin') { try { app.show() } catch (e) {} }
    return openMainPage()
  }
  if (mainPageWindow.isVisible() && mainPageWindow.isFocused()) {
    mainPageWindow.hide()
  } else {
    if (mainPageWindow.isMinimized()) mainPageWindow.restore()
    // macOS：app.show() = NSApp.activate(ignoringOtherApps:true)，先把 App 激活到前台，
    // 再 show() 窗口才会被系统带到最前（纯托盘/后台态下 NSApp 不激活则 show 无效）。
    if (process.platform === 'darwin') { try { app.show() } catch (e) {} }
    mainPageWindow.show()
    mainPageWindow.focus()
  }
}

// ─── 刷新主页面网页（顶部菜单「刷新」：点一下即刷新当前加载的网页）──
function reloadMainPage() {
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    try { mainPageWindow.reload() } catch (e) { console.warn('[Reload] failed:', e && e.message) }
  } else {
    openMainPage()   // 窗口不存在则打开
  }
}

// ─── 主页面显隐快捷键（默认 Ctrl/⌘+Shift+M，可在「设置-通用」中自定义）───
let mainPageHotkeyAccel = 'CommandOrControl+Shift+M'
function registerMainPageHotkey() {
  const accel = (settingsStore.get() && settingsStore.get().mainPageHotkey) || mainPageHotkeyAccel
  // 注销旧绑定（用户可能改过，或上一次注册的是默认键）
  try { globalShortcut.unregister(mainPageHotkeyAccel) } catch (e) {}
  mainPageHotkeyAccel = accel
  try {
    if (!globalShortcut.register(accel, toggleMainPage)) {
      console.warn('[Shortcut] 注册失败，回退默认快捷键:', accel)
      mainPageHotkeyAccel = 'CommandOrControl+Shift+M'
      try { globalShortcut.register(mainPageHotkeyAccel, toggleMainPage) } catch (e2) {}
    }
  } catch (e) {
    console.warn('[Shortcut] 注册异常，回退默认:', e && e.message)
    mainPageHotkeyAccel = 'CommandOrControl+Shift+M'
  }
}

// ─── 工作台全局快捷键（已移除：功能入口关闭，Ctrl/⌘+Shift+B 不再唤起工作台）───

// 开机自启统一入口：带 --hidden 参数，使系统登录后自动启动时不弹出主窗口（仅驻留托盘）。
// macOS 额外用 openAsHidden；Windows/Linux 通过 args 把 --hidden 传给启动进程，由 openMainPage 识别。
function setAutoStart(v) {
  const AUTO_START_NAME = 'com.tianyuan.mylog.desktop-notifier'
  try {
    if (!v) {
      app.setLoginItemSettings({ openAtLogin: false, name: AUTO_START_NAME })
      return
    }
    // 打包版：exe 即应用本体，参数只需 --hidden（开机隐藏启动）。
    // 开发版：必须把「应用目录」作为第一个参数传给 electron，否则注册表里只会写入
    //   node_modules/electron/dist/electron.exe（无 app 路径）—— 开机时 Electron 找不到
    //   应用，会退回内置默认欢迎页（标题 "Electron"、内容 "To run a local app..."）。
    //   这正是历史上开机弹出 Electron 默认窗口的根因。
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
    app.setLoginItemSettings({
      openAtLogin: true,
      name: AUTO_START_NAME,
      args,
      openAsHidden: process.platform === 'darwin',
    })
  } catch (e) { console.warn('[AutoStart] setLoginItemSettings 失败:', e && e.message) }
}

// 本次启动是否由「开机自启」带 --hidden 触发（仅进程启动时判定一次）
const LAUNCHED_HIDDEN = process.argv.includes('--hidden')

// ─── 主窗口加载超时兜底（首次加载与错误页「重试」共用）──────────────
// 20s 内没加载完（卡死/超慢/挂起）就兜底，避免无限空白。
// 注意：站点判定用 homeUrl()/inMainSite() 实时读配置，这里不缓存主机名。
function armMainLoadTimeout(expectUrl) {
  if (mainLoadTimer) { clearTimeout(mainLoadTimer); mainLoadTimer = null }
  mainLoadTimer = setTimeout(() => {
    mainLoadTimer = null
    if (!mainPageWindow || mainPageWindow.isDestroyed()) return
    const cur = mainPageWindow.webContents.getURL() || ''
    if (cur.indexOf('mainpage-error') !== -1) return
    const home = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
    const special = /^(about|data|blob|devtools|chrome-extension):/i.test(cur)
    // 当前页已离开主页站点（被换站/被带到站外且加载不出来）→ 直接拉回主页，
    // 不要给一张"重试站外地址"的错误页：用户要的是回到 e日志，而不是继续等那个站点。
    const sameHost = (() => {
      try {
        const a = new URL(cur), b = new URL(home)
        return a.hostname.toLowerCase() === b.hostname.toLowerCase() && (a.port || '') === (b.port || '')
      } catch (e) { return false }
    })()
    if (cur && !special && cur.indexOf('file://') !== 0 && !sameHost) {
      console.warn('[MainPage] 当前页已离开主页站点且加载超时，直接回到主页:', cur)
      mainPageWindow.loadURL(home)
      return
    }
    console.warn('[MainPage] 远程主页加载超时，显示错误页')
    // ★ 错误页必须带 home：错误页的「重试」要回主页，而不是重试一个加载不出来的地址。
    mainPageWindow.loadURL('file://' + path.join(__dirname, 'src', 'mainpage-error.html') +
      '?url=' + encodeURIComponent(cur || expectUrl || home) +
      '&reason=timeout&home=' + encodeURIComponent(home))
  }, 20000)
  // 加载结束（成功或失败）就收掉计时器。用 on 而非 once：重试会重新 arm，
  // once 只生效一次会导致后续加载完全没有兜底。
  const wc = mainPageWindow.webContents
  if (!wc.__mainLoadStopBound) {
    wc.__mainLoadStopBound = true
    wc.on('did-stop-loading', () => {
      if (mainLoadTimer) { clearTimeout(mainLoadTimer); mainLoadTimer = null }
    })
  }
}

function openMainPage() {
  const rawUrl = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
  // 规范化 + 安全上下文升级：
  // 网页被叫/音视频通话依赖 WebRTC，必须在安全上下文（https 或 localhost）下运行；
  // 且同源策略要求页面与子资源同 scheme——若页面是 http:// 而子资源是 https://，
  // 浏览器会按跨源拦截所有 JS/CSS（CORS 报错），导致 SPA 白屏。
  // 故：http:// 一律升级为 https:// 加载，原 http 地址留存为 https 失败时的回退（仅一次）。
  let url = MAIN_PAGE_DEFAULT
  let fallbackUrl = null
  if (/^https?:\/\//i.test(rawUrl || '')) {
    try {
      const u = new URL(rawUrl)
      const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)
      if (u.protocol === 'http:' && !isLocalhost) {
        const httpsU = new URL(rawUrl); httpsU.protocol = 'https:'
        fallbackUrl = u.toString()      // 原 http，作为 https 加载失败回退
        url = httpsU.toString()         // 优先用 https 加载
      } else {
        url = u.toString()
      }
    } catch (e) { url = MAIN_PAGE_DEFAULT }
  }

  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    // 点击切换语义：最小化则恢复；可见且聚焦则隐藏（类 IM）；其余置顶显示
    if (mainPageWindow.isMinimized()) { mainPageWindow.restore(); mainPageWindow.focus(); return }
    if (mainPageWindow.isVisible() && mainPageWindow.isFocused()) { mainPageWindow.hide(); return }
    if (process.platform === 'darwin') { try { app.show() } catch (e) {} }
    mainPageWindow.show(); mainPageWindow.focus()
    return
  }

  const b = loadMainPageBounds()
  mainPageWindow = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1300, height: 700, center: true }),
    minWidth: 800,
    minHeight: 480,
    show: false,                 // 先隐藏，splash 渲染完成后由 ready-to-show 显示
    title: 'e日志',           // 系统标题栏显示文本（与设置/诊断/工作台窗口一致）
    frame: true,                 // 使用系统默认标题栏（最小化/最大化/关闭由 OS 提供），与设置/诊断/工作台窗口风格统一
    resizable: true,
    minimizable: true,
    maximizable: true,
    autoHideMenuBar: true,       // 原生菜单栏默认隐藏（在线用户/设置菜单，按 Alt 唤出）
    backgroundColor: '#F5F6F8',  // 与通知中心一致的 app 灰底，杜绝默认白色闪烁
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    // 首开提速②③（仅主页面窗口，不影响通知等常驻窗口功耗）：
    //   backgroundThrottling:false —— 窗口隐藏到托盘/失焦时，网络与定时器仍全速（否则节流到 1 次/秒，后台加载明显变慢）
    //   v8CacheOptions:'bypassHeatCheck' —— V8 代码缓存跳过"热度检查"，二次启动直接命中字节码缓存，SPA 大包体（Vue+TRTC+TUIKit）编译提速明显
    webPreferences: { ...makeWebPrefs(), backgroundThrottling: false, v8CacheOptions: 'bypassHeatCheck' },
  })

  // 关闭即隐藏到托盘（继续当前页面），而非销毁；真正退出由全局 isQuitting 控制。
  // 注意：preventDefault 只阻止"销毁"，窗口对象保留在内存里——会议 / 视频 / 表单状态
  // 都在 renderer 进程，hide 不会断开 WebRTC 或暂停 <video>，符合钉钉/微信"关窗不影响内容"。
  // macOS 上不要做 setImmediate + showInactive 之类的状态机复位，那只会让 NSWindow 更混乱；
  // 单纯 hide() 即可，后续 show() 能正常唤回。
  mainPageWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainPageWindow.hide()
    }
  })
  // ─── 渲染进程 console 桥接到主进程 ───
  // 用户无法直接查看主页面窗口的 console 日志（TRTC SDK 的报错、调用路径全藏在渲染进程）。
  // 通过 webContents.on('console-message') 把所有 console.log/warn/error 输出到主进程控制台，
  // 这样 npm run dev 的终端里就能看到 SDK 内部到底干了什么。
  mainPageWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    var tag = '[MainPage Console]'
    // level: 0=verbose, 1=info, 2=warning, 3=error
    if (level === 3) console.error(tag, message, '|', sourceId, ':', line)
    else if (level === 2) console.warn(tag, message, '|', sourceId, ':', line)
    else console.log(tag, message, '|', sourceId, ':', line)
  })

  // ─── 主窗口快捷键「白名单 + 防火墙」（窗口级，仅主页面聚焦时生效）───
  // 设计要点：
  //  1) 全部走 webContents 的 before-input-event（窗口级），而非 globalShortcut（OS 级全局）。
  //     原先的 Ctrl+Shift+I 用 globalShortcut 注册，会在「其它软件里按」也触发本应用 DevTools，
  //     干扰其它软件——现已移除全局注册，改由下方窗口级处理（仅本应用聚焦时开/关 DevTools）。
  //  2) 允许列表：F5 / F11 / F12 + 窗口内 Ctrl/⌘+Shift+I（DevTools）+ 「显示/隐藏窗口」热键。
  //  3) 放行文本编辑组合键（Ctrl/⌘+C/V/X/A/Z，可带 Shift，不可带 Alt），保证输入框正常复制粘贴。
  //  4) 其余带修饰键（Ctrl/Alt/Meta）或功能键（F1–F4/F6–F10/F13+）一律 preventDefault 屏蔽，
  //     阻止浏览器/系统默认行为（Ctrl+R/W/T/P/S/U、F1 帮助、F3 查找等）；普通字符输入放行。
  const _isTextEditCombo = (input) => {
    const k = (input.key || '').toUpperCase()
    const isCVXAZ = k === 'C' || k === 'V' || k === 'X' || k === 'A' || k === 'Z'
    return isCVXAZ && (input.control || input.meta) && !input.alt
  }
  // 判断按键是否匹配某个 Electron 加速器串（如 "CommandOrControl+Shift+M"），用于放行「显示/隐藏窗口」热键
  const _matchesAccel = (input, accel) => {
    if (!accel) return false
    const tokens = String(accel).split('+').map((t) => t.trim().toUpperCase())
    const key = tokens.pop()
    const has = (t) => tokens.includes(t)
    const coc = has('COMMANDORCONTROL') || has('CMDORCTRL')
    const wantCtrl = has('CONTROL') || has('CTRL') || coc
    const wantCmd = has('COMMAND') || has('CMD') || has('META') || has('SUPER') || coc
    const wantAlt = has('ALT')
    const wantShift = has('SHIFT')
    const ctrlOk = coc ? (input.control || input.meta) : (wantCtrl ? input.control : !input.control)
    const cmdOk = coc ? true : (wantCmd ? input.meta : !input.meta)
    const altOk = wantAlt ? input.alt : !input.alt
    const shiftOk = wantShift ? input.shift : !input.shift
    return (input.key || '').toUpperCase() === key && ctrlOk && cmdOk && altOk && shiftOk
  }
  try {
    mainPageWindow.webContents.on('before-input-event', (event, input) => {
      if (!mainPageWindow || mainPageWindow.isDestroyed()) return
      if (input.type !== 'keyDown') return
      const key = input.key

      // ── 允许项 1：F5 / F11 / F12 ──
      if (key === 'F5' || key === 'F11' || key === 'F12') {
        event.preventDefault()
        if (key === 'F5') {
          // 完全重新加载：忽略缓存，确保所有静态资源（图片/css/字体/json 等）重新拉取，不被缓存加载
          if (mainPageWindow.isVisible()) mainPageWindow.webContents.reloadIgnoringCache()
          else openMainPage()
        } else if (key === 'F11') {
          mainPageWindow.setFullScreen(!mainPageWindow.isFullScreen())
        } else if (key === 'F12') {
          mainPageWindow.webContents.toggleDevTools()
        }
        return
      }

      // ── 允许项 2：窗口内 Ctrl/⌘+Shift+I 打开/关闭 DevTools（替代原全局注册，避免干扰其它软件）──
      if ((input.control || input.meta) && input.shift && !input.alt && (input.key || '').toUpperCase() === 'I') {
        event.preventDefault()
        if (mainPageWindow.isVisible()) mainPageWindow.webContents.toggleDevTools()
        return
      }

      // ── 放行：文本编辑组合键（输入框复制粘贴等）──
      if (_isTextEditCombo(input)) return

      // ── 放行：「显示/隐藏窗口」热键（默认 Ctrl/⌘+Shift+M，可在设置自定义），保持全局生效、不在此重复处理 ──
      if (_matchesAccel(input, mainPageHotkeyAccel)) return

      // ── 屏蔽：其余带修饰键或功能键的快捷键一律拦截；普通字符输入放行 ──
      const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
      const hasModifier = input.control || input.alt || input.meta
      if (hasModifier || isFunctionKey) {
        event.preventDefault()
      }
    })
  } catch (e) {
    console.warn('[Shortcut] 主窗口快捷键拦截注册失败:', e && e.message)
  }

  // 主页面显隐快捷键（默认 Ctrl/⌘+Shift+M，可在「设置-通用」中自定义，修改后即时生效）
  registerMainPageHotkey()

  mainPageWindow.on('closed', () => {
    mainPageWindow = null
    try { globalShortcut.unregister(mainPageHotkeyAccel) } catch (e) {}
  })

  // 顶部菜单栏（在线用户 + 设置），复用托盘菜单逻辑；在线用户列表会随连接状态刷新
  try { mainPageWindow.setMenu(null) } catch (e) { console.warn('[Menu] 顶部菜单设置失败:', e && e.message) }

  // ─── 主窗口导航边界：只允许停在「主页地址所在站点」内，跨站一律不进入主窗口 ───
  // 线上问题：网页里存在指向 patrol.tygps.com（另一套系统）的跳转，无论它是同窗 <a>、
  //   location.href 还是服务端 302，主窗口都会被整体替换成那个站点——e日志 界面直接消失，
  //   托盘/会议状态与页面脱节，用户只能去设置里把地址改回来。
  // 规则：主框架（main frame）的导航目标必须与「当前主页地址」同站点——host + port 一致，
  //   http/https 互认（openMainPage 有 http→https 升级与失败回退）。只堵"主窗口自己被换掉"的两条通道：
  //     ① 渲染进程发起的跳转   → will-navigate
  //     ② 服务端 302/307 重定向 → will-redirect
  // 不涉及新开窗口：window.open / _blank 弹出来的窗口不受站点限制（见下方 setWindowOpenHandler）。
  // 只约束主框架：不注册 will-frame-navigate，页面内嵌的第三方 iframe 照常工作。
  // 站点信息每次实时读 settingsStore——用户在「设置」里改主页地址后立即生效，不吃启动快照。
  // 放行严格程度：false＝同站点任意路径都算"主页范围内"（默认）；
  //   true＝还要求目标 path 落在主页地址所在目录内（如只许 /mylog-pc/ 下的页面）。
  //   默认不收紧的原因：线上存在 /login、/sso 这类主页目录之外的同站跳转，收紧会把登录流程一起拦死。
  const STRICT_DIR_SCOPE = false
  // 当前配置里的主页地址（错误页「重试」要回到这里）。每次实时读，改设置后立即生效。
  const homeUrl = () => (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
  const mainSite = () => {
    const raw = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
    try {
      const u = new URL(raw)
      if (!/^https?:$/i.test(u.protocol)) return null
      // 目录前缀：去掉最后一段文件名（主页通常以 / 结尾，此时 dir 就是 pathname 本身）
      let dir = u.pathname || '/'
      if (!dir.endsWith('/')) dir = dir.slice(0, dir.lastIndexOf('/') + 1) || '/'
      return { host: u.hostname.toLowerCase().replace(/\.$/, ''), port: u.port || '', dir }
    } catch (e) { return null }
  }
  // 本地开发地址：localhost / 127.0.0.1 / [::1]（任意端口）始终视为「站内」。
  // 理由：主窗口通常配的是生产地址（如 data.tygps.com），但开发/联调时必须能切到本地
  // dev server（vite 5173，且端口可能漂移），否则每次都要改设置、还会被跨站守卫拦成错误页。
  // 安全边界：目标仍是本机回环地址，不属于「外部站点」，不会把主窗口带到任意公网页面。
  const isLocalDevUrl = (target) => {
    try {
      const u = new URL(target)
      if (!/^https?:$/i.test(u.protocol)) return false
      const h = u.hostname.toLowerCase().replace(/\.$/, '')
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
    } catch (e) { return false }
  }
  const inMainSite = (target) => {
    if (!target) return false
    let u
    try { u = new URL(target) } catch (e) { return false }
    if (!/^https?:$/i.test(u.protocol)) return false
    if (isLocalDevUrl(target)) return true      // 本地开发地址一律放行
    const site = mainSite()
    if (!site) return false
    if (u.hostname.toLowerCase().replace(/\.$/, '') !== site.host) return false
    if ((u.port || '') !== site.port) return false
    if (STRICT_DIR_SCOPE && !u.pathname.startsWith(site.dir)) return false
    return true
  }
  // 本地页只认本应用自带的 splash / 错误页（都在 src/ 下），其余 file:// 一并拦掉，
  // 免得网页侧借 file:// 把主窗口导航去读本地磁盘；data:/about: 等特殊协议不参与站点校验。
  const isLocalOrSpecialUrl = (target) => {
    const t = target || ''
    if (/^(about|data|blob|devtools|chrome-extension):/i.test(t)) return true
    if (!/^file:\/\//i.test(t)) return false
    try {
      const p = decodeURIComponent(t.replace(/^file:\/\//i, '')).replace(/^\/+/, '')
      return path.normalize(p).toLowerCase().startsWith(path.normalize(path.join(__dirname, 'src')).toLowerCase())
    } catch (e) { return false }
  }
  const guardMainFrameNav = (kind) => (event, legacyUrl) => {
    if (!mainPageWindow || mainPageWindow.isDestroyed()) return
    // Electron 32：详情挂在 event 上（event.url / event.isMainFrame），旧签名参数仍传但已废弃
    if (event && event.isMainFrame === false) return
    const target = (event && typeof event.url === 'string' && event.url) || (typeof legacyUrl === 'string' ? legacyUrl : '')
    if (!target || isLocalOrSpecialUrl(target) || inMainSite(target)) return
    // mailto:/tel: 交给系统邮件客户端 / 拨号器，别在主窗口里当"被拦截"静默吞掉
    if (/^(mailto|tel):/i.test(target)) {
      event.preventDefault()
      try { shell.openExternal(target) } catch (e) {}
      return
    }
    event.preventDefault()
    console.warn('[MainPage] 已阻止跨站' + kind + ':', target, '| 允许站点:', (mainSite() || {}).host || '(未配置)')
    // 用户手上有活页（已正常打开主页）时，跨站跳转一律"外面开、主页不动"：
    //   站外地址不是没法访问，只是不该把 e日志 主窗口换掉——主窗口一丢，IM/会议/画板全部脱节，
    //   而且网页侧可能已经把内存状态（正在编辑的内容、未发送草稿）一并带走。
    //   注意：这里不做站点白名单，只影响"在哪打开"，与 setWindowOpenHandler 的口径一致。
    try {
      const cur = mainPageWindow.webContents.getURL() || ''
      const hasLivePage = cur && cur !== 'about:blank' && cur.indexOf('splash.html') === -1 && cur.indexOf('mainpage-error') === -1
      if (hasLivePage && /^https?:/i.test(target)) {
        shell.openExternal(target)
      } else if (!hasLivePage) {
        // 首屏就被带去站外时页面还没有任何内容，别把用户留在空白窗口——给一张可读的说明页
        mainPageWindow.loadURL('file://' + path.join(__dirname, 'src', 'mainpage-error.html') +
          '?reason=blocked&home=' + encodeURIComponent(homeUrl()) + '&url=' + encodeURIComponent(target))
      }
    } catch (e) { console.warn('[MainPage] 处理跨站跳转失败:', e && e.message) }
  }
  try {
    mainPageWindow.webContents.on('will-navigate', guardMainFrameNav('跳转'))
    mainPageWindow.webContents.on('will-redirect', guardMainFrameNav('重定向'))
  } catch (e) { console.warn('[MainPage] 导航边界注册失败:', e && e.message) }

  // ─── 下载 / 新窗口拦截：<a> 下载直接下载不弹新窗；外链用系统浏览器打开 ───
  // 注意边界：这里只管"用什么方式打开"，**不做站点白名单**——新开的窗口不受主页站点限制，
  //   网页想弹新窗就弹、想开外链就开（_blank 类走系统浏览器）。只约束主窗口自身不被换站，
  //   那是上面 will-navigate / will-redirect 的职责。
  // 文件扩展名白名单：命中则视为"下载链接"直接下载（进下载中心），否则视为普通外链走系统浏览器
  const DOWNLOAD_EXT_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|pdf|docx?|xlsx?|pptx?|mp3|wav|m4a|aac|flac|ogg|mp4|mkv|avi|mov|wmv|flv|webm|apk|exe|msi|dmg|iso|csv|json|xml|txt|png|jpe?g|gif|webp|bmp|svg|psd|dwg)(\?|$)/i
  function looksLikeDownload(url) {
    if (!url) return false
    try { return DOWNLOAD_EXT_RE.test(new URL(url).pathname) } catch (e) { return DOWNLOAD_EXT_RE.test(url) }
  }
  try {
    mainPageWindow.webContents.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'download' || disposition === 'saveToDisk' || looksLikeDownload(url)) {
        // 直接触发下载（进 will-download → 下载中心），不再弹新窗 / 打开浏览器
        try { mainPageWindow.webContents.downloadURL(url) } catch (e) { console.warn('[Download] 触发失败:', e && e.message) }
        return { action: 'deny' }
      }
      if (disposition === 'new-window' || disposition === 'foreground-tab' || disposition === 'background-tab') {
        // 普通外链（_blank 等）用系统默认浏览器打开，不在应用内开新窗
        if (url && /^https?:\/\//i.test(url)) { try { require('electron').shell.openExternal(url) } catch (e) {} }
        return { action: 'deny' }
      }
      return { action: 'allow' } // 同窗口导航
    })
    // 实际落盘 + 任务跟踪：默认存到用户下载目录，进度/状态实时推给下载中心
    // 命名 handler + 防重标志：openMainPage 在窗口销毁重建时会再次执行，避免重复注册导致任务双记
    if (!global.__dlSessionBound) {
      global.__dlSessionBound = true
      mainPageWindow.webContents.session.on('will-download', handleWillDownload)
    }
  } catch (e) { console.warn('[WebContents] 下载/新窗口拦截设置失败:', e && e.message) }

  // ─── 全屏时隐藏顶部菜单栏（窗口全屏 + 页面 DOM 全屏都覆盖）──
  const _hideMenuOnFs = () => { try { mainPageWindow.setMenuBarVisibility(false) } catch (e) {} }
  const _showMenuOnFs = () => { try { mainPageWindow.setMenuBarVisibility(true) } catch (e) {} }
  mainPageWindow.on('enter-full-screen', _hideMenuOnFs)
  mainPageWindow.on('leave-full-screen', _showMenuOnFs)
  mainPageWindow.on('enter-html-full-screen', _hideMenuOnFs)
  mainPageWindow.on('leave-html-full-screen', _showMenuOnFs)

  // 主页面 shim 注入时机：优先 dom-ready（比 did-finish-load 更早，在 SDK 脚本执行前包裹），
  // did-finish-load 作为备用（全页重载时 JS 上下文重建，__SCREEN_SHARE_SHIM_INSTALLED__ 重置，
  // 需重新注入；shim 内部有防重包裹守卫）。
  // SPA 内部路由切换不会触发这两个事件，shim 持久化于同一 JS 上下文。
  mainPageWindow.webContents.on('dom-ready', () => injectScreenShareShim(mainPageWindow))
  mainPageWindow.webContents.on('did-finish-load', () => injectScreenShareShim(mainPageWindow))

  // 启动预授权：主页面首次加载完成后，在主页面 origin 内静默 getUserMedia 并立即关闭，
  // 把媒体权限置为 granted，消除"首次会议才被发现没声音"的窗口期。
  // 兜底：失败不阻断，仅记日志（用户仍可手动点击托盘「打开麦克风/摄像头」或诊断页按钮兜底）。
  mainPageWindow.webContents.on('did-finish-load', () => {
    if (mediaPreAuthed) return
    mediaPreAuthed = true
    setTimeout(() => {
      activateMediaInMainPage()
        .then((r) => { if (!r.ok) console.warn('[MediaPreAuth] 预授权未全部成功（可手动激活兜底）:', (r.audio && !r.audio.ok ? ('audio:' + r.audio.name) : ''), (r.video && !r.video.ok ? ('video:' + r.video.name) : '')) })
        .catch(() => {})
    }, 1500)
  })

  // 加载状态：任务栏不确定进度
  mainPageWindow.webContents.on('did-start-loading', () => {
    mainPageWindow.setProgressBar(-1, { mode: 'indeterminate' })
  })
  mainPageWindow.webContents.on('did-stop-loading', () => {
    mainPageWindow.setProgressBar(-1)
  })
  mainPageWindow.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
    console.warn('[MainPage] load failed:', errorCode, errorDescription, validatedURL)
    mainPageWindow.setProgressBar(-1)
    // https 升级回退：https 加载失败（如站点不支持 https）时回退原 http（仅一次），避免 http 站点直接白屏
    if (fallbackUrl && validatedURL && validatedURL.indexOf('https://') === 0 && fallbackUrl.indexOf('http://') === 0) {
      const fu = fallbackUrl; fallbackUrl = null
      console.warn('[MainPage] https 加载失败，回退 http:', fu)
      if (mainPageWindow.getURL() !== fu) mainPageWindow.loadURL(fu)
      return
    }
    const errPage = 'file://' + path.join(__dirname, 'src', 'mainpage-error.html') +
      '?url=' + encodeURIComponent(validatedURL || url) + '&home=' + encodeURIComponent(homeUrl())
    // 防递归：错误页自身加载失败时不再二次 load（避免无限循环空白）
    if (mainPageWindow.getURL() !== errPage) mainPageWindow.loadURL(errPage)
  })
  // 渲染进程崩溃（如网页端 JS 致命错误导致 renderer 挂掉）→ 显示错误页而非空白
  mainPageWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[MainPage] 渲染进程崩溃:', details && details.reason)
    if (mainLoadTimer) { clearTimeout(mainLoadTimer); mainLoadTimer = null }
    if (mainPageWindow && !mainPageWindow.isDestroyed()) {
      const errPage = 'file://' + path.join(__dirname, 'src', 'mainpage-error.html') +
        '?url=' + encodeURIComponent(url) + '&reason=crash&home=' + encodeURIComponent(homeUrl())
      if (mainPageWindow.getURL() !== errPage) mainPageWindow.loadURL(errPage)
    }
  })

  // 记忆窗口尺寸/位置
  mainPageWindow.on('resize', saveMainPageBounds)
  mainPageWindow.on('move', saveMainPageBounds)

  // 窗口最大化/还原/全屏态变化时，实时推送标题栏（供"恢复"图标切换）
  const _onWinState = () => pushTitlebarState()
  mainPageWindow.on('maximize', _onWinState)
  mainPageWindow.on('unmaximize', _onWinState)
  mainPageWindow.on('enter-full-screen', _onWinState)
  mainPageWindow.on('leave-full-screen', _onWinState)

  // 先加载本地 splash（瞬时、零网络），splash 渲染完成即用 ready-to-show 显示窗口，
  // 随后在后台加载远程主页，完成即替换内容。这样：① 窗口即时可见、无"隐藏后突然弹出"；
  // ② 底色为 app 灰（backgroundColor）而非默认白，消除白屏闪烁；③ 远程 SPA 慢加载期间有品牌加载页兜底。
  mainPageWindow.once('ready-to-show', () => {
    // 开机自启（带 --hidden）时不主动弹出窗口，仅驻留托盘；用户可点托盘「打开主页面」手动唤出
    if (!LAUNCHED_HIDDEN) {
      try { mainPageWindow.show(); mainPageWindow.focus() } catch (e) {}
    }
    // 初始推送一次窗口状态（非最大化），保证标题栏图标初始为"最大化"
    pushTitlebarState()
  })
  mainPageWindow.loadFile(path.join(__dirname, 'src', 'splash.html'))
  mainPageWindow.webContents.once('did-finish-load', () => {
    // splash 已就绪，转去加载真正的远程主页（后台加载，完成即替换内容，无白屏）
    if (mainPageWindow && !mainPageWindow.isDestroyed()) {
      mainPageWindow.loadURL(url)
      // 加载超时兜底（逻辑见 armMainLoadTimeout，重试路径也复用它）
      armMainLoadTimeout(url)
    }
  })
}

function createTray() {
  loadIconCache()
  // Start with gray icon (no WS connections yet)
  const startIcon = trayIcon(iconCache.gray || iconCache.default)
  tray = new Tray(startIcon)
  setTrayState('gray')
  updateTrayMenu()

  tray.on('click', () => {
    // 左键点击 → toggle 主窗口显隐（与钉钉/微信一致）。
    // macOS：先 app.show() 把 App 激活到前台，再 toggleMainPage（内部 show 才会生效）。
    if (process.platform === 'darwin') { try { app.show() } catch (e) {} }
    toggleMainPage()
  })
}

// ─── Protocol handler ─────────────────────────────────────
function registerProtocol() {
  if (process.defaultApp) return
  app.setAsDefaultProtocolClient('web+mylog')
}

// ─── WebSocket server ──────────────────────────────────
function startWSServer() {
  wsServer = new WebSocketServer({ port: currentWsPort, host: '127.0.0.1' })

  wsServer.on('connection', (ws, request) => {
    const clientId = ++clientIdCounter
    const now = Date.now()
    // 通过 UA 标记识别应用窗口连接（mainPageWindow）vs 外部浏览器连接
    // 应用窗口 UA 末尾含 MylogDesktop/1.0（由 app.whenReady 中 setUserAgent 注入）
    const reqUA = (request && request.headers && request.headers['user-agent']) || ''
    const isAppWindow = /MylogDesktop/i.test(reqUA)
    console.log('[WS] Browser connected, clientId:', clientId, 'isAppWindow:', isAppWindow)

    // Pre-register placeholder so we can track this connection
    connectedClients.set(ws, {
      clientId,
      userId: '',
      userName: '',
      userIcon: '',
      browserType: '',
      connected: true,
      localIconPath: '',
      lastSeenAt: now,
      isAppWindow,
      isAgent: false,
    })

    ws.send(JSON.stringify({ type: 'CONNECTED', payload: { version: version, port: currentWsPort } }))

    // New WS connection → switch from gray to default if needed
    if (trayIconState === 'gray') {
      setTrayState('default')
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw)
        handleBrowserMessage(ws, msg)
      } catch (e) {
        console.warn('[WS] Invalid message:', raw)
      }
    })

    ws.on('close', () => {
      // 清理该连接上未完成的 Agent 请求，避免悬挂
      clearAgentRequestsFor(ws)
      const entry = connectedClients.get(ws)
      if (entry) {
        console.log('[WS] Browser disconnected:', entry.userName || entry.userId || `client#${entry.clientId}`)
        // Mark as disconnected with timestamp (keep in map so tray can show "已断开")
        entry.connected = false
        entry.lastSeenAt = Date.now()
        connectedClients.set(ws, entry)
        updateTrayMenu()

        // Clean up anonymous connections (never registered) immediately
        if (!entry.userId && !entry.userName) {
          connectedClients.delete(ws)
        }

        // If no more connected clients and not ringing → switch to gray
        if (!hasConnectedClients() && trayIconState !== 'ringing') {
          setTrayState('gray')
        }
      } else {
        console.log('[WS] Browser disconnected (unregistered)')
      }
    })
  })

  wsServer.on('error', (err) => {
    console.error('[WS] Server error:', err)
  })

  console.log('[WS] Server listening on ws://127.0.0.1:', currentWsPort)

  // Start periodic cleanup of stale disconnected entries
  startStaleCleanup()
}

// ─── Handle browser messages ──────────────────────────
function handleBrowserMessage(ws, msg) {
  // payload 必须序列化后再打：直接传对象会输出 [object Object]，排查时等于没日志
  try {
    const raw = JSON.stringify(msg.payload || {})
    console.log('[WS] Message:', msg.type, raw.length > 800 ? raw.slice(0, 800) + '…' : raw)
  } catch (e) {
    console.log('[WS] Message:', msg.type, '(unserializable)')
  }

  switch (msg.type) {
    case 'REGISTER':
      setUserInfo({
        userId: msg.payload?.userId,
        userName: msg.payload?.userName,
        userIcon: msg.payload?.userIcon,
        browserType: msg.payload?.browserType
      }, ws)   // pass ws client for multi-user tracking
      // 标记 Agent 连接（WorkBuddy 连接器），用于后续 AGENT_RESULT 路由回写
      if (msg.payload?.browserType === 'agent') {
        const e = connectedClients.get(ws)
        if (e) { e.isAgent = true; connectedClients.set(ws, e) }
        console.log('[WS] Agent client registered, clientId:', clientId)
      }
      break

    case 'SHOW_CALL_NOTIFICATION':
      if (!msg.payload || !msg.payload.callId) {
        console.warn('[Validation] Skip call notification: missing callId')
        return
      }
      if (!msg.payload.callerName) {
        console.warn('[Validation] Skip call notification: missing callerName')
        return
      }
      if (isDuplicateCall(msg.payload.callId)) {
        console.log('[Dedup] Skip duplicate call:', msg.payload.callId)
        return
      }
      // 来电/会议弹窗永远不隐藏：模式设置只决定铃声是否静音（在 showCallWindow/showMeetingWindow
      // 中由 ringtoneResolver 返回 null 控制），弹窗本身始终展示，由网页端承载通话 UI。
      setTrayState('ringing')
      if (msg.payload.callType === 'meeting') {
        showMeetingWindow(msg.payload, ws)
      } else {
        showCallWindow(msg.payload, ws)
      }
      break

    case 'SHOW_MESSAGE_NOTIFICATION': {
      const p = msg.payload || {}
      // 每一次消息都留痕（含判定结果）：排查「没提醒」时先看这一行在不在
      const mirror = isMirrorClient(ws)
      console.log('[NC] SHOW_MESSAGE_NOTIFICATION cid=', p.conversationId,
        '| count=', p.unreadCount, '| muted=', !!p.muted,
        '| mirror=', mirror, '| hasAppClient=', hasAppClient())
      // 桌面主窗口在线时，外部浏览器标签页的消息不再驱动提醒（避免双端未读数互相覆盖）
      if (mirror) {
        console.log('[Dedup] Ignore message notify from mirror client (app window is online)')
        break
      }
      // 去重只在「没有权威未读数」时启用（兼容老版本网页）。
      // ★ 有 unreadCount 时绝不能按「会话+内容」去重：同一个人连发几条相同的「好的」，
      //   3s 窗口内后几条会被当成重复直接丢掉 —— 表现为未读数不涨、提醒不弹。
      //   有权威值时重复推送本身就是幂等的（计数被归一、响铃按会话去重）。
      const hasAuthCount = (typeof p.unreadCount === 'number' && p.unreadCount > 0)
      if (!hasAuthCount && isDuplicateToast(p.conversationId, p.content)) {
        console.log('[Dedup] Skip duplicate toast')
        return
      }
      if (notificationCenter) notificationCenter.pushMessage(p)
      break
    }

    case 'SYNC_CONTACTS':
      if (notificationCenter && Array.isArray(msg.payload?.contacts)) {
        notificationCenter.syncContacts(msg.payload.contacts)
        console.log('[WS] Synced contacts:', msg.payload.contacts.length)
      }
      break

    // 网页端实时下发的权威未读状态（IM SDK 真实未读数），桌面端以此为准重建聚合
    case 'SYNC_UNREAD':
      if (isMirrorClient(ws)) {
        console.log('[Dedup] Ignore SYNC_UNREAD from mirror client (app window is online)')
        break
      }
      if (notificationCenter && Array.isArray(msg.payload?.items)) {
        notificationCenter.syncUnread(msg.payload.items)
        console.log('[WS] Synced unread from web:', msg.payload.items.length, 'items')
      }
      break

    // 网页端下发的审批待办列表（payload = { approvals: [...] }），桌面端只读聚合展示
    case 'SYNC_APPROVALS':
      if (notificationCenter && Array.isArray(msg.payload?.approvals)) {
        const n = notificationCenter.syncApprovals(msg.payload.approvals)
        console.log('[WS] Synced approvals from web:', n.length, 'items')
      }
      break

    case 'UPDATE_UNREAD_COUNT':
      updateUnreadCount(msg.payload?.count || 0)
      break

    // 网页端已读同步：payload = { conversationId? } 或 {} 表示全部已读
    case 'MARK_READ':
      if (notificationCenter) {
        notificationCenter.markRead(msg.payload?.conversationId || 'all')
        console.log('[WS] Mark read from web:', msg.payload?.conversationId || 'all')
      }
      break

    // 网页端当前正在查看的会话变化（打开/切换/关闭）。conversationId 为 null 表示无具体会话（如停留在会话列表）。
    // 桌面端据此实时感知"用户正在看哪个会话"，抑制该会话的消息弹窗与未读闪烁；
    // 切到某会话即清掉它的未读，托盘立即停止闪烁（解决「网页端已读状态未实时同步到桌面」的问题）。
    case 'ACTIVE_CONVERSATION':
      if (notificationCenter) {
        const cid = (msg.payload && msg.payload.conversationId) ? msg.payload.conversationId : null
        notificationCenter.setActiveConversation(cid)
        console.log('[WS] Active conversation:', cid)
      }
      break

    case 'CALL_CONNECTED':
    case 'CALL_ENDED':
      setTrayState(deriveTrayState())
      closeCallWindow()
      closeMeetingWindow()
      break

    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }))
      break

    // ── Connection state messages (from web) ─────────────
    case 'KICKED':
      console.log('[WS] User kicked offline')
      markClientOffline(ws, '被踢下线')
      if (notificationCenter) {
        const rp = ringtoneResolver ? ringtoneResolver.resolve('message', null) : null
        notificationCenter.pushSysAlert({
          id: 'kick',
          type: 'kick',
          sticky: true,
          time: Date.now(),
          data: {
            reason: msg.payload?.reason || '',
            device: msg.payload?.device || '',
            time: msg.payload?.time || Date.now(),
          },
          ringtonePath: rp,
        })
      }
      break

    case 'NET_OFFLINE':
      console.log('[WS] Network offline reported by web')
      markClientOffline(ws, '网络离线')
      if (notificationCenter) {
        notificationCenter.pushSysAlert({
          id: 'offline',
          type: 'offline',
          sticky: true,
          time: Date.now(),
          data: { time: msg.payload?.time || Date.now() },
          ringtonePath: null,   // 离线条提示，默认无声
        })
      }
      break

    case 'NET_ONLINE':
      console.log('[WS] Network online reported by web')
      if (ws && connectedClients.has(ws)) {
        const entry = connectedClients.get(ws)
        entry.connected = true
        entry.lastSeenAt = Date.now()
        connectedClients.set(ws, entry)
        updateTrayMenu()
        setTrayState('default')
      }
      if (notificationCenter) {
        notificationCenter.dismissSysAlert('offline')
        // 重连上线后，被踢常驻提醒也随之消除（符合「直到重连上线或手动关闭」）
        notificationCenter.dismissSysAlert('kick')
      }
      break

    // ── Agent 中继（WorkBuddy 连接器 ↔ 应用窗口）────────────
    // 来自连接器的意图：校验应用窗口在线 → 暂存 requestId → 转发给应用窗口
    case 'AGENT_INTENT': {
      const payload = msg.payload || {}
      const requestId = payload.requestId
      if (!requestId) {
        ws.send(JSON.stringify({ type: 'AGENT_RESULT', payload: { requestId: null, ok: false, error: 'BAD_REQUEST:missing requestId' }, timestamp: Date.now() }))
        break
      }
      // 应用窗口未就绪：立即失败，绝不排队（避免乱序灾难）
      if (!hasAppClient()) {
        ws.send(JSON.stringify({ type: 'AGENT_RESULT', payload: { requestId, ok: false, error: 'WEB_OFFLINE' }, timestamp: Date.now() }))
        break
      }
      // 重复 requestId：忽略，避免结果被旧连接消费
      if (pendingAgentRequests.has(requestId)) {
        ws.send(JSON.stringify({ type: 'AGENT_RESULT', payload: { requestId, ok: false, error: 'DUP_REQUEST_ID' }, timestamp: Date.now() }))
        break
      }
      const timer = setTimeout(() => {
        if (pendingAgentRequests.has(requestId)) {
          pendingAgentRequests.delete(requestId)
          ws.send(JSON.stringify({ type: 'AGENT_RESULT', payload: { requestId, ok: false, error: 'TIMEOUT' }, timestamp: Date.now() }))
        }
      }, AGENT_REQUEST_TIMEOUT_MS)
      pendingAgentRequests.set(requestId, { ws, timer })
      sendToAppClient({ type: 'AGENT_INTENT', payload })
      break
    }

    // 来自应用窗口的执行结果：按 requestId 路由回发起意图的连接器
    case 'AGENT_RESULT': {
      const payload = msg.payload || {}
      const requestId = payload.requestId
      // 优先回写 HTTP 长连接请求（/api/agent/intent）
      const hp = pendingHttpRequests.get(requestId)
      if (hp) {
        pendingHttpRequests.delete(requestId)
        clearTimeout(hp.timer)
        if (payload.ok) hp.resolve(payload.data)
        else hp.reject(new Error(payload.error || 'EXEC_FAIL'))
        break
      }
      const pending = pendingAgentRequests.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingAgentRequests.delete(requestId)
        pending.ws.send(JSON.stringify({ type: 'AGENT_RESULT', payload, timestamp: Date.now() }))
      } else {
        console.warn('[WS] AGENT_RESULT 无匹配请求（可能已超时）:', requestId)
      }
      break
    }

    // 来自应用窗口的异步事件（如来电主动提示）：广播给所有 Agent 连接
    case 'AGENT_EVENT':
      broadcastToAgentClients(msg)
      break

    default:
      console.log('[WS] Unknown message type:', msg.type)
  }
}

// ─── Deduplication helpers ────────────────────────────
function hashCode(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + c
    hash |= 0
  }
  return hash
}

function isDuplicateCall(callId) {
  if (!callId) return false
  const now = Date.now()
  for (const [key, ts] of recentCalls) {
    if (now - ts > DEDUP_CALL_WINDOW_MS) recentCalls.delete(key)
  }
  if (recentCalls.has(callId)) return true
  recentCalls.set(callId, now)
  return false
}

function isDuplicateToast(convId, content) {
  const now = Date.now()
  const contentHash = hashCode((content || '').slice(0, 100))
  const key = `${convId || 'no-conv'}:${contentHash}`
  for (const [k, ts] of recentToasts) {
    if (now - ts > DEDUP_TOAST_WINDOW_MS) recentToasts.delete(k)
  }
  if (recentToasts.has(key)) return true
  recentToasts.set(key, now)
  return false
}

// ─── Incoming call window (pre-created for instant show) ─
function preCreateCallWindow() {
  const rect = getNcRect(CALL_W, CALL_H)

  callWindow = new BrowserWindow({
    ...makePopupWindowOpts(CALL_W, CALL_H),
    x: rect.x,
    y: rect.y,
  })
  callWindow.setAlwaysOnTop(true, 'screen-saver')
  callWindow.setVisibleOnAllWorkspaces(true)
  callWindow.loadFile(path.join(__dirname, 'src', 'call-window.html'))
  // Preload ringtone as soon as page is ready — eliminates ~5s audio decode delay on call arrival
  callWindow.webContents.once('did-finish-load', () => {
    callWindow.webContents.send('preload-ringtone', {
      ringtonePath: ringtoneResolver ? ringtoneResolver.resolve('audio', null) : getRingtonePath(),
      ringtoneConfig: config.ringtone,
    })
  })
}

function showCallWindow(payload, ws) {
  if (!callWindow || callWindow.isDestroyed()) {
    preCreateCallWindow()
  }

  if (callWindow._timer) {
    clearTimeout(callWindow._timer)
    callWindow._timer = null
  }

  const rect = getNcRect(CALL_W, CALL_H)
  callWindow.setPosition(rect.x, rect.y)
  callWindow.webContents.setAudioMuted(false)   // Unmute in case previously muted
  callWindow.show()
  callWindow.focus()

  function sendCallPayload() {
    // resolver 可用时直接采用其返回值：返回 null 表示静音（silent/dnd/总开关关闭/blockChat 消息），
    // 必须如实传递 null 给来电窗口，不得回退默认铃声，否则静音/勿扰失效。
    // 仅当 resolver 本身未初始化时才回退默认铃声（保证有铃路径始终可用）。
    var rp = ringtoneResolver
      ? ringtoneResolver.resolve(payload.callType || 'audio', payload.callerId)
      : getRingtonePath()
    callWindow.webContents.send('call-data', {
      ...payload,
      ringtonePath: rp,
      ringtoneConfig: config.ringtone,
    })
  }
  if (callWindow.webContents.isLoading()) {
    callWindow.webContents.once('did-finish-load', sendCallPayload)
  } else {
    sendCallPayload()
  }
  callWindow._callId = payload.callId || ''

  const timer = setTimeout(() => {
    if (callWindow && !callWindow.isDestroyed() && callWindow.isVisible()) {
      closeCallWindow()
      endRingingState()
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: { action: 'timeout', callId: payload.callId }
        }))
      }
    }
  }, config.timeout.call)
  callWindow._timer = timer
}

function closeCallWindow() {
  if (callWindow && !callWindow.isDestroyed()) {
    // 1. Synchronous audio mute — kills ALL sound instantly (no async, no race condition)
    try { callWindow.webContents.setAudioMuted(true) } catch(e) {}
    // 2. Async JS cleanup as backup (release audio resources)
    try { callWindow.webContents.executeJavaScript('try{if(window.__stopRingtone)window.__stopRingtone()}catch(e){}') } catch(e) {}
    callWindow.hide()
    callWindow.webContents.send('stop-ringtone')
    callWindow.webContents.send('call-closed')
    if (callWindow._timer) {
      clearTimeout(callWindow._timer)
      callWindow._timer = null
    }
  }
}

// ─── Meeting window (screen center, dedicated to meeting invites) ─
function preCreateMeetingWindow() {
  const rect = getNcRect(MEETING_W, MEETING_H)

  meetingWindow = new BrowserWindow({
    ...makePopupWindowOpts(MEETING_W, MEETING_H),
    x: rect.x,
    y: rect.y,
  })
  meetingWindow.setAlwaysOnTop(true, 'screen-saver')
  meetingWindow.setVisibleOnAllWorkspaces(true)
  meetingWindow.loadFile(path.join(__dirname, 'src', 'meeting-window.html'))
  // Preload ringtone as soon as page is ready — eliminates ~5s audio decode delay on call arrival
  meetingWindow.webContents.once('did-finish-load', () => {
    meetingWindow.webContents.send('preload-ringtone', {
      ringtonePath: ringtoneResolver ? ringtoneResolver.resolve('meeting', null) : getRingtonePath(),
      ringtoneConfig: config.ringtone,
    })
  })
}

function showMeetingWindow(payload, ws) {
  if (!meetingWindow || meetingWindow.isDestroyed()) {
    preCreateMeetingWindow()
  }

  if (meetingWindow._timer) {
    clearTimeout(meetingWindow._timer)
    meetingWindow._timer = null
  }

  const rect = getNcRect(MEETING_W, MEETING_H)
  meetingWindow.setPosition(rect.x, rect.y)
  meetingWindow.webContents.setAudioMuted(false)   // Unmute in case previously muted
  meetingWindow.show()
  meetingWindow.focus()

  function sendMeetingPayload() {
    // resolver 可用时直接采用其返回值：返回 null 表示静音（silent/dnd/总开关关闭/blockChat 消息），
    // 必须如实传递 null，不得回退默认铃声，否则静音/勿扰失效；仅 resolver 未初始化时回退默认铃声。
    var rp = ringtoneResolver
      ? ringtoneResolver.resolve('meeting', payload.callerId)
      : getRingtonePath()
    meetingWindow.webContents.send('meeting-data', {
      ...payload,
      ringtonePath: rp,
      ringtoneConfig: config.ringtone,
    })
  }
  if (meetingWindow.webContents.isLoading()) {
    meetingWindow.webContents.once('did-finish-load', sendMeetingPayload)
  } else {
    sendMeetingPayload()
  }
  meetingWindow._callId = payload.callId || ''
  meetingWindow._callType = 'meeting'

  const timer = setTimeout(() => {
    if (meetingWindow && !meetingWindow.isDestroyed() && meetingWindow.isVisible()) {
      closeMeetingWindow()
      endRingingState()
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: { action: 'timeout', callId: payload.callId, callType: 'meeting' }
        }))
      }
    }
  }, config.timeout.call)
  meetingWindow._timer = timer
}

function closeMeetingWindow() {
  if (meetingWindow && !meetingWindow.isDestroyed()) {
    // 1. Synchronous audio mute — kills ALL sound instantly (no async, no race condition)
    try { meetingWindow.webContents.setAudioMuted(true) } catch(e) {}
    // 2. Async JS cleanup as backup (release audio resources)
    try { meetingWindow.webContents.executeJavaScript('try{if(window.__stopRingtone)window.__stopRingtone()}catch(e){}') } catch(e) {}
    meetingWindow.hide()
    meetingWindow.webContents.send('stop-ringtone')
    meetingWindow.webContents.send('meeting-closed')
    if (meetingWindow._timer) {
      clearTimeout(meetingWindow._timer)
      meetingWindow._timer = null
    }
  }
}

// ─── Message toast (legacy) ─────────────────────────
// 已被通知中心（notificationCenter）取代：SHOW_MESSAGE_NOTIFICATION → notificationCenter.pushMessage
// 保留 toastWindow 变量仅用于退出清理（恒为 null）。

// 强制将主页面窗口（网页）置顶显示——用于桌面被叫弹窗"接听"后把网页窗口拉到最前。
// 不能直接用 openMainPage()：其内部对"已可见且聚焦"的窗口会执行隐藏（类 IM 切换语义），
// 接听场景必须强制置顶而非切换，否则在网页窗口恰好聚焦时会误隐藏。
function focusMainPage() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) {
    openMainPage()
    return
  }
  if (mainPageWindow.isMinimized()) mainPageWindow.restore()
  mainPageWindow.show()
  mainPageWindow.focus()
  // 短暂置顶，确保从被叫弹窗切换到网页窗口时一定能到最前（规避 Windows 前台锁限制）
  try {
    mainPageWindow.setAlwaysOnTop(true)
    setTimeout(() => {
      try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setAlwaysOnTop(false) } catch (_) {}
    }, 1200)
  } catch (_) {}
}

// ─── IPC handlers ─────────────────────────────────────
// 通知中心渲染层的日志（渲染进程异常无法被主进程看到，必须回传落盘）
ipcMain.on('nc-log', (event, msg) => {
  try { console.log('[NCR]', String(msg).slice(0, 2000)) } catch (e) {}
})

ipcMain.on('call-action', (event, action) => {
  console.log('[IPC] Call action:', action)
  // 接听：把网页窗口拉到最前（拒绝/超时无需处理）
  if (action === 'accept') focusMainPage()
  const callId = (callWindow && callWindow._callId) ? callWindow._callId : ''

  if (wsServer) {
    wsServer.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: { action, callId, callType: 'audio', timestamp: Date.now() }
        }))
      }
    })
  }
  closeCallWindow()
  endRingingState()
})

ipcMain.on('meeting-action', (event, action) => {
  console.log('[IPC] Meeting action:', action)
  // 接听：把网页窗口拉到最前（拒绝/超时无需处理）
  if (action === 'accept') focusMainPage()
  const callId = (meetingWindow && meetingWindow._callId) ? meetingWindow._callId : ''

  if (wsServer) {
    wsServer.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: { action, callId, callType: 'meeting', timestamp: Date.now() }
        }))
      }
    })
  }
  closeMeetingWindow()
  endRingingState()
})

ipcMain.on('open-browser', (event, url) => {
  safeOpenExternal(url)
})

// ─── Settings window IPC ──────────────────────────
ipcMain.handle('settings-load', () => {
  const s = settingsStore.getMerged()
  const urls = {}
  const allRels = ['assets/ringtone.m4a'].concat(config.ringtonePresets.builtin || [], s.localRingtones || [])
  allRels.forEach((r) => {
    const u = ringtoneResolver ? ringtoneResolver.toFile(r) : null
    if (u) urls[r] = u
  })
  return {
    settings: s,
    version: version,
    presets: config.ringtonePresets,
    // 展示名合并：内置名（config）为底，用户自定义（settings.ringtoneNames）覆盖
    names: Object.assign({}, config.ringtoneNames, (s.ringtoneNames || {})),
    builtin: config.ringtonePresets.builtin || [],
    localRingtones: s.localRingtones || [],
    contacts: settingsStore.loadContacts(),
    ringtoneDir: settingsStore.getRingtoneDir(),
    urls,
  }
})

ipcMain.on('settings-save', (event, partial) => {
  if (!partial || typeof partial !== 'object') return
  settingsStore.set(partial)
  if (partial && typeof partial.mainPageHotkey === 'string') registerMainPageHotkey()
  if (notificationCenter) notificationCenter.notifySettingsChanged()
})

// 捕获快捷键期间：临时注销全局显隐快捷键（避免 OS 在捕获时吞掉组合键），结束后恢复
ipcMain.on('hotkey-capture', (event, on) => {
  try {
    if (on) { globalShortcut.unregister(mainPageHotkeyAccel) }
    else { registerMainPageHotkey() }
  } catch (e) {}
})

// 删除指定联系人的专属铃声设置（真正移除 key，避免 deepMerge 把删除的 key 保留下来）
ipcMain.on('settings-remove-contact', (event, cid) => {
  if (!cid) return
  settingsStore.removeContactRingtone(cid)
  if (notificationCenter) notificationCenter.notifySettingsChanged()
})

ipcMain.handle('pick-ringtone', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: '选择铃声文件',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac'] }],
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null
    const src = result.filePaths[0]
    const ext = (path.extname(src).toLowerCase().replace(/^\./, '') || 'mp3')
    // 默认展示名 = 源文件名去掉扩展名（如 "我的铃声.mp3" → "我的铃声"）
    const base = path.basename(src)
    const name = base.replace(/\.[^.]+$/, '')
    const stat = fs.statSync(src)
    const hash = crypto.createHash('sha1').update(src + stat.size + Date.now()).digest('hex').slice(0, 16)
    const dir = settingsStore.getRingtoneDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const rel = `ringtones/${hash}.${ext}`
    fs.copyFileSync(src, path.join(dir, `${hash}.${ext}`))   // 主进程直接 copy，不限大小
    settingsStore.addLocalRingtone(rel)
    return { path: rel, name }
  } catch (e) {
    console.error('[Ringtone] pick failed:', e && e.message)
    return null
  }
})

// 重命名/清除某铃声的展示名（name 为空白则清除自定义名，回退为文件名显示）
ipcMain.handle('ringtone-rename', (event, rel, name) => {
  try {
    if (!rel || typeof rel !== 'string') return { names: {} }
    settingsStore.setRingtoneName(rel, name)
    const s = settingsStore.getMerged()
    return { names: Object.assign({}, config.ringtoneNames, s.ringtoneNames || {}) }
  } catch (e) {
    console.error('[Ringtone] rename failed:', e && e.message)
    return { names: {} }
  }
})

// 删除用户上传的铃声：解除所有引用（场景回退默认、联系人专属移除）→ 移除候选/映射 → 物理删文件。
// rel 必须以 'ringtones/' 开头且取 basename，杜绝路径穿越误删其它文件。
ipcMain.handle('ringtone-delete', (event, rel) => {
  try {
    if (!rel || typeof rel !== 'string' || !rel.startsWith('ringtones/')) {
      console.error('[Ringtone] delete rejected: bad rel', rel)
      return null
    }
    settingsStore.removeLocalRingtone(rel)
    // 物理删除（文件可能已不存在，忽略 ENOENT）
    const dir = settingsStore.getRingtoneDir()
    const file = path.join(dir, path.basename(rel))
    try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch (e) { /* 忽略 */ }
    if (notificationCenter) notificationCenter.notifySettingsChanged()
    // 返回最新候选数据，供渲染层无痛刷新
    const s = settingsStore.getMerged()
    const allRels = ['assets/ringtone.m4a'].concat(config.ringtonePresets.builtin || [], s.localRingtones || [])
    const urls = {}
    allRels.forEach((r) => {
      const u = ringtoneResolver ? ringtoneResolver.toFile(r) : null
      if (u) urls[r] = u
    })
    return {
      names: Object.assign({}, config.ringtoneNames, s.ringtoneNames || {}),
      localRingtones: s.localRingtones || [],
      urls,
    }
  } catch (e) {
    console.error('[Ringtone] delete failed:', e && e.message)
    return null
  }
})

ipcMain.on('set-auto-start', (event, value) => {
  const v = !!value
  setAutoStart(v)
  settingsStore.set({ autoStart: v })
  updateTrayMenu()
})

// 设置-关于「应用」按钮：立即把主页面窗口刷新为新地址（即时生效）
ipcMain.handle('navigate-mainpage', (event, url) => {
  const u = (url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'invalid-url' }
  settingsStore.set({ mainPageUrl: u })
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    mainPageWindow.loadURL(u)
    if (!mainPageWindow.isVisible()) mainPageWindow.show()
    mainPageWindow.focus()
    return { ok: true }
  }
  // 主页面窗口尚未创建：下次打开会用新地址，此处主动打开以满足"即时"需求
  openMainPage()
  return { ok: true }
})

// 设置面板「通用」页拉取当前在线用户列表（与托盘菜单一致）
ipcMain.handle('tray-users-get', () => getTrayUsersData())

// 错误页（mainpage-error.html）的「重试 / 返回主页」。
// ★ 只接受「主页同站点」的地址，其余一律回落到配置里的主页地址——错误页是 file:// 页面，
//   若不校验，网页侧只要能把人带到错误页就能借这个通道把主窗口导航到任意站点。
ipcMain.on('mainpage-retry', (event, requested) => {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  const home = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
  let target = home
  // 只接受字符串：渲染进程可以传任意类型（对象/数字/undefined），直接 .trim() 会抛异常
  const want = typeof requested === 'string' ? requested.trim() : ''
  if (want) {
    try {
      const a = new URL(want), b = new URL(home)
      const sameHost = a.hostname.toLowerCase() === b.hostname.toLowerCase() && (a.port || '') === (b.port || '')
      if (/^https?:$/i.test(a.protocol) && sameHost) target = want
    } catch (e) {}
  }
  console.log('[MainPage] 错误页请求重试 →', target)
  // ★ 这里只能碰模块级的 mainLoadTimer / armMainLoadTimeout()。
  //   曾经写成引用 mainLoadTimer，而它当时是 openMainPage() 的局部变量 → 本处理器在
  //   模块顶层，作用域里没有它 → ReferenceError: mainLoadTimer is not defined →
  //   点「重试」直接弹 "A JavaScript error occurred in the main process"，页面毫无反应。
  mainPageWindow.loadURL(target)
  // 重新武装超时兜底：重试也可能再次超时，不能让它变成无边界的等待
  armMainLoadTimeout(target)
  if (!mainPageWindow.isVisible()) mainPageWindow.show()
  mainPageWindow.focus()
})

// ─── Settings window singleton ────────────────────
// tab: 可选，传入则打开后直接跳转到对应面板（general/ringtone/contacts）
function openSettingsWindow(tab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isVisible()) settingsWindow.focus()
    else settingsWindow.show()
    // 已打开时若指定了面板，直接切换
    if (tab) settingsWindow.webContents.send('settings-switch-tab', tab)
    return
  }
  const { screen } = require('electron')
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 560,
    show: true,
    frame: true,
    autoHideMenuBar: true,
    center: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    webPreferences: makeWebPrefs(),
  })
  const loadOpts = tab ? { query: { tab: tab } } : {}
  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings-window.html'), loadOpts)
  settingsWindow.webContents.once('did-finish-load', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('tray-users-update', getTrayUsersData())
    }
  })
  settingsWindow.on('closed', () => { settingsWindow = null })
}

// ─── Diagnostics window (自检：自动 + 手工) ──────
const NC_W = 360, NC_H = 520   // 通知中心窗口尺寸（须与 notificationCenter.js 保持一致）

function openDiagnosticsWindow() {
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    if (diagnosticsWindow.isVisible()) diagnosticsWindow.focus()
    else diagnosticsWindow.show()
    return
  }
  diagnosticsWindow = new BrowserWindow({
    width: 840, height: 680,
    show: true, frame: true, autoHideMenuBar: true,
    center: false, resizable: true, minimizable: true, maximizable: true,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    webPreferences: makeWebPrefs(),
  })
  // 居中到光标当前所在显示器（与通知窗一致，避免多屏下跑到客户没在看的屏）
  const wa = getActiveDisplay().workArea
  diagnosticsWindow.setPosition(
    Math.round(wa.x + Math.max(0, (wa.width - 840) / 2)),
    Math.round(wa.y + Math.max(0, (wa.height - 680) / 2)),
  )
  diagnosticsWindow.loadFile(path.join(__dirname, 'src', 'diagnostics.html'))
  diagnosticsWindow.on('closed', () => { diagnosticsWindow = null })
}


// 推送标题栏状态（连接状态/离线重连），与托盘图标状态同源
function pushTitlebarStatus() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  try {
    const offline = trayIconState === 'gray' || !hasConnectedClients()
    const reconnecting = offline && !!httpServer
    mainPageWindow.webContents.send('titlebar-status', { offline, reconnecting })
  } catch (e) {}
}

// 推送标题栏用户信息（姓名 + 头像 URL；头像失败时 fallback 姓名首字）
function pushTitlebarUser() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  try {
    const first = Array.from(connectedClients.values()).find(u => u && u.userName)
    if (first && first.userName) {
      mainPageWindow.webContents.send('titlebar-user', { name: first.userName, avatar: first.userIcon || '' })
    }
  } catch (e) {}
}

// 推送审批待办数（标题栏角标）——后续可由网页 WS 推送，当前先置 0
function pushTitlebarApproval(count) {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  try { mainPageWindow.webContents.send('titlebar-approval', count || 0) } catch (e) {}
}

// ─── Titlebar IPC ─────────────────────────────
// 向网页推送窗口最大化/全屏状态，供标题栏"最大化/恢复"图标切换
function pushTitlebarState() {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  try {
    const maximized = mainPageWindow.isMaximized() || mainPageWindow.isFullScreen()
    // fullScreen 单独上报：与「最大化」区分开，供网页「退出全屏」按钮精确判定
    // （isMaximized || isFullScreen 合并会把单纯最大化也误判为全屏，导致按钮误显示）
    mainPageWindow.webContents.send('titlebar-state', { maximized, fullScreen: mainPageWindow.isFullScreen() })
  } catch (e) {}
}
ipcMain.on('titlebar:win', (e, action) => {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  if (action === 'minimize') mainPageWindow.minimize()
  else if (action === 'maximize') {
    if (mainPageWindow.isMaximized()) mainPageWindow.unmaximize()
    else mainPageWindow.maximize()
    // 窗口最大化态变更可能由系统动画延迟，下一帧再推送（此时 isMaximized 已是最新值）
    pushTitlebarState()
  }
  else if (action === 'fullscreen') {
    // F11 / 标题栏按钮触发的系统级全屏切换（与 before-input-event 的 F11 同一条链路）
    mainPageWindow.setFullScreen(!mainPageWindow.isFullScreen())
    pushTitlebarState() // 全屏态变化由 enter/leave-full-screen 事件再推一次，这里兜底确保即时
  }
  else if (action === 'exit-fullscreen') {
    // 网页「退出全屏」按钮：仅当处于系统级全屏时退出（不干扰单纯最大化窗口）
    if (mainPageWindow.isFullScreen()) { mainPageWindow.setFullScreen(false); pushTitlebarState() }
  }
  else if (action === 'close') { mainPageWindow.close() } // close 事件已拦截为隐藏到托盘
})

// ─── 手动拖拽兜底（titlebar:drag）──
// 背景：-webkit-app-region:drag 在部分远程页环境（注入样式/页面合成层影响）下可能失效，
//       表现为"标题栏空白处按住拖不动"。原生拖拽生效时，mousedown 会被系统吞掉、根本到不了
//       网页 JS —— 所以该兜底与原生拖拽天然互斥共存：原生失效才有事件漏进来，兜底自动接管。
// 实现：渲染层在标题栏空白区 mousedown → 'begin'；主进程轮询 screen.getCursorScreenPoint
//       以 16ms 步进 setBounds 跟随鼠标；mouseup/窗口失焦 → 'end'。
//       最大化态先还原窗口（水平居中到鼠标下方）再拖，行为对齐系统标题栏"拖拽即还原"。
let _tbDrag = null
ipcMain.on('titlebar:drag', (e, action) => {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) { _tbDrag = null; return }
  const { screen } = require('electron')
  if (action === 'begin') {
    if (_tbDrag) return
    const win = mainPageWindow
    // 最大化/全屏时先还原，让标题栏跟回鼠标下方
    try {
      if (win.isMaximized() || win.isFullScreen()) {
        const nb = win.getNormalBounds()
        win.unmaximize()
        if (win.isFullScreen()) win.setFullScreen(false)
        const cur0 = screen.getCursorScreenPoint()
        win.setBounds({ x: Math.round(cur0.x - nb.width / 2), y: Math.max(0, cur0.y - 20), width: nb.width, height: nb.height })
      }
    } catch (err) {}
    const cur = screen.getCursorScreenPoint()
    const b = win.getBounds()
    _tbDrag = { dx: cur.x - b.x, dy: cur.y - b.y, w: b.width, h: b.height, timer: null, startAt: Date.now() }
    const tick = () => {
      if (!_tbDrag || !mainPageWindow || mainPageWindow.isDestroyed()) { _tbDrag = null; return }
      // 安全上限：渲染层 mouseup 丢失（如拖拽中页面重载）时防无限轮询
      if (Date.now() - _tbDrag.startAt > 15000) {
        if (_tbDrag.timer) { clearTimeout(_tbDrag.timer); _tbDrag.timer = null }
        _tbDrag = null
        return
      }
      try {
        const c = screen.getCursorScreenPoint()
        mainPageWindow.setBounds({ x: c.x - _tbDrag.dx, y: c.y - _tbDrag.dy, width: _tbDrag.w, height: _tbDrag.h })
      } catch (err) {}
      _tbDrag.timer = setTimeout(tick, 16)
    }
    tick()
  } else if (action === 'end') {
    if (_tbDrag && _tbDrag.timer) { clearTimeout(_tbDrag.timer); _tbDrag.timer = null }
    _tbDrag = null
  }
})

// 快捷操作：转发给主页面网页执行（网页侧 desktop-notifier.ts 需 onQuickAction 分发）
ipcMain.on('titlebar:quick-action', (e, action) => {
  if (mainPageWindow && !mainPageWindow.isDestroyed() && action) {
    mainPageWindow.webContents.send('quick-action', String(action))
    console.log('[Titlebar] quick-action →', action)
  }
})

// 头像下拉菜单：设置/下载/诊断/调试/退出登录
ipcMain.on('titlebar:menu', (e, key) => {
  if (key === 'settings') openSettingsWindow('general')
  else if (key === 'ringtone') openSettingsWindow('ringtone')
  else if (key === 'contacts') openSettingsWindow('contacts')
  else if (key === 'downloads') openDownloadsWindow()
  // 通知模式快捷入口：打开设置面板的「通用」页（通知模式四态卡片即位于该页）
  else if (key === 'notify') openSettingsWindow('general')
  else if (key === 'diagnostics') { try { openDiagnosticsWindow() } catch (err) {} }
  else if (key === 'devtools') {
    if (mainPageWindow && !mainPageWindow.isDestroyed()) { mainPageWindow.webContents.openDevTools(); mainPageWindow.show(); mainPageWindow.focus() }
  }
  else if (key === 'logout') {
    if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.webContents.send('quick-action', 'logout')
  }
  else if (key === 'search') {
    if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.webContents.send('quick-action', 'open-search')
  }
})

// ─── Downloads window (下载中心：任务列表 + 打开文件/所在目录) ──────
// will-download 处理：落盘到用户下载目录 + 记录任务 + 广播进度/状态
// 注意 fs/path 已在文件顶部 require（这里可直接使用）
function handleWillDownload(event, item) {
  const downDir = settingsStore.getDownloadDir()
  try { if (!fs.existsSync(downDir)) fs.mkdirSync(downDir, { recursive: true }) } catch (e) {}
  // 同名文件自动加序号 (1)/(2)…，避免覆盖已有文件
  let name = item.getFilename() || 'download'
  const extIdx = name.lastIndexOf('.')
  const base = extIdx > 0 ? name.slice(0, extIdx) : name
  const ext = extIdx > 0 ? name.slice(extIdx) : ''
  let target = path.join(downDir, name), n = 1
  while (fs.existsSync(target)) { target = path.join(downDir, `${base} (${n})${ext}`); n++ }
  item.setSavePath(target)

  const rec = {
    id: 'dl-' + (++downloadSeq),
    filename: path.basename(target),
    savePath: target,
    url: item.getURL() || '',
    state: 'progressing',
    receivedBytes: 0,
    totalBytes: item.getTotalBytes() || 0,
    userId: (currentUser && currentUser.userId) || '',     // 归属用户：下载记录按用户隔离
    userName: (currentUser && currentUser.userName) || '',
    item: item, // 引用保留用于取消（广播前剥离）
  }
  downloads.unshift(rec)
  broadcastDownloads()
  // 下载开始：菜单角标 + 自动弹出下载面板，让用户立即看到进度（可手动关闭，下次下载再次弹出）
  try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setMenu(buildWindowMenu()) } catch (e2) {}
  openDownloadsWindow()
  item.on('updated', (e, state) => {
    if (state === 'progressing') {
      rec.receivedBytes = item.getReceivedBytes()
      rec.totalBytes = item.getTotalBytes()
    }
    broadcastDownloads()
  })
  item.on('done', (e, state) => {
    rec.state = state === 'completed' ? 'completed' : (state === 'cancelled' ? 'cancelled' : 'interrupted')
    rec.receivedBytes = item.getReceivedBytes()
    rec.totalBytes = item.getTotalBytes()
    broadcastDownloads()
    try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setMenu(buildWindowMenu()) } catch (e2) {}
    // 终态（完成/失败/取消）落盘，使下载记录在进程重启后仍然存在
    try { settingsStore.persistDownloadHistory(downloads) } catch (e4) {}
    // 下载完成/失败系统通知（点击通知打开文件）
    try {
      if (Notification.isSupported && Notification.isSupported()) {
        const doneTitle = rec.state === 'completed' ? '✅ 下载完成' : (rec.state === 'interrupted' ? '⚠️ 下载失败' : null)
        if (doneTitle) {
          const n = new Notification({
            title: doneTitle,
            body: rec.filename + (rec.state === 'completed' ? ' 已保存到下载文件夹' : '，请检查网络后重试'),
            silent: false,
          })
          n.on('click', () => {
            if (fs.existsSync(rec.savePath)) shell.openPath(rec.savePath)
            else if (mainPageWindow && !mainPageWindow.isDestroyed()) { mainPageWindow.show(); mainPageWindow.focus() }
          })
          n.show()
        }
      }
    } catch (e3) { /* 通知失败忽略 */ }
  })
  broadcastDownloads()
  try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setMenu(buildWindowMenu()) } catch (e2) {}
}

function openDownloadsWindow() {
  const t0 = Date.now()
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    if (downloadsWindow.isVisible()) downloadsWindow.focus()
    else {
      downloadsWindow.show()
      // 复用已隐藏的窗口：重新推送最新列表与当前用户（避免显示陈旧数据）
      try {
        if (downloadsWindow.webContents && !downloadsWindow.webContents.isDestroyed()) {
          downloadsWindow.webContents.send('downloads-changed', publicDownloads())
          downloadsWindow.webContents.send('downloads-user-changed', {
            userId: (currentUser && currentUser.userId) || '',
            userName: (currentUser && currentUser.userName) || '',
          })
        }
      } catch (e) {}
    }
    return
  }
  const { screen } = require('electron')
  const wa = screen.getPrimaryDisplay().workArea
  downloadsWindow = new BrowserWindow({
    width: 400, height: 480,
    show: true, frame: false, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#F2F5FA', // 与页面渐变底色一致，避免圆角四角露白
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    webPreferences: makeWebPrefs(),
  })
  console.log('[Downloads] 窗口对象创建耗时', Date.now() - t0, 'ms')
  // 锚定到主页面窗口右上角（菜单栏下方），主窗口隐藏时退回主屏右上角
  try {
    if (mainPageWindow && !mainPageWindow.isDestroyed() && mainPageWindow.isVisible()) {
      const b = mainPageWindow.getBounds()
      downloadsWindow.setPosition(Math.round(b.x + b.width - 400 - 8), Math.round(b.y + 34))
    } else {
      downloadsWindow.setPosition(Math.round(wa.x + wa.width - 400 - 8), Math.round(wa.y + 8))
    }
  } catch (e) {}
  downloadsWindow.loadFile(path.join(__dirname, 'src', 'downloads-window.html'))
  // 关闭时不销毁，改为隐藏复用：渲染进程常驻，避免每次重开都经历 ~10s 渲染进程冷启动
  // （主窗口用 splash 把同样的冷启动藏起来了，下载窗口没有，于是裸奔成"白屏 10s"）。
  // 仅在应用退出（isQuitting）时允许真正关闭，以免阻碍进程退出。
  downloadsWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    try { downloadsWindow.hide() } catch (err) {}
  })
  downloadsWindow.on('closed', () => { downloadsWindow = null })
  // 打开即推送一次最新列表
  downloadsWindow.webContents.once('did-finish-load', () => {
    if (downloadsWindow && !downloadsWindow.isDestroyed()) {
      console.log('[Downloads] did-finish-load 距开窗', Date.now() - t0, 'ms')
      downloadsWindow.webContents.send('downloads-changed', publicDownloads())
      downloadsWindow.webContents.send('downloads-user-changed', {
        userId: (currentUser && currentUser.userId) || '',
        userName: (currentUser && currentUser.userName) || '',
      })
    }
  })
}

// ─── 邮箱窗口（固定地址：阿里企业邮箱登录页）──
// 网页端「邮箱」入口 / 托盘「邮箱」都会调用 openEmailWindow：直接打开一个加载
// https://qiye.aliyun.com/alimail/auth/login 的独立窗口，不再内置 SnappyMail / PHP / IMAP。

// 邮箱站点判定：允许在邮箱窗口内导航 / 弹窗的域名。
// 关键：qiye.aliyun.com 会 302 跳转到 mailsso.mxhichina.com（真正输密码的 SSO 页），
// 二者都必须在白名单内，否则 SSO 跳转被拦截、登录态永远进不了邮箱窗口 → 每次都要重登。
function isEmailSite(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const h = u.hostname
    return h === 'qiye.aliyun.com'
      || h.endsWith('.aliyun.com')
      || h === 'mailsso.mxhichina.com'
      || h.endsWith('.mxhichina.com')
  } catch (e) {
    return false
  }
}

// ─── 邮箱会话持久化：登录一次，关窗 / 整程序重启后免登 ───
// Electron 的 persist: 分区虽会落盘，但在被强杀或某些退出路径下会丢；
// 这里在「邮箱窗口隐藏 / 退出 / 定时」时把分区 Cookie 显式导出，启动时再写回，
// 让阿里邮箱 SSO 会话在关窗与重启后都还在，避免每次重新输入密码。
const EMAIL_PARTITION = 'persist:alimail'
function emailSessionFile() {
  return path.join(app.getPath('userData'), 'email', 'alimail-session.json')
}
function emailPartitionSession() {
  return session.fromPartition(EMAIL_PARTITION)
}
// 仅凭已保存会话里是否存在「会话型」Cookie 粗略判断是否已登录：
// 命中则直接打开邮箱主页（服务端凭 Cookie 续登），否则回退到登录入口页。
function hasSavedEmailSession() {
  try {
    if (!fs.existsSync(emailSessionFile())) return false
    let raw = fs.readFileSync(emailSessionFile(), 'utf8')
    if (raw.startsWith('enc:')) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) raw = safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
      else return false
    }
    const cookies = JSON.parse(raw)
    // 只要存在「除长期设备信任 Cookie 之外」的任意阿里邮箱 Cookie，就视为已登录，
    // 直接进邮箱主页；避免写死具体会话 Cookie 名导致误判回退到登录页。
    const NON_SESSION = ['alimail_sso_device_id']
    return Array.isArray(cookies) && cookies.some(c => !NON_SESSION.includes(c.name))
  } catch (e) { return false }
}
async function saveEmailSession() {
  try {
    const cookies = await emailPartitionSession().cookies.get({})
    if (!cookies.length) return
    const keep = cookies.filter(c => {
      const d = (c.domain || '').toLowerCase()
      return d.endsWith('aliyun.com') || d.endsWith('mxhichina.com')
    })
    if (!keep.length) return
    const file = emailSessionFile()
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    let payload = JSON.stringify(keep)
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      try { payload = 'enc:' + safeStorage.encryptString(payload).toString('base64') } catch (e) {}
    }
    fs.writeFileSync(file, payload)
    console.log('[Mail] saved email session cookies:', keep.length)
  } catch (e) { console.error('[Mail] saveEmailSession failed:', e) }
}
async function restoreEmailSession() {
  try {
    const file = emailSessionFile()
    if (!fs.existsSync(file)) return
    let raw = fs.readFileSync(file, 'utf8')
    if (raw.startsWith('enc:')) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) raw = safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
      else return
    }
    const cookies = JSON.parse(raw)
    if (!Array.isArray(cookies) || !cookies.length) return
    const ses = emailPartitionSession()
    for (const c of cookies) {
      const host = (c.domain || '').startsWith('.') ? c.domain.slice(1) : c.domain
      const url = (c.secure ? 'https' : 'http') + '://' + host + (c.path || '/')
      const details = { url, name: c.name, value: c.value, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite }
      if (typeof c.expirationDate === 'number') details.expirationDate = c.expirationDate
      try { await ses.cookies.set(details) } catch (e2) {}
    }
    console.log('[Mail] restored email session cookies:', cookies.length)
  } catch (e) { console.error('[Mail] restoreEmailSession failed:', e) }
}

function openEmailWindow() {
  if (emailWindow && !emailWindow.isDestroyed()) {
    if (emailWindow.isVisible()) emailWindow.focus()
    else emailWindow.show()
    return
  }
  emailWindow = new BrowserWindow({
    width: 1180, height: 780,
    minWidth: 900, minHeight: 600,
    show: true, frame: true, autoHideMenuBar: true,
    backgroundColor: '#F6F8FA',
    title: '邮箱',
    partition: 'persist:alimail',
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 已保存会话则直接进邮箱主页（服务端凭 Cookie 续登，免输密码）；否则走登录入口页
  if (hasSavedEmailSession()) {
    emailWindow.loadURL('https://qiye.aliyun.com/alimail/')
  } else {
    emailWindow.loadURL('https://qiye.aliyun.com/alimail/auth/login')
  }
  // 页面内新开窗口 / 跳转统一交给系统默认浏览器，避免在主窗口内嵌外部站点
  emailWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (isEmailSite(url)) return { action: 'allow' } // SSO 弹窗 / 跳转在应用内完成，登录态才能落进本窗口
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') shell.openExternal(url)
    } catch (e) {}
    return { action: 'deny' }
  })
  emailWindow.webContents.on('will-navigate', (e, url) => {
    if (isEmailSite(url)) return // 允许在阿里邮箱及 SSO 子域（含 mailsso.mxhichina.com）内导航
    e.preventDefault()
    try { shell.openExternal(url) } catch (e2) {}
  })
  // 关闭即隐藏（保留会话与页面），不销毁：登录态在内存里，重开免登；真正退出由 isQuitting 控制
  emailWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      emailWindow.hide()
    }
  })
  // 隐藏（关窗）时把当前 SSO 会话落盘，确保下次/重启后能续登
  emailWindow.on('hide', () => { saveEmailSession() })
  emailWindow.on('closed', () => { emailWindow = null })
}

// 网页侧边栏「邮箱」入口 → 打开固定地址邮箱窗口
ipcMain.on('email:open-window', () => {
  console.log('[Mail] 网页侧边栏请求打开邮箱窗口')
  openEmailWindow()
})


// 当前用户可见的下载记录（未登录 userId 为空时回退为全部，兼容旧行为）
function visibleDownloads() {
  return (!currentUser || !currentUser.userId)
    ? downloads
    : downloads.filter(d => d.userId === currentUser.userId)
}
// 广播下载列表给面板（剥离 item 引用，只发可序列化字段）
function publicDownloads() {
  return visibleDownloads().map(({ item, ...rest }) => rest)
}
function broadcastDownloads() {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    try { downloadsWindow.webContents.send('downloads-changed', publicDownloads()) } catch (e) {}
  }
}
// 标记某下载记录为「不可访问」（文件被移动/删除）：置灰 + 删除线展示，隐藏打开/打开所在目录按钮。
// 既广播给面板即时刷新，也落盘使重启后保持不可访问状态。
function markDownloadInaccessible(id) {
  const d = downloads.find(x => x.id === id)
  if (!d || d.inaccessible) return
  d.inaccessible = true
  broadcastDownloads()
  try { settingsStore.persistDownloadHistory(downloads) } catch (e2) {}
  try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setMenu(buildWindowMenu()) } catch (e3) {}
}
// 向下载中心窗口推送「当前用户」信息（切换账号时刷新归属标识）
function sendDownloadsUser() {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    try {
      downloadsWindow.webContents.send('downloads-user-changed', {
        userId: (currentUser && currentUser.userId) || '',
        userName: (currentUser && currentUser.userName) || '',
      })
    } catch (e) {}
  }
}
function clearDownloads() {
  // 只清除「当前用户」的已完成记录；保留其他用户的记录，以及所有进行中的下载（跨用户进度仍需跟踪）
  downloads = downloads.filter(d => d.state === 'progressing' || (currentUser && d.userId !== currentUser.userId))
  broadcastDownloads()
  try { if (mainPageWindow && !mainPageWindow.isDestroyed()) mainPageWindow.setMenu(buildWindowMenu()) } catch (e) {}
  // 「清空已完成」同时清理持久化历史
  try { settingsStore.persistDownloadHistory(downloads) } catch (e2) {}
}

// ─── Downloads IPC ─────────────────────────────
ipcMain.handle('downloads:list', () => {
  const t = Date.now()
  const r = publicDownloads()
  console.log('[Downloads] downloads:list 构建', Date.now() - t, 'ms，条目', r.length)
  return r
})
ipcMain.handle('downloads:current-user', () => ({
  userId: (currentUser && currentUser.userId) || '',
  userName: (currentUser && currentUser.userName) || '',
}))
ipcMain.handle('downloads:open', (e, id) => {
  const d = downloads.find(x => x.id === id)
  if (!d) return { ok: false, reason: '下载记录不存在' }
  if (!d.savePath || !fs.existsSync(d.savePath)) {
    markDownloadInaccessible(id) // 文件已不可访问：置灰 + 删除线，隐藏打开/打开所在目录
    return { ok: false, reason: '文件已不存在（可能已被移动或删除）', inaccessible: true }
  }
  try {
    // shell.openPath 返回 Promise<string>：空串=成功，非空=错误描述
    return Promise.resolve(shell.openPath(d.savePath))
      .then(err => err ? { ok: false, reason: err } : { ok: true })
      .catch(e2 => ({ ok: false, reason: String((e2 && e2.message) || e2) }))
  } catch (e2) { return { ok: false, reason: String((e2 && e2.message) || e2) } }
})
ipcMain.handle('downloads:open-folder', (e, id) => {
  const d = downloads.find(x => x.id === id)
  if (!d) return { ok: false, reason: '下载记录不存在' }
  if (!d.savePath) return { ok: false, reason: '文件路径缺失' }
  try {
    if (fs.existsSync(d.savePath)) {
      shell.showItemInFolder(d.savePath) // 同步：打开所在目录并选中文件
      return { ok: true }
    }
    // 文件已不存在：标记不可访问，并退而打开所在文件夹（下载目录）便于用户自行查找
    markDownloadInaccessible(id)
    const dir = path.dirname(d.savePath)
    if (fs.existsSync(dir)) { shell.openPath(dir); return { ok: true, note: '文件已不存在，已打开所在文件夹', inaccessible: true } }
    return { ok: false, reason: '文件与所在文件夹均已不存在', inaccessible: true }
  } catch (e2) { return { ok: false, reason: String((e2 && e2.message) || e2) } }
})
ipcMain.handle('downloads:open-in-browser', (e, id) => {
  const d = downloads.find(x => x.id === id)
  if (!d || !d.url) return { ok: false, reason: '原始下载地址缺失' }
  let u
  try { u = new URL(d.url) } catch (e2) { return { ok: false, reason: '原始下载地址无效' } }
  // 仅允许 http/https 协议，避免 file:/data 等被滥用
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '仅支持 http/https 链接' }
  try {
    return Promise.resolve(shell.openExternal(d.url))
      .then(() => ({ ok: true }))
      .catch(e2 => ({ ok: false, reason: String((e2 && e2.message) || e2) }))
  } catch (e2) { return { ok: false, reason: String((e2 && e2.message) || e2) } }
})
ipcMain.handle('downloads:cancel', (e, id) => {
  const d = downloads.find(x => x.id === id)
  if (d && d.item && typeof d.item.cancel === 'function') { try { d.item.cancel() } catch (err) {} }
})
ipcMain.handle('downloads:clear', () => { clearDownloads() })
// 读取当前下载目录（未自定义则回落系统下载文件夹）
ipcMain.handle('downloads:get-dir', () => settingsStore.getDownloadDir())
// 弹出文件夹选择器，让用户更改下载目录（仅影响之后的下载）
// 注意：必须用「无父窗口」写法（与 pick-ringtone 一致）。把 frameless + alwaysOnTop 的
// 下载窗口当作父窗口传进去，在 Windows 上会导致模态对话框创建失败/抛错（表现为“更改位置失败”）。
// 弹窗期间临时关闭 alwaysOnTop，确保对话框浮在下载窗口之上、可见可点。
ipcMain.handle('downloads:pick-dir', async () => {
  try {
    const cur = settingsStore.getDownloadDir()
    let defaultPath = cur
    try { if (cur && fs.existsSync(cur)) defaultPath = cur } catch (e) {}
    let restoreTop = false
    try {
      if (downloadsWindow && !downloadsWindow.isDestroyed() && downloadsWindow.isAlwaysOnTop()) {
        downloadsWindow.setAlwaysOnTop(false)
        restoreTop = true
      }
    } catch (e) {}
    const res = await dialog.showOpenDialog({
      title: '选择下载文件夹',
      defaultPath: defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (restoreTop) { try { downloadsWindow.setAlwaysOnTop(true) } catch (e) {} }
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true }
    const dir = res.filePaths[0]
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch (e2) {}
    settingsStore.setDownloadDir(dir)
    // 切换下载目录后，广播一次让下载中心界面刷新展示
    try { if (downloadsWindow && !downloadsWindow.isDestroyed()) downloadsWindow.webContents.send('downloads-dir-changed', dir) } catch (e3) {}
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
})

//\ ───\ Workbench\ window\ \(个人工作台：四象限\ \+\ 日历\)\ ──────
function openWorkbenchWindow() {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    if (workbenchWindow.isVisible()) workbenchWindow.focus()
    else workbenchWindow.show()
    return
  }
  workbenchWindow = new BrowserWindow({
    width: 1100, height: 760,
    show: true, frame: true, autoHideMenuBar: true,
    center: true, resizable: true, minimizable: true, maximizable: true,
    backgroundColor: '#F6F8FA',
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    webPreferences: makeWebPrefs(),
  })
  workbenchWindow.loadFile(path.join(__dirname, 'src', 'workbench-window.html'))
  workbenchWindow.on('closed', () => { workbenchWindow = null })
}

// 纯环境信息（无副作用）：供诊断窗「多显示器环境」面板使用
function getDiagEnv() {
  const { screen } = require('electron')
  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
  }))
  const primary = screen.getPrimaryDisplay()
  const cursor = screen.getCursorScreenPoint()
  const active = screen.getDisplayNearestPoint(cursor)
  const mainUrl = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
  const permissions = SAFE_PERMISSIONS.map((p) => ({ permission: p, allow: permissionAllowed(mainUrl, p) }))
  return {
    displayCount: displays.length,
    displays,
    primaryId: primary.id,
    cursor,
    activeId: active.id,
    ncRect: getNcRect(NC_W, NC_H),
    mainUrl,
    permissions,
  }
}

// 自动测试：在 getDiagEnv 基础上附带副作用（真实显示通知窗 + 试播铃声），用于验证可见性/可听性
function buildDiagAuto(autoFullscreenOk) {
  const env = getDiagEnv()
  let windowState = null
  let ringtone = null
  if (notificationCenter) {
    notificationCenter.showWindow()                 // 真实显示通知窗，验证可见性
    windowState = notificationCenter.getWindowState()
    ringtone = notificationCenter.previewRingtone('message', null)
    setTimeout(() => { try { notificationCenter.hideWindow() } catch (e) {} }, 2500)  // 自动收起
  }
  return Object.assign({}, env, {
    window: windowState,
    ringtone,
    fullscreenApiOk: !!autoFullscreenOk,
  })
}

ipcMain.on('open-diagnostics', () => openDiagnosticsWindow())
ipcMain.handle('diag:display-info', () => getDiagEnv())
ipcMain.handle('diag:permission-matrix', () => {
  const mainUrl = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
  return SAFE_PERMISSIONS.map((p) => ({ permission: p, allow: permissionAllowed(mainUrl, p) }))
})
ipcMain.handle('diag:run-auto', async (e, arg) => {
  // arg.fullscreenOk 由渲染进程在完成 requestFullscreen 后回填
  return buildDiagAuto(arg && arg.fullscreenOk)
})
ipcMain.on('diag:push-test', () => { if (notificationCenter) notificationCenter.pushTest() })
ipcMain.on('diag:play-ringtone', () => { if (notificationCenter) notificationCenter.previewRingtone('message', null) })
ipcMain.on('diag:close-test', () => { if (notificationCenter) notificationCenter.hideWindow() })

// ── 诊断扩展（P0+P1 补充项，见 .workbuddy/diagnostics-gap.md）──
// P0-1 屏幕共享"源获取"实测：直接调本机 desktopCapturer，验证驱动/显卡/权限能拿到源
// （权限放行 ≠ 共享可用，客户"意外出错"极可能在此层失败）
ipcMain.handle('diag:screencapture', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } })
    return {
      ok: true,
      count: sources.length,
      audioMode: screenShareAudioMode,
      sample: sources.slice(0, 3).map((s) => ({ id: s.id, name: s.name })),
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), audioMode: screenShareAudioMode }
  }
})

// 运行时切换屏幕共享音频模式（mute / loopback / loopbackWithMute），用于排查
// “腾讯 SDK 是否因缺少音频轨道而报未知错误”这一假设；持久化到 settings 下次启动仍生效。
ipcMain.handle('diag:set-screenshare-audio', (e, mode) => {
  if (mode !== 'mute' && mode !== 'loopback' && mode !== 'loopbackWithMute') {
    return { ok: false, error: 'invalid mode: ' + mode }
  }
  screenShareAudioMode = mode
  try { settingsStore.set({ screenShareAudio: mode }); console.log('[ScreenShare] audio mode persisted:', mode) } catch (err) {}
  return { ok: true, mode: screenShareAudioMode }
})

// ── 屏幕共享兼容：为腾讯 TRTC 旧式 getUserMedia({chromeMediaSource:'desktop'}) 提供源 ──
// Electron 无原生源选择框，TRTC SDK 走 legacy getUserMedia 时会因缺少 chromeMediaSourceId 而失败。
// 这里返回主进程枚举到的首选屏幕源（id/name），由 preload 的 shim 注入到约束中。
ipcMain.handle('get-desktop-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } })
    const screen = sources.find((s) => s.id && s.id.indexOf('screen:') === 0) || sources[0]
    return { ok: true, id: screen ? screen.id : null, name: screen ? screen.name : null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// 主页面媒体调用埋点（来自 preload 的 shim）：定位腾讯 SDK 实际走哪条捕获路径
ipcMain.on('page-media-log', (event, msg) => {
  console.log('[MainPage Media]', msg)
})

// P0-2 通知点击聚焦（FOCUS_CONVERSATION / 回退 openExternal）
ipcMain.handle('diag:focus', (e, data) => {
  return notificationCenter ? notificationCenter.diagFocusTest(data || {}) : null
})

// P0-3 网页端离线/被踢常驻通知（sticky 不随 ✕ 收起）
ipcMain.handle('diag:sysalert', () => {
  return notificationCenter ? notificationCenter.diagSysAlertTest() : null
})
// 手工「模拟常驻通知」：推送后保持可见，供用户在通知中心肉眼确认（与自校验版 diag:sysalert 区分）
ipcMain.handle('diag:sysalert-simulate', () => {
  return notificationCenter ? notificationCenter.diagSysAlertSimulate() : null
})
// 清除手工模拟的常驻通知
ipcMain.handle('diag:sysalert-clear', () => {
  return notificationCenter ? notificationCenter.diagSysAlertClear() : null
})

// P1-4 铃声多场景解析（message/call/meeting/联系人专属，silent 不试播）
ipcMain.handle('diag:ringtone-scenes', () => {
  if (!notificationCenter) return null
  const contacts = (settingsStore.loadContacts && settingsStore.loadContacts()) || []
  const cid = contacts.length ? contacts[0].id : null
  return {
    message: notificationCenter.previewRingtone('message', null, true),
    call: notificationCenter.previewRingtone('call', null, true),
    meeting: notificationCenter.previewRingtone('meeting', null, true),
    contact: cid ? notificationCenter.previewRingtone('message', cid, true) : null,
    contactId: cid,
  }
})

// P1-5 来电浮窗弹出（show + 验证 visible，2.5s 自动关闭并静音，避免干扰真实来电状态）
ipcMain.handle('diag:show-call', () => {
  try {
    if (!callWindow || callWindow.isDestroyed()) preCreateCallWindow()
    callWindow.show()
    try { callWindow.webContents.setAudioMuted(true) } catch (e) {}
    const visible = callWindow.isVisible()
    setTimeout(() => { try { closeCallWindow() } catch (e) {} }, 2500)
    return { visible }
  } catch (e) {
    return { visible: false, error: (e && e.message) || String(e) }
  }
})

// P1-5 会议浮窗弹出
ipcMain.handle('diag:show-meeting', () => {
  try {
    if (!meetingWindow || meetingWindow.isDestroyed()) preCreateMeetingWindow()
    meetingWindow.show()
    try { meetingWindow.webContents.setAudioMuted(true) } catch (e) {}
    const visible = meetingWindow.isVisible()
    setTimeout(() => { try { closeMeetingWindow() } catch (e) {} }, 2500)
    return { visible }
  } catch (e) {
    return { visible: false, error: (e && e.message) || String(e) }
  }
})

// P1-6 通知模式联动：切 dnd 验证铃声静音 + 弹窗被抑制，随后恢复原模式
ipcMain.handle('diag:mode-linkage', () => {
  const origMode = settingsStore.getMerged().notifyMode
  settingsStore.set({ notifyMode: 'dnd' })
  if (notificationCenter) {
    notificationCenter.markRead('__diag_mode__')
    notificationCenter.hideWindow()
    notificationCenter.pushMessage({ conversationId: '__diag_mode__', senderId: '__diag_mode__', senderName: '诊断', content: 'x' })
  }
  const win = notificationCenter ? notificationCenter.getWindowState() : null
  const r = notificationCenter ? notificationCenter.previewRingtone('message', null, true) : null
  const dndBlockedPopup = !(win && win.visible)
  const dndMuted = r ? r.muted : false
  if (notificationCenter) { notificationCenter.markRead('__diag_mode__'); notificationCenter.hideWindow() }
  settingsStore.set({ notifyMode: origMode })
  return { origMode, dndBlockedPopup, dndMuted, restored: settingsStore.getMerged().notifyMode === origMode }
})

// 手动激活媒体权限（麦克风/摄像头兜底按钮）：
// 在主页面 origin 内 getUserMedia 并立即关闭，覆盖被缓存的拒绝/不同步状态。
ipcMain.handle('media:activate', async () => {
  return activateMediaInMainPage()
})

// ─── Workbench window IPC ──────────────────────────
ipcMain.handle('workbench-load', () => {
  return { tasks: workbenchStore.list(), tasksPath: workbenchStore.getTasksPath(), mapKey: settingsStore.getMerged().mapKey || '', restMode: settingsStore.getMerged().restMode || 'double' }
})

// 工作台侧栏聚合数据：系统通知(sysAlerts) / 未读消息(unread) / 审批(approvals) / 在线状态
ipcMain.handle('workbench-nc-data', () => {
  if (!notificationCenter) return { unread: [], sysAlerts: [], approvals: [], online: false }
  return {
    unread: notificationCenter.getUnread(),
    sysAlerts: notificationCenter.getSysAlerts(),
    approvals: notificationCenter.getApprovals(),
    online: !!(hasConnectedClients && hasConnectedClients()),
  }
})
ipcMain.handle('workbench-add', (e, task) => workbenchStore.add(task))
ipcMain.handle('workbench-update', (e, id, patch) => workbenchStore.update(id, patch))
ipcMain.handle('workbench-toggle', (e, id) => workbenchStore.toggle(id))
ipcMain.handle('workbench-delete', (e, id) => workbenchStore.remove(id))

// 通讯录（来自网页 SYNC_CONTACTS 缓存，桌面端只读）：附 py/initials 供拼音模糊搜索
ipcMain.handle('workbench-contacts', async () => {
  try {
    const list = workbenchStore.loadContacts() || []
    let pinyin = null
    try { pinyin = require('pinyin-pro') } catch (e) { pinyin = null }
    return list.map((c) => {
      const name = String(c.name || '')
      let py = ''
      let initials = ''
      if (pinyin && name) {
        try {
          const full = pinyin.pinyin(name, { toneType: 'none', type: 'array' })
          py = (Array.isArray(full) ? full.join('') : String(full || '')).toLowerCase()
          const firsts = pinyin.pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' })
          initials = (Array.isArray(firsts) ? firsts.join('') : '').toLowerCase()
        } catch (e) { /* ignore */ }
      }
      return { id: String(c.id || c.imUserId || ''), name, avatar: String(c.avatar || ''), py, initials }
    })
  } catch (e) {
    console.error('[Workbench] contacts failed:', e && e.message)
    return []
  }
})

// 地图 Key（高德地图 Web 服务）：本地保存，不随任务数据上传
ipcMain.handle('workbench-set-mapkey', (e, key) => {
  settingsStore.set({ mapKey: String(key || '').trim() })
  return settingsStore.getMerged().mapKey || ''
})

// 单双休偏好（本地保存，影响日历周末显示）
ipcMain.handle('workbench-set-restmode', (e, mode) => {
  const m = mode === 'single' ? 'single' : 'double'
  settingsStore.set({ restMode: m })
  return m
})

// 日历信息：农历 / 节日 / 法定节假日 / 单双休（由主进程 solarlunar 计算，避免浏览器端脆弱实现）
ipcMain.handle('workbench-calendar-info', (e, year, month, restMode) => {
  try { return workbenchStore.calendarInfo(year, month, restMode || settingsStore.getMerged().restMode || 'double') }
  catch (err) { console.error('[Workbench] calendar-info failed:', err && err.message); return { year, month, restMode: restMode || 'double', days: [] } }
})

// 图片/截图：选择本地文件、剪贴板截图、读取、打开、删除
ipcMain.handle('workbench-pick-images', async () => {
  try {
    const res = await dialog.showOpenDialog({
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    })
    if (res.canceled || !res.filePaths || !res.filePaths.length) return []
    return res.filePaths.map((fp) => {
      const ext = (fp.split('.').pop() || 'png').toLowerCase()
      const buf = fs.readFileSync(fp)
      return workbenchStore.saveImage(buf, ext)
    })
  } catch (e) {
    console.error('[Workbench] pick-images failed:', e && e.message)
    return []
  }
})

ipcMain.handle('workbench-paste-screenshot', () => {
  try {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const png = img.toPNG()
    return workbenchStore.saveImage(png, 'png')
  } catch (e) {
    console.error('[Workbench] paste-screenshot failed:', e && e.message)
    return null
  }
})

// 复制图片到系统剪贴板：渲染进程经 IPC 把图片字节交给主进程，
// 由原生 clipboard.writeImage 写入【系统剪贴板】，从而可被钉钉 / 其他会话 / 其他应用读取。
// （Electron 渲染进程的 navigator.clipboard.write 写图片不可靠，会抛 NotAllowedError）
ipcMain.handle('clipboard:copy-image', (_e, buffer) => {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(buffer))
    if (image.isEmpty()) return { ok: false, error: 'empty image' }
    clipboard.writeImage(image)
    return { ok: true }
  } catch (e) {
    console.error('[Clipboard] copy-image failed:', e && e.message)
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('workbench-read-image', (e, filename) => workbenchStore.readImageDataUrl(filename))
ipcMain.handle('workbench-open-image', (e, filename) => {
  try { shell.openPath(workbenchStore.imageFullPath(filename)) } catch (e) { /* ignore */ }
})
ipcMain.handle('workbench-delete-image', (e, filename) => workbenchStore.deleteImage(filename))

// ─── Workbench 提醒引擎（独立于窗口，后台轮询）──
let reminderTimer = null
function checkReminders() {
  try {
    // 免打扰模式：不弹任何工作台提醒（DND 结束后下次轮询自然补触发，不会丢）
    if (settingsStore.getMerged().notifyMode === 'dnd') return
    const pending = workbenchStore.getPendingReminders(Date.now())
    for (const p of pending) {
      const t = p.task
      let title = '提醒'
      let body = t.title
      if (p.kind === 'overdue') {
        title = '⏰ 待办已延期'
        const endStr = t.schedule && t.schedule.single ? (t.schedule.single.end || '').replace('T', ' ').slice(5) : ''
        body = `${t.title}\n原定 ${endStr || '执行时间'} 未完成`
      } else {
        const rem = t.reminder
        if (p.kind === 'repeat') title = '🔁 周期提醒'
        else title = '⏰ 时间提醒'
        if (rem && rem.mode === '5min') body += '\n（提前5分钟）'
        else if (rem && rem.mode === '30min') body += '\n（提前30分钟）'
        else if (rem && rem.mode === '1day') body += `\n（提前1天 ${rem.dayTime || '09:00'}）`
        else if (rem && rem.mode === 'custom') body += `\n（提前${rem.leadDays || 1}天 ${rem.leadTime || '09:00'}）`
      }
      if (t.note) body += (body.indexOf('\n') >= 0 ? '\n' : '\n') + t.note
      try {
        if (Notification.isSupported && Notification.isSupported()) {
          const n = new Notification({ title, body, silent: false })
          n.show()
        }
      } catch (e) { /* ignore notification errors */ }
      workbenchStore.markReminderFired(t.id, p.kind, p.schedAt)
    }
  } catch (e) {
    console.error('[Workbench] checkReminders failed:', e && e.message)
  }
}
function startReminderEngine() {
  if (reminderTimer) return
  checkReminders() // 启动时先扫一次（处理错过/延期）
  reminderTimer = setInterval(checkReminders, 30 * 1000)
}
function stopReminderEngine() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null }
}

// 真正退出应用（被托盘菜单「退出」与潜在其他入口复用）
function quitApp() {
  isQuitting = true
  stopStaleCleanup()
  stopReminderEngine()
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null }

  // Force-close all WebSocket connections immediately
  if (wsServer) {
    wsServer.clients.forEach(client => client.close())
    wsServer.close()
    wsServer = null
  }
  // Force-close HTTP server immediately
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }

  // Destroy all BrowserWindow instances (hidden windows still hold process)
  if (callWindow && !callWindow.isDestroyed()) { callWindow.destroy(); callWindow = null }
  if (meetingWindow && !meetingWindow.isDestroyed()) { meetingWindow.destroy(); meetingWindow = null }
  if (toastWindow && !toastWindow.isDestroyed()) { toastWindow.destroy(); toastWindow = null }
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.destroy(); settingsWindow = null }
  if (workbenchWindow && !workbenchWindow.isDestroyed()) { workbenchWindow.destroy(); workbenchWindow = null }
  if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) { boardOverlayWindow.destroy(); boardOverlayWindow = null }

  // Destroy tray
  if (tray) { tray.destroy(); tray = null }

  // Hard quit: app.quit() requests exit, process.exit(0) guarantees it
  app.quit()
  process.exit(0)
}

// ─── 画板覆盖窗诊断日志（落盘）──────────────────────────────
// 打包后主进程 console 不可见，导致「画板窗口没出现」这类问题只能靠猜。
// 这里同时追加写 userData/board-overlay.log，测完可直接读文件定位断点。
let _boardLogPath = null
function boardLog(msg) {
  var line = '[' + new Date().toISOString() + '] ' + msg
  try { console.log('[BoardOverlay]', msg) } catch (e) {}
  try {
    if (!_boardLogPath) _boardLogPath = path.join(app.getPath('userData'), 'board-overlay.log')
    fs.appendFileSync(_boardLogPath, line + '\n')
  } catch (e) { /* 落盘失败不影响功能 */ }
}

// ═══════════════════════════════════════════════════════════
// 画板「真·OS 全屏」覆盖窗口（桌面端专属）
//
// 场景：共享者 A 在桌面端共享【整个屏幕】并打开画板时，画板升级为一块
// 透明覆盖窗口，A 可在整个共享屏幕上涂鸦，笔迹经主页面窗口的
// useInteractiveBoard 广播给会议其他人。
//
// 数据流（真相源 = 主页面窗口的 useInteractiveBoard strokes 单例）：
//   覆盖窗口采集笔迹 → 'board-overlay:local-stroke' → 主进程 → 主页面 → addStroke（广播+本地）
//   主页面 strokes 变化 → 'board-overlay:sync' → 主进程 → 覆盖窗口 → 全量重绘
//
// 对齐保证：覆盖窗口精确铺到「被共享的那块屏幕」的 display.bounds，
// 坐标相对该屏 0-1 == 画面内容坐标，笔迹与画面不错位（多显示器亦如此）。
// 共享【窗口】（window）时拿不到窗口精确 bounds，覆盖窗口不打开、
// 降级用窗口级画板（贴合画面内容区，同样不错位）。
// ═══════════════════════════════════════════════════════════
/** 共享源所在显示器的 bounds（共享「整个屏幕」时用） */
function resolveSharedDisplayBounds(src) {
  var wantDisplayId = (src && src.displayId != null) ? src.displayId : null
  var display = null
  if (wantDisplayId != null) {
    try {
      // ⚠ desktopCapturer 的 display_id 是字符串，Electron 的 display.id 是数字，
      //   必须转成同一类型比较，否则永远匹配不上（多显示器会定位到主屏）。
      display = screen.getAllDisplays().find(function (d) {
        return String(d.id) === String(wantDisplayId)
      }) || null
    } catch (e) { display = null }
  }
  if (!display) display = screen.getPrimaryDisplay()
  var b = display.bounds
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

/** 当前鼠标所在显示器全屏（最终兜底：宁可范围略大，也不能让画板整个不存在） */
function resolveCursorDisplayBounds() {
  var display = null
  try { display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) } catch (e) { display = null }
  if (!display) display = screen.getPrimaryDisplay()
  var b = display.bounds
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

/**
 * Windows 下用 Win32 API 查外部应用窗口在屏幕上的矩形（物理像素）。
 * 失败（非 Windows / 窗口不存在 / 被安全策略拦截）返回 null，由调用方降级处理。
 */
function queryWindowRectNative(title) {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32' || !title) return resolve(null)
    // 用 here-string 内嵌 C#，交给 PowerShell 一次性编译调用（execFile 不经过 shell，引号安全）
    var ps = [
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Text;',
      'using System.Runtime.InteropServices;',
      'public class MyLogWinRect {',
      '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);',
      '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);',
      '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
      '  public static string Find(string title) {',
      '    try { SetProcessDPIAware(); } catch (Exception) {}',
      '    IntPtr found = IntPtr.Zero;',
      '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
      '      if (!IsWindowVisible(h)) return true;',
      '      StringBuilder sb = new StringBuilder(1024);',
      '      GetWindowTextW(h, sb, 1024);',
      '      if (sb.ToString() == title) { found = h; return false; }',
      '      return true;',
      '    }, IntPtr.Zero);',
      '    if (found == IntPtr.Zero) return "";',
      '    RECT r;',
      '    int hr = DwmGetWindowAttribute(found, 9, out r, Marshal.SizeOf(typeof(RECT)));',
      '    if (hr != 0 && !GetWindowRect(found, out r)) return "";',
      '    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);',
      '  }',
      '}',
      "'@",
      "  $env:MYLOG_TITLE = '" + String(title).replace(/'/g, "''") + "'",
      '  [MyLogWinRect]::Find($env:MYLOG_TITLE)',
    ].join('\n')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      function (err, stdout) {
        if (err) {
          console.warn('[BoardOverlay] 查询窗口矩形失败:', err.message)
          return resolve(null)
        }
        var out = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        var parts = out.trim().split(',')
        if (parts.length !== 4) return resolve(null)
        var nums = parts.map(Number)
        if (nums.some(function (n) { return !isFinite(n) })) return resolve(null)
        if (nums[2] <= 0 || nums[3] <= 0) return resolve(null)
        resolve({ x: nums[0], y: nums[1], width: nums[2], height: nums[3], physical: true })
      },
    )
  })
}

/** 物理像素 → Electron DIP（BrowserWindow 的 x/y/width/height 使用 DIP 单位） */
function physicalRectToDip(rect) {
  if (!rect || !rect.physical) return rect
  try {
    var d = screen.getDisplayMatching({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    var f = (d && d.scaleFactor) ? d.scaleFactor : 1
    if (!f || f === 1) return rect
    return {
      x: Math.round(rect.x / f),
      y: Math.round(rect.y / f),
      width: Math.round(rect.width / f),
      height: Math.round(rect.height / f),
    }
  } catch (e) {
    return rect
  }
}

/** 共享「某个窗口」→ 解析该窗口在屏幕上的矩形（本应用窗口直接取 bounds；外部窗口走 Win32） */
function resolveSharedWindowBounds(src) {
  var title = (src && src.name) || ''
  if (!title) return Promise.resolve(null)
  // ① 本应用自己的窗口：零成本且精确
  try {
    var own = BrowserWindow.getAllWindows().find(function (w) {
      return !w.isDestroyed() && w.getTitle() === title
    })
    if (own) {
      var ob = own.getBounds()
      if (ob.width > 0 && ob.height > 0) return Promise.resolve(ob)
    }
  } catch (e) { /* 落到 Win32 查询 */ }
  // ② 外部应用窗口
  return queryWindowRectNative(title).then(function (rect) {
    return rect ? physicalRectToDip(rect) : null
  })
}

/** 当前生效的共享源：选源窗口结果优先（最准），其次 shim 记录的实际共享源 */
function currentShareSource() {
  return lastSharedScreen || shimShareSource || null
}

/** 通知网页端「未能精确定位共享范围，已降级」——用于给出可见提示 */
function notifyBoardUnsupported(reason) {
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    try { mainPageWindow.webContents.send('board-overlay:unsupported', reason) } catch (e) {}
  }
}

/**
 * 通知网页端「本机是否正在共享屏幕」。
 * 用途：网页端 enterBoard() 据此分流（需求2）—— 共享中开「屏幕画板」（OS 覆盖窗），
 * 否则开网页画板。网页端**不能**用 hasScreenStream 自判：TUIRoomEngine 把屏幕共享
 * 当作独立参会人，共享者本人条目的 hasScreenStream 不必然为 true，只有桌面端知道真相。
 */
function notifySelfScreenShare(active) {
  screenShareActive = !!active
  boardLog('notifySelfScreenShare | active=' + !!active)
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    try { mainPageWindow.webContents.send('board-overlay:self-screen-share', !!active) } catch (e) {}
  }
}

/**
 * 诊断取样：把会议页的「可见性 + <video> 帧数」写进 board-overlay.log。
 * 用途：定位「开画笔后视频画面消失」究竟是哪一层停了 ——
 *   vis=hidden            → 页面被判为不可见（visibility 层）
 *   frames 不再增长       → 视频解码/渲染确实停了（媒体层）
 *   frames 持续增长       → 画面数据还在，问题在合成/呈现层（GPU overlay 之类）
 * 只在模式切换时取样（进入/退出绘制模式各两次），不影响性能。
 */
function sampleMainPageVideo(tag) {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  var code = '(function(){try{' +
    'var vs=Array.prototype.slice.call(document.querySelectorAll("video"));' +
    'var frames=0,playing=0;' +
    'vs.forEach(function(v){try{var q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():null;' +
    'frames+=(q&&q.totalVideoFrames)||0;if(!v.paused)playing++;}catch(e){}});' +
    'return {vis:document.visibilityState,hidden:document.hidden,videos:vs.length,playing:playing,frames:frames};' +
    '}catch(e){return {err:String(e&&e.message)}}})()'
  mainPageWindow.webContents.executeJavaScript(code, true).then(function (r) {
    boardLog('videoSample[' + tag + '] ' + JSON.stringify(r))
  }).catch(function (e) {
    boardLog('videoSample[' + tag + '] failed: ' + (e && e.message))
  })
}

/**
 * 覆盖窗口应铺满的屏幕矩形。
 * ⚠ 绝不返回 null：「拿不到 bounds 就拒绝打开」的代价是功能彻底不存在
 *   （原实现即如此 —— 这就是「共享屏幕测多少次都没有系统级画板」的直接原因）。
 *   共享「整个屏幕」→ 该显示器 bounds
 *   共享「某个窗口」→ 该窗口矩形；拿不到 → 退到当前显示器全屏
 *   尚无共享信息 → 当前显示器全屏（记日志）
 */
function resolveBoardOverlayBounds() {
  var src = currentShareSource()
  boardLog('resolve bounds | source=' + (src ? JSON.stringify(src) : 'null'))
  if (src && src.type === 'screen') return Promise.resolve(resolveSharedDisplayBounds(src))
  if (src && src.type === 'window') {
    return resolveSharedWindowBounds(src).then(function (rect) {
      if (rect) return rect
      boardLog('window rect unavailable → fallback to cursor display')
      notifyBoardUnsupported('未能取到共享窗口的精确范围，屏幕画板已放到当前显示器（笔迹可能略有偏移）')
      return resolveCursorDisplayBounds()
    })
  }
  boardLog('no share source recorded yet → fallback to cursor display')
  return Promise.resolve(resolveCursorDisplayBounds())
}

/**
 * 给覆盖窗补上 WS_EX_TOOLWINDOW 扩展样式 —— 这是「一开画笔，屏幕上其它应用的视频就卡住」的正解。
 *
 * 为什么必须：Chromium 的窗口遮挡判定（`ui/gfx/win/hwnd_util.cc` 的 `IsWindowVisibleAndFullyOpaque`）
 * 决定「谁有资格当遮挡者」，其中两条豁免恰好对应我们的两种模式：
 *     if (ex_styles & WS_EX_TRANSPARENT) return false;   // 鼠标模式：整窗穿透 → 不算遮挡 ← 所以那时一切正常
 *     if (ex_styles & WS_EX_TOOLWINDOW)  return false;   // ← 绘制模式要的就是这一条
 * 拿不到这条豁免时，浏览器（Chrome/Edge 等**任何** Chromium 应用）会判定自己的窗口「被完全盖住」，
 * 于是停掉页面渲染与视频解码 —— 典型症状：视频区域发虚/模糊、进度条不走、音频却照常，切回鼠标模式即恢复。
 * 注意：Electron 的 `transparent:true` 是逐像素 alpha，Chromium 认不出来；`skipTaskbar` 走的是
 * ITaskbarList.DeleteTab，也不带这个样式 —— 所以只能显式设置。
 * 副作用：不出现在任务栏与 Alt-Tab（本来也不该出现）；窗口仍可正常接收鼠标/键盘。
 */
function forceToolWindowStyle(win) {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32' || !win || win.isDestroyed()) return resolve(false)
    var hwnd = null
    try {
      var buf = win.getNativeWindowHandle()
      hwnd = buf.length >= 8 ? buf.readBigInt64LE(0).toString() : String(buf.readUInt32LE(0))
    } catch (e) { hwnd = null }
    if (!hwnd) {
      boardLog('toolwindow style skipped | cannot read hwnd')
      return resolve(false)
    }
    // 与 queryWindowRectNative 同一套路：here-string 内嵌 C#，execFile 不经过 shell，引号安全
    var ps = [
      "Add-Type -TypeDefinition @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class MyLogToolWin {',
      '  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);',
      '  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);',
      '  public static string Mark(IntPtr h) {',
      '    int GWL_EXSTYLE = -20; long WS_EX_TOOLWINDOW = 0x80;',
      '    long before = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();',
      '    SetWindowLongPtr(h, GWL_EXSTYLE, (IntPtr)(before | WS_EX_TOOLWINDOW));',
      '    long after = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();',
      '    return "0x" + before.ToString("X") + ",0x" + after.ToString("X");',
      '  }',
      '}',
      "'@",
      '  [MyLogToolWin]::Mark([IntPtr]' + hwnd + ')',
    ].join('\n')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      function (err, stdout) {
        if (err) {
          boardLog('toolwindow style FAILED | ' + err.message)
          return resolve(false)
        }
        var out = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        var parts = out.split(',')
        var after = parts.length === 2 ? parseInt(parts[1].replace('0x', ''), 16) : NaN
        var ok = isFinite(after) && (after & 0x80) !== 0
        boardLog('toolwindow style ' + (ok ? 'OK' : 'UNVERIFIED') + ' | ex-style=' + out)
        resolve(ok)
      },
    )
  })
}

async function openBoardOverlay() {
  boardLog('openBoardOverlay called | exists=' + !!(boardOverlayWindow && !boardOverlayWindow.isDestroyed()))
  if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) {
    boardOverlayWindow.show()
    boardOverlayWindow.focus()
    boardLog('overlay already exists → show + focus')
    return
  }
  var bounds = await resolveBoardOverlayBounds()
  // 理论不可达（resolveBoardOverlayBounds 已保证兜底），保底再拦一次：
  // 画板宁可范围略大，也绝不能「打开了却什么都不出现」。
  if (!bounds) bounds = resolveCursorDisplayBounds()
  boardLog('creating overlay window | bounds=' + JSON.stringify(bounds))
  var win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: makeWebPrefs(),
  })
  boardOverlayWindow = win
  win.setMenu(null)
  // 置顶到屏幕级（'screen-saver' 层级，确保盖在绝大多数窗口之上）
  win.setAlwaysOnTop(true, 'screen-saver')
  // ★ 关键：补 WS_EX_TOOLWINDOW —— 否则 Chromium 系应用（浏览器、IDE，以及我们自己的会议窗口）
  //   会把「被这扇全屏置顶透明窗盖住」判定为遮挡，进而停掉渲染（视频卡住/发虚、进度不走）。
  //   不 await，避免阻塞开窗；结果与前后样式值写进 board-overlay.log 便于验证。
  forceToolWindowStyle(win).catch(function () {})

  // ⚠ 关键：transparent:true 的窗口在 Windows 上 `ready-to-show` 经常不触发 →
  //   窗口已创建却永远不 show，表现就是「点了共享屏幕，画板窗口没出现」。
  //   因此以 did-finish-load 为主、并加一个定时兜底，确保一定会显示。
  var shown = false
  function showOverlayOnce(reason) {
    if (shown) return
    if (!win || win.isDestroyed()) return
    shown = true
    win.show()
    win.setAlwaysOnTop(true, 'screen-saver')
    boardLog('overlay window shown | via=' + reason + ' | visible=' + win.isVisible() + ' | bounds=' + JSON.stringify(win.getBounds()))
    // 通知网页端：OS 覆盖窗已实际打开 → 网页端据此把本端表面切到「屏幕画板」（互斥关网页画板）
    if (mainPageWindow && !mainPageWindow.isDestroyed()) {
      try { mainPageWindow.webContents.send('board-overlay:screen-opened') } catch (e) {}
    }
  }
  win.webContents.once('did-finish-load', function () { showOverlayOnce('did-finish-load') })
  win.once('ready-to-show', function () { showOverlayOnce('ready-to-show') })
  setTimeout(function () { showOverlayOnce('timeout-1500ms') }, 1500)
  win.webContents.on('did-fail-load', function (e, code, desc) {
    boardLog('overlay did-fail-load | code=' + code + ' | desc=' + desc)
  })

  win.loadFile(path.join(__dirname, 'src', 'board-overlay.html'))
  win.on('closed', () => {
    boardLog('overlay window closed')
    if (boardOverlayWindow === win) boardOverlayWindow = null
    if (mainPageWindow && !mainPageWindow.isDestroyed()) {
      mainPageWindow.webContents.send('board-overlay:closed')
    }
  })
}

function closeBoardOverlay() {
  boardLog('closeBoardOverlay called | exists=' + !!(boardOverlayWindow && !boardOverlayWindow.isDestroyed()))
  if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) {
    boardOverlayWindow.destroy()
  }
  boardOverlayWindow = null
}

function toggleBoardOverlay() {
  if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) closeBoardOverlay()
  else return openBoardOverlay()
}

// ── IPC：覆盖窗口 ↔ 主页面窗口 ──
// openBoardOverlay 是异步的（共享「窗口」时要先查该窗口矩形），统一吞掉异常避免未处理的 Promise
function safeOpenBoardOverlay() {
  Promise.resolve(openBoardOverlay()).catch(function (e) {
    console.warn('[BoardOverlay] open failed:', e && e.message)
  })
}
ipcMain.on('board-overlay:toggle', () => {
  boardLog('IPC board-overlay:toggle')
  if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) closeBoardOverlay()
  else safeOpenBoardOverlay()
})
ipcMain.on('board-overlay:open', () => {
  boardLog('IPC board-overlay:open')
  safeOpenBoardOverlay()
})
ipcMain.on('board-overlay:close', () => closeBoardOverlay())

// 网页点「画板」时调用：由主进程决定要不要在屏幕上开覆盖窗。
// 只在确实记录了共享源时才开 —— 纯白板场景（没共享）不该在桌面上弹覆盖层。
ipcMain.on('board-overlay:open-if-sharing', () => {
  var src = currentShareSource()
  boardLog('IPC board-overlay:open-if-sharing | source=' + (src ? JSON.stringify(src) : 'null'))
  if (!src) return
  safeOpenBoardOverlay()
})

// shim 的真实信号：SDK 调用了 chrome.desktopCapture.chooseDesktopMedia（用户确实点了共享）。
// 这是桌面端唯一可靠的「共享已开始」时机 —— 共享走 shim 路径、不经 getDisplayMedia，
// 所以 setDisplayMediaRequestHandler 里的自动开窗永远不会被触发。
ipcMain.on('board-overlay:share-started', (e, sourceId) => {
  boardLog('IPC board-overlay:share-started | sourceId=' + (sourceId || '(none)'))
  // 仅记录共享源（用于用户后续主动开屏板时精确定位），【不自动】开覆盖窗（需求4）。
  if (!sourceId) return
  // 需求2：本机开始共享屏幕 → 立即通知网页端「本机正在共享」，供 enterBoard 分流到屏幕画板。
  // 不能依赖网页 hasScreenStream（屏幕共享在 TUIRoomEngine 是独立参会人，本人 hasScreenStream 不必然为 true）。
  // 注：本路径（shim）在本项目里实测从未被 SDK 触发，保留作兼容；真正生效的是
  //     setDisplayMediaRequestHandler 里授予共享源时的 notifySelfScreenShare(true)。
  notifySelfScreenShare(true)
  desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } })
    .then(function (list) {
      var hit = (list || []).filter(function (s) { return s.id === sourceId })[0]
      if (hit) {
        lastSharedScreen = {
          type: (hit.id.indexOf('screen:') === 0) ? 'screen' : 'window',
          displayId: (hit.display_id != null) ? hit.display_id : null,
          name: hit.name || '',
        }
        boardLog('share-started resolved | id=' + hit.id + ' | display_id=' + hit.display_id)
      }
    })
    .catch(function (err) {
      boardLog('share-started resolve failed: ' + (err && err.message))
    })
})
ipcMain.on('board-overlay:local-stroke', (e, stroke) => {
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    mainPageWindow.webContents.send('board-overlay:remote-stroke', stroke)
  }
})
ipcMain.on('board-overlay:sync', (e, state) => {
  if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) {
    boardOverlayWindow.webContents.send('board-overlay:state', state)
  }
})
ipcMain.on('board-overlay:undo', () => {
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    mainPageWindow.webContents.send('board-overlay:undo')
  }
})

// 屏幕共享已结束（shim 观测到 getDisplayMedia 返回的轨道 ended / stop）→ 清除「本机共享中」标记。
// 没有这条信号时，标记会滞留为 true，导致「已停止共享后点画板」误开屏幕画板。
ipcMain.on('board-overlay:share-stopped', () => {
  boardLog('IPC board-overlay:share-stopped')
  notifySelfScreenShare(false)
})

// 网页端主动查询本机是否在共享（应对「推送早于监听注册」或页面刚加载完就已在共享的情况）
ipcMain.handle('board-overlay:is-sharing', () => !!screenShareActive)

// 覆盖窗「上传图片 / 截图作底图」→ 转交网页端 addImage 并广播（与网页画板功能一致）
ipcMain.on('board-overlay:local-image', (e, img) => {
  if (!img || !img.src) return
  boardLog('IPC board-overlay:local-image | ratio=' + img.ratio)
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    mainPageWindow.webContents.send('board-overlay:remote-image', img)
  }
})

// 覆盖窗「截图当前屏幕作底图」：
// 先临时隐藏覆盖窗再抓屏，否则会把已经画上去的笔迹一起烤进底图。
ipcMain.handle('board-overlay:capture-screen', async () => {
  var hidden = false
  try {
    if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) {
      boardOverlayWindow.hide()
      hidden = true
      await new Promise(function (r) { setTimeout(r, 200) })
    }
    var list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
    if (!list || !list.length) return null
    // 覆盖窗所在显示器对应的源优先（多显示器时别截错屏）
    var hit = null
    try {
      var ob = boardOverlayWindow && !boardOverlayWindow.isDestroyed() ? boardOverlayWindow.getBounds() : null
      if (ob) {
        hit = list.find(function (s) {
          var d = screen.getAllDisplays().find(function (x) { return String(x.id) === String(s.display_id) })
          if (!d) return false
          return Math.abs(d.bounds.x - ob.x) < 8 && Math.abs(d.bounds.y - ob.y) < 8
        }) || null
      }
    } catch (e2) { hit = null }
    if (!hit) hit = list[0]
    var size = hit.thumbnail.getSize()
    boardLog('capture-screen | sources=' + list.length + ' | hit=' + hit.name + ' | size=' + size.width + 'x' + size.height)
    return { src: hit.thumbnail.toDataURL(), ratio: size.width / (size.height || 1) }
  } catch (err) {
    boardLog('capture-screen failed: ' + (err && err.message))
    return null
  } finally {
    if (hidden && boardOverlayWindow && !boardOverlayWindow.isDestroyed()) boardOverlayWindow.show()
  }
})

// 覆盖窗「清空」按钮 → 转发给网页端执行 clearAll 并广播（工具栏功能与网页一致）
ipcMain.on('board-overlay:clear', () => {
  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    mainPageWindow.webContents.send('board-overlay:clear')
  }
})

// 覆盖窗「鼠标模式」点击穿透：让整个透明窗口忽略鼠标（桌面可操作），
// 仅工具栏悬停区域由网页端切回可点（见 board-overlay.html 的 hover 逻辑）。
// 上一次「整窗忽略鼠标」的状态。pointer 模式下网页端 mousemove 会高频调用本通道，
// 只在状态真正切换时才写日志/取样，避免刷日志。
let lastIgnoreMouseState = null
ipcMain.on('board-overlay:set-ignore-mouse', (e, ignore, forward) => {
  var next = !!ignore
  try {
    if (boardOverlayWindow && !boardOverlayWindow.isDestroyed()) {
      boardOverlayWindow.setIgnoreMouseEvents(next, { forward: !!forward })
    }
  } catch (err) {
    boardLog('set-ignore-mouse failed: ' + (err && err.message))
  }
  if (next !== lastIgnoreMouseState) {
    lastIgnoreMouseState = next
    boardLog('mouse mode → ' + (next ? 'pointer(整窗穿透桌面)' : 'draw(覆盖窗接收鼠标)'))
    // 进入绘制模式时覆盖窗才构成「完整遮挡」，此处最可能触发视频停渲染 → 前后取样对比
    sampleMainPageVideo(next ? 'back-to-pointer' : 'enter-draw')
    if (!next) {
      setTimeout(function () { sampleMainPageVideo('enter-draw+2.5s') }, 2500)
    }
  }
})