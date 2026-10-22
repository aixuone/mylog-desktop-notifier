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
  // 弹窗展示期（一次「打卡」会话）：每次有新未读把窗口叫出来时开启，用户关闭/全部已读后结束。
  // 展示期内的**所有**新未读都留在同一个弹窗里累加 —— 不再「一条一弹、后一条把前一条顶掉」。
  const shownConvs = new Set()
  let burstStart = 0            // 展示期起始时刻（Date.now()）
  let lastHeight = 0            // 上次渲染层回传的真实内容高度：show 前用它占位，避免「最大高度→内容高度」的忽长忽短闪动
  let focusConvId = null        // 最近一条触发弹窗的会话（用于"最新会话排最前"的稳定排序，不再只显示这一条）
  let activeConvId = null       // 网页端当前正在查看的会话 id（由 ACTIVE_CONVERSATION 上报）
  let lastDismissAt = 0         // 用户最近一次「收起通知窗」/「全部已读」的时刻：用于过滤展示列表
  const BURST_IDLE_MS = 60000   // 展示期空闲阈值：窗口正常自动隐藏后 60s 内再来新未读，仍算同一次"接连多条"
  const sysAlerts = []          // { id, type, sticky, data, ringtonePath }
  const approvals = []          // { id, title, applicant, time, status, url }（网页 SYNC_APPROVALS 下发，桌面只读展示）
  let idleTimer = null
  let hiddenByUser = false      // 用户主动关闭(✕/全部已读/知道了)后，sync 刷新不再自动弹出
  let pendingShow = false       // 等待渲染层回传真实高度后再 show（避免先大后缩的顶部下移闪烁）
  let showTimer = null
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
      focusId: focusConvId,
      sysAlerts: sysAlerts.slice(),
    })
  }

  // 展示期（burst）是否仍在进行：一个窗内「接连多条」共享同一次展示、同一段计时
  function burstActive() {
    if (!burstStart) return false
    if (win && !win.isDestroyed() && win.isVisible() && !hiddenByUser) return true
    return (Date.now() - burstStart) < BURST_IDLE_MS
  }

  function burstEnd() {
    burstStart = 0
    focusConvId = null
    shownConvs.clear()
  }

  // 关闭/收起通知窗（✕、全部已读、自动隐藏都会走这里）：
  // 记下 lastDismissAt 结束展示期，并**主动推送一次空列表** —— 渲染层随即重算高度并回传 nc-resize，
  // 让窗口在不可见状态下收缩到最小高度。否则保留着大高度的隐藏窗口，下一条消息到达时会先闪一下大窗口。
  function dismissWindow(byUser) {
    hiddenByUser = !!byUser
    lastDismissAt = Date.now()
    burstEnd()
    if (win && !win.isDestroyed()) win.hide()
    sendUnread()
  }

  // 推送未读列表到渲染层。通知窗只显示「本次展示期」的未读（时间 >= max(burstStart, lastDismissAt)），
  // 这样：① 同一批进来的多条会一起累加展示；② 用户关掉之后，早先那批不再「复活」。
  function sendUnread() {
    const since = Math.max(burstStart || 0, lastDismissAt || 0)
    const list = []
    for (const it of unreadMap.values()) {
      if (!since || (it.time || 0) >= since) list.push(it)
    }
    send('nc-unread', { unread: list, total: totalUnread(), focusId: focusConvId })
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
    // 先拿旧值：展示期只由「该会话此前没有未读」的新未读触发，
    // 同一会话的连续多条 -> 计数加一 + 摘要覆盖 + 高度微调，不重建窗口、不重播入场动画。
    const rid = payload.conversationId || payload.senderId || 'unknown'
    const prevCount = (unreadMap.get(rid) || {}).count || 0
    const convId = rid
    // 网页端当前正在查看该会话时，抑制桌面通知弹窗与未读计数：
    // 用户正在看，无需再弹窗/响铃/闪烁（对应「正在跟张三聊天时不再弹通知」）。
    if (activeConvId && activeConvId === convId) {
      console.log('[NC] Suppress toast for active conversation:', convId)
      return
    }
    // 会话已设置"消息免打扰"：不弹窗、不响铃（对应需求：免打扰会话不通知）。
    // 未读计数仍同步到通知中心列表（用户可手动打开查看），仅抑制主动打扰。
    const convMuted = !!(payload && payload.muted)
    // 网页端下发的权威未读数（IM SDK 真实值）。若提供则以其为准，避免桌面端自行累加导致大于网页真实未读。
    // ⚠️ 权威值不可信时（websocket 断连期间网页已重置、或 0）回退到自增：0 的权威值会让卡片直接消失。
    const authRaw = payload && payload.unreadCount
    const authoritative = (typeof authRaw === 'number' && authRaw > 0)
    const existing = unreadMap.get(convId)
    if (existing) {
      existing.count = authoritative ? authRaw : Math.max(existing.count, 0) + 1
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
        count: authoritative ? authRaw : 1,
        time: Date.now(),
        pushedAt: Date.now(),
        url: payload.url || '',
        senderId: payload.senderId || '',
      })
    }

    const st = settingsStore.getMerged()
    const blocked = st.notifyMode === 'dnd' || st.notifyMode === 'blockChat'
    // 展示期在「有新未读要弹」时才开启；期间的每一条都算同一个展示期（同一段自动隐藏计时）
    const inBurst = burstActive()
    // 「同一会话的后续未读」不重复叫窗：只加计数/换摘要、并把当前窗口的计时往后延
    const isNewConv = prevCount <= 0

    // 置顶会话：展示期内始终跟随最近到达的会话；展示期外只认真正的新未读
    if (!blocked && !convMuted && (inBurst || isNewConv)) focusConvId = convId

    // 渲染层（通知中心弹窗内列表）始终同步；但托盘红点/闪烁只以网页端权威未读为准，
    // 不由 pushMessage 自行累加驱动——否则「开着聊天框收消息」时，网页端已判读、不再下发
    // 归零信号，而桌面端仍按收到通知事件 +1，导致托盘误闪且无未读却持续闪烁。
    // 托盘未读由 UPDATE_UNREAD_COUNT / SYNC_UNREAD（权威）与 markRead（用户已读）驱动。
    sendUnread()

    if (blocked || convMuted) {
      if (convMuted) console.log('[NC] Suppress toast for muted conversation:', convId)
      return
    }

    // ① 展示期内：窗口保持并累加，只把自动隐藏计时往后延（不重建窗口、不重播入场动画）
    if (inBurst) {
      if (!win || win.isDestroyed() || !win.isVisible()) showWindow()
      else resetIdle()
      // 响铃：同一会话的一串连发只响一次，不同会话各响一次（避免刷屏）
      if (!shownConvs.has(convId)) {
        shownConvs.add(convId)
        const rp = ringtoneResolver.resolve('message', payload.senderId)
        if (rp) send('nc-play', { path: rp })
      }
      console.log('[NC] Burst append:', convId, 'count=', totalUnread())
      return
    }

    // ③ 同一次展示期内已在列表里的老会话（其它会话的新消息）：
    //    只静默更新摘要/计数与计时，不再重复弹窗，避免"别人的旧未读"被反复顶到最前
    if (!isNewConv) {
      console.log('[NC] Silent update for already-listed conversation:', convId)
      resetIdle()
      return
    }

    // ④ 新的一次展示：清空旧批内容，弹窗 + 响铃（showWindow 内会开启展示期）
    shownConvs.clear()
    shownConvs.add(convId)
    const rp = ringtoneResolver.resolve('message', payload.senderId)
    showWindow()
    send('nc-play', { path: rp })
  }

  function showWindow() {
    hiddenByUser = false
    // 每次真正「把窗叫出来」都开启/续期展示期：之后接连到达的未读并入同一窗口并延长计时
    burstStart = Date.now()
    if (!win || win.isDestroyed()) preCreate()
    // 仅「隐藏→可见」时做占位：用**上次真实内容高度**占位（无记录则用 160 最小高度），
    // 渲染层回传真实高度（nc-resize）后再一次性 show。**不再用最大高度 520 占位** ——
    // 隐藏窗口的 rAF 会被节流，真实高度回传有延迟，用 520 占位会先以长窗显示、再缩到内容高度，
    // 造成「忽长忽短」的闪动。已可见时保持当前尺寸，交由随后到达的 nc-resize 按新内容高度微调。
    if (!win.isVisible()) {
      const h = lastHeight > 0 ? lastHeight : 160
      const rect = getWindowRect(W, h)
      win.setBounds({ x: rect.x, y: rect.y, width: W, height: h })
      // 推迟 show 到真实高度回传后，并触发入场动画（从下往上滑入）
      pendingShow = true
      // 兜底：极端情况（nc-resize 未到达）下 250ms 直接 show 当前尺寸，保证可用
      if (showTimer) clearTimeout(showTimer)
      showTimer = setTimeout(() => {
        if (pendingShow && win && !win.isDestroyed() && !win.isVisible()) {
          pendingShow = false
          win.show()
          try { win.webContents.send('nc-show') } catch (e) {}
        }
      }, 250)
    }
    resetIdle()
  }

  function resetIdle() {
    const st = settingsStore.getMerged()
    const dur = (st.messageNotify && st.messageNotify.duration) || 5
    if (idleTimer) clearTimeout(idleTimer); idleTimer = null
    // 存在常驻系统通知(被踢/离线)时，窗口持续显示，不自动隐藏；
    // 用户主动关闭后也不挂自动隐藏（避免 sync 刷新又把窗口弹出来）。
    // 需用户点击或重连上线(NET_ONLINE)才消失。
    if (hasStickyAlert() || hiddenByUser) return
    idleTimer = setTimeout(() => {
      // 到点先推送空列表让渲染层收缩高度（窗口还可见时做，避免隐藏态 rAF 节流），再 hide
      lastDismissAt = Date.now()
      sendUnread()
      if (win && !win.isDestroyed()) win.hide()
      idleTimer = null
    }, Math.max(3, dur) * 1000)
  }

  function markRead(id) {
    if (id === 'all' || id == null) {
      unreadMap.clear()
      burstEnd()          // 全部已读：结束展示期、解除所有"已展示"标记
    } else {
      unreadMap.delete(id)
      shownConvs.delete(id)   // 已读：解除该会话"已展示"标记，后续新未读可再次响铃
      if (focusConvId === id) focusConvId = null
    }
    sendUnread()
    if (onUnreadChange) onUnreadChange(totalUnread())
    // 无未读且无常驻系统通知时：视为用户已处理，隐藏窗口并标记 hiddenByUser，
    // 后续 sync 刷新不再自动弹出，直到新消息到达(pushMessage 会重置该标记)。
    if (unreadMap.size === 0 && !hasStickyAlert()) {
      if (win && win.isVisible()) dismissWindow(true)
      else { hiddenByUser = true; lastDismissAt = Date.now(); burstEnd() }
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
    let addedNonMuted = false   // sync 自身新增的、且非免打扰的未读 → 才允许弹窗
    ;(items || []).forEach((it) => {
      if (!it || !it.conversationId) return
      const c = (typeof it.count === 'number' && it.count > 0) ? it.count : 0
      if (c <= 0) return
      authIds.add(it.conversationId)
      const muted = !!(it.muted)
      const existing = unreadMap.get(it.conversationId)
      if (existing) {
        existing.count = c
        if (it.name) existing.name = it.name
        if (it.avatar) existing.avatar = it.avatar
        if (it.last) existing.last = it.last
        if (it.url) existing.url = it.url
        if (it.senderId) existing.senderId = it.senderId
        existing.muted = muted
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
          muted,
        })
        // 此前不存在且非 pushMessage 加入 → 视为 sync 侧新产生的未读；
        // 仅当该会话非"消息免打扰"时才计入"可弹窗"条件。
        if (!prevKeys.has(it.conversationId) && !muted) {
          addedNonMuted = true
          shownConvs.add(it.conversationId)
          focusConvId = it.conversationId     // 弹窗聚焦到本次新增的会话
        }
      }
    })

    // 移除网页端已读/归零的会话；但保留「刚由 pushMessage 加入、尚未来得及被 sync 覆盖」的会话
    for (const [cid, it] of unreadMap) {
      if (!authIds.has(cid)) {
        const grace = it.pushedAt && (now - it.pushedAt) < GRACE_MS
        if (!grace) {
          unreadMap.delete(cid)
          shownConvs.delete(cid)   // 会话已归零：解除"已展示"标记，后续新未读可再次提示
          if (focusConvId === cid) focusConvId = null
        }
      }
    }

    sendUnread()
    if (onUnreadChange) onUnreadChange(totalUnread())

    const st = settingsStore.getMerged()
    const blocked = st.notifyMode === 'dnd' || st.notifyMode === 'blockChat'
    if (unreadMap.size > 0) {
      // sync 自身带来新的、非免打扰的未读：
      //   展示期内 → 并入当前窗口并延长计时（不断言、不重建）；
      //   否则 → 开启新展示期并弹窗。
      if (addedNonMuted && !blocked && !hiddenByUser) {
        if (burstActive()) {
          if (!win || win.isDestroyed() || !win.isVisible()) showWindow()
          else resetIdle()
        } else {
          burstStart = Date.now()
          showWindow()
        }
      } else if (!hiddenByUser) resetIdle()
    } else if (!hasStickyAlert() && win && win.isVisible() && !hiddenByUser) {
      dismissWindow(false)
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
        dismissWindow(true)
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

  // ── 诊断：模拟离线/被踢常驻通知（供手工确认，保持可见，不自动消除）──
  // 与 diagSysAlertTest（自校验、跑完即清理）区分：本方法只推送、不 dismiss，
  // 让用户在通知中心真实看到常驻卡片并确认「✕ 不收起」，验证完再 manual 清除。
  function diagSysAlertSimulate() {
    pushSysAlert({ id: '__diag_offline__', type: 'offline', sticky: true, data: {} })
    pushSysAlert({ id: '__diag_kick__', type: 'kick', sticky: true, data: {} })
    return {
      pushed: sysAlerts.slice().map((a) => a.type),
      sticky: hasStickyAlert(),
      visible: !!(win && win.isVisible()),
    }
  }

  // 清除诊断模拟的常驻通知（手工测试「清除模拟」按钮）
  function diagSysAlertClear() {
    dismissSysAlert('__diag_offline__')
    dismissSysAlert('__diag_kick__')
    return { remaining: sysAlerts.slice().map((a) => a.type) }
  }

  // 通知点击聚焦核心逻辑：按连接来源分流。
  // 应用窗口连接 → 置前 mainPageWindow + 定向发 FOCUS_CONVERSATION（跳转到对应会话）
  // 外部浏览器连接 / 无连接 → 只标记已读，不打开任何窗口、不做任何操作
  // 通过 _sendToAppClient / _focusMainWindow 引用调用，便于 diagFocusTest 用 spy 验证分支而不真发/真开窗口。
  function focusConversation(data) {
    const d = data || {}
    const convId = d.conversationId || ''
    console.log('[NC] focusConversation convId=', JSON.stringify(convId), 'url=', JSON.stringify(d.url || ''), 'hasApp=', _hasAppClient.fn())
    // 有应用窗口连接：置前窗口（把 unreadMap 里的原始会话 id 直接交给主进程，避免从 URL 反解）+ 定向发 FOCUS_CONVERSATION
    if (_hasAppClient.fn() && (convId || d.url)) {
      _focusMainWindow.fn(d.url || '', convId)
      _sendToAppClient.fn({ type: 'FOCUS_CONVERSATION', conversationId: convId, url: d.url || '' })
    }
    // ⚠️ 无论有没有应用窗口都标记已读：用户点了这条提醒，就等于处理了这条未读。
    //   与网页端 sendActiveConversation(cid)（切会话时上报）互补——网页端不依赖 cookie、
    //   也不保证所有切换路径都会上报，桌面端这一侧必须以「点击」为最可靠的已读信号。
    //   代价：若网页端跳转失败（会话不存在），该条未读不再在弹窗里出现，但仍会由网页端
    //   下一次 SYNC_UNREAD 以真实未读数重新带回，不会丢消息。
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
    dismissWindow(true)
  })
  ipcMain.on('nc-resize', (e, h) => {
    if (win && !win.isDestroyed()) {
      const newH = Math.max(160, Math.min(560, h || 520))
      lastHeight = newH   // 记录真实内容高度，供下次 show 前占位（消除长→短闪动）
      const rect = getWindowRect(W, newH)
      win.setBounds({ x: rect.x, y: rect.y, width: W, height: newH })
      // 若正处于「等待真实高度后再显示」状态：尺寸已定，立即 show，
      // 使窗口以最终高度一次性出现，消除先大后缩的顶部下移闪烁。
      if (pendingShow) {
        pendingShow = false
        if (showTimer) { clearTimeout(showTimer); showTimer = null }
        if (!win.isVisible()) {
          win.show()
          try { win.webContents.send('nc-show') } catch (_) {}
        }
      }
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
    diagFocusTest, diagSysAlertTest, diagSysAlertSimulate, diagSysAlertClear,
  }
}

module.exports = { createNotificationCenter }
