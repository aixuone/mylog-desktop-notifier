// main.js - Electron main process: tray + WS server + HTTP server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage, dialog, session, desktopCapturer, globalShortcut } = require('electron')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const http = require('http')
const https = require('https')
const fs = require('fs')
const net = require('net')
const zlib = require('zlib')

// ─── Feature modules (M1+) ──────────────────────
const settingsStore = require('./lib/settingsStore')
const { createRingtoneResolver } = require('./lib/ringtoneResolver')
const { createNotificationCenter } = require('./lib/notificationCenter')

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
    tray?.setToolTip(`我的日志-通知助手 | ${reason}`)
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
      // Alternate: default (color) ↔ transparent (blink effect)
      tray.setImage(trayIcon(iconCache.default))
      blinkInterval = setInterval(() => {
        blinkPhase = !blinkPhase
        tray.setImage(trayIcon(blinkPhase ? iconCache.transparent : iconCache.default))
      }, 500)
      break

    default:
      console.warn('[Tray] Unknown state:', state)
      tray.setImage(trayIcon(iconCache.default))
  }

  if (prevState !== state) {
    console.log('[Tray] Icon state:', prevState, '→', state)
  }
}

/** 来电/会议提醒结束后，显式清除响铃瞬态并恢复真实图标状态 */
function endRingingState() {
  isRinging = false
  setTrayState(deriveTrayState())
}

/** Derive the correct icon state based on current conditions */
function deriveTrayState() {
  // Priority: ringing > unread > default/gray
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
var SAFE_PERMISSIONS = ['media', 'display-capture', 'fullscreen', 'clipboard-read', 'clipboard-write', 'pointerLock', 'notifications']
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
    const screen = sources.find((s) => s.id && s.id.indexOf('screen:') === 0) || sources[0]
    sourceId = screen ? screen.id : ''
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
    }).catch(function (err) {
      console.error('[ScreenShare] getSources failed:', err && err.message)
      callback({})
    })
  })

  session.defaultSession.setPermissionRequestHandler(function (webContents, permission, cb) {
    var url = webContents.getURL()
    // 仅对可信来源放行一组安全的 Web API（媒体/采集/全屏/剪贴板/指针锁定/通知）；
    // 原实现只放行 media/display-capture，导致主页面窗口内 requestFullscreen()、
    // 剪贴板、指针锁定、通知等被拒（表现为"点击无响应/报错"）。
    var allow = permissionAllowed(url, permission)
    // 诊断日志：便于远程定位"被拒的权限"（如屏幕共享仍报错的客户机）
    console.log('[Permission]', allow ? 'allow' : 'deny', permission, 'url:', url)
    cb(allow)
  })
}

// Shared BrowserWindow options for center-popup notification windows
function makePopupWindowOpts(w, h) {
  return {
    width: w,
    height: h,
    show: false,
    frame: false,
    ...(supportsAcrylic()
      ? { backgroundMaterial: 'acrylic' }
      : { backgroundColor: '#FFFFFF', transparent: false }),
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    hasShadow: false,
    webPreferences: makeWebPrefs(),
  }
}

