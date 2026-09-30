#!/usr/bin/env node
/**
 * 主进程作用域 / IPC 通道校验器
 *
 * 为什么需要它：
 *   Electron 主进程 main.js 是一个巨型单文件（3000+ 行）。一旦某个函数**少写一个闭合 `}`**，
 *   后续整段代码会被"吞"进那个函数体，而文件本身**语法依然合法** —— `node --check` 全绿、
 *   启动也不报错。结果是：这些代码从不执行，且没有任何报错线索。
 *
 *   真实事故（2026-09-29）：quitApp() 丢了收尾 `}` → 从 boardLog 到全部
 *   `ipcMain.on('board-overlay:*')` 共 340 行被卷进 quitApp() 体内 → 所有画板 IPC
 *   从未注册，网页发的指令全部石沉大海。唯一的外部症状只是托盘菜单点一下报
 *   `ReferenceError: safeOpenBoardOverlay is not defined`，排查代价极高。
 *
 * 检查项：
 *   A. 【错误】main.js 中「字面量通道名」的 ipcMain.on/handle 必须注册在顶层。
 *      嵌套在函数里 = 永不执行（main.js 是单文件巨兽，专治这类事故）。
 *      lib/*.js 允许嵌套（模块式注册），但必须被 main.js require（见 F）。
 *   B. 【错误】main.js 中关键函数必须声明在顶层。
 *   C. 【错误】关键 IPC 通道必须有注册。
 *   D. 【错误】preload.js 用 ipcRenderer.send/invoke 发出的通道，必须在主进程侧有注册
 *      —— 否则渲染层的指令会石沉大海（这是画板事故的另一半）。
 *   E. 【错误】preload.js 经 contextBridge 暴露的画板 API 必须齐全。
 *   F. 【错误】含 ipcMain 注册的 lib 模块必须被 main.js 引入（防"模块写完没接线"）。
 *
 * 用法：node scripts/check-scope.js        （退出码 0 = 通过，1 = 有问题）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MAIN = path.join(ROOT, 'main.js')
const PRELOAD = path.join(ROOT, 'src', 'preload.js')
const LIB_DIR = path.join(ROOT, 'lib')

/** typescript 仅用于解析，本包未装则回退到同级 web 工程（同仓工作区） */
function loadTs() {
  const candidates = [
    'typescript',
    path.resolve(ROOT, '..', 'web', 'node_modules', 'typescript'),
    path.resolve(ROOT, 'node_modules', 'typescript'),
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch (e) {
      /* 尝试下一个 */
    }
  }
  console.error('[check-scope] 找不到 typescript 依赖，无法解析 AST。')
  console.error('  可在 desktop-notifier 下执行 npm i -D typescript，或确保同级 web 工程已安装。')
  process.exit(2)
}

const ts = loadTs()

/** main.js 中必须处于顶层的函数（被托盘菜单 / IPC / 其他模块直接引用） */
const REQUIRED_TOP_LEVEL_FUNCS = [
  'quitApp',
  'updateTrayMenu',
  'injectScreenShareShim',
  'setupScreenShare',
  'pickScreenShareSource',
  'handleWillDownload',
  // 画板覆盖窗
  'boardLog',
  'currentShareSource',
  'resolveBoardOverlayBounds',
  'openBoardOverlay',
  'closeBoardOverlay',
  'toggleBoardOverlay',
  'safeOpenBoardOverlay',
]

/** 必须有 ipcMain 注册的通道（画板链路 + 主链路） */
const REQUIRED_IPC_CHANNELS = [
  'call-action',
  'meeting-action',
  'titlebar:win',
  'titlebar:drag',
  'titlebar:menu',
  'titlebar:quick-action',
  'board-overlay:toggle',
  'board-overlay:open',
  'board-overlay:close',
  'board-overlay:open-if-sharing',
  'board-overlay:share-started',
  'board-overlay:local-stroke',
  'board-overlay:sync',
  'board-overlay:undo',
]

