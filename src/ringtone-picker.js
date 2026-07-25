// src/ringtone-picker.js
// 共用铃声选择器组件：铃声设置页 与 联系人专属设置页 统一使用，保证章法一致。
// 触发器（当前值 + ▾）+ 下拉分组列表（默认 / 我的铃声）+ 行内试听 + ✓ 选中态 + 整行上传按钮。
// 用法：window.RingtonePicker.create({ mount, getValue, onChange, getCandidates, onUpload })

(function () {
  function basename(p) { return p ? p.split('/').pop() : '' }
  function displayName(rel, names) {
    if (!rel || rel === 'default') return (names && names['assets/ringtone.m4a']) || '经典铃声'
    if (rel.startsWith('assets/')) return (names && names[rel]) || '内置铃声'
    if (rel.startsWith('ringtones/')) return basename(rel)
    return rel
  }

  function getSharedAudio() {
    if (!window.__pickerAudio) {
      window.__pickerAudio = document.createElement('audio')
      window.__pickerAudio.style.display = 'none'
      document.body.appendChild(window.__pickerAudio)
    }
    return window.__pickerAudio
  }

  // 跨实例共享：时长缓存 + 当前试听状态
  var durations = {}            // rel -> 秒
  var currentPlayingRel = null  // 当前正在试听的铃声
  var currentPlayBtn = null     // 当前试听按钮 DOM

  function formatDur(sec) {
    if (!isFinite(sec) || sec <= 0) return ''
    sec = Math.round(sec)
    var m = Math.floor(sec / 60)
    var s = sec % 60
    return m + ':' + (s < 10 ? '0' + s : s)
  }

  function create(opts) {
    var mount = opts.mount
    var getValue = opts.getValue
    var onChange = opts.onChange || function () {}
    var getCandidates = opts.getCandidates || function () { return { localRingtones: [], names: {}, presets: {} } }
    var onUpload = opts.onUpload || function () { return Promise.resolve(null) }

    var panel = null
    var open = false

    // 触发器
    var trigger = document.createElement('button')
    trigger.className = 'picker-trigger'
    trigger.type = 'button'
    function renderTrigger() {
      var v = getValue()
      trigger.innerHTML = '<span class="picker-cur">' + displayName(v, lastNames) + '</span><span class="picker-chev">▾</span>'
    }

    var lastNames = {}
    function buildPanel() {
      var cands = getCandidates() || {}
      lastNames = cands.names || {}
      var local = cands.localRingtones || []
      var builtin = cands.builtin || []
      var v = getValue()

      function rowHtml(r) {
        return '<div class="picker-row' + (r.sel ? ' sel' : '') + '" data-rel="' + encodeURIComponent(r.rel) + '">' +
          '<span class="picker-name">' + r.label + '</span>' +
          '<span class="picker-dur" data-rel="' + encodeURIComponent(r.rel) + '"></span>' +
          '<button class="picker-prev" data-rel="' + encodeURIComponent(r.rel) + '" title="试听">▶</button>' +
          (r.sel ? '<span class="picker-check">✓</span>' : '') +
          '</div>'
      }

      var panelEl = document.createElement('div')
      panelEl.className = 'picker-panel'
      var html = ''
      // 默认
      html += '<div class="picker-group">默认</div>'
      html += rowHtml(row('default', '默认 · ' + displayName('default', lastNames), v === 'default' || !v))
      // 内置铃声（随包铃声，如 assets/ringtones 下的 default.mp3 / msg1~4.mp3）
      if (builtin.length) {
        html += '<div class="picker-group">内置铃声</div>'
        builtin.forEach(function (rel) {
          html += rowHtml(row(rel, displayName(rel, lastNames), v === rel))
        })
      }
      // 我的铃声（用户上传）
      if (local.length) {
        html += '<div class="picker-group">我的铃声</div>'
        local.forEach(function (rel) {
          html += rowHtml(row(rel, displayName(rel, lastNames), v === rel))
        })
      }
      html += '<button class="picker-upload" data-act="upload">⬆ 上传自定义铃声</button>'
      panelEl.innerHTML = html

      // 加载各铃声时长（缓存，避免重复解析元数据）
      function ensureDuration(rel) {
        if (durations[rel] != null) { updateDurText(rel); return }
        var toFile = opts.toFile
        if (!toFile) return
        var url = toFile(rel)
        if (!url) return
        var a = document.createElement('audio')
        a.preload = 'metadata'
        a.src = url
        a.addEventListener('loadedmetadata', function () {
          if (isFinite(a.duration) && a.duration > 0) {
            durations[rel] = a.duration
            updateDurText(rel)
          }
        })
      }
      function updateDurText(rel) {
        var el = panelEl.querySelector('.picker-dur[data-rel="' + encodeURIComponent(rel) + '"]')
        if (el) el.textContent = formatDur(durations[rel])
      }
      ;['default'].concat(builtin, local).forEach(function (rel) { ensureDuration(rel) })

      // 选择
      panelEl.querySelectorAll('.picker-row').forEach(function (rowEl) {
        rowEl.addEventListener('click', function (e) {
          if (e.target.closest('.picker-prev')) return
          var rel = decodeURIComponent(rowEl.getAttribute('data-rel'))
          onChange(rel)
          closePanel()
        })
      })
      // 试听
      panelEl.querySelectorAll('.picker-prev').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation()
          var rel = decodeURIComponent(btn.getAttribute('data-rel'))
          playPreview(rel, btn)
        })
      })
      // 上传
      panelEl.querySelector('.picker-upload').addEventListener('click', function () {
        onUpload().then(function (res) {
          if (res && res.path) {
            onChange(res.path)
          }
          closePanel()
        })
      })
      return panelEl
    }

    function row(rel, label, sel) { return { rel: rel, label: label, sel: sel } }

    function stopPreview() {
      var a = getSharedAudio()
      try { a.pause(); a.currentTime = 0 } catch (e) {}
      if (currentPlayBtn) {
        currentPlayBtn.classList.remove('playing')
        currentPlayBtn.innerHTML = '▶'
      }
      currentPlayingRel = null
      currentPlayBtn = null
    }

    function playPreview(rel, btn) {
      var toFile = opts.toFile
      if (!toFile) return
      var url = toFile(rel)
      if (!url) return
      // 再次点击同一铃声 → 停止（切换/关闭）
      if (currentPlayingRel === rel) { stopPreview(); return }
      stopPreview()
      var a = getSharedAudio()
      a.onended = function () { stopPreview() }
      try {
        a.src = url; a.loop = false; a.currentTime = 0
        var p = a.play()
        if (p && p.catch) p.catch(function () {})
        currentPlayingRel = rel
        currentPlayBtn = btn
        if (btn) {
          btn.classList.add('playing')
          btn.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>'
        }
      } catch (e) { stopPreview() }
    }

    function openPanel() {
      if (open) { closePanel(); return }
      panel = buildPanel()

      // 用 fixed 定位，避免被父容器 overflow 裁剪
      const rect = trigger.getBoundingClientRect()
      // 面板优先在触发器下方展开；如果右侧空间不足则左对齐到触发器右边缘
      let left = rect.left + window.scrollX
      const panelW = 240
      if (left + panelW > window.innerWidth) {
        left = rect.right + window.scrollX - panelW
      }
      panel.style.left = Math.max(4, left) + 'px'
      panel.style.top = (rect.bottom + 2 + window.scrollY) + 'px'

      document.body.appendChild(panel)
      open = true
      // 点击外部关闭
      setTimeout(function () {
        document.addEventListener('click', onDocClick, true)
      }, 0)
    }
    function closePanel() {
      stopPreview()   // 收起候选框时立即停掉正在播放的试听
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
      panel = null; open = false
      document.removeEventListener('click', onDocClick, true)
      renderTrigger()
    }
    function onDocClick(e) {
      if (panel && !panel.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
        closePanel()
      }
    }

    trigger.addEventListener('click', function (e) { e.stopPropagation(); openPanel() })

    mount.innerHTML = ''
    mount.appendChild(trigger)
    renderTrigger()

    return {
      refresh: function () { renderTrigger() },
      setValue: function () { renderTrigger() },
    }
  }

  window.RingtonePicker = { create: create }
})()
