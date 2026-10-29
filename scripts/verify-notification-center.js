// scripts/verify-notification-center.js
// ─────────────────────────────────────────────────────────────────────────────
// 消息提醒场景全量校验（主进程模型层）
// 对照 docs/notification-center-prd.md 的场景编号逐条断言。
// 用法：node scripts/verify-notification-center.js
// ─────────────────────────────────────────────────────────────────────────────
const Module = require('module')

// ── 可控时钟 ──────────────────────────────────────────────────────────────
let NOW = 1700000000000
Date.now = () => NOW

const timers = new Map()
let tid = 0
global.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: NOW + (ms || 0) }); return id }
global.clearTimeout = (id) => { timers.delete(id) }
function tick(ms) {
  const target = NOW + ms
  for (;;) {
    let pick = null
    for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t }
    if (!pick) break
    timers.delete(pick.id)
    NOW = pick.t.at
    pick.t.fn()
  }
  NOW = target
}

// ── electron 打桩 ─────────────────────────────────────────────────────────
const ipcHandlers = {}
let CURRENT = null          // 当前场景的上下文
const electronStub = {
  ipcMain: { on: (ch, fn) => { ipcHandlers[ch] = fn } },
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}

// ── 假 BrowserWindow（含渲染层协议模拟）──────────────────────────────────
function contentHeight(rows, sys) {
  const rowH = 62, gap = 8
  let c = 0
  if (rows > 0) c += rows * rowH + (rows - 1) * gap
  if (sys > 0) c += sys * 110 + (rows > 0 ? gap : 0)
  if (c === 0) c = 80
  return 48 + 10 + c + 10
}

function replyResize(h) {
  const fn = ipcHandlers['nc-resize']
  if (fn) fn({}, h)
}

function onSend(win, ch, data) {
  const ctx = CURRENT
  ctx.sent.push({ ch, data, t: NOW })
  if (ch === 'nc-state') {
    const rows = (data.unread || []).length
    const sys = (data.sysAlerts || []).length
    ctx.renderH = contentHeight(rows, sys)
    replyResize(ctx.renderH)       // 真实渲染层：内容变化 → 实测回传
  } else if (ch === 'nc-measure') {
    replyResize(ctx.renderH || contentHeight(0, 0))
  } else if (ch === 'nc-show') {
    ctx.showEvents++
  } else if (ch === 'nc-play') {
    ctx.plays++
  }
}

function makeBWClass(ctx) {
  return class FakeBW {
    constructor(opts) {
      this.opts = opts
      this.visible = false
      this.destroyed = false
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }
      this._loadCb = null
      const self = this
      this.webContents = {
        send(ch, data) { onSend(self, ch, data) },
        once(ev, cb) { if (ev === 'did-finish-load') self._loadCb = cb },
        on() {},
      }
      ctx.win = this
    }
    loadFile() { if (this._loadCb) this._loadCb() }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    showInactive() { this.visible = true; ctx.log.push({ ev: 'show', t: NOW, h: this.bounds.height }) }
    show() { this.showInactive() }
    hide() { if (this.visible) { this.visible = false; ctx.log.push({ ev: 'hide', t: NOW }) } }
    setBounds(b) {
      const prev = this.bounds.height
      this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
      if (prev !== b.height) ctx.log.push({ ev: 'resize', t: NOW, from: prev, to: b.height })
    }
    getBounds() { return { ...this.bounds } }
    setAlwaysOnTop() {}
    moveTop() {}
    on() {}
    once() {}
    destroy() { this.destroyed = true }
  }
}

// ── 依赖桩 ────────────────────────────────────────────────────────────────
function makeSettings(over) {
  return Object.assign({
    notifyMode: 'all',
    ringtoneEnabled: true,
    messageNotify: { display: 'content', duration: 5 },
  }, over || {})
}

