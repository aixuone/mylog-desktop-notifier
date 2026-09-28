# 方案：WorkBuddy 聊天驱动 mylog 网页端核心功能

> 目标：让用户用自然语言跟 WorkBuddy 助手聊一句，就能完成 mylog 网页端的 7 项核心功能。
> 原则（已与乔伊确认）：
> 1. **WorkBuddy 不直接调 mylog 后端 API** —— 一律由网页端代发（复用网页已登录态 + 后端鉴权）。
> 2. **通话/会议的媒体跑在桌面端网页内**（Electron + TRTC/TUICallKit 已在桌面端就绪），但 **WorkBuddy 可驱动发起、接听、挂断等替用户操作**。
> 3. **全自主执行**；但语音转文字可能出错，**发起前必须先匹配用户列表**，用确定性匹配 + 回显身份做纠错安全网。

---

## 0. 现有基础（方案不是空谈，全部挂在真实代码上）

| 现有能力 | 位置 | 本方案复用方式 |
|---|---|---|
| 本地 WebSocket 服务 | `main.js:1907` `startWSServer()`，监听 `127.0.0.1:currentWsPort` | Agent 连接器接入同一 WS，复用既有收发管道 |
| 网页↔桌面双向消息 | `handleBrowserMessage`（`main.js:1983`）+ `sendToAppClient()` | Agent 意图经桌面转发到网页，结果原路返回 |
| 通讯录缓存 | `SYNC_CONTACTS` → `notificationCenter.syncContacts()`（`main.js:2025`） | **用户列表匹配的数据源已在桌面端**，无需新建同步 |
| 拼音匹配依赖 | `package.json` 含 `pinyin-pro@^3.29.1` | 语音转文字纠错的中文/拼音模糊匹配直接复用 |
| 通话/会议窗口 | `showCallWindow` / `showMeetingWindow` + `TUICallKit` | 媒体在桌面端网页内跑，WorkBuddy 只发"发起/接听/挂断"指令 |

---

## 1. 总体架构

```
┌─────────────────────┐       ① 自然语言指令        ┌──────────────────────────┐
│   WorkBuddy 聊天      │ ───────────────────────▶  │  Agent 连接器(MCP/Connector) │
│  (NLU + 意图识别)     │ ◀───────────────────────  │  暴露工具: createPlan…      │
└─────────────────────┘       ⑥ 结果回显            └───────────┬──────────────┘
                                                                 │ ② AGENT_INTENT (WS, 127.0.0.1)
                                                                 ▼
                                                    ┌──────────────────────────┐
                                                    │  桌面端 desktop-notifier   │
                                                    │  Agent Gateway(扩展WS)     │
                                                    │  - 识别 agent 连接         │
                                                    │  - 转发意图到网页          │
                                                    │  - 持有通讯录缓存          │
                                                    └───────────┬──────────────┘
                                                                │ ③ sendToAppClient(AGENT_INTENT)
                                                                ▼
                                                    ┌──────────────────────────┐
                                                    │  mylog-pc 网页端(已登录)   │
                                                    │  Agent Bridge 模块         │
                                                    │  - 调业务 API(代发)        │
                                                    │  - 调 TUICallKit/TRTC      │
                                                    │  - 回 AGENT_RESULT         │
                                                    └───────────┬──────────────┘
                                                                │ ④ 业务API / 媒体
                                                                ▼
                                                    ┌──────────────────────────┐
                                                    │  mylog 后端(数据真源)      │
                                                    │  tenant-id + authorization │
                                                    └──────────────────────────┘
       ⑤ AGENT_RESULT 沿 ②←③←④ 原路返回至 WorkBuddy
```

**三端职责**
- **WorkBuddy（对话层）**：语义理解、意图/槽位抽取、用户列表匹配、结果渲染。**不持有业务数据、不直连 API**。
- **桌面端（桥接层）**：Agent Gateway 接入、意图转发、来电时反向通知 WorkBuddy。
- **网页端（业务层）**：真正执行业务——调后端 API（代发）、驱动 TUICallKit/TRTC 媒体、回传结构化结果。

---

## 2. 通信协议：在现有 WS 上扩展 Agent Gateway

不新增独立服务，复用桌面端现有 WS（已绑 `127.0.0.1`）。WorkBuddy 连接器以 `browserType:'agent'` 注册为特殊的 Agent 客户端。**无 token**：本地边界由 `127.0.0.1` 绑定 + 连接 UA 区分（应用窗口 UA 含 `MylogDesktop`，连接器为非 Electron UA）保证，业务权限仍由后端 RBAC 决定。

