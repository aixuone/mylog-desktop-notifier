// src/ringtone-picker.js
// 共用铃声选择器组件（v3 · 模态弹窗版）：
// 触发器 = 当前铃声名 + 「更改」按钮；点击「更改」打开居中模态弹窗，
// 弹窗内分「默认 / 短铃声 / 我的铃声」分组，支持试听、时长、上传（命名）、行内重命名，
// 选中后「确定」才应用（取消不保存）。
// 用法：window.RingtonePicker.create({ mount, title, getValue, onChange, getCandidates, onUpload, onRename, toFile })

(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function basename(p) { return p ? p.split('/').pop() : '' }
  // 去掉最后一个扩展名（"我的铃声.mp3" → "我的铃声"；多段点号如 "a.b.mp3" → "a.b"）
  function stripExt(n) { return n ? n.replace(/\.[^.]+$/, '') : n }
  function displayName(rel, names) {
    if (!rel || rel === 'default') return (names && names['assets/ringtone.m4a']) || '经典铃声'
    // 自定义展示名优先（内置 config.ringtoneNames 或用户上传后命名）
    var n = names && names[rel]
    if (n) return n
    // 兜底：文件名去掉扩展名显示（不展示 .mp3/.m4a 等类型尾缀）
    if (rel.startsWith('assets/') || rel.startsWith('ringtones/')) return stripExt(basename(rel))
    return rel
  }

  // ── 命名弹窗（上传命名 / 重命名共用）：自绘遮罩 + 输入框，Enter 确认 / Esc 取消 ──
  // 返回 Promise<string|null>：确认返回输入值；取消返回 null。
  // keydown 用捕获阶段并 stopPropagation，避免误触下层模态弹窗的 Esc 关闭。
  function injectPromptStyles() {
    if (document.getElementById('rn-prompt-style')) return
    var st = document.createElement('style')
    st.id = 'rn-prompt-style'
    st.textContent = [
      '.rn-overlay{position:fixed;inset:0;background:rgba(20,30,45,.35);z-index:2147483646;display:flex;align-items:center;justify-content:center;}',
      '.rn-panel{width:280px;background:#fff;border-radius:12px;box-shadow:0 16px 48px rgba(20,35,60,.28);padding:16px 16px 14px;font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;user-select:none;}',
      '.rn-title{font-size:13px;font-weight:700;color:#2C2C2A;margin-bottom:10px;}',
      '.rn-input{width:100%;box-sizing:border-box;height:32px;border:1px solid #D8D5CF;border-radius:8px;padding:0 10px;font-size:12.5px;color:#2C2C2A;outline:none;background:#fff;}',
      '.rn-input:focus{border-color:#185FA5;box-shadow:0 0 0 3px rgba(24,95,165,.14);}',
      '.rn-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}',
      '.rn-btn{height:28px;padding:0 14px;border-radius:8px;font-size:12px;cursor:pointer;border:1px solid transparent;}',
      '.rn-cancel{background:#fff;border-color:#D8D5CF;color:#5F5E5A;}',
      '.rn-cancel:hover{background:#F5F4F0;}',
      '.rn-ok{background:#185FA5;color:#fff;}',
      '.rn-ok:hover{background:#15508C;}',
      '.rn-msg{font-size:12.5px;color:#5F5E5A;line-height:1.6;margin:2px 0 4px;}',
      '.rn-danger{background:#D9534F;color:#fff;}',
      '.rn-danger:hover{background:#C9302C;}',
      '.picker-rename{width:22px;height:22px;border:0;background:transparent;color:#9A9893;font-size:11px;cursor:pointer;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}',
      '.picker-rename:hover{background:#E2EFFB;color:#185FA5;}',
      '.picker-remove{width:22px;height:22px;border:0;background:transparent;color:#9A9893;font-size:11px;cursor:pointer;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}',
      '.picker-remove:hover{background:#FCEBEB;color:#D9534F;}',
    ].join('\n')
    document.head.appendChild(st)
  }
  function promptName(title, defaultValue) {
    injectPromptStyles()
    return new Promise(function (resolve) {
      var overlay = document.createElement('div')
      overlay.className = 'rn-overlay'
      var panel = document.createElement('div')
      panel.className = 'rn-panel'
      panel.innerHTML =
        '<div class="rn-title">' + escapeHtml(title || '铃声名称') + '</div>' +
        '<input class="rn-input" type="text" maxlength="40" spellcheck="false" placeholder="请输入铃声名称">' +
        '<div class="rn-btns">' +
        '<button class="rn-btn rn-cancel" type="button">取消</button>' +
        '<button class="rn-btn rn-ok" type="button">确定</button>' +
        '</div>'
      overlay.appendChild(panel)
      document.body.appendChild(overlay)
      var input = panel.querySelector('.rn-input')
      input.value = defaultValue || ''
      function cleanup() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(input.value) }
        else if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null) }
      }
      panel.querySelector('.rn-ok').addEventListener('click', function () { cleanup(); resolve(input.value) })
      panel.querySelector('.rn-cancel').addEventListener('click', function () { cleanup(); resolve(null) })
      overlay.addEventListener('click', function (e) { if (e.target === overlay) { cleanup(); resolve(null) } })
      document.addEventListener('keydown', onKey, true)
      input.focus()
      input.select()
    })
  }

  // ── 确认弹窗（删除等危险操作）：Enter 确认 / Esc 取消 ──
  function confirmDialog(title, message, okText) {
    injectPromptStyles()
    return new Promise(function (resolve) {
      var overlay = document.createElement('div')
      overlay.className = 'rn-overlay'
      var panel = document.createElement('div')
      panel.className = 'rn-panel'
      panel.innerHTML =
        '<div class="rn-title">' + escapeHtml(title || '确认') + '</div>' +
        '<div class="rn-msg">' + escapeHtml(message || '') + '</div>' +
        '<div class="rn-btns">' +
        '<button class="rn-btn rn-cancel" type="button">取消</button>' +
        '<button class="rn-btn rn-danger" type="button">' + escapeHtml(okText || '确定') + '</button>' +
        '</div>'
      overlay.appendChild(panel)
      document.body.appendChild(overlay)
      function cleanup() { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(true) }
        else if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(false) }
      }
      panel.querySelector('.rn-danger').addEventListener('click', function () { cleanup(); resolve(true) })
      panel.querySelector('.rn-cancel').addEventListener('click', function () { cleanup(); resolve(false) })
      overlay.addEventListener('click', function (e) { if (e.target === overlay) { cleanup(); resolve(false) } })
      document.addEventListener('keydown', onKey, true)
      panel.querySelector('.rn-danger').focus()
    })
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

  function getSharedAudio() {
    if (!window.__pickerAudio) {
      window.__pickerAudio = document.createElement('audio')
      window.__pickerAudio.style.display = 'none'
      document.body.appendChild(window.__pickerAudio)
    }
    return window.__pickerAudio
  }

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

  function playPreview(rel, btn, toFile) {
    if (!toFile) return
    var url = toFile(rel)
    if (!url) return
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

  function create(opts) {
    var mount = opts.mount
    var getValue = opts.getValue
    var onChange = opts.onChange || function () {}
    var onRename = opts.onRename || function () { return Promise.resolve() }
    var onDelete = opts.onDelete || function () { return Promise.resolve() }
    var getCandidates = opts.getCandidates || function () { return { localRingtones: [], names: {}, presets: {} } }
    var onUpload = opts.onUpload || function () { return Promise.resolve(null) }
    var title = opts.title || ''

    var lastNames = {}
    var modal = null
    var pending = null   // 弹窗内待确认铃声 rel

    // ── 触发器：当前铃声名 + 「更改」按钮 ──
    var trigger = document.createElement('div')
    trigger.className = 'rp-trigger'
    trigger.title = '更改铃声'
    function renderTrigger() {
      var cands = getCandidates() || {}
      lastNames = cands.names || lastNames
      var v = getValue()
      var nm = displayName(v, lastNames)
      trigger.innerHTML =
        '<span class="rp-name">' + escapeHtml(nm) + '</span>' +
        '<button type="button" class="rp-change">更改</button>'
    }

    // ── 弹窗内容构建 ──
    function buildRowHtml(r) {
      return '<div class="rp-row' + (r.sel ? ' sel' : '') + '" data-rel="' + encodeURIComponent(r.rel) + '">' +
        '<span class="rp-radio"></span>' +
        '<span class="rp-name2">' + escapeHtml(r.label) + '</span>' +
        '<span class="picker-dur" data-rel="' + encodeURIComponent(r.rel) + '"></span>' +
        (r.deletable ? '<button class="picker-remove" data-rel="' + encodeURIComponent(r.rel) + '" title="删除">🗑</button>' : '') +
        (r.renameable ? '<button class="picker-rename" data-rel="' + encodeURIComponent(r.rel) + '" title="重命名">✎</button>' : '') +
        '<button class="picker-prev" data-rel="' + encodeURIComponent(r.rel) + '" title="试听">▶</button>' +
        '</div>'
    }
    function row(rel, label, sel, renameable, deletable) {
      return { rel: rel, label: label, sel: sel, renameable: !!renameable, deletable: !!deletable }
    }

    function buildBody(pendingRel) {
      var cands = getCandidates() || {}
      lastNames = cands.names || {}
      var local = cands.localRingtones || []
      var builtin = cands.builtin || []
      var v = pendingRel != null ? pendingRel : getValue()

      var body = document.createElement('div')
      body.className = 'rp-body'
      var html = ''
      // 上传新铃声（置顶，方便随时上传）
      html += '<button class="rp-upload" type="button">⬆ 上传新铃声</button>'
      // 默认（长铃声）
      html += '<div class="rp-group">默认铃声</div>'
      html += buildRowHtml(row('default', displayName('default', lastNames), v === 'default' || !v))
      // 内置短铃声
      if (builtin.length) {
        html += '<div class="rp-group">短铃声</div>'
        builtin.forEach(function (rel) {
          html += buildRowHtml(row(rel, displayName(rel, lastNames), v === rel))
        })
      }
      // 我的铃声（用户上传）
      if (local.length) {
        html += '<div class="rp-group">我的铃声</div>'
        local.forEach(function (rel) {
          html += buildRowHtml(row(rel, displayName(rel, lastNames), v === rel, true, true))
        })
      }
      body.innerHTML = html

      // 时长（缓存）
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
        var el = body.querySelector('.picker-dur[data-rel="' + encodeURIComponent(rel) + '"]')
        if (el) el.textContent = formatDur(durations[rel])
      }
      ;['default'].concat(builtin, local).forEach(function (rel) { ensureDuration(rel) })

      // 点行 → 设为待选（不高亮提交，确定才生效）
      body.querySelectorAll('.rp-row').forEach(function (rowEl) {
        rowEl.addEventListener('click', function (e) {
          if (e.target.closest('.picker-prev') || e.target.closest('.picker-rename') || e.target.closest('.picker-remove')) return
          var rel = decodeURIComponent(rowEl.getAttribute('data-rel'))
          pending = rel
          body.querySelectorAll('.rp-row').forEach(function (r) { r.classList.toggle('sel', r === rowEl) })
        })
      })
      // 试听
      body.querySelectorAll('.picker-prev').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation()
          var rel = decodeURIComponent(btn.getAttribute('data-rel'))
          playPreview(rel, btn, opts.toFile)
        })
      })
      // 删除（仅「我的铃声」行）：二次确认 → 删除 → 数据刷新后关闭弹窗（重开即新列表）
      body.querySelectorAll('.picker-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation()
          var rel = decodeURIComponent(btn.getAttribute('data-rel'))
          stopPreview()
          confirmDialog(
            '删除铃声',
            '删除「' + displayName(rel, lastNames) + '」后将不可恢复，所有场景会自动恢复默认铃声。',
            '删除'
          ).then(function (ok) {
            if (!ok) return
            onDelete(rel).then(function (done) {
              if (done === false) return   // 删除失败，保持弹窗
              closeModal()
            })
          })
        })
      })
      // 重命名（仅「我的铃声」行）
      body.querySelectorAll('.picker-rename').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation()
          var rel = decodeURIComponent(btn.getAttribute('data-rel'))
          var cur = displayName(rel, lastNames)
          promptName('重命名铃声', cur).then(function (nm) {
            if (nm && nm.trim()) {
              onRename(rel, nm).then(function () { refreshBody() })
            }
          })
        })
      })
      // 上传：选文件 → 命名 → 加入列表并自动选中待确认
      body.querySelector('.rp-upload').addEventListener('click', function () {
        onUpload().then(function (res) {
          if (!res || !res.path) return
          promptName('铃声名称', res.name || '').then(function (nm) {
            var task = Promise.resolve()
            if (nm && nm.trim()) task = task.then(function () { return onRename(res.path, nm) })
            task.then(function () {
              pending = res.path
              refreshBody()
            })
          })
        })
      })
      return body
    }

    function refreshBody() {
      if (!modal) return
      var bodyWrap = modal.querySelector('.rp-body-wrap')
      var body = buildBody(pending)
      bodyWrap.innerHTML = ''
      bodyWrap.appendChild(body)
    }

    // ── 弹窗开合 ──
    function openModal() {
      if (modal) return
      pending = getValue()
      stopPreview()
      var overlay = document.createElement('div')
      overlay.className = 'rp-overlay'
      overlay.innerHTML =
        '<div class="rp-modal">' +
          '<div class="rp-head">' +
            '<div class="rp-head-ic">♪</div>' +
            '<div><div class="rp-tt">更改铃声</div><div class="rp-st">' + escapeHtml(title || '') + '</div></div>' +
            '<button type="button" class="rp-close" title="关闭">✕</button>' +
          '</div>' +
          '<div class="rp-body-wrap"></div>' +
          '<div class="rp-foot">' +
            '<button type="button" class="rp-btn rp-cancel">取消</button>' +
            '<button type="button" class="rp-btn rp-ok">确定</button>' +
          '</div>' +
        '</div>'
      document.body.appendChild(overlay)
      modal = overlay
      var body = buildBody(pending)
      overlay.querySelector('.rp-body-wrap').appendChild(body)

      // 关闭
      function close() { closeModal() }
      overlay.querySelector('.rp-close').addEventListener('click', close)
      overlay.querySelector('.rp-cancel').addEventListener('click', close)
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
      // 确定 → 应用待选
      overlay.querySelector('.rp-ok').addEventListener('click', function () {
        onChange(pending != null ? pending : getValue())
        close()
      })
      // Esc 关闭（冒泡阶段；命名弹窗用捕获阶段拦截，不会误触）
      document.addEventListener('keydown', onModalKey)
    }
    function onModalKey(e) {
      if (e.key === 'Escape' && modal) { e.stopPropagation(); closeModal() }
    }
    function closeModal() {
      stopPreview()
      document.removeEventListener('keydown', onModalKey)
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal)
      modal = null
      pending = null
      renderTrigger()
    }

    trigger.addEventListener('click', function (e) {
      if (e.target.closest('.rp-change')) { openModal(); return }
      openModal()
    })

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
