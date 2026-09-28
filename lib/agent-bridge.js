'use strict'
/**
 * agent-bridge.js — WorkBuddy 连接器侧的 Agent 通信客户端（Node）。
 *
 * 职责（仅客户端，不含任何业务/鉴权逻辑）：
 *   1. 通过桌面端 HTTP 握手（POST /api/handshake）发现 WS 端口；
 *   2. 以 browserType:'agent' 注册为 Agent 连接（桌面端据此标记 isAgent）；
 *   3. sendIntent(intent, slots) 发送一条意图，按 requestId 等回 AGENT_RESULT；
 *   4. 超时 / WEB_OFFLINE / 未知意图等异常统一以 reject(Error) 暴露。
 *
 * 无 token：通信仅限 127.0.0.1，依赖该绑定 + 文件 ACL 作为本地边界。
 * 业务执行全部在网页端（收到 AGENT_INTENT 后调用 commands/agentExecutor）。
 */
const WebSocket = require('ws')
const { randomUUID } = require('crypto')

const HTTP_BASE_PORT = 19789
const HTTP_MAX_PORTS = 10
const AGENT_REQUEST_TIMEOUT_MS = 30000
const HANDSHAKE_ABORT_MS = 300   // 单端口探测超时（并行探测，缩短冷启动）

let cachedWsPort = null   // 缓存已发现的 WS 端口，避免每次重扫 10 端口

async function probePort(p) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), HANDSHAKE_ABORT_MS)
    const r = await fetch(`http://127.0.0.1:${p}/api/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserType: 'agent' }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (r.ok) {
      const data = await r.json()
      if (data && data.success && data.wsPort) return data.wsPort
    }
  } catch (_) {
    // 端口未监听或超时
  }
  return null
}

/** 扫描桌面端 HTTP 握手端口（并行 + 缓存），返回 WS 端口；找不到返回 null */
async function discoverWsPort() {
  if (cachedWsPort) return cachedWsPort
  const ports = Array.from({ length: HTTP_MAX_PORTS }, (_, i) => HTTP_BASE_PORT + i)
  const results = await Promise.all(ports.map(probePort))
  const wsPort = results.find((p) => p != null) || null
  if (wsPort) cachedWsPort = wsPort
  return wsPort
}

class AgentBridge {
  constructor({ timeout = AGENT_REQUEST_TIMEOUT_MS } = {}) {
    this.timeout = timeout
    this.ws = null
    this.connected = false
    this.pending = new Map()
    this.ready = null
  }

  /** 连接并注册为 Agent（幂等，多次调用复用同一次连接）*/
  connect() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const port = await discoverWsPort()
      if (!port) {
        cachedWsPort = null   // 探测失败清缓存，便于下次重扫
        throw new Error('DESKTOP_OFFLINE: 未发现桌面代理握手端口（桌面端是否已启动？）')
      }
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise((resolve, reject) => {
        this.ws.once('open', resolve)
        this.ws.once('error', reject)
      })
      this.connected = true
      this.ws.send(
        JSON.stringify({ type: 'REGISTER', payload: { browserType: 'agent' }, timestamp: Date.now() }),
      )
      this.ws.on('message', (raw) => this._onMessage(raw))
      this.ws.on('error', () => { cachedWsPort = null })
      this.ws.on('close', () => { this.connected = false; cachedWsPort = null })
    })()
    return this.ready
  }

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch (_) {
      return
    }
    if (msg.type !== 'AGENT_RESULT') return
    const rid = msg.payload && msg.payload.requestId
    const pending = this.pending.get(rid)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(rid)
    if (msg.payload.ok) pending.resolve(msg.payload.data)
    else pending.reject(new Error(msg.payload.error || 'EXEC_FAIL'))
  }

  /**
   * 发送一条意图并等待结果。
   * @param {string} intent 意图名，如 'queryTodo' / 'createPlan' / 'createExec'
   * @param {object} slots  意图参数
   * @returns {Promise<any>} 网页端回传的 data
   */
  sendIntent(intent, slots = {}, { timeout } = {}) {
    const run = async () => {
      await this.connect()
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('NOT_CONNECTED')
      }
      const requestId = randomUUID()
      const t = timeout != null ? timeout : this.timeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending.has(requestId)) {
            this.pending.delete(requestId)
            reject(new Error('TIMEOUT'))
          }
        }, t)
        this.pending.set(requestId, { resolve, reject, timer })
        this.ws.send(
          JSON.stringify({
            type: 'AGENT_INTENT',
            payload: { requestId, intent, slots },
            timestamp: Date.now(),
          }),
        )
      })
    }
    return run()
  }

  close() {
    if (this.ready) {
      this.ready.finally(() => {
        if (this.ws) {
          try { this.ws.close() } catch (_) {}
        }
      })
    }
  }
}

module.exports = { AgentBridge, discoverWsPort }
