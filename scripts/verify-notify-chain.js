// scripts/verify-notify-chain.js
// ─────────────────────────────────────────────────────────────────────────────
// 端到端链路探针：模拟「主窗口网页端 WS 发 SHOW_MESSAGE_NOTIFICATION」，
// 断言通知中心窗口真的被 show、且收到带 unread 的 nc-state。
//
// 目的：定位「完全没有消息提示」这类问题。它跨越 main.js 的 WS 分发 →
// notificationCenter 控制器 → 渲染层协议，比单独看某一段更能反映真实行为。
//
// 用法：node scripts/verify-notify-chain.js
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const os = require('os')
const Module = require('module')

const noop = () => {}
const USER_DATA = path.join(os.tmpdir(), 'mylog-nc-chain-test')

// ── BrowserWindow 桩：记录 send / showInactive / loadFile ──
const winRecs = []
function makeWin() {
  const rec = { sends: [], shown: 0, hidden: 0, loaded: '', bounds: null }
  const wc = {
    _url: 'about:blank',
    getURL() { return this._url },
    on: noop, once: noop,
    send(ch, data) { rec.sends.push([ch, data]) },
    stop: noop,
    executeJavaScript: () => Promise.resolve(),
    setWindowOpenHandler: noop,
    session: { setDisplayMediaRequestHandler: noop, setPermissionRequestHandler: noop },
  }
  const w = {
    webContents: wc,
    id: winRecs.length + 1,
    isDestroyed: () => false,
    isVisible: () => rec.shown > rec.hidden,
    isMinimized: () => false,
    isFocused: () => false,
    show() { rec.shown++ },
    showInactive() { rec.shown++ },
    hide() { rec.hidden++ },
    focus: noop, restore: noop, moveTop: noop,
    loadURL: (u) => { wc._url = u; rec.loaded = u },
    loadFile: (p) => { rec.loaded = p },
    setBounds: (b) => { rec.bounds = b },
    setAlwaysOnTop: noop, setSkipTaskbar: noop, setMenu: noop, setTitle: noop,
    getBounds: () => rec.bounds || { x: 0, y: 0, width: 360, height: 520 },
    setProgressBar: noop, setClosable: noop, setResizable: noop,
    on: noop, once: noop, removeAllListeners: noop,
  }
  winRecs.push(rec)
  return new Proxy(w, {
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

const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }

const electron = {
  app: {
    getPath: (n) => (n === 'userData' ? USER_DATA : os.tmpdir()),
    setPath: noop,
    whenReady: () => Promise.resolve(),
    on: noop, getVersion: () => '1.0.0', isPackaged: false,
    requestSingleInstanceLock: () => true, quit: noop,
    commandLine: { appendSwitch: noop, hasSwitch: () => false, getSwitchValue: () => '' },
    getLoginItemSettings: () => ({}), setLoginItemSettings: noop, setAsDefaultProtocolClient: noop,
    disableHardwareAcceleration: noop, setAppUserModelId: noop, setName: noop,
    getName: () => 'x', getAppPath: () => process.cwd(), show: noop,
    on: noop, whenReady_: noop,
  },
  BrowserWindow: function () { return makeWin() },
  ipcMain: { on: noop, handle: noop, removeAllListeners: noop, removeHandler: noop },
  shell: { openExternal: noop, openPath: noop, showItemInFolder: noop },
  Tray: function () { return { setToolTip: noop, setImage: noop, setContextMenu: noop, on: noop, popUpContextMenu: noop, destroy: noop, isDestroyed: () => false } },
  Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop, getApplicationMenu: () => null },
  nativeImage: { createFromPath: () => img(), createFromBuffer: () => img(), createEmpty: () => img(), createFromDataURL: () => img() },
  nativeTheme: { on: noop, shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => display,
    getAllDisplays: () => [display],
    getDisplayNearestPoint: () => display,
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
  session: { defaultSession: { setPermissionRequestHandler: noop, setDisplayMediaRequestHandler: noop, setUserAgent: noop, webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop } } },
  protocol: { registerSchemesAsPrivileged: noop, handle: noop, isProtocolHandled: () => false },
  powerMonitor: { on: noop },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: () => Promise.resolve(true) },
  desktopCapturer: { getSources: () => Promise.resolve([]) },
  clipboard: { readText: () => '', writeText: noop, readImage: () => ({ isEmpty: () => true }), writeImage: noop },
  net: { request: () => ({ on: noop, end: noop, write: noop }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  webContents: { getAllWebContents: () => [] },
}

// ── WS 桩：捕获 connection 回调 ──
let onConnection = null
class FakeWSS {
  constructor() {}
  on(ev, fn) { if (ev === 'connection') onConnection = fn }
  close() {}
}

const origLoad = Module._load
Module._load = function (req) {
  if (req === 'electron') return electron
  if (req === 'ws') return { WebSocketServer: FakeWSS }
  return origLoad.apply(this, arguments)
}

const logs = []
const sandbox = {
  console: { log: (...a) => logs.push(a.join(' ')), warn: noop, error: (...a) => logs.push('[err] ' + a.join(' ')), info: noop, debug: noop },
  require: (m) => {
    if (m === 'electron') return electron
    if (m === 'ws') return { WebSocketServer: FakeWSS }
    if (m.startsWith('.')) return Module._load(path.resolve(process.cwd(), m), module, false)
    return Module._load(m, module, false)
  },
  process: {
    platform: 'win32', env: {}, argv: [], execPath: 'x', version: 'v20', versions: {},
    nextTick: (f) => f(), on: noop, cwd: () => process.cwd(), resourcesPath: os.tmpdir(), type: 'browser',
  },
  __dirname: process.cwd(),
  __filename: path.join(process.cwd(), 'main.js'),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, setImmediate,
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
  console.log((e && e.stack || '').split('\n').slice(0, 8).join('\n'))
}

let bad = 0, total = 0
const ok = (name, cond, extra) => {
  total++
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  if (loadErr) {
    console.log('\n载入失败，链路无法验证')
    process.exit(1)
  }
  ok('B1 main.js 载入成功', true)

  // whenReady() 的 then 回调在微任务里执行 —— 让出一次事件循环
  await wait(50)
  ok('B2 WS 服务已启动并注册 connection 回调', typeof onConnection === 'function',
    'onConnection=' + typeof onConnection)

  // 通知中心窗口应已在 app.whenReady 中 preCreate
  const ncRec = winRecs.find((r) => String(r.loaded).indexOf('notification-center.html') >= 0)
  ok('B3 通知中心窗口已预创建', !!ncRec, ncRec ? ncRec.loaded : '未找到 loadFile notification-center.html')

  if (!onConnection) { console.log('\n无法继续'); process.exit(1) }

  // ── 模拟主窗口连接（UA 带 MylogDesktop 标记 → isAppWindow=true）──
  const listeners = {}
  const fakeWs = {
    readyState: 1,
    send: noop,
    on(ev, fn) { listeners[ev] = fn },
    close: noop,
  }
  onConnection(fakeWs, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) MylogDesktop/1.0' } })
  fakeWs.send = () => {}

  // REGISTER（网页端登录后必发）
  listeners.message(JSON.stringify({
    type: 'REGISTER',
    payload: { userId: 'u1', userName: '测试', userIcon: '', browserType: 'web' },
  }))

  // 真实新消息
  listeners.message(JSON.stringify({
    type: 'SHOW_MESSAGE_NOTIFICATION',
    payload: {
      conversationId: 'conv_a',
      senderId: 'u2',
      senderName: '张三',
      senderAvatar: '',
      content: '你好',
      unreadCount: 1,
      url: 'https://data.tygps.com/mylog-pc/message?conv=conv_a',
    },
  }))

  // arming 150ms + measure 兜底 200ms
  await wait(600)

  const stateSends = (ncRec ? ncRec.sends : []).filter((s) => s[0] === 'nc-state')
  const lastState = stateSends.length ? stateSends[stateSends.length - 1][1] : null

  ok('B4 通知中心收到 nc-state', stateSends.length > 0, 'count=' + stateSends.length)
  ok('B5 nc-state 里有 1 个未读会话',
    !!(lastState && Array.isArray(lastState.unread) && lastState.unread.length === 1),
    lastState ? 'unread=' + JSON.stringify((lastState.unread || []).map((u) => u.conversationId)) : 'no state')
  ok('B6 窗口被 show（showInactive）', !!(ncRec && ncRec.shown > 0), 'shown=' + (ncRec ? ncRec.shown : 'n/a'))
  ok('B7 主进程要求渲染层测量高度', !!(ncRec && ncRec.sends.some((s) => s[0] === 'nc-measure')))

  // 诊断输出：链路卡在哪一环
  const ncLogs = logs.filter((l) => l.indexOf('[NC]') >= 0 || l.indexOf('[WS]') >= 0 || l.indexOf('[Dedup]') >= 0)
  if (ncLogs.length) {
    console.log('\n── 关键日志 ──')
    ncLogs.slice(-10).forEach((l) => console.log('  ' + l))
  }
  if (!ncRec || ncRec.shown === 0) {
    const errs = logs.filter((l) => l.indexOf('[err]') >= 0)
    if (errs.length) {
      console.log('\n── 异常 ──')
      errs.slice(-8).forEach((l) => console.log('  ' + l))
    }
  }

  console.log('\n═══ 链路校验 ═══')
  console.log('通过 ' + (total - bad) + ' / ' + total)
  console.log(bad ? '结果：FAIL' : '结果：PASS')
  process.exit(bad ? 1 : 0)
})()
