// lib/emailClient.js
// 收件引擎：基于 imapflow 连接阿里企业邮箱 IMAP，完成
//   - 列出服务器文件夹（目录来自阿里云 IMAP，不写死）
//   - 拉取某文件夹邮件列表（信封/标记/是否带附件）
//   - 拉取单封邮件详情（正文/附件落盘，HTML 经 sanitize-html 清洗）
//   - 后台 IDLE 实时监听新邮件
// 发信（SMTP）不在此文件，后续在 emailSender.js 实现。

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const sanitizeHtml = require('sanitize-html')

// ─── 阿里企业邮箱默认值（用户可改）──
function defaultImapForEmail() {
  return {
    imapHost: 'imap.qiye.aliyun.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.qiye.aliyun.com',
    smtpPort: 465,
    smtpSecure: true,
  }
}

// ─── 清洗 HTML（保排版、去脚本；远程资源由渲染端 iframe CSP 控制）──
// 说明：放行 <style> 是为了「高保真」——大量 HTML 邮件用 <style> 块排版。
// 安全性由外层沙箱 iframe（sandbox，无 allow-scripts / allow-same-origin）+ CSP
// （script-src 'none'、img-src 默认 none）兜底，故 <style> 不会带来脚本执行风险。
const SANITIZE_OPTS = {
  allowedTags: [
    'style',
    'p', 'br', 'div', 'span', 'a', 'strong', 'b', 'em', 'i', 'u', 's',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
    'pre', 'code', 'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'font', 'sub', 'sup', 'strike', 'del', 'section', 'article',
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'id'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'title'],
    font: ['color', 'face', 'size'],
    td: ['align', 'valign', 'width', 'rowspan', 'colspan', 'bgcolor'],
    th: ['align', 'valign', 'width', 'rowspan', 'colspan', 'bgcolor'],
    table: ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
  // script / textarea / option 的「内部文本」直接丢弃（style 已在 allowedTags 中保留）
  nonTextTags: ['script', 'textarea', 'option'],
}

function sanitize(html) {
  try { return sanitizeHtml(html || '', SANITIZE_OPTS) }
  catch (e) { return '<p>（正文解析失败）</p>' }
}

// ─── 连接 ──
function makeClient(config, authCode) {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: !!config.imapSecure,
    auth: { user: config.email, pass: authCode },
    logger: false,
  })
}

// 临时连接：用完即关（供向导「测试连接」使用，不污染复用的浏览连接）
async function withTempClient(config, authCode, fn) {
  const client = makeClient(config, authCode)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try { await client.logout() } catch (e) {}
  }
}

// ─── 浏览连接（复用单条连接；避免每点一封邮件都重新登录，那太慢且易触发限流）──
let browseClient = null
let browseKey = null   // `${email}|${authCode}`：凭据变更时自动重建

function closeClient(c) {
  if (!c) return
  try { c.removeAllListeners && c.removeAllListeners() } catch (e) {}
  try { Promise.resolve(c.logout()).catch(() => {}) } catch (e) {}
}

function closeBrowse() {
  const c = browseClient
  browseClient = null
  browseKey = null
  closeClient(c)
}

async function getBrowseClient(config, authCode) {
  const key = config.email + '|' + authCode
  if (browseClient && browseClient.usable && browseKey === key) return browseClient
  closeBrowse()
  const c = makeClient(config, authCode)
  c.on('error', (err) => { console.error('[Email] browse error:', err && err.message) })
  c.on('close', () => { if (browseClient === c) { browseClient = null; browseKey = null } })
  await c.connect()
  browseClient = c
  browseKey = key
  return c
}

// 复用浏览连接执行一次操作；连接失效则丢弃，下次操作自动重建
async function withClient(config, authCode, fn) {
  const client = await getBrowseClient(config, authCode)
  try {
    return await fn(client)
  } catch (err) {
    if (client && client.usable === false) closeBrowse()
    throw err
  }
}

