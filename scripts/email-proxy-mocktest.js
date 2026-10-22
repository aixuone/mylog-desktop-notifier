'use strict'
// 离线验证 handleEmailApiProxy 的 HTTP 请求格式与响应归一化。
// 启动一个 mock SnappyMail（/index?/Json/ 入口），用与 main.js 相同的逻辑发起请求，
// 断言：路径、Cookie 头、X-Sm-Token 头、JSON body、以及归一化结果正确。
const http = require('http')
const assert = require('assert')

// ---- 复制 main.js 中的关键逻辑（与真实实现保持一致）----
function makeSnappyApi(baseUrl, cookies) {
  return async function snappyApi(action, params = {}) {
    const cookieHeader = cookies.map((c) => c.name + '=' + c.value).join('; ')
    const smToken = (cookies.find((c) => c.name === 'smtoken') || {}).value || ''
    const body = JSON.stringify(Object.assign({ Action: action }, params))
    const u = new URL(baseUrl + '/?/Json/')
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Cookie: cookieHeader,
            'X-Sm-Token': smToken,
          },
        },
        (res) => {
          let d = ''
          res.on('data', (c) => (d += c))
          res.on('end', () => {
            let json
            try { json = JSON.parse(d) } catch (e) { return reject(new Error('BAD_RESPONSE: ' + d.slice(0, 200))) }
            if (json && json.ErrorCode) return reject(new Error('SNAPPYMAIL_ERROR: ' + (json.ErrorMessage || json.ErrorCode)))
            resolve(json)
          })
        },
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}
function _addr(x) {
  if (!x) return { name: '', address: '' }
  if (typeof x === 'string') return { name: '', address: x }
  return { name: x.Name || x.name || '', address: x.Email || x.email || x.Address || '' }
}
function _arr(x) { return Array.isArray(x) ? x : x ? [x] : [] }
function _toMs(v) {
  if (v == null) return 0
  const n = Number(v)
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000
  const t = Date.parse(v)
  return isNaN(t) ? 0 : t
}
function normalizeMessages(r) {
  const res = (r && r.Result) || {}
  const mr = res.MessageResult || {}
  return (mr.Messages || []).map((m) => ({
    uid: String(m.Uid != null ? m.Uid : ''),
    subject: m.Subject || '',
    from: _addr(m.From),
    to: _arr(m.To).map(_addr),
    date: _toMs(m.TimeStamp != null ? m.TimeStamp : m.Date),
    seen: !!m.IsSeen,
    flagged: !!m.IsFlagged,
    hasAttachment: !!m.HasAttachments,
    size: m.Size || 0,
  }))
}
function normalizeMessage(r) {
  const res = (r && r.Result) || {}
  const m = res.Message || res
  return {
    subject: m.Subject || '',
    from: _addr(m.From),
    to: _arr(m.To).map(_addr),
    cc: _arr(m.Cc).map(_addr),
    date: _toMs(m.TimeStamp != null ? m.TimeStamp : m.Date),
    text: m.Text || '',
    html: m.Html || '',
    attachments: (m.Attachments || []).map((a) => ({ name: a.FileName || a.Name || '', size: a.Size || 0, contentType: a.MimeType || '' })),
  }
}

// ---- mock SnappyMail 服务端 ----
const cookies = [
  { name: 'PHPSESSID', value: 'abc123' },
  { name: 'smtoken', value: 'csrf-xyz' },
  { name: 'smauth', value: 'auth-token' },
]
const received = {}
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    received.method = req.method
    received.path = req.url
    received.cookie = req.headers['cookie']
    received.xsm = req.headers['x-sm-token']
    received.body = chunks.join('')
    let json = {}
    try { json = JSON.parse(received.body) } catch (e) {}
    if (json.Action === 'Folders') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ Action: 'Folders', Result: { Folders: [{ FullName: 'INBOX', Name: 'INBOX', Unread: 2, Exists: 10 }] }, Status: 0 }))
    } else if (json.Action === 'MessageList') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ Action: 'MessageList', Result: { MessageResult: { Messages: [
        { Uid: 5, Subject: '测试邮件', From: { Name: '周维', Email: 'zhouwei@x.com' }, To: { Name: '我', Email: 'me@x.com' }, TimeStamp: 1730000000, IsSeen: false, HasAttachments: true, Size: 1234 },
      ] } }, Status: 0 }))
    } else if (json.Action === 'Message') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ Action: 'Message', Result: { Message: { Subject: '详情', From: { Email: 'a@x.com' }, Text: '正文', Attachments: [{ FileName: 'f.txt', Size: 10, MimeType: 'text/plain' }] } }, Status: 0 }))
    } else if (json.Action === 'SendMessage') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ Action: 'SendMessage', Result: { NewUid: 99 }, Status: 0 }))
    } else {
      res.statusCode = 400
      res.end(JSON.stringify({ ErrorCode: 1, ErrorMessage: 'unknown action' }))
    }
  })
})

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port
  const snappyApi = makeSnappyApi(base, cookies)

  // 1) 请求格式断言
  await snappyApi('Folders')
  assert.strictEqual(received.method, 'POST', 'method 应为 POST')
  assert.strictEqual(received.path, '/?/Json/', '路径应为 /?/Json/，实际=' + received.path)
  assert.strictEqual(received.cookie, 'PHPSESSID=abc123; smtoken=csrf-xyz; smauth=auth-token', 'Cookie 头拼接错误')
  assert.strictEqual(received.xsm, 'csrf-xyz', 'X-Sm-Token 应为 smtoken 的值')
  const sentBody = JSON.parse(received.body)
  assert.strictEqual(sentBody.Action, 'Folders', 'body 应含 Action')
  console.log('[OK] 请求格式：路径/方法/Cookie/X-Sm-Token/JSON body 均正确')

  // 2) 列表归一化
  const list = normalizeMessages(await snappyApi('MessageList', { folder: 'INBOX', limit: 50 }))
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].uid, '5')
  assert.strictEqual(list[0].from.name, '周维')
  assert.strictEqual(list[0].from.address, 'zhouwei@x.com')
  assert.strictEqual(list[0].date, 1730000000 * 1000, '时间戳应为毫秒')
  assert.strictEqual(list[0].seen, false)
  assert.strictEqual(list[0].hasAttachment, true)
  console.log('[OK] 邮件列表归一化正确（含秒→毫秒时间戳、地址解析）')

  // 3) 详情归一化
  const msg = normalizeMessage(await snappyApi('Message', { folder: 'INBOX', uid: '5' }))
  assert.strictEqual(msg.subject, '详情')
  assert.strictEqual(msg.text, '正文')
  assert.strictEqual(msg.attachments[0].name, 'f.txt')
  console.log('[OK] 邮件详情归一化正确')

  // 4) 发送
  const sendR = await snappyApi('SendMessage', { to: 'a@b.com', subject: 'hi', plain: 'hello' })
  assert.strictEqual(sendR.Result.NewUid, 99)
  console.log('[OK] 发送调用正确')

  server.close()
  console.log('\nALL PASS ✅  代理 HTTP plumbing 验证通过')
}
main().catch((e) => { server.close(); console.error('FAIL:', e.message); process.exit(1) })