function boot(settingsOverride) {
  const ctx = {
    log: [], sent: [], showEvents: 0, plays: 0, renderH: 0, win: null,
    settings: makeSettings(settingsOverride),
  }
  CURRENT = ctx
  // 场景隔离：每个场景独立 boot，清空共享的可控时钟与待触发定时器，
  // 避免前一个场景遗留的隐藏定时器被后一个场景的 tick 误触发（交叉污染）。
  NOW = 1700000000000
  timers.clear()
  tid = 0
  for (const k of Object.keys(ipcHandlers)) delete ipcHandlers[k]

  const BW = makeBWClass(ctx)
  delete require.cache[require.resolve('../lib/notificationCenter')]
  const { createNotificationCenter } = require('../lib/notificationCenter')

  ctx.nc = createNotificationCenter({
    BrowserWindow: BW,
    webPreferences: {},
    getWindowRect: (w, h) => ({ x: 1920 - w - 20, y: 1040 - h - 20 }),
    settingsStore: { getMerged: () => ctx.settings, saveContacts: () => {} },
    ringtoneResolver: { resolve: () => 'file:///ring.mp3' },
    onUnreadChange: () => {},
    openExternal: () => {},
    broadcast: () => {},
    isWebConnected: () => true,
    sendToAppClient: () => {},
    hasAppClient: () => true,
    focusMainWindow: () => {},
  })
  ctx.nc.preCreate()
  return ctx
}

function msg(cid, name, content, extra) {
  return Object.assign({
    conversationId: cid,
    senderId: cid,
    senderName: name || cid,
    content: content || '你好',
    url: 'https://x/message?conv=' + cid,
  }, extra || {})
}

// ── 断言 ──────────────────────────────────────────────────────────────────
let pass = 0
const fails = []
function ok(scn, cond, desc, detail) {
  if (cond) { pass++ } else { fails.push(scn + ' ' + desc + (detail ? '  → ' + detail : '')) }
}
function eq(scn, a, b, desc) { ok(scn, a === b, desc || '', 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)) }
function rowsOf(ctx) {
  const last = [...ctx.sent].reverse().find((s) => s.ch === 'nc-state')
  return last ? last.data.unread : []
}
function isShown(ctx) { return !!(ctx.win && ctx.win.isVisible()) }
function transitionSeq(ctx) {
  return ctx.log.filter((e) => e.ev === 'show' || e.ev === 'hide').map((e) => e.ev).join('>')
}

// ═════════════════════════════════════════════════════════════════════════
// S1 消息到达
// ═════════════════════════════════════════════════════════════════════════

// S1.1 单会话单条
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', '在吗', { unreadCount: 1 }))
  tick(200)
  eq('S1.1', rowsOf(c).length, 1, '单条消息显示 1 行')
  eq('S1.1', rowsOf(c)[0].count, 1, '计数为 1')
  eq('S1.1', c.plays, 1, '响铃 1 次')
  ok('S1.1', isShown(c), '窗口可见')
}

// S1.2 同会话 1s 内连发 3 条 → 1 行、计数 3、只响一次
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', '1', { unreadCount: 1 }))
  tick(100)
  c.nc.pushMessage(msg('a', '张三', '2', { unreadCount: 2 }))
  tick(100)
  c.nc.pushMessage(msg('a', '张三', '3', { unreadCount: 3 }))
  tick(200)
  eq('S1.2', rowsOf(c).length, 1, '连发合并为 1 行')
  eq('S1.2', rowsOf(c)[0].count, 3, '计数累加为 3')
  eq('S1.2', rowsOf(c)[0].last, '3', '内容为最后一条')
  eq('S1.2', c.plays, 1, '同一会话只响 1 次铃')
  eq('S1.2', c.showEvents, 1, '整窗入场动画只播 1 次')
}

// S1.3 展示期内隔 3s 再来 → 同一行、位置不动、计时重置
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(200)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(200)
  eq('S1.3', rowsOf(c)[0].conversationId, 'b', '新会话在最上面（b 在上）')
  tick(3000)
  c.nc.pushMessage(msg('b', '李四', 'z', { unreadCount: 2 }))
  tick(50)
  eq('S1.3', rowsOf(c)[0].conversationId, 'b', '更新不改变行位置')
  eq('S1.3', rowsOf(c)[1].conversationId, 'a', '第二行仍是 a')
  tick(2000)
  ok('S1.3', isShown(c), '更新后计时重置，窗口仍在')
  tick(4300)   // 2 行 → 设定 5s + 1s = 6s（D11 时长随行数递增）
  ok('S1.3', !isShown(c), '完整时长后自动收起')
}

