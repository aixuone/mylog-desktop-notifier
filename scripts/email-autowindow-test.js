'use strict'
// 端到端验证「无会话 → 自动拉起邮箱窗口 → 就绪后重试」链路（直接跑真实 e-log.js）。
// mock 桌面端行为：
//   GET  /api/email/*   —— 未开窗前一律返回 EMAIL_SESSION_MISSING
//   POST /api/email/open-window —— 模拟"开窗 + PHP 启动 + 登录态恢复"，随后放行
// 断言：e-log.js 在**零人工干预**下最终输出未读邮件列表。
const http = require('http')
const assert = require('assert')
const { spawn } = require('child_process')
const path = require('path')

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
const ELOG = 'C:/Users/Administrator/.workbuddy/skills/e-log-communication-1.0/scripts/e-log.js'

let windowReady = false // 是否已"开窗并就绪"
let canLogin = true // 场景3 设 false：模拟"开窗了但用户从未登录过"
const openCalls = []

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const send = (obj, code) => {
      res.statusCode = code || 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'POST' && req.url === '/api/email/open-window') {
      openCalls.push(Date.now())
      // 模拟开窗耗时（PHP 服务启动 + 窗口加载 + 登录态恢复）
      setTimeout(() => { if (canLogin) windowReady = true }, 1200)
      return send({ ok: true, hasSession: true, windowOpen: true })
    }
    if (req.url.startsWith('/api/email/') && req.method === 'GET') {
      if (!windowReady) {
        return send({ ok: false, error: 'EMAIL_SESSION_MISSING' })
      }
      if (req.url.startsWith('/api/email/messages')) {
        return send({
          ok: true,
          folder: 'INBOX',
          count: 1,
          messages: [
            {
              uid: '7',
              subject: '未读测试邮件',
              from: { name: '周维', address: 'zhouwei@x.com' },
              to: [{ name: '我', address: 'me@x.com' }],
              date: 1730000000000,
              seen: false,
              flagged: false,
              hasAttachment: false,
              size: 2048,
            },
          ],
        })
      }
      // mailboxes（端口探测用）—— 未开窗也返回错误体，保证探测能发现端口
      return send({ ok: false, error: 'EMAIL_SESSION_MISSING' })
    }
    send({ ok: false, error: 'NOT_FOUND' }, 404)
  })
})

function runELog(intent, slotsJson) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [ELOG, intent, slotsJson], {
      env: Object.assign({}, process.env, { EMAIL_PORTS: String(server.address().port) }),
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', reject)
  })
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  console.log('mock desktop 端口:', port)

  // 1) 会话未就绪的初次查询 → 脚本应自动开窗并重试，最终成功返回未读邮件
  const r1 = await runELog('queryEmail', '{"mode":"messages","unreadOnly":true}')
  assert.strictEqual(r1.code, 0, '退出码应为 0，实际 stderr=' + r1.err)
  let payload = null
  try { payload = JSON.parse(r1.out) } catch (e) {}
  assert.ok(payload, 'stdout 应为 JSON，实际=' + r1.out.slice(0, 200))
  assert.strictEqual(payload.ok, true)
  assert.strictEqual(payload.count, 1, '应返回 1 封未读邮件')
  assert.strictEqual(payload.messages[0].subject, '未读测试邮件')
  assert.strictEqual(openCalls.length, 1, '应恰好调用一次 open-window，实际=' + openCalls.length)
  console.log('[OK] 场景1：无会话时自动开窗 + 重试，零人工干预读到未读邮件')

  // 2) 已就绪后的查询 → 不应再触发开窗
  const r2 = await runELog('queryEmail', '{"mode":"messages","unreadOnly":true}')
  assert.strictEqual(r2.code, 0, '第二次查询应直接成功')
  assert.strictEqual(openCalls.length, 1, '已就绪后不应再开窗')
  console.log('[OK] 场景2：会话已就绪时不再触发开窗（不打扰用户）')

  // 3) 开窗后仍未就绪（模拟从未登录）→ 应给出引导文案而非崩溃
  canLogin = false // open-window 不再翻转 ready：窗口开了，但没有登录态
  windowReady = false
  const r3 = await runELog('queryEmail', '{"mode":"messages","unreadOnly":true}')
  assert.notStrictEqual(r3.code, 0, '未就绪应以非零码退出')
  assert.ok(
    /EMAIL_SESSION_MISSING/.test(r3.out + r3.err),
    '应提示登录引导，实际=' + (r3.out + r3.err).slice(0, 300),
  )
  console.log('[OK] 场景3：开窗后仍未登录 → 明确引导"在窗口里登录一次"，不崩')

  server.close()
  console.log('\nALL PASS ✅  自动开窗 + 重试链路端到端验证通过')
}
main().catch((e) => { server.close(); console.error('FAIL:', e.message); process.exit(1) })