**新增消息类型**
| type | 方向 | 说明 |
|---|---|---|
| `REGISTER{browserType:'agent'}` | 连接器→桌面 | 桌面按 browserType 标记为 agent 客户端 |
| `AGENT_INTENT{requestId, intent, slots}` | 连接器→桌面→网页 | 一条用户意图，如 `{intent:'startCall', slots:{targetUserId:'u_8821'}}` |
| `AGENT_RESULT{requestId, ok, code, message?, data?}` | 网页→桌面→连接器 | 执行结果（结构化） |
| `AGENT_EVENT{eventId, type, payload}` | 网页→桌面→连接器 | 异步事件，如 `incoming_call` / `call_ended` |

### 2.1 无 Token 设计（本地边界说明）

**本期不引入任何 token。理由：**

- WS 仅绑 `127.0.0.1`，外部机器不可达；同机其它进程若要连接，需具备本地访问能力——此时是否加 token 对"同用户进程"无实质阻挡（token 同样可被该用户进程读取）。
- 两类连接已通过**连接 UA 区分**，无需 token：
  - 应用窗口（Electron 内网页）：WS 升级请求 UA 含 `MylogDesktop` → `isAppWindow=true`；
  - 连接器（Node `ws`）：非 Electron UA → `isAppWindow=false`，且 `REGISTER` 时 `browserType==='agent'` → `isAgent=true`。
  - 中继据此把 `AGENT_INTENT` 只发给应用窗口、把结果/`AGENT_EVENT` 只路由回连接器，互不串台。
- **真实权限永远在后端**：所有意图最终以网页已登录用户身份代发，后端用 `tenant-id+authorization` 校验 RBAC，Agent 无法越权。

> 若未来连接器需**跨机**访问，则必须升级为 `wss://` + 显式配对（届时再恢复令牌），本期默认同机，故不实现。

### 2.2 意图转发详细设计（鲁棒性核心）

桌面在转发时承担"可靠交换机"职责，逐条防呆：

1. **协议版本门控**：`REGISTER` 带 `protoVersion`，桌面拒绝不兼容版本（防旧连接器误发新字段）。
2. **意图注册表（allowlist）**：桌面维护 `SUPPORTED_INTENTS`，未知意图直接 `UNKNOWN_INTENT` 拒绝（安全+防呆）。
3. **请求关联**：每个意图带 `requestId`(UUID)。桌面维护 `pendingRequests: Map<requestId,{ws,timer}>`，`AGENT_RESULT` 按 id 路由回对应连接器连接并清理，**杜绝串话**。
4. **超时释放**：默认 `AGENT_TIMEOUT=30s`（媒体类可调长）。超时→向连接器返回 `{ok:false,code:'TIMEOUT'}` 并清理，避免连接悬挂。
5. **连接状态门控**：转发前检查 `hasAppClient()`（网页是否在线）。不在线→立即返回 `{code:'WEB_OFFLINE', hint:'请先打开并登录 mylog 网页'}`，**绝不静默丢弃或排队**（排队会造成"用户忘了刚才说啥"的乱序）。
6. **Schema 校验**：桌面对 `intent`+`slots` 做轻量结构校验（必填/类型），非法→`BAD_REQUEST` 早失败；网页侧二次校验防御。
7. **结构化错误码**：统一 `AGENT_RESULT{ok,code,message,data}`，code 取固定枚举（`WEB_OFFLINE/TIMEOUT/BAD_REQUEST/AUTH_FAIL/EXEC_FAIL/UNKNOWN_INTENT/CONFLICT`…），连接器转友好提示，不暴露内部栈。
8. **异步事件通道**：`AGENT_EVENT` 与请求解耦，按 `eventId` 去重后直推连接器（来电/通话结束/计划后续状态），不阻塞请求通道。
9. **重连与幂等**：连接器断线重连后重新 `REGISTER`（无需重配对）；桌面按 `requestId` 去重，重复 id 忽略，支持连接器安全重试。
10. **审计日志**：桌面记录每条意图 `{ts,requestId,intent,slots(脱敏),result,costMs}`，落本地日志便于运营排查。

**运营错误清单（防呆表）**

| 场景 | 现象 | 处理 |
|---|---|---|
| 网页未打开/未登录 | 意图无响应 | 门控返回 `WEB_OFFLINE` + 提示 |
| 网页加载中/重载 | 间歇断连 | 同上；连接器提示"请等网页就绪" |
| 网络抖动/WS 闪断 | 请求中途断 | 超时 `TIMEOUT`；连接器可幂等重试 |
| 用户重名 | `resolveUser` 多候选 | 返回候选，WorkBuddy 让用户选（见 §5） |
| 意图字段缺失/类型错 | 网页执行报错 | `BAD_REQUEST` 早失败 |
| 未知意图（拼写错） | — | `UNKNOWN_INTENT` + 支持列表 |
| 后端业务报错（无权限/参数错） | 网页执行失败 | `EXEC_FAIL` + 后端 message |
| 通话/会议长连接 | 媒体进行中 | 不阻塞，靠 `AGENT_EVENT` 推状态 |
| 桌面重启 | 连接器掉线 | 连接器自动重连 + 重新 REGISTER |

