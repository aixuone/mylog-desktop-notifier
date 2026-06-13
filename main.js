// main.js - Electron main process: tray + WS server + HTTP server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage } = require('electron')
const path = require('path')
const { WebSocketServer } = require('ws')
const http = require('http')
const https = require('https')
const fs = require('fs')
const net = require('net')

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
// ─── Tray icon state management ───────────────────────────
// States: 'default' (connected, normal) | 'gray' (disconnected) | 'ringing' (incoming call) | 'unread' (unread messages)
let trayIconState = 'gray'    // Start gray (no connections yet)
let blinkInterval = null      // setInterval reference for blinking
let blinkPhase = false        // true = showing alternate icon, false = showing primary icon

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
}

/** Check if any client is currently connected via WebSocket */
function hasConnectedClients() {
  return Array.from(connectedClients.values()).some(u => u.connected)
}

/**
 * Set tray icon state with optional blinking.
 * - 'default':  solid default icon (no blink)
 * - 'gray':     solid gray icon (no blink)
 * - 'ringing':  blink between default ↔ gray (500ms)
 * - 'unread':   blink between unread ↔ default (500ms)
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

  switch (state) {
    case 'default':
      tray.setImage(iconCache.default || iconCache.ringing || iconCache.unread)
      break

    case 'gray':
      tray.setImage(iconCache.gray || iconCache.default)
      break

    case 'ringing':
      // Alternate: default (color) ↔ gray
      tray.setImage(iconCache.default)
      blinkInterval = setInterval(() => {
        blinkPhase = !blinkPhase
        tray.setImage(blinkPhase ? (iconCache.gray || iconCache.default) : iconCache.default)
      }, 500)
      break

    case 'unread':
      // Alternate: unread (red dot) ↔ default
      tray.setImage(iconCache.unread || iconCache.default)
      blinkInterval = setInterval(() => {
        blinkPhase = !blinkPhase
        tray.setImage(blinkPhase ? iconCache.default : (iconCache.unread || iconCache.default))
      }, 500)
      break

    default:
      console.warn('[Tray] Unknown state:', state)
      tray.setImage(iconCache.default)
  }

  if (prevState !== state) {
    console.log('[Tray] Icon state:', prevState, '→', state)
  }
}

/** Derive the correct icon state based on current conditions */
function deriveTrayState() {
  // Priority: ringing > unread > default/gray
  if (trayIconState === 'ringing') return 'ringing'  // Don't auto-override ringing
  if (unreadCount > 0) return 'unread'
  return hasConnectedClients() ? 'default' : 'gray'
}

let unreadCount = 0

// User info from browser - supports multiple users (keyed by ws client id)
// connectedClients: Map<ws, { clientId, userId, userName, userIcon, browserType, connected, localIconPath, lastSeenAt }>
let connectedClients = new Map()

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

// Toast queue: ensure messages display one by one
const toastQueue = []
let isToastShowing = false

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
  }, 60_000)
}

function stopStaleCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}