// ─── 地址归一化 ──
// 两个库返回的地址结构不一样，必须都兼容（此前只按「数组」处理，导致 mailparser 的
// AddressObject 被当成一条地址、两个字段都取不到 → 详情页「发件人/收件人」全部渲染为空）：
//   · imapflow envelope： [{ name, address }]              （列表页用）
//   · mailparser：        { value: [{ name, address }] }   （详情页用）
function asAddr(x) {
  if (!x) return null
  if (typeof x === 'string') {
    const s = x.trim()
    if (!s) return null
    const m = s.match(/^(.*?)\s*<\s*([^>]+)\s*>$/)
    return m ? { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2].trim() } : { name: '', address: s }
  }
  const name = typeof x.name === 'string' ? x.name : ''
  const address = typeof x.address === 'string' ? x.address : ''
  if (!name && !address) return null
  return { name, address }
}

// 统一取出「地址数组」：同时兼容 imapflow 数组 与 mailparser AddressObject
function toAddrList(v) {
  if (!v) return []
  if (!Array.isArray(v) && Array.isArray(v.value)) return v.value.map(asAddr).filter(Boolean)
  const list = Array.isArray(v) ? v : [v]
  return list.map(asAddr).filter(Boolean)
}

// 取第一个地址（用于「发件人」这类单值字段）
function firstAddr(v) {
  const list = toAddrList(v)
  return list.length ? list[0] : null
}

// 从 bodyStructure 判断是否带附件
function detectAttachment(node) {
  if (!node) return false
  if (node.disposition === 'attachment') return true
  const kids = node.childNodes || node.child || node.children
  if (Array.isArray(kids)) return kids.some(detectAttachment)
  return false
}

// imapflow 的 flags 是 Set（不是数组）。IMAP flag 名不区分大小写，统一转小写集合
function flagSet(flags) {
  const out = new Set()
  if (!flags) return out
  const arr = flags instanceof Set ? Array.from(flags) : (Array.isArray(flags) ? flags : [])
  for (const f of arr) out.add(String(f).toLowerCase())
  return out
}

function normalizeEnvelope(msg) {
  const e = msg.envelope || {}
  const flags = flagSet(msg.flags)
  let date = 0
  if (e.date) date = new Date(e.date).getTime()
  else if (msg.internalDate) date = new Date(msg.internalDate).getTime()
  return {
    uid: msg.uid,
    id: e.messageId || String(msg.uid),
    from: firstAddr(e.from),
    to: toAddrList(e.to),
    subject: e.subject || '(无主题)',
    date,
    seen: flags.has('\\seen'),
    flagged: flags.has('\\flagged'),
    answered: flags.has('\\answered'),
    hasAttachment: detectAttachment(msg.bodyStructure),
  }
}

// ─── 公开 API ──

// 列出服务器文件夹（动态，来自阿里云 IMAP LIST）
async function listMailboxes(config, authCode) {
  return withClient(config, authCode, async (client) => {
    // 注意：必须调用 listTree()/list() —— 它们才会真的发一次 LIST 命令；
    // client.mailboxes 只是缓存 getter，新连接上它是空的。
    const tree = await client.listTree()
    const out = []
    const walk = (folders, depth) => {
      for (const n of (folders || [])) {
        out.push({
          path: n.path,
          name: n.name || n.path,
          specialUse: n.specialUse || '',
          flags: Array.from(n.flags || []),
          delimiter: n.delimiter || '',
          disabled: !!n.disabled,
          depth: depth || 0,
        })
        // 子目录键名是 folders（不是 children）
        if (n.folders && n.folders.length) walk(n.folders, (depth || 0) + 1)
      }
    }
    walk(tree && tree.folders, 0)
    // 收件箱置顶（服务器返回顺序不保证）；稳定排序，子目录相对顺序不变
    out.sort((a, b) => {
      const ai = (/inbox/i.test(a.specialUse || '') || a.path === 'INBOX') ? 0 : 1
      const bi = (/inbox/i.test(b.specialUse || '') || b.path === 'INBOX') ? 0 : 1
      return ai - bi
    })
    return out
  })
}

