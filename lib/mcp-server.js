'use strict'
/**
 * mcp-server.js — mylog 桌面助手 MCP 连接器（stdio JSON-RPC）。
 *
 * 让 WorkBuddy 在对话里直接调用 mylog 能力：
 *   查询待办 / 创建计划 / 创建执行。
 *
 * 实现只做「协议适配」：把 MCP tools/call 翻译成 AGENT_INTENT，
 * 经 AgentBridge（桌面端 WS 中继）→ 网页 agentExecutor → 真实后端执行，
 * 再把 AGENT_RESULT 回包成 MCP 文本结果。不持有任何业务/鉴权逻辑。
 *
 * 设计要点：
 *   - 不依赖 @modelcontextprotocol/sdk，直接实现 stdio 上的 JSON-RPC 2.0（newline-delimited），
 *     避免安装外部包失败的风险。
 *   - 复用 lib/agent-bridge.js（已验证的握手/转发/超时/requestId 关联）。
 *   - 仅 127.0.0.1 通信，无 token（与桌面端保持一致）。
 *   - 调试信息走 stderr，绝不污染 stdout 的 JSON-RPC 流。
 */

const path = require('path')
// 把项目 node_modules 加入解析路径，确保 require('ws') 一定能找到
const nodeModules = path.join(__dirname, '..', 'node_modules')
if (!module.paths.includes(nodeModules)) module.paths.push(nodeModules)

const WebSocket = require('ws')
const { AgentBridge } = require('./agent-bridge')

const log = (...a) => console.error('[mcp-server]', ...a)

// 模块级单例：首次调用时连接，之后复用；断线自动重建
let bridge = null
function getBridge() {
  if (!bridge || !bridge.ws || bridge.ws.readyState !== WebSocket.OPEN) {
    if (bridge) {
      try { bridge.close() } catch (_) {}
    }
    bridge = new AgentBridge({ timeout: 25000 })
  }
  return bridge
}

