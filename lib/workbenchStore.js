// lib/workbenchStore.js
// 个人工作台数据持久化：任务四象限 + 日历视图 + 备注/图片/时间提醒/类型/参与人/地点
// 所有数据落盘到 app.getPath('userData')/workbench/，与网页/设置完全隔离。
//   tasks.json      任务数据
//   images/<id>.*   任务附带的图片/截图（按文件存储，避免 JSON 膨胀）

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
let solar2lunar = null
try {
  const sl = require('solarlunar')
  solar2lunar = (sl && sl.default && sl.default.solar2lunar) ? sl.default.solar2lunar : (sl.solar2lunar || null)
} catch (e) { solar2lunar = null }

// 惰性获取路径：避免 require 阶段（app 未 ready）调用 app.getPath 抛错
function USER_DATA() { return app.getPath('userData') }
function WORKBENCH_DIR() { return path.join(USER_DATA(), 'workbench') }
function TASKS_PATH() { return path.join(WORKBENCH_DIR(), 'tasks.json') }
function IMAGES_DIR() { return path.join(WORKBENCH_DIR(), 'images') }

// 四象限枚举（与 UI 保持一致）
const QUADRANTS = [
  'urgent-important',      // 重要且紧急
  'important-not-urgent',  // 重要不紧急
  'urgent-not-important',  // 不重要但紧急
  'not-urgent-not-important' // 不重要不紧急
]

// 快捷类型图标 key（与 UI 图标映射一致）
// 2026-08-18：删除生活类（study/exercise/shopping/health/family）；
// 新增工程机械代理店工作场景 10 类（客户/销售/合同/交机/挖掘机/装载机/吊车/配件/培训/租赁），共 20 类
const TASK_TYPES = [
  'event', 'meeting', 'task', 'cycle-meeting', 'cycle-task',           // 通用
  'customer', 'sales', 'contract', 'delivery',                         // 客户经营
  'excavator', 'loader', 'crane', 'parts', 'repair',                   // 设备与配件
  'call', 'business', 'report', 'find', 'training', 'rent',            // 其他工作场景
]

const DEFAULTS = {
  tasks: [],
  version: 4
}

let _data = null
let _saveTimer = null

function ensureDir() {
  const dir = WORKBENCH_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const img = IMAGES_DIR()
  if (!fs.existsSync(img)) fs.mkdirSync(img, { recursive: true })
}

function load() {
  try {
    ensureDir()
    if (fs.existsSync(TASKS_PATH())) {
      const raw = JSON.parse(fs.readFileSync(TASKS_PATH(), 'utf-8'))
      _data = { ...DEFAULTS, ...raw }
      if (!Array.isArray(_data.tasks)) _data.tasks = []
      _data.tasks = _data.tasks
        .filter((t) => QUADRANTS.includes(t.quadrant))
        .map((t) => normalizeTaskShape(t))
      // order 迁移：旧数据无 order 时按文件顺序补值（保持原展示次序），一次性落盘
      let orderChanged = false
      _data.tasks.forEach((t, i) => { if (typeof t.order !== 'number') { t.order = i + 1; orderChanged = true } })
      if (orderChanged) scheduleSave()
    } else {
      _data = JSON.parse(JSON.stringify(DEFAULTS))
      saveNow()
    }
  } catch (e) {
    console.error('[Workbench] load failed, using defaults:', e && e.message)
    _data = JSON.parse(JSON.stringify(DEFAULTS))
  }
  return _data
}

function normalizeTaskShape(t) {
  return {
    id: t.id,
    title: t.title || '',
    type: TASK_TYPES.includes(t.type) ? t.type : 'event',
    quadrant: QUADRANTS.includes(t.quadrant) ? t.quadrant : 'urgent-important',
    order: typeof t.order === 'number' ? t.order : null,
    done: !!t.done,
    schedule: normalizeSchedule(t.schedule, t),
    reminder: normalizeReminder(t.reminder),
    note: t.note || '',
    images: Array.isArray(t.images) ? t.images.slice() : [],
    participants: normalizeParticipants(t.participants),
    location: normalizeLocation(t.location),
    createdAt: t.createdAt || Date.now(),
    updatedAt: t.updatedAt || Date.now(),
    overdueNotifiedAt: t.overdueNotifiedAt || '',
  }
}