// D11 停留时长固定 5s，与堆叠行数无关（用户要求 7→5；多会话不再加时，行为可预期）
{
  const c = boot({ messageNotify: { display: 'content', duration: 5 } })
  c.nc.pushMessage(msg('a', '张三', '1', { unreadCount: 1 }))
  tick(60)
  c.nc.pushMessage(msg('b', '李四', '2', { unreadCount: 1 }))
  tick(60)
  c.nc.pushMessage(msg('c', '王五', '3', { unreadCount: 1 }))
  tick(300)
  eq('D11', rowsOf(c).length, 3, '3 行已就位')
  tick(4500)
  ok('D11', isShown(c), '5s 内（3 行）仍在显示')
  tick(1500)
  ok('D11', !isShown(c), '满 5s 后收起（不随行数加时）')
}

// S1.4 两个会话在 150ms 内到达 → 一次成型
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', '1', { unreadCount: 1 }))
  tick(60)
  c.nc.pushMessage(msg('b', '李四', '2', { unreadCount: 1 }))
  tick(300)
  eq('S1.4', rowsOf(c).length, 2, '一次性出现 2 行')
  eq('S1.4', c.showEvents, 1, '只 show 一次')
  ok('S1.4', isShown(c) && c.win.bounds.height === contentHeight(2, 0), '以 2 行的高度显示（不是先 1 行再长高）',
    'h=' + c.win.bounds.height + ' want ' + contentHeight(2, 0))
}

// S1.5 间隔 500ms（窗口已显示）→ 追加行，不重播整窗动画
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', '1', { unreadCount: 1 }))
  tick(300)
  eq('S1.5', c.showEvents, 1, '首条 show 1 次')
  c.nc.pushMessage(msg('b', '李四', '2', { unreadCount: 1 }))
  tick(100)
  eq('S1.5', rowsOf(c).length, 2, '第 2 行已追加')
  eq('S1.5', c.showEvents, 1, '不重播整窗入场动画')
  eq('S1.5', c.win.bounds.height, contentHeight(2, 0), '高度增长到 2 行')
  eq('S1.5', transitionSeq(c), 'show', '窗口没有 hide/show 抖动')
}

// S1.6 6 个以上会话 → 高度封顶
{
  const c = boot()
  for (let i = 0; i < 8; i++) { c.nc.pushMessage(msg('c' + i, 'U' + i, 'm', { unreadCount: 1 })); tick(20) }
  tick(300)
  eq('S1.6', rowsOf(c).length, 8, '8 行都在栈里')
  ok('S1.6', c.win.bounds.height <= 520, '窗口高度封顶 520', 'h=' + c.win.bounds.height)
}

// S1.7 连发完全相同的内容
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', '好的', { unreadCount: 1 }))
  tick(500)
  c.nc.pushMessage(msg('a', '张三', '好的', { unreadCount: 2 }))
  tick(50)
  eq('S1.7', rowsOf(c)[0].count, 2, '相同内容不被吞，计数 +1')
  eq('S1.7', rowsOf(c).length, 1, '仍是 1 行')
}

// S1.8 昵称缺失
{
  const c = boot()
  c.nc.pushMessage({ conversationId: 'x', senderId: 'u', content: 'hi' })
  tick(300)
  eq('S1.8', rowsOf(c)[0].name, '未知用户', '昵称兜底')
}

// ═════════════════════════════════════════════════════════════════════════
// S2 抑制与免打扰
// ═════════════════════════════════════════════════════════════════════════

// S2.1 会话免打扰
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1, muted: true }))
  tick(300)
  eq('S2.1', rowsOf(c).length, 0, '免打扰不进列表')
  ok('S2.1', !isShown(c), '不弹窗')
  eq('S2.1', c.plays, 0, '不响铃')
  eq('S2.1', c.nc.getUnread().length, 1, '托盘未读仍统计')
}

