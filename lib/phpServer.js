'use strict'
/**
 * phpServer.js —— e日志桌面端内置 PHP 服务托管
 *
 * 作用：把随包分发的便携版 PHP 作为子进程拉起，用于承载 SnappyMail 邮箱界面。
 * 设计要点：
 *  - 只监听 127.0.0.1（回环），不对外暴露；
 *  - 端口动态分配（避免与用户机器上的既有服务冲突）；
 *  - 懒启动：只有用户打开「邮箱」窗口时才拉起；
 *  - 带健康检查与失败重试；退出应用时彻底清理，不残留进程。
 *
 * 依赖的外部组件（均为免费开源，随包分发）：
 *  - PHP            PHP License v3.01
 *  - SnappyMail     AGPL-3.0
 */

const { spawn } = require('child_process')
const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')

let child = null
let currentPort = 0
let startingPromise = null
let lastError = ''
let logStream = null

// ─── 路径解析（开发态 vs 打包态）──────────────────────────────

// 开发态：<项目>/vendor ；打包态：<resources>/vendor（见 package.json 的 extraResources）
function vendorRoot() {
  const dev = path.join(__dirname, '..', 'vendor')
  if (fs.existsSync(path.join(dev, 'php'))) return dev
  if (process.resourcesPath) return path.join(process.resourcesPath, 'vendor')
  return dev
}

function phpBin() {
  const name = process.platform === 'win32' ? 'php.exe' : 'php'
  return path.join(vendorRoot(), 'php', name)
}

function phpIni() { return path.join(vendorRoot(), 'php', 'php.ini') }
function routerFile() { return path.join(vendorRoot(), 'php', 'router.php') }
function appRoot() { return path.join(vendorRoot(), 'snappymail') }

// SnappyMail 的数据目录必须可写；安装目录（Program Files）通常只读，
// 因此统一放到 Electron 的 userData 下。
// 允许用 MYLOG_EMAIL_DATA_DIR 覆盖（仅供自动化测试与排障，正常运行时不要设）。
function dataDir() {
  const override = process.env.MYLOG_EMAIL_DATA_DIR
  if (override) {
    try { fs.mkdirSync(override, { recursive: true }) } catch (e) {}
    return override
  }
  const { app } = require('electron')
  const d = path.join(app.getPath('userData'), 'email', 'snappymail-data')
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
  return d
}

function logFile() {
  try {
    const { app } = require('electron')
    const dir = path.join(app.getPath('userData'), 'email')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'php-server.log')
  } catch (e) { return null }
}

function writeLog(msg) {
  try {
    if (!logStream) {
      const f = logFile()
      if (!f) return
      logStream = fs.createWriteStream(f, { flags: 'a' })
    }
    logStream.write('[' + new Date().toISOString() + '] ' + msg + '\n')
  } catch (e) {}
}

// ─── 工具 ────────────────────────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: timeoutMs || 3000 },
      (res) => {
        let n = 0
        res.on('data', (c) => { n += c.length })
        res.on('end', () => resolve(res.statusCode === 200 && n > 500))
        res.on('error', () => resolve(false))
      }
    )
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ─── 运行期数据准备（幂等）──────────────────────────────────────
//
// SnappyMail 首次请求时会自动「安装」：在数据目录里建 _data_/_default_/，
// 并从它自带的 app/domains/ 拷贝一份域名配置。而那份配置指向 localhost，
// 直接跑会「无法连接至服务器」。
//
// 所以在拉起 PHP 之前，先在这里把数据目录准备好（每次都跑，幂等）：
//   1. 同步「邮箱类型」插件 mylog-provider（每次覆盖，保证是最新版）；
//   2. 预置域名配置 default.json（阿里企业邮箱）与 disabled（清空），
//      并阻止安装流程用内置的 localhost 配置覆盖；
//   3. 确保 application.ini 里插件是开启的。
//
// 这些操作都不动 SnappyMail 的源码，只准备它自己的数据目录。

const PLUGIN_NAME = 'mylog-provider'

// 随包分发的数据模板（已在仓库里配置好域名与插件开关）
function dataTemplateRoot() {
  return path.join(vendorRoot(), 'snappymail', 'data', '_data_', '_default_')
}

function privateDataRoot() {
  return path.join(dataDir(), '_data_', '_default_')
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirSync(s, d)
    else if (entry.isFile()) fs.copyFileSync(s, d)
  }
}

