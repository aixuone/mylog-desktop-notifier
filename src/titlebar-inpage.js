// titlebar-inpage.js
// 自绘标题栏（注入主窗口页面内，与主窗口同属一个 Win32 窗口 → 视觉一体）。
// 由主进程在 did-finish-load 时 executeJavaScript 注入；样式由主进程 insertCSS 注入，
// 本文件只负责 DOM 结构与事件绑定（不写内联样式，规避远程页 CSP）。
;(function () {
  'use strict'
  // 已挂载则跳过（避免 SPA 路由切换 / 重复执行导致重复节点）
  if (window.__myTitlebar) return

  var api = window.electronAPI || {}

  // ─── SVG 图标（20×20，线条风格，与网页 #1677ff 主色统一）──
  var ICONS = {
    phone: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5h3l1.5 4.5-2 1.5a11 11 0 0 0 5 5l1.5-2 4.5 1.5v3a2 2 0 0 1-2 2A14.5 14.5 0 0 1 2.5 4.5a2 2 0 0 1 2-2z"/></svg>',
    video: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6h3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-3l-4 3V3l4 3z"/></svg>',
    chat: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 10a7 7 0 1 0-2.65 5.5L17 17v-3a7 7 0 0 0 0-4z"/></svg>',
    plan: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="14" rx="2"/><path d="M16 8H4M8 2v4M14 2v4M7 12h.01M11 12h.01M7 15h.01"/></svg>',
    note: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/><path d="M7 8h6M7 12h4"/><path d="M13 2v4"/></svg>',
    approval: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 10l2.5 2.5L14 8"/></svg>',
    search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="6"/><path d="M15 15l3 3"/></svg>',
    minimize: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 10h12"/></svg>',
    maximize: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="1.5"/></svg>',
    close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l10 10M15 5L5 15"/></svg>',
    chevron: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4"/></svg>',
  }

  function mountBar() {
    if (document.getElementById('my-titlebar-root')) return

    var bar = document.createElement('div')
    bar.id = 'my-titlebar-root'
    bar.className = 'my-titlebar'
    bar.innerHTML =
      '<div class="tb-drag-area"></div>' +
      '<div class="tb-left">' +
      '  <button class="tb-avatar-wrap" id="tb-avatar-wrap" title="设置" type="button">' +
      '    <div class="tb-avatar" id="tb-avatar">田</div>' +
      '    <img class="tb-avatar-img" id="tb-avatar-img" src="" alt="">' +
      '    <span class="tb-status-dot" id="tb-status-dot"></span>' +
      '    <span class="tb-chevron">' + ICONS.chevron + '</span>' +
      '  </button>' +
      '  <div class="tb-offline" id="tb-offline">' +
      '    <span class="tb-offline-dot"></span>' +
      '    <span class="tb-offline-text">离线 · 正在重连</span>' +
      '  </div>' +
      '</div>' +
      '<div class="tb-mid">' +
      '  <button class="tb-search" id="tb-search" type="button">' +
      '    <span class="tb-search-icon">' + ICONS.search + '</span>' +
      '    <span class="tb-search-text">搜索日志 / 会话 / 联系人</span>' +
      '    <kbd class="tb-k">Ctrl K</kbd>' +
      '  </button>' +
      '  <div class="tb-qacts" role="toolbar" aria-label="快捷操作">' +
      '    <button class="tb-qa" data-action="quick-action:call" title="发起通话" type="button">' + ICONS.phone + '</button>' +
      '    <button class="tb-qa" data-action="quick-action:meeting" title="发起会议" type="button">' + ICONS.video + '</button>' +
      '    <button class="tb-qa" data-action="quick-action:chat" title="发起聊天" type="button">' + ICONS.chat + '</button>' +
      '    <button class="tb-qa" data-action="quick-action:create-plan" title="创建计划" type="button">' + ICONS.plan + '</button>' +
      '    <button class="tb-qa" data-action="quick-action:note-log" title="创建日志" type="button">' + ICONS.note + '</button>' +
      '    <button class="tb-qa tb-qa-approval" data-action="quick-action:approval" title="审批" type="button">' + ICONS.approval + '<span class="tb-bd" id="tb-approval-bd">0</span></button>' +
      '  </div>' +
      '</div>' +
      '<div class="tb-winctrl" role="toolbar" aria-label="窗口控制">' +
      '  <button class="tb-wc" data-win="minimize" title="最小化" type="button">' + ICONS.minimize + '</button>' +
      '  <button class="tb-wc" data-win="maximize" title="最大化" type="button">' + ICONS.maximize + '</button>' +
      '  <button class="tb-wc tb-close" data-win="close" title="关闭到托盘" type="button">' + ICONS.close + '</button>' +
      '</div>' +
      '<div class="tb-dropdown" id="tb-dd-avatar">' +
      '  <div class="tb-dd-hd">设置</div>' +
      '  <button class="tb-dd-item" data-dd="settings" type="button"><span class="tb-dd-ic">通</span>通用设置</button>' +
      '  <button class="tb-dd-item" data-dd="ringtone" type="button"><span class="tb-dd-ic">铃</span>铃声设置</button>' +
      '  <button class="tb-dd-item" data-dd="contacts" type="button"><span class="tb-dd-ic">关</span>特别关注</button>' +
      '  <button class="tb-dd-item" data-dd="downloads" type="button"><span class="tb-dd-ic">下</span>下载中心</button>' +
      '  <div class="tb-dd-sep"></div>' +
      '  <button class="tb-dd-item" data-dd="diagnostics" type="button"><span class="tb-dd-ic">测</span>设备测试</button>' +
      '  <button class="tb-dd-item" data-dd="devtools" type="button"><span class="tb-dd-ic">调</span>调试窗口</button>' +
      '  <div class="tb-dd-sep"></div>' +
      '  <button class="tb-dd-item tb-danger" data-dd="logout" type="button"><span class="tb-dd-ic">退</span>退出登录</button>' +
      '</div>'

    document.body.appendChild(bar)

    var dd = bar.querySelector('#tb-dd-avatar')
    var avatar = bar.querySelector('#tb-avatar-wrap')

    // 头像下拉
    avatar.addEventListener('click', function (e) {
      e.stopPropagation()
      dd.classList.toggle('show')
    })
    document.addEventListener('click', function () { dd.classList.remove('show') })
    dd.addEventListener('click', function (e) {
      var item = e.target.closest('.tb-dd-item')
      if (!item) return
      dd.classList.remove('show')
      var key = item.getAttribute('data-dd')
      if (api.titlebarMenu) api.titlebarMenu(key)
    })

    // 快捷操作
    bar.querySelectorAll('.tb-qa[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (api.titlebarQuickAction) api.titlebarQuickAction(btn.getAttribute('data-action'))
      })
    })

    // 搜索
    bar.querySelector('#tb-search').addEventListener('click', function () {
      if (api.titlebarMenu) api.titlebarMenu('search')
    })

    // 窗口控制
    bar.querySelectorAll('.tb-wc[data-win]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (api.titlebarWin) api.titlebarWin(btn.getAttribute('data-win'))
      })
    })

    // 双击标题栏空白处 → 最大化/还原（拖拽区 + 左右空区）
    bar.addEventListener('dblclick', function (e) {
      if (e.target.closest('.tb-avatar-wrap,.tb-qa,.tb-search,.tb-wc,.tb-dropdown,.tb-offline')) return
      if (api.titlebarWin) api.titlebarWin('maximize')
    })

    // ── 手动拖拽兜底 ──
    // 原生 -webkit-app-region:drag 生效时，空白区 mousedown 会被系统吞掉、到不了这里 → 兜底静默；
    // 原生失效（远程页环境导致）时 mousedown 会到达 → 通知主进程接管拖拽（16ms 步进跟随鼠标）。
    var _dragging = false
    bar.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      if (e.target.closest('.tb-avatar-wrap,.tb-qa,.tb-search,.tb-wc,.tb-dropdown,.tb-offline')) return
      _dragging = true
      if (api.titlebarDrag) api.titlebarDrag('begin')
      e.preventDefault()
    })
    function _endDrag() {
      if (!_dragging) return
      _dragging = false
      if (api.titlebarDrag) api.titlebarDrag('end')
    }
    document.addEventListener('mouseup', _endDrag)
    window.addEventListener('blur', _endDrag)

    // 键盘：Ctrl/Cmd + K 聚焦搜索
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        var s = bar.querySelector('#tb-search')
        if (s) { e.preventDefault(); s.click() }
      }
    })
  }

  mountBar()

  // 防止 SPA 重渲染把 body 级标题栏误删：移除即重新挂载
  var mo = new MutationObserver(function () {
    if (!document.getElementById('my-titlebar-root')) mountBar()
  })
  mo.observe(document.body, { childList: true })

  // ── 状态同步（在线/离线/重连）──
  function applyStatus(data) {
    var off = !!(data && data.offline)
    var reconnecting = !!(data && data.reconnecting)
    var hint = document.getElementById('tb-offline')
    var dot = document.getElementById('tb-status-dot')
    if (hint) {
      document.documentElement.classList.toggle('tb-offline', off)
      hint.querySelector('.tb-offline-text').textContent = reconnecting ? '离线 · 正在重连' : '被踢下线 · 请重新登录'
    }
    if (dot) {
      dot.classList.toggle('offline', off)
      dot.classList.toggle('reconnect', reconnecting)
      dot.title = off ? (reconnecting ? '离线 · 正在重连' : '被踢下线') : '在线'
    }
  }
  if (api.onTitlebarStatus) {
    api.onTitlebarStatus(function (data) { applyStatus(data) })
  }

  // ── 审批角标 ──
  if (api.onTitlebarApproval) {
    api.onTitlebarApproval(function (count) {
      var bd = document.getElementById('tb-approval-bd')
      if (!bd) return
      var n = Number(count) || 0
      bd.style.display = n > 0 ? 'flex' : 'none'
      bd.textContent = n > 99 ? '99+' : String(n)
    })
  }

  // ── 用户头像/姓名 ──
  if (api.onTitlebarUser) {
    api.onTitlebarUser(function (data) {
      var name = (data && data.name) || ''
      var avatar = (data && data.avatar) || ''
      var av = document.getElementById('tb-avatar')
      var img = document.getElementById('tb-avatar-img')
      if (av) av.textContent = name ? String(name).charAt(0).toUpperCase() : '田'
      if (img) {
        img.onload = function () { img.classList.add('loaded') }
        img.onerror = function () { img.classList.remove('loaded') }
        img.src = avatar
      }
    })
  }

  // ── 对外接口（供主进程全屏时隐藏/显示）──
  window.__myTitlebar = {
    hide: function () { document.documentElement.classList.add('tb-hidden') },
    show: function () { document.documentElement.classList.remove('tb-hidden') },
    setStatus: function (d) { applyStatus(d) }
  }
})();
