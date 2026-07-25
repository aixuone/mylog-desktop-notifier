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
  messageNotify: { display: 'content', duration: 8 },  // content | count ; 秒
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
  load, get, getMerged, set, saveNow, addLocalRingtone, removeContactRingtone,
  loadContacts, saveContacts,
}
