// src/workbench-window.js
// 个人工作台渲染逻辑：四象限 / 待办列表（四竖列）视图切换、备注、图片/截图、
// 快捷类型图标（点击弹选）、参与人（通讯录+拼音搜索）、地点（高德地图选点）、
// 执行时间（单次时间范围 / 周期自定义 + 结束条件）、时间提醒（基于执行时间的提前提醒）、
// 拖拽改分组、日历每日数量（待办+提醒）、农历/节日/法定节假日/单双休、右侧折叠。

(function () {
  'use strict'

  let api = window.electronAPI
  let mapKey = ''
  let currentRestMode = 'double'
  if (!api) {
    // 浏览器预览/调试模式：使用内存 mock 数据
    console.warn('[Workbench] electronAPI not available, using mock data')
    const today = (function () { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    let mockTasks = [
      { id: '1', title: '给老板报日志的智能体', type: 'report', quadrant: 'urgent-important', done: false,
        schedule: { mode: 'single', single: { start: `${today}T15:00`, end: `${today}T16:00` } },
        reminder: { enabled: true, mode: '30min', dayTime: '09:00' },
        note: '记得附上本周数据', images: [], participants: [{ id: 'u1', name: '张三', avatar: '' }], location: null, createdAt: Date.now() - 3600000 },
      { id: '2', title: '每日站会', type: 'meeting', quadrant: 'important-not-urgent', done: false,
        schedule: { mode: 'recur', recur: { repeatMode: 'daily', time: '09:30', weekdays: [1, 2, 3, 4, 5], monthDay: 1, yearMonth: 1, yearDay: 1, endMode: 'never', endDate: '', endCount: 1, countFired: 0, lastFired: null } },
        reminder: { enabled: true, mode: '5min', dayTime: '09:00' },
        note: '', images: [], participants: [], location: { address: '石家庄市长安区', lat: 38.04, lng: 114.51 }, createdAt: Date.now() - 7200000 },
      { id: '3', title: '喝水', type: 'event', quadrant: 'not-urgent-not-important', done: false,
        schedule: { mode: 'single', single: { start: `${today}T09:00`, end: `${today}T17:00` } },
        reminder: { enabled: false, mode: 'none', dayTime: '09:00' },
        note: '', images: [], participants: [], location: null, createdAt: Date.now() - 1800000 },
    ]
    // 浏览器预览：用隐藏 file input + FileReader 让图片/截图可真实预览（真实 App 走 IPC，不受影响）
    function mockPickImageDataUrls(multiple) {
      return new Promise((resolve) => {
        const inp = document.createElement('input')
        inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = !!multiple
        inp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
        inp.addEventListener('change', () => {
          const files = Array.from(inp.files || [])
          Promise.all(files.map((f) => new Promise((res) => {
            const fr = new FileReader()
            fr.onload = () => res(fr.result); fr.onerror = () => res(null)
            fr.readAsDataURL(f)
          }))).then((urls) => { resolve(urls.filter(Boolean)); inp.remove() })
        })
        inp.addEventListener('cancel', () => { resolve([]); inp.remove() })
        document.body.appendChild(inp); inp.click()
      })
    }
    async function mockClipboardImage() {
      try {
        if (navigator.clipboard && navigator.clipboard.read) {
          const items = await navigator.clipboard.read()
          for (const it of (items || [])) {
            const type = (it.types || []).find((t) => String(t).startsWith('image/'))
            if (type) { const blob = await it.getType(type); return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob) }) }
          }
        }
      } catch (e) { /* 剪贴板不可读，回退文件选择 */ }
      return null
    }
    api = {
      workbenchLoad: async () => ({ tasks: mockTasks, tasksPath: '/mock/workbench/tasks.json', mapKey: '', restMode: 'double' }),
      workbenchAdd: async (t) => { const item = { id: Date.now().toString(), ...t, done: false, createdAt: Date.now(), updatedAt: Date.now() }; mockTasks.push(item); return item },
      workbenchUpdate: async (id, patch) => { const t = mockTasks.find(x => x.id === id); if (t) Object.assign(t, patch, { updatedAt: Date.now() }); return t },
      workbenchToggle: async (id) => { const t = mockTasks.find(x => x.id === id); if (t) { t.done = !t.done; t.updatedAt = Date.now() } return t },
      workbenchDelete: async (id) => { mockTasks = mockTasks.filter(x => x.id !== id); return true },
      workbenchPickImages: async () => mockPickImageDataUrls(true),
      workbenchPasteScreenshot: async () => {
        const clip = await mockClipboardImage()
        if (clip) return clip
        const picked = await mockPickImageDataUrls(false)
        return (picked && picked.length) ? picked[0] : null
      },
      workbenchReadImage: async (filename) => (typeof filename === 'string' && filename.startsWith('data:') ? filename : null),
      workbenchOpenImage: async (filename) => { if (typeof filename === 'string' && filename.startsWith('data:')) window.open(filename, '_blank') },
      workbenchDeleteImage: async () => {},
      workbenchContacts: async () => [
        { id: 'u1', name: '张三', avatar: '', py: 'zhangsan', initials: 'zs' },
        { id: 'u2', name: '李四', avatar: '', py: 'lisi', initials: 'ls' },
        { id: 'u3', name: '王小明', avatar: '', py: 'wangxiaoming', initials: 'wxm' },
      ],
      workbenchSetMapKey: async (k) => k,
      workbenchSetRestMode: async (m) => m,
      workbenchCalendarInfo: async (y, m, rest) => mockCalendarInfo(y, m, rest || 'double'),
      workbenchNcData: async () => ({
        unread: [
          { conversationId: 'u1', name: '张三', avatar: '', last: '好的，收到', count: 3, time: Date.now() - 60000, url: '' },
          { conversationId: 'u2', name: '李四', avatar: '', last: '项目资料发你邮箱了', count: 1, time: Date.now() - 3600000, url: '' },
        ],
        sysAlerts: [
          { id: 'offline', type: 'offline', sticky: true, time: Date.now() - 120000, data: { reason: '网络连接已断开' } },
        ],
        approvals: [
          { id: 'a1', title: '设备采购申请', applicant: '王小明', time: Date.now() - 300000, status: 'pending', url: '' },
          { id: 'a2', title: '加班申请', applicant: '李四', time: Date.now() - 86400000, status: 'approved', url: '' },
        ],
        online: false,
      }),
    }
  }

  // 象限配色（2026-08-14 蓝主题重调：红=重要且紧急 / 蓝=重要不紧急 / 琥珀=不重要但紧急 / 灰=不重要不紧急）
  const QUADRANTS = [
    { key: 'urgent-important', label: '重要且紧急', color: '#E11D48' },
    { key: 'important-not-urgent', label: '重要不紧急', color: '#1D4ED8' },
    { key: 'urgent-not-important', label: '不重要但紧急', color: '#B45309' },
    { key: 'not-urgent-not-important', label: '不重要不紧急', color: '#64748B' },
  ]
  const QUAD_COLOR = {}
  QUADRANTS.forEach((q) => { QUAD_COLOR[q.key] = q.color })
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

  // 类型图标（2026-08-14：与 store TASK_TYPES 20 类对齐——删生活类，加客户经营/设备配件/工程机械场景）
  const TYPE_ICONS = {
    event: '●', meeting: '📅', task: '📋', 'cycle-meeting': '🔁', 'cycle-task': '🔄',
    customer: '🤝', sales: '📈', contract: '📄', delivery: '🚚',
    excavator: '⛏️', loader: '🚜', crane: '🏗️', parts: '⚙️', repair: '🔧',
    call: '📞', business: '✈️', report: '📊', find: '🔍', training: '🎓', rent: '📦',
  }
  const TYPE_LABELS = {
    event: '事件', meeting: '会议', task: '任务', 'cycle-meeting': '周期会议', 'cycle-task': '周期任务',
    customer: '客户', sales: '销售', contract: '合同', delivery: '发货',
    excavator: '挖机', loader: '装载机', crane: '吊车', parts: '配件', repair: '维修',
    call: '电话', business: '出差', report: '汇报', find: '找人', training: '培训', rent: '租赁',
  }
  const TYPE_ORDER = ['event', 'meeting', 'task', 'cycle-meeting', 'cycle-task', 'customer', 'sales', 'contract', 'delivery', 'excavator', 'loader', 'crane', 'parts', 'repair', 'call', 'business', 'report', 'find', 'training', 'rent']

  let tasks = []
  let tasksPath = ''
  let currentView = 'quadrant'
  let currentCalDate = new Date()
  let selectedDate = formatDate(new Date())
  let refreshTimer = null
  const calInfoCache = {}
  // 筛选状态：搜索 / 类型多选（空=全部）/ 完成状态 / 仅看延期
  let searchQuery = ''
  let filterTypes = new Set()
  let filterDone = 'all' // 'all' | 'todo' | 'done'
  let filterOverdue = false
  // 拖拽排序状态
  let dragId = null
  let downPt = null

  // 象限内排序：未完成在前；组内按 order 升序（拖拽排序的持久化序号），无 order 按创建时间降序
  function sortTasks(ts) {
    return ts.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const oa = typeof a.order === 'number' ? a.order : 0
      const ob = typeof b.order === 'number' ? b.order : 0
      if (oa !== ob) return oa - ob
      return (b.createdAt || 0) - (a.createdAt || 0)
    })
  }

  // ── Utilities ──
  function pad(n) { return String(n).padStart(2, '0') }
  function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
  function formatDateCN(d) { return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}` }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
  function parseDt(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d }
  function dtLocal(s) { return (s || '').replace('T', ' ') }
  function avatarHtml(p, cls) {
    const fb = (p.name || '?').charAt(0)
    if (p.avatar) return `<img class="${cls}" src="${escapeHtml(p.avatar)}" onerror="this.outerHTML='<div class=\\'${cls} ${cls}-fb\\'>${fb}</div>'">`
    return `<div class="${cls} ${cls}-fb">${escapeHtml(fb)}</div>`
  }
  function localLunarText(d) {
    try {
      const monthFmt = new Intl.DateTimeFormat('zh-CN', { calendar: 'chinese', month: 'long' })
      const m = monthFmt.format(d)
      const day = d.getDate()
      let dayCn = ''
      if (day === 10) dayCn = '初十'; else if (day === 20) dayCn = '二十'; else if (day === 30) dayCn = '三十'
      else { const t = Math.floor(day / 10); const o = day % 10; const ts = t === 0 ? '初' : t === 1 ? '十' : t === 2 ? '廿' : '三'; const os = o === 0 ? '' : '一二三四五六七八九'[o - 1]; dayCn = ts + os }
      return (day === 1) ? m : dayCn
    } catch (e) { return '' }
  }
  function mockCalendarInfo(y, m, rest) {
    const dim = new Date(y, m, 0).getDate()
    const days = []
    for (let d = 1; d <= dim; d++) {
      const wd = new Date(y, m - 1, d).getDay()
      let isRest = false
      if (rest === 'double') isRest = (wd === 0 || wd === 6); else isRest = (wd === 0)
      days.push({ ds: `${y}-${pad(m)}-${pad(d)}`, lunarText: localLunarText(new Date(y, m - 1, d)), festival: '', isHoliday: false, isMakeup: false, isRest })
    }
    return { year: y, month: m, restMode: rest, days }
  }

  // 执行时间文案
  function scheduleLabel(t) {
    const s = t.schedule
    if (!s) return '未设时间'
    if (s.mode === 'single') {
      const sD = parseDt(s.single && s.single.start)
      const eD = parseDt(s.single && s.single.end)
      const sTxt = sD ? dtLocal(s.single.start).slice(5) : ''
      const eTxt = eD ? dtLocal(s.single.end).slice(5) : ''
      return sTxt ? (sTxt + (eTxt ? ' – ' + eTxt : '')) : '未设时间'
    }
    const r = s.recur
    const time = (r && r.time) || '09:00'
    const iv = (r && r.interval && r.interval > 1) ? `每隔${r.interval}` : ''
    let base = ''
    if (!r) base = ''
    else if (r.repeatMode === 'daily') base = (iv ? iv + '天 ' : '每天 ') + time
    else if (r.repeatMode === 'weekly') base = (iv ? iv + '周 ' : '每周') + (r.weekdays || []).map((d) => WEEKDAYS[Number(d)]).join('') + ' ' + time
    else if (r.repeatMode === 'monthly') base = (iv ? iv + '月 ' : '每月') + (r.monthDay || '?') + '号 ' + time
    else if (r.repeatMode === 'yearly') base = (iv ? iv + '年 ' : '每年') + (r.yearMonth || '?') + '月' + (r.yearDay || '?') + '日 ' + time
    if (r) {
      if (r.endMode === 'date') base += ' 至' + (r.endDate || '')
      else if (r.endMode === 'count') base += ' 限' + (r.endCount || 1) + '次'
    }
    return base
  }
  function reminderLabel(t) {
    const r = t.reminder
    if (!r || !r.enabled) return ''
    if (r.mode === '5min') return '⏰提前5分'
    if (r.mode === '30min') return '⏰提前30分'
    if (r.mode === '1day') return '⏰提前1天' + (r.dayTime ? ' ' + r.dayTime : '')
    return '⏰提醒'
  }
  function isOverdue(t) {
    if (!t || t.done) return false
    if (t.schedule && t.schedule.mode === 'single' && t.schedule.single && t.schedule.single.end) {
      const e = parseDt(t.schedule.single.end)
      return e && e.getTime() < Date.now()
    }
    return false
  }

  // 各任务在某日期窗口内的执行发生时刻 / 提醒日期（用于日历计数）
  function occOnDate(r, date) {
    const [hh, mm] = (r.time || '09:00').split(':').map(Number)
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0)
    const dim = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    if (r.repeatMode === 'daily') return at
    if (r.repeatMode === 'weekly') return (r.weekdays || []).includes(date.getDay()) ? at : null
    if (r.repeatMode === 'monthly') return date.getDate() === Math.min(r.monthDay || date.getDate(), dim) ? at : null
    if (r.repeatMode === 'yearly') return (date.getMonth() + 1 === (r.yearMonth || date.getMonth() + 1)) && date.getDate() === Math.min(r.yearDay || date.getDate(), dim) ? at : null
    return null
  }
  function taskOccurrences(t, from, to) {
    const s = t.schedule; const out = []
    if (!s || s.mode === 'single') { const st = parseDt(s && s.single ? s.single.start : ''); if (st && st >= from && st <= to) out.push(st) }
    else if (s.recur) { for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) { const o = occOnDate(s.recur, d); if (o) out.push(o) } }
    return out
  }
  function taskReminderDates(t, from, to) {
    const r = t.reminder; const out = new Set()
    if (!r || !r.enabled) return []
    taskOccurrences(t, from, to).forEach((occ) => {
      if (r.mode === '1day') { const d = new Date(occ); d.setDate(d.getDate() - 1); out.add(formatDate(d)) }
      else out.add(formatDate(occ))
    })
    return [...out]
  }

  // ── Data ──
  async function loadData() {
    try {
      const d = await api.workbenchLoad()
      tasks = Array.isArray(d.tasks) ? d.tasks : []
      tasksPath = d.tasksPath || ''
      mapKey = d.mapKey || ''
      if (d.restMode) currentRestMode = d.restMode
      document.getElementById('cal-rest').value = currentRestMode
    } catch (e) { console.error('[Workbench] load failed:', e); tasks = [] }
    renderAll()
    loadBoardImages()
  }

  function renderAll() { renderBoard(); renderCalendar(); renderClock() }

  // ── Board (quadrant / list) ──
  function matchFilter(t) {
    if (filterTypes.size && !filterTypes.has(t.type)) return false
    if (filterDone === 'todo' && t.done) return false
    if (filterDone === 'done' && !t.done) return false
    if (filterOverdue && !isOverdue(t)) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const hay = [t.title, t.note, (Array.isArray(t.participants) ? t.participants.map((p) => p.name).join(' ') : '')].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }

  function renderBoard() {
    const board = document.getElementById('board')
    board.className = 'board ' + (currentView === 'list' ? 'list-view' : 'quadrant-view')
    board.innerHTML = QUADRANTS.map((q) => `
      <div class="quad ${q.key}" data-quadrant="${q.key}">
        <div class="quad-header">
          <div class="quad-title"><span class="dot"></span>${escapeHtml(q.label)}</div>
          <div class="quad-actions">
            <span class="quad-count"></span>
            <button class="quad-btn" data-action="add" title="添加">+</button>
          </div>
        </div>
        <div class="quad-list" data-drop="${q.key}"></div>
      </div>`).join('')

    let anyMatch = false
    QUADRANTS.forEach((q) => {
      const el = board.querySelector(`.quad[data-quadrant="${q.key}"]`)
      const list = el.querySelector('.quad-list')
      const qt = tasks.filter((t) => t.quadrant === q.key && matchFilter(t))
      if (qt.length) anyMatch = true
      const undone = qt.filter((t) => !t.done)
      const done = qt.filter((t) => t.done)
      const sorted = sortTasks(qt)
      el.querySelector('.quad-count').textContent = `${undone.length}/${qt.length}`
      list.innerHTML = sorted.length ? sorted.map(renderTask).join('') : '<div class="empty">暂无待办</div>'
      el.querySelector('[data-action="add"]').addEventListener('click', () => openEditDialog(null, q.key))

      // 拖拽：跨象限 + 象限内排序（插入指示线）
      list.addEventListener('dragover', (e) => {
        e.preventDefault()
        if (!dragId) return
        list.classList.add('drag-over')
        const els = Array.from(list.querySelectorAll('.task'))
        let placed = false
        els.forEach((n) => {
          n.classList.remove('drag-over-before', 'drag-over-after')
          if (placed || n.dataset.id === dragId) return
          const r = n.getBoundingClientRect()
          if (e.clientY < r.top || e.clientY > r.bottom) return
          const before = (e.clientY - r.top) < r.height / 2
          n.classList.add(before ? 'drag-over-before' : 'drag-over-after')
          placed = true
        })
      })
      list.addEventListener('dragleave', () => list.classList.remove('drag-over'))
      list.addEventListener('drop', async (e) => {
        e.preventDefault(); list.classList.remove('drag-over')
        const id = e.dataTransfer.getData('text/plain')
        const target = list.dataset.drop
        const els = Array.from(list.querySelectorAll('.task'))
        let refId = null; let after = false
        for (const n of els) {
          if (n.classList.contains('drag-over-before')) { refId = n.dataset.id; after = false; break }
          if (n.classList.contains('drag-over-after')) { refId = n.dataset.id; after = true; break }
        }
        els.forEach((n) => n.classList.remove('drag-over-before', 'drag-over-after'))
        if (id && target) await reorderTask(id, target, refId, after)
      })

      // 任务卡：单击打开详情（拖拽位移 > 6px 不触发），勾选圈/图片不触发
      list.querySelectorAll('.task').forEach((node) => {
        const id = node.dataset.id
        node.addEventListener('dragstart', (e) => {
          dragId = id
          e.dataTransfer.setData('text/plain', id)
          e.dataTransfer.effectAllowed = 'move'
          node.classList.add('dragging')
        })
        node.addEventListener('dragend', () => {
          node.classList.remove('dragging')
          dragId = null
        })
        node.addEventListener('mousedown', (e) => { downPt = { x: e.clientX, y: e.clientY } })
        node.addEventListener('click', (e) => {
          if (e.target.closest('.task-check') || e.target.closest('.task-img')) return
          if (downPt && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 6) { downPt = null; return }
          downPt = null
          openEditDialog(id)
        })
        node.querySelector('.task-check').addEventListener('click', () => toggleTask(id))
        node.querySelectorAll('.task-img').forEach((img) => img.addEventListener('click', () => api.workbenchOpenImage(img.dataset.filename)))
        const noteBadge = node.querySelector('.badge.note'); if (noteBadge) noteBadge.title = noteBadge.dataset.note || '备注'
        const locBadge = node.querySelector('.badge.loc'); if (locBadge) locBadge.title = locBadge.dataset.addr || '地点'
      })
    })

    // 搜索/筛选无匹配时，整屏提示（有数据但被过滤掉）
    if (!anyMatch && tasks.length) {
      const hasFilter = searchQuery || filterTypes.size > 0 || filterDone !== 'all' || filterOverdue
      board.insertAdjacentHTML('beforeend', `<div class="board-empty"><div class="be-ic">🔍</div><div>${hasFilter ? '没有匹配的待办，试试调整搜索或筛选' : '暂无待办'}</div></div>`)
    }
  }

  function renderTask(t) {
    const overdue = isOverdue(t)
    const typeIcon = TYPE_ICONS[t.type] || TYPE_ICONS.event
    const timeTxt = scheduleLabel(t)
    const badges = []
    if (t.done) badges.push(`<span class="badge done" title="已完成">✓ 已完成</span>`)
    if (t.note) badges.push(`<span class="badge note" data-note="${escapeHtml(t.note)}" title="备注">📝</span>`)
    if (Array.isArray(t.images) && t.images.length) badges.push(`<span class="badge img" title="${t.images.length} 张图片">🖼️${t.images.length}</span>`)
    if (t.reminder && t.reminder.enabled) badges.push(`<span class="badge rem" title="${escapeHtml(reminderLabel(t))}">${escapeHtml(reminderLabel(t))}</span>`)
    if (overdue) badges.push(`<span class="badge overdue" title="已延期">延期</span>`)
    const imgs = (Array.isArray(t.images) && t.images.length)
      ? `<div class="task-images">${t.images.map((f) => `<img class="task-img" data-filename="${escapeHtml(f)}" alt="图片">`).join('')}</div>` : ''
    const pars = (Array.isArray(t.participants) && t.participants.length)
      ? `<div class="task-participants">${t.participants.slice(0, 5).map((p) => avatarHtml(p, 'pa')).join('')}${t.participants.length > 5 ? `<span class="pa-more">+${t.participants.length - 5}</span>` : ''}</div>` : ''
    const loc = t.location
      ? `<span class="badge loc" data-addr="${escapeHtml(t.location.address || '')}" title="${escapeHtml(t.location.address || '')}">📍${escapeHtml((t.location.address || '').slice(0, 10) || '已定位')}</span>` : ''
    const metaHtml = `<div class="task-meta"><span class="task-time" title="执行时间">🕒 ${escapeHtml(timeTxt)}</span>${pars}${badges.join('')}${loc}</div>`
    const noteHtml = t.note ? `<div class="task-note" title="${escapeHtml(t.note)}">${escapeHtml(t.note)}</div>` : ''
    return `
      <div class="task ${t.done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-id="${escapeHtml(t.id)}" draggable="true" title="单击查看详情，拖拽可排序">
        <div class="task-check" data-id="${escapeHtml(t.id)}"></div>
        <div class="task-body">
          <div class="task-headblock">
            <span class="task-type" title="${escapeHtml(TYPE_LABELS[t.type] || '事件')}">${typeIcon}</span>
            <span class="task-text" data-id="${escapeHtml(t.id)}">${escapeHtml(t.title)}</span>
          </div>
          ${noteHtml}
          ${metaHtml}
          ${imgs}
        </div>
      </div>`
  }

  async function reorderTask(id, targetQuad, refId, after) {
    const drag = tasks.find((t) => t.id === id)
    if (!drag) return
    const rest = sortTasks(tasks.filter((t) => t.quadrant === targetQuad && t.id !== id))
    let idx = refId ? rest.findIndex((t) => t.id === refId) : -1
    if (idx >= 0) idx = after ? idx + 1 : idx
    if (idx < 0 || idx > rest.length) idx = rest.length
    rest.splice(idx, 0, drag)
    const patches = rest.map((t, i) => ({ id: t.id, quadrant: targetQuad, order: i + 1 }))
    for (const p of patches) { try { await api.workbenchUpdate(p.id, p) } catch (e) {} }
    await loadData()
  }

  async function loadBoardImages() {
    const imgs = Array.from(document.querySelectorAll('#board .task-img[data-filename]'))
    await Promise.all(imgs.map(async (img) => {
      try { const url = await api.workbenchReadImage(img.dataset.filename); if (url) img.src = url } catch (e) {}
    }))
  }
  async function toggleTask(id) { await api.workbenchToggle(id); await loadData() }

  // ── Calendar ──
  async function getCalInfo(y, m) {
    const key = `${y}-${m}-${currentRestMode}`
    if (calInfoCache[key]) return calInfoCache[key]
    let info = null
    if (api.workbenchCalendarInfo) { try { info = await api.workbenchCalendarInfo(y, m, currentRestMode) } catch (e) { info = null } }
    if (!info) info = mockCalendarInfo(y, m, currentRestMode)
    calInfoCache[key] = info
    return info
  }

  async function renderCalendar() {
    const y = currentCalDate.getFullYear()
    const m = currentCalDate.getMonth() + 1
    document.getElementById('cal-title').textContent = `${y}年${m}月`
    const info = await getCalInfo(y, m)

    const grid = document.getElementById('cal-grid')
    grid.innerHTML = WEEKDAYS.map((w) => `<div class="cal-weekday">${w}</div>`).join('')

    const firstDay = new Date(y, m - 1, 1)
    const startOffset = firstDay.getDay()
    const daysInMonth = new Date(y, m, 0).getDate()
    const prevDays = new Date(y, m - 1, 0).getDate()
    const todayStr = formatDate(new Date())

    // 计数（待办=执行日期；提醒=提醒触发日期）
    const monthStart = new Date(y, m - 1, 1)
    const monthEnd = new Date(y, m, 0)
    const todoCount = {}; const remCount = {}
    tasks.forEach((t) => {
      taskOccurrences(t, monthStart, monthEnd).forEach((occ) => { const ds = formatDate(occ); todoCount[ds] = (todoCount[ds] || 0) + 1 })
      taskReminderDates(t, monthStart, monthEnd).forEach((ds) => { remCount[ds] = (remCount[ds] || 0) + 1 })
    })

    const renderCell = (day, isOther) => {
      const d = isOther ? new Date(y, m === 1 ? 0 : m - 2, day) : new Date(y, m - 1, day)
      const ds = formatDate(d)
      const cell = document.createElement('div')
      cell.className = 'cal-day' + (isOther ? ' other' : '')
      if (!isOther && ds === todayStr) cell.classList.add('today')
      else if (ds === selectedDate) cell.classList.add('selected')
      const infoDay = info.days[day - 1]
      if (infoDay && !isOther) {
        if (infoDay.isRest) cell.classList.add('rest')
        if (infoDay.isHoliday) cell.classList.add('holiday')
        const secText = infoDay.festival || infoDay.lunarText || ''
        const festCls = infoDay.festival ? 'fest' : 'lunar'
        const counts = (todoCount[ds] || remCount[ds])
          ? `<div class="cal-counts">${todoCount[ds] ? `<span class="c-todo">${todoCount[ds]}待</span>` : ''}${remCount[ds] ? `<span class="c-rem">${remCount[ds]}提</span>` : ''}</div>` : ''
        cell.innerHTML = `<div>${day}</div>${secText ? `<div class="${festCls}">${escapeHtml(secText)}</div>` : ''}${infoDay.isMakeup ? '<div class="makeup">班</div>' : ''}${counts}`
      } else {
        cell.innerHTML = `<div>${day}</div>`
      }
      cell.addEventListener('click', () => { selectedDate = ds; renderCalendar(); openDayDetail(ds) })
      grid.appendChild(cell)
    }
    for (let i = startOffset - 1; i >= 0; i--) renderCell(prevDays - i, true)
    for (let day = 1; day <= daysInMonth; day++) renderCell(day, false)
    for (let day = 1; day <= (7 - ((startOffset + daysInMonth) % 7)) % 7; day++) renderCell(day, true)
  }

  document.getElementById('cal-prev').addEventListener('click', () => { currentCalDate.setMonth(currentCalDate.getMonth() - 1); renderCalendar() })
  document.getElementById('cal-next').addEventListener('click', () => { currentCalDate.setMonth(currentCalDate.getMonth() + 1); renderCalendar() })
  document.getElementById('cal-today').addEventListener('click', () => { currentCalDate = new Date(); selectedDate = formatDate(new Date()); renderCalendar() })
  document.getElementById('cal-rest').addEventListener('change', async (e) => {
    currentRestMode = e.target.value
    for (const k in calInfoCache) if (k.endsWith('-' + (currentRestMode === 'single' ? 'double' : 'single'))) delete calInfoCache[k]
    try { await api.workbenchSetRestMode(currentRestMode) } catch (err) {}
    renderCalendar()
  })

  function openDayDetail(ds) {
    const d = parseDt(ds)
    const todos = tasks.filter((t) => {
      if (t.schedule && t.schedule.mode === 'single') return (t.schedule.single.start || '').slice(0, 10) === ds
      if (t.schedule && t.schedule.recur) return taskOccurrences(t, d, d).length > 0
      return false
    })
    const reminders = tasks.filter((t) => !t.done && t.reminder && t.reminder.enabled && taskReminderDates(t, d, d).includes(ds))
    const items = []
    todos.forEach((t) => {
      const par = (Array.isArray(t.participants) && t.participants.length) ? `<div class="di-par">参与人：${t.participants.map((p) => escapeHtml(p.name)).join('、')}</div>` : ''
      const loc = t.location && t.location.address ? `<div class="di-par">📍 ${escapeHtml(t.location.address)}</div>` : ''
      items.push({ color: QUAD_COLOR[t.quadrant], text: t.title, meta: (scheduleLabel(t) ? '时间 ' + scheduleLabel(t) + ' · ' : '') + (isOverdue(t) ? '已延期 · ' : '') + TYPE_LABELS[t.type] + ' · ' + QUADRANTS.find((q) => q.key === t.quadrant).label + (t.done ? ' · 已完成' : ''), extra: par + loc })
    })
    reminders.forEach((t) => {
      if (todos.some((x) => x.id === t.id)) return
      items.push({ color: '#B45309', text: t.title, meta: reminderLabel(t) + ' · ' + TYPE_LABELS[t.type], extra: '' })
    })
    const overlay = document.createElement('div')
    overlay.className = 'dialog-overlay'
    overlay.innerHTML = `
      <div class="dialog">
        <h3>${ds} 当日安排</h3>
        <div class="day-list">
          ${items.length ? items.map((it) => `
            <div class="day-item">
              <div class="bar" style="background:${it.color}"></div>
              <div class="di-text">${escapeHtml(it.text)}<div class="di-meta">${escapeHtml(it.meta)}</div>${it.extra || ''}</div>
            </div>`).join('') : '<div class="empty">当日无待办与提醒</div>'}
        </div>
        <div class="actions"><button class="cancel">关闭</button></div>
      </div>`
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    overlay.querySelector('.cancel').addEventListener('click', () => overlay.remove())
    document.body.appendChild(overlay)
  }

  // ── Clock ──
  function renderClock() {
    const now = new Date()
    document.getElementById('clock-time').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    document.getElementById('clock-date').textContent = formatDateCN(now)
    document.getElementById('clock-lunar').textContent = localLunarText(now)
  }
  function startClock() {
    renderClock()
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(renderClock, 1000)
  }

  // ── View toggle + collapse ──
  document.getElementById('view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]'); if (!btn) return
    currentView = btn.dataset.view
    document.querySelectorAll('#view-toggle button').forEach((b) => b.classList.toggle('active', b === btn))
    renderBoard(); loadBoardImages()
  })
  // ── 侧边栏自适应：宽屏固定右侧；窄屏（<1180px）悬浮抽屉 ──
  const sidebarEl = document.getElementById('sidebar')
  const sidebarMask = document.getElementById('sidebar-mask')
  const collapseBtn = document.getElementById('collapse-btn')
  const NARROW_WIDTH = 1180
  let isNarrow = window.innerWidth < NARROW_WIDTH
  function updateSidebarMode() {
    const narrow = window.innerWidth < NARROW_WIDTH
    if (narrow === isNarrow) return
    isNarrow = narrow
    const main = document.getElementById('main')
    if (narrow) {
      main.classList.remove('collapsed')
      sidebarEl.classList.remove('open'); sidebarMask.classList.remove('show')
      collapseBtn.textContent = '☰'
      collapseBtn.title = '打开日历'
    } else {
      sidebarEl.classList.remove('open'); sidebarMask.classList.remove('show')
      collapseBtn.textContent = main.classList.contains('collapsed') ? '›' : '‹'
      collapseBtn.title = '收起/展开日历'
    }
  }
  window.addEventListener('resize', updateSidebarMode)
  collapseBtn.addEventListener('click', () => {
    const main = document.getElementById('main')
    if (isNarrow) {
      const open = sidebarEl.classList.toggle('open')
      sidebarMask.classList.toggle('show', open)
      return
    }
    const collapsed = main.classList.toggle('collapsed')
    collapseBtn.textContent = collapsed ? '›' : '‹'
  })
  if (sidebarMask) sidebarMask.addEventListener('click', () => {
    sidebarEl.classList.remove('open'); sidebarMask.classList.remove('show')
  })

  // ── 工具栏：搜索 + 筛选聚合面板（类型多选 / 完成状态 / 仅看延期）──
  const searchInput = document.getElementById('search-input')
  const searchClear = document.getElementById('search-clear')
  function applySearch() {
    searchQuery = (searchInput.value || '').trim()
    searchClear.hidden = !searchQuery
    renderBoard()
  }
  searchInput.addEventListener('input', applySearch)
  searchClear.addEventListener('click', () => { searchInput.value = ''; applySearch(); searchInput.focus() })

  const filterBtn = document.getElementById('filter-btn')
  const filterPanel = document.getElementById('filter-panel')
  const filterTypesWrap = document.getElementById('filter-types-wrap')
  const filterDoneEl = document.getElementById('filter-done')
  const filterOverdueCb = document.getElementById('filter-overdue')
  const filterReset = document.getElementById('filter-reset')
  const filterCount = document.getElementById('filter-count')

  function filterActiveCount() {
    return filterTypes.size + (filterDone !== 'all' ? 1 : 0) + (filterOverdue ? 1 : 0)
  }
  function updateFilterBadge() {
    const n = filterActiveCount()
    filterCount.hidden = n === 0
    filterCount.textContent = n
    filterBtn.classList.toggle('on', n > 0)
  }
  function renderFilterTypes() {
    filterTypesWrap.innerHTML = `<div class="fp-group"><div class="fp-group-label">类型</div><div class="fp-types">` +
      TYPE_ORDER.map((k) => `<button type="button" data-type="${k}" class="${filterTypes.has(k) ? 'on' : ''}" title="${TYPE_LABELS[k]}"><span class="tic">${TYPE_ICONS[k]}</span>${TYPE_LABELS[k]}</button>`).join('') +
      `</div></div>`
    filterTypesWrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.type
      if (filterTypes.has(k)) filterTypes.delete(k); else filterTypes.add(k)
      b.classList.toggle('on', filterTypes.has(k))
      updateFilterBadge(); renderBoard()
    }))
  }
  function applyFilterDone() {
    filterDoneEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.done === filterDone))
    updateFilterBadge(); renderBoard()
  }
  filterBtn.addEventListener('click', (e) => { e.stopPropagation(); filterPanel.hidden = !filterPanel.hidden })
  filterPanel.addEventListener('click', (e) => e.stopPropagation())
  document.addEventListener('click', () => { filterPanel.hidden = true })
  filterDoneEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { filterDone = b.dataset.done; applyFilterDone() }))
  filterOverdueCb.addEventListener('change', () => { filterOverdue = filterOverdueCb.checked; updateFilterBadge(); renderBoard() })
  filterReset.addEventListener('click', () => {
    filterTypes.clear(); filterDone = 'all'; filterOverdue = false
    filterOverdueCb.checked = false
    renderFilterTypes(); applyFilterDone(); updateFilterBadge(); renderBoard()
  })
  renderFilterTypes()
  updateFilterBadge()
  const topbarAdd = document.getElementById('topbar-add')
  if (topbarAdd) topbarAdd.addEventListener('click', () => openEditDialog(null, 'urgent-important'))

  // ── Edit / Add dialog ──
  function createOverlay() { const o = document.createElement('div'); o.className = 'dialog-overlay'; document.body.appendChild(o); o.addEventListener('click', (e) => { if (e.target === o) o.remove() }); return o }

  function buildDialogContent(overlay, t, defaultQuadrant) {
    const isEdit = !!t
    const q = t ? t.quadrant : (defaultQuadrant || 'urgent-important')
    const quadLabel = (QUADRANTS.find((x) => x.key === q) || {}).label || ''
    const type = t && t.type ? t.type : 'event'
    const sched = t && t.schedule ? t.schedule : { mode: 'single', single: { start: `${formatDate(new Date())}T09:00`, end: `${formatDate(new Date())}T17:00` } }
    const rem = t && t.reminder ? t.reminder : { enabled: false, mode: 'none', dayTime: '09:00' }

    const singleStart = sched.mode === 'single' ? (sched.single.start || `${formatDate(new Date())}T09:00`) : `${formatDate(new Date())}T09:00`
    const singleEnd = sched.mode === 'single' ? (sched.single.end || `${formatDate(new Date())}T17:00`) : `${formatDate(new Date())}T17:00`
    const tabMode = sched.mode === 'recur' ? 'recur' : 'single'
    const r = sched.recur || { repeatMode: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], monthDay: new Date().getDate(), yearMonth: new Date().getMonth() + 1, yearDay: new Date().getDate(), endMode: 'never', endDate: '', endCount: 1 }
    let curUnit = ({ weekly: 'week', monthly: 'month', yearly: 'year', daily: 'day' })[r.repeatMode] || 'day'
    const curInterval = r.interval || 1

    let participants = isEdit && Array.isArray(t.participants) ? t.participants.slice() : []
    let location = isEdit && t.location ? t.location : null
    let images = isEdit && Array.isArray(t.images) ? t.images.slice() : []

    overlay.innerHTML = `
      <div class="dialog">
        <div class="dialog-head">
          <h3>${isEdit ? '编辑待办' : '新建待办'} <span class="quad-pill" style="background:${QUAD_COLOR[q]}">${escapeHtml(quadLabel)}</span></h3>
          <button type="button" class="dlg-x" id="dlg-close" title="关闭">×</button>
        </div>
        <div class="dialog-body">
        <div class="section">
          <div class="section-title">内容</div>
          <div class="edit-block">
            <div class="type-row">
              <div class="type-label-col">
                <div class="type-label">类型</div>
                <div class="type-name" id="dlg-type-name">${TYPE_LABELS[type]}</div>
              </div>
              <div class="type-icons" id="dlg-type-icons">
                ${TYPE_ORDER.map((k) => `<button type="button" data-type="${k}" class="${k === type ? 'on' : ''}" title="${TYPE_LABELS[k]}"><span class="ic">${TYPE_ICONS[k]}</span></button>`).join('')}
              </div>
            </div>
            <label>标题</label>
            <input type="text" id="dlg-title" value="${isEdit ? escapeHtml(t.title) : ''}" placeholder="待办标题，按回车确认" maxlength="500" autocomplete="off">
            <label>备注</label>
            <textarea id="dlg-note" placeholder="补充说明...">${isEdit ? escapeHtml(t.note || '') : ''}</textarea>
          </div>
        </div>

        <div class="section">
          <div class="section-title">执行时间</div>
          <div class="tabs">
            <button type="button" data-tab="single" class="${tabMode === 'single' ? 'active' : ''}">单次</button>
            <button type="button" data-tab="recur" class="${tabMode === 'recur' ? 'active' : ''}">周期</button>
          </div>
          <div class="tab-pane ${tabMode === 'single' ? 'active' : ''}" id="tab-single">
            <div class="row">
              <div><label style="margin:0 0 4px;">开始时间</label><input type="datetime-local" id="dlg-s-start" value="${escapeHtml(singleStart)}"></div>
              <div><label style="margin:0 0 4px;">结束时间</label><input type="datetime-local" id="dlg-s-end" value="${escapeHtml(singleEnd)}"></div>
            </div>
          </div>
          <div class="tab-pane ${tabMode === 'recur' ? 'active' : ''}" id="tab-recur">
            <div class="recur-unit-seg" id="dlg-recur-unit">
              <button type="button" data-unit="day" class="${curUnit === 'day' ? 'on' : ''}">每天</button>
              <button type="button" data-unit="week" class="${curUnit === 'week' ? 'on' : ''}">每周</button>
              <button type="button" data-unit="month" class="${curUnit === 'month' ? 'on' : ''}">每月</button>
              <button type="button" data-unit="year" class="${curUnit === 'year' ? 'on' : ''}">每年</button>
            </div>
            <div class="recur-interval">
              <div class="ri-field">
                <label>重复频率</label>
                <div class="ri-every">
                  <span>每隔</span>
                  <input type="number" class="ri-num" id="dlg-interval" min="1" max="365" value="${curInterval}">
                  <span>次</span>
                </div>
              </div>
              <div class="ri-field">
                <label>单位</label>
                <select class="ri-unit" id="dlg-unit">
                  <option value="day" ${curUnit === 'day' ? 'selected' : ''}>日</option>
                  <option value="week" ${curUnit === 'week' ? 'selected' : ''}>周</option>
                  <option value="month" ${curUnit === 'month' ? 'selected' : ''}>月</option>
                  <option value="year" ${curUnit === 'year' ? 'selected' : ''}>年</option>
                </select>
              </div>
              <div class="ri-field">
                <label>执行时间</label>
                <input type="time" class="ri-time" id="dlg-recur-time" value="${escapeHtml(r.time || '09:00')}">
              </div>
            </div>
            <div class="weekday-pick" id="dlg-weekdays" style="${curUnit === 'week' ? '' : 'display:none;'}">
              ${WEEKDAYS.map((w, i) => `<button type="button" data-d="${i}" class="${r.weekdays.includes(i) ? 'on' : ''}">${w}</button>`).join('')}
            </div>
            <div class="repeat-fields" id="dlg-monthly" style="${curUnit === 'month' ? '' : 'display:none;'}">
              <div><label>每月几号</label><input type="number" id="dlg-month-day" min="1" max="31" value="${r.monthDay}"></div>
            </div>
            <div class="repeat-fields" id="dlg-yearly" style="${curUnit === 'year' ? '' : 'display:none;'}">
              <div><label>月份</label><select id="dlg-year-month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === r.yearMonth ? 'selected' : ''}>${i + 1}月</option>`).join('')}</select></div>
              <div><label>日期</label><input type="number" id="dlg-year-day" min="1" max="31" value="${r.yearDay}"></div>
            </div>
            <div class="repeat-fields" id="dlg-end-wrap">
              <div><label>结束重复</label>
                <select id="dlg-end-mode">
                  <option value="never" ${r.endMode === 'never' ? 'selected' : ''}>无限重复</option>
                  <option value="date" ${r.endMode === 'date' ? 'selected' : ''}>结束于日期</option>
                  <option value="count" ${r.endMode === 'count' ? 'selected' : ''}>限制次数</option>
                </select>
              </div>
              <div id="dlg-end-date" style="${r.endMode === 'date' ? '' : 'display:none;'}"><label>结束日期</label><input type="date" id="dlg-end-date-val" value="${escapeHtml(r.endDate || '')}"></div>
              <div id="dlg-end-count" style="${r.endMode === 'count' ? '' : 'display:none;'}"><label>重复次数</label><input type="number" id="dlg-end-count-val" min="1" max="999" value="${r.endCount}"></div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">参与人</div>
          <div class="participants" id="dlg-participants"></div>
        </div>

        <div class="section">
          <div class="section-title">地点</div>
          <div class="loc-row" id="dlg-loc"></div>
          <div class="loc-hint">可手动输入地址，或点击「地图选点」模糊搜索并在地图上标点（保存真实地址 + GPS 坐标，GCJ-02）。</div>
        </div>

        <div class="section">
          <div class="section-title">提醒</div>
          <div class="rem-box">
            <label class="rem-toggle"><input type="checkbox" id="dlg-rem-on" ${rem.enabled ? 'checked' : ''}> 启用提醒</label>
            <div class="rem-mode-row ${rem.enabled ? '' : 'hidden'}" id="rem-modes">
              <button type="button" data-mode="5min" class="${rem.enabled && rem.mode === '5min' ? 'on' : ''}">提前5分钟</button>
              <button type="button" data-mode="30min" class="${rem.enabled && rem.mode === '30min' ? 'on' : ''}">提前30分钟</button>
              <button type="button" data-mode="1day" class="${rem.enabled && rem.mode === '1day' ? 'on' : ''}">提前1天</button>
              <button type="button" data-mode="custom" class="${rem.enabled && rem.mode === 'custom' ? 'on' : ''}">提前X天</button>
            </div>
            <div class="rem-custom ${rem.enabled && rem.mode === '1day' ? '' : 'hidden'}" id="rem-daytime">
              提前到当天 <input type="time" id="dlg-daytime" value="${escapeHtml(rem.dayTime || '09:00')}"> 提醒
            </div>
            <div class="rem-custom ${rem.enabled && rem.mode === 'custom' ? '' : 'hidden'}" id="rem-custom">
              提前 <input type="number" class="rem-days" id="dlg-rem-days" min="1" max="365" value="${rem.leadDays || 1}"> 天
              于 <input type="time" id="dlg-rem-time" value="${escapeHtml(rem.leadTime || '09:00')}"> 提醒
            </div>
            <div class="rem-preview hidden" id="rem-preview"></div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">图片 / 截图</div>
          <div class="img-zone" id="dlg-imgs"></div>
          <div class="img-actions">
            <button id="dlg-pick" type="button">＋ 添加图片</button>
            <button id="dlg-shot" type="button">📷 粘贴截图</button>
          </div>
        </div>

        </div>
        <div class="actions">
          ${isEdit ? '<button class="del" id="dlg-del">删除</button>' : ''}
          <button class="cancel">取消</button>
          <button class="ok">${isEdit ? '保存' : '确定'}</button>
        </div>
      </div>`

    // 关闭按钮 + 删除按钮（编辑模式，删除移入详情内部）
    const closeBtn = overlay.querySelector('#dlg-close')
    if (closeBtn) closeBtn.addEventListener('click', () => overlay.remove())
    const delBtn = overlay.querySelector('#dlg-del')
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!window.confirm(`确定删除「${t.title}」？此操作不可恢复。`)) return
      try { await api.workbenchDelete(t.id) } catch (e) {}
      overlay.remove(); await loadData()
    })

    // 类型选择（内联图标网格：标签在左、图标在右，点选即切换）
    let curType = type
    const typeName = overlay.querySelector('#dlg-type-name')
    const typeIcons = overlay.querySelector('#dlg-type-icons')
    typeIcons.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      curType = b.dataset.type
      typeIcons.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
      typeName.textContent = TYPE_LABELS[curType]
    }))

    // tabs
    overlay.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      overlay.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b))
      overlay.querySelector('#tab-single').classList.toggle('active', b.dataset.tab === 'single')
      overlay.querySelector('#tab-recur').classList.toggle('active', b.dataset.tab === 'recur')
      computeReminderPreview()
    }))
    // 周期单位（每天/每周/每月/每年）分段 + 下拉保持同步
    const unitSeg = overlay.querySelector('#dlg-recur-unit')
    const unitSel = overlay.querySelector('#dlg-unit')
    const wdPick = overlay.querySelector('#dlg-weekdays')
    const monthlyEl = overlay.querySelector('#dlg-monthly')
    const yearlyEl = overlay.querySelector('#dlg-yearly')
    function applyUnit(u) {
      curUnit = u
      unitSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.unit === u))
      if (unitSel.value !== u) unitSel.value = u
      wdPick.style.display = u === 'week' ? '' : 'none'
      monthlyEl.style.display = u === 'month' ? '' : 'none'
      yearlyEl.style.display = u === 'year' ? '' : 'none'
      computeReminderPreview()
    }
    unitSeg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => applyUnit(b.dataset.unit)))
    unitSel.addEventListener('change', () => applyUnit(unitSel.value))
    wdPick.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { b.classList.toggle('on'); computeReminderPreview() }))
    const endModeSel = overlay.querySelector('#dlg-end-mode')
    const endDateEl = overlay.querySelector('#dlg-end-date')
    const endCountEl = overlay.querySelector('#dlg-end-count')
    endModeSel.addEventListener('change', () => {
      endDateEl.style.display = endModeSel.value === 'date' ? '' : 'none'
      endCountEl.style.display = endModeSel.value === 'count' ? '' : 'none'
    })

    // 提醒模式
    const remOn = overlay.querySelector('#dlg-rem-on')
    const remModes = overlay.querySelector('#rem-modes')
    const remDaytime = overlay.querySelector('#rem-daytime')
    const remCustom = overlay.querySelector('#rem-custom')
    let curMode = rem.enabled ? rem.mode : '5min'
    remOn.addEventListener('change', () => {
      remModes.classList.toggle('hidden', !remOn.checked)
      remDaytime.classList.toggle('hidden', !(remOn.checked && curMode === '1day'))
      remCustom.classList.toggle('hidden', !(remOn.checked && curMode === 'custom'))
      computeReminderPreview()
    })
    remModes.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      curMode = b.dataset.mode
      remModes.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
      remDaytime.classList.toggle('hidden', curMode !== '1day')
      remCustom.classList.toggle('hidden', curMode !== 'custom')
      computeReminderPreview()
    }))

    // 图片
    const imgZone = overlay.querySelector('#dlg-imgs')
    function renderImgs() {
      imgZone.innerHTML = images.map((f, i) => `<div class="thumb"><img data-filename="${escapeHtml(f)}" alt=""><button class="rm" data-i="${i}" title="移除">×</button></div>`).join('')
      imgZone.querySelectorAll('img[data-filename]').forEach(async (img) => { try { const u = await api.workbenchReadImage(img.dataset.filename); if (u) img.src = u } catch (e) {} })
      imgZone.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', async () => { const i = parseInt(b.dataset.i, 10); const f = images[i]; images.splice(i, 1); try { await api.workbenchDeleteImage(f) } catch (e) {} renderImgs() }))
    }
    renderImgs()
    overlay.querySelector('#dlg-pick').addEventListener('click', async () => { const added = await api.workbenchPickImages(); if (added && added.length) { images = images.concat(added); renderImgs() } })
    overlay.querySelector('#dlg-shot').addEventListener('click', async () => {
      try { const f = await api.workbenchPasteScreenshot(); if (f) { images.push(f); renderImgs() } else alert('剪贴板中没有图片，请先用截图工具（如 Win+Shift+S）复制图片。') } catch (e) { alert('截图读取失败：' + (e && e.message)) }
    })

    // 参与人
    const parEl = overlay.querySelector('#dlg-participants')
    function renderParticipants() {
      parEl.innerHTML = participants.map((p, i) => `<span class="participant-chip">${avatarHtml(p, 'pa')}<span>${escapeHtml(p.name)}</span><span class="pa-x" data-i="${i}">×</span></span>`).join('') + '<button type="button" class="participant-add" id="dlg-add-par">＋ 添加</button>'
      parEl.querySelectorAll('.pa-x').forEach((b) => b.addEventListener('click', () => { participants.splice(parseInt(b.dataset.i, 10), 1); renderParticipants() }))
      parEl.querySelector('#dlg-add-par').addEventListener('click', () => openContactPicker(participants, (p) => { if (!participants.some((x) => x.id && x.id === p.id)) { participants.push(p); renderParticipants() } }))
    }
    renderParticipants()

    // 地点
    const locEl = overlay.querySelector('#dlg-loc')
    function renderLocation() {
      if (location) {
        locEl.innerHTML = `<span class="loc-chip"><span>📍</span><span class="lc-text">${escapeHtml(location.address || (location.lat + ',' + location.lng))}</span><span class="lc-x" id="dlg-loc-x">×</span></span><button type="button" class="participant-add" id="dlg-loc-edit">地图选点</button>`
        locEl.querySelector('#dlg-loc-x').addEventListener('click', () => { location = null; renderLocation() })
      } else {
        locEl.innerHTML = `<input type="text" id="dlg-loc-text" placeholder="手动输入地址，如：石家庄市长安区XX路1号" value=""><button type="button" class="participant-add" id="dlg-loc-map">地图选点</button>`
      }
      const mapBtn = locEl.querySelector('#dlg-loc-map')
      if (mapBtn) mapBtn.addEventListener('click', () => openMapPicker(location, (loc) => { location = loc; renderLocation() }))
    }
    renderLocation()

    // ── 读取执行时间 / 提醒 + 实时预览 ──
    function fmtDT(occ) { return `${occ.getFullYear()}-${pad(occ.getMonth() + 1)}-${pad(occ.getDate())} ${pad(occ.getHours())}:${pad(occ.getMinutes())}` }
    function reminderMomentLocal(occ, rem) {
      if (rem.mode === '5min') return new Date(occ.getTime() - 5 * 60000)
      if (rem.mode === '30min') return new Date(occ.getTime() - 30 * 60000)
      if (rem.mode === '1day') { const [hh, mm] = (rem.dayTime || '09:00').split(':').map(Number); const d = new Date(occ); d.setDate(d.getDate() - 1); d.setHours(hh, mm, 0, 0); return d }
      if (rem.mode === 'custom') { const days = Math.max(1, rem.leadDays || 1); const [hh, mm] = (rem.leadTime || '09:00').split(':').map(Number); const d = new Date(occ); d.setDate(d.getDate() - days); d.setHours(hh, mm, 0, 0); return d }
      return new Date(occ.getTime())
    }
    function nextOccurrence(sched) {
      if (!sched) return null
      if (sched.mode === 'single') { const st = parseDt(sched.single && sched.single.start); return st }
      const rr = sched.recur; if (!rr) return null
      const from = new Date(); from.setHours(0, 0, 0, 0)
      for (let i = 0; i < 400; i++) { const d = new Date(from); d.setDate(d.getDate() + i); const o = occOnDate(rr, d); if (o) return o }
      return null
    }
    function readSchedule() {
      const isRecur = overlay.querySelector('#tab-recur').classList.contains('active')
      if (isRecur) {
        const unit = curUnit // 'day'|'week'|'month'|'year'
        const repeatMode = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit]
        const interval = Math.max(1, parseInt(overlay.querySelector('#dlg-interval').value, 10) || 1)
        const wds = Array.from(wdPick.querySelectorAll('button.on')).map((b) => parseInt(b.dataset.d, 10))
        const endMode = endModeSel.value
        return { mode: 'recur', recur: {
          repeatMode,
          interval,
          anchorDate: formatDate(new Date()),
          time: overlay.querySelector('#dlg-recur-time').value || '09:00',
          weekdays: unit === 'week' ? wds : [1, 2, 3, 4, 5],
          monthDay: parseInt(overlay.querySelector('#dlg-month-day').value, 10) || new Date().getDate(),
          yearMonth: parseInt(overlay.querySelector('#dlg-year-month').value, 10) || (new Date().getMonth() + 1),
          yearDay: parseInt(overlay.querySelector('#dlg-year-day').value, 10) || new Date().getDate(),
          endMode,
          endDate: endMode === 'date' ? overlay.querySelector('#dlg-end-date-val').value : '',
          endCount: endMode === 'count' ? Math.max(1, parseInt(overlay.querySelector('#dlg-end-count-val').value, 10) || 1) : 1,
          countFired: 0, lastFired: null,
        } }
      }
      return { mode: 'single', single: { start: overlay.querySelector('#dlg-s-start').value || `${formatDate(new Date())}T09:00`, end: overlay.querySelector('#dlg-s-end').value || '' } }
    }
    function readReminder() {
      if (!remOn.checked) return { enabled: false, mode: 'none', dayTime: '09:00', leadDays: 1, leadTime: '09:00' }
      if (curMode === 'custom') {
        return { enabled: true, mode: 'custom', dayTime: '09:00', leadDays: Math.max(1, parseInt(overlay.querySelector('#dlg-rem-days').value, 10) || 1), leadTime: overlay.querySelector('#dlg-rem-time').value || '09:00' }
      }
      return { enabled: true, mode: curMode, dayTime: curMode === '1day' ? (overlay.querySelector('#dlg-daytime').value || '09:00') : '09:00', leadDays: 1, leadTime: '09:00' }
    }
    function computeReminderPreview() {
      const preview = overlay.querySelector('#rem-preview')
      if (!preview) return
      const rem = readReminder()
      if (!rem.enabled) { preview.className = 'rem-preview hidden'; preview.textContent = ''; return }
      const occ = nextOccurrence(readSchedule())
      if (!occ) { preview.className = 'rem-preview warn'; preview.textContent = '⚠️ 无后续执行时间，提醒不会触发'; return }
      const rf = reminderMomentLocal(occ, rem)
      const modeText = rem.mode === '5min' ? '提前5分钟' : rem.mode === '30min' ? '提前30分钟' : rem.mode === '1day' ? '提前1天 ' + (rem.dayTime || '09:00') : '提前' + (rem.leadDays || 1) + '天 ' + (rem.leadTime || '09:00')
      const past = rf.getTime() < Date.now()
      preview.className = 'rem-preview' + (past ? ' warn' : '')
      preview.textContent = (past ? '⏰ 提醒时间已过：' : '⏰ 将于 ') + fmtDT(rf) + ' 提醒（' + modeText + '）'
    }
    overlay.addEventListener('input', computeReminderPreview)
    overlay.addEventListener('change', computeReminderPreview)
    computeReminderPreview()

    async function submit() {
      const title = overlay.querySelector('#dlg-title').value.trim()
      if (!title) return
      const schedule = readSchedule()
      const reminder = readReminder()
      const pickedLocation = location || (function () { const tx = overlay.querySelector('#dlg-loc-text'); return (tx && tx.value.trim()) ? { address: tx.value.trim(), lat: null, lng: null } : null })()
      const patch = {
        title, type: curType, quadrant: q,
        schedule, reminder,
        note: overlay.querySelector('#dlg-note').value, images, participants, location: pickedLocation,
      }
      if (isEdit) await api.workbenchUpdate(t.id, patch)
      else await api.workbenchAdd(patch)
      overlay.remove(); await loadData()
    }
    overlay.querySelector('.ok').addEventListener('click', submit)
    overlay.querySelector('#dlg-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
    overlay.querySelector('.cancel').addEventListener('click', () => overlay.remove())
    overlay.querySelector('#dlg-title').focus()
  }

  function openEditDialog(id, defaultQuadrant) {
    const t = id ? tasks.find((x) => x.id === id) : null
    if (id && !t) return
    const overlay = createOverlay()
    buildDialogContent(overlay, t, defaultQuadrant)
  }

  // ── Type picker（点击图标弹选）──
  function openTypePicker(currentType, onPick) {
    const overlay = document.createElement('div')
    overlay.className = 'type-popup-overlay'
    document.body.appendChild(overlay)
    const popup = document.createElement('div')
    popup.className = 'type-popup'
    popup.innerHTML = TYPE_ORDER.map((k) => `<button type="button" data-type="${k}" class="${k === currentType ? 'on' : ''}"><span class="ic">${TYPE_ICONS[k]}</span>${TYPE_LABELS[k]}</button>`).join('')
    document.body.appendChild(popup)
    const anchor = document.getElementById('dlg-type-btn')
    const r = anchor.getBoundingClientRect()
    let left = r.left; let top = r.bottom + 6
    popup.style.left = Math.max(8, Math.min(left, window.innerWidth - popup.offsetWidth - 8)) + 'px'
    popup.style.top = Math.min(top, window.innerHeight - popup.offsetHeight - 8) + 'px'
    function close() { overlay.remove(); popup.remove() }
    overlay.addEventListener('click', close)
    popup.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { onPick(b.dataset.type); close() }))
  }

  // ── Contact picker（通讯录 + 拼音模糊搜索）──
  async function openContactPicker(existing, onPick) {
    let all = []
    try { all = await api.workbenchContacts() } catch (e) { all = [] }
    const overlay = createOverlay()
    overlay.style.zIndex = 10001
    const panel = document.createElement('div')
    panel.className = 'contact-picker'
    panel.style.left = '50%'; panel.style.top = '50%'; panel.style.transform = 'translate(-50%,-50%)'
    panel.innerHTML = `<div class="cp-title">选择参与人</div><input class="cp-search" placeholder="搜索姓名 / 拼音（如 zhangsan / zs）" autocomplete="off">`
    const listEl = document.createElement('div'); listEl.className = 'cp-list'
    panel.appendChild(listEl)
    function render(q) {
      q = (q || '').trim().toLowerCase()
      const avail = all.filter((c) => !existing.some((e) => e.id && c.id && e.id === c.id))
      const matched = avail.filter((c) => {
        if (!q) return true
        if (c.name && c.name.toLowerCase().includes(q)) return true
        if (c.py && c.py.includes(q)) return true
        if (c.initials && c.initials.includes(q)) return true
        return false
      })
      if (!matched.length) { listEl.innerHTML = '<div class="cp-empty">未找到匹配的联系人</div>'; return }
      listEl.innerHTML = matched.map((c) => {
        const fb = (c.name || '?').charAt(0)
        const av = c.avatar ? `<div class="cp-avatar"><img src="${escapeHtml(c.avatar)}" onerror="this.style.display='none'">${fb}</div>` : `<div class="cp-avatar">${fb}</div>`
        return `<div class="cp-item" data-id="${escapeHtml(c.id)}">${av}<span class="cp-name">${escapeHtml(c.name || c.id)}</span></div>`
      }).join('')
      listEl.querySelectorAll('.cp-item').forEach((el) => el.addEventListener('click', () => {
        const c = matched.find((x) => x.id === el.dataset.id)
        if (c) onPick({ id: c.id, name: c.name, avatar: c.avatar })
        overlay.remove()
      }))
    }
    const search = panel.querySelector('.cp-search')
    search.addEventListener('input', () => render(search.value))
    render('')
    overlay.appendChild(panel)
    search.focus()
  }

  // ── Map picker（高德地图 JS API，GCJ-02；Key 由用户自备并在本地持久化，合规不内置任何 Key）──
  function loadAMap(key) {
    return new Promise((resolve, reject) => {
      if (window.AMap) return resolve(window.AMap)
      const s = document.createElement('script')
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key) + '&plugin=AMap.PlaceSearch,AMap.Geocoder,AMap.Geolocation,AMap.CitySearch'
      s.onload = () => { setTimeout(() => { if (window.AMap) resolve(window.AMap); else reject(new Error('地图 SDK 未就绪')) }, 300) }
      s.onerror = () => reject(new Error('地图脚本加载失败（请检查网络或 Key）'))
      document.head.appendChild(s)
    })
  }
  async function openMapPicker(current, onPick) {
    const overlay = createOverlay()
    overlay.style.zIndex = 10002
    const dialog = document.createElement('div')
    dialog.className = 'dialog map-dialog'
    dialog.innerHTML = `
      <div class="dialog-head">
        <h3>选择地点</h3>
        <button type="button" class="dlg-x" id="map-close" title="关闭">×</button>
      </div>
      <div class="dialog-body map-body">
        <div class="map-key-row">
          <input type="text" id="map-key" placeholder="高德地图 Key（请在高德开放平台 console.amap.com 自行申请，仅本地保存）" value="${escapeHtml(mapKey)}" autocomplete="off">
          <button type="button" id="map-key-save">保存Key</button>
          <span class="mk-hint">未配置时无法加载地图</span>
        </div>
        <div class="map-stage">
          <div class="map-search">
            <input type="text" id="map-kw" placeholder="搜索地点，如：石家庄北国商城" autocomplete="off">
            <button type="button" id="map-search-btn">搜索</button>
          </div>
          <button type="button" class="map-locate-btn" id="map-locate-btn" title="自动定位">📍</button>
          <div id="map-picker"></div>
          <div class="map-results" id="map-results" hidden></div>
          <div class="map-current" id="map-current">点击地图选点，或搜索 / 自动定位后选择；下方显示已选地址与坐标。</div>
        </div>
        <div class="map-note">坐标为 GCJ-02（高德/腾讯标准），仅保存在本机工作台数据，不上传。Key 申请路径：高德开放平台控制台 → 应用管理 → 新建应用 → 添加「Web端(JS API)」Key。</div>
      </div>
      <div class="actions">
        <button class="cancel">取消</button>
        <button class="ok">确定</button>
      </div>`
    overlay.appendChild(dialog)

    const keyInput = dialog.querySelector('#map-key')
    const curEl = dialog.querySelector('#map-current')
    const resultsEl = dialog.querySelector('#map-results')
    const locateBtn = dialog.querySelector('#map-locate-btn')
    let picked = null

    dialog.querySelector('#map-close').addEventListener('click', () => overlay.remove())
    dialog.querySelector('#map-key-save').addEventListener('click', async () => {
      const k = keyInput.value.trim()
      if (!k) { curEl.textContent = '请先填写高德地图 Key（仅本地保存，用于加载地图）'; return }
      try { mapKey = await api.workbenchSetMapKey(k) } catch (e) {}
      initMap(k)
    })
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dialog.querySelector('#map-key-save').click() })

    async function initMap(k) {
      if (!k) { curEl.textContent = '尚未配置地图 Key：请在上方填入高德地图 Key 后点「保存Key」。'; return }
      try {
        const AMap = await loadAMap(k)
        const center = current && current.lat != null ? [current.lng, current.lat] : [114.502, 38.048]
        const map = new AMap.Map('map-picker', { center, zoom: current && current.lat != null ? 15 : 11 })
        let marker = null
        function setMarker(lng, lat) {
          const pos = [lng, lat]
          if (marker) marker.setPosition(pos); else marker = new AMap.Marker({ position: pos, map })
          map.setCenter(pos)
          map.setZoom(Math.max(map.getZoom(), 13))
        }
        async function setPin(lng, lat, addrText) {
          setMarker(lng, lat)
          if (addrText) {
            picked = { address: addrText, lat, lng }
            curEl.innerHTML = `<b>已选：</b>${escapeHtml(addrText)}<br>坐标 ${lat.toFixed(6)}, ${lng.toFixed(6)}（GCJ-02）`
            return
          }
          try {
            const geocoder = new AMap.Geocoder()
            geocoder.getAddress([lng, lat], (status, result) => {
              const addr = (result && result.regeocode && result.regeocode.formattedAddress) || ''
              picked = { address: addr, lat, lng }
              curEl.innerHTML = `<b>已选：</b>${escapeHtml(addr || '已定位坐标')}<br>坐标 ${lat.toFixed(6)}, ${lng.toFixed(6)}（GCJ-02）`
            })
          } catch (e) { picked = { address: '', lat, lng }; curEl.innerHTML = `已选坐标：${lat.toFixed(6)}, ${lng.toFixed(6)}` }
        }
        if (current && current.lat != null) setPin(current.lng, current.lat, current.address || '')

        // 自动定位：优先 HTML5 高精度定位（需 geolocation 权限）；失败回退高德 IP 城市定位（走用户 Key 的 SDK 服务，Electron 下更稳）
        function ipLocate() {
          try {
            const cs = new AMap.CitySearch()
            cs.getLocalCity((status, result) => {
              if (status === 'complete' && result && result.center) {
                setPin(result.center.lng, result.center.lat, (result.city || '') + '（IP定位，可点击地图精确定位）')
              } else {
                curEl.textContent = '定位失败：浏览器未授权或系统定位不可用，可手动搜索或点击地图选点。'
              }
            })
          } catch (e) { curEl.textContent = '定位失败：' + (e && e.message || '') }
        }
        function locateMe() {
          curEl.textContent = '正在定位…'
          locateBtn.classList.add('loading')
          const done = () => locateBtn.classList.remove('loading')
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (pos) => { done(); setPin(pos.coords.longitude, pos.coords.latitude, '') },
              (err) => { done(); console.warn('[Map] HTML5 locate failed:', err && err.code, err && err.message); ipLocate() },
              { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
            )
          } else { done(); ipLocate() }
        }
        locateBtn.addEventListener('click', locateMe)

        map.on('click', (e) => { const ll = e.lnglat; setPin(ll.getLng(), ll.getLat()) })

        // 搜索：结果渲染为地图右上角侧浮层
        function search() {
          const kw = dialog.querySelector('#map-kw').value.trim()
          if (!kw) return
          try {
            const ps = new AMap.PlaceSearch({ pageSize: 8, city: '全国' })
            ps.search(kw, (status, result) => {
              const list = (result && result.poiList && result.poiList.pois) || []
              if (!list.length) { resultsEl.innerHTML = '<div class="map-result mr-empty">未找到匹配地点</div>'; resultsEl.hidden = false; return }
              resultsEl.innerHTML = list.map((it, i) => `<div class="map-result" data-i="${i}"><div class="mr-title">${escapeHtml(it.name || '')}</div><div class="mr-addr">${escapeHtml(it.address || '')}</div></div>`).join('')
              resultsEl.hidden = false
              resultsEl.querySelectorAll('.map-result').forEach((el) => el.addEventListener('click', () => {
                const it = list[parseInt(el.dataset.i, 10)]
                if (it && it.location) { setPin(it.location.lng, it.location.lat, (it.address || it.name || '')); resultsEl.hidden = true }
              }))
            })
          } catch (e) { resultsEl.innerHTML = '<div class="map-result mr-empty">搜索失败：' + escapeHtml(e && e.message || '') + '</div>'; resultsEl.hidden = false }
        }
        dialog.querySelector('#map-search-btn').addEventListener('click', search)
        dialog.querySelector('#map-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') search() })
      } catch (e) {
        curEl.textContent = '地图初始化失败：' + (e && e.message || '') + '（可手动输入地址替代）'
      }
    }
    initMap(mapKey)

    dialog.querySelector('.ok').addEventListener('click', () => {
      if (!picked) { if (current) { onPick(current); overlay.remove(); return } alert('请先选点或搜索选择地点'); return }
      onPick(picked); overlay.remove()
    })
    dialog.querySelector('.cancel').addEventListener('click', () => overlay.remove())
  }

  // ── Sidebar 聚合：通知 / 未读消息 / 审批（30s 轮询 + 聚焦刷新）──
  let ncTimer = null
  function fmtShortTime(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (now - d < 7 * 86400000) return WEEKDAYS[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  function sysAlertTitle(a) {
    if (a.type === 'offline') return '网络离线'
    if (a.type === 'kick') return '被踢下线'
    return '系统通知'
  }
  function sysAlertDesc(a) {
    if (a.type === 'offline') return '网络连接已断开，等待自动重连'
    if (a.type === 'kick') return (a.data && a.data.reason) || '账号已在其他设备登录'
    return (a.data && a.data.reason) || '系统通知'
  }
  function sysAlertIcon(a) {
    if (a.type === 'offline') return '📴'
    if (a.type === 'kick') return '🚫'
    return '🔔'
  }
  function renderNcData(d) {
    // 通知（系统通知：离线/被踢等）
    const sysList = document.getElementById('nc-sys-list')
    const sysCount = document.getElementById('nc-sys-count')
    const sysAlerts = d.sysAlerts || []
    sysCount.hidden = sysAlerts.length === 0
    sysCount.textContent = sysAlerts.length > 99 ? '99+' : sysAlerts.length
    sysList.innerHTML = sysAlerts.length ? sysAlerts.slice(0, 8).map((a) => `
      <div class="nc-item" title="${escapeHtml(sysAlertDesc(a))}">
        <span class="nc-ico">${sysAlertIcon(a)}</span>
        <div class="nc-body">
          <div class="nc-name">${sysAlertTitle(a)}</div>
          <div class="nc-last">${escapeHtml(sysAlertDesc(a))}</div>
        </div>
        <span class="nc-time">${fmtShortTime(a.time)}</span>
      </div>`).join('') : '<div class="nc-empty">暂无系统通知</div>'

    // 未读消息（点击打开会话 + 标记已读）
    const unreadList = document.getElementById('nc-unread-list')
    const unreadCount = document.getElementById('nc-unread-count')
    const unread = d.unread || []
    const totalUnread = unread.reduce((s, it) => s + (it.count || 0), 0)
    unreadCount.hidden = totalUnread === 0
    unreadCount.textContent = totalUnread > 99 ? '99+' : totalUnread
    unreadList.innerHTML = unread.length ? unread.slice(0, 8).map((it) => {
      const fb = (it.name || '?').charAt(0)
      const av = it.avatar ? `<img src="${escapeHtml(it.avatar)}" onerror="this.remove()">${escapeHtml(fb)}` : escapeHtml(fb)
      return `
      <div class="nc-item" title="点击打开会话">
        <div class="nc-avatar">${av}</div>
        <div class="nc-body">
          <div class="nc-name">${escapeHtml(it.name)}</div>
          <div class="nc-last">${escapeHtml(it.last)}</div>
        </div>
        <span class="nc-badge">${(it.count || 0) > 99 ? '99+' : it.count}</span>
      </div>`
    }).join('') : '<div class="nc-empty">暂无未读消息</div>'
    unreadList.querySelectorAll('.nc-item').forEach((el, i) => el.addEventListener('click', () => {
      const it = unread[i]
      if (!it) return
      try { if (api.ncMarkRead) api.ncMarkRead(it.conversationId) } catch (e) {}
      if (it.url && api.openBrowser) api.openBrowser(it.url)
    }))

    // 审批（仅计数未处理的待审批）
    const apprList = document.getElementById('nc-appr-list')
    const apprCount = document.getElementById('nc-appr-count')
    const approvals = d.approvals || []
    const pend = approvals.filter((a) => a.status === 'pending').length
    apprCount.hidden = pend === 0
    apprCount.textContent = pend > 99 ? '99+' : pend
    apprCount.className = 'nc-count' + (pend ? ' amber' : '')
    apprList.innerHTML = approvals.length ? approvals.slice(0, 8).map((a) => {
      const st = a.status === 'approved' ? 'approved' : a.status === 'rejected' ? 'rejected' : 'pending'
      const stTxt = a.status === 'approved' ? '通过' : a.status === 'rejected' ? '拒绝' : '待审'
      return `
      <div class="nc-item" title="${escapeHtml(a.title)}${a.applicant ? ' · ' + escapeHtml(a.applicant) : ''}">
        <span class="nc-ico">📋</span>
        <div class="nc-body">
          <div class="nc-name">${escapeHtml(a.title)}</div>
          <div class="nc-last">${escapeHtml(a.applicant || '审批事项')} · ${fmtShortTime(a.time)}</div>
        </div>
        <span class="nc-status ${st}">${stTxt}</span>
      </div>`
    }).join('') : '<div class="nc-empty">暂无审批</div>'
    apprList.querySelectorAll('.nc-item').forEach((el, i) => el.addEventListener('click', () => {
      const a = approvals[i]
      if (a && a.url && api.openBrowser) api.openBrowser(a.url)
    }))
  }
  async function refreshNcData() {
    try {
      if (!api.workbenchNcData) return
      renderNcData(await api.workbenchNcData())
    } catch (e) { /* 侧栏聚合失败不影响主界面 */ }
  }
  function startNcPolling() {
    refreshNcData()
    if (ncTimer) clearInterval(ncTimer)
    ncTimer = setInterval(refreshNcData, 30000)
  }

  // ── Init ──
  if (isNarrow) { collapseBtn.textContent = '☰'; collapseBtn.title = '打开日历' }
  loadData()
  startClock()
  startNcPolling()
  window.addEventListener('focus', () => { loadData(); refreshNcData() })
})()