### 2.3 桌面端新增逻辑（概念，非代码）
- `handleBrowserMessage` 增加 `AGENT_INTENT` 分支：版本+allowlist 校验→`hasAppClient()` 门控→`sendToAppClient({type:'AGENT_INTENT',...})`（网页已连 App 窗口），并登记 `pendingRequests`。
- 网页回 `AGENT_RESULT` 时，桌面按 `requestId` 路由回连接器连接并清理 timer。
- `resolveUser(query)`：基于 `notificationCenter` 已缓存通讯录 + `pinyin-pro`，返回**候选集合**与置信度（见 §5）；不在此做最终抉择，抉择交 WorkBuddy 对话层。

---

## 3. 功能映射表（WorkBuddy ↔ 桌面端 ↔ 网页端，覆盖 7 项）

| # | 能力 | WorkBuddy 工具(意图) | 桌面端动作 | 网页端执行 | 后端/媒体 |
|---|---|---|---|---|---|
| 1 | 创建计划 | `createPlan{title,dateRange,participants?}` | 转发意图；participants 先经 `resolveUser` | 计划 API 代发（POST /plan） | 后端建计划，返回 planId |
| 2 | 创建执行任务 | `createTask{title,assignee,dueDate,planId?}` | 转发；**assignee 必经 `resolveUser`** | 任务 API 代发（POST /task） | 后端建任务，指派到人 |
| 3 | 查看待办 | `listTodos{scope,date?}` | 转发 | 待办 API（GET /todos） | 返回待办列表 |
| 4 | 查看业务数据 | `queryData{domain,filters,dateRange}` | 转发 | 数据 API（GET /report/...） | 返回数据集 |
| 5 | 发起语音通话 | `startCall{target,type:'voice'}` | 转发；target 经 `resolveUser` | `TUICallKitAPI.call(userId,'voice')` | 媒体在桌面端网页(TRTC) |
| 6 | 发起会议 | `startMeeting{participants,title?}` | 转发；逐人 `resolveUser` | `TUIRoomKit`/TRTC 建房 + 邀请 | 媒体在桌面端网页 |
| 7 | 查看统计 | `getStats{metric,dateRange,dimension}` | 转发 | 统计 API（GET /stats/...） | 返回指标 |
| + | 接听/挂断通话 | `answerCall{callId?}` / `hangupCall{}` | 转发（或桌面直接驱动 call/meeting 窗口） | `TUICallKitAPI.accept()/hangup()` | 媒体控制 |
| + | 来电感知 | （事件驱动） | 收到 `SHOW_CALL_NOTIFICATION` 时推 `AGENT_EVENT:incoming_call` | — | WorkBuddy 可主动问"要接听吗？" |

> 全部 7 项 + 通话生命周期控制，均已映射，无遗漏。

---

## 4. 聊天指令触发流程（端到端时序，以"给张三发起语音通话"为例）

```
用户(语音): "给张三打个语音"
   │  [WorkBuddy NLU]
   ▼
意图=startCall, slots={target:"张三"}        ← 注意：语音结果是"张三"文本，可能原是"张伞"
   │
   ▼  ② 调用 resolveUser("张三")
桌面返回: [{userId:u_8821, name:"张三", conf:0.98}]   ← 拼音/中文精确命中
   │
   ▼  ③ 连接器发 AGENT_INTENT{intent:'startCall', slots:{targetUserId:'u_8821'}}
桌面 → 网页 AGENT_INTENT
   │
   ▼  ④ 网页 Agent Bridge 调 TUICallKitAPI.call('u_8821','voice')
桌面端网页内 TRTC 建立媒体（铃声/接通在桌面端）
   │
   ▼  ⑤ 网页回 AGENT_RESULT{ok:true, data:{callId, status:'calling'}}
桌面 → 连接器 → WorkBuddy
   │
   ▼  ⑥ WorkBuddy 回显："已为你呼叫 张三（工号 u_8821），媒体在桌面端接通中 📞"
```

**各能力触发流程共性**：NLU 抽意图/槽位 → 涉及"人"的槽位先 `resolveUser` → 发 `AGENT_INTENT` → 网页代发/驱动 → `AGENT_RESULT` 回显。读类（待办/数据/统计）无"人"槽位则跳过匹配直发。

---

## 5. 用户列表匹配（语音纠错 + 重名安全网）

**数据源**：桌面端 `notificationCenter` 已缓存的通讯录（`SYNC_CONTACTS` 已在跑），无需新建同步。

**`resolveUser` 返回候选集合（确定性，非 LLM 猜）**
1. 精确相等（中文全名）→ `HIGH`
2. 拼音全拼/首字母（`zhangsan` / `zs` → 张三，用 `pinyin-pro`）→ `MEDIUM-HIGH`
3. 包含匹配 / 近似（编辑距离）→ `MEDIUM`
4. 否则 `LOW`