// S2.2 / S2.3 全局免打扰
for (const mode of ['dnd', 'blockChat']) {
  const tag = mode === 'dnd' ? 'S2.2' : 'S2.3'
  const c = boot({ notifyMode: mode })
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  eq(tag, rowsOf(c).length, 0, mode + ' 模式不弹')
  eq(tag, c.plays, 0, mode + ' 模式不响铃')
}

// S2.4 正在查看该会话
{
  const c = boot()
  c.nc.setActiveConversation('a')
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  eq('S2.4', rowsOf(c).length, 0, '正在看的会话不弹')
  ok('S2.4', !isShown(c), '窗口不出现')
}

// S2.5 在看 A，B 来消息
{
  const c = boot()
  c.nc.setActiveConversation('a')
  c.nc.pushMessage(msg('b', '李四', 'x', { unreadCount: 1 }))
  tick(300)
  eq('S2.5', rowsOf(c).length, 1, 'B 正常弹')
  eq('S2.5', rowsOf(c)[0].conversationId, 'b', '弹的是 B')
}

// D13 回归：消息弹出后，网页随后上报 ACTIVE_CONVERSATION=该会话（路由切换 / 收到消息后自动聚焦）
// 不得立刻把正在显示的提醒清掉（否则「闪一下就消失，看不清是谁发的」）
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(200)
  ok('D13', isShown(c), '弹出后窗口可见')
  c.nc.setActiveConversation('a')   // 网页随后聚焦 / 路由到 a
  tick(300)
  ok('D13', isShown(c), 'ACTIVE_CONVERSATION=a 后窗口仍可见（提醒不被秒清）')
  eq('D13', rowsOf(c).length, 1, 'a 仍在列表')
  eq('D13', rowsOf(c)[0].conversationId, 'a', '仍是 a')
}

// D14 切到「当前无可见提醒、但有旧未读」的会话 → 不应清它的旧未读（修复「切换会话自动已读」bug）
// 旧逻辑一切换就 markRead，未读被清、该会话再也不弹窗；未读归零权应交由网页端 MARK_READ。
// 同时校验：切到 a 后 a 再来新消息应被抑制（activeConvId=a），避免「打开后回弹」。
{
  const c = boot()
  c.nc.syncUnread([{ conversationId: 'a', name: '张三', count: 1, last: 'hi' }])   // 基线，a 不进 stack（idle）
  tick(30)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))                       // b 弹出
  tick(200)
  eq('D14', rowsOf(c).length, 1, '只有 b 在显示')
  eq('D14', rowsOf(c)[0].conversationId, 'b', '显示的是 b')
  c.nc.setActiveConversation('a')    // 用户切到 a（a 当前无可见提醒）
  tick(50)
  ok('D14', c.nc.getUnread().find((x) => x.conversationId === 'a'), '切到 a → a 的旧未读保留（不再被自动已读）')
  ok('D14', isShown(c), 'b 的提醒不受影响，仍在显示')
  c.nc.pushMessage(msg('a', '张三', '新消息', { unreadCount: 2 }))                  // 切到 a 后 a 再来消息
  tick(200)
  eq('D14', rowsOf(c).length, 1, 'a 新消息被抑制：仍只有 b 在显示')
  eq('D14', rowsOf(c)[0].conversationId, 'b', '显示的是 b')
}

// S2.6 双通道（先 SYNC 后 PUSH）
{
  const c = boot()
  c.nc.syncUnread([{ conversationId: 'a', name: '张三', count: 1, last: 'hi', avatar: '' }])
  tick(30)
  ok('S2.6', !isShown(c), 'SYNC 单独不弹窗（I1）')
  c.nc.pushMessage(msg('a', '张三', 'hi', { unreadCount: 1 }))
  tick(300)
  eq('S2.6', rowsOf(c).length, 1, '双通道只出 1 行')
  eq('S2.6', rowsOf(c)[0].count, 1, '计数不翻倍')
  eq('S2.6', c.plays, 1, '只响 1 次铃')
  eq('S2.6', c.showEvents, 1, '只 show 1 次')
}

// S2.7 网页端标记某会话已读
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 2 }))
  tick(50)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(300)
  eq('S2.7', rowsOf(c).length, 2, '先有 2 行')
  c.nc.markRead('a')
  tick(50)
  eq('S2.7', rowsOf(c).length, 1, '已读行移除')
  eq('S2.7', rowsOf(c)[0].conversationId, 'b', '另一行保留')
  ok('S2.7', isShown(c), '窗口仍显示')
}

