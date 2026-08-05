// screenshare-shim.js — 注入到主页面【main world】的屏幕共享兼容层
//
// 背景：腾讯 TRTC / TUICallEngine 在 Electron 下的屏共享有三条路径：
//   1. Chrome 扩展路径：检测 chrome.desktopCapture.chooseDesktopMedia 是否存在 →
//      调用获取 streamId → getUserMedia({chromeMediaSource:'desktop', chromeMediaSourceId: streamId})
//      ← **这是 TRTC 在检测到 Electron UA 时的首选路径**
//   2. 新版标准路径：getDisplayMedia() → 由 setDisplayMediaRequestHandler 拾起
//   3. 旧式 getUserMedia({chromeMediaSource:'desktop'}) 但不带 chromeMediaSourceId → 失败
//
// 根因定位（DevTools 日志铁证）：
//   TRTC/TUICallEngine v3.5.9 在 Electron 中检查 chrome.desktopCapture API，
//   发现不存在 → 认定屏共享不可用 → 直接报"未知错误"，根本不调任何 API。
//   Agora RTC_AMBULANCE 也不调 getDisplayMedia（日志无 handler 记录）。
//
// 此脚本提供三项关键修复（三层保险）：
//   A. chrome.desktopCapture.chooseDesktopMedia mock —— 让 TRTC 检测到"扩展可用"
//      调 chooseDesktopMedia → 我们回 sourceId → SDK 调 getUserMedia 带完整约束 → 成功
//   B. getUserMedia 包裹 —— 对 legacy 路径兜底注入 chromeMediaSourceId
//   C. getDisplayMedia 包裹 —— 埋点追踪（handler 已在主进程正常工作）
//
// ⚠️ 此脚本通过 webContents.executeJavaScript 注入，运行在网页 main world，
//    不是 preload —— 因为 contextIsolation=true 时 preload 的包裹渗透不到网页，
//    在 preload 里加 chrome.desktopCapture 对腾讯 SDK 完全无效。
(function () {
  // 防止重复包裹（整页重新加载时会再次执行；iframe 注入也用此标记）
  if (window.__SCREEN_SHARE_SHIM_INSTALLED__) return
  window.__SCREEN_SHARE_SHIM_INSTALLED__ = true

  var cfg = window.__SCREEN_SHARE_CFG__ || {}
  var SOURCE_ID = cfg.sourceId || ''
  var AUDIO_MODE = cfg.audioMode || 'mute'

  // ─── 双通道日志：同时写 DevTools console + IPC 到主进程 ───
  // 之前 log() 只走 IPC，用户在 DevTools 里看不到 shim 消息——这是定位困难的主要原因。
  // 现在两条路都写，DevTools 和主进程终端都能看到。
  function log(msg) {
    console.log('[main-world-shim] ' + msg)  // DevTools 可见
    try {
      if (window.electronAPI && window.electronAPI.logMedia) window.electronAPI.logMedia('[main-world-shim] ' + msg)
    } catch (e) {}
  }
  // 序列约束时把 chromeMediaSourceId 脱敏，避免日志刷屏
  function safe(o) {
    try {
      return JSON.stringify(o, function (k, v) {
        if (k === 'chromeMediaSourceId' && v) return '<id>'
        return v
      })
    } catch (e) { return String(o) }
  }
  // 是否需要注入源 id：约束声明了 chromeMediaSource:'desktop'/'screen' 且尚未带 chromeMediaSourceId
  function needsDesktopId(constraints) {
    var v = constraints && constraints.video
    if (!v) return false
    var m = v.mandatory || v
    var cs = m.chromeMediaSource
    if (cs !== 'desktop' && cs !== 'screen') return false
    return !m.chromeMediaSourceId
  }

  // ─── A. chrome.desktopCapture mock（TRTC 屏共享的关键入口）───
  // TRTC/TUICallEngine 检测到 Electron UA 后，会优先查找 chrome.desktopCapture API：
  //   if (window.chrome && chrome.desktopCapture && chrome.desktopCapture.chooseDesktopMedia)
  // 如果找不到 → 认定屏共享不可用 → 直接报错，不调任何媒体 API。
  //
  // 同时在 desktopCapture 上加 getter 拦截，记录 SDK 对此属性的读取——
  // 这能证明 TRTC 是否真的在检测 chrome.desktopCapture。
  window.chrome = window.chrome || {}
  window.chrome.runtime = window.chrome.runtime || {}

  // 用 defineProperty 带 getter 来检测 SDK 是否读取 desktopCapture
  var _dcMock = {}
  var _dcReadCount = 0
  var _cdmReadCount = 0
  var _nextRequestId = 1
  var _activeRequests = {}

  _dcMock.chooseDesktopMedia = function (types, targetTab, callback) {
    var requestId = _nextRequestId++
    log('chrome.desktopCapture.chooseDesktopMedia called | types=' + JSON.stringify(types || [])
      + ' | sourceId=' + (SOURCE_ID ? SOURCE_ID.slice(0, 16) + '…' : 'none'))
    if (!SOURCE_ID) {
      log('chooseDesktopMedia: no SOURCE_ID → returning empty (cancel)')
      setTimeout(function () { callback('') }, 0)
      return requestId
    }
    _activeRequests[requestId] = { sourceId: SOURCE_ID, callback: callback }
    setTimeout(function () {
      var req = _activeRequests[requestId]
      if (req && req.callback) {
        req.callback(req.sourceId)
        log('chooseDesktopMedia callback fired | sourceId=' + req.sourceId.slice(0, 16) + '…')
      }
      delete _activeRequests[requestId]
    }, 50)
    return requestId
  }

  _dcMock.cancelChooseDesktopMedia = function (requestId) {
    log('chrome.desktopCapture.cancelChooseDesktopMedia called | requestId=' + requestId)
    var req = _activeRequests[requestId]
    if (req && req.callback) {
      req.callback('')
      log('chooseDesktopMedia cancelled | requestId=' + requestId)
    }
    delete _activeRequests[requestId]
  }

  // 给 chrome.desktopCapture 安装 getter——当 SDK 读取此属性时，记录访问
  try {
    Object.defineProperty(window.chrome, 'desktopCapture', {
      configurable: true,
      enumerable: true,
      get: function () {
        _dcReadCount++
        log('chrome.desktopCapture READ (#' + _dcReadCount + ') — SDK 正在检测此属性')
        return _dcMock
      }
    })
  } catch (e) {
    // defineProperty 失败（可能已有不可配置属性）→ 直接赋值
    window.chrome.desktopCapture = _dcMock
    log('chrome.desktopCapture: defineProperty failed, set directly')
  }

  // 给 chooseDesktopMedia 也加 getter 拦截——更细粒度地检测函数引用读取
  // SDK 可能只检查 `typeof chrome.desktopCapture.chooseDesktopMedia === 'function'`
  // 而不真正调用。getter 能捕获这种"只读不调"的检测。
  try {
    var _cdmFn = _dcMock.chooseDesktopMedia
    Object.defineProperty(_dcMock, 'chooseDesktopMedia', {
      configurable: true,
      enumerable: true,
      get: function () {
        _cdmReadCount++
        log('chrome.desktopCapture.chooseDesktopMedia READ (#' + _cdmReadCount + ') — SDK 正在检测此函数')
        return _cdmFn
      }
    })
  } catch (e) {
    log('chooseDesktopMedia defineProperty failed: ' + (e && e.message))
  }

  log('chrome.desktopCapture mock installed | chooseDesktopMedia=yes cancelChooseDesktopMedia=yes sourceId='
    + (SOURCE_ID ? SOURCE_ID.slice(0, 16) + '…' : 'none')
    + ' | getter-traps: desktopCapture=yes chooseDesktopMedia=yes')

  // ─── B+C. MediaDevices API 包裹（兜底 + 埋点）───
  function wrapMediaDevices(md, tag) {
    if (!md) return { gum: false, gdm: false }
    var gum = false, gdm = false

    if (typeof md.getUserMedia === 'function') {
      var origGUM = md.getUserMedia.bind(md)
      md.getUserMedia = function (constraints) {
        log(tag + ' getUserMedia request ' + safe(constraints))
        var inject = needsDesktopId(constraints)
        if (inject) {
          if (SOURCE_ID) {
            var v = constraints.video
            if (v.mandatory) v.mandatory.chromeMediaSourceId = SOURCE_ID
            else v.chromeMediaSourceId = SOURCE_ID
            log(tag + ' injected chromeMediaSourceId=' + SOURCE_ID.slice(0, 16) + '…')
          } else {
            log(tag + ' 需要 desktop 源但无 SOURCE_ID 可用')
          }
        }
        return origGUM(constraints)
          .then(function (s) {
            log(tag + ' getUserMedia OK v=' + !!s.getVideoTracks()[0] + ' a=' + !!s.getAudioTracks()[0])
            return s
          })
          .catch(function (e) {
            log(tag + ' getUserMedia ERR ' + (e && e.name) + ': ' + (e && e.message))
            throw e
          })
      }
      gum = true
    }

    if (typeof md.getDisplayMedia === 'function') {
      var origGDM = md.getDisplayMedia.bind(md)
      md.getDisplayMedia = function (constraints) {
        log(tag + ' getDisplayMedia request ' + safe(constraints))
        return origGDM(constraints)
          .then(function (s) {
            log(tag + ' getDisplayMedia OK v=' + !!s.getVideoTracks()[0] + ' a=' + !!s.getAudioTracks()[0])
            return s
          })
          .catch(function (e) {
            log(tag + ' getDisplayMedia ERR ' + (e && e.name) + ': ' + (e && e.message))
            throw e
          })
      }
      gdm = true
    } else if (md) {
      // getDisplayMedia 在注入时不可用——用 getter/setter 拦截后续定义
      try {
        var _gdmValue = undefined
        Object.defineProperty(md, 'getDisplayMedia', {
          configurable: true,
          enumerable: true,
          get: function () {
            if (_gdmValue) return _gdmValue
            var proto = Object.getPrototypeOf(md)
            var protoMethod = proto && proto.getDisplayMedia
            if (typeof protoMethod === 'function') {
              var bound = protoMethod.bind(md)
              _gdmValue = function (constraints) {
                log(tag + ' getDisplayMedia request(proto-fallback) ' + safe(constraints))
                return bound(constraints)
                  .then(function (s) {
                    log(tag + ' getDisplayMedia OK v=' + !!s.getVideoTracks()[0] + ' a=' + !!s.getAudioTracks()[0])
                    return s
                  })
                  .catch(function (e) {
                    log(tag + ' getDisplayMedia ERR ' + (e && e.name) + ': ' + (e && e.message))
                    throw e
                  })
              }
              gdm = true
              return _gdmValue
            }
            return undefined
          },
          set: function (fn) {
            if (typeof fn === 'function') {
              var bound = fn.bind(md)
              _gdmValue = function (constraints) {
                log(tag + ' getDisplayMedia request(setter-trap) ' + safe(constraints))
                return bound(constraints)
                  .then(function (s) {
                    log(tag + ' getDisplayMedia OK v=' + !!s.getVideoTracks()[0] + ' a=' + !!s.getAudioTracks()[0])
                    return s
                  })
                  .catch(function (e) {
                    log(tag + ' getDisplayMedia ERR ' + (e && e.name) + ': ' + (e && e.message))
                    throw e
                  })
              }
              gdm = true
              log(tag + ' getDisplayMedia setter trap: wrapped on set')
            } else {
              _gdmValue = undefined
            }
          }
        })
        log(tag + ' getDisplayMedia not available at inject time; setter+proto trap installed')
      } catch (defineErr) {
        log(tag + ' getDisplayMedia defineProperty failed: ' + (defineErr && defineErr.message))
      }
    }

    return { gum: gum, gdm: gdm }
  }

  // ─── 主窗口 ───
  var md = navigator.mediaDevices
  var mainResult = wrapMediaDevices(md, '[main]')
  log('shim installed | sourceId=' + (SOURCE_ID ? SOURCE_ID.slice(0, 16) + '…' : 'none')
    + ' audioMode=' + AUDIO_MODE
    + ' gum=' + mainResult.gum + ' gdm=' + mainResult.gdm)

  // ─── D. toString 伪装（防 [native code] 检测）───
  // 包裹 getDisplayMedia / getUserMedia 后，toString() 返回的是函数源码而非原生格式，
  // 某些 SDK 会通过检测 "[native code]" 判断 API 是否被篡改。
  // 用 Object.defineProperty 重新定义包裹函数的 toString，返回原生格式。
  function maskNativeToString(fn, name) {
    if (typeof fn !== 'function') return
    try {
      var nativeStr = 'function ' + name + '() { [native code] }'
      Object.defineProperty(fn, 'toString', {
        configurable: true,
        value: function () { return nativeStr }
      })
      // 进一步伪装 toString 自身，避免被二次检测
      Object.defineProperty(fn.toString, 'toString', {
        configurable: true,
        value: function () { return 'function toString() { [native code] }' }
      })
      log('toString masked: ' + name)
    } catch (e) {
      log('toString mask failed for ' + name + ': ' + (e && e.message))
    }
  }

  // 对主窗口的 getUserMedia / getDisplayMedia 包裹函数应用 toString 伪装
  try {
    if (md) {
      if (typeof md.getUserMedia === 'function') maskNativeToString(md.getUserMedia, 'getUserMedia')
      if (typeof md.getDisplayMedia === 'function') maskNativeToString(md.getDisplayMedia, 'getDisplayMedia')
    }
  } catch (e) {
    log('toString mask apply err: ' + (e && e.message))
  }

  // ─── D2. chooseDesktopMedia / cancelChooseDesktopMedia toString 伪装 ───
  // TRTC 可能通过 chooseDesktopMedia.toString().includes('[native code]') 检测是否为原生函数。
  // _cdmFn 是 getter 返回的 chooseDesktopMedia 函数引用，对它做 toString 伪装。
  // 注意：getter 每次返回同一个 _cdmFn 引用，对 _cdmFn 做 toString 伪装即可生效。
  try {
    maskNativeToString(_cdmFn, 'chooseDesktopMedia')
    maskNativeToString(_dcMock.cancelChooseDesktopMedia, 'cancelChooseDesktopMedia')
  } catch (e) {
    log('desktopCapture toString mask err: ' + (e && e.message))
  }

  // ─── D3. chrome.runtime.id 伪装 ───
  // 原生扩展环境下 chrome.runtime.id 是非空字符串（扩展 ID）。
  // 某些 SDK 检测它是否存在作为"是否在扩展环境"的判据。
  // 用 getter（configurable=false 无 setter 不可重写）定义，同时埋点读取次数。
  try {
    var _runtimeIdReadCount = 0
    try {
      if (!window.chrome.runtime.id) {
        Object.defineProperty(window.chrome.runtime, 'id', {
          configurable: false,
          enumerable: true,
          get: function () {
            _runtimeIdReadCount++
            log('chrome.runtime.id READ (#' + _runtimeIdReadCount + ') — SDK 正在检测扩展 ID')
            return 'mylog-desktop-notifier-screen-capture'
          }
        })
        log('chrome.runtime.id mock installed (getter, non-configurable)')
      } else {
        log('chrome.runtime.id already present: ' + String(window.chrome.runtime.id).slice(0, 32))
      }
    } catch (e) {
      // defineProperty 失败（可能已有不可配置属性）→ 直接赋值兜底
      try {
        if (!window.chrome.runtime.id) {
          window.chrome.runtime.id = 'mylog-desktop-notifier-screen-capture'
          log('chrome.runtime.id set directly (defineProperty failed: ' + (e && e.message) + ')')
        }
      } catch (e2) {
        log('chrome.runtime.id fallback err: ' + (e2 && e2.message))
      }
    }
  } catch (e) {
    log('chrome.runtime.id mock err: ' + (e && e.message))
  }

  // ─── D4. chrome.runtime.getURL 伪装 ───
  // 某些 SDK 检测 chrome.runtime.getURL 是否存在（用于获取扩展内部资源路径）。
  try {
    var _getURLReadCount = 0
    if (typeof window.chrome.runtime.getURL !== 'function') {
      var _getURLFn = function (path) {
        _getURLReadCount++
        log('chrome.runtime.getURL READ (#' + _getURLReadCount + ') path=' + (path || ''))
        return 'chrome-extension://mylog-desktop-notifier-screen-capture/' + (path || '')
      }
      window.chrome.runtime.getURL = _getURLFn
      maskNativeToString(_getURLFn, 'getURL')
      log('chrome.runtime.getURL mock installed')
    } else {
      log('chrome.runtime.getURL already present, skip mock')
    }
  } catch (e) {
    log('chrome.runtime.getURL mock err: ' + (e && e.message))
  }

  // ─── E. RTCRtpSender.getCapabilities mock ───
  // 某些 SDK 通过 RTCRtpSender.getCapabilities('video') 检测编解码能力。
  // 如果原生不存在则 mock 一个返回包含 H264 编解码能力的对象；如果原生存在则不干预。
  try {
    var _rtcCapsReadCount = 0
    function _makeVideoCapabilities() {
      return {
        codecs: [
          { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
          { mimeType: 'video/VP8', clockRate: 90000 },
          { mimeType: 'video/VP9', clockRate: 90000 }
        ]
      }
    }
    function _makeAudioCapabilities() {
      return {
        codecs: [
          { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
          { mimeType: 'audio/telephone-event', clockRate: 8000 }
        ]
      }
    }

    if (typeof RTCRtpSender !== 'undefined') {
      if (typeof RTCRtpSender.getCapabilities !== 'function') {
        RTCRtpSender.getCapabilities = function (kind) {
          _rtcCapsReadCount++
          log('RTCRtpSender.getCapabilities READ (#' + _rtcCapsReadCount + ') kind=' + kind)
          if (kind === 'video') return _makeVideoCapabilities()
          if (kind === 'audio') return _makeAudioCapabilities()
          return { codecs: [] }
        }
        log('RTCRtpSender.getCapabilities mocked (was missing)')
      } else {
        // 原生存在，不干预
        log('RTCRtpSender.getCapabilities exists (native), no intervention')
      }
    } else {
      log('RTCRtpSender not defined globally, skipping getCapabilities mock')
    }
  } catch (e) {
    log('RTCRtpSender.getCapabilities mock err: ' + (e && e.message))
  }

  // ─── F. navigator.mediaDevices.getSupportedConstraints mock ───
  // 确保返回对象包含屏幕共享相关约束键：
  // displaySurface, logicalSurface, cursor, suppressLocalAudioPlayback, mediaStreamSource
  // 原生存在则合并补充缺失键；不存在则 mock 一个。
  try {
    var _gscReadCount = 0
    var _gscNeedKeys = ['displaySurface', 'logicalSurface', 'cursor', 'suppressLocalAudioPlayback', 'mediaStreamSource']

    if (md && typeof md.getSupportedConstraints === 'function') {
      var _origGSC = md.getSupportedConstraints.bind(md)
      md.getSupportedConstraints = function () {
        _gscReadCount++
        log('getSupportedConstraints READ (#' + _gscReadCount + ')')
        var base = {}
        try { base = _origGSC() || {} } catch (e) { base = {} }
        for (var i = 0; i < _gscNeedKeys.length; i++) {
          if (!(_gscNeedKeys[i] in base)) base[_gscNeedKeys[i]] = true
        }
        return base
      }
      log('getSupportedConstraints wrapped (merge mode)')
    } else if (md) {
      md.getSupportedConstraints = function () {
        _gscReadCount++
        log('getSupportedConstraints READ (#' + _gscReadCount + ')')
        var o = {}
        for (var i = 0; i < _gscNeedKeys.length; i++) o[_gscNeedKeys[i]] = true
        return o
      }
      log('getSupportedConstraints mocked (was missing)')
    }
  } catch (e) {
    log('getSupportedConstraints mock err: ' + (e && e.message))
  }

  // ─── G. TRTC setLogLevel 拦截（诊断用）───
  // 现象：TRTC 先 setLogLevel(0) 然后又 setLogLevel(4)，level=4 屏蔽了所有 INFO/DEBUG 日志。
  // 策略：定期（每 500ms，持续 10 秒）扫描 window 上的 TRTC 相关对象
  //       （查找包含 setLogLevel 方法的对象），找到后包裹 setLogLevel，
  //       忽略任何 >= 1 的级别设置，强制保持 level=0（VERBOSE）。
  try {
    var _sllScanCount = 0
    var _sllMaxScans = 20   // 10 秒 / 500ms
    var _sllInterval = 500
    var _sllWrappedSet = []

    function _sllIsCandidate(obj) {
      if (!obj || typeof obj !== 'object') return false
      if (typeof obj.setLogLevel !== 'function') return false
      return true
    }

    function _sllAlreadyWrapped(obj) {
      for (var i = 0; i < _sllWrappedSet.length; i++) {
        if (_sllWrappedSet[i] === obj) return true
      }
      return false
    }

    function _sllWrap(obj, path) {
      if (_sllAlreadyWrapped(obj)) return
      try {
        var orig = obj.setLogLevel
        if (orig && orig.__sllWrapped) return
        var wrapped = function (level) {
          var forced = level
          if (typeof level === 'number' && level >= 1) {
            log('setLogLevel intercepted: level=' + level + ' → forced to 0 (path=' + path + ')')
            forced = 0
          } else {
            log('setLogLevel pass-through: level=' + level + ' (path=' + path + ')')
          }
          try { return orig.call(this, forced) } catch (e) {
            log('setLogLevel orig call err: ' + (e && e.message))
          }
        }
        wrapped.__sllWrapped = true
        try {
          Object.defineProperty(obj, 'setLogLevel', {
            configurable: true, writable: true, value: wrapped
          })
        } catch (e) {
          obj.setLogLevel = wrapped
        }
        _sllWrappedSet.push(obj)
        log('setLogLevel wrapped on ' + path)
      } catch (e) {
        log('setLogLevel wrap err: ' + (e && e.message))
      }
    }

    function _sllScan() {
      _sllScanCount++
      try {
        var topKeys = []
        try { topKeys = Object.getOwnPropertyNames(window) } catch (e) {}
        for (var i = 0; i < topKeys.length; i++) {
          var k = topKeys[i]
          var v
          try { v = window[k] } catch (e) { continue }
          if (_sllIsCandidate(v)) _sllWrap(v, k)
          // 一层嵌套：扫描属性值
          if (v && typeof v === 'object') {
            var subKeys = []
            try { subKeys = Object.getOwnPropertyNames(v) } catch (e) {}
            for (var j = 0; j < subKeys.length; j++) {
              var sk = subKeys[j]
              var sv
              try { sv = v[sk] } catch (e) { continue }
              if (_sllIsCandidate(sv)) _sllWrap(sv, k + '.' + sk)
            }
          }
        }
      } catch (e) {
        log('setLogLevel scan err: ' + (e && e.message))
      }
      if (_sllScanCount < _sllMaxScans) {
        setTimeout(_sllScan, _sllInterval)
      } else {
        log('setLogLevel scan done: ' + _sllWrappedSet.length + ' object(s) wrapped over ' + _sllMaxScans + ' scans')
      }
    }

    log('setLogLevel scan started: ' + _sllMaxScans + ' scans every ' + _sllInterval + 'ms')
    setTimeout(_sllScan, 0)
  } catch (e) {
    log('setLogLevel interceptor setup err: ' + (e && e.message))
  }

  // ─── 同源 iframe 注入 ───
  function injectIntoIframes() {
    var iframes = document.querySelectorAll('iframe')
    var injected = 0
    for (var i = 0; i < iframes.length; i++) {
      try {
        var w = iframes[i].contentWindow
        if (w && !w.__SCREEN_SHARE_SHIM_INSTALLED__) {
          w.__SCREEN_SHARE_SHIM_INSTALLED__ = true
          w.__SCREEN_SHARE_CFG__ = window.__SCREEN_SHARE_CFG__
          // iframe 里也注入 chrome.desktopCapture mock（含 getter 拦截）
          w.chrome = w.chrome || {}
          w.chrome.runtime = w.chrome.runtime || {}
          var iframeSourceId = (w.__SCREEN_SHARE_CFG__ && w.__SCREEN_SHARE_CFG__.sourceId) || SOURCE_ID
          var iframeNextId = 1
          var iframeActive = {}
          var iframeDcReads = 0
          var iframeCdmReads = 0

          var iframeDcMock = {}
          iframeDcMock.chooseDesktopMedia = function (types, targetTab, cb) {
            var rid = iframeNextId++
            log('[iframe-' + i + '] chooseDesktopMedia called | types=' + JSON.stringify(types || []))
            if (!iframeSourceId) { setTimeout(function () { cb('') }, 0); return rid }
            iframeActive[rid] = { sourceId: iframeSourceId, callback: cb }
            setTimeout(function () {
              var req = iframeActive[rid]
              if (req && req.callback) req.callback(req.sourceId)
              delete iframeActive[rid]
            }, 50)
            return rid
          }
          iframeDcMock.cancelChooseDesktopMedia = function (rid) {
            log('[iframe-' + i + '] cancelChooseDesktopMedia called')
          }

          // iframe 的 getter 拦截
          try {
            Object.defineProperty(w.chrome, 'desktopCapture', {
              configurable: true, enumerable: true,
              get: function () {
                iframeDcReads++
                log('[iframe-' + i + '] chrome.desktopCapture READ (#' + iframeDcReads + ')')
                return iframeDcMock
              }
            })
          } catch (e) { w.chrome.desktopCapture = iframeDcMock }

          try {
            var _ifCdmFn = iframeDcMock.chooseDesktopMedia
            Object.defineProperty(iframeDcMock, 'chooseDesktopMedia', {
              configurable: true, enumerable: true,
              get: function () {
                iframeCdmReads++
                log('[iframe-' + i + '] chooseDesktopMedia READ (#' + iframeCdmReads + ')')
                return _ifCdmFn
              }
            })
          } catch (e) {}

          // iframe 的 toString 伪装：chooseDesktopMedia / cancelChooseDesktopMedia
          try {
            maskNativeToString(_ifCdmFn, 'chooseDesktopMedia')
            maskNativeToString(iframeDcMock.cancelChooseDesktopMedia, 'cancelChooseDesktopMedia')
          } catch (e) {}

          // iframe 的 chrome.runtime.id 伪装（与主窗口一致）
          try {
            var _ifRuntimeIdReads = 0
            if (!w.chrome.runtime.id) {
              Object.defineProperty(w.chrome.runtime, 'id', {
                configurable: false,
                enumerable: true,
                get: function () {
                  _ifRuntimeIdReads++
                  log('[iframe-' + i + '] chrome.runtime.id READ (#' + _ifRuntimeIdReads + ')')
                  return 'mylog-desktop-notifier-screen-capture'
                }
              })
            }
          } catch (e) {}

          // iframe 的 chrome.runtime.getURL 伪装（与主窗口一致）
          try {
            var _ifGetURLReads = 0
            if (typeof w.chrome.runtime.getURL !== 'function') {
              var _ifGetURLFn = function (path) {
                _ifGetURLReads++
                log('[iframe-' + i + '] chrome.runtime.getURL READ (#' + _ifGetURLReads + ') path=' + (path || ''))
                return 'chrome-extension://mylog-desktop-notifier-screen-capture/' + (path || '')
              }
              w.chrome.runtime.getURL = _ifGetURLFn
              maskNativeToString(_ifGetURLFn, 'getURL')
            }
          } catch (e) {}

          var iframeMd = w.navigator && w.navigator.mediaDevices
          var r = wrapMediaDevices(iframeMd, '[iframe-' + i + ']')
          log('iframe shim | index=' + i + ' src=' + (iframes[i].src || '').slice(0, 60) + ' gum=' + r.gum + ' gdm=' + r.gdm)
          injected++
        }
      } catch (e) {
        log('iframe skip | index=' + i + ' (cross-origin or error)')
      }
    }
    return injected
  }

  var iframeCount = injectIntoIframes()
  if (iframeCount > 0) log('iframe injection: ' + iframeCount + ' frame(s) wrapped')

  // ─── 动态 iframe 监控 ───
  if (typeof MutationObserver !== 'undefined') {
    var _iframeObserver = new MutationObserver(function () {
      setTimeout(injectIntoIframes, 200)
    })
    var target = document.body || document.documentElement
    if (target) _iframeObserver.observe(target, { childList: true, subtree: true })
  }
})()