**关键：返回的是"候选集合"，不是"单个答案"。** 重名（同显示名、不同 userId）即使完全精确命中，结果里也会有多个 userId——这是常见情况，必须交用户选择。

**抉择规则（鲁棒性优先）**
- **唯一且置信 ≥ MEDIUM**（`resolveUser` 仅 1 个 userId，且无重名）→ **自动执行**，结果中回显已解析身份（"已呼叫 张三（u_8821·销售部）"），便于发现错误。
- **多候选 / 重名 / 低置信** → **不自动执行**，WorkBuddy 列出候选并请用户点选：
  > 「有 2 位『张三』，选哪个？① 张三·销售部 ② 张三·工程部」
  
  用户回复序号或姓名后即继续，**这是纠错而非审批**，不阻断"全自主"主线。
- 候选展示需带**区分属性**（部门/职位/手机号尾号/头像），让用户能分辨重名者。
- 选定后可**在本次对话内记住映射**（"以后『张三』默认指销售部那位？"），减少重复询问；跨对话不持久化（隐私 + 防误用）。

**为什么抉择放 WorkBuddy 而非桌面**：只有对话层能和用户交互；桌面只提供确定性 `resolveUser` 纯函数（可单测、可复用），UX 判断留在聊天层。职责清晰、易扩展新匹配策略。

---

## 6. 数据同步范围

| 数据 | 真源 | WorkBuddy 侧 | 同步方式 |
|---|---|---|---|
| 计划/任务/待办 | 后端（网页代发写入） | 不存储，仅展示返回结果 | 按需查询，结果随消息返回 |
| 业务数据/统计 | 后端 | 不存储 | 按需查询 |
| 通话/会议记录 | 后端 + 桌面端媒体状态 | 不存储 | 事件通知（`AGENT_EVENT`） |
| 通讯录（用于匹配） | 网页 → 桌面缓存 | 桌面持有，连接器借 `resolveUser` 用 | `SYNC_CONTACTS` 现有管道 |
| 对话上下文（如"刚才那个计划"） | WorkBuddy 会话 | 仅存 requestId/planId 引用 | 内存，会话结束即弃 |

**关键约定**
- **单一真源 = 后端**。Agent 创建的项立即在网页可见（网页重新拉取），无离线合并、无冲突。
- WorkBuddy **不持久化任何业务数据**，只在对话内存里保留最近一次创建的 `planId/taskId` 以支持"给刚才的计划加条任务"这类指代。
- 既有的「我的日志项目同步计划」技能（计划单向同步到 WorkBuddy 计划做展示）可保留为可选增强，不影响本方案的权威链路（网关→网页→后端）。

---

## 7. 权限控制

**两层权限，互不替代**

1. **身份层（继承登录态）**：所有 Agent 动作经网页已登录用户发起，后端 `tenant-id:81 + authorization` 鉴权，**用户只能做自己有权限做的事**（RBAC 由后端强制）。Agent 不绕过任何后端权限。

2. **本地 Agent 策略层（桌面端配置）**：`config.js` 增加 `agent` 段：
   - `enabled`：总开关
   - `allowedIntents`：白名单（默认开放 7 项 + 接听/挂断）
   - `requireConfirm`：危险操作清单（见下）
   - 注：本期**不配置 token**（见 §2.1 无 Token 设计）；本地边界由 `127.0.0.1` + UA 区分提供。

**危险操作确认策略（呼应既有钉钉策略：删除/撤回/移除等高危需确认）**
- 自主执行：创建计划/任务、查看待办/数据/统计、发起语音/会议、接听/挂断。
- **需二次确认**：删除计划/任务、撤回消息、移除成员、群发/批量指派、修改他人数据。即使"全自主"，这类不可逆/影响他人动作仍先回显摘要请用户确认，与既有约定一致。
- 来电接听属于替用户操作，默认自主；但若通话来自非常规联系人可加提示。

**网络安全**：Agent Gateway 仅绑 `127.0.0.1`，外部不可达；两类连接以 UA 区分（应用窗口 `MylogDesktop` / 连接器非 Electron）。未来若需远程，须走隧道 + 强化鉴权（本期不涉及）。

---

## 8. 能力覆盖总览（核对清单）