/** preload 必须经 contextBridge 暴露的画板 API */
const REQUIRED_PRELOAD_APIS = [
  'boardOverlayToggle',
  'boardOverlayOpen',
  'boardOverlayOpenIfSharing',
  'boardOverlayClose',
  'boardOverlayPushState',
  'boardOverlaySendStroke',
  'boardOverlayUndo',
  'notifyScreenShareStarted',
  'onBoardOverlayState',
  'onBoardOverlayRemoteStroke',
  'onBoardOverlayClosed',
  'onBoardOverlayUnsupported',
  'onBoardOverlayUndo',
  'onBoardOverlaySelfScreenShare',
]

/**
 * 已知的无处理器通道：渲染层仍在发，但主进程侧没有任何注册。
 * 均为历史遗留（对应页面已不再加载），非本轮画板问题。
 */
const IGNORED_CHANNELS = new Set([
  'close-toast', // toast-window.html 已无任何地方 loadFile，属遗留页面
])

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  return { text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS) }
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function describeFn(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  return '(anonymous)'
}

/** 收集某文件里的 ipcMain 注册 */
function collectIpcMain(relPath) {
  const { sf } = parseFile(path.join(ROOT, relPath))
  const topLevel = new Map() // channel -> line
  const nested = [] // {channel, line, chain}
  const anyDepth = new Map() // channel -> line（含嵌套，用于跨文件通道校验）
  const dynamic = [] // {line, chain, text}
  const outbound = new Set() // main -> renderer 的通道（webContents.send）

  function walk(node, chain) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf)

      if (/^ipcMain\.(on|handle|once|handleOnce)$/.test(callee)) {
        const a0 = node.arguments[0]
        const line = lineOf(sf, node)
        if (a0 && ts.isStringLiteral(a0)) {
          if (!anyDepth.has(a0.text)) anyDepth.set(a0.text, line)
          if (chain.length === 0) {
            if (!topLevel.has(a0.text)) topLevel.set(a0.text, line)
          } else {
            nested.push({ channel: a0.text, line, chain: chain.join(' > ') })
          }
        } else {
          dynamic.push({ line, chain: chain.join(' > '), text: a0 ? a0.getText(sf) : '(none)' })
        }
      }

      if (/\.webContents\.send$/.test(callee)) {
        const a0 = node.arguments[0]
        if (a0 && ts.isStringLiteral(a0)) outbound.add(a0.text)
      }
    }

    if (isFunctionLike(node)) {
      ts.forEachChild(node, (c) => walk(c, chain.concat(describeFn(node))))
      return
    }
    ts.forEachChild(node, (c) => walk(c, chain))
  }

  walk(sf, [])
  return { relPath, topLevel, nested, anyDepth, dynamic, outbound }
}

function collectTopLevelFuncs(relPath) {
  const { sf } = parseFile(path.join(ROOT, relPath))
  const set = new Set()
  ts.forEachChild(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) set.add(n.name.text)
  })
  return set
}