function normalizeParticipants(arr) {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((p) => p && (p.id || p.name))
    .map((p) => ({ id: String(p.id || ''), name: String(p.name || ''), avatar: String(p.avatar || '') }))
    .slice(0, 50)
}

function normalizeLocation(loc) {
  if (!loc || typeof loc !== 'object') return null
  const address = String(loc.address || '').trim()
  const lat = Number(loc.lat)
  const lng = Number(loc.lng)
  if (!address && (isNaN(lat) || isNaN(lng))) return null
  return {
    address,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
  }
}

function normalizeTime(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return ''
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)))
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function normalizeDate(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function normalizeDateTime(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return ''
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
  const hh = Math.min(23, Math.max(0, parseInt(m[4], 10)))
  const mm = Math.min(59, Math.max(0, parseInt(m[5], 10)))
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function defaultStart() { const d = new Date(); return `${formatDate(d)}T09:00` }
function defaultEnd() { const d = new Date(); return `${formatDate(d)}T17:00` }

// 执行时间：single{start,end} / recur{repeatMode,time,weekdays,monthDay,yearMonth,yearDay,endMode,endDate,endCount,countFired,lastFired}
function normalizeSchedule(s, t) {
  if (s && (s.mode === 'single' || s.mode === 'recur')) {
    if (s.mode === 'single') {
      const start = normalizeDateTime(s.single && s.single.start) || defaultStart()
      const end = normalizeDateTime(s.single && s.single.end) || ''
      return { mode: 'single', single: { start, end } }
    }
    return { mode: 'recur', recur: normalizeRecur(s.recur) }
  }
  // 迁移旧数据：dueDate + dueTime → single 起点
  if (t && t.dueDate) {
    return { mode: 'single', single: { start: `${normalizeDate(t.dueDate)}T${normalizeTime(t.dueTime) || '09:00'}`, end: '' } }
  }
  return { mode: 'single', single: { start: defaultStart(), end: defaultEnd() } }
}

function normalizeRecur(r) {
  r = r || {}
  const today = new Date()
  const interval = typeof r.interval === 'number' ? Math.max(1, Math.round(r.interval)) : 1
  // anchorDate：间隔(interval>1)场景下作为"第 0 次"基准日；缺省回退到今天，保证可重现
  const anchorDate = normalizeDate(r.anchorDate) || (interval > 1 ? formatDate(today) : '')
  return {
    repeatMode: ['daily', 'weekly', 'monthly', 'yearly'].includes(r.repeatMode) ? r.repeatMode : 'daily',
    interval,
    anchorDate,
    time: normalizeTime(r.time) || '09:00',
    weekdays: Array.isArray(r.weekdays) ? r.weekdays.map(Number).filter((x) => x >= 0 && x <= 6) : [1, 2, 3, 4, 5],
    monthDay: typeof r.monthDay === 'number' ? Math.min(31, Math.max(1, r.monthDay))
      : (typeof r.anchorDay === 'number' ? Math.min(31, Math.max(1, r.anchorDay)) : today.getDate()),
    yearMonth: typeof r.yearMonth === 'number' ? Math.min(12, Math.max(1, r.yearMonth))
      : (typeof r.anchorMonth === 'number' ? Math.min(12, Math.max(1, r.anchorMonth)) : today.getMonth() + 1),
    yearDay: typeof r.yearDay === 'number' ? Math.min(31, Math.max(1, r.yearDay))
      : (typeof r.anchorDay === 'number' ? Math.min(31, Math.max(1, r.anchorDay)) : today.getDate()),
    endMode: ['never', 'date', 'count'].includes(r.endMode) ? r.endMode : 'never',
    endDate: normalizeDate(r.endDate),
    endCount: typeof r.endCount === 'number' ? Math.max(1, Math.round(r.endCount)) : 1,
    countFired: typeof r.countFired === 'number' ? Math.max(0, Math.round(r.countFired)) : 0,
    lastFired: typeof r.lastFired === 'number' ? r.lastFired : null,
  }
}

// 提醒：基于「每次执行时间」做提前提醒，模式：
//   none / 5min / 30min / 1day(+dayTime) / custom(提前 leadDays 天，于 leadTime 时刻)
function normalizeReminder(r) {
  if (!r || typeof r !== 'object' || r.enabled === false) return { enabled: false, mode: 'none', dayTime: '09:00', leadDays: 1, leadTime: '09:00' }
  if (r.mode === '5min' || r.mode === '30min' || r.mode === '1day') {
    return { enabled: true, mode: r.mode, dayTime: normalizeTime(r.dayTime) || '09:00', leadDays: 1, leadTime: '09:00' }
  }
  if (r.mode === 'custom') {
    return {
      enabled: true, mode: 'custom',
      dayTime: '09:00',
      leadDays: typeof r.leadDays === 'number' ? Math.max(1, Math.round(r.leadDays)) : 1,
      leadTime: normalizeTime(r.leadTime) || '09:00',
    }
  }
  // 旧结构（type 'once'|'repeat' + leadMinutes）：映射到最近的提前模式
  const lead = typeof r.leadMinutes === 'number' ? r.leadMinutes : 0
  let mode = '5min'
  if (lead > 30) mode = '1day'
  else if (lead > 5) mode = '30min'
  return { enabled: true, mode, dayTime: normalizeTime(r.dayTime) || '09:00', leadDays: 1, leadTime: '09:00' }
}

function get() {
  if (!_data) load()
  return _data
}

function saveNow() {
  try {
    ensureDir()
    fs.writeFileSync(TASKS_PATH(), JSON.stringify(_data, null, 2))
  } catch (e) {
    console.error('[Workbench] save failed:', e && e.message)
  }
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => { _saveTimer = null; saveNow() }, 200)
}

function genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)
}

function formatDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// ── Public CRUD ──
function list() {
  return (get().tasks || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

function add(task) {
  if (!task || typeof task !== 'object') return null
  const quadrant = QUADRANTS.includes(task.quadrant) ? task.quadrant : 'urgent-important'
  const title = String(task.title || '').trim().slice(0, 500)
  if (!title) return null
  const item = normalizeTaskShape({
    id: genId(),
    title,
    type: TASK_TYPES.includes(task.type) ? task.type : 'event',
    quadrant,
    done: !!task.done,
    schedule: task.schedule,
    reminder: task.reminder,
    note: String(task.note || '').slice(0, 5000),
    images: Array.isArray(task.images) ? task.images.slice(0, 30) : [],
    participants: task.participants,
    location: task.location,
  })
  item.createdAt = Date.now()
  item.updatedAt = Date.now()
  // order：追加到队列末尾（四象限内拖拽排序的持久化序号）
  item.order = get().tasks.reduce((m, x) => Math.max(m, typeof x.order === 'number' ? x.order : 0), 0) + 1
  get().tasks.push(item)
  scheduleSave()
  return item
}

function update(id, patch) {
  if (!id) return null
  const t = get().tasks.find((x) => x.id === id)
  if (!t) return null
  if (patch.title !== undefined) {
    const title = String(patch.title || '').trim().slice(0, 500)
    if (!title) return null
    t.title = title
  }
  if (patch.type !== undefined && TASK_TYPES.includes(patch.type)) t.type = patch.type
  if (patch.quadrant !== undefined && QUADRANTS.includes(patch.quadrant)) t.quadrant = patch.quadrant
  if (patch.order !== undefined) t.order = (typeof patch.order === 'number') ? patch.order : t.order
  if (patch.done !== undefined) t.done = !!patch.done
  if (patch.schedule !== undefined) t.schedule = normalizeSchedule(patch.schedule, t)
  if (patch.reminder !== undefined) t.reminder = normalizeReminder(patch.reminder)
  if (patch.note !== undefined) t.note = String(patch.note || '').slice(0, 5000)
  if (patch.images !== undefined && Array.isArray(patch.images)) t.images = patch.images.slice(0, 30)
  if (patch.participants !== undefined) t.participants = normalizeParticipants(patch.participants)
  if (patch.location !== undefined) t.location = normalizeLocation(patch.location)
  t.updatedAt = Date.now()
  scheduleSave()
  return t
}

function toggle(id) {
  const t = get().tasks.find((x) => x.id === id)
  if (!t) return null
  return update(id, { done: !t.done })
}

function remove(id) {
  if (!id) return false
  const t = get().tasks.find((x) => x.id === id)
  if (!t) return false
  if (Array.isArray(t.images) && t.images.length) {
    t.images.forEach((f) => { try { fs.unlinkSync(imageFullPath(f)) } catch (e) { /* ignore */ } })
  }
  const before = get().tasks.length
  get().tasks = get().tasks.filter((x) => x.id !== id)
  if (get().tasks.length !== before) {
    scheduleSave()
    return true
  }
  return false
}

function getTasksPath() { return TASKS_PATH() }

// ── 图片存储 ──
function saveImage(buffer, ext) {
  ensureDir()
  const cleanExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
  const filename = `${genId()}.${cleanExt}`
  fs.writeFileSync(path.join(IMAGES_DIR(), filename), buffer)
  return filename
}
function imageFullPath(filename) { return path.join(IMAGES_DIR(), path.basename(String(filename))) }
function getImagesDir() { return IMAGES_DIR() }
function readImageDataUrl(filename) {
  try {
    const p = imageFullPath(filename)
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p)
    const ext = String(filename).split('.').pop().toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (e) { return null }
}
function deleteImage(filename) {
  try { fs.unlinkSync(imageFullPath(filename)); return true } catch (e) { return false }
}

// ── 通讯录（来自网页 SYNC_CONTACTS 缓存，桌面端只读）──
function loadContacts() {
  try {
    const p = path.join(USER_DATA(), 'contactsCache.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (e) { /* ignore */ }
  return []
}

// ── 时间提醒计算（基于执行时间）──
function parseDt(s) {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// 提醒实际触发时刻：基于 occStart（执行发生时刻）提前
function reminderMoment(occStart, rem) {
  if (rem.mode === '5min') return new Date(occStart.getTime() - 5 * 60000)
  if (rem.mode === '30min') return new Date(occStart.getTime() - 30 * 60000)
  if (rem.mode === '1day') {
    const [hh, mm] = (rem.dayTime || '09:00').split(':').map(Number)
    const d = new Date(occStart); d.setDate(d.getDate() - 1); d.setHours(hh, mm, 0, 0)
    return d
  }
  if (rem.mode === 'custom') {
    const days = Math.max(1, rem.leadDays || 1)
    const [hh, mm] = (rem.leadTime || '09:00').split(':').map(Number)
    const d = new Date(occStart); d.setDate(d.getDate() - days); d.setHours(hh, mm, 0, 0)
    return d
  }
  return new Date(occStart.getTime())
}

// 重复提醒是否已因「结束条件」而终止
function reminderEnded(r, nowTs) {
  if (!r) return true
  if (r.endMode === 'date') {
    const ed = normalizeDate(r.endDate)
    if (ed) { const end = new Date(ed + 'T23:59:59'); if (nowTs > end.getTime()) return true }
  } else if (r.endMode === 'count') {
    if ((r.countFired || 0) >= (r.endCount || 1)) return true
  }
  return false
}

// 间隔(interval)计算辅助
function parseDateOnly(s) {
  const d = parseDt(s)
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const wd = x.getDay() // 0=周日
  const diff = (wd === 0 ? -6 : 1 - wd)
  x.setDate(x.getDate() + diff)
  return x
}
function daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000) }

// 某日期是否命中重复规则，返回该日执行时刻（Date）或 null
// 支持 interval（每隔 X 日/周/月/年），anchorDate 为"第 0 次"基准日（缺省回退 today）
function occOnDate(r, date) {
  if (!r) return null
  const [hh, mm] = (r.time || '09:00').split(':').map(Number)
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0)
  const dim = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  const interval = Math.max(1, r.interval || 1)
  const anchor = r.anchorDate ? parseDateOnly(r.anchorDate) : null
  const dayOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (r.repeatMode === 'daily') {
    if (interval > 1) {
      if (!anchor) return at
      const diff = daysBetween(anchor, dayOnly)
      if (diff < 0 || diff % interval !== 0) return null
    }
    return at
  }
  if (r.repeatMode === 'weekly') {
    if (!(r.weekdays || []).includes(date.getDay())) return null
    if (interval > 1) {
      const aMon = anchor ? mondayOf(anchor) : mondayOf(dayOnly)
      const dMon = mondayOf(dayOnly)
      const weeks = daysBetween(aMon, dMon) / 7
      if (weeks < 0 || weeks % interval !== 0) return null
    }
    return at
  }
  if (r.repeatMode === 'monthly') {
    if (date.getDate() !== Math.min(r.monthDay || date.getDate(), dim)) return null
    if (interval > 1) {
      const base = anchor ? { y: anchor.getFullYear(), m: anchor.getMonth() + 1 } : { y: date.getFullYear(), m: (r.yearMonth || date.getMonth() + 1) }
      const months = (date.getFullYear() - base.y) * 12 + (date.getMonth() + 1 - base.m)
      if (months < 0 || months % interval !== 0) return null
    }
    return at
  }
  if (r.repeatMode === 'yearly') {
    if (!(date.getMonth() + 1 === (r.yearMonth || date.getMonth() + 1) && date.getDate() === Math.min(r.yearDay || date.getDate(), dim))) return null
    if (interval > 1) {
      const baseY = anchor ? anchor.getFullYear() : date.getFullYear()
      const years = date.getFullYear() - baseY
      if (years < 0 || years % interval !== 0) return null
    }
    return at
  }
  return null
}

// 某任务在 [from,to] 窗口内所有执行发生时刻
// 注意：from / to 均可为时间戳(number) 或 Date，内部统一转为 Date，调用方无需关心类型
function occurrenceStarts(task, from, to) {
  const fromD = (from instanceof Date) ? from : new Date(from)
  const toD = (to instanceof Date) ? to : new Date(to)
  const sched = task.schedule
  const out = []
  if (!sched || sched.mode === 'single') {
    const s = parseDt(sched && sched.single ? sched.single.start : '')
    if (s && s >= fromD && s <= toD) out.push(s)
    return out
  }
  const r = sched.recur
  if (!r) return out
  if (reminderEnded(r, toD.getTime())) return out
  for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate() + 1)) {
    const occ = occOnDate(r, d)
    if (occ) out.push(occ)
  }
  return out
}