### 实际落地状态（P0，已实现）
- [x] **查看待办事项** → `queryTodo`（后台静默，`workCalendar.querytodo` headless 调用）
- [x] **创建计划** → `createPlan`（后台静默，`addLogRecord` type=2）
- [x] **创建执行任务** → `createExec`（后台静默，`addLogRecord` type=1）
- [x] 网页端 Agent 处理骨架：`desktop-notifier.ts` 的 `AGENT_INTENT` 分支 + `commands/agentExecutor.ts` 执行器（按 intent 分派，后台静默回传）
- [x] 桌面端中继：`main.js` 的 `AGENT_INTENT`/`AGENT_RESULT` 转发（requestId 关联 + `WEB_OFFLINE` 门控 + `TIMEOUT` 释放）
- [x] 连接器客户端：`lib/agent-bridge.js`（无 token；HTTP 握手发现 WS 端口 + 按 requestId 收结果）
- [x] **端到端联调验证通过（2026-09-15）**：`node scripts/test-agent-bridge.js` 跑通三条链路——queryTodo 返回真实后端 total=3732、createPlan/createExec 后台静默写入并返回真实 id，全程无页面跳转。验证环境：本机 5173 dev server（含新代码）+ 真实后端 API + 桌面端 WS 中继（19789/18999）。

### `queryTodo` slots 全量参数（2026-09-15 增强）
网页端 `agentExecutor.execQueryTodo` 现已透传 `workCalendar.querytodo` 的全部查询条件，并新增单日 `date` 便捷参数与标签预设 `preset`：

| slots 字段 | 说明 | 备注 |
| --- | --- | --- |
| `preset` | 标签预设名/英文名/标签 id | 未完成计划 / 已完成计划 / 计划外执行 / 通话 / 打卡 / 速记 / 重要；解析为对应 `DEFAULT_GROUP_TAGS.filter`，显式条件优先覆盖 |
| `date` | 单日 YYYY-MM-DD | 等价于 `dateFrom=dateTo=date`；与 dateFrom/dateTo 二选一 |
| `dateFrom` / `dateTo` | 日志日期范围 | 含当日 |
| `kind` | 类型 `1执行 2计划 3打卡 4通话 5视频会议 6速记 7` | 逗号分隔；`all`=全部 |
| `planStatus` | 计划状态 `0未开始 1已完成 2已延期 3部分完成 4已取消 5` | 逗号分隔；`all`=不限 |
| `planRel` | 计划关联 `0计划外 / 1计划内` | 仅 kind 含 1 时有效 |
| `isImportant` | `0 / 1` | 是否重要 |
| `isChan` | `0 / 1` | 是否禅道 |
| `keyword` | 关键字 | 匹配内容/项目名/模块名 |
| `viewedUserId` | 查看同事的待办 | 缺省=当前登录用户 |
| `deadlineFrom` / `deadlineTo` | 计划 deadline 范围 | — |
| `sortBy` | `deadline_asc/deadline_desc/status_deadline/created_desc` | — |
| `countOnly` | `true`=仅返回总数 | — |
| `ids` | log_id 数组 | 与其他筛选互斥（手动标签模式） |
| `size` / `page` | 分页 | size 默认 10 上限 100 |

**固化口语捷径（2026-09-15 新增）**：`preset` 除标签预设外，新增两个组合捷径，把「标签筛选条件 + 日期语义」打包，WorkBuddy 直接用口语即可触发，无需手动拼 `date`：

| 捷径 preset | 等价条件 | 口语别名 |
| --- | --- | --- |
| `今天的计划` | kind=2, planStatus=0,3,5（未完成计划），且 记录日期=今天 | 今天的计划 / 今天有什么计划 / 今天有哪些计划 / 今天要做的计划 / 今日计划 |
| `今天及以后的计划` | kind=2, planStatus=0,3,5（未完成计划），且 记录日期>=今天（无上限） | 今天及以后的计划 / 今天及之后的计划 / 未来计划 / 未到期计划 / 今后计划 / 后续计划 / 近期计划 |

优先级：`date`/`dateFrom`/`dateTo` 显式 > 捷径自带 `dateMode` > 无日期。捷径已内置日期语义，调用时不要额外传 `date`/`dateFrom`/`dateTo`（会被忽略优先级）。

**特殊分支**：`kind` 锁定为 `3`（打卡）时，执行器改走 `fetchClockPositionResult` 专用接口（按日期范围逐日聚合），不走 `querytodo`。

### 规划中（P1+）
- [ ] 查看业务数据 → `queryData`
- [ ] 发起语音通话 → `startCall`（媒体在桌面端，需验证 TUICallKit 程序化调用）
- [ ] 发起会议 → `startMeeting`（媒体在桌面端）
- [ ] 查看统计 → `getStats`
- [ ] 通话生命周期：接听/挂断（`answerCall`/`hangupCall`）+ 来电感知（`AGENT_EVENT`）
- [ ] 语音纠错：涉及"人"的意图发起前 `resolveUser` 匹配通讯录（重名需用户选）
- [x] 数据同步范围与权限控制：§6 / §7 已定义

---

## 9. 实施分期

