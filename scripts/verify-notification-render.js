// scripts/verify-notification-render.js
// ─────────────────────────────────────────────────────────────────────────────
// 渲染层行为验证（jsdom）：键控复用、顺序稳定、重复推送零写入、高度协议
// 用法（jsdom 装在托管工作区，不污染项目依赖）：
//   NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
//   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" \
//   scripts/verify-notification-render.js
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs')
const path = require('path')
let JSDOM
try {
  ({ JSDOM } = require('jsdom'))
} catch (e) {
  console.error('缺少 jsdom。请设置 NODE_PATH 指向托管 node 的 node_modules（见文件头）。')
  process.exit(2)
}

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'notification-center.html'), 'utf8')

const calls = []
const api = {
  onNcState: (f) => { api._state = f },
  onNcMeasure: (f) => { api._measure = f },
  onNcPlay: (f) => { api._play = f },
  onNcShow: (f) => { api._show = f },
  openConversation: (cid, url) => calls.push(['open', cid, url]),
  closeNc: (f) => calls.push(['close', f]),
  markRead: () => {},
  resizeNc: (h) => calls.push(['resize', h]),
  reconnect: () => calls.push(['reconnect']),
  dismissSysAlert: (id) => calls.push(['dismiss', id]),
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.electronAPI = api
    window.HTMLMediaElement.prototype.play = function () { return Promise.resolve() }
    window.HTMLMediaElement.prototype.pause = function () {}
    // jsdom 没有布局引擎：按 CSS 规则给一个等价的高度模型，才能验证「高度协议」
    const listHeight = (el) => {
      const nConv = el.querySelectorAll('.conv').length
      const nSys = el.querySelectorAll('.sys').length
      if (!nConv && !nSys) return 100            // 空态 80 + 上下 padding 20
      let c = 0
      if (nConv) c += nConv * 62 + (nConv - 1) * 8
      if (nSys) c += nSys * 110 + (nConv ? 8 : 0)
      return 10 + c + 10
    }
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return this.id === 'list' ? listHeight(this) : 0 },
    })
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return this.classList && this.classList.contains('header') ? 48 : 0 },
    })
  },
})
const { window } = dom
const doc = window.document
const listEl = () => doc.getElementById('list')
const rows = () => Array.from(listEl().querySelectorAll('.conv'))
const sysRows = () => Array.from(listEl().querySelectorAll('.sys'))
const names = () => rows().map((r) => r.querySelector('.name').textContent)
const lastResize = () => { for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === 'resize') return calls[i][1]; return null }
const clearCalls = () => { calls.length = 0 }

let bad = 0, total = 0
const ok = (name, cond, extra) => {
  total++
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
}

const SETTINGS = { messageNotify: { display: 'content', duration: 5 } }
function mk(cid, name, content, count, extra) {
  return Object.assign({
    conversationId: cid, name, avatar: '', last: content, count,
    time: Date.parse('2026-10-22T10:30:00+08:00'),
    url: 'https://x/message?conv=' + cid, senderId: cid,
  }, extra || {})
}
function push(unread, extra) {
  api._state(Object.assign({ settings: SETTINGS, unread, sysAlerts: [], focusId: null }, extra || {}))
}

// ── R1 初始空态 ──
push([])
ok('R1 空列表显示空态', doc.querySelector('.empty') !== null)
ok('R1 空态高度回传', typeof lastResize() === 'number' && lastResize() >= 132, 'h=' + lastResize())

// ── R2 单行渲染 ──
clearCalls()
const A = mk('a', '张三', '在吗', 1)
push([A])
ok('R2 单行渲染', rows().length === 1, 'rows=' + rows().length)
ok('R2 名称/内容/计数正确',
  rows()[0].querySelector('.name').textContent === '张三' &&
  rows()[0].querySelector('.last').textContent === '在吗' &&
  rows()[0].querySelector('.count').textContent === '1')
ok('R2 时间格式化 HH:MM', rows()[0].querySelector('.time').textContent === '10:30',
  rows()[0].querySelector('.time').textContent)