// 返回当前需要弹通知的提醒：{ task, kind: 'once'|'repeat'|'overdue', fireAt, schedAt }
function getPendingReminders(nowTs) {
  const now = new Date(nowTs)
  const todayStr = formatDate(now)
  const out = []
  // 扫描窗口需覆盖最大"提前天数"，否则提醒时刻早于 now 但执行时刻落在窗口外的待办不会被扫描到
  let maxLead = 1
  for (const t of list()) {
    const rem = t.reminder
    if (rem && rem.enabled) {
      const ld = rem.mode === 'custom' ? Math.max(1, rem.leadDays || 1) : 1
      if (ld > maxLead) maxLead = ld
    }
  }
  const from = new Date(now); from.setDate(from.getDate() - 3)
  const to = new Date(now); to.setDate(to.getDate() + Math.min(maxLead + 1, 400))
  for (const t of list()) {
    if (t.done) continue
    // 延期（仅单次且有结束时间、未完成）
    if (t.schedule && t.schedule.mode === 'single' && t.schedule.single && t.schedule.single.end) {
      const endT = parseDt(t.schedule.single.end)
      if (endT && endT.getTime() < now.getTime() && t.overdueNotifiedAt !== todayStr) {
        out.push({ task: t, kind: 'overdue', fireAt: endT.getTime(), schedAt: endT.getTime() })
      }
    }
    const rem = t.reminder
    if (!rem || !rem.enabled) continue
    const occs = occurrenceStarts(t, from, to)
    for (const occ of occs) {
      const rm = reminderMoment(occ, rem)
      if (rm.getTime() > now.getTime()) continue
      if (rm.getTime() < now.getTime() - 24 * 3600 * 1000) continue // 跳过 24h 前的，避免堆积补弹
      if (t.schedule && t.schedule.mode === 'recur') {
        const r = t.schedule.recur
        if (r.lastFired && occ.getTime() <= r.lastFired) continue
        if (r.endMode === 'count' && (r.countFired || 0) >= (r.endCount || 1)) continue
      } else if (rem.firedOnce) continue
      out.push({ task: t, kind: t.schedule && t.schedule.mode === 'recur' ? 'repeat' : 'once', fireAt: rm.getTime(), schedAt: occ.getTime() })
    }
  }
  return out
}