- **P0 桥接打通（已完成代码 + 已端到端联调验证 ✅）**：桌面端扩展 `AGENT_INTENT`/`AGENT_RESULT` 中继；连接器客户端 `lib/agent-bridge.js`；网页端 Agent 处理骨架（`desktop-notifier.ts` + `commands/agentExecutor.ts`）；落地 `queryTodo` / `createPlan` / `createExec` 三条后台静默链路。已于 2026-09-15 通过本地 5173 dev server + 真实后端 API 完成端到端联调，三条链路均真实返回数据。
- **P1 全能力**：补齐 `queryData/startCall/startMeeting/getStats`；来电 `AGENT_EVENT` 主动提示。
- **P2 健壮性**：`resolveUser` 多候选交互、危险操作确认、错误回显与重试。
- **P3 体验**：对话内卡片渲染（计划链接/待办列表/统计图表）、多轮指代（"刚才那个计划"）。

> 注：早期文档把"创建执行任务"记为 `createTask`、"查看待办"记为 `listTodos`，实际 P0 落地命名为 `createExec` / `queryTodo`（与 `workCalendar` 底层 API 对齐），以代码为准。已于 2026-09-15 通过本地 5173 dev server（含新代码）+ 真实后端 API 完成端到端联调验证，三条链路均真实返回数据；线上正式发版仍需用户侧上传 zip + 改回 settings 到 `https://data.tygps.com/mylog-pc/`。

## 10. 分层取舍：为何该设计最鲁棒 / 可靠 / 可扩展

- **桌面端 = 常驻安全中继**：桌面进程只要 app 运行就常驻，比"网页是否加载"更稳定 → **可靠性**最佳；通讯录缓存（如引入 `resolveUser`）与网页状态解耦（网页重载也不丢解析能力）。
- **网页端 = 唯一执行权威**：所有写操作/媒体都在网页，复用已登录态与后端 RBAC，**权限单一真源**，避免多处实现权限逻辑 → **鲁棒性**。
- **WorkBuddy = 对话编排 + 歧义 UX**：NLU、多轮指代、重名选择都在聊天层，天然适配"和人交互" → **可扩展性**（加新意图只需登记 + 网页实现，桌面仅做 allowlist 透传）。
- 对比"全部塞进网页"：网页是远程页、会重载，作为本地 Agent 鉴权锚点不如常驻桌面稳；对比"全部塞进 WorkBuddy"：需把通讯录/拼音匹配搬去云端，增加同步负担与数据外泄面。故当前分层在三维上最优。

## 11. 网页端交互形态：前台跳转 vs 后台静默

按"是否打扰用户当前操作"把 7 项能力分成两类，Agent Bridge 执行时必须走对应模式：

| 类别 | 能力 | 网页表现 |
|---|---|---|
| **前台跳转** | 发起语音通话、发起会议（及接听/挂断） | 桌面 `focusMainPage()` 置前主窗口 → 网页**跳转到通话/会议界面**并唤起 TUICallKit/TRTC 媒体 UI。用户必须看到并可与媒体交互（麦克风/摄像头/挂断）。 |
| **后台静默** | 创建计划、创建执行任务、查看待办、查看业务数据、查看统计 | 网页**不发生任何视图变化**：Agent Bridge 直接调 Pinia store action / API client 完成写入或查询，结果以 `AGENT_RESULT` 回传 WorkBuddy 在聊天里渲染。**不弹窗、不导航、不闪烁**。用户停留在原页面。 |

**实现要点（避免"数据类也跳页面"的失误）**
- 数据类执行路径必须**绕过 UI 流程**：直接调用与"新建弹窗提交"相同的 store action / API，而非模拟点击或打开 modal。即页面要存在"无界面也能建计划/查数据"的代码入口。
- 若某创建流程当前强耦合 UI（只能在弹窗里点），需先抽出一个 headless 函数供 Agent 调用——这是 P0/P1 的改造点之一。
- 前台类需确保：① 主窗口从隐藏/最小化恢复并置前；② 路由跳转到通话/会议视图；③ 媒体 SDK 正常初始化（依赖桌面端已就绪的 screenshare-shim / TRTC 环境）。

---

## 12. 代码验证结论（2026-09-10 直接读 `web/` 源码核实）

> 目的：回答方案评审里"三个技术真值 + 通讯录来源 + 桌面中继"是否属实。结论：**方案可行，且风险比原评估低得多——网页侧已把执行层、通讯录、媒体发起都做好了，几乎不用从零造轮。**

### 12.1 验证结果总表