// S2.8 全部已读
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  c.nc.markRead('all')
  tick(50)
  ok('S2.8', !isShown(c), '全部已读后窗口收起')
}

// S2.9 网页端全量已读（sync 空列表）
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  tick(2600)                        // 越过 grace
  c.nc.syncUnread([])
  tick(50)
  ok('S2.9', !isShown(c), 'SYNC 空列表 → 收起')
  eq('S2.9', c.nc.getUnread().length, 0, '聚合清空')
}

// D12 点提醒但拿不到 conversationId → 不能「全部已读」误清列表
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(300)
  eq('D12', rowsOf(c).length, 2, '前置：两行')
  ipcHandlers['nc-open-conversation']({}, { conversationId: '' })
  tick(50)
  eq('D12', rowsOf(c).length, 2, 'cid 为空时列表不被清空')
  eq('D12', c.nc.getUnread().length, 2, '未读聚合未丢失')
}

// ═════════════════════════════════════════════════════════════════════════
// S3 窗口生命周期
// ═════════════════════════════════════════════════════════════════════════

// S3.1 首次显示即以最终高度
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(20)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(300)
  const shows = c.log.filter((e) => e.ev === 'show')
  eq('S3.1', shows.length, 1, '只 show 一次')
  eq('S3.1', shows[0].h, contentHeight(2, 0), '首次 show 的高度 = 2 行内容高度')
}

// S3.2 显示中新增行：底边固定（y 随高度减小）
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  const y1 = c.win.bounds.y
  const h1 = c.win.bounds.height
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(100)
  const y2 = c.win.bounds.y
  ok('S3.2', y2 < y1, '高度增长时 y 上移（底边固定）', 'y1=' + y1 + ' y2=' + y2)
  eq('S3.2', y2 + c.win.bounds.height, y1 + h1, '底边坐标不变')
}

// S3.4 超时自动收起
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  ok('S3.4', isShown(c), '显示中')
  tick(5000)
  ok('S3.4', !isShown(c), '5s 后自动收起')
  eq('S3.4', rowsOf(c).length, 0, '收起后栈清空')
}

// S3.5 到期前有新消息 → 不闪、续期
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(200)
  tick(4000)
  c.nc.pushMessage(msg('a', '张三', 'y', { unreadCount: 2 }))
  tick(4000)
  ok('S3.5', isShown(c), '更新后续期，原 5s 已过仍在显示')
  eq('S3.5', transitionSeq(c), 'show', '无 hide/show 抖动')
  tick(1500)
  ok('S3.5', !isShown(c), '新时长到点后收起')
}

// S3.6 用户 ✕ 后不被 SYNC 弹回
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  ipcHandlers['nc-close']({}, true)
  tick(20)
  ok('S3.6', !isShown(c), '✕ 后立刻收起')
  c.nc.syncUnread([{ conversationId: 'a', name: '张三', count: 1, last: 'x' }])
  c.nc.syncUnread([{ conversationId: 'a', name: '张三', count: 1, last: 'x' }])
  tick(50)
  ok('S3.6', !isShown(c), 'SYNC 不会把窗口弹回来')
}

// S3.7 点某一行：该行移除，其余保留
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(50)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(300)
  ipcHandlers['nc-open-conversation']({}, { conversationId: 'a', url: 'u' })
  tick(50)
  eq('S3.7', rowsOf(c).length, 1, '只剩 1 行')
  eq('S3.7', rowsOf(c)[0].conversationId, 'b', '保留的是 b')
  ok('S3.7', isShown(c), '窗口继续显示')
}

// S3.8 点最后一行 → 收起
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  ipcHandlers['nc-open-conversation']({}, { conversationId: 'a', url: 'u' })
  tick(50)
  ok('S3.8', !isShown(c), '点完最后一条窗口收起')
}

// S3.10 收起后真实新消息 → 立刻弹
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  ipcHandlers['nc-close']({}, true)
  tick(50)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(300)
  ok('S3.10', isShown(c), '新消息立刻弹出')
  eq('S3.10', rowsOf(c)[0].conversationId, 'b', '显示的是新会话')
}