// 只在缺失时拷贝，不覆盖已有数据（保护用户配置与会话）
function ensureFile(file, source) {
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(source, file)
  return true
}

// 保证 application.ini 里 [plugins] enable = On 且只启用我们的插件
function ensurePluginsEnabled(iniFile) {
  let text = fs.readFileSync(iniFile, 'utf8')
  const re = /(\[plugins\])([\s\S]*?)(?=\n\s*\[|$)/
  const listLine = 'enabled_list = "' + PLUGIN_NAME + '"'
  if (!re.test(text)) {
    text = text.replace(/\s*$/, '') + '\n\n[plugins]\nenable = On\n' + listLine + '\n'
  } else {
    text = text.replace(re, (all, head, body) => {
      let b = body
      if (/^\s*enable\s*=/m.test(b)) b = b.replace(/^\s*enable\s*=.*$/m, 'enable = On')
      else b = '\nenable = On' + b
      if (/^\s*enabled_list\s*=/m.test(b)) b = b.replace(/^\s*enabled_list\s*=.*$/m, listLine)
      else b = b.replace(/\s*$/, '') + '\n' + listLine + '\n'
      return head + b
    })
  }
  if (text !== fs.readFileSync(iniFile, 'utf8')) fs.writeFileSync(iniFile, text)
}

// 【e日志】强制品牌与默认设置（幂等，每次启动校验）
// 避免依赖后台手动配置：标题去掉 SnappyMail、首屏文案设为「e日志邮箱加载中」、
// 默认开启会话(线程)视图，让 e日志邮箱 开箱即合规。
function setIniValue(text, section, key, value) {
  const lines = text.split('\n')
  let inSection = false
  let keySet = false
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[(.+?)\]\s*$/)
    if (m) { inSection = (m[1] === section); continue }
    if (inSection && new RegExp('^\\s*' + key + '\\s*=').test(lines[i])) {
      lines[i] = key + ' = ' + value
      keySet = true
    }
  }
  if (!keySet) {
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp('^\\[' + section + '\\]\\s*$').test(lines[i])) {
        lines.splice(i + 1, 0, key + ' = ' + value)
        keySet = true
        break
      }
    }
    if (!keySet) lines.push('', '[' + section + ']', key + ' = ' + value)
  }
  return lines.join('\n')
}

function ensureBranding(iniFile) {
  let text = fs.readFileSync(iniFile, 'utf8')
  const orig = text
  text = setIniValue(text, 'webmail', 'title', '"e日志邮箱"')
  text = setIniValue(text, 'webmail', 'loading_description', '"e日志邮箱加载中"')
  if (text !== orig) {
    fs.writeFileSync(iniFile, text)
    writeLog('branding/defaults enforced in application.ini')
  }
}

function prepareRuntime() {
  const tpl = dataTemplateRoot()
  const priv = privateDataRoot()
  if (!fs.existsSync(tpl)) {
    writeLog('data template missing: ' + tpl)
    return
  }

  // 1) 目录骨架 + 插件本体（每次覆盖，保证插件随时是最新版）
  for (const sub of ['configs', 'domains', 'plugins', 'storage', 'cache']) {
    fs.mkdirSync(path.join(priv, sub), { recursive: true })
  }
  const pluginSrc = path.join(vendorRoot(), 'snappymail', 'plugins', PLUGIN_NAME)
  if (fs.existsSync(pluginSrc)) {
    copyDirSync(pluginSrc, path.join(priv, 'plugins', PLUGIN_NAME))
  } else {
    writeLog('plugin source missing: ' + pluginSrc)
  }

  // 2) 域名配置
  const disabledFile = path.join(priv, 'domains', 'disabled')
  const defaultJson = path.join(priv, 'domains', 'default.json')
  const tplDisabled = path.join(tpl, 'domains', 'disabled')
  const tplDefault = path.join(tpl, 'domains', 'default.json')

  // disabled 每次覆盖：原版会在这里禁用 gmail/qq/outlook 等，桌面端需要放开
  if (fs.existsSync(tplDisabled)) fs.copyFileSync(tplDisabled, disabledFile)

  // default.json：缺失时补齐；若收信主机被安装流程重置回 localhost，也改回来
  // 注意只检查 IMAP.host —— Sieve 段里本来就有个未启用的 localhost，不能据此判定
  let needDefault = !fs.existsSync(defaultJson)
  if (!needDefault && fs.existsSync(tplDefault)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(defaultJson, 'utf8'))
      if (!cfg || !cfg.IMAP || !cfg.IMAP.host || /localhost/i.test(String(cfg.IMAP.host))) {
        needDefault = true
      }
    } catch (e) {
      needDefault = true // 内容坏了也重写
    }
  }
  if (needDefault && fs.existsSync(tplDefault)) {
    fs.copyFileSync(tplDefault, defaultJson)
    writeLog('default.json prepared: ' + defaultJson)
  }

  // 3) 插件开关
  const iniFile = path.join(priv, 'configs', 'application.ini')
  const tplIni = path.join(tpl, 'configs', 'application.ini')
  ensureFile(iniFile, tplIni)
  if (fs.existsSync(iniFile)) {
    ensurePluginsEnabled(iniFile)
    ensureBranding(iniFile)
  }
}

