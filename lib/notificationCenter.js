// lib/notificationCenter.js
// ─────────────────────────────────────────────────────────────────────────────
// 通知中心主进程控制器（v2 架构级重做）
//
// 设计文档：docs/notification-center-prd.md
//
// 核心不变量（Invariant）
//   I1. 窗口「出现」的唯一入口是 pushMessage（真实新消息）与 pushSysAlert（系统通知）。
//       SYNC_UNREAD 只做内容校正，**无权开关窗口** —— 这是「闪动」的架构级根治点。
//   I2. 窗口一旦可见（phase === 'shown'），绝不 hide()，只 setBounds()；直到超时/用户操作。
//   I3. 展示栈（stack）在新批次内只增不减（除已读/归零）；同会话再来消息只更新已有行。
//   I4. 窗口高度以渲染进程实测为准（nc-resize），主进程不猜、不占位。
//
// 状态机
//   idle ──pushMessage──▶ arming(150ms 首屏合并) ──nc-measure 回传──▶ shown
//     ▲                                                                 │
//     └──────────── 超时 / ✕ / 点完最后一条 / 全部已读 ─────────────────┘
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path')
const fs = require('fs')
const { ipcMain, screen } = require('electron')

const W = 360
const MIN_H = 132
const MAX_H = 520
const ARM_MS = 150          // 首屏合并窗口：这段时间内到达的会话一次成型
const MEASURE_FALLBACK_MS = 200  // 等渲染层回传真实高度的兜底