function markReminderFired(id, kind, schedAt) {
  const t = get().tasks.find((x) => x.id === id)
  if (!t) return
  if (kind === 'once') { if (t.reminder) t.reminder.firedOnce = true }
  else if (kind === 'repeat') {
    if (t.schedule && t.schedule.recur) {
      t.schedule.recur.lastFired = schedAt
      if (t.schedule.recur.endMode === 'count') t.schedule.recur.countFired = (t.schedule.recur.countFired || 0) + 1
    }
  } else if (kind === 'overdue') { t.overdueNotifiedAt = formatDate(new Date(schedAt)) }
  scheduleSave()
}

// ── 日历信息（农历 / 节日 / 法定节假日 / 单双休）──
const LUNAR_FESTIVALS = {
  '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节', '7-7': '七夕',
  '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节', '12-23': '小年',
}
const SOLAR_FESTIVALS = {
  '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节', '5-1': '劳动节',
  '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节', '10-1': '国庆节',
  '12-24': '平安夜', '12-25': '圣诞节',
}
// 2026 法定节假日（官方，已核实）。键：YYYY-MM-DD；值：节假日名称
const HOLIDAYS_2026 = (function () {
  const m = {}
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // 按真实日期逐日遍历（字符串不能 i++，必须用 Date 递增）
  const add = (a, b, name) => {
    const [ay, am, ad] = a.split('-').map(Number)
    const [by, bm, bd] = b.split('-').map(Number)
    const cur = new Date(ay, am - 1, ad)
    const end = new Date(by, bm - 1, bd)
    while (cur <= end) { m[fmt(cur)] = name; cur.setDate(cur.getDate() + 1) }
  }
  add('2026-01-01', '2026-01-03', '元旦')
  add('2026-02-15', '2026-02-23', '春节')
  add('2026-04-04', '2026-04-06', '清明')
  add('2026-05-01', '2026-05-05', '劳动节')
  add('2026-06-19', '2026-06-21', '端午节')
  add('2026-09-25', '2026-09-27', '中秋节')
  add('2026-10-01', '2026-10-07', '国庆节')
  return m
})()
// 2026 调休补班（周末上班）
const MAKEUP_2026 = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']