// ─── 生命周期 ─────────────────────────────────────────────────

function isRunning() {
  return !!(child && !child.killed && child.exitCode === null)
}

async function start() {
  if (isRunning()) {
    if (await probe(currentPort, 2500)) return { ok: true, port: currentPort }
    // 进程还在但已无响应 → 先清理再重启
    stop()
  }

  // 数据目录 / 域名配置 / 插件开关的准备（幂等，失败不影响启动）
  try { prepareRuntime() } catch (e) { writeLog('prepareRuntime failed: ' + (e && e.message)) }

  const bin = phpBin()
  const app = appRoot()
  if (!fs.existsSync(bin)) {
    lastError = '未找到内置 PHP 运行时：' + bin
    writeLog(lastError)
    return { ok: false, error: lastError }
  }
  if (!fs.existsSync(path.join(app, 'index.php'))) {
    lastError = '未找到内置邮箱组件（SnappyMail）：' + app
    writeLog(lastError)
    return { ok: false, error: lastError }
  }

  currentPort = await findFreePort()
  const args = [
    '-c', phpIni(),
    '-d', 'variables_order=EGPCS', // 让 PHP 能读到 getenv()
    '-S', '127.0.0.1:' + currentPort,
    '-t', app,
    routerFile(),
  ]

  writeLog('starting php: ' + bin + ' ' + args.join(' ') + ' | cwd=' + vendorRoot())

  child = spawn(bin, args, {
    cwd: vendorRoot(),
    windowsHide: true,
    env: Object.assign({}, process.env, {
      MYLOG_EMAIL_DATA: dataDir(),
      // 避免 PHP 自身的 HTTP 请求被系统代理拦截
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost',
    }),
  })

  child.stdout.on('data', (d) => writeLog('[php] ' + String(d).trim()))
  child.stderr.on('data', (d) => writeLog('[php:err] ' + String(d).trim()))
  child.on('exit', (code, sig) => {
    writeLog('php exited code=' + code + ' signal=' + sig)
    child = null
  })
  child.on('error', (e) => {
    lastError = 'PHP 启动失败：' + (e && e.message)
    writeLog(lastError)
    child = null
  })

  // 最长等 25 秒（首次运行 SnappyMail 需要初始化数据目录）
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (!isRunning()) break
    if (await probe(currentPort, 2000)) {
      writeLog('php ready on port ' + currentPort)
      return { ok: true, port: currentPort }
    }
    await sleep(400)
  }

  lastError = lastError || ('邮箱服务启动超时（端口 ' + currentPort + ' 无响应）')
  writeLog(lastError)
  stop()
  return { ok: false, error: lastError }
}

// 幂等启动：并发调用共用同一个启动 Promise
function ensureStarted() {
  if (isRunning() && startingPromise === null) {
    return probe(currentPort, 2500).then((ok) =>
      ok ? { ok: true, port: currentPort } : start()
    )
  }
  if (startingPromise) return startingPromise
  startingPromise = start().finally(() => { startingPromise = null })
  return startingPromise
}

function stop() {
  const c = child
  child = null
  currentPort = 0
  if (!c) return
  try { c.kill() } catch (e) {}
  // Windows 下 php.exe 由 -S 直接承载，kill() 即可；再兜底一次强杀
  if (process.platform === 'win32' && c.pid) {
    try {
      spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
    } catch (e) {}
  }
}

function status() {
  return { running: isRunning(), port: currentPort, error: lastError }
}

module.exports = { ensureStarted, start, stop, status, dataDir, vendorRoot, appRoot, prepareRuntime }
