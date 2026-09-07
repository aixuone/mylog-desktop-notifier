// lib/settingsStore.js
// 用户偏好持久化：settings.json（通知模式/铃声/消息设置/联系人铃声关联）
// 以及 contactsCache.json（联系人元数据，来自网页 SYNC_CONTACTS 推送，桌面端只读缓存）
// 所有落盘路径均在 app.getPath('userData')（asar 之外），绝不写 __dirname。

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// 惰性获取路径：避免 require 阶段（app 未 ready）调用 app.getPath 抛错
function USER_DATA() { return app.getPath('userData') }
function SETTINGS_PATH() { return path.join(USER_DATA(), 'settings.json') }
function CONTACTS_PATH() { return path.join(USER_DATA(), 'contactsCache.json') }
function RINGTONE_DIR() { return path.join(USER_DATA(), 'ringtones') }

const DEFAULTS = {
  autoStart: true,
  notifyMode: 'normal',        // normal | silent | blockChat | dnd
  ringtoneEnabled: true,       // 铃声总开关（响铃/静音）
  ringtones: {
    call_audio: { enabled: true, file: 'default' },
    call_video: { enabled: true, file: 'default' },
    meeting:    { enabled: true, file: 'default' },
    message:    { enabled: true, file: 'assets/ringtones/default.mp3' },
  },
  contactRingtones: {},         // { [imUserId]: { message, voice } }
  localRingtones: [],           // ['ringtones/<hash>.mp3', ...]
  ringtoneNames: {},            // { 'ringtones/<hash>.mp3': '自定义铃声名' }（用户上传/重命名的展示名）
  messageNotify: { display: 'content', duration: 5 },  // content | count ; 秒（稳定版默认 5s）
  mainPageUrl: 'https://data.tygps.com/mylog-pc/',    // 托盘点击 / 主页面打开的网页地址
  mainPageHotkey: 'CommandOrControl+Shift+M',        // 切换网页窗口显示/隐藏的全局快捷键（可在设置-通用自定义）
}

let _settings = null
let _saveTimer = null

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

// 深合并：对象递归合并，数组与原始值直接覆盖（保留旧版本缺字段）
function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base)
  for (const k of Object.keys(over)) {
    const ov = over[k]
    if (ov === undefined) continue
    if (isObj(ov) && isObj(out[k])) {
      out[k] = deepMerge(out[k], ov)
    } else {
      out[k] = ov
    }
  }
  return out
}

function load() {
  try {
    if (fs.existsSync(SETTINGS_PATH())) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf-8'))
      _settings = deepMerge(DEFAULTS, raw)
      // 迁移：消息通知默认铃声统一指向内置 default.mp3（旧版存的是 'default' 令牌→ringtone.m4a）
      if (_settings.ringtones && _settings.ringtones.message && _settings.ringtones.message.file === 'default') {
        _settings.ringtones.message.file = 'assets/ringtones/default.mp3'
      }
      // 迁移：消息提醒默认时长统一为 5 秒（旧默认 8 秒，非用户显式设定）
      if (_settings.messageNotify && _settings.messageNotify.duration === 8) {
        _settings.messageNotify.duration = 5
      }
    } else {
      _settings = JSON.parse(JSON.stringify(DEFAULTS))
      saveNow()
    }
  } catch (e) {
    console.error('[Settings] load failed, using defaults:', e && e.message)
    _settings = JSON.parse(JSON.stringify(DEFAULTS))
  }
  return _settings
}

function get() { return _settings || load() }
function getMerged() { return get() }

function set(partial) {
  _settings = deepMerge(_settings || JSON.parse(JSON.stringify(DEFAULTS)), partial)
  scheduleSave()
  return _settings
}

function saveNow() {
  try {
    const ud = USER_DATA()
    if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true })
    fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(_settings, null, 2))
  } catch (e) {
    console.error('[Settings] save failed:', e && e.message)
  }
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => { _saveTimer = null; saveNow() }, 300)
}

