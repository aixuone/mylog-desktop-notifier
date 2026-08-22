// lib/notificationCenter.js
// 通知中心主进程控制器：常驻预加载窗口 + 会话未读聚合(unreadMap) + 系统通知(sysAlerts)。
// 根除白框：窗口启动时创建并预加载，永不因消息重建，仅 show/hide。
// 会话未读走托盘红点；系统通知独立于会话，不累加红点。

const path = require('path')
const fs = require('fs')
const { ipcMain, screen } = require('electron')

function createNotificationCenter(deps) {
  const { BrowserWindow, webPreferences, getWindowRect, settingsStore, ringtoneResolver, onUnreadChange, openExternal, broadcast, isWebConnected, sendToAppClient, hasAppClient, focusMainWindow } = deps

  const W = 360
  const H = 520
  const _broadcast = { fn: broadcast }
  const _openExternal = { fn: openExternal }
  // 应用窗口定向能力：用于通知点击分流（应用窗口连接 → 置前 + FOCUS_CONVERSATION）
  const _sendToAppClient = { fn: sendToAppClient || function() {} }
  const _hasAppClient = { fn: hasAppClient || function() { return false } }
  const _focusMainWindow = { fn: focusMainWindow || function() {} }

  let win = null
  const unreadMap = new Map()   // conversationId -> item
  let activeConvId = null       // 网页端当前正在查看的会话 id（由 ACTIVE_CONVERSATION 上报）
  const sysAlerts = []          // { id, type, sticky, data, ringtonePath }
  const approvals = []          // { id, title, applicant, time, status, url }（网页 SYNC_APPROVALS 下发，桌面只读展示）
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

  // 网页端上报当前正在查看的会话（打开/切换/关闭会话时调用，conversationId 为 null 表示无具体会话）。
  // 用户打开或切到某会话即视为"正在看"——清掉该会话未读，托盘立即停止闪烁；
  // 同时 pushMessage 会据此抑制该会话的后续弹窗/响铃。与网页端"已读状态"判定解耦，更稳健。
  function setActiveConversation(id) {
    activeConvId = id || null
    console.log('[NC] Active conversation set to:', activeConvId)
    if (activeConvId) markRead(activeConvId)
  }

  function pushMessage(payload) {
    const convId = payload.conversationId || payload.senderId || 'unknown'
    // 网页端当前正在查看该会话时，抑制桌面通知弹窗与未读计数：
    // 用户正在看，无需再弹窗/响铃/闪烁（对应「正在跟张三聊天时不再弹通知」）。
    if (activeConvId && activeConvId === convId) {
      console.log('[NC] Suppress toast for active conversation:', convId)
      return
    }
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

    // 渲染层（通知中心弹窗内列表）始终同步；但托盘红点/闪烁只以网页端权威未读为准，
    // 不由 pushMessage 自行累加驱动——否则「开着聊天框收消息」时，网页端已判读、不再下发
    // 归零信号，而桌面端仍按收到通知事件 +1，导致托盘误闪且无未读却持续闪烁。
    // 托盘未读由 UPDATE_UNREAD_COUNT / SYNC_UNREAD（权威）与 markRead（用户已读）驱动。
    send('nc-unread', { unread: [...unreadMap.values()], total: totalUnread() })

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

  // 网页端下发的审批待办（SYNC_APPROVALS）：桌面端只读聚合，供工作台侧栏展示。
  // 整表替换（网页是权威源），仅保留合法条目，按 time 降序。
  function syncApprovals(items) {
    approvals.length = 0
    ;(items || []).forEach((it) => {
      if (!it || !it.id) return
      approvals.push({
        id: String(it.id),
        title: String(it.title || '审批事项'),
        applicant: String(it.applicant || ''),
        time: it.time || Date.now(),
        status: String(it.status || 'pending'), // pending | approved | rejected
        url: String(it.url || ''),
      })
    })
    approvals.sort((a, b) => (b.time || 0) - (a.time || 0))
    return approvals.slice()
  }

  function syncContacts(list) {
    settingsStore.saveContacts(list)
  }

  function notifySettingsChanged() {
    send('nc-settings-changed', { settings: settingsStore.getMerged() })
  }

  // ── 诊断用 API ──
  // 将 file:///C:/... 还原为本机路径，供 fs.existsSync 校验铃声文件是否存在
  function fileUrlToPath(u) {
    if (!u || u.indexOf('file://') !== 0) return u
    var p = u.replace('file://', '')
    if (p[0] === '/') p = p.slice(1)
    return decodeURIComponent(p)
  }

  // 返回通知窗当前状态：是否存在、是否可见、bounds 是否落在任一显示器 workArea 内
  function getWindowState() {
    if (!win || win.isDestroyed()) return { exists: false, visible: false, onScreen: false, bounds: null }
    const b = win.getBounds()
    const visible = win.isVisible()
    const onScreen = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
             b.y < wa.y + wa.height && b.y + b.height > wa.y
    })
    return { exists: true, visible, onScreen, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } }
  }

  // 解析并试播某类铃声；返回解析路径与文件存在性（供自动测试校验）
  // silent=true 时只解析不试播（诊断多场景批量校验时避免连续响声）
  function previewRingtone(callType, callerId, silent) {
    const rp = ringtoneResolver.resolve(callType, callerId)
    let exists = false
    if (rp) { try { exists = fs.existsSync(fileUrlToPath(rp)) } catch (e) { exists = false } }
    if (rp && !silent) send('nc-play', { path: rp })
    const st = settingsStore.getMerged()
    const muted = st.notifyMode === 'dnd' || !st.ringtoneEnabled || st.notifyMode === 'silent' ||
                  (callType === 'message' && st.notifyMode === 'blockChat')
    return { path: rp, exists, muted }
  }

  // 推送一条测试通知卡并展示窗口（手工"触发弹窗"用）
  function pushTest() {
    pushMessage({
      conversationId: '__diag__',
      senderId: '__diag__',
      senderName: '诊断测试',
      content: '这是一条测试通知，用于验证弹窗是否可见。',
      url: '',
    })
  }

  // 仅隐藏窗口，不设置 hiddenByUser（避免影响后续真实通知逻辑）
  function hideWindow() {
    if (win && !win.isDestroyed()) win.hide()
  }

  // ── 诊断：通知点击聚焦验证（spy 包 broadcast/openExternal/sendToAppClient/focusMainWindow，不真发/真开浏览器）──
  function diagFocusTest(data) {
    const sent = []
    const opened = []
    const focused = []
    const appSent = []
    const origB = _broadcast.fn, origO = _openExternal.fn, origF = _focusMainWindow.fn, origA = _sendToAppClient.fn
    _broadcast.fn = (m) => { sent.push(m) }
    _openExternal.fn = (u) => { opened.push(u) }
    _focusMainWindow.fn = () => { focused.push(true) }
    _sendToAppClient.fn = (m) => { appSent.push(m) }
    try { focusConversation(data || {}) } finally {
      _broadcast.fn = origB
      _openExternal.fn = origO
      _focusMainWindow.fn = origF
      _sendToAppClient.fn = origA
    }
    return {
      webConnected: !!(isWebConnected && isWebConnected()),
      appConnected: _hasAppClient.fn(),
      sent,        // 广播消息（旧路径，新逻辑下应为空）
      opened,      // openExternal 调用（新逻辑下应为空）
      focused,     // focusMainWindow 调用
      appSent,     // sendToAppClient 发送的消息
      action: appSent.length ? 'appFocus' : (focused.length ? 'appFocus' : (sent.length ? 'broadcast' : (opened.length ? 'external' : 'none'))),
    }
  }

  // ── 诊断：网页端离线/被踢常驻通知（sticky 不随 ✕ 收起）──
  function diagSysAlertTest() {
    pushSysAlert({ id: '__diag_offline__', type: 'offline', sticky: true, data: {} })
    pushSysAlert({ id: '__diag_kick__', type: 'kick', sticky: true, data: {} })
    const pushed = sysAlerts.slice().map((a) => a.type)
    const stickyAfterPush = hasStickyAlert()
    const winVisibleWhileSticky = !!(win && win.isVisible())
    // nc-close 行为：常驻时 hasStickyAlert() 为真 → 不收起（等价于"✕ 不关常驻提醒"）
    const ncCloseSuppressed = hasStickyAlert()
    dismissSysAlert('__diag_offline__')
    const afterDismissOne = sysAlerts.slice().map((a) => a.type)
    dismissSysAlert('__diag_kick__')
    const afterDismissAll = sysAlerts.slice().map((a) => a.type)
    try { hideWindow() } catch (e) {}   // 清理测试弹窗
    return {
      pushed,
      stickyAfterPush,
      winVisibleWhileSticky,
      ncCloseSuppressed,
      afterDismissOne,
      afterDismissAll,
    }
  }

  // 通知点击聚焦核心逻辑：按连接来源分流。
  // 应用窗口连接 → 置前 mainPageWindow + 定向发 FOCUS_CONVERSATION（跳转到对应会话）
  // 外部浏览器连接 / 无连接 → 只标记已读，不打开任何窗口、不做任何操作
  // 通过 _sendToAppClient / _focusMainWindow 引用调用，便于 diagFocusTest 用 spy 验证分支而不真发/真开窗口。
  function focusConversation(data) {
    const d = data || {}
    const convId = d.conversationId || ''
    console.log('[NC] focusConversation convId=', JSON.stringify(convId), 'url=', JSON.stringify(d.url || ''), 'hasApp=', _hasAppClient.fn())
    // 有应用窗口连接：置前窗口（带 url 跳转）+ 定向发 FOCUS_CONVERSATION
    if (_hasAppClient.fn() && (convId || d.url)) {
      _focusMainWindow.fn(d.url || '')
      _sendToAppClient.fn({ type: 'FOCUS_CONVERSATION', conversationId: convId, url: d.url || '' })
    }
    // 外部浏览器连接或无连接：只标记已读，不打开任何窗口
    markRead(convId ? convId : 'all')
  }

  // ── 渲染进程 → 主进程 IPC ──
  ipcMain.on('nc-open-conversation', (e, d) => focusConversation(d))
  ipcMain.on('nc-mark-read', (e, id) => markRead(id))
  ipcMain.on('nc-dismiss-sysalert', (e, id) => dismissSysAlert(id))
  ipcMain.on('nc-close', (e, force) => {
    // 存在常驻系统通知（离线/被踢）时，默认抑制收起以防误关；
    // force=true（✕ 强制关闭）时仍收起窗口，常驻提醒保留在其自身按钮上正规消除。
    if (hasStickyAlert() && !force) return
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
    syncUnread, syncContacts, syncApprovals, notifySettingsChanged, showWindow,
    setActiveConversation,
    getSysAlerts: () => sysAlerts.slice(),
    getUnread: () => [...unreadMap.values()],
    getApprovals: () => approvals.slice(),
    // ── 诊断用 ──
    getWindowState, previewRingtone, pushTest, hideWindow,
    diagFocusTest, diagSysAlertTest,
  }
}

module.exports = { createNotificationCenter }