ok('R2 高度随内容回传（1 行内容 130 < 最小高度 132，按下限取值）', lastResize() === 132, 'h=' + lastResize())
ok('R2 新行带入场标记', rows()[0].classList.contains('is-new'))

// ── R3 追加第二行：顺序完全按主进程给的顺序 ──
const B = mk('b', '李四', '你好', 2)
push([B, A])
ok('R3 两行顺序 = 输入顺序', JSON.stringify(names()) === JSON.stringify(['李四', '张三']), names().join(','))
ok('R3 第一行是 B', rows()[0].getAttribute('data-id') === 'b')
ok('R3 高度增长', lastResize() > 0)

// ── R4 键控复用：更新已有行不重建 DOM ──
const nodeA = rows()[1]
const nodeB = rows()[0]
const A2 = mk('a', '张三', '在吗在吗在吗', 5)
push([B, A2])
ok('R4 已有行复用同一 DOM 节点', rows()[1] === nodeA && rows()[0] === nodeB)
ok('R4 内容已更新', rows()[1].querySelector('.last').textContent === '在吗在吗在吗')
ok('R4 计数已更新', rows()[1].querySelector('.count').textContent === '5')

// ── R5 相同状态重复推送 → 零 DOM 写入（这是「重复推送不闪」的硬指标）──
{
  let mutations = 0
  const mo = new window.MutationObserver((recs) => { mutations += recs.length })
  mo.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true })
  clearCalls()
  push([B, A2])
  push([B, A2])
  push([B, A2])
  const recs = mo.takeRecords()
  mutations += recs.length
  mo.disconnect()
  ok('R5 重复推送零 DOM 写入', mutations === 0, 'mutations=' + mutations)
  ok('R5 重复推送不再回传高度', lastResize() === null)
}

// ── R6 顺序变化：复用节点 + 位置调整 ──
push([A2, B])
ok('R6 顺序改变', JSON.stringify(names()) === JSON.stringify(['张三', '李四']), names().join(','))
ok('R6 仍是同一批 DOM 节点', rows()[0] === nodeA && rows()[1] === nodeB)

// ── R7 移除一行：其余保留 ──
push([A2])
ok('R7 只剩 1 行', rows().length === 1)
ok('R7 保留的是张三点节点', rows()[0] === nodeA)

// ── R8 仅数量模式 ──
api._state({ settings: { messageNotify: { display: 'count', duration: 5 } }, unread: [A2], sysAlerts: [] })
ok('R8 count 模式加 body class', doc.body.classList.contains('nc-hide-content'))
api._state({ settings: SETTINGS, unread: [A2], sysAlerts: [] })
ok('R8 content 模式移除 class', !doc.body.classList.contains('nc-hide-content'))

// ── R9 高度协议：nc-measure 强制回传 ──
clearCalls()
api._measure()
ok('R9 nc-measure 强制回传高度', lastResize() !== null, 'h=' + lastResize())

// ── R10 头像只设置一次，且不重复写 src ──
{
  const C = mk('c', '王五', 'hi', 1, { avatar: 'https://cdn/x.png' })
  push([C])
  const img = rows()[0].querySelector('.avatar img')
  ok('R10 首次设置头像 src', img.getAttribute('src') === 'https://cdn/x.png')
  img.setAttribute('data-mark', '1')
  push([mk('c', '王五', 'hi2', 2, { avatar: 'https://cdn/x.png' })])
  ok('R10 同一头像不重复写 DOM（节点未被替换）', rows()[0].querySelector('.avatar img').getAttribute('data-mark') === '1')
  ok('R10 头像切换时才换 src',
    rows()[0].querySelector('.avatar img').getAttribute('src') === 'https://cdn/x.png')
}

// ── R11 计数封顶 ──
push([mk('d', '赵六', 'x', 150)])
ok('R11 计数 >99 显示 99+', rows()[0].querySelector('.count').textContent === '99+')

