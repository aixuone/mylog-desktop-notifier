// main.js - Electron main process: tray + WS server + notification windows
process.env.ELECTRON_NO_ATTACH_CONSOLE = '1'

const { app, Tray, Menu, BrowserWindow, ipcMain, shell, Notification, nativeImage } = require('electron')
const path = require('path')
const { WebSocketServer } = require('ws')

// ─── Global state ──────────────────────────────────────────
let tray = null
let wsServer = null
let callWindow = null        // incoming call popup (screen center)
let toastWindow = null        // message toast (bottom right)
let audioPlayer = null
let isQuitting = false

const WS_PORT = 18999
const PRELOAD_PATH = path.join(__dirname, 'src', 'preload.js')

// ─── App lifecycle ────────────────────────────────────────
app.whenReady().then(() => {
  createTray()
  startWSServer()
  registerProtocol()
  console.log('[MyLog Notifier] Ready | WS port:', WS_PORT)
})

app.on('window-all-closed', (e) => {
  // Prevent default: tray app should not quit when all windows are closed
  if (!isQuitting) e.preventDefault()
})

app.on('before-quit', () => { isQuitting = true })

// ─── System tray ──────────────────────────────────────────
function createTray() {
  // 使用默认图标（若 assets/icon.png 存在则使用）
  let iconPath = path.join(__dirname, 'assets', 'icon.png')
  const fs = require('fs')
  if (!fs.existsSync(iconPath)) {
    // 创建一个简单的占位图标（1x1 透明 PNG）
    iconPath = path.join(__dirname, 'assets', 'tray.png')
  }

  tray = new Tray(iconPath)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'MyLog 通知助手',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开 MyLog',
      click: () => shell.openExternal('http://localhost:5173'),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        // Must destroy tray before quit, otherwise app.quit() is blocked
        if (tray) {
          tray.destroy()
          tray = null
        }
        // 关闭 WS 服务器
        if (wsServer) {
          wsServer.close()
          wsServer = null
        }
        app.quit()
      },
    },
  ])
  tray.setToolTip('MyLog 通知助手')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    // 单击托盘图标：打开主网页
    shell.openExternal('http://localhost:5173')
  })
}

// ─── Protocol handler ─────────────────────────────────────
function registerProtocol() {
  // 注册 web+mylog:// 协议（仅做基础支持，浏览器置顶本期不做）
  if (process.defaultApp) return
  app.setAsDefaultProtocolClient('web+mylog')
}

// ─── WebSocket server ──────────────────────────────────
function startWSServer() {
  wsServer = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })

  wsServer.on('connection', (ws) => {
    console.log('[WS] Browser connected')

    // 发送连接确认
    ws.send(JSON.stringify({ type: 'CONNECTED', payload: { version: '1.0.0' } }))

    // 心跳：收到 PING 回复 PONG
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
      console.warn(`[WS] Port ${WS_PORT} in use (another instance running?)`)
      // 不退出，让位于已运行的实例
    } else {
      console.error('[WS] Server error:', err)
    }
  })

  console.log(`[WS] Server listening on ws://127.0.0.1:${WS_PORT}`)
}

// ─── Handle browser messages ──────────────────────────
function handleBrowserMessage(ws, msg) {
  console.log('[WS] Message:', msg.type, msg)

  switch (msg.type) {
    case 'REGISTER':
      console.log('[WS] Browser register:', msg.payload?.userName)
      break

    case 'SHOW_CALL_NOTIFICATION':
      showCallWindow(msg.payload, ws)
      break

    case 'SHOW_MESSAGE_NOTIFICATION':
      showToast(msg.payload)
      break

    case 'CALL_CONNECTED':
    case 'CALL_ENDED':
      closeCallWindow()
      stopRingtone()
      break

    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }))
      break

    default:
      console.log('[WS] Unknown message type:', msg.type)
  }
}