// S3.11 arming 期被 ✕ → 不会被延迟 show 弹回
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  ipcHandlers['nc-close']({}, true)
  tick(500)
  ok('S3.11', !isShown(c), '开栈等待期关闭后不会被延迟 show 弹回')
}

// S3.12 隐藏期积累多条 → 一次成型
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(30)
  c.nc.pushMessage(msg('b', '李四', 'y', { unreadCount: 1 }))
  tick(30)
  c.nc.pushMessage(msg('c', '王五', 'z', { unreadCount: 1 }))
  tick(400)
  eq('S3.12', c.showEvents, 1, '只 show 一次')
  eq('S3.12', rowsOf(c).length, 3, '3 行一次成型')
  eq('S3.12', transitionSeq(c), 'show', '无抖动')
}

// ═════════════════════════════════════════════════════════════════════════
// S4 系统通知
// ═════════════════════════════════════════════════════════════════════════

// S4.1 离线常驻：不自动隐藏
{
  const c = boot()
  c.nc.pushSysAlert({ id: 'offline', type: 'offline', sticky: true, data: {} })
  tick(300)
  ok('S4.1', isShown(c), '常驻通知显示')
  tick(20000)
  ok('S4.1', isShown(c), '常驻通知不自动隐藏')
}

// S4.2 被踢
{
  const c = boot()
  c.nc.pushSysAlert({ id: 'kick', type: 'kick', sticky: true, data: {} })
  tick(300)
  ok('S4.2', isShown(c), '被踢常驻卡显示')
}

// S4.3 常驻时 ✕ 不收起
{
  const c = boot()
  c.nc.pushSysAlert({ id: 'offline', type: 'offline', sticky: true, data: {} })
  tick(300)
  ipcHandlers['nc-close']({}, false)
  tick(50)
  ok('S4.3', isShown(c), '常驻时 ✕ 不收起（防误关）')
  ipcHandlers['nc-close']({}, true)
  tick(50)
  ok('S4.3', !isShown(c), 'force 关闭仍可收起')
}

// S4.4 网络恢复 → 恢复常规计时
{
  const c = boot()
  c.nc.pushSysAlert({ id: 'offline', type: 'offline', sticky: true, data: {} })
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  c.nc.dismissSysAlert('offline')
  tick(50)
  ok('S4.4', isShown(c), '常驻消失后仍显示（有未读）')
  tick(5100)
  ok('S4.4', !isShown(c), '恢复常规自动隐藏')
}

// S4.6 重复 offline 不叠加
{
  const c = boot()
  c.nc.pushSysAlert({ id: 'o1', type: 'offline', sticky: true, data: {} })
  c.nc.pushSysAlert({ id: 'o2', type: 'offline', sticky: true, data: {} })
  tick(300)
  eq('S4.6', c.nc.getSysAlerts().length, 1, '重复 offline 复用同一张卡')
}

// ═════════════════════════════════════════════════════════════════════════
// S5 环境与设置
// ═════════════════════════════════════════════════════════════════════════

// S5.3 修改展示时长立即生效
{
  const c = boot({ messageNotify: { display: 'content', duration: 8 } })
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  tick(6000)
  ok('S5.3', isShown(c), '8s 时长下 6s 时仍在显示')
  tick(2200)
  ok('S5.3', !isShown(c), '8s 后收起')
}

// S5.5 重启后首次 SYNC 不弹窗
{
  const c = boot()
  c.nc.syncUnread([
    { conversationId: 'a', name: '张三', count: 3, last: 'x' },
    { conversationId: 'b', name: '李四', count: 1, last: 'y' },
  ])
  tick(500)
  ok('S5.5', !isShown(c), '历史未读不弹窗')
  eq('S5.5', c.sent.filter((s) => s.ch === 'nc-state' && s.data.unread.length > 0).length, 0, '未推送任何展示行')
  eq('S5.5', c.nc.getUnread().length, 2, '聚合里有 2 条未读（供托盘）')
}