function calendarInfo(year, month, restMode) {
  const dim = new Date(year, month, 0).getDate()
  const rest = restMode === 'single' ? 'single' : 'double'
  const days = []
  for (let d = 1; d <= dim; d++) {
    const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    let lunarText = '', festival = '', isHoliday = false, isMakeup = false
    if (solar2lunar) {
      try {
        const L = solar2lunar(year, month, d)
        const lMonth = L.lMonth, lDay = L.lDay
        lunarText = (lDay === 1) ? (L.monthCn || '正月') : (L.dayCn || '')
        const lf = LUNAR_FESTIVALS[`${lMonth}-${lDay}`]
        const sf = SOLAR_FESTIVALS[`${month}-${d}`] || (L.term || '')
        festival = lf || sf || ''
      } catch (e) { /* ignore */ }
    }
    const holidayName = HOLIDAYS_2026[ds]
    if (holidayName) { isHoliday = true; festival = holidayName }
    if (MAKEUP_2026.includes(ds)) isMakeup = true
    const wd = new Date(year, month - 1, d).getDay()
    let isRest = false
    if (isHoliday) isRest = true
    else if (isMakeup) isRest = false
    else if (rest === 'double') isRest = (wd === 0 || wd === 6)
    else isRest = (wd === 0)
    days.push({ ds, lunarText, festival, isHoliday, isMakeup, isRest })
  }
  return { year, month, restMode: rest, days }
}

module.exports = {
  QUADRANTS, TASK_TYPES,
  load, get, list, add, update, toggle, remove,
  getTasksPath, loadContacts,
  saveImage, imageFullPath, getImagesDir, readImageDataUrl, deleteImage,
  getPendingReminders, markReminderFired, reminderEnded, occOnDate, occurrenceStarts,
  calendarInfo,
}