// ─── Incoming call window (screen center, topmost) ────
function showCallWindow(payload, ws) {
  closeCallWindow() // 关闭已有弹窗

  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = primaryDisplay.workAreaSize
  const w = 380
  const h = 280
  const x = Math.round((sw - w) / 2)
  const y = Math.round((sh - h) / 2)

  callWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Always on top (even when focus is lost)
  callWindow.setAlwaysOnTop(true, 'screen-saver')
  callWindow.setVisibleOnAllWorkspaces(true)

  // 加载来电弹窗 HTML
  callWindow.loadFile(path.join(__dirname, 'src', 'call-window.html'))

  // 传递数据给弹窗
  callWindow.webContents.once('did-finish-load', () => {
    callWindow.webContents.send('call-data', payload)
  })

  // 播放铃声
  playRingtone(payload.callType)

  // Timer auto-close (45 seconds)
  setTimeout(() => {
    if (callWindow) {
      closeCallWindow()
      stopRingtone()
      // 通知浏览器：超时未接
      ws.send(JSON.stringify({
        type: 'USER_ACTION',
        payload: { action: 'timeout', callId: payload.callId }
      }))
    }
  }, 45000)
}

function closeCallWindow() {
  if (callWindow) {
    try {
      if (!callWindow.isDestroyed()) callWindow.destroy()
    } catch (e) {
      // fallback to close() if destroy() fails
      try { callWindow.close() } catch (_) {}
    }
    callWindow = null
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
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
    },
  })

  toastWindow.setAlwaysOnTop(true, 'normal')
  toastWindow.loadFile(path.join(__dirname, 'src', 'toast-window.html'))

  toastWindow.webContents.once('did-finish-load', () => {
    toastWindow.webContents.send('toast-data', payload)
  })

  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    if (toastWindow) {
      try { toastWindow.close() } catch (e) {}
      toastWindow = null
    }
  }, 8000)
}

// ─── Ringtone playback ──────────────────────────────────
let ringtoneProc = null

function playRingtone(callType = 'audio') {
  stopRingtone()

  // 使用系统默认声音（跨平台兼容）
  // Windows: 使用系统来电铃声
  // macOS: 使用系统通知声音
  if (process.platform === 'win32') {
    // 使用 PowerShell 播放系统声音
    const { spawn } = require('child_process')
    // 备用：播放内置音频文件
    const soundFile = path.join(__dirname, 'assets', 'ringtone.m4a')
    const fs = require('fs')
    if (fs.existsSync(soundFile)) {
      // 使用系统音频 API 播放（不依赖浏览器）
      ringtoneProc = spawn('powershell', [
        '-c', `(New-Object Media.SoundPlayer '${soundFile}').PlayLooping()`
      ], { detached: true, shell: true })
    } else {
      // 没有音频文件时使用系统声音
      spawn('powershell', ['-c', '[System.Media.SystemSounds]::Hand.Play()'], { shell: true })
    }
  } else {
    // macOS / Linux: 使用系统通知声音
    const { exec } = require('child_process')
    exec('afplay /System/Library/Sounds/Ping.aiff &', (err) => {})
  }
}

function stopRingtone() {
  if (ringtoneProc) {
    try {
      process.kill(-ringtoneProc.pid)
    } catch (e) {}
    ringtoneProc = null
  }
}

// ─── IPC handlers ─────────────────────────────────────
ipcMain.on('call-action', (event, action) => {
  // action = 'accept' | 'reject' | 'ignore'
  console.log('[IPC] User action:', action)

  // 找到连接的浏览器 WS 客户端，回传操作
  // （简化版：遍历所有 WS 客户端）
  if (wsServer) {
    wsServer.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify({
          type: 'USER_ACTION',
          payload: {
            action,
            callId: callWindow?._callId || '',
            timestamp: Date.now(),
          }
        }))
      }
    })
  }

  closeCallWindow()
  stopRingtone()
})

// Toast close button handler
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

// ─── Single-instance lock (port probe) ────────────────
// 如果端口已被占用，说明已有实例运行，当前实例退出
const net = require('net')
const probe = net.createServer()
probe.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('[Notifier] Another instance already running, exiting.')
    app.quit()
  }
})
probe.once('listening', () => {
  probe.close()
})
probe.listen(WS_PORT + 1, '127.0.0.1') // 用 +1 端口做互斥检测
