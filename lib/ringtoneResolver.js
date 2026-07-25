// lib/ringtoneResolver.js
// 铃声解析：个人专属 > 场景默认 > 全局默认，受通知模式与每场景开关约束。
// 返回 file:// 绝对路径 或 null（不播放）。

const path = require('path')

function createRingtoneResolver({ settingsStore, assetsDir, userDataDir, presets }) {
  // rel 形如 'assets/ringtone.m4a' 或 'ringtones/<hash>.mp3' 或 'default'
  function toFile(rel) {
    if (!rel) return null
    if (rel === 'default') rel = presets.default
    if (rel.startsWith('assets/')) {
      const p = path.join(assetsDir, rel)
      return 'file:///' + p.replace(/\\/g, '/')
    }
    if (rel.startsWith('ringtones/')) {
      // getRingtoneDir() 返回的 userDataDir 已是 ".../ringtones" 目录，
      // 而 rel 形如 "ringtones/<hash>.<ext>"，必须去掉前缀再拼接，
      // 否则会得到 ".../ringtones/ringtones/..." 这样的错误路径，
      // 用户上传的铃声文件找不到 → 播放无声（内置 assets/ 铃声不受影响）。
      const file = rel.slice('ringtones/'.length)
      const p = path.join(userDataDir, file)
      return 'file:///' + p.replace(/\\/g, '/')
    }
    return null
  }

  function resolve(callType, callerId) {
    const st = settingsStore.getMerged()
    if (st.notifyMode === 'dnd') return null       // 勿扰：全屏蔽
    if (!st.ringtoneEnabled) return null           // 总开关静音
    if (st.notifyMode === 'silent') return null    // 静音模式

    const sceneKey = { audio: 'call_audio', video: 'call_video', meeting: 'meeting', message: 'message' }[callType]
    if (!sceneKey) return null
    if (callType === 'message' && st.notifyMode === 'blockChat') return null  // 屏蔽聊天消息

    // 联系人专属：语音类合并 audio/video/meeting 为 voice
    if (callerId && st.contactRingtones && st.contactRingtones[callerId]) {
      const key = callType === 'message' ? 'message' : 'voice'
      const v = st.contactRingtones[callerId][key]
      if (v != null) return v === 'default' ? toFile(presets.default) : toFile(v)
    }

    const scene = st.ringtones[sceneKey]
    if (!scene || !scene.enabled) return null
    const v = scene.file || 'default'
    return v === 'default' ? toFile(presets.default) : toFile(v)
  }

  return { resolve, toFile }
}

module.exports = { createRingtoneResolver }