// ---- 工具定义（name / description / inputSchema 供 WorkBuddy LLM 理解）----
const TOOLS = [
  {
    name: 'mylog_query_todo',
    description:
      '查询 mylog 工作日志系统（mylog-pc / 我的日志）的待办事项，返回「计划 / 执行 / 通话 / 打卡 / 速记」等列表及总数。' +
      '它与钉钉待办是完全独立的两套数据，切勿混淆。' +
      '当用户在 mylog / 工作日志 / 日志系统语境下询问"待办 / 任务 / 还有什么要做 / 今天有什么安排 / 我的工作事项 / 打卡 / 通话记录 / 速记"时，' +
      '应优先调用本工具，而不是钉钉待办工具。' +
      '只读查询，后台静默执行，不改变网页状态。\n' +
      '常用查询可直接用 preset 指代（网页端已固化标签预设与口语捷径）：\n' +
      '  - "今天的计划" / "今天有什么计划" → preset="今天的计划"（记录日期=今天，未完成计划）\n' +
      '  - "今天及以后的计划" / "未来计划" / "未到期计划" → preset="今天及以后的计划"（记录日期>=今天）\n' +
      '  - "今天/今日待办" → preset="未完成计划" 且 date=今天(YYYY-MM-DD)\n' +
      '  - 捷径(今天的计划/今天及以后的计划)已内置日期语义，不要再额外传 date/dateFrom/dateTo。\n' +
      '  - "已完成计划" → preset="已完成计划"\n' +
      '  - "计划外执行" → preset="计划外执行"\n' +
      '  - "通话/会议记录" → preset="通话"\n' +
      '  - "打卡" → preset="打卡"\n' +
      '  - "速记" → preset="速记"\n' +
      '  - "重要的事" → preset="重要"\n' +
      '也可传原始筛选条件自由组合：kind(1执行/2计划/3打卡/4通话/6,7速记)、planStatus(0未开始/1已完成/2已延期/3部分完成/4已取消)、' +
      'planRel(0计划外/1计划内)、isImportant(0/1)、keyword、date(单日) 或 dateFrom/dateTo(范围)、deadlineFrom/deadlineTo、' +
      'viewedUserId(看同事)、sortBy、countOnly(仅计数)。date 与 dateFrom/dateTo 二选一，date 表示某一天。',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description:
            '常用查询预设名：今天的计划 / 今天及以后的计划 / 未完成计划 / 已完成计划 / 计划外执行 / 通话 / 打卡 / 速记 / 重要（也接受英文或标签 id）。' +
            '"今天的计划"=记录日期为今天的未完成计划；"今天及以后的计划"=记录日期>=今天的未完成计划（二者内置日期语义，无需再传 date）。与下方原始条件可叠加，显式条件优先。',
        },
        date: {
          type: 'string',
          description: '单日查询 YYYY-MM-DD（如 2026-09-15），表示这一天内的待办；与 dateFrom/dateTo 二选一',
        },
        dateFrom: { type: 'string', description: '日志日期起 YYYY-MM-DD（范围查询用）' },
        dateTo: { type: 'string', description: '日志日期止 YYYY-MM-DD（含当日）' },
        kind: {
          type: 'string',
          description: '日志类型：1执行 2计划 3打卡 4通话 5视频会议 6速记 7，逗号分隔；all=全部',
        },
        planStatus: {
          type: 'string',
          description: '计划状态逗号分隔：0未开始 1已完成 2已延期 3部分完成 4已取消 5；all=不限',
        },
        planRel: { type: 'string', description: '计划关联：空=不限 / 0=计划外 / 1=计划内' },
        isImportant: { type: 'string', description: '是否重要：空=不限 / 0 / 1' },
        isChan: { type: 'string', description: '是否禅道：空=不限 / 0 / 1' },
        keyword: { type: 'string', description: '关键字（匹配内容/项目名/模块名）' },
        viewedUserId: { type: 'string', description: '查看指定同事的待办（不填=当前用户）' },
        deadlineFrom: { type: 'string', description: '截止日期起 YYYY-MM-DD（计划的 deadline）' },
        deadlineTo: { type: 'string', description: '截止日期止 YYYY-MM-DD' },
        sortBy: {
          type: 'string',
          description: '排序：deadline_asc / deadline_desc / status_deadline / created_desc',
        },
        countOnly: { type: 'boolean', description: 'true=只返回总数不返回明细' },
        size: { type: 'integer', description: '返回条数，默认 10，最大 100' },
        page: { type: 'integer', description: '页码，默认 1' },
      },
    },
  },
  {
    name: 'mylog_create_plan',
    description:
      '在 mylog 工作日志系统创建一条「计划」项（后台静默写入真实后端，不弹窗、不跳转）。' +
      '注意：这是 mylog 日志系统的计划，不是钉钉日程。' +
      'txt 为计划内容描述；projectIds 为关联项目 ID 列表（可空）；date 为计划日期（默认今天）。' +
      '当用户说"建个计划""记一下我要去拜访客户""在 mylog 创建计划：xxx""明天的计划：xxx"时使用。' +
      '计划无标题字段，直接给内容即可。',
    inputSchema: {
      type: 'object',
      properties: {
        txt: { type: 'string', description: '计划内容描述（必填，对应表单「计划内容」）' },
        date: { type: 'string', description: '计划日期 YYYY-MM-DD，默认今天；说"明天/后天/下周X"时换算成具体日期传入' },
        projectIds: {
          type: 'array',
          items: { type: 'string' },
          description: '关联项目 ID 列表，可空',
        },
      },
      required: ['txt'],
    },
  },
  {
    name: 'mylog_create_exec',
    description:
      '在 mylog 工作日志系统创建一条「执行任务」（工作日志中的执行/记录项）。后台静默写入真实后端，不弹窗、不跳转。' +
      '注意：这是 mylog 日志系统的执行记录，不是钉钉待办。' +
      'txt 为执行内容描述；projectIds 为关联项目 ID 列表（可空）；date 为执行日期（默认今天）。' +
      '当用户说"记一条执行""完成了设备巡检""在 mylog 创建执行：xxx"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        txt: { type: 'string', description: '执行内容描述（必填）' },
        date: { type: 'string', description: '执行日期 YYYY-MM-DD，默认今天' },
        projectIds: {
          type: 'array',
          items: { type: 'string' },
          description: '关联项目 ID 列表，可空',
        },
        // —— 在计划下上报执行 ——
        relatePlanId: {
          type: 'string',
          description: '关联计划 log_id（直接给）。与 planKeyword 二选一；关联计划后 planStatus 必填',
        },
        planKeyword: {
          type: 'string',
          description: '按计划内容关键字解析关联计划（走 querytodo kind=2 取首个匹配）。与 relatePlanId 二选一',
        },
        planStatus: {
          type: 'string',
          enum: ['pending', 'done', 'delayed', 'partial', 'cancelled'],
          description:
            '关联计划时执行所置的计划状态：pending=未开始 done=已完成 delayed=已延期 partial=部分完成 cancelled=已取消。缺省 pending。status=delayed 时必须同时给 defermentDate',
        },
        defermentDate: {
          type: 'string',
          description: '延期日期 YYYY-MM-DD（planStatus=delayed 时必填）',
        },
        // —— 上报工时（小时） ——
        aiHours: { type: 'number', description: 'AI 耗时（小时）。关联计划或禅道时报工时用；与 normalHours 单位均为小时，将 ×3600 转秒写入' },
        normalHours: { type: 'number', description: '常规耗时（小时）。同上' },
        // —— 禅道分支 ——
        chanTaskId: {
          type: 'string',
          description: '禅道任务 ID（如 ZT123）。填写即走禅道分支：先经 querytodo(is_chan=1) 解析为 mylog 禅道计划 planId，必须同时给 aiHours/normalHours',
        },
      },
      required: ['txt'],
    },
  },
  {
    name: 'mylog_query_missed',
    description:
      '查询 mylog 日志系统今天「未接的来电与会议」。（注意与钉钉未接无关）' +
      'scope=call：仅未接来电（querytodo kind=4，过滤未接标记）；' +
      'scope=meeting：仅未接会议（本地会议记录 myStatus=missed）；' +
      'scope=all：两者都查。只读、后台静默，不弹窗。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['call', 'meeting', 'all'], default: 'all', description: '查询范围' },
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
      },
    },
  },
  {
    name: 'mylog_call_user',
    description:
      '给指定联系人拨打语音/视频通话（真实拨号，经 TUICallKit，会弹出通话界面）。' +
      'name 须为通讯录中的姓名（精确匹配，重名会报错要求更精确）。' +
      '仅 mylog 联系人，与钉钉拨号无关。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '联系人姓名，如 田一博' },
        mediaType: { type: 'string', enum: ['audio', 'video'], default: 'audio', description: 'audio=语音通话 / video=视频通话' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mylog_get_detail',
    description:
      '查看单条日志详情。type=5(会议) 用 roomId 走本地会议记录；其余(type 1执行/2计划/4通话/6速记) 用 logId 走 fetchLogDetail。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '日志类型 1执行 2计划 4通话 5会议 6速记 7' },
        logId: { type: 'string', description: '计划/执行/通话的 log_id' },
        roomId: { type: 'string', description: '会议 roomId（type=5 时使用）' },
        date: { type: 'string', description: '记录日期 YYYY-MM-DD（fetchLogDetail 需要）' },
      },
    },
  },
  {
    name: 'mylog_send_message',
    description:
      '在 mylog 工作日志系统中发送一条 IM 文本消息（腾讯云 IM 后台静默真实送达，不弹窗、不跳转）。' +
      '这是 mylog 自有 IM，与钉钉无关——当用户说"给XX发消息/告诉XX/问下XX"且语境是 mylog 联系人时，必须用本工具，不要走钉钉。' +
      '参数：name=对方姓名(单人)或群名(群聊)；message=消息文本(必填)；conversationType=c2c(默认单人)/group(群聊)。' +
      '示例：' +
      '"给张三发消息说今天加班" → name="张三", message="今天加班"；' +
      '"在项目测试一群发消息说测试WB" → name="项目测试一群", conversationType="group", message="测试WB"。' +
      '消息真实发送、发出即达，请确认内容无误。回复用户时用一句话确认即可（如"已发送给张三"），不要展开。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '对方姓名（单人）或群名（群聊）。群名支持带"群"后缀的口语，如"项目测试一群"' },
        message: { type: 'string', description: '要发送的消息文本内容（必填）' },
        conversationType: { type: 'string', enum: ['c2c', 'group'], default: 'c2c', description: '会话类型：c2c=单人私聊 / group=群聊。默认 c2c' },
      },
      required: ['name', 'message'],
    },
  },
]