function addLocalRingtone(rel) {
  const s = get()
  if (!Array.isArray(s.localRingtones)) s.localRingtones = []
  if (!s.localRingtones.includes(rel)) s.localRingtones.push(rel)
  scheduleSave()
  return s.localRingtones
}

// 设置/清除某铃声的展示名（rel → name；name 为空串/纯空白则清除自定义名，回退为文件名显示）
function setRingtoneName(rel, name) {
  const s = get()
  if (!s.ringtoneNames || typeof s.ringtoneNames !== 'object') s.ringtoneNames = {}
  const v = (typeof name === 'string' ? name : '').trim()
  if (v) s.ringtoneNames[rel] = v
  else delete s.ringtoneNames[rel]
  scheduleSave()
  return s.ringtoneNames
}

// 真正删除某个联系人的专属铃声设置。
// 注意：set() 使用 deepMerge，partial 里缺失的 key 不会被删除，
// 因此删除必须用本函数显式 delete 后落盘，普通 settingsSave 无法移除 key。
function removeContactRingtone(cid) {
  const s = get()
  if (s.contactRingtones && cid) {
    delete s.contactRingtones[cid]
    scheduleSave()
  }
  return (s.contactRingtones || {})
}

// 删除用户上传的铃声（rel 形如 'ringtones/<hash>.<ext>'）：
// 1) 从 localRingtones 移除；2) 清理 ringtoneNames 映射；
// 3) 所有场景引用回退默认（message → 内置 default.mp3，其余 → 'default' 经典铃声）；
// 4) 联系人专属引用（message/voice）移除字段，空对象一并清理。
// 注意：deepMerge 无法删除 key，必须显式 delete 后落盘；物理文件删除由主进程负责。
function removeLocalRingtone(rel) {
  const s = get()
  if (!rel || typeof rel !== 'string' || !rel.startsWith('ringtones/')) return s
  // 1) 候选列表
  if (Array.isArray(s.localRingtones)) {
    s.localRingtones = s.localRingtones.filter((x) => x !== rel)
  }
  // 2) 展示名映射
  if (s.ringtoneNames && s.ringtoneNames[rel]) delete s.ringtoneNames[rel]
  // 3) 场景引用回退默认
  if (s.ringtones && typeof s.ringtones === 'object') {
    for (const k of Object.keys(s.ringtones)) {
      const sc = s.ringtones[k]
      if (sc && sc.file === rel) {
        sc.file = k === 'message' ? 'assets/ringtones/default.mp3' : 'default'
      }
    }
  }
  // 4) 联系人专属引用移除（空对象清理）
  if (s.contactRingtones && typeof s.contactRingtones === 'object') {
    for (const cid of Object.keys(s.contactRingtones)) {
      const cr = s.contactRingtones[cid] || {}
      if (cr.message === rel) delete cr.message
      if (cr.voice === rel) delete cr.voice
      if (Object.keys(cr).length === 0) delete s.contactRingtones[cid]
    }
  }
  scheduleSave()
  return s
}

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_PATH())) {
      return JSON.parse(fs.readFileSync(CONTACTS_PATH(), 'utf-8'))
    }
  } catch (e) {
    console.error('[Settings] contacts load failed:', e && e.message)
  }
  return []
}

function saveContacts(list) {
  try {
    const ud = USER_DATA()
    if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true })
    fs.writeFileSync(CONTACTS_PATH(), JSON.stringify(list || [], null, 2))
  } catch (e) {
    console.error('[Settings] contacts save failed:', e && e.message)
  }
}

module.exports = {
  DEFAULTS,
  getUserData: USER_DATA,
  getRingtoneDir: RINGTONE_DIR,
  load, get, getMerged, set, saveNow, addLocalRingtone, setRingtoneName, removeLocalRingtone, removeContactRingtone,
  loadContacts, saveContacts,
}