// 拉取某文件夹邮件（信封级，不含正文）
// since: 可选，Date 或 'YYYY-MM-DD'，只取该日期之后的邮件（用于"最近 N 天"等时间窗查询）
async function fetchMessages(config, authCode, folder, limit = 60, since) {
  return withClient(config, authCode, async (client) => {
    const mb = await client.mailboxOpen(folder, { readOnly: true })
    if (!mb) throw new Error('无法打开文件夹：' + folder)
    let uids
    if (since) {
      const d = (since instanceof Date) ? since : new Date(since)
      if (isNaN(d.getTime())) throw new Error('since 参数无法解析为日期: ' + since)
      uids = await client.search({ since: d }, { uid: true })
    } else {
      uids = await client.search({ all: true }, { uid: true })
    }
    const recent = (uids || []).slice(-limit)
    if (!recent.length) return []
    const messages = []
    // 第三参 { uid: true } 必不可少：告诉 imapflow 这里的 range 是 UID 而不是序号
    for await (const msg of client.fetch(recent, {
      uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true,
    }, { uid: true })) {
      messages.push(normalizeEnvelope(msg))
    }
    messages.reverse() // 最新在前
    return messages
  })
}

// 拉取单封邮件详情（解析正文 + 附件落盘）
async function fetchMessage(config, authCode, folder, uid) {
  return withClient(config, authCode, async (client) => {
    await client.mailboxOpen(folder, { readOnly: true })
    const msg = await client.fetchOne(uid, {
      uid: true, envelope: true, flags: true, source: true, bodyStructure: true,
    }, { uid: true })
    if (!msg || !msg.source) throw new Error('邮件不存在或已被移动')
    const parsed = await simpleParser(msg.source)

    // 附件：解析后落盘到临时目录，回传本地路径供主进程打开/保存
    const attachments = []
    const ATT_DIR = path.join(app.getPath('userData'), 'emailAttachments')
    try { fs.mkdirSync(ATT_DIR, { recursive: true }) } catch (e) {}
    if (parsed.attachments && parsed.attachments.length) {
      const folderSafe = String(folder).replace(/[^\w]/g, '_')
      for (const att of parsed.attachments) {
        const safe = (att.filename || 'attachment').replace(/[^\w.\-一-龥]/g, '_')
        const file = path.join(ATT_DIR, `${folderSafe}_${uid}_${safe}`)
        try {
          fs.writeFileSync(file, att.content)
          attachments.push({
            filename: att.filename || 'attachment',
            contentType: att.contentType || '',
            size: att.size || (att.content ? att.content.length : 0),
            file,
            isImage: /^image\//i.test(att.contentType || ''),
          })
        } catch (e) {
          console.error('[Email] attachment save failed:', e && e.message)
        }
      }
    }

    let html = ''
    if (parsed.html) html = sanitize(parsed.html)

    return {
      uid,
      folder,
      subject: parsed.subject || '(无主题)',
      from: firstAddr(parsed.from),
      to: toAddrList(parsed.to),
      cc: toAddrList(parsed.cc),
      replyTo: firstAddr(parsed.replyTo),
      date: parsed.date ? new Date(parsed.date).getTime() : 0,
      text: parsed.text || '',
      html,
      attachments,
    }
  })
}

// ─── 后台 IDLE 实时监听（只监听 INBOX 新邮件，断线自动重连）──
let idleClient = null
let idleStopped = true
let idleConfig = null
let idleAuth = null
let idleOnNew = null
let idleOnState = null
let idleReconnectTimer = null

// 状态机（透出给托盘/设置页）：connecting → online ⇄ error；stopped = 未启用
function setIdleState(state, error) {
  if (typeof idleOnState !== 'function') return
  try { idleOnState({ state, error: error || null, at: Date.now() }) } catch (e) {}
}

async function stopIdle() {
  idleStopped = true
  clearTimeout(idleReconnectTimer)
  idleReconnectTimer = null
  if (idleClient) {
    const c = idleClient
    idleClient = null
    try { c.removeAllListeners && c.removeAllListeners() } catch (e) {}
    try { await c.logout() } catch (e) {}
  }
}