function updateTrayMenu() {
  if (!tray) return

  const menuItems = []

  // ── Multi-user section ──────────────────────────────────
  // Only show connected users
  const connectedUsers = Array.from(connectedClients.values()).filter(u => u.connected)
  if (connectedUsers.length > 0) {
    connectedUsers.forEach((u) => {
      const displayName = u.userName || u.userId || '未知用户'
      menuItems.push({
        label: `${displayName} 🟢`,  // Added spaces for better width
        enabled: false,
        // Use local icon path if available, resize to 16x16
        ...(u.localIconPath && fs.existsSync(u.localIconPath)
          ? { icon: nativeImage.createFromPath(u.localIconPath).resize({ width: 20, height: 20 }) }
          : {})
      })
    })
    menuItems.push({ type: 'separator' })
  } else if (currentUser.userName) {
    // Fallback: legacy single user display
    menuItems.push({
      label: `  ${currentUser.userName}`,  // Added spaces for better width
      enabled: false
    })
    menuItems.push({ type: 'separator' })
  }
  // ── End multi-user section ──────────────────────────────

  menuItems.push({
    label: '开机自启',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => {
      app.setLoginItemSettings({ openAtLogin: item.checked })
    },
  })
  menuItems.push({ type: 'separator' })
  menuItems.push({
    label: '退出',
    click: () => {
      isQuitting = true
      stopStaleCleanup()
      if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null }
      if (tray) {
        tray.destroy()
        tray = null
      }
      if (wsServer) {
        wsServer.close()
        wsServer = null
      }
      if (httpServer) {
        httpServer.close()
        httpServer = null
      }
      app.quit()
    },
  })

  const contextMenu = Menu.buildFromTemplate(menuItems)
  tray.setContextMenu(contextMenu)

  // Tooltip: show online count
  const onlineCount = connectedUsers.length
  if (onlineCount > 0) {
    tray.setToolTip(`我的日志-通知助手 | ${onlineCount} 个用户在线`)
  } else {
    tray.setToolTip(currentUser.userName || '我的日志-通知助手')
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
          entry.localIconPath = iconPath
          connectedClients.set(wsClient, entry)
          updateTrayMenu()
          // Also update legacy path for primary user
          if (entry.userId === currentUser.userId) {
            localUserIconPath = iconPath
          }
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
            version: '1.0.0',
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
        version: '1.0.0'
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
app.whenReady().then(() => {
  findAvailablePort(config.wsPort, config.handshake.maxAttempts, (err, wsPort) => {
    if (err || !wsPort) {
      console.error('[Port] No available ports found, exiting')
      app.quit()
      return
    }

    currentWsPort = wsPort
    createTray()
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

app.on('window-all-closed', (e) => {
  if (!isQuitting) e.preventDefault()
})

app.on('before-quit', () => {
  isQuitting = true
  stopStaleCleanup()
  if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null }
})

// ─── System tray ──────────────────────────────────────────
function createTray() {
  loadIconCache()

  // Start with gray icon (no WS connections yet)
  const startIcon = iconCache.gray || iconCache.default
  tray = new Tray(startIcon)
  setTrayState('gray')
  updateTrayMenu()

  tray.on('click', () => {
    // Click clears unread → back to connected/disconnected state
    updateUnreadCount(0)
    if (trayIconState !== 'ringing') {
      setTrayState(deriveTrayState())
    }
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

    ws.send(JSON.stringify({ type: 'CONNECTED', payload: { version: '1.0.0', port: currentWsPort } }))

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
  console.log('[WS] Message:', msg.type)

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
      if (isDuplicateCall(msg.payload?.callId)) {
        console.log('[Dedup] Skip duplicate call:', msg.payload?.callId)
        return
      }
      setTrayState('ringing')
      if (msg.payload?.callType === 'meeting') {
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
      showToast(msg.payload)
      break

    case 'UPDATE_UNREAD_COUNT':
      updateUnreadCount(msg.payload?.count || 0)
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
  callWindow.show()
  callWindow.focus()

  function sendCallPayload() {
    callWindow.webContents.send('call-data', {
      ...payload,
      ringtonePath: getRingtonePath(),
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
      setTrayState(deriveTrayState())
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
    callWindow.hide()
    callWindow.webContents.send('stop-ringtone')
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
  meetingWindow.show()
  meetingWindow.focus()

  function sendMeetingPayload() {
    meetingWindow.webContents.send('meeting-data', {
      ...payload,
      ringtonePath: getRingtonePath(),
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
      setTrayState(deriveTrayState())
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
    meetingWindow.hide()
    meetingWindow.webContents.send('stop-ringtone')
    if (meetingWindow._timer) {
      clearTimeout(meetingWindow._timer)
      meetingWindow._timer = null
    }
  }
}

// ─── Message toast (bottom right, WeChat-style) ──────
function showToast(payload) {
  // If a toast is currently showing, queue this message
  if (isToastShowing) {
    toastQueue.push(payload)
    console.log('[Toast] Queued message, queue length:', toastQueue.length)
    return
  }

  displayToast(payload)
}

function displayToast(payload) {
  isToastShowing = true

  if (toastWindow) {
    try { toastWindow.close() } catch (e) {}
    toastWindow = null
  }

  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = primaryDisplay.workAreaSize
  const w = config.toastWindow.width
  const h = config.toastWindow.height
  const margin = config.toastWindow.margin
  const x = sw - w - margin
  const y = sh - h - margin

  toastWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    ...(supportsAcrylic()
      ? { backgroundMaterial: 'acrylic' }
      : { backgroundColor: '#FFFFFF', transparent: false }),
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: makeWebPrefs(),
  })

  toastWindow.setAlwaysOnTop(true, 'normal')
  toastWindow.loadFile(path.join(__dirname, 'src', 'toast-window.html'))

  toastWindow.webContents.once('did-finish-load', () => {
    toastWindow.webContents.send('toast-data', payload)
  })

  // Handle window close event to show next message in queue
  toastWindow.on('closed', () => {
    toastWindow = null
    isToastShowing = false

    // Check if there are more messages in the queue
    if (toastQueue.length > 0) {
      const nextPayload = toastQueue.shift()
      console.log('[Toast] Showing next message from queue, remaining:', toastQueue.length)
      // Use setImmediate to ensure proper cleanup before showing next
      setImmediate(() => displayToast(nextPayload))
    }
  })

  setTimeout(() => {
    if (toastWindow && !toastWindow.isDestroyed()) {
      try { toastWindow.close() } catch (e) {}
    }
  }, config.timeout.toast)
}

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
  setTrayState(deriveTrayState())
  closeCallWindow()
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
  setTrayState(deriveTrayState())
  closeMeetingWindow()
})

ipcMain.on('close-toast', () => {
  if (toastWindow) {
    try {
      if (!toastWindow.isDestroyed()) toastWindow.destroy()
    } catch (e) {
      try { toastWindow.close() } catch (_) {}
    }
    toastWindow = null
  }
})