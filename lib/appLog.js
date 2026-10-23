// lib/appLog.js
// ─────────────────────────────────────────────────────────────────────────────
// 轻量落盘日志：把关键前缀的 console 输出同时写进 userData/logs/notify-YYYY-MM-DD.log
//
// 为什么需要它：桌面端打包后没有可见的 stdout，「完全没提醒」这类问题
// 只能在用户机器上复现，必须让日志留在磁盘上，否则只能靠猜。
//
// 设计约束：
//   - 零侵入：不改造已有的 console.log 调用点，只按前缀过滤（[NC] / [WS] / [Dedup] …）
//   - 不阻塞主进程：createWriteStream 追加写，异常一律吞掉（日志不能反过来搞崩应用）
//   - 有界：按天分文件；单文件超 5MB 轮转
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs')
const path = require('path')

let stream = null
let filePath = ''
let dirPath = ''
let patched = false

// 需要落盘的前缀（其余日志太吵，不写）
const KEEP_RE = /^\[(NC|NCR|WS|Dedup|Log|Notify|Tray|TrayMenu|Menu)\]|^\[error\]|^\[warn\]/

function pad(n) { return ('0' + n).slice(-2) }

function stamp() {
  const d = new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    '.' + ('00' + d.getMilliseconds()).slice(-3)
}

function fmt(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  try { return JSON.stringify(v) } catch (e) { return String(v) }
}

function write(line) {
  if (!stream) return
  try { stream.write(stamp() + ' ' + line + '\n') } catch (e) {}
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(filePath)
    if (st.size > 5 * 1024 * 1024) {
      stream.end()
      fs.renameSync(filePath, filePath.replace(/\.log$/, '.' + Date.now() + '.log'))
      stream = fs.createWriteStream(filePath, { flags: 'a' })
    }
  } catch (e) {}
}

/**
 * 初始化。必须在 app ready 前后尽早调用（getPath('userData') 在 ready 前已可用）。
 * @param {string} userDataDir
 */
function init(userDataDir) {
  try {
    dirPath = path.join(userDataDir, 'logs')
    fs.mkdirSync(dirPath, { recursive: true })
    const d = new Date()
    const name = 'notify-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.log'
    filePath = path.join(dirPath, name)
    rotateIfNeeded()
    stream = fs.createWriteStream(filePath, { flags: 'a' })
    stream.on('error', () => { stream = null })
    write('=== session start pid=' + process.pid + ' ===')
  } catch (e) {
    stream = null
  }
  return { file: filePath, dir: dirPath }
}

/** 劫持 console.log/warn/error：原始行为保留，额外落盘。重复调用无副作用。 */
function patchConsole() {
  if (patched) return
  patched = true

  const origLog = console.log.bind(console)
  console.log = function () {
    origLog.apply(null, arguments)
    const s = Array.prototype.map.call(arguments, fmt).join(' ')
    if (KEEP_RE.test(s)) write(s)
  }

  const origWarn = console.warn.bind(console)
  console.warn = function () {
    origWarn.apply(null, arguments)
    write('[warn] ' + Array.prototype.map.call(arguments, fmt).join(' '))
  }

  const origErr = console.error.bind(console)
  console.error = function () {
    origErr.apply(null, arguments)
    write('[error] ' + Array.prototype.map.call(arguments, fmt).join(' '))
  }
}

/** 主进程主动写一行（不受前缀过滤） */
function log(tag, msg) {
  const s = '[' + tag + '] ' + (typeof msg === 'string' ? msg : fmt(msg))
  console.log(s)
}

function getFile() { return filePath }
function getDir() { return dirPath }
function close() { try { if (stream) stream.end() } catch (e) {} stream = null }

module.exports = { init, patchConsole, log, getFile, getDir, close }