// ─── Active display (光标当前所在显示器) ──
function getActiveDisplay() {
  const { screen } = require('electron')
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

// ─── Notification center window rect (bottom-right of active display) ──
function getNcRect(w, h) {
  const wa = getActiveDisplay().workArea
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

// 置前主页面窗口，并可选地跳转到指定 url（SPA 路由跳转，不刷新页面）
function focusMainWindow(url) {
  if (!mainPageWindow || mainPageWindow.isDestroyed()) return
  if (mainPageWindow.isMinimized()) mainPageWindow.restore()
  mainPageWindow.show()
  mainPageWindow.focus()
  // 如果有 url，用 executeJavaScript 在页面内触发 SPA 路由跳转
  // 网页端可能未处理 FOCUS_CONVERSATION 消息，直接用 history.pushState + popstate 最可靠
  if (url) {
    try {
      mainPageWindow.webContents.executeJavaScript(
        "(function(u){" +
        "  try {" +
        "    if (window.location.pathname + window.location.search === u.split('//')[1].split('/').slice(1).join('/')) return;" +
        "    window.history.pushState({}, '', u);" +
        "    window.dispatchEvent(new PopStateEvent('popstate'));" +
        "  } catch(e) { window.location.href = u; }" +
        "})(" + JSON.stringify(url) + ")"
      )
    } catch (e) { console.warn('[FocusMain] executeJavaScript failed:', e && e.message) }
  }
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

  // Update tooltip
  const onlineCount = Array.from(connectedClients.values()).filter(u => u.connected).length
  if (onlineCount > 0) {
    const names = Array.from(connectedClients.values())
      .filter(u => u.connected)
      .map(u => u.userName || u.userId)
      .join(', ')
    tray?.setToolTip(`我的日志-通知助手 | ${onlineCount} 人在线${unreadCount > 0 ? ` | ${unreadCount} 条未读` : ''}`)
  } else {
    tray?.setToolTip('我的日志-通知助手 | 未连接')
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
function updateTrayMenu() {
  if (!tray) return

  const menuItems = []

  // ── Header（第一行标题 + 版本号） ──
  menuItems.push({ label: `我的日志（v${version}）`, enabled: false })
  menuItems.push({ type: 'separator' })

  // ── Connected users（显示头像 + 在线状态标识） ──
  // 仅在线用户项带图标（头像），其余菜单项（设置/版本等）不显示图标，符合统一风格。
  const connectedUsers = Array.from(connectedClients.values()).filter(u => u.connected)
  if (connectedUsers.length > 0) {
    menuItems.push({ label: `在线用户 (${connectedUsers.length})`, enabled: false })
    connectedUsers.forEach((u) => {
      const displayName = u.userName || u.userId || '未知用户'
      const item = {
        label: `${displayName} 🟢`,
        enabled: false,
      }
      // 头像：优先 userId 缓存（抗重连抖动），其次连接项 localIconPath，再次主用户 legacy 路径
      const iconPath = (u.userId && userIconCache.get(u.userId)) || u.localIconPath ||
        (u.userId === currentUser.userId ? localUserIconPath : '')
      const ic = loadMenuIcon(iconPath)
      if (ic) item.icon = ic
      menuItems.push(item)
    })
    menuItems.push({ type: 'separator' })
  } else if (currentUser.userName) {
    const item = { label: `${currentUser.userName} ⚪（离线）`, enabled: false }
    const ic = loadMenuIcon(localUserIconPath)
    if (ic) item.icon = ic
    menuItems.push(item)
    menuItems.push({ type: 'separator' })
  }

  // ── Actions ──
  menuItems.push({ label: '设置', click: () => openSettingsWindow() })
  // 调试窗口：打开主页面窗口的 Chrome DevTools，查看 TRTC SDK 内部日志（或用 Ctrl+Shift+I）
  menuItems.push({ label: '调试窗口', click: () => {
    if (mainPageWindow && !mainPageWindow.isDestroyed()) {
      mainPageWindow.webContents.openDevTools()
      mainPageWindow.show()
      mainPageWindow.focus()
    }
  }})
  menuItems.push({
    label: '开机自启',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => {
      app.setLoginItemSettings({ openAtLogin: item.checked })
      settingsStore.set({ autoStart: item.checked })
      updateTrayMenu()
    },
  })
  menuItems.push({ type: 'separator' })

  // ── Exit（左侧单色关机图标，与「开机自启」对勾左列对齐） ──
  menuItems.push({ type: 'separator' })
  const exitItem = { label: '退出', click: () => { isQuitting = true; quitApp() } }
  const si = getShutdownIcon()
  if (si) exitItem.icon = si
  menuItems.push(exitItem)

  const contextMenu = Menu.buildFromTemplate(menuItems)
  tray.setContextMenu(contextMenu)

  // 实时同步在线用户列表给设置面板「通用」页（与托盘菜单展示完全一致）
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('tray-users-update', getTrayUsersData())
  }

  // Tooltip：显示在线数量
  const onlineCount = connectedUsers.length
  if (onlineCount > 0) {
    tray.setToolTip(`我的日志-通知助手 | ${onlineCount} 个用户在线`)
  } else {
    tray.setToolTip(currentUser.userName ? `${currentUser.userName} - 我的日志通知助手` : '我的日志-通知助手')
  }
}

function setUserInfo(userData, wsClient) {
  const userId = userData.userId || ''
  const userName = userData.userName || ''
  const userIcon = userData.userIcon || ''
  const browserType = userData.browserType || ''
  const now = Date.now()

  // Legacy single-user reference update (use most recently registered)
  currentUser = { userId, userName, userIcon, browserType }
  console.log('[User] Updated:', userName, browserType)

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
// ─── macOS: hide from Dock (pure tray app) ────────────────
if (process.platform === 'darwin') {
  app.dock && app.dock.hide()
}

app.whenReady().then(() => {
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
      onUnreadChange: updateUnreadCount,
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
  // Tray-only app: closing all windows should NOT quit
  // Quit only happens via tray menu "退出"
})

app.on('before-quit', () => {
  isQuitting = true
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
})

// ─── System tray ──────────────────────────────────────────
let mainPageWindow = null
let mainPagePendingShow = false   // 首屏加载完成前不显示窗口（避免白屏/假死）
const MAIN_PAGE_DEFAULT = 'https://data.tygps.com/mylog-pc/'

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

// 托盘点击 → 打开主页面网页（默认 1300x700，地址可在设置「关于」中修改）
function openMainPage() {
  let url = (settingsStore.get() && settingsStore.get().mainPageUrl) || MAIN_PAGE_DEFAULT
  // 兜底：必须是 http/https，否则回退默认地址（避免 loadURL 加载非法内容）
  if (!/^https?:\/\//i.test(url || '')) url = MAIN_PAGE_DEFAULT

  if (mainPageWindow && !mainPageWindow.isDestroyed()) {
    // 点击切换语义：最小化则恢复；可见且聚焦则隐藏（类 IM）；其余置顶显示
    if (mainPageWindow.isMinimized()) { mainPageWindow.restore(); mainPageWindow.focus(); return }
    if (mainPageWindow.isVisible() && mainPageWindow.isFocused()) { mainPageWindow.hide(); return }
    mainPageWindow.show(); mainPageWindow.focus()
    return
  }

  const b = loadMainPageBounds()
  mainPageWindow = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1300, height: 700, center: true }),
    minWidth: 800,
    minHeight: 480,
    show: false,            // 首屏加载完成后再显示，避免白屏/假死
    frame: true,
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico')),
    webPreferences: makeWebPrefs(),
  })

  // 关闭即隐藏到托盘（继续当前页面），而非销毁；真正退出由全局 isQuitting 控制
  mainPageWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainPagePendingShow = false; mainPageWindow.hide() }
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

  // ─── Ctrl+Shift+I 打开 DevTools ───
  // 让用户能直接在主页面窗口里打开 Chrome DevTools，查看 TRTC SDK 的真实调用日志。
  // 窗口关闭时注销快捷键；重新打开时重新注册。
  try {
    globalShortcut.register('CommandOrControl+Shift+I', function () {
      if (mainPageWindow && !mainPageWindow.isDestroyed()) {
        mainPageWindow.webContents.toggleDevTools()
      }
    })
  } catch (e) {
    console.warn('[DevTools] 快捷键注册失败:', e && e.message)
  }

  mainPageWindow.on('closed', () => {
    mainPageWindow = null
    try { globalShortcut.unregister('CommandOrControl+Shift+I') } catch (e) {}
  })

  // 主页面 shim 注入时机：优先 dom-ready（比 did-finish-load 更早，在 SDK 脚本执行前包裹），
  // did-finish-load 作为备用（全页重载时 JS 上下文重建，__SCREEN_SHARE_SHIM_INSTALLED__ 重置，
  // 需重新注入；shim 内部有防重包裹守卫）。
  // SPA 内部路由切换不会触发这两个事件，shim 持久化于同一 JS 上下文。
  mainPageWindow.webContents.on('dom-ready', () => injectScreenShareShim(mainPageWindow))
  mainPageWindow.webContents.on('did-finish-load', () => injectScreenShareShim(mainPageWindow))

  // 加载状态：任务栏不确定进度；首屏完成才显示；失败进入本地兜底错误页
  mainPageWindow.webContents.on('did-start-loading', () => {
    mainPageWindow.setProgressBar(-1, { mode: 'indeterminate' })
  })
  mainPageWindow.webContents.on('did-stop-loading', () => {
    mainPageWindow.setProgressBar(-1)
    if (mainPagePendingShow) { mainPagePendingShow = false; mainPageWindow.show(); mainPageWindow.focus() }
  })
  mainPageWindow.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
    console.warn('[MainPage] load failed:', errorCode, errorDescription, validatedURL)
    mainPageWindow.setProgressBar(-1)
    const errPage = 'file://' + path.join(__dirname, 'src', 'mainpage-error.html') + '?url=' + encodeURIComponent(validatedURL || url)
    if (mainPageWindow.getURL() !== errPage) mainPageWindow.loadURL(errPage)
    if (mainPagePendingShow) { mainPagePendingShow = false; mainPageWindow.show() }
  })

  // 记忆窗口尺寸/位置
  mainPageWindow.on('resize', saveMainPageBounds)
  mainPageWindow.on('move', saveMainPageBounds)

  mainPagePendingShow = true
  mainPageWindow.loadURL(url)
}