| 验证项 | 原假设风险 | 代码核实结果 | 缺口 |
|---|---|---|---|
| ① 网页 WS 入口是否常驻 | 中低 | ✅ `utils/desktop-notifier.ts` 是常驻客户端：`initNotifier` 登录后调用，`connect()` 指数退避重连(≤10次)→握手重试；30s PING/PONG 心跳；`beforeunload` 才销毁 | 仅缺 1 个下行分支：`onMessage` 目前只处理 `USER_ACTION/PONG/CONNECTED`，**无 `AGENT_INTENT` 分支**（约 20 行） |
| ② TUICallKit 能否程序化发起 | 中 | ✅ `commands/callActions.ts` 的 `startCall()` 直接 `await TUICallKitAPI.calls({userIDList, type, strRoomID, offlinePushInfo})`，**不依赖任何按钮**；会议 `startMeetingWith/createMeeting/joinMeetingByRoomId` 调 `conferenceStore.openConference(...)` 也是 store action | 无 |
| ③ 数据类 headless 路径 | 中 | ⚠️ 部分满足。命令系统 handler **全是 `router.push` 跳转**（见下）；但真正的 headless 提交函数是 `api/workCalendar.ts` 的 `addLogRecord({date, txt, type, pEstimate…})`（type=2 计划 / 1 执行），Agent 可直接调它**不触发任何 UI** | 数据类命令当前强制跳页；"查看业务数据/统计"**命令系统完全没有对应项** |
| ④ 通讯录来源（是否组织目录） | — | ✅ `stores/contacts.ts` 数据源 = `getCallParticipants()`（后台个人通讯录），含 `person_id / person_name / mobile_account(→imUserId) / department / org_name`，是**全员组织目录非 IM 好友**；`registeredIM=!!imUserId` 决定能否被通话/邀请 | 重名必然存在（`byImUserId` 按 imUserId 查，按姓名查会多命中）→ 印证 §5 重名必须用户选 |

### 12.2 关键发现：网页侧已存在"Agent 执行层"

`src/commands/` 是一套完整命令系统，**`registry.ts` 注释明写"供 WorkBuddy 桌面端 skill 连接调用"**：

- `runCommandById(id, {target?, roomId?})`（`registry.ts:41`）—— 按命令 id 程序化执行，含 `targetMode` 校验（person 需 target / roomId 需 roomId）。**这正是方案里"网页执行层"的现成实现**。
- 命令 id 已规范化，与方案映射一一对应：
  - `calendar.plan.create` 创建计划 · `calendar.exec.create` 创建执行任务
  - `call.voice` / `call.video` 发起语音/视频通话 · `call.meeting.create` / `call.meeting.join` 会议
  - `record.call` / `record.note` / `record.checkin` 查看记录（待办/通话/速记/打卡）
  - `buildPersonActions(person)` 生成"对某人能做之事"列表（发消息/通话/会议/看日程…），含重名无关但 `registeredIM` 过滤
- `PersonTarget` 结构 = `{personId, imUserId, name, avatar, registeredIM}` —— 与 `resolveUser` 输出契约一致（方案 §5 直接复用）。

**结论：网页侧"接收意图→执行"的执行层已 95% 就绪，唯一缺的是 WS 下行入口（12.1①）。**

### 12.3 不满足项 & 必须新增的代码（P0 落地清单）

1. **网页 `desktop-notifier.ts.onMessage` 加 `AGENT_INTENT` 分支**：解析 `{intent, slots, requestId}` → 调 `runCommandById` 或直查 API → 发 `AGENT_RESULT{requestId, ok, data/error}` 回桌面。
2. **桌面 `handleBrowserMessage` 加三件事**（main.js:1983 附近）：
   - 识别 connector 连接（新增 client 类型，非 `isAppWindow`）；
   - 收到 `AGENT_INTENT` → `sendToAppClient(...)` 转发到网页（复用 line 755 现成函数 + line 766 `hasAppClient()` 门控）；
   - 收到 `AGENT_RESULT`（来自网页）→ 按 `requestId` 路由回对应 connector 连接。
3. **数据类"headless 模式"改造**：数据类意图**不**走 `router.push`，改为直调 `addLogRecord` / 查询 API，把结果塞进 `AGENT_RESULT`。这是 §11 后台静默要求的落地关键。
4. **新增"查询类"命令**补齐用户第 3、7 项能力：
   - 查看待办 → 复用 `fetchPlansByMonth` / calendar store（headless 查询，不跳 `/todo`）；
   - 查看业务数据/统计 → 现有底层数据在 `api/projectGroup.ts`（`WorkhourBoard` 计划/已耗/剩余工时）与 `api/workCalendar.ts`（工时 effort），需新增查询命令 + headless 取数，结果回传聊天渲染。
5. **`resolveUser` 用 `contacts.ts` 做姓名→`PersonTarget` 解析**：候选集合（同名多命中→用户选），保留 `registeredIM` 区分（无 IM 者通话/会议意图应拒绝并提示）。

### 12.4 总体判定

- **架构正确、落地量小**：核心执行层（命令系统 + `startCall` + `addLogRecord` + 通讯录）已存在，方案不是"设计愿景"而是"拼接既有零件"。
- **三个未知项结果**：① WS 常驻 ✅ 缺口仅 1 个 case；② 程序化发起 ✅ 已证实；③ headless 路径：创建已存在（headless API）、查看待办可用、**但业务数据/统计缺命令且所有数据类命令当前强制跳页**（需 12.3-③④ 改造）。
- **真正的净新增工作量**集中在：WS 下行入口（网页 1 处 + 桌面 3 处）、数据类 headless 模式、查询类命令。均属确定改造，无技术不确定性。
- **建议下一步**：按 12.3 的 P0 清单落地一条最小端到端链路（`listTodos` 或 `startCall`），先打通"连接器→桌面→网页→结果回传"全管道，再横向铺开 7 项能力。

