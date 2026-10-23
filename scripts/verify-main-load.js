// 主进程载入探针：electron 全量打桩 + 劫持 Module._load，确认 main.js 能真实载入、
// 通道全部注册，并调用关键通道确认无 ReferenceError。
// 用途：改 main.js 后必须跑（node --check 抓不到跨作用域引用）。
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const Module = require('module')

const noop = () => {}
const handlers = {}

const img = () => ({
  isEmpty: () => false, resize: () => img(), setTemplateImage: noop,
  toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 16, height: 16 }),
})

function makeWin() {
  const wc = {
    _url: 'about:blank',
    getURL() { return this._url },
    on: noop, once: noop, send: noop, stop: noop,
    executeJavaScript: () => Promise.resolve(),
    setWindowOpenHandler: noop,
    session: { setDisplayMediaRequestHandler: noop, setPermissionRequestHandler: noop },
  }
  const w = {
    webContents: wc,
    id: 1,
    isDestroyed: () => false, isVisible: () => false, isMinimized: () => false,
    isFocused: () => false, show: noop, hide: noop, focus: noop, restore: noop,
    loadURL: (u) => { wc._url = u }, loadFile: noop,
    setBounds: noop, getBounds: () => ({ x: 0, y: 0, width: 360, height: 520 }),
    setProgressBar: noop, setMenu: noop, setTitle: noop,
    on: noop, once: noop, removeAllListeners: noop,
  }
  // 未显式声明的方法一律当 noop，避免逐个补桩
  return new Proxy(w, {
    get(t, p) {
      if (p in t) return t[p]
      if (typeof p === 'symbol') return undefined
      return noop
    },
  })
}

const electron = {
  app: {
    getPath: () => 'C:/tmp', setPath: noop, whenReady: () => new Promise(() => {}),
    on: noop, getVersion: () => '1.0.0', isPackaged: false,
    requestSingleInstanceLock: () => true, quit: noop,
    commandLine: { appendSwitch: noop, hasSwitch: () => false, getSwitchValue: () => '' },
    getLoginItemSettings: () => ({}), setLoginItemSettings: noop, setAsDefaultProtocolClient: noop,
    disableHardwareAcceleration: noop, setAppUserModelId: noop,
    getName: () => 'x', getAppPath: () => 'C:/tmp', show: noop,
  },
  BrowserWindow: function () { return makeWin() },
  ipcMain: { on: (c, f) => { handlers[c] = f }, handle: (c, f) => { handlers[c] = f }, removeAllListeners: noop, removeHandler: noop },
  shell: { openExternal: noop, openPath: noop, showItemInFolder: noop },
  Tray: function () { return { setToolTip: noop, setImage: noop, setContextMenu: noop, on: noop, popUpContextMenu: noop, destroy: noop, isDestroyed: () => false } },
  Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop, getApplicationMenu: () => null },
  nativeImage: { createFromPath: () => img(), createFromBuffer: () => img(), createEmpty: () => img(), createFromDataURL: () => img() },
  nativeTheme: { on: noop, shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  globalShortcut: { register: noop, unregister: noop, unregisterAll: noop, isRegistered: () => false },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true }),
    showSaveDialog: () => Promise.resolve({ canceled: true }),
    showMessageBox: () => Promise.resolve({ response: 0 }),
    showErrorBox: noop,
  },
  Notification: function () { return { show: noop, on: noop } },
  session: { defaultSession: { setPermissionRequestHandler: noop, setDisplayMediaRequestHandler: noop, webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop } } },
  protocol: { registerSchemesAsPrivileged: noop, handle: noop, isProtocolHandled: () => false },
  powerMonitor: { on: noop },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: () => Promise.resolve(true) },
  desktopCapturer: { getSources: () => Promise.resolve([]) },
  clipboard: { readText: () => '', writeText: noop, readImage: () => ({ isEmpty: () => true }), writeImage: noop },
  net: { request: () => ({ on: noop, end: noop, write: noop }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  webContents: { getAllWebContents: () => [] },
}

const origLoad = Module._load
Module._load = function (req) {
  if (req === 'electron') return electron
  return origLoad.apply(this, arguments)
}

const sandbox = {
  console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
  // ★ 相对路径必须按 main.js 所在目录（cwd）解析：沙箱没有真实模块路径，
  //   直接 require('./lib/x') 会以本脚本所在目录为基准而找不到。
  require: (m) => {
    if (m === 'electron') return electron
    if (m.startsWith('.')) return Module._load(path.resolve(process.cwd(), m), module, false)
    return Module._load(m, module, false)
  },
  process: {
    platform: 'win32', env: {}, argv: [], execPath: 'x', version: 'v20', versions: {},
    nextTick: (f) => f(), on: noop, cwd: () => process.cwd(), resourcesPath: 'C:/tmp', type: 'browser',
  },
  __dirname: process.cwd(),
  __filename: path.join(process.cwd(), 'main.js'),
  setTimeout: () => 0, setInterval: () => 0, clearTimeout: noop, clearInterval: noop, setImmediate: noop,
  Buffer, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController,
  Promise, Date, Math, JSON, RegExp, Error, String, Number, Object, Array, Symbol,
  Map, Set, WeakMap, WeakSet, Reflect, Proxy, Intl, structuredClone,
}
sandbox.global = sandbox
sandbox.globalThis = sandbox
sandbox.module = {}
sandbox.exports = {}

const code = fs.readFileSync(path.join(process.cwd(), 'main.js'), 'utf8')
let loadErr = null
try {
  vm.runInNewContext(code, sandbox, { filename: 'main.js', timeout: 30000 })
} catch (e) {
  loadErr = e
  console.log('[载入失败]', e && e.name, ':', e && e.message)
  console.log((e && e.stack || '').split('\n').slice(0, 6).join('\n'))
}
if (!loadErr) console.log('载入成功，捕获 IPC 通道:', Object.keys(handlers).length)

let bad = 0
// 只调用与本次改动相关的通道；其余通道需要真实窗口上下文，不强行触发
const targets = ['mainpage-retry', 'nc-resize', 'nc-close', 'nc-mark-read']
for (const ch of targets) {
  if (!handlers[ch]) { console.log('SKIP |', ch, '未注册'); continue }
  try {
    handlers[ch]({ sender: { send: noop } }, '')
    console.log('PASS |', ch, '调用无异常')
  } catch (e) {
    if (e && e.name === 'ReferenceError') { bad++; console.log('FAIL |', ch, 'ReferenceError:', e.message) }
    else console.log('ok   |', ch, '(' + (e && e.name) + ')', e && e.message)
  }
}

console.log(bad === 0 && !loadErr ? '\n通过：主进程可载入，关键通道无 ReferenceError' : '\n存在问题')
process.exit(bad === 0 && !loadErr ? 0 : 1)
