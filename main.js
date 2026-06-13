// main.js - Electron main process: tray + WS server + HTTP server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const { WebSocketServer } = require('ws')
const http = require('http')
const fs = require('fs')
const net = require('net')

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
let trayIconState = 'default' // default, incoming, unread
let unreadCount = 0

// User info from browser
let currentUser = {
  userId: '',
  userName: '',
  userIcon: '',
  browserType: ''
}

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

// ─── Tray icon management ──────────────────────────────────
function getIconPath(state) {
  if (state === 'default' && currentUser.userIcon) {
    return currentUser.userIcon
  }
  
  const iconConfig = config.icons[state] || config.icons.default
  const fullPath = path.join(__dirname, iconConfig)
  if (fs.existsSync(fullPath)) {
    return fullPath
  }
  return path.join(__dirname, config.icons.default)
}

function setTrayIcon(state) {
  if (!tray || trayIconState === state) return
  
  const iconPath = getIconPath(state)
  tray.setImage(iconPath)
  trayIconState = state
  console.log('[Tray] Icon state changed to:', state)
}

function updateUnreadCount(count) {
  unreadCount = Math.max(0, count)
  const tooltip = currentUser.userName 
    ? `${currentUser.userName} - ${unreadCount} unread messages`
    : `MyLog Notification Assistant${unreadCount > 0 ? ` - ${unreadCount} unread messages` : ''}`
  
  if (unreadCount > 0 && trayIconState !== 'incoming') {
    setTrayIcon('unread')
    tray.setToolTip(tooltip)
  } else if (trayIconState === 'unread' && unreadCount === 0) {
    setTrayIcon('default')
    tray.setToolTip(currentUser.userName || 'MyLog Notification Assistant / MyLog 通知助手')
  }
}

function updateTrayMenu() {
  if (!tray) return

  const menuItems = []
  
  if (currentUser.userName) {
    menuItems.push({
      label: currentUser.userName,
      enabled: false,
      icon: currentUser.userIcon ? path.basename(currentUser.userIcon) : undefined
    })
    menuItems.push({ type: 'separator' })
  }
  
  menuItems.push({
    label: 'Launch at startup / 开机自启',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => {
      app.setLoginItemSettings({ openAtLogin: item.checked })
    },
  })
  menuItems.push({ type: 'separator' })
  menuItems.push({
    label: 'Exit / 退出',
    click: () => {
      isQuitting = true
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
  
  tray.setToolTip(currentUser.userName || 'MyLog Notification Assistant / MyLog 通知助手')
}

function setUserInfo(userData) {
  currentUser = {
    userId: userData.userId || '',
    userName: userData.userName || '',
    userIcon: userData.userIcon || '',
    browserType: userData.browserType || ''
  }
  
  console.log('[User] Updated:', currentUser.userName, currentUser.browserType)
  updateTrayMenu()
  if (trayIconState === 'default') {
    setTrayIcon('default')
  }
}

// ─── HTTP server for handshake ────────────────────────────
const HTTP_DEFAULT_PORT = 8080

function startHttpServer(callback) {
  const server = http.createServer((req, res) => {
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
          console.log('[HTTP] Handshake request:', data)
          
          setUserInfo({
            userId: data.userId,
            userName: data.userName,
            userIcon: data.userIcon,
            browserType: data.browserType
          })

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
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      currentHttpPort++
      console.log('[HTTP] Port', currentHttpPort - 1, 'in use, trying port', currentHttpPort)
      server.listen(currentHttpPort, '127.0.0.1')
    } else {
      console.error('[HTTP] Server error:', err)
      callback(err)
    }
  })

  server.on('listening', () => {
    currentHttpPort = server.address().port
    httpServer = server
    console.log('[HTTP] Server listening on http://127.0.0.1:', currentHttpPort)
    callback(null)
  })

  currentHttpPort = HTTP_DEFAULT_PORT
  server.listen(currentHttpPort, '127.0.0.1')
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

app.on('before-quit', () => { isQuitting = true })

// ─── System tray ──────────────────────────────────────────
function createTray() {
  const iconPath = getIconPath('default')

  tray = new Tray(iconPath)
  updateTrayMenu()

  tray.on('click', () => {
    updateUnreadCount(0)
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
    console.log('[WS] Browser connected')
    ws.send(JSON.stringify({ type: 'CONNECTED', payload: { version: '1.0.0', port: currentWsPort } }))

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw)
        handleBrowserMessage(ws, msg)
      } catch (e) {
        console.warn('[WS] Invalid message:', raw)
      }
    })

    ws.on('close', () => {
      console.log('[WS] Browser disconnected')
    })
  })

  wsServer.on('error', (err) => {
    console.error('[WS] Server error:', err)
  })

  console.log('[WS] Server listening on ws://127.0.0.1:', currentWsPort)
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
      })
      break

    case 'SHOW_CALL_NOTIFICATION':
      if (isDuplicateCall(msg.payload?.callId)) {
        console.log('[Dedup] Skip duplicate call:', msg.payload?.callId)
        return
      }
      setTrayIcon('incoming')
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
      setTrayIcon(unreadCount > 0 ? 'unread' : 'default')
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
      setTrayIcon(unreadCount > 0 ? 'unread' : 'default')
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
      setTrayIcon(unreadCount > 0 ? 'unread' : 'default')
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

  setTimeout(() => {
    if (toastWindow) {
      try { toastWindow.close() } catch (e) {}
      toastWindow = null
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
  setTrayIcon(unreadCount > 0 ? 'unread' : 'default')
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
  setTrayIcon(unreadCount > 0 ? 'unread' : 'default')
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