async function connectIdle() {
  if (idleStopped) return { ok: false, error: '已停止' }
  const client = makeClient(idleConfig, idleAuth)
  idleClient = client
  setIdleState('connecting')

  client.on('error', (err) => {
    console.error('[Email] idle error:', err && err.message)
    setIdleState('error', (err && err.message) || String(err))
  })
  // 断线 → 15s 后重连（避免频繁重试打爆服务器）
  client.on('close', () => {
    if (idleClient === client) idleClient = null
    if (idleStopped) return
    clearTimeout(idleReconnectTimer)
    setIdleState('connecting')
    idleReconnectTimer = setTimeout(() => { connectIdle().catch(() => {}) }, 15000)
  })

  try {
    await client.connect()
    const mb = await client.mailboxOpen('INBOX', { readOnly: true })
    var known = (mb && mb.exists) || 0
  } catch (err) {
    setIdleState('error', humanize(err))
    throw err
  }
  setIdleState('online')

  client.on('exists', async (data) => {
    const count = (data && data.count) || 0
    const newCount = count - known
    if (newCount <= 0) { known = count; return }
    known = count
    try {
      const all = await client.search({ all: true }, { uid: true })
      const last = (all || []).slice(-newCount)
      if (!last.length) return
      const msgs = []
      for await (const m of client.fetch(last, { uid: true, envelope: true, flags: true }, { uid: true })) {
        msgs.push(normalizeEnvelope(m))
      }
      if (msgs.length && typeof idleOnNew === 'function') idleOnNew(msgs)
    } catch (e) {
      console.error('[Email] idle new-mail fetch error:', e && e.message)
    }
  })

  // 主动进入 IDLE，但绝不 await：idle() 会一直等到有新邮件/超时才 resolve。
  // （imapflow 在收到命令时会自动中断 IDLE 并在命令后重建，故可在回调里安全地 SEARCH/FETCH）
  client.idle().catch((e) => { console.error('[Email] idle() failed:', e && e.message) })
  return { ok: true }
}

// 把底层报错翻译成可读文案（授权码失效是最常见原因）
function humanize(err) {
  const msg = (err && (err.message || String(err))) || '未知错误'
  if (/authentication failed|LOGIN failed|INVALID/i.test(msg)) return '授权码无效或已过期（' + msg + '）'
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(msg)) return '网络连接失败（' + msg + '）'
  return msg
}

// onNewMail(msgs) ：收到新邮件回调
// onState({state,error,at}) ：同步状态回调（connecting/online/error）
async function startIdle(config, authCode, onNewMail, onState) {
  await stopIdle()
  idleStopped = false
  idleConfig = config
  idleAuth = authCode
  idleOnNew = onNewMail
  idleOnState = typeof onState === 'function' ? onState : null
  return connectIdle()
}

// INBOX 未读数（供托盘角标轮询；短连接用完即关）
async function fetchUnseen(config, authCode) {
  return withTempClient(config, authCode, async (client) => {
    const st = await client.status('INBOX', { messages: true, unseen: true })
    return { messages: (st && st.messages) || 0, unseen: (st && st.unseen) || 0 }
  })
}

// 向导「测试连接」：临时连接实测一次，成功返回文件夹数量
async function testConnection(config, authCode) {
  return withTempClient(config, authCode, async (client) => {
    const tree = await client.listTree()
    let count = 0
    const walk = (folders) => {
      for (const n of (folders || [])) { count++; if (n.folders && n.folders.length) walk(n.folders) }
    }
    walk(tree && tree.folders)
    return { ok: true, folderCount: count }
  })
}

// 凭据变更/退出时统一复位（关闭浏览连接 + 停止 IDLE）
async function resetClients() {
  closeBrowse()
  await stopIdle()
}

module.exports = {
  defaultImapForEmail,
  listMailboxes,
  fetchMessages,
  fetchMessage,
  testConnection,
  fetchUnseen,
  sanitize,
  startIdle,
  stopIdle,
  resetClients,
}