/** 收集 preload 里的通道用法与 contextBridge 暴露的 key */
function collectPreload() {
  const { sf } = parseFile(PRELOAD)
  const sends = new Map() // channel -> line（ipcRenderer.send/invoke）
  const listens = new Map() // channel -> line（ipcRenderer.on/once）
  const exposed = new Set()

  function walk(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf)
      const a0 = node.arguments[0]
      const isCh = a0 && ts.isStringLiteral(a0)

      if (/^ipcRenderer\.(send|sendSync|invoke)$/.test(callee) && isCh) {
        if (!sends.has(a0.text)) sends.set(a0.text, lineOf(sf, node))
      }
      if (/^ipcRenderer\.(on|once|addListener)$/.test(callee) && isCh) {
        if (!listens.has(a0.text)) listens.set(a0.text, lineOf(sf, node))
      }
      if (/^contextBridge\.exposeInMainWorld$/.test(callee)) {
        const obj = node.arguments[1]
        if (obj && ts.isObjectLiteralExpression(obj)) {
          for (const p of obj.properties) {
            if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
              exposed.add(p.name.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk)
  }

  walk(sf)
  return { sends, listens, exposed }
}

function listLibModules() {
  if (!fs.existsSync(LIB_DIR)) return []
  return fs
    .readdirSync(LIB_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.posix.join('lib', f))
}

function main() {
  const problems = []
  const notes = []

  const mainIpc = collectIpcMain('main.js')
  const topFuncs = collectTopLevelFuncs('main.js')
  const pre = collectPreload()

  // lib 模块（模块式 IPC 注册，允许嵌套但必须被 main.js 引入）
  const libMods = listLibModules().map((m) => collectIpcMain(m))
  const libWithIpc = libMods.filter((m) => m.anyDepth.size > 0)
  const anyRegistered = new Map(mainIpc.anyDepth)
  for (const m of libWithIpc) {
    for (const [ch, line] of m.anyDepth) if (!anyRegistered.has(ch)) anyRegistered.set(ch, line)
  }

  // ── A. main.js 里被包进函数的 ipcMain 注册 ──
  for (const n of mainIpc.nested) {
    problems.push(
      `main.js:${n.line}  ipcMain 注册 "${n.channel}" 被包在函数里（${n.chain}）→ 永远不会执行`
    )
  }

  // ── B. 关键函数必须在 main.js 顶层 ──
  for (const fn of REQUIRED_TOP_LEVEL_FUNCS) {
    if (!topFuncs.has(fn)) {
      problems.push(`main.js  关键函数 ${fn}() 不在顶层作用域（可能被上一个大括号"吞"进别的函数体）`)
    }
  }

  // ── C. 关键通道必须有注册 ──
  for (const ch of REQUIRED_IPC_CHANNELS) {
    if (anyRegistered.has(ch)) continue
    const nestedHit = mainIpc.nested.find((n) => n.channel === ch)
    problems.push(
      `main.js  通道 "${ch}" 没有任何 ipcMain 注册` +
        (nestedHit ? `（第 ${nestedHit.line} 行的注册被包在 ${nestedHit.chain} 里）` : '')
    )
  }

  // ── D. preload 发出的通道必须有注册 ──
  for (const [ch, line] of pre.sends) {
    if (anyRegistered.has(ch) || IGNORED_CHANNELS.has(ch)) continue
    problems.push(
      `preload.js:${line} 发送通道 "${ch}" 在主进程侧找不到 ipcMain 注册（该指令会石沉大海）`
    )
  }

  // ── E. 画板 API 必须暴露 ──
  for (const api of REQUIRED_PRELOAD_APIS) {
    if (!pre.exposed.has(api)) problems.push(`preload.js  contextBridge 未暴露画板 API: ${api}`)
  }

  // ── F. 含 IPC 的 lib 模块必须被 main.js 引入 ──
  const mainText = fs.readFileSync(MAIN, 'utf8')
  for (const m of libWithIpc) {
    const base = path.basename(m.relPath, '.js')
    const required = new RegExp(`require\\(\\s*['"\`][^'"\`]*${base}['"\`]\\s*\\)`).test(mainText)
    if (!required) {
      problems.push(`main.js  未引入 ${m.relPath}（该模块含 ${m.anyDepth.size} 个 IPC 注册，不引入即全部失效）`)
    }
  }

  // 参考信息
  const notListened = [...mainIpc.outbound].filter((c) => !pre.listens.has(c))
  if (notListened.length) {
    notes.push(
      `main.js 向渲染层发送但 preload 未监听的通道（可能由其他窗口 preload 处理）：${notListened.join(', ')}`
    )
  }
  if (mainIpc.dynamic.length) {
    notes.push(
      `动态通道注册 ${mainIpc.dynamic.length} 处（跳过校验）：` +
        mainIpc.dynamic.map((d) => `L${d.line}(${d.text})`).join(', ')
    )
  }
  const libNested = libWithIpc.reduce((s, m) => s + m.nested.length, 0)
  if (libNested) {
    notes.push(`lib 模块内嵌 IPC 注册 ${libNested} 处（模块式注册，已在 F 中校验其被引入）`)
  }

  console.log(
    `[check-scope] main.js 顶层 IPC ${mainIpc.topLevel.size} / 顶层函数 ${topFuncs.size}` +
      ` | lib 含 IPC 模块 ${libWithIpc.length} | preload 发送 ${pre.sends.size} / 监听 ${pre.listens.size} / 暴露 API ${pre.exposed.size}`
  )
  for (const n of notes) console.log('  ℹ ' + n)

  if (problems.length) {
    console.error(`\n[check-scope] 发现 ${problems.length} 个问题：`)
    for (const p of problems) console.error('  ✗ ' + p)
    process.exit(1)
  }

  console.log('[check-scope] 通过：作用域与 IPC 通道均正常')
}

main()
