'use strict'
/**
 * bench-send.js — 测速脚本（隔离"代码侧机械链路"延迟，不含 LLM 推理耗时）。
 *
 * 用法：
 *   node scripts/bench-send.js                 # 基线模式：queryTodo 只读往返 x3（无副作用）
 *   node scripts/bench-send.js --send          # 真实发送模式（有副作用，需下方参数）
 *       --name "张三" --message "测试WB代发" [--type group|c2c]
 *
 * 说明：WorkBuddy 用户感知的"慢"= LLM 选工具+填参+生成回话（本脚本测不到，那部分靠收紧提示词解决）
 *       + 代码侧机械链路（握手+WS 中继+网页执行+回传，本脚本测的就是它）。
 *       机械链路快，则"若仍慢只在 LLM 侧"；sendMessage 机械部分 ≈ 基线 + IM 网络往返(~0.2-1s)。
 */
const { AgentBridge } = require('../lib/agent-bridge')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const get = (f, d) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

function now() {
  return process.hrtime.bigint()
}
function ms(a, b) {
  return Number(b - a) / 1e6
}

async function bench(name, fn) {
  const t0 = now()
  try {
    const r = await fn()
    const dt = ms(t0, now())
    console.log(`  ✅ ${name}: ${dt.toFixed(1)} ms`)
    return { ok: true, dt, r }
  } catch (e) {
    const dt = ms(t0, now())
    console.log(`  ❌ ${name}: ${dt.toFixed(1)} ms  错误: ${e.message}`)
    return { ok: false, dt, err: e.message }
  }
}

function stats(arr) {
  if (!arr.length) return 'n/a'
  const s = [...arr].sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return `min=${s[0].toFixed(1)} median=${s[Math.floor(s.length / 2)].toFixed(1)} max=${s[s.length - 1].toFixed(1)} avg=${(sum / s.length).toFixed(1)} ms`
}

async function main() {
  const sendMode = has('--send')
  const bridge = new AgentBridge()

  console.log('\n=== 连接（HTTP 握手发现 WS 端口 + 注册）===')
  const c = await bench('connect', () => bridge.connect())
  if (!c.ok) {
    console.log('\n连接失败，无法继续（桌面端是否已启动？）。')
    process.exit(1)
  }

  if (sendMode) {
    const name = get('--name', '')
    const message = get('--message', '')
    const type = get('--type', 'c2c')
    if (!name || !message) {
      console.log('\n--send 模式需要 --name 与 --message 参数。')
      bridge.close()
      process.exit(1)
    }
    console.log(`\n=== 真实发送（${type}）到「${name}」：${message} ===`)
    console.log('  ⚠️ 这是真实 IM 发送，消息会立即送达对方。')
    const samples = []
    for (let i = 1; i <= 3; i++) {
      const r = await bench(`send #${i}`, () =>
        bridge.sendIntent('sendMessage', { name, message, conversationType: type }),
      )
      if (r.ok) samples.push(r.dt)
      await new Promise((res) => setTimeout(res, 300))
    }
    console.log('\n  发送耗时:', stats(samples))
  } else {
    console.log('\n=== 基线：queryTodo 只读往返（无副作用，代表机械链路）===')
    const samples = []
    for (let i = 1; i <= 3; i++) {
      const r = await bench(`queryTodo #${i}`, () => bridge.sendIntent('queryTodo', { size: 3 }))
      if (r.ok) samples.push(r.dt)
      await new Promise((res) => setTimeout(res, 300))
    }
    console.log('\n  机械链路往返耗时:', stats(samples))
    console.log('  （sendMessage 机械部分 ≈ 此值 + IM 网络往返 ~0.2-1s）')
  }

  bridge.close()
  console.log('\n测速结束。')
}

main().catch((e) => {
  console.error('异常:', e.message || e)
  process.exit(1)
})
