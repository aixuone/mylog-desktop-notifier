'use strict'
/**
 * test-agent-bridge.js — 端到端自检脚本。
 *
 * 前置条件：
 *   1. 桌面端已启动（e日志），并加载网页端（mylog-pc 已部署含 agentExecutor 的版本）；
 *   2. 当前登录用户已在网页端登录（后端 RBAC 校验依赖登录态）。
 *
 * 运行：node scripts/test-agent-bridge.js
 * 验证三条链路：queryTodo（查询待办）/ createPlan（创建计划）/ createExec（创建执行）。
 */
const { AgentBridge } = require('../lib/agent-bridge')

function logTitle(t) {
  console.log(`\n=== ${t} ===`)
}

async function main() {
  const bridge = new AgentBridge()
  logTitle('连接桌面代理（HTTP 握手发现 WS 端口）')
  await bridge.connect()
  console.log('✅ 已连接，并以 browserType=agent 完成注册')

  // 1. 查询待办
  logTitle('1) queryTodo 查询待办')
  try {
    const r = await bridge.sendIntent('queryTodo', { size: 5 })
    console.log('✅ 成功   total =', r.total, ' 返回条数 =', (r.items || []).length)
    console.log(JSON.stringify((r.items || []).slice(0, 2), null, 2))
  } catch (e) {
    console.log('❌ 失败:', e.message)
  }

  // 2. 创建计划
  logTitle('2) createPlan 创建计划')
  try {
    const r = await bridge.sendIntent('createPlan', {
      txt: '【WorkBuddy 自检】客户现场拜访计划 ' + new Date().toLocaleString(),
      projectIds: [],
    })
    console.log('✅ 成功   id =', r.id, ' type =', r.type)
  } catch (e) {
    console.log('❌ 失败:', e.message)
  }

  // 3. 创建执行
  logTitle('3) createExec 创建执行')
  try {
    const r = await bridge.sendIntent('createExec', {
      txt: '【WorkBuddy 自检】完成设备巡检执行 ' + new Date().toLocaleString(),
    })
    console.log('✅ 成功   id =', r.id, ' type =', r.type)
  } catch (e) {
    console.log('❌ 失败:', e.message)
  }

  bridge.close()
  console.log('\n自检结束。')
}

main().catch((e) => {
  console.error('自检异常:', e.message || e)
  process.exit(1)
})