// S5.6 展示中收到 sync 的新会话 → 补行但不重开
{
  const c = boot()
  c.nc.pushMessage(msg('a', '张三', 'x', { unreadCount: 1 }))
  tick(300)
  c.nc.syncUnread([
    { conversationId: 'a', name: '张三', count: 1, last: 'x' },
    { conversationId: 'b', name: '李四', count: 1, last: 'y' },
  ])
  tick(50)
  eq('S5.6', rowsOf(c).length, 2, '展示中 sync 新会话补行')
  eq('S5.6', c.showEvents, 1, '不重播入场动画')
}

// D13 网页端只发 SYNC、不发 SHOW_MESSAGE_NOTIFICATION → 也必须提醒
// （v6 SDK 下 layout.vue 曾用 deep watch 的 oldValue 做增量判断，新旧值同引用使比较恒 false，
//   SHOW 一次都没发出过 → 桌面端彻底静音。SYNC 的 count 增长是同一事实的另一路证据。）
{
  const c = boot()
  c.nc.syncUnread([])                 // 首次同步 = 基线
  tick(50)
  ok('D13', !isShown(c), '空基线不弹')

  c.nc.syncUnread([{ conversationId: 'x', name: '田一博', count: 1, last: '123' }])
  tick(400)
  ok('D13', isShown(c), '仅凭 SYNC 未读增长也能弹出')
  eq('D13', rowsOf(c).length, 1, '1 行')
  eq('D13', rowsOf(c)[0].conversationId, 'x', '是新消息的会话')
  eq('D13', c.plays, 1, '响铃 1 次')

  // 同会话继续增长 → 同一行更新，不重复响铃
  c.nc.syncUnread([{ conversationId: 'x', name: '田一博', count: 2, last: '456' }])
  tick(100)
  eq('D13', rowsOf(c).length, 1, '仍是 1 行')
  eq('D13', c.plays, 1, '同会话不重复响铃')
}

// D13b 双通道（SHOW + SYNC 都到）→ 只弹一次、只响一次、只有一行
{
  const c = boot()
  c.nc.syncUnread([])
  tick(50)
  c.nc.pushMessage(msg('y', '李四', 'hi', { unreadCount: 1 }))
  c.nc.syncUnread([{ conversationId: 'y', name: '李四', count: 1, last: 'hi' }])
  tick(500)
  eq('D13b', c.showEvents, 1, '只 show 一次')
  eq('D13b', rowsOf(c).length, 1, '只有 1 行')
  eq('D13b', c.plays, 1, '只响 1 次铃')
}

// D14 点过提醒（已读归零）后，同一会话再来消息必须重新提醒
// 曾经用独立的「上次同步未读数」做增长基准，markRead 只删 unreadMap 不清基准，
// 导致点过的会话下次 count 从 1 重新计数时被判「没增长」→ 该会话彻底静音。
{
  const c = boot()
  c.nc.syncUnread([])
  tick(50)
  c.nc.syncUnread([{ conversationId: 'a', name: '田一博', count: 1, last: 'hi' }])
  tick(400)
  ok('D14', isShown(c), '前置：首次弹出')
  eq('D14', c.plays, 1, '响铃 1 次')

  c.nc.markRead('a')                  // 用户点提醒 → 已读
  tick(100)
  eq('D14', rowsOf(c).length, 0, '点掉后栈空')

  c.nc.syncUnread([{ conversationId: 'a', name: '田一博', count: 1, last: 'again' }])
  tick(400)
  ok('D14', isShown(c), '点过提醒后同会话再来仍会弹')
  eq('D14', rowsOf(c).length, 1, '1 行')
  eq('D14', c.plays, 2, '重新响铃')
}

// ═════════════════════════════════════════════════════════════════════════
// 汇总
// ═════════════════════════════════════════════════════════════════════════
Module._load = origLoad

const total = pass + fails.length
console.log('\n═══ 通知中心场景校验（模型层）═══')
if (fails.length) {
  console.log('\n失败项：')
  fails.forEach((f) => console.log('  ✗ ' + f))
}
console.log('\n通过 ' + pass + ' / ' + total)
console.log(fails.length ? '结果：FAIL' : '结果：PASS')
process.exit(fails.length ? 1 : 0)
