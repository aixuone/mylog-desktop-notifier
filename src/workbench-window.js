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
    api = {
      workbenchLoad: async () => ({ tasks: mockTasks, tasksPath: '/mock/workbench/tasks.json', mapKey: '', restMode: 'double' }),
      workbenchAdd: async (t) => { const item = { id: Date.now().toString(), ...t, done: false, createdAt: Date.now(), updatedAt: Date.now() }; mockTasks.push(item); return item },
      workbenchUpdate: async (id, patch) => { const t = mockTasks.find(x => x.id === id); if (t) Object.assign(t, patch, { updatedAt: Date.now() }); return t },
      workbenchToggle: async (id) => { const t = mockTasks.find(x => x.id === id); if (t) { t.done = !t.done; t.updatedAt = Date.now() } return t },
      workbenchDelete: async (id) => { mockTasks = mockTasks.filter(x => x.id !== id); return true },
      workbenchPickImages: async () => [],
      workbenchPasteScreenshot: async () => null,
      workbenchReadImage: async () => null,
      workbenchOpenImage: async () => {},
      workbenchDeleteImage: async () => {},
      workbenchContacts: async () => [
        { id: 'u1', name: '张三', avatar: '', py: 'zhangsan', initials: 'zs' },
        { id: 'u2', name: '李四', avatar: '', py: 'lisi', initials: 'ls' },
        { id: 'u3', name: '王小明', avatar: '', py: 'wangxiaoming', initials: 'wxm' },
      ],
      workbenchSetMapKey: async (k) => k,
      workbenchSetRestMode: async (m) => m,
      workbenchCalendarInfo: async (y, m, rest) => mockCalendarInfo(y, m, rest || 'double'),
    }
  }

  const QUADRANTS = [
    { key: 'urgent-important', label: '重要且紧急', color: '#EF4444' },
    { key: 'important-not-urgent', label: '重要不紧急', color: '#F59E0B' },
    { key: 'urgent-not-important', label: '不重要但紧急', color: '#22C55E' },
    { key: 'not-urgent-not-important', label: '不重要不紧急', color: '#9CA3AF' },
  ]
  const QUAD_COLOR = {}
  QUADRANTS.forEach((q) => { QUAD_COLOR[q.key] = q.color })
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

  const TYPE_ICONS = {
    event: '●', meeting: '📅', call: '📞', business: '✈️', report: '📊', repair: '🔧', find: '🔍', more: '⋯',
  }
  const TYPE_LABELS = {
    event: '事件', meeting: '会议', call: '电话', business: '出差', report: '汇报', repair: '维修', find: '找人', more: '更多',
  }
  const TYPE_ORDER = ['event', 'meeting', 'call', 'business', 'report', 'repair', 'find', 'more']

  let tasks = []
  let tasksPath = ''
  let currentView = 'quadrant'
  let currentCalDate = new Date()
  let selectedDate = formatDate(new Date())
  let refreshTimer = null
  const calInfoCache = {}

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
    let base = ''
    if (!r) base = ''
    else if (r.repeatMode === 'daily') base = '每天 ' + time
    else if (r.repeatMode === 'weekly') base = '每周' + (r.weekdays || []).map((d) => WEEKDAYS[Number(d)]).join('') + ' ' + time
    else if (r.repeatMode === 'monthly') base = '每月' + (r.monthDay || '?') + '号 ' + time
    else if (r.repeatMode === 'yearly') base = '每年' + (r.yearMonth || '?') + '月' + (r.yearDay || '?') + '日 ' + time
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

    QUADRANTS.forEach((q) => {
      const el = board.querySelector(`.quad[data-quadrant="${q.key}"]`)
      const list = el.querySelector('.quad-list')
      const qt = tasks.filter((t) => t.quadrant === q.key)
      const undone = qt.filter((t) => !t.done)
      const done = qt.filter((t) => t.done)
      const sorted = undone.concat(done)
      el.querySelector('.quad-count').textContent = `${undone.length}/${qt.length}`
      list.innerHTML = sorted.length ? sorted.map(renderTask).join('') : '<div class="empty">暂无待办</div>'
      el.querySelector('[data-action="add"]').addEventListener('click', () => openEditDialog(null, q.key))

      list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drag-over') })
      list.addEventListener('dragleave', () => list.classList.remove('drag-over'))
      list.addEventListener('drop', async (e) => {
        e.preventDefault(); list.classList.remove('drag-over')
        const id = e.dataTransfer.getData('text/plain')
        const target = list.dataset.drop
        if (id && target) { await api.workbenchUpdate(id, { quadrant: target }); await loadData() }
      })

      list.querySelectorAll('.task').forEach((node) => {
        const id = node.dataset.id
        node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', id); node.classList.add('dragging') })
        node.addEventListener('dragend', () => node.classList.remove('dragging'))
        node.querySelector('.task-check').addEventListener('click', () => toggleTask(id))
        node.querySelector('.task-text').addEventListener('dblclick', () => openEditDialog(id))
        node.querySelector('.task-del').addEventListener('click', () => deleteTask(id))
        node.querySelectorAll('.task-img').forEach((img) => img.addEventListener('click', () => api.workbenchOpenImage(img.dataset.filename)))
        const noteBadge = node.querySelector('.badge.note'); if (noteBadge) noteBadge.title = noteBadge.dataset.note || '备注'
        const locBadge = node.querySelector('.badge.loc'); if (locBadge) locBadge.title = locBadge.dataset.addr || '地点'
      })
    })
  }

  function renderTask(t) {
    const overdue = isOverdue(t)
    const typeIcon = TYPE_ICONS[t.type] || TYPE_ICONS.event
    const timeTxt = scheduleLabel(t)
    const badges = []
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
      <div class="task ${t.done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-id="${escapeHtml(t.id)}" draggable="true">
        <div class="task-check" data-id="${escapeHtml(t.id)}"></div>
        <div class="task-body">
          <div class="task-headblock">
            <span class="task-type" title="${escapeHtml(TYPE_LABELS[t.type] || '事件')}">${typeIcon}</span>
            <span class="task-text" data-id="${escapeHtml(t.id)}" title="双击编辑">${escapeHtml(t.title)}</span>
          </div>
          ${noteHtml}
          ${metaHtml}
          ${imgs}
        </div>
        <button class="task-del" data-id="${escapeHtml(t.id)}" title="删除">×</button>
      </div>`
  }

  async function loadBoardImages() {
    const imgs = Array.from(document.querySelectorAll('#board .task-img[data-filename]'))
    await Promise.all(imgs.map(async (img) => {
      try { const url = await api.workbenchReadImage(img.dataset.filename); if (url) img.src = url } catch (e) {}
    }))
  }
  async function toggleTask(id) { await api.workbenchToggle(id); await loadData() }
  async function deleteTask(id) { await api.workbenchDelete(id); await loadData() }

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
  document.getElementById('collapse-btn').addEventListener('click', () => {
    const main = document.getElementById('main')
    const collapsed = main.classList.toggle('collapsed')
    document.getElementById('collapse-btn').textContent = collapsed ? '›' : '‹'
  })

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

    let participants = isEdit && Array.isArray(t.participants) ? t.participants.slice() : []
    let location = isEdit && t.location ? t.location : null
    let images = isEdit && Array.isArray(t.images) ? t.images.slice() : []

    overlay.innerHTML = `
      <div class="dialog">
        <h3>${isEdit ? '编辑待办' : '添加待办'} · ${escapeHtml(quadLabel)}</h3>
        <div class="edit-block">
          <label style="margin-top:0;">类型</label>
          <button type="button" class="type-current" id="dlg-type-btn"><span class="ic">${TYPE_ICONS[type]}</span><span id="dlg-type-name">${TYPE_LABELS[type]}</span> <span style="color:#8BA89E;">▾</span></button>
          <label>标题</label>
          <input type="text" id="dlg-title" value="${isEdit ? escapeHtml(t.title) : ''}" placeholder="待办标题，按回车确认" maxlength="500" autocomplete="off">
          <label>备注</label>
          <textarea id="dlg-note" placeholder="补充说明...">${isEdit ? escapeHtml(t.note || '') : ''}</textarea>
        </div>
        <label>执行时间</label>
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
          <div class="repeat-fields">
            <div><label>重复类型</label>
              <select id="dlg-recur-mode">
                <option value="daily" ${r.repeatMode === 'daily' ? 'selected' : ''}>每天</option>
                <option value="weekly" ${r.repeatMode === 'weekly' ? 'selected' : ''}>每周（多选）</option>
                <option value="monthly" ${r.repeatMode === 'monthly' ? 'selected' : ''}>每月 N 号</option>
                <option value="yearly" ${r.repeatMode === 'yearly' ? 'selected' : ''}>每年 N 月 N 日</option>
              </select>
            </div>
            <div><label>时间</label><input type="time" id="dlg-recur-time" value="${escapeHtml(r.time || '09:00')}"></div>
          </div>
          <div class="weekday-pick" id="dlg-weekdays" style="${r.repeatMode === 'weekly' ? '' : 'display:none;'}">
            ${WEEKDAYS.map((w, i) => `<button type="button" data-d="${i}" class="${r.weekdays.includes(i) ? 'on' : ''}">${w}</button>`).join('')}
          </div>
          <div class="repeat-fields" id="dlg-monthly" style="${r.repeatMode === 'monthly' ? '' : 'display:none;'}">
            <div><label>每月几号</label><input type="number" id="dlg-month-day" min="1" max="31" value="${r.monthDay}"></div>
          </div>
          <div class="repeat-fields" id="dlg-yearly" style="${r.repeatMode === 'yearly' ? '' : 'display:none;'}">
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
        <label>参与人</label>
        <div class="participants" id="dlg-participants"></div>
        <label>地点</label>
        <div class="loc-row" id="dlg-loc"></div>
        <div class="loc-hint">可手动输入地址，或点击「地图选点」模糊搜索并在地图上标点（保存真实地址 + GPS 坐标，GCJ-02）。</div>
        <label>提醒（基于执行时间提前）</label>
        <div class="rem-box" style="border:1px solid #E8F0EC;border-radius:10px;padding:10px 12px;margin-top:6px;background:#FAFCFB;">
          <label style="margin:0 0 6px;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="dlg-rem-on" ${rem.enabled ? 'checked' : ''} style="width:auto;margin:0;"> 启用提醒</label>
          <div class="rem-modes ${rem.enabled ? '' : 'hidden'}" id="rem-modes" style="margin-top:6px;">
            <button type="button" data-mode="5min" class="${rem.enabled && rem.mode === '5min' ? 'on' : ''}">提前5分钟</button>
            <button type="button" data-mode="30min" class="${rem.enabled && rem.mode === '30min' ? 'on' : ''}">提前30分钟</button>
            <button type="button" data-mode="1day" class="${rem.enabled && rem.mode === '1day' ? 'on' : ''}">提前1天</button>
          </div>
          <div class="rem-daytime ${rem.enabled && rem.mode === '1day' ? '' : 'hidden'}" id="rem-daytime">
            提前到当天 <input type="time" id="dlg-daytime" value="${escapeHtml(rem.dayTime || '09:00')}"> 提醒
          </div>
        </div>
        <label>图片 / 截图</label>
        <div class="img-zone" id="dlg-imgs"></div>
        <div class="img-actions">
          <button id="dlg-pick" type="button">＋ 添加图片</button>
          <button id="dlg-shot" type="button">📷 粘贴截图</button>
        </div>
        <div class="actions">
          <button class="cancel">取消</button>
          <button class="ok">${isEdit ? '保存' : '确定'}</button>
        </div>
      </div>`

    // 类型选择（点击弹选）
    let curType = type
    const typeBtn = overlay.querySelector('#dlg-type-btn')
    const typeName = overlay.querySelector('#dlg-type-name')
    typeBtn.addEventListener('click', () => openTypePicker(curType, (nt) => { curType = nt; typeBtn.querySelector('.ic').textContent = TYPE_ICONS[nt]; typeName.textContent = TYPE_LABELS[nt] }))

    // tabs
    overlay.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      overlay.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b))
      overlay.querySelector('#tab-single').classList.toggle('active', b.dataset.tab === 'single')
      overlay.querySelector('#tab-recur').classList.toggle('active', b.dataset.tab === 'recur')
    }))
    const repModeSel = overlay.querySelector('#dlg-recur-mode')
    const wdPick = overlay.querySelector('#dlg-weekdays')
    const monthlyEl = overlay.querySelector('#dlg-monthly')
    const yearlyEl = overlay.querySelector('#dlg-yearly')
    repModeSel.addEventListener('change', () => {
      wdPick.style.display = repModeSel.value === 'weekly' ? '' : 'none'
      monthlyEl.style.display = repModeSel.value === 'monthly' ? '' : 'none'
      yearlyEl.style.display = repModeSel.value === 'yearly' ? '' : 'none'
    })
    wdPick.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')))
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
    let curMode = rem.enabled ? rem.mode : '5min'
    remOn.addEventListener('change', () => {
      remModes.classList.toggle('hidden', !remOn.checked)
      remDaytime.classList.toggle('hidden', !(remOn.checked && curMode === '1day'))
    })
    remModes.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      curMode = b.dataset.mode
      remModes.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
      remDaytime.classList.toggle('hidden', curMode !== '1day')
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

    async function submit() {
      const title = overlay.querySelector('#dlg-title').value.trim()
      if (!title) return
      const isRecur = overlay.querySelector('#tab-recur').classList.contains('active')
      let schedule
      if (isRecur) {
        const mode = repModeSel.value
        const wds = Array.from(wdPick.querySelectorAll('button.on')).map((b) => parseInt(b.dataset.d, 10))
        const endMode = endModeSel.value
        schedule = {
          mode: 'recur',
          recur: {
            repeatMode: mode,
            time: overlay.querySelector('#dlg-recur-time').value || '09:00',
            weekdays: mode === 'weekly' ? wds : [1, 2, 3, 4, 5],
            monthDay: parseInt(overlay.querySelector('#dlg-month-day').value, 10) || new Date().getDate(),
            yearMonth: parseInt(overlay.querySelector('#dlg-year-month').value, 10) || (new Date().getMonth() + 1),
            yearDay: parseInt(overlay.querySelector('#dlg-year-day').value, 10) || new Date().getDate(),
            endMode,
            endDate: endMode === 'date' ? overlay.querySelector('#dlg-end-date-val').value : '',
            endCount: endMode === 'count' ? Math.max(1, parseInt(overlay.querySelector('#dlg-end-count-val').value, 10) || 1) : 1,
            countFired: 0, lastFired: null,
          },
        }
      } else {
        schedule = { mode: 'single', single: { start: overlay.querySelector('#dlg-s-start').value || `${formatDate(new Date())}T09:00`, end: overlay.querySelector('#dlg-s-end').value || '' } }
      }
      const reminder = (function () {
        if (!remOn.checked) return { enabled: false, mode: 'none', dayTime: '09:00' }
        return { enabled: true, mode: curMode, dayTime: curMode === '1day' ? (overlay.querySelector('#dlg-daytime').value || '09:00') : '09:00' }
      })()
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

  // ── Map picker（高德地图 JS API，GCJ-02，本地私有存储）──
  function loadAMap(key) {
    return new Promise((resolve, reject) => {
      if (window.AMap) return resolve(window.AMap)
      const s = document.createElement('script')
      s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key) + '&plugin=AMap.PlaceSearch,AMap.Geocoder'
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
      <h3>选择地点</h3>
      <div class="map-key-input" id="map-key-row">
        <input type="text" id="map-key" placeholder="高德地图 Web 服务 Key（首次使用请填入，仅本地保存）" value="${escapeHtml(mapKey)}">
        <button type="button" id="map-key-save">保存Key</button>
      </div>
      <div class="map-search">
        <input type="text" id="map-kw" placeholder="模糊搜索地点，如：石家庄北国商城">
        <button type="button" id="map-search-btn">搜索</button>
      </div>
      <div class="map-wrap"><div id="map-picker"></div></div>
      <div class="map-results" id="map-results"></div>
      <div class="map-current" id="map-current">点击地图选点，或搜索后点结果；下方显示已选地址与 GPS。</div>
      <div class="map-note">坐标为 GCJ-02（高德/腾讯标准），仅保存在本机工作台数据，不上传。</div>
      <div class="actions"><button class="cancel">取消</button><button class="ok">确定</button></div>`
    overlay.appendChild(dialog)

    const keyInput = dialog.querySelector('#map-key')
    const curEl = dialog.querySelector('#map-current')
    let picked = null

    dialog.querySelector('#map-key-save').addEventListener('click', async () => {
      const k = keyInput.value.trim()
      try { mapKey = await api.workbenchSetMapKey(k) } catch (e) {}
      initMap(k)
    })

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
        }
        if (current && current.lat != null) { setMarker(current.lng, current.lat); picked = current; curEl.textContent = '已选：' + (current.address || '') + '（' + current.lat.toFixed(6) + ',' + current.lng.toFixed(6) + '）' }
        async function setPin(lng, lat, addrText) {
          setMarker(lng, lat)
          if (addrText) { picked = { address: addrText, lat, lng }; curEl.textContent = '已选：' + addrText + '（' + lat.toFixed(6) + ',' + lng.toFixed(6) + '）'; return }
          try {
            const geocoder = new AMap.Geocoder()
            geocoder.getAddress([lng, lat], (status, result) => {
              const addr = (result && result.regeocode && result.regeocode.formattedAddress) || ''
              picked = { address: addr, lat, lng }
              curEl.textContent = '已选：' + addr + '（' + lat.toFixed(6) + ',' + lng.toFixed(6) + '）'
            })
          } catch (e) { picked = { address: '', lat, lng }; curEl.textContent = '已选坐标：' + lat.toFixed(6) + ',' + lng.toFixed(6) }
        }
        map.on('click', (e) => { const ll = e.lnglat; setPin(ll.getLng(), ll.getLat()) })
        const resultsEl = dialog.querySelector('#map-results')
        dialog.querySelector('#map-search-btn').addEventListener('click', () => {
          const kw = dialog.querySelector('#map-kw').value.trim()
          if (!kw) return
          try {
            const ps = new AMap.PlaceSearch({ pageSize: 10, city: '全国' })
            ps.search(kw, (status, result) => {
              const list = (result && result.poiList && result.poiList.pois) || []
              if (!list.length) { resultsEl.innerHTML = '<div class="map-result">无结果</div>'; return }
              resultsEl.innerHTML = list.map((it, i) => `<div class="map-result" data-i="${i}"><div class="mr-title">${escapeHtml(it.name || '')}</div><div class="mr-addr">${escapeHtml(it.address || '')}</div></div>`).join('')
              resultsEl.querySelectorAll('.map-result').forEach((el) => el.addEventListener('click', () => {
                const it = list[parseInt(el.dataset.i, 10)]
                if (it && it.location) setPin(it.location.lng, it.location.lat, (it.address || it.name || ''))
              }))
            })
          } catch (e) { resultsEl.innerHTML = '<div class="map-result">搜索失败：' + escapeHtml(e && e.message || '') + '</div>' }
        })
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

  // ── Init ──
  loadData()
  startClock()
  window.addEventListener('focus', loadData)
})()