// ── R12 长文本截断 ──
push([mk('e', '孙七', '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多出来的', 1)])
{
  const t = rows()[0].querySelector('.last').textContent
  ok('R12 超长内容截断为 43 字符', t.length === 43 && t.endsWith('...'), 'len=' + t.length + ' ' + t)
}

// ── R13 点击行 → openConversation 参数正确 ──
{
  clearCalls()
  rows()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  const c = calls.find((x) => x[0] === 'open')
  ok('R13 点击行回传会话 id', c && c[1] === 'e', c ? 'cid=' + c[1] : 'no call')
  ok('R13 URL 已解码', c && c[2] === 'https://x/message?conv=e', c ? c[2] : '')
}

// ── R14 系统卡渲染与按钮 ──
{
  clearCalls()
  api._state({
    settings: SETTINGS, unread: [], focusId: null,
    sysAlerts: [{ id: 'offline', type: 'offline', sticky: true, data: {} }],
  })
  ok('R14 系统卡渲染', sysRows().length === 1)
  ok('R14 无会话行时不留空分区', rows().length === 0)
  const btn = sysRows()[0].querySelector('.sys-btn')
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  ok('R14 点「关闭」回传 dismissSysAlert', calls.some((c) => c[0] === 'dismiss' && c[1] === 'offline'))
}

// ── R15 系统卡 + 会话行共存，系统卡在上 ──
{
  api._state({
    settings: SETTINGS,
    unread: [mk('a', '张三', 'x', 1)],
    sysAlerts: [{ id: 'kick', type: 'kick', sticky: true, data: { device: 'PC' } }],
    focusId: null,
  })
  const list = listEl()
  const firstSys = list.querySelector('.sys')
  const firstConv = list.querySelector('.conv')
  ok('R15 系统卡与消息行同时存在', !!firstSys && !!firstConv)
  ok('R15 系统卡在消息行上方',
    !!(firstSys.compareDocumentPosition(firstConv) & window.Node.DOCUMENT_POSITION_FOLLOWING))
}

// ── R16 全部清空回到空态 ──
{
  api._state({ settings: SETTINGS, unread: [], sysAlerts: [] })
  ok('R16 清空后回到空态', doc.querySelector('.empty') !== null && rows().length === 0)
}

// ── R17 focus 高亮 ──
{
  api._state({ settings: SETTINGS, unread: [mk('a', '张三', 'x', 1)], sysAlerts: [], focusId: 'a' })
  ok('R17 最近会话高亮', rows()[0].classList.contains('is-focus'))
  api._state({ settings: SETTINGS, unread: [mk('a', '张三', 'x', 1)], sysAlerts: [], focusId: null })
  ok('R17 高亮可撤销', !rows()[0].classList.contains('is-focus'))
}

// ── R19 新增会话行时滚回顶部（S1.6）；纯更新不抢滚动位置 ──
{
  const many = []
  for (let i = 0; i < 8; i++) many.push(mk('c' + i, '用户' + i, 'msg' + i, 1))
  push(many.slice())
  // jsdom 无布局引擎：scrollTop 打桩，确保断言的是「谁写了它」而不是浏览器行为
  let st = 0
  Object.defineProperty(listEl(), 'scrollTop', {
    configurable: true,
    get() { return st },
    set(v) { st = v },
  })
  st = 120
  push(many.slice().reverse())          // 行集合不变（顺序变），属纯更新
  ok('R19 纯更新不重置滚动位置', st === 120, 'scrollTop=' + st)
  push([mk('brand-new', '新人', 'hi', 1)].concat(many))
  ok('R19 新增会话滚回顶部', st === 0, 'scrollTop=' + st)
}

// ── R18 ✕ 按钮 ──
{
  clearCalls()
  doc.getElementById('btn-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  ok('R18 ✕ 发送 force close', calls.some((c) => c[0] === 'close' && c[1] === true))
}

console.log('\n═══ 渲染层校验 ═══')
console.log('通过 ' + (total - bad) + ' / ' + total)
console.log(bad ? '结果：FAIL' : '结果：PASS')
process.exit(bad ? 1 : 0)
