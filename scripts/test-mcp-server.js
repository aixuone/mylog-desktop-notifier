'use strict'
/**
 * test-mcp-server.js — 模拟 WorkBuddy 客户端，对 mcp-server.js 做 stdio 协议联调。
 * 仅用 mylog_query_todo（只读）验证「协议 + 真实通道」，不写入后端数据。
 */
const { spawn } = require('child_process')

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
const SERVER = 'C:/ixuworkspace/mylog-pc/desktop-notifier/lib/mcp-server.js'
const CWD = 'C:/ixuworkspace/mylog-pc/desktop-notifier'

const server = spawn(NODE, [SERVER], { cwd: CWD })
const responses = []
let stdoutBuf = ''

server.stdout.setEncoding('utf8')
server.stdout.on('data', (d) => {
  stdoutBuf += d
  let idx
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim()
    stdoutBuf = stdoutBuf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      responses.push(msg)
      console.log('← recv id=' + msg.id + ' method=' + (msg.method || '(result)') + ' hasResult=' + !!msg.result + ' hasError=' + !!msg.error)
    } catch (_) {}
  }
})
server.stderr.setEncoding('utf8')
server.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d))

function send(msg) {
  console.log('→ send id=' + msg.id + ' method=' + msg.method)
  server.stdin.write(JSON.stringify(msg) + '\n')
}

function findResp(id) {
  return responses.find((r) => r.id === id)
}

const steps = [
  () => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } } }),
  () => send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  () => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mylog_query_todo', arguments: { size: 3 } } }),
]

let i = 0
const timer = setInterval(() => {
  if (i < steps.length) {
    steps[i++]()
  } else if (findResp(3)) {
    clearInterval(timer)
    finish()
  }
}, 600)

setTimeout(() => {
  clearInterval(timer)
  if (!findResp(3)) {
    console.log('⏱ 超时：未收到 tools/call 结果（可能桌面端未启动或未登录 5173 网页）')
  }
  finish()
}, 40000)

function finish() {
  const init = findResp(1)
  const list = findResp(2)
  const call = findResp(3)
  console.log('\n==== 结果 ====')
  console.log('initialize:', init ? (init.result ? 'OK server=' + init.result.serverInfo.name : 'ERR ' + JSON.stringify(init.error)) : '无响应')
  if (list && list.result) {
    console.log('tools/list:', 'OK 工具数=' + list.result.tools.length)
    list.result.tools.forEach((t) => console.log('   - ' + t.name + ': ' + t.description.slice(0, 24) + '…'))
  } else {
    console.log('tools/list:', list ? 'ERR ' + JSON.stringify(list.error) : '无响应')
  }
  if (call) {
    if (call.result) {
      console.log('tools/call(queryTodo):', call.result.isError ? 'ERR ' + call.result.content[0].text : 'OK')
      if (!call.result.isError) console.log(call.result.content[0].text.slice(0, 600))
    } else {
      console.log('tools/call(queryTodo):', 'ERR ' + JSON.stringify(call.error))
    }
  } else {
    console.log('tools/call(queryTodo): 无响应')
  }
  try { server.kill() } catch (_) {}
  process.exit(0)
}
