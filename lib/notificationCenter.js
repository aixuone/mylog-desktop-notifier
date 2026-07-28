// lib/notificationCenter.js
// 通知中心主进程控制器：常驻预加载窗口 + 会话未读聚合(unreadMap) + 系统通知(sysAlerts)。
// 根除白框：窗口启动时创建并预加载，永不因消息重建，仅 show/hide。
// 会话未读走托盘红点；系统通知独立于会话，不累加红点。

const path = require('path')
const { ipcMain } = require('electron')

function createNotificationCenter(deps) {
  const { BrowserWindow, webPreferences, getWindowRect, settingsStore, ringtoneResolver, onUnreadChange, openExternal, broadcast, isWebConnected } = deps

  const W = 360
  const H = 520
  let win = null
  const unreadMap = new Map()   // conversationId -> item
  const sysAlerts = []          // { id, type, sticky, data, ringtonePath }
  let idleTimer = null
  let hiddenByUser = false      // 用户主动关闭(✕/全部已读/知道了)后，sync 刷新不再自动弹出
  const GRACE_MS = 2500         // 竞态保护：pushMessage 刚加入的会话在此时窗内不被 sync 误删

  function preCreate() {
    const rect = getWindowRect(W, H)
    win = new BrowserWindow({
      width: W, height: H, x: rect.x, y: rect.y,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#ffffff',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      hasShadow: true,
      webPreferences,
    })
    win.loadFile(path.join(__dirname, '..', 'src', 'notification-center.html'))
    win.webContents.once('did-finish-load', () => {
      sendInit()
    })
    win.on('closed', () => { win = null })
  }

  function send(channel, data) {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, data) } catch (e) {}
    }
  }

  function sendInit() {
    send('nc-init', {
      settings: settingsStore.getMerged(),
      unread: [...unreadMap.values()],
      sysAlerts: sysAlerts.slice(),
    })
  }

  function totalUnread() {
    let t = 0
    for (const it of unreadMap.values()) t += (it.count || 0)
    return t
  }

  // 是否存在常驻系统通知(被踢/离线)——这类通知不随聊天消息自动隐藏
  function hasStickyAlert() {
    for (const a of sysAlerts) if (a.sticky) return true
    return false
  }

  function pushMessage(payload) {
    const convId = payload.conversationId || payload.senderId || 'unknown'
    // 网页端下发的权威未读数（IM SDK 真实值）。若提供则以其为准，避免桌面端自行累加导致大于网页真实未读。
    const authoritative = (typeof payload.unreadCount === 'number' && payload.unreadCount >= 0)
    const existing = unreadMap.get(convId)
    if (existing) {
      existing.count = authoritative ? payload.unreadCount : existing.count + 1
      existing.last = payload.content || existing.last
      existing.time = Date.now()
      existing.pushedAt = Date.now()
      if (payload.senderName) existing.name = payload.senderName
      if (payload.senderAvatar) existing.avatar = payload.senderAvatar
      if (payload.url) existing.url = payload.url
      if (payload.senderId) existing.senderId = payload.senderId
    } else {
      unreadMap.set(convId, {
        conversationId: convId,
        name: payload.senderName || '未知用户',
        avatar: payload.senderAvatar || '',
        last: payload.content || '发来一条消息',
        count: authoritative ? payload.unreadCount : 1,
        time: Date.now(),
        pushedAt: Date.now(),
        url: payload.url || '',
        senderId: payload.senderId || '',
      })
    }

    const st = settingsStore.getMerged()
    const blocked = st.notifyMode === 'dnd' || st.notifyMode === 'blockChat'

    // 渲染层与托盘红点始终同步
    send('nc-unread', { unread: [...unreadMap.values()], total: totalUnread() })
    if (onUnreadChange) onUnreadChange(totalUnread())

    if (!blocked) {
      const rp = ringtoneResolver.resolve('message', payload.senderId)
      showWindow()
      send('nc-play', { path: rp })
    }
  }

  function showWindow() {
    hiddenByUser = false
    if (!win || win.isDestroyed()) preCreate()
    // Always recalculate position to bottom-right (user may have moved screen, etc.)
    const rect = getWindowRect(W, H)
    win.setBounds({ x: rect.x, y: rect.y, width: W, height: H })
    if (!win.isVisible()) win.show()
    resetIdle()
  }

  function resetIdle() {
    const st = settingsStore.getMerged()
    const dur = (st.messageNotify && st.messageNotify.duration) || 8
    if (idleTimer) clearTimeout(idleTimer); idleTimer = null
    // 存在常驻系统通知(被踢/离线)时，窗口持续显示，不自动隐藏；
    // 用户主动关闭后也不挂自动隐藏（避免 sync 刷新又把窗口弹出来）。
    // 需用户点击或重连上线(NET_ONLINE)才消失。
    if (hasStickyAlert() || hiddenByUser) return
    idleTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.hide()
      idleTimer = null
    }, Math.max(3, dur) * 1000)
  }

  function markRead(id) {
    if (id === 'all' || id == null) {
      unreadMap.clear()
    } else {
      unreadMap.delete(id)
    }
    send('nc-unread', { unread: [...unreadMap.values()], total: totalUnread() })
    if (onUnreadChange) onUnreadChange(totalUnread())
    // 无未读且无常驻系统通知时：视为用户已处理，隐藏窗口并标记 hiddenByUser，
    // 后续 sync 刷新不再自动弹出，直到新消息到达(pushMessage 会重置该标记)。
    if (unreadMap.size === 0 && !hasStickyAlert()) {
      hiddenByUser = true
      if (win && win.isVisible()) win.hide()
    }
  }

  // 以网页端 IM SDK 的权威未读状态为准，增量调和未读聚合（不再整表清空重建）。
  // 仅 count>0 的会话视为"有未读"；已读/归零的会话由"不在列表"表达。
  // 采用「合并 + 竞态保护」而非「清空重建」，避免 SHOW_MESSAGE_NOTIFICATION 与
  // SYNC_UNREAD 竞态时把刚到的消息误删，导致通知窗一闪即逝。
  function syncUnread(items) {
    const now = Date.now()
    const prevKeys = new Set(unreadMap.keys())
    const authIds = new Set()
    let addedViaSync = false
    ;(items || []).forEach((it) => {
      if (!it || !it.conversationId) return
      const c = (typeof it.count === 'number' && it.count > 0) ? it.count : 0
      if (c <= 0) return
      authIds.add(it.conversationId)
      const existing = unreadMap.get(it.conversationId)
      if (existing) {
        existing.count = c
        if (it.name) existing.name = it.name
        if (it.avatar) existing.avatar = it.avatar
        if (it.last) existing.last = it.last
        if (it.url) existing.url = it.url
        if (it.senderId) existing.senderId = it.senderId
        existing.syncedAt = now
      } else {
        unreadMap.set(it.conversationId, {
          conversationId: it.conversationId,
          name: it.name || '未知用户',
          avatar: it.avatar || '',
          last: it.last || '发来一条消息',
          count: c,
          time: now,
          pushedAt: 0,
          syncedAt: now,
          url: it.url || '',
          senderId: it.senderId || '',
        })
        // 此前不存在且非 pushMessage 加入 → 视为 sync 侧新产生的未读
        if (!prevKeys.has(it.conversationId)) addedViaSync = true
      }
    })

    // 移除网页端已读/归零的会话；但保留「刚由 pushMessage 加入、尚未来得及被 sync 覆盖」的会话
    for (const [cid, it] of unreadMap) {
      if (!authIds.has(cid)) {
        const grace = it.pushedAt && (now - it.pushedAt) < GRACE_MS
        if (!grace) unreadMap.delete(cid)
      }
    }

    send('nc-unread', { unread: [...unreadMap.values()], total: totalUnread() })
    if (onUnreadChange) onUnreadChange(totalUnread())

    const st = settingsStore.getMerged()
    const blocked = st.notifyMode === 'dnd' || st.notifyMode === 'blockChat'
    if (unreadMap.size > 0) {
      // 仅当 sync 自身带来新未读且处于可自动显示状态时弹窗；否则仅续期计时（保持当前可见性）。
      // 计时续期即「新消息来重新计算时长（继续延长）」。
      if (addedViaSync && !blocked && !hiddenByUser) showWindow()
      else if (!hiddenByUser) resetIdle()
    } else if (!hasStickyAlert() && win && win.isVisible() && !hiddenByUser) {
      win.hide()
    }
  }

  function pushSysAlert(alert) {
    if (alert.type === 'offline') {
      const ex = sysAlerts.find(a => a.type === 'offline')
      if (ex) { ex.time = Date.now(); send('nc-sysalert', ex); showWindow(); return }
    }
    sysAlerts.push(alert)
    send('nc-sysalert', alert)
    showWindow()
    if (alert.ringtonePath) send('nc-play', { path: alert.ringtonePath })
  }

  function dismissSysAlert(id) {
    const idx = sysAlerts.findIndex(a => a.id === id)
    if (idx >= 0) sysAlerts.splice(idx, 1)
    send('nc-sysalert-dismiss', { id })
    // 常驻通知消失后重新评估窗口可见性：
    // 仍有其它常驻通知 -> 保持显示；否则若还有未读会话则恢复常规自动隐藏计时；
    // 若既无未读也无常驻通知 -> 隐藏窗口（标记为已关闭，避免 sync 刷新又弹出）。
    if (!hasStickyAlert()) {
      if (unreadMap.size > 0) {
        resetIdle()
      } else if (win && win.isVisible()) {
        hiddenByUser = true
        win.hide()
      }
    }
  }

  function syncContacts(list) {
    settingsStore.saveContacts(list)
  }

  function notifySettingsChanged() {
    send('nc-settings-changed', { settings: settingsStore.getMerged() })
  }

  // ── 渲染进程 → 主进程 IPC ──
  ipcMain.on('nc-open-conversation', (e, d) => {
    const data = d || {}
    const convId = data.conversationId || ''
    // 网页端当前通过 WebSocket 连着 → 走「聚焦已有 tab」通道，避免重复开新 tab；
    // 网页未连 → 回退为浏览器打开 URL（兜底，行为和改造前一致）。
    if (isWebConnected && isWebConnected() && (convId || data.url)) {
      broadcast({
        type: 'FOCUS_CONVERSATION',
        conversationId: convId,
        url: data.url || '',
      })
    } else if (data.url) {
      openExternal(data.url)
    } else if (convId) {
      openExternal(convId)
    }
    markRead(convId ? convId : 'all')
  })
  ipcMain.on('nc-mark-read', (e, id) => markRead(id))
  ipcMain.on('nc-dismiss-sysalert', (e, id) => dismissSysAlert(id))
  ipcMain.on('nc-close', () => {
    // 存在常驻系统通知（离线/被踢）时，✕ 不收起窗口，避免误关常驻提醒
    if (hasStickyAlert()) return
    hiddenByUser = true
    if (win && !win.isDestroyed()) win.hide()
  })
  ipcMain.on('nc-resize', (e, h) => {
    if (win && !win.isDestroyed()) {
      const newH = Math.max(160, Math.min(560, h || 520))
      const rect = getWindowRect(W, newH)
      win.setBounds({ x: rect.x, y: rect.y, width: W, height: newH })
    }
  })
  ipcMain.on('nc-reconnect', () => {
    if (broadcast) broadcast({ type: 'RECONNECT_REQUEST' })
  })

  return {
    preCreate, pushMessage, markRead, pushSysAlert, dismissSysAlert,
    syncUnread, syncContacts, notifySettingsChanged, showWindow,
    getSysAlerts: () => sysAlerts.slice(),
  }
}

module.exports = { createNotificationCenter }
