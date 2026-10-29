// 下载中心渲染回归：打桩 DOM，验证 Tab 计数 / 类型图标 / 状态文案 / 操作按钮
// 运行：node scripts/verify-downloads-ui.js
;(function () {
  const fs = require('fs')
  const path = require('path')
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'downloads-window.html'), 'utf8')
  const code = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1]
  if (!code) { console.error('FAIL | 未找到渲染脚本'); process.exit(1) }

  function makeEl() {
    return {
      innerHTML: '', textContent: '', title: '', className: '', disabled: false,
      _handlers: {},
      addEventListener(ev, fn) { this._handlers[ev] = fn },
    }
  }
  const els = {}
  const ids = ['dl-list', 'dl-tabs', 'dl-count', 'dl-who', 'btn-clear', 'btn-close', 'dl-toast', 'dl-path-val', 'btn-path']
  ids.forEach((id) => { els[id] = makeEl() })

  const now = Date.now()
  const sample = [
    { id: 'dl-1', filename: 'agents.zip', state: 'progressing', receivedBytes: 700, totalBytes: 1024 },
    { id: 'dl-2', filename: 'e日志敏捷开发管理.html', state: 'completed', receivedBytes: 176742, totalBytes: 176742, startedAt: now },
    { id: 'dl-3', filename: 'mylog-log_prod_NCIHQ0fZIXLg', state: 'interrupted', receivedBytes: 5351, totalBytes: 23068685 },
    { id: 'dl-4', filename: '旧记录无时间.txt', state: 'completed', receivedBytes: 100, totalBytes: 100 },
    { id: 'dl-5', filename: 'cancelled.bin', state: 'cancelled', receivedBytes: 10, totalBytes: 0 },
    // blob 下载（页面内存 Blob 导出）：字节不上报，必须走「保存中…」流动条而不是 0%
    { id: 'dl-6', filename: 'export.zip', state: 'progressing', receivedBytes: 0, totalBytes: 83886080, url: 'blob:https://data.tygps.com/abc' },
  ]
  const window = { electronAPI: { downloadsList: () => Promise.resolve(sample) } }
  const document = { getElementById: (id) => els[id] || null }

  new Function('window', 'document', code)(window, document)

  setTimeout(() => {
    const list = els['dl-list'].innerHTML
    const tabs = els['dl-tabs'].innerHTML
    const errs = []
    function ok(cond, msg) { if (!cond) errs.push(msg) }

    ok(tabs.includes('全部') && tabs.includes('data-tab="all"'), 'Tab: 缺「全部」')
    ok(/进行中<span class="n">2</.test(tabs), 'Tab: 进行中计数应=2')
    ok(/已完成<span class="n">2</.test(tabs), 'Tab: 已完成计数应=2')
    ok(/失败<span class="n">2</.test(tabs), 'Tab: 失败计数应=2（interrupted+cancelled）')

    ok(list.includes('t-amber'), '类型图标: zip 应为琥珀色')
    ok(list.includes('HTML'), '类型图标: 应显示 HTML 徽标')
    ok(list.includes('>TXT<'), '类型图标: 无扩展名以外的 txt 应显示 TXT')
    ok(list.includes('>FILE<'), '类型图标: 无扩展名应显示 FILE')

    ok(list.includes('<i style="width:68%"'), '下载中: 进度条 68%')
    ok((list.match(/class="pbar"/g) || []).length === 1, '下载中: 普通进度条应只有一条（blob 走流动条）')
    ok(list.includes('pbar indet'), 'blob 下载: 应使用流动条')
    ok(list.includes('保存中…'), 'blob 下载: 应显示「保存中…」而非 0%')
    ok(list.includes('重试'), '失败: 应有重试胶囊')
    ok(list.includes('重新下载'), '已取消: 应有重新下载胶囊')
    ok(list.includes('今天'), '完成: startedAt 应渲染为「今天 HH:mm」')
    ok(!list.includes('undefined'), '不应出现 undefined 文案')

    ok(els['dl-count'].textContent.includes('共 6 个任务') && els['dl-count'].textContent.includes('2 个进行中'), '标题计数')

    if (errs.length) { errs.forEach((e) => console.error('FAIL | ' + e)); process.exit(1) }
    console.log('PASS | 下载中心渲染回归 ' + [
      'Tab 计数 6/2/2/2', '类型图标着色', '普通进度条唯一', 'blob「保存中…」流动条',
      '重试/重新下载胶囊', '今天时间渲染', '无 undefined',
    ].join(' · '))
  }, 20)
})()