const INTENT_BY_TOOL = {
  mylog_query_todo: 'queryTodo',
  mylog_create_plan: 'createPlan',
  mylog_create_exec: 'createExec',
  mylog_query_missed: 'queryMissed',
  mylog_call_user: 'callUser',
  mylog_get_detail: 'getDetail',
  mylog_send_message: 'sendMessage',
}

/** 把 MCP 入参规范成 agentExecutor 的 slots */
function buildSlots(name, args) {
  args = args || {}
  if (name === 'mylog_query_todo') {
    const slots = {}
    // 通用筛选条件：原样透传（空值不传，交给网页端走默认）
    const strFields = [
      'date', 'dateFrom', 'dateTo', 'kind', 'planStatus', 'planRel',
      'isImportant', 'isChan', 'keyword', 'viewedUserId',
      'deadlineFrom', 'deadlineTo', 'sortBy', 'preset',
    ]
    for (const f of strFields) {
      if (args[f] !== undefined && args[f] !== null && args[f] !== '') slots[f] = String(args[f])
    }
    if (args.countOnly !== undefined) slots.countOnly = args.countOnly === true || args.countOnly === 'true'
    const size = parseInt(args.size, 10)
    if (Number.isFinite(size)) slots.size = Math.min(Math.max(size, 1), 100)
    const page = parseInt(args.page, 10)
    if (Number.isFinite(page)) slots.page = Math.max(page, 1)
    return slots
  }
  if (name === 'mylog_query_missed') {
    const slots = {}
    if (args.scope) slots.scope = String(args.scope)
    if (args.date) slots.date = String(args.date)
    return slots
  }
  if (name === 'mylog_call_user') {
    const nameVal = String(args.name || '').trim()
    if (!nameVal) throw new Error('参数 name 不能为空')
    return { name: nameVal, mediaType: args.mediaType === 'video' ? 'video' : 'audio' }
  }
  if (name === 'mylog_get_detail') {
    const slots = {}
    if (args.type !== undefined && args.type !== null && args.type !== '') slots.type = String(args.type)
    if (args.logId) slots.logId = String(args.logId)
    if (args.roomId) slots.roomId = String(args.roomId)
    if (args.date) slots.date = String(args.date)
    return slots
  }
  if (name === 'mylog_send_message') {
    const nameVal = String(args.name || '').trim()
    const message = String(args.message || '').trim()
    if (!nameVal) throw new Error('参数 name 不能为空')
    if (!message) throw new Error('参数 message 不能为空')
    return {
      name: nameVal,
      message,
      conversationType: args.conversationType === 'group' ? 'group' : 'c2c',
    }
  }
  const txt = String(args.txt || '').trim()
  if (!txt) throw new Error('参数 txt 不能为空')
  const projectIds = Array.isArray(args.projectIds) ? args.projectIds : []
  const slots = { txt, projectIds }
  if (args.date) slots.date = String(args.date)
  if (name === 'mylog_create_exec') {
    if (args.relatePlanId) slots.relatePlanId = String(args.relatePlanId)
    if (args.planKeyword) slots.planKeyword = String(args.planKeyword)
    if (args.planStatus) slots.planStatus = String(args.planStatus)
    if (args.defermentDate) slots.defermentDate = String(args.defermentDate)
    if (args.aiHours !== undefined) slots.aiHours = Number(args.aiHours)
    if (args.normalHours !== undefined) slots.normalHours = Number(args.normalHours)
    if (args.chanTaskId) slots.chanTaskId = String(args.chanTaskId)
  }
  return slots
}

