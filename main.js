// main.js - Electron main process: tray + WS server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('path')
const { WebSocketServer } = require('ws')

// ─── Global state ──────────────────────────────────────────
let tray = null
let wsServer = null
let callWindow = null        // incoming audio/video call popup (screen center)
let meetingWindow = null     // incoming meeting invitation popup
let toastWindow = null        // message toast (bottom right)
let isQuitting = false

const WS_PORT = 18999
const PRELOAD_PATH = path.join(__dirname, 'src', 'preload.js')
const CALL_W = 380
const CALL_H = 280
const MEETING_W = 380
const MEETING_H = 320

// Ringtone file (M4A - played via HTML5 Audio in renderer, not PowerShell)
const RINGTONE_FILE = path.join(__dirname, 'assets', 'ringtone.m4a')
const fs = require('fs')
function getRingtonePath() {
  if (fs.existsSync(RINGTONE_FILE)) {
    return 'file:///' + RINGTONE_FILE.replace(/\\/g, '/')
  }
  return ''
}

// Deduplication: prevent duplicate notifications from multiple browser tabs
const recentCalls = new Map()
const recentToasts = new Map()
const DEDUP_CALL_WINDOW_MS = 5000
const DEDUP_TOAST_WINDOW_MS = 3000

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
    // Allow Audio.play() without user gesture — critical for ringtone reliability
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
    // Use acrylic material instead of transparent:true to keep ClearType font rendering
    // transparent:true creates WS_EX_LAYERED which disables subpixel anti-aliasing on Windows,
    // causing CJK characters to appear broken/garbled (Electron issue #40515)
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

// ─── App lifecycle ────────────────────────────────────────
app.whenReady().then(() => {
  createTray()
  startWSServer()
  registerProtocol()
  preCreateCallWindow()
  preCreateMeetingWindow()
  console.log('[MyLog Notifier] Ready | WS port:', WS_PORT)
})

app.on('window-all-closed', (e) => {
  if (!isQuitting) e.preventDefault()
})

app.on('before-quit', () => { isQuitting = true })

// ─── System tray ──────────────────────────────────────────
function createTray() {
  let iconPath = path.join(__dirname, 'assets', 'icon.png')
  if (!fs.existsSync(iconPath)) {
    iconPath = path.join(__dirname, 'assets', 'tray.png')
  }

  tray = new Tray(iconPath)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'MyLog Notification Assistant / MyLog 通知助手',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open MyLog / 打开 MyLog',
      click: () => shell.openExternal('http://localhost:5173'),
    },
    {
      label: 'Launch at startup / 开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
      },
    },
    { type: 'separator' },
    {
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
        app.quit()
      },
    },
  ])
  tray.setToolTip('MyLog Notification Assistant / MyLog 通知助手')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    shell.openExternal('http://localhost:5173')
  })
}

// ─── Protocol handler ─────────────────────────────────────
function registerProtocol() {
  if (process.defaultApp) return
  app.setAsDefaultProtocolClient('web+mylog')
}

// ─── WebSocket server ──────────────────────────────────
function startWSServer() {
  wsServer = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })

  wsServer.on('connection', (ws) => {
    console.log('[WS] Browser connected')
    ws.send(JSON.stringify({ type: 'CONNECTED', payload: { version: '1.0.0' } }))

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
    if (err.code === 'EADDRINUSE') {
      console.warn('[WS] Port', WS_PORT, 'in use (another instance running?)')
    } else {
      console.error('[WS] Server error:', err)
    }
  })

  console.log('[WS] Server listening on ws://127.0.0.1:', WS_PORT)
}

// ─── Handle browser messages ──────────────────────────
function handleBrowserMessage(ws, msg) {
  console.log('[WS] Message:', msg.type)

  switch (msg.type) {
    case 'REGISTER':
      console.log('[WS] Browser register:', msg.payload?.userName)
      break

    case 'SHOW_CALL_NOTIFICATION':
      if (isDuplicateCall(msg.payload?.callId)) {
        console.log('[Dedup] Skip duplicate call:', msg.payload?.callId)
        return
      }
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

    case 'CALL_CONNECTED':
    case 'CALL_ENDED':
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
      callWindow.hide()
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: { action: 'timeout', callId: payload.callId }
        }))
      }
    }
  }, 45000)
  callWindow._timer = timer
}

function closeCallWindow() {
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.hide()
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
      meetingWindow.hide()
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: { action: 'timeout', callId: payload.callId, callType: 'meeting' }
        }))
      }
    }
  }, 45000)
  meetingWindow._timer = timer
}

function closeMeetingWindow() {
  if (meetingWindow && !meetingWindow.isDestroyed()) {
    meetingWindow.hide()
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
  const w = 340
  const h = 100
  const x = sw - w - 20
  const y = sh - h - 20

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
  }, 8000)
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

// ─── Single-instance lock ──────────────────────────
const net = require('net')
const probe = net.createServer()
probe.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[Notifier] Another instance already running, exiting.')
    app.quit()
  }
})
probe.once('listening', () => { probe.close() })
probe.listen(WS_PORT + 1, '127.0.0.1')