function createNotificationCenter(deps) {
  const {
    BrowserWindow, webPreferences, getWindowRect, settingsStore, ringtoneResolver,
    onUnreadChange, openExternal, broadcast, isWebConnected,
    sendToAppClient, hasAppClient, focusMainWindow,
  } = deps

  const _broadcast = { fn: broadcast }
  const _openExternal = { fn: openExternal }
  const _sendToAppClient = { fn: sendToAppClient || function () {} }
  const _hasAppClient = { fn: hasAppClient || function () { return false } }
  const _focusMainWindow = { fn: focusMainWindow || function () {} }

  let win = null

  // ── 数据 ──
  const unreadMap = new Map()   // conversationId -> item（全量权威未读：含免打扰、含未进栈的）
  const stack = []              // 展示栈，索引 0 = 列表最上面（最新入栈）
  const ringed = new Set()      // 本栈内已响过铃的会话（同会话只响一次，S1.2）
  let syncBaselineDone = false  // 首次同步只建基线，不弹（S5.5）

  // ── 生命周期 ──
  let phase = 'idle'            // 'idle' | 'arming' | 'shown'
  let armTimer = null
  let hideTimer = null
  let measureTimer = null
  let pendingShow = false
  let lastHeight = 0            // 渲染层回传的真实高度（唯一可信）
  let appliedHeight = 0         // 上次 setBounds 的高度（避免重复 setBounds 抖动）
  let activeConvId = null       // 网页端当前正在查看的会话
  let lastFocusId = null        // 最近一条触发提醒的会话（仅供高亮）
  let allowEmptyShow = false    // 仅 showWindow()（诊断/手动打开面板）允许显示空态窗口
  const GRACE_MS = 2500         // pushMessage 刚加入的会话在此时窗内不被 sync 误删

  const sysAlerts = []          // { id, type, sticky, data, ringtonePath }
  const approvals = []

  // ───────────────────────────────────────────────────────────────────────────
  // 窗口
  // ───────────────────────────────────────────────────────────────────────────
  function preCreate() {
    const rect = getWindowRect(W, MIN_H)
    win = new BrowserWindow({
      width: W, height: MIN_H, x: rect.x, y: rect.y,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#F5F6F8',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      hasShadow: true,
      webPreferences,
    })
    win.loadFile(path.join(__dirname, '..', 'src', 'notification-center.html'))
    // 页面加载/崩溃必须留痕：渲染层挂了的表现就是「窗口在、但什么都没有」
    win.webContents.once('did-finish-load', () => {
      console.log('[NC] notification-center.html loaded')
      pushState()
    })
    win.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.log('[NC] did-fail-load', code, desc, url)
    })
    win.webContents.on('render-process-gone', (e, details) => {
      console.log('[NC] render-process-gone', JSON.stringify(details || {}))
    })
    win.on('closed', () => { console.log('[NC] window closed'); win = null; phase = 'idle' })
  }

  function send(channel, data) {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, data) } catch (e) {}
    }
  }

  function isVisible() {
    return !!(win && !win.isDestroyed() && win.isVisible())
  }

  function clampH(h) {
    const v = Math.round(Number(h) || 0)
    return Math.max(MIN_H, Math.min(MAX_H, v))
  }

  // 应用高度：底边锚定（getWindowRect 已按「底边 20px 边距」算 y），高度变大时向上生长（S3.2）
  function applyHeight(h) {
    if (!win || win.isDestroyed()) return
    const nh = clampH(h)
    lastHeight = nh
    if (nh === appliedHeight) return
    console.log('[NC] height', appliedHeight, '->', nh, '(raw', h + ')')
    appliedHeight = nh
    const rect = getWindowRect(W, nh)
    win.setBounds({ x: rect.x, y: rect.y, width: W, height: nh })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 状态推送（单一快照，渲染层只负责画）
  // ───────────────────────────────────────────────────────────────────────────
  function stackItems() {
    const out = []
    for (let i = 0; i < stack.length; i++) {
      const it = unreadMap.get(stack[i])
      if (it) out.push(it)
    }
    return out
  }

  function pushState() {
    send('nc-state', {
      settings: settingsStore.getMerged(),
      unread: stackItems(),
      sysAlerts: sysAlerts.slice(),
      focusId: lastFocusId,
      canClose: !hasStickyAlert(),
      phase,
    })
  }

  function hasStickyAlert() {
    for (let i = 0; i < sysAlerts.length; i++) if (sysAlerts[i].sticky) return true
    return false
  }

  function totalUnread() {
    let t = 0
    for (const it of unreadMap.values()) t += (it.count || 0)
    return t
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 展示：idle → arming → shown
  // ───────────────────────────────────────────────────────────────────────────
  function present(immediate) {
    console.log('[NC] present | phase=', phase, '| visible=', isVisible(), '| stack=', stack.length, '| immediate=', !!immediate)
    if (isVisible()) { allowEmptyShow = false; pushState(); resetHideTimer(); return }
    if (phase === 'arming') { allowEmptyShow = false; pushState(); return }   // 合并窗口内：只更新内容，不重置计时器
    phase = 'arming'
    pushState()
    if (immediate) { doShow(); return }
    if (armTimer) clearTimeout(armTimer)
    armTimer = setTimeout(() => { armTimer = null; doShow() }, ARM_MS)
  }

  function doShow() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null }
    console.log('[NC] doShow | stack=', stack.length, '| sys=', sysAlerts.length, '| lastH=', lastHeight)
    if (!stack.length && !sysAlerts.length && !allowEmptyShow) { phase = 'idle'; console.log('[NC] doShow aborted (empty)'); return }
    allowEmptyShow = false
    if (!win || win.isDestroyed()) preCreate()
    // 先用已知高度定尺寸（避免默认尺寸先闪），再向渲染层要一次真实高度，
    // 收到后立刻 show —— 保证「以最终高度一次性出现」（S3.1）。
    applyHeight(lastHeight || MIN_H)
    pendingShow = true
    send('nc-measure')
    if (measureTimer) clearTimeout(measureTimer)
    measureTimer = setTimeout(() => {
      measureTimer = null
      if (pendingShow) actuallyShow()
    }, MEASURE_FALLBACK_MS)
  }

  function actuallyShow() {
    if (!pendingShow) { console.log('[NC] actuallyShow skipped (pendingShow=false)'); return }
    pendingShow = false
    if (measureTimer) { clearTimeout(measureTimer); measureTimer = null }
    if (!win || win.isDestroyed()) { console.log('[NC] actuallyShow aborted (no window)'); return }
    phase = 'shown'
    console.log('[NC] actuallyShow | h=', appliedHeight, '| visibleBefore=', win.isVisible())
    if (!win.isVisible()) {
      // 展示前置顶：被其他窗口盖住后仍能弹出（S5.1）
      try { win.setAlwaysOnTop(true, 'screen-saver') } catch (e) { try { win.setAlwaysOnTop(true) } catch (_) {} }
      win.showInactive()             // 不抢焦点
      if (!win.isVisible()) win.show()   // 极端情况兜底
      try { win.webContents.send('nc-show') } catch (e) {}
    }
    try { win.moveTop() } catch (e) {}
    resetHideTimer()
  }

  function clearTimers() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (measureTimer) { clearTimeout(measureTimer); measureTimer = null }
  }

  // 关闭栈：唯一的「窗口消失」出口
  // forceHide=true（用户按 ✕）时即使有常驻系统通知也真的把窗口收起来；
  // 常驻提醒本身仍留在 sysAlerts 里，下次重新推送/展示时还会出现。
  function closeStack(reason, forceHide) {
    clearTimers()
    pendingShow = false
    stack.length = 0
    ringed.clear()
    lastFocusId = null
    // 存在常驻系统通知时，消息栈清空但窗口要留着（S4.1/S4.3）
    if (!forceHide && hasStickyAlert()) {
      phase = isVisible() ? 'shown' : 'idle'
      pushState()
      console.log('[NC] Stack cleared (sticky alert kept):', reason)
      return
    }
    phase = 'idle'
    if (isVisible()) win.hide()
    pushState()
    console.log('[NC] Stack closed:', reason)
  }

  function resetHideTimer() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (hasStickyAlert()) return              // 常驻通知：不自动隐藏（S4.1/S4.2）
    const st = settingsStore.getMerged()
    const dur = (st.messageNotify && st.messageNotify.duration) || 5
    // 展示时长随行数递增：设定值是一行的「扫读时间」，多行必须给足时间，
    // 否则 6 个会话堆在一起 5 秒消失，用户根本看不完是谁（D11）。
    // 上限 12s：提醒窗不该长期占屏。
    const rows = stack.length
    const secs = Math.min(12, Math.max(3, dur) + Math.max(0, rows - 1))
    console.log('[NC] hide timer', secs + 's | rows=', rows, '| duration setting=', dur)
    hideTimer = setTimeout(() => { hideTimer = null; closeStack('timeout') }, secs * 1000)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 栈操作
  // ───────────────────────────────────────────────────────────────────────────
  function addToStack(cid) {
    if (stack.indexOf(cid) >= 0) return false
    stack.unshift(cid)          // 新行插到最上面（S1.5）
    lastFocusId = cid
    return true
  }

  function removeFromStack(cid) {
    const i = stack.indexOf(cid)
    if (i >= 0) stack.splice(i, 1)
    ringed.delete(cid)
    if (lastFocusId === cid) lastFocusId = null
  }

  function isBlockedByMode() {
    const st = settingsStore.getMerged()
    return st.notifyMode === 'dnd' || st.notifyMode === 'blockChat'
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 消息到达
  // ───────────────────────────────────────────────────────────────────────────
  const dupSig = new Map()      // convId -> { sig, at }：双通道/重复推送去重

  function pushMessage(payload) {
    const p = payload || {}
    const cid = p.conversationId || p.senderId || 'unknown'
    const now = Date.now()

    // 用户正在看这个会话 → 不提醒（S2.4）。仍记入未读，由网页端已读后同步归零。
    if (activeConvId && activeConvId === cid) {
      console.log('[NC] Suppress toast (active conversation):', cid)
      return
    }

    const muted = !!p.muted
    const content = p.content || '发来一条消息'
    // 去重签名：同会话 + 同内容 + 同权威计数，300ms 内重复到达视为同一条消息（S2.6）
    const sig = cid + '\u0001' + content + '\u0001' + (p.unreadCount == null ? '' : p.unreadCount)
    const prevSig = dupSig.get(cid)
    const isDup = !!(prevSig && prevSig.sig === sig && (now - prevSig.at) < 300)
    dupSig.set(cid, { sig, at: now })

    const authRaw = p.unreadCount
    const authoritative = (typeof authRaw === 'number' && authRaw > 0)
    const existing = unreadMap.get(cid)
    const prevCount = existing ? (existing.count || 0) : 0

    let item = existing
    if (existing) {
      // 计数：有权威未读数就以它为准（网页端 SYNC 与 PUSH 同源，取权威值天然幂等，双通道不会翻倍）；
      // 没有权威值时才自增，并用 300ms 同签名去重防止同一条消息被推两次。
      existing.count = authoritative ? authRaw : (isDup ? prevCount : prevCount + 1)
      existing.last = content
      existing.time = now
      existing.pushedAt = now
      if (p.senderName) existing.name = p.senderName
      if (p.senderAvatar) existing.avatar = p.senderAvatar
      if (p.url) existing.url = p.url
      if (p.senderId) existing.senderId = p.senderId
      existing.muted = muted
    } else {
      item = {
        conversationId: cid,
        name: p.senderName || '未知用户',
        avatar: p.senderAvatar || '',
        last: content,
        count: authoritative ? authRaw : 1,
        time: now,
        pushedAt: now,
        url: p.url || '',
        senderId: p.senderId || '',
        muted,
      }
      unreadMap.set(cid, item)
    }

    if (onUnreadChange) onUnreadChange(totalUnread())

    // 免打扰 / 全局免打扰 → 不进栈、不响铃（S2.1/S2.2/S2.3）
    if (muted || isBlockedByMode()) {
      console.log('[NC] Suppress toast (muted/mode):', cid, '| muted=', muted, '| mode=', settingsStore.getMerged().notifyMode)
      if (phase !== 'idle') pushState()
      return
    }

    addToStack(cid)

    // 响铃：同一会话在本栈内只响一次，不同会话各响一次（S1.2/S1.5）
    const willRing = !ringed.has(cid)
    if (willRing) {
      ringed.add(cid)
      const rp = ringtoneResolver.resolve('message', p.senderId)
      if (rp) send('nc-play', { path: rp })
    }

    console.log('[NC] Message:', cid, '| stack=', stack.length, '| count=', item.count, '| isDup=', isDup, '| ring=', willRing)

    // 展示：已可见 → 只刷新 + 续期；arming → 只刷新；idle → 开栈
    present(false)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 权威未读同步：只校正内容，不开栈（I1）
  // ───────────────────────────────────────────────────────────────────────────
  function syncUnread(items) {
    const now = Date.now()
    const authIds = new Set()
    const grew = []                    // 本次同步里「未读增长」的会话（兜底提醒用）
    // 基线：进程启动后的第一次同步只记录各会话未读数，绝不弹窗（S5.5）。
    // 注意空列表也算有效基线 —— 它说明「此刻确实没有未读」，之后的 1 才是真新消息。
    const isBaseline = !syncBaselineDone
    let stackAdded = false

    ;(items || []).forEach((it) => {
      if (!it || !it.conversationId) return
      const c = (typeof it.count === 'number' && it.count > 0) ? it.count : 0
      if (c <= 0) return
      authIds.add(it.conversationId)
      // 未读增长判定：以前一份 unreadMap 里的 count 作为基准，而不是单独的「上次同步值」。
      // 理由：markRead（点提醒/已读）、sync 清理这两条「归零」路径都会删掉 unreadMap 项，
      // 基准随之回到 0 —— 若维护独立的上次值，点过提醒的会话下次 count 从 1 重新计数时
      // 会被误判为「没增长」而彻底静音（实测复现：点一次提醒后该会话再也不弹）。
      const prevItem = unreadMap.get(it.conversationId)
      const prevC = prevItem ? (prevItem.count || 0) : 0
      if (!isBaseline && c > prevC) grew.push(it.conversationId)
      const muted = !!it.muted
      const ex = unreadMap.get(it.conversationId)
      if (ex) {
        ex.count = c
        if (it.name) ex.name = it.name
        if (it.avatar) ex.avatar = it.avatar
        if (it.last) ex.last = it.last
        if (it.url) ex.url = it.url
        if (it.senderId) ex.senderId = it.senderId
        ex.muted = muted
        ex.syncedAt = now
      } else {
        unreadMap.set(it.conversationId, {
          conversationId: it.conversationId,
          name: it.name || '未知用户',
          avatar: it.avatar || '',
          last: it.last || '发来一条消息',
          count: c,
          time: now,
          pushedAt: 0,           // 非 pushMessage 产生 → 允许被下次 sync 清理
          syncedAt: now,
          url: it.url || '',
          senderId: it.senderId || '',
          muted,
        })
        // 只在「窗口已经在展示/即将展示」时补行（防 WS 丢包导致漏行）；
        // arming 期（150ms 首屏合并）也算即将展示，此时补行才能一次成型（S1.4）。
        // 窗口未展示时**绝不**因为 sync 而开栈 —— 否则历史未读会被反复弹出来（S5.5）。
        if ((phase === 'shown' || phase === 'arming') && !muted) {
          if (addToStack(it.conversationId)) stackAdded = true
        }
      }
    })

    // 已读/归零：从聚合与栈中移除。刚被 pushMessage 加入的保留一小段时间，避免竞态误删。
    for (const [cid, it] of unreadMap) {
      if (authIds.has(cid)) continue
      if (it.pushedAt && (now - it.pushedAt) < GRACE_MS) continue
      unreadMap.delete(cid)
      removeFromStack(cid)
    }

    syncBaselineDone = true
    if (onUnreadChange) onUnreadChange(totalUnread())
    pushState()

    if (stackAdded) resetHideTimer()

    // ── 兜底：网页端只发了 SYNC、没发 SHOW_MESSAGE_NOTIFICATION 时补提醒 ──
    // 这不是假设：v6 SDK 下 layout.vue 曾用 deep watch 的 oldValue 做增量判断，
    // 而 deep watch 的新旧值同引用 → 比较恒 false → SHOW 一次都没发过，
    // 桌面端表现为「完全没有消息提示」。SYNC 的 unreadCount 增长是同一事实的另一路证据，
    // 这里用它兜底，桌面端就不再依赖网页端某一段逻辑是否正确。
    // 安全性：SHOW 已先到时该会话已在栈内（addToStack 返回 false）且已响过铃 → 不会重复。
    if (grew.length && !isBlockedByMode()) {
      for (let i = 0; i < grew.length; i++) {
        const cid = grew[i]
        const it = unreadMap.get(cid)
        if (!it || it.muted) continue
        if (activeConvId && activeConvId === cid) continue   // 用户正在看这个会话
        notifyFromSync(it)
      }
    }

    // 栈已空（都被读掉了）→ 收起（S2.8）
    if (!stack.length && !hasStickyAlert() && phase !== 'idle') closeStack('synced-empty')
  }

  // 由 SYNC 增长驱动的提醒：与 pushMessage 共用入栈/响铃/展示，但不改 unreadMap
  function notifyFromSync(it) {
    const cid = it.conversationId
    const added = addToStack(cid)
    const willRing = !ringed.has(cid)
    if (!added && !willRing) {
      console.log('[NC] Sync-fallback skip (already notified):', cid)
      return
    }
    if (willRing) {
      ringed.add(cid)
      const rp = ringtoneResolver.resolve('message', it.senderId)
      if (rp) send('nc-play', { path: rp })
    }
    console.log('[NC] Sync-fallback notify:', cid, '| added=', added, '| ring=', willRing, '| stack=', stack.length)
    present(false)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 已读
  // ───────────────────────────────────────────────────────────────────────────
  function markRead(id) {
    if (id === 'all' || id == null) {
      unreadMap.clear()
      closeStack('read-all')
    } else {
      unreadMap.delete(id)
      removeFromStack(id)
      if (!stack.length && !hasStickyAlert()) closeStack('read-one')
      else { pushState(); if (phase === 'shown') resetHideTimer() }
    }
    if (onUnreadChange) onUnreadChange(totalUnread())
  }

  // 网页端上报当前正在查看的会话
  function setActiveConversation(id) {
    activeConvId = id || null
    console.log('[NC] Active conversation:', activeConvId)
    // 只清「当前没有可见提醒」的会话的旧未读。
    // 否则一条刚弹出的提醒（仍在本次展示 stack 内）会被紧随其后的 ACTIVE_CONVERSATION
    // （网页路由切换 / 收到消息后自动聚焦该会话）当场 markRead 掉，表现为
    // 「闪一下就消失、根本看不清是谁发的」(D-race)。
    // 该会话若正在显示提醒，让它按设定时长停留；用户读完由点击提醒或网页 SYNC_UNREAD 去清。
    if (activeConvId && !stack.includes(activeConvId)) markRead(activeConvId)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 系统通知（允许开窗：粘性提醒必须被看到，属 I1 的显式例外）
  // ───────────────────────────────────────────────────────────────────────────
  function pushSysAlert(alert) {
    if (!alert || !alert.id) return
    if (alert.type === 'offline') {
      const ex = sysAlerts.find((a) => a.type === 'offline')
      if (ex) { ex.time = Date.now(); pushState(); present(false); return }   // S4.6
    }
    sysAlerts.push(alert)
    pushState()
    present(false)
    if (alert.ringtonePath) send('nc-play', { path: alert.ringtonePath })
  }

  function dismissSysAlert(id) {
    const idx = sysAlerts.findIndex((a) => a.id === id)
    if (idx >= 0) sysAlerts.splice(idx, 1)
    pushState()
    if (hasStickyAlert()) return
    if (stack.length) resetHideTimer()
    else if (phase !== 'idle') closeStack('sys-cleared')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 审批 / 联系人 / 设置
  // ───────────────────────────────────────────────────────────────────────────
  function syncApprovals(items) {
    approvals.length = 0
    ;(items || []).forEach((it) => {
      if (!it || !it.id) return
      approvals.push({
        id: String(it.id),
        title: String(it.title || '审批事项'),
        applicant: String(it.applicant || ''),
        time: it.time || Date.now(),
        status: String(it.status || 'pending'),
        url: String(it.url || ''),
      })
    })
    approvals.sort((a, b) => (b.time || 0) - (a.time || 0))
    return approvals.slice()
  }

  function syncContacts(list) { settingsStore.saveContacts(list) }

  // 设置变更：只推状态（不重开/重置计时，避免改设置把窗口时长莫名拉长）
  function notifySettingsChanged() { pushState() }

  // ───────────────────────────────────────────────────────────────────────────
  // 点击提醒
  // ───────────────────────────────────────────────────────────────────────────
  function focusConversation(data) {
    const d = data || {}
    const convId = d.conversationId || ''
    console.log('[NC] focusConversation cid=', JSON.stringify(convId), 'hasApp=', _hasAppClient.fn())
    if (_hasAppClient.fn() && (convId || d.url)) {
      _focusMainWindow.fn(d.url || '', convId)
      _sendToAppClient.fn({ type: 'FOCUS_CONVERSATION', conversationId: convId, url: d.url || '' })
    }
    // 点了就算已读：即使网页端跳转失败，也不会在弹窗里反复出现；
    // 网页端下一次 SYNC_UNREAD 会以真实未读数把它带回来（不丢消息）。
    // 注意：只有拿到明确的会话 id 才动数据 —— 旧写法 `convId || 'all'` 在 cid 为空时
    // 会把整个列表清空（误伤其它会话），以用户体验为重改成保守策略（D12）。
    if (convId) markRead(convId)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 诊断 API（保持与旧版签名一致）
  // ───────────────────────────────────────────────────────────────────────────
  function fileUrlToPath(u) {
    if (!u || u.indexOf('file://') !== 0) return u
    let p = u.replace('file://', '')
    if (p[0] === '/') p = p.slice(1)
    return decodeURIComponent(p)
  }

  function getWindowState() {
    if (!win || win.isDestroyed()) return { exists: false, visible: false, onScreen: false, bounds: null, phase }
    const b = win.getBounds()
    const visible = win.isVisible()
    const onScreen = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
             b.y < wa.y + wa.height && b.y + b.height > wa.y
    })
    return { exists: true, visible, onScreen, bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, phase }
  }

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

  function pushTest() {
    pushMessage({
      conversationId: '__diag__',
      senderId: '__diag__',
      senderName: '诊断测试',
      content: '这是一条测试通知，用于验证弹窗是否可见。',
      url: '',
    })
  }

  function hideWindow() {
    clearTimers()
    pendingShow = false
    if (isVisible()) win.hide()
    phase = 'idle'
  }

  function diagFocusTest(data) {
    const sent = [], opened = [], focused = [], appSent = []
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
      sent, opened, focused, appSent,
      action: appSent.length ? 'appFocus' : (focused.length ? 'appFocus' : (sent.length ? 'broadcast' : (opened.length ? 'external' : 'none'))),
    }
  }

  function diagSysAlertTest() {
    pushSysAlert({ id: '__diag_offline__', type: 'offline', sticky: true, data: {} })
    pushSysAlert({ id: '__diag_kick__', type: 'kick', sticky: true, data: {} })
    const pushed = sysAlerts.slice().map((a) => a.type)
    const stickyAfterPush = hasStickyAlert()
    const winVisibleWhileSticky = isVisible()
    const ncCloseSuppressed = hasStickyAlert()
    dismissSysAlert('__diag_offline__')
    const afterDismissOne = sysAlerts.slice().map((a) => a.type)
    dismissSysAlert('__diag_kick__')
    const afterDismissAll = sysAlerts.slice().map((a) => a.type)
    try { hideWindow() } catch (e) {}
    return { pushed, stickyAfterPush, winVisibleWhileSticky, ncCloseSuppressed, afterDismissOne, afterDismissAll }
  }

  function diagSysAlertSimulate() {
    pushSysAlert({ id: '__diag_offline__', type: 'offline', sticky: true, data: {} })
    pushSysAlert({ id: '__diag_kick__', type: 'kick', sticky: true, data: {} })
    return { pushed: sysAlerts.slice().map((a) => a.type), sticky: hasStickyAlert(), visible: isVisible() }
  }

  function diagSysAlertClear() {
    dismissSysAlert('__diag_offline__')
    dismissSysAlert('__diag_kick__')
    return { remaining: sysAlerts.slice().map((a) => a.type) }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // IPC（渲染进程 → 主进程）
  // ───────────────────────────────────────────────────────────────────────────
  ipcMain.on('nc-open-conversation', (e, d) => focusConversation(d))
  ipcMain.on('nc-mark-read', (e, id) => markRead(id))
  ipcMain.on('nc-dismiss-sysalert', (e, id) => dismissSysAlert(id))
  ipcMain.on('nc-close', (e, force) => {
    if (hasStickyAlert() && !force) return   // S4.3
    closeStack('user', !!force)
  })
  ipcMain.on('nc-resize', (e, h) => {
    applyHeight(h)
    if (pendingShow) actuallyShow()          // 高度已定，立刻以最终高度出现（S3.1）
  })
  ipcMain.on('nc-reconnect', () => {
    if (broadcast) broadcast({ type: 'RECONNECT_REQUEST' })
  })

  return {
    preCreate, pushMessage, markRead, pushSysAlert, dismissSysAlert,
    syncUnread, syncContacts, syncApprovals, notifySettingsChanged,
    showWindow: () => { allowEmptyShow = true; present(true) },
    setActiveConversation,
    getSysAlerts: () => sysAlerts.slice(),
    getUnread: () => [...unreadMap.values()],
    getApprovals: () => approvals.slice(),
    // 诊断
    getWindowState, previewRingtone, pushTest, hideWindow,
    diagFocusTest, diagSysAlertTest, diagSysAlertSimulate, diagSysAlertClear,
  }
}

module.exports = { createNotificationCenter, NC_W: W, NC_MIN_H: MIN_H, NC_MAX_H: MAX_H }