---

## 13. WorkBuddy 真连接器（MCP server）落地（2026-09-15 ✅ 已实现并验证）

**背景**：P0 的"能力管道"（`lib/agent-bridge.js` → 桌面 WS → 网页 `agentExecutor` → 真实后端）已于 09-15 端到端验证通过，但 `agent-bridge.js` 仅是模拟连接器的 Node 脚本——用户尚不能"跟 WorkBuddy 聊天触发"。本章记录"聊天入口"的落地。

### 13.1 形态选择：MCP server（stdio JSON-RPC）

WorkBuddy 已支持 MCP 连接器（用户既有 `API 文档`=Apifox MCP、`figma-dev-mode`）。据此把 mylog 能力做成 MCP server，WorkBuddy 在对话中自动识别并调用工具，无需额外 skill 注入。

### 13.2 新建文件 `lib/mcp-server.js`

- **不依赖 MCP SDK**：手写 stdio 上的 JSON-RPC 2.0（newline-delimited），规避装包失败风险。处理 `initialize / tools/list / tools/call / ping` + 忽略 `notifications/initialized`。
- **复用 `lib/agent-bridge.js`**：`AgentBridge` 负责 HTTP 握手发现 WS 端口 → `REGISTER{ browserType:'agent' }` → `sendIntent(intent, slots)` 按 `requestId` 收 `AGENT_RESULT`。MCP server 只做"协议翻译 + 参数规范化"。
- **暴露 3 个工具**（P0 能力，与 `agentExecutor` 对齐）：
  - `mylog_query_todo`（查询待办，只读，slot: `size`）
  - `mylog_create_plan`（创建计划，slot: `txt, projectIds?`）
  - `mylog_create_exec`（创建执行，slot: `txt, projectIds?`）
  - 每个含中文 `description` + `inputSchema`，供 LLM 准确理解"何时调用"。
- **鲁棒性**：仅 127.0.0.1、无 token（与桌面端一致）；调试日志走 stderr 不污染 stdout JSON 流；模块级 `AgentBridge` 单例，**检测 `readyState !== OPEN` 即重建**，断线自动重连；首次 `tools/call` 才连桌面端（避免桌面端未开时启动失败）。

### 13.3 注册 `~/.workbuddy/mcp.json`

新增 `mylog 桌面助手`（server 名）：
```json
"mylog 桌面助手": {
  "command": "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe",
  "args": ["C:/ixuworkspace/mylog-pc/desktop-notifier/lib/mcp-server.js"],
  "disabled": false
}
```
JSON 校验合法；用 managed node 绝对路径，规避 PATH 不确定。

### 13.4 验证（只读，未污染后端）

`scripts/test-mcp-server.js`（模拟 WorkBuddy stdio 客户端）实测：
- `initialize` → OK（serverInfo `mylog-desktop-assistant`）
- `tools/list` → 返回 3 工具
- `tools/call(mylog_query_todo)` → 真实返回 `total: 3734` 业务数据

**结论**：MCP 协议 + 真实通道双通。用户在 WorkBuddy 对话框直接说"查一下我的待办""帮我建个计划：明天拜访客户""记一条执行：完成设备巡检"，即可经桌面端静默驱动网页执行。

### 13.5 用户启用步骤（必做）

1. **信任连接器**：WorkBuddy 连接器管理页对 `mylog 桌面助手` 点击「信任」启用（改 mcp.json 后不自动激活）。
2. **运行前提**：桌面端须运行 + 加载含 `agentExecutor` 的网页（当前本地 5173；线上发版后 settings 改回 `https://data.tygps.com/mylog-pc/` 即可）。
3. **聊天即用**：自然语言触发，WorkBuddy 自动选工具调用。

### 13.6 仍未做（P1+）

- **`resolveUser` 人名/项目解析**：当前 `createPlan/createExec` 仅把文本写入，未关联联系人/项目（P0 按"全自主+先匹配"要求，P1 须补姓名→`PersonTarget` 解析与重名用户选）。
- **`queryData` 业务数据 / `getStats` 统计**：底层在 `api/projectGroup.ts`(WorkhourBoard) 与 `api/workCalendar.ts`(effort)，需新增工具 + headless 取数。
- **`startCall` 语音 / `startMeeting` 会议 / 接听挂断**：前台跳转类，需补工具并走 `focusMainPage` + TUICallKit/TRTC。
- **危险操作确认**：删除/撤回/移除等不可逆动作二次确认（与既有钉钉策略一致）。