function createTray() {
  loadIconCache()

  // Start with gray icon (no WS connections yet)
  const startIcon = trayIcon(iconCache.gray || iconCache.default)
  tray = new Tray(startIcon)
  setTrayState('gray')
  updateTrayMenu()

  tray.on('click', () => {
    // 左键点击 → 打开主页面网页（默认 1300x700，地址见「关于」设置）
    openMainPage()
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
  console.log('[WS] Message:', msg.type, msg.payload)

  switch (msg.type) {
    case 'REGISTER':
      setUserInfo({
        userId: msg.payload?.userId,
        userName: msg.payload?.userName,
        userIcon: msg.payload?.userIcon,
        browserType: msg.payload?.browserType
      }, ws)   // pass ws client for multi-user tracking
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
      setTrayState('ringing')
      if (msg.payload.callType === 'meeting') {
        showMeetingWindow(msg.payload, ws)
      } else {
        showCallWindow(msg.payload, ws)
      }
      break

    case 'SHOW_MESSAGE_NOTIFICATION':
      if (isDuplicateToast(msg.payload?.conversationId, msg.payload?.content)) {
        console.log('[Dedup] Skip duplicate toast')
        return
      }
      if (notificationCenter) notificationCenter.pushMessage(msg.payload || {})
      break

    case 'SYNC_CONTACTS':
      if (notificationCenter && Array.isArray(msg.payload?.contacts)) {
        notificationCenter.syncContacts(msg.payload.contacts)
        console.log('[WS] Synced contacts:', msg.payload.contacts.length)
      }
      break

    // 网页端实时下发的权威未读状态（IM SDK 真实未读数），桌面端以此为准重建聚合
    case 'SYNC_UNREAD':
      if (notificationCenter && Array.isArray(msg.payload?.items)) {
        notificationCenter.syncUnread(msg.payload.items)
        console.log('[WS] Synced unread from web:', msg.payload.items.length, 'items')
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
  const wa = getActiveDisplay().workArea

  callWindow = new BrowserWindow({
    ...makePopupWindowOpts(CALL_W, CALL_H),
    x: Math.round(wa.x + (wa.width - CALL_W) / 2),
    y: Math.round(wa.y + (wa.height - CALL_H) / 2),
  })
  callWindow.setAlwaysOnTop(true, 'screen-saver')
  callWindow.setVisibleOnAllWorkspaces(true)
  callWindow.loadFile(path.join(__dirname, 'src', 'call-window.html'))
  // Preload ringtone as soon as page is ready — eliminates ~5s audio decode delay on call arrival
  callWindow.webContents.once('did-finish-load', () => {
    callWindow.webContents.send('preload-ringtone', {
      ringtonePath: (ringtoneResolver ? ringtoneResolver.resolve('audio', null) : null) || getRingtonePath(),
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

  const wa = getActiveDisplay().workArea
  callWindow.setPosition(Math.round(wa.x + (wa.width - CALL_W) / 2), Math.round(wa.y + (wa.height - CALL_H) / 2))
  callWindow.webContents.setAudioMuted(false)   // Unmute in case previously muted
  callWindow.show()
  callWindow.focus()

  function sendCallPayload() {
    var rp = ringtoneResolver
      ? ringtoneResolver.resolve(payload.callType || 'audio', payload.callerId)
      : null
    // 兜底：resolver 可能因设置状态返回 null（如勿扰模式），仍需保证有铃声
    if (!rp) rp = getRingtonePath()
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
  const wa = getActiveDisplay().workArea

  meetingWindow = new BrowserWindow({
    ...makePopupWindowOpts(MEETING_W, MEETING_H),
    x: Math.round(wa.x + (wa.width - MEETING_W) / 2),
    y: Math.round(wa.y + (wa.height - MEETING_H) / 2),
  })
  meetingWindow.setAlwaysOnTop(true, 'screen-saver')
  meetingWindow.setVisibleOnAllWorkspaces(true)
  meetingWindow.loadFile(path.join(__dirname, 'src', 'meeting-window.html'))
  // Preload ringtone as soon as page is ready — eliminates ~5s audio decode delay on call arrival
  meetingWindow.webContents.once('did-finish-load', () => {
    meetingWindow.webContents.send('preload-ringtone', {
      ringtonePath: (ringtoneResolver ? ringtoneResolver.resolve('meeting', null) : null) || getRingtonePath(),
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

  const wa = getActiveDisplay().workArea
  meetingWindow.setPosition(Math.round(wa.x + (wa.width - MEETING_W) / 2), Math.round(wa.y + (wa.height - MEETING_H) / 2))
  meetingWindow.webContents.setAudioMuted(false)   // Unmute in case previously muted
  meetingWindow.show()
  meetingWindow.focus()

  function sendMeetingPayload() {
    var rp = ringtoneResolver
      ? ringtoneResolver.resolve('meeting', payload.callerId)
      : null
    if (!rp) rp = getRingtonePath()
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

// ─── IPC handlers ─────────────────────────────────────
ipcMain.on('call-action', (event, action) => {
  console.log('[IPC] Call action:', action)
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
    names: config.ringtoneNames,
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
  if (notificationCenter) notificationCenter.notifySettingsChanged()
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
    const stat = fs.statSync(src)
    const hash = crypto.createHash('sha1').update(src + stat.size + Date.now()).digest('hex').slice(0, 16)
    const dir = settingsStore.getRingtoneDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const rel = `ringtones/${hash}.${ext}`
    fs.copyFileSync(src, path.join(dir, `${hash}.${ext}`))   // 主进程直接 copy，不限大小
    settingsStore.addLocalRingtone(rel)
    return { path: rel, name: path.basename(src) }
  } catch (e) {
    console.error('[Ringtone] pick failed:', e && e.message)
    return null
  }
})

ipcMain.on('set-auto-start', (event, value) => {
  const v = !!value
  app.setLoginItemSettings({ openAtLogin: v })
  settingsStore.set({ autoStart: v })
  updateTrayMenu()
})

// 设置面板「通用」页拉取当前在线用户列表（与托盘菜单一致）
ipcMain.handle('tray-users-get', () => getTrayUsersData())

// ─── Settings window singleton ────────────────────
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isVisible()) settingsWindow.focus()
    else settingsWindow.show()
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
  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings-window.html'))
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

// 真正退出应用（被托盘菜单「退出」与潜在其他入口复用）
function quitApp() {
  isQuitting = true
  stopStaleCleanup()
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

  // Destroy tray
  if (tray) { tray.destroy(); tray = null }

  // Hard quit: app.quit() requests exit, process.exit(0) guarantees it
  app.quit()
  process.exit(0)
}