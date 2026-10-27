// 邮箱窗口行为回归：真实调用 email:open-window，验证
//  1) 创建的窗口使用 persist:alimail 持久分区，并加载固定地址；
//  2) 导航白名单已注册（isEmailSite：放行 qiye.aliyun.com / *.aliyun.com / *.mxhichina.com）；
//  3) 重复打开复用同一窗口（不重复创建）；
//  4) 关闭=隐藏（preventDefault + hide），仅在 isQuitting 后才允许真关闭；
//  5) 已保存 SSO 会话时直接进邮箱主页（/alimail/），否则走登录入口（/alimail/auth/login）；
//  6) 隐藏窗口时触发会话落盘（saveEmailSession）。
// 改 openEmailWindow / isEmailSite / 会话持久化后必须跑：node scripts/verify-email-window.js
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const Module = require('module')
const os = require('os')

const noop = () => {}
const handlers = {}
const appHandlers = {}
const wins = []

// 用一个真实可写的临时目录模拟 userData，便于验证会话落盘/读取
const TEST_USERDATA = path.join(process.cwd(), '.email-session-test')
const EMAIL_SESSION_PATH = path.join(TEST_USERDATA, 'email', 'alimail-session.json')

function writeSessionFile(cookies) {
  fs.mkdirSync(path.dirname(EMAIL_SESSION_PATH), { recursive: true })
  fs.writeFileSync(EMAIL_SESSION_PATH, JSON.stringify(cookies))
}
function removeSessionFile() {
  try { fs.rmSync(TEST_USERDATA, { recursive: true, force: true }) } catch (e) {}
}

function makeWin(opts) {
  const calls = []
  const listeners = {}
  const wc = {
    _url: 'about:blank',
    getURL() { return this._url },
    on(evt, fn) { listeners['wc:' + evt] = fn },
    setWindowOpenHandler(fn) { listeners['wc:windowopen'] = fn },
    send: noop, stop: noop, once: noop,
    executeJavaScript: () => Promise.resolve(),
    session: { setDisplayMediaRequestHandler: noop, setPermissionRequestHandler: noop },
  }
  const base = {
    webContents: wc,
    _ctorOpts: opts, _listeners: listeners, _calls: calls,
    id: 1,
    isDestroyed: () => false, isVisible: () => false, isMinimized: () => false, isFocused: () => false,
    show: () => calls.push('show'), hide: () => calls.push('hide'), focus: () => calls.push('focus'), restore: noop,
    loadURL: (u) => { wc._url = u; calls.push('loadURL:' + u) }, loadFile: noop,
    setBounds: noop, getBounds: () => ({ x: 0, y: 0, width: 360, height: 520 }),
    setProgressBar: noop, setMenu: noop, setTitle: noop,
    on(evt, fn) { listeners[evt] = fn },
    once: noop, removeAllListeners: noop,
  }
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p]
      if (typeof p === 'symbol') return undefined
      return noop
    },
  })
}

const img = () => ({
  isEmpty: () => false, resize: () => img(), setTemplateImage: noop,
  toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 16, height: 16 }),
})

// 模拟分区会话：cookies.get 默认返回空（save 时不会真实写盘），cookies.set 空操作
function makePartitionSession() {
  return { cookies: { get: () => Promise.resolve([]), set: () => Promise.resolve() } }
}

const electron = {
  app: {
    getPath: () => TEST_USERDATA, setPath: noop, whenReady: () => new Promise(() => {}),
    on: (evt, fn) => { appHandlers[evt] = fn }, getVersion: () => '1.0.0', isPackaged: false,
    requestSingleInstanceLock: () => true, quit: noop,
    commandLine: { appendSwitch: noop, hasSwitch: () => false, getSwitchValue: () => '' },
    getLoginItemSettings: () => ({}), setLoginItemSettings: noop, setAsDefaultProtocolClient: noop,
    disableHardwareAcceleration: noop, setAppUserModelId: noop,
    getName: () => 'x', getAppPath: () => 'C:/tmp', show: noop,
  },
  BrowserWindow: function (opts) { const w = makeWin(opts); wins.push(w); return w },
  ipcMain: { on: (c, f) => { handlers[c] = f }, handle: (c, f) => { handlers[c] = f }, removeAllListeners: noop, removeHandler: noop },
  shell: { openExternal: noop, openPath: noop, showItemInFolder: noop },
  Tray: function () { return { setToolTip: noop, setImage: noop, setContextMenu: noop, on: noop, popUpContextMenu: noop, destroy: noop, isDestroyed: () => false } },
  Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop, getApplicationMenu: () => null },
  nativeImage: { createFromPath: () => img(), createFromBuffer: () => img(), createEmpty: () => img(), createFromDataURL: () => img() },
  nativeTheme: { on: noop, shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
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
  session: {
    defaultSession: { setPermissionRequestHandler: noop, setDisplayMediaRequestHandler: noop, webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop } },
    fromPartition: () => makePartitionSession(),
  },
  protocol: { registerSchemesAsPrivileged: noop, handle: noop, isProtocolHandled: () => false },
  powerMonitor: { on: noop },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: () => Promise.resolve(true) },
  desktopCapturer: { getSources: () => Promise.resolve([]) },
  clipboard: { readText: () => '', writeText: noop, readImage: () => ({ isEmpty: () => true }), writeImage: noop },
  net: { request: () => ({ on: noop, end: noop, write: noop }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('x' + s), decryptString: (b) => b.toString().slice(1) },
  webContents: { getAllWebContents: () => [] },
}