async function callTool(name, args) {
  const intent = INTENT_BY_TOOL[name]
  if (!intent) throw new Error('UNKNOWN_TOOL: ' + name)
  const slots = buildSlots(name, args)
  log('callTool', name, '-> intent', intent, 'slots', JSON.stringify(slots))
  const data = await getBridge().sendIntent(intent, slots)
  return data
}

// ---- JSON-RPC over stdio ----
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch (_) {
      continue
    }
    handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))

async function handle(msg) {
  const id = msg.id
  try {
    if (msg.method === 'initialize') {
      const proto =
        msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '2024-11-05'
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: proto,
          capabilities: { tools: {} },
          serverInfo: { name: 'mylog-desktop-assistant', version: '0.1.0' },
        },
      })
      // 预连接桌面端：后台建立 WS，把冷启动（端口探测+建连）移出首条指令的关键路径。
      // 失败静默忽略（桌面端可能尚未启动），getBridge 会在首条 tools/call 时按需重建。
      void getBridge().connect().catch((e) => log('prewarm skipped:', e.message))
    } else if (msg.method === 'notifications/initialized') {
      // 无响应
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = (msg.params || {})
      try {
        const data = await callTool(name, args || {})
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      } catch (e) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: '执行失败：' + e.message }],
            isError: true,
          },
        })
      }
    } else if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else if (id != null) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found: ' + msg.method },
      })
    }
  } catch (e) {
    if (id != null) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message || 'internal error' } })
    }
  }
}

log('mylog-desktop-assistant MCP server started (stdio)')
