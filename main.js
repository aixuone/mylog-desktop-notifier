// main.js - Electron main process: tray + WS server + HTTP server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage, dialog } = require('electron')
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

// ─── Notification center window rect (bottom-right) ──
function getNcRect(w, h) {
  const { screen } = require('electron')
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const margin = 20
  return { x: sw - w - margin, y: sh - h - margin }
}

// ─── Broadcast helper (main → all web clients) ──
function broadcast(msg) {
  if (!wsServer) return
  const raw = JSON.stringify(msg)
  wsServer.clients.forEach((c) => { if (c.readyState === 1) c.send(raw) })
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
          const reclaimed = {
            clientId: oldEntry.clientId,     // keep same clientId (stable identity)
            userId,
            userName,
            userIcon,
            browserType,
            connected: true,
            localIconPath: oldEntry.localIconPath,  // reuse downloaded icon
            lastSeenAt: now,
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
  findAvailablePort(config.wsPort, config.handshake.maxAttempts, (err, wsPort) => {
    if (err || !wsPort) {
      console.error('[Port] No available ports found, exiting')
      app.quit()
      return
    }

    currentWsPort = wsPort
    createTray()

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
function createTray() {
  loadIconCache()

  // Start with gray icon (no WS connections yet)
  const startIcon = trayIcon(iconCache.gray || iconCache.default)
  tray = new Tray(startIcon)
  setTrayState('gray')
  updateTrayMenu()

  tray.on('click', () => {
    // 左键点击 → 打开设置面板
    openSettingsWindow()
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

  wsServer.on('connection', (ws) => {
    const clientId = ++clientIdCounter
    const now = Date.now()
    console.log('[WS] Browser connected, clientId:', clientId)

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
  const { screen } = require('electron')
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  callWindow = new BrowserWindow({
    ...makePopupWindowOpts(CALL_W, CALL_H),
    x: Math.round((sw - CALL_W) / 2),
    y: Math.round((sh - CALL_H) / 2),
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

  const { screen } = require('electron')
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  callWindow.setPosition(Math.round((sw - CALL_W) / 2), Math.round((sh - CALL_H) / 2))
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
  const { screen } = require('electron')
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  meetingWindow = new BrowserWindow({
    ...makePopupWindowOpts(MEETING_W, MEETING_H),
    x: Math.round((sw - MEETING_W) / 2),
    y: Math.round((sh - MEETING_H) / 2),
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

  const { screen } = require('electron')
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  meetingWindow.setPosition(Math.round((sw - MEETING_W) / 2), Math.round((sh - MEETING_H) / 2))
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