const origLoad = Module._load
Module._load = function (req) {
  if (req === 'electron') return electron
  return origLoad.apply(this, arguments)
}

const sandbox = {
  console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
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
  Buffer, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController, os,
  Promise, Date, Math, JSON, RegExp, Error, String, Number, Object, Array, Symbol,
  Map, Set, WeakMap, WeakSet, Reflect, Proxy, Intl, structuredClone,
}
sandbox.global = sandbox
sandbox.globalThis = sandbox
sandbox.module = {}
sandbox.exports = {}

let loadErr = null
try {
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'main.js'), 'utf8'), sandbox, { filename: 'main.js', timeout: 30000 })
} catch (e) {
  loadErr = e
  console.log('[载入失败]', e && e.name, ':', e && e.message)
}

let bad = 0
const assert = (cond, msg) => { if (!cond) bad++; console.log((cond ? 'PASS' : 'FAIL') + ' | ' + msg) }

removeSessionFile() // 确保初始无会话

if (!loadErr && handlers['email:open-window']) {
  const open = () => handlers['email:open-window']({ sender: { send: noop } })
  const emailWins = () => wins.filter(w => w._ctorOpts && w._ctorOpts.partition === 'persist:alimail')

  // ── 阶段 A：无会话文件 → 走登录入口 ──
  open()
  let w = emailWins()[0]
  assert(w, 'email:open-window 创建了 persist:alimail 分区窗口')
  if (w) {
    assert(w._calls.some(c => c === 'loadURL:https://qiye.aliyun.com/alimail/auth/login'),
      'A. 无会话时加载登录入口 https://qiye.aliyun.com/alimail/auth/login')
    assert(!!w._listeners['wc:will-navigate'], '已注册 will-navigate 白名单拦截')
    assert(!!w._listeners['wc:windowopen'], '已注册 setWindowOpenHandler')
    assert(!!w._listeners['close'], '已注册 close（隐藏）处理器')
    assert(!!w._listeners['hide'], '已注册 hide（落盘）处理器')

    const n0 = emailWins().length
    open()
    assert(emailWins().length === n0, '重复打开复用同一窗口，不重复创建')
    assert(w._calls.includes('show') || w._calls.includes('focus'), '重复打开走 show/focus 唤回')

    const ev1 = { prevented: false, preventDefault() { this.prevented = true } }
    w._listeners['close'](ev1)
    assert(ev1.prevented, 'A. 点击关闭时 preventDefault（不销毁）')
    assert(w._calls.includes('hide'), 'A. 点击关闭时 hide（保留会话）')

    if (appHandlers['before-quit']) {
      appHandlers['before-quit']()
      const ev2 = { prevented: false, preventDefault() { this.prevented = true } }
      w._listeners['close'](ev2)
      assert(!ev2.prevented, 'A. isQuitting 后允许真正关闭')
    } else {
      assert(false, 'A. app before-quit 处理器未注册')
    }
    // 模拟窗口销毁，使下次 open 创建新窗口
    w._listeners['closed']()
  }

  // ── 阶段 B：写入已登录会话文件 → 直接进邮箱主页 ──
  writeSessionFile([
    { name: 'alimail_sid', value: 'abc123', domain: '.qiye.aliyun.com', path: '/', secure: true, httpOnly: true },
    { name: 'at', value: 'tok', domain: '.aliyun.com', path: '/', secure: true },
  ])
  open()
  let w2 = emailWins()[emailWins().length - 1]
  assert(w2 && w2._calls.some(c => c === 'loadURL:https://qiye.aliyun.com/alimail/'),
    'B. 有会话时直接加载邮箱主页 https://qiye.aliyun.com/alimail/')
  if (w2) w2._listeners['closed']()

  // ── 阶段 C：删除会话文件 → 回到登录入口 ──
  removeSessionFile()
  open()
  let w3 = emailWins()[emailWins().length - 1]
  assert(w3 && w3._calls.some(c => c === 'loadURL:https://qiye.aliyun.com/alimail/auth/login'),
    'C. 会话文件移除后回退到登录入口')
  if (w3) w3._listeners['closed']()
} else {
  bad++
  console.log('FAIL | main.js 载入失败或 email:open-window 未注册')
}

removeSessionFile()
console.log(bad === 0 ? '\n通过：邮箱窗口行为全部符合预期' : '\n存在问题：' + bad + ' 项失败')
process.exit(bad === 0 ? 0 : 1)
