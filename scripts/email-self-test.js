// scripts/email-self-test.js
// 在 electron 运行时内自测邮件收发（不创建窗口、不依赖 HTTP server、不触发单实例锁）。
// 直接调用 lib/emailClient 与 lib/emailSender，跑完即退出。
// 运行：ELECTRON_RUN_AS_NODE= npx electron scripts/email-self-test.js
const { app } = require('electron')
const path = require('path')
const os = require('os')
// 让本脚本以真实桌面端的应用身份运行，从而使 safeStorage 能解密授权码
app.setName('mylog-desktop-notifier')
try {
  app.setPath('userData', path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'mylog-desktop-notifier'))
} catch (e) { /* ignore */ }
const settingsStore = require('../lib/settingsStore')
const emailCreds = require('../lib/emailCreds')
const emailClient = require('../lib/emailClient')
const emailSender = require('../lib/emailSender')

const L = (...a) => console.log('[SELFTEST]', ...a)
const ONE_MONTH = 30 * 24 * 3600 * 1000

function findFolder(mailboxes, kind) {
  const lower = (s) => (s || '').toLowerCase()
  if (kind === 'inbox') {
    const m = mailboxes.find((x) => /inbox/i.test(x.specialUse || '') || lower(x.path) === 'inbox')
    return m ? m.path : 'INBOX'
  }
  const m = mailboxes.find(
    (x) =>
      /sent/i.test(x.specialUse || '') ||
      /sent|已发送|发件/.test(lower(x.name)) ||
      /sent/i.test(lower(x.path)),
  )
  return m ? m.path : 'Sent'
}

function step(name, obj) {
  L(name, JSON.stringify(obj))
}

function finish(code) {
  setTimeout(() => app.quit(code || 0), 200)
}

function errInfo(err) {
  return { error: err && err.message, code: err && err.code, resp: err && err.responseText }
}

app.whenReady().then(async () => {
  try {
    const s = settingsStore.get()
    const e = (s && s.email) || {}
    const cfg = Object.assign({}, e)
    const auth = emailCreds.loadAuthCode()
    cfg.authCode = auth
    step('config', {
      configured: !!e.configured,
      email: e.email,
      authLoaded: !!auth,
      imapHost: e.imapHost,
      imapPort: e.imapPort,
      smtpHost: e.smtpHost,
      smtpPort: e.smtpPort,
      userData: app.getPath('userData'),
    })

    if (!e.configured || !auth) {
      step('abort', { reason: '邮箱未配置或授权码解密失败' })
      return finish(1)
    }

    let mbs = []
    try {
      mbs = await emailClient.listMailboxes(cfg, auth)
      step('mailboxes', {
        count: mbs.length,
        list: mbs.map((m) => ({ path: m.path, name: m.name, special: m.specialUse })),
      })
    } catch (err) {
      step('mailboxes', errInfo(err))
    }

    const inboxPath = findFolder(mbs, 'inbox')
    const sentPath = findFolder(mbs, 'sent')

    try {
      const since = new Date(Date.now() - ONE_MONTH)
      const msgs = await emailClient.fetchMessages(cfg, auth, inboxPath, 200, since)
      step('inbox_1m', {
        folder: inboxPath,
        count: msgs.length,
        sample: msgs.slice(0, 3).map((m) => ({ from: m.from, subject: m.subject, date: m.date })),
      })
    } catch (err) {
      step('inbox_1m', { folder: inboxPath, ...errInfo(err) })
    }

    try {
      const since = new Date(Date.now() - ONE_MONTH)
      const msgs = await emailClient.fetchMessages(cfg, auth, sentPath, 200, since)
      step('sent_1m', {
        folder: sentPath,
        count: msgs.length,
        sample: msgs.slice(0, 3).map((m) => ({ to: m.to, subject: m.subject, date: m.date })),
      })
    } catch (err) {
      step('sent_1m', { folder: sentPath, ...errInfo(err) })
    }

    try {
      const all = await emailClient.fetchMessages(cfg, auth, inboxPath, 500)
      const toZhouIn = all.filter(
        (m) =>
          m.from &&
          ((m.from.name || '').includes('周维') || /zhou\s*wei|zhouw/i.test(m.from.address || '')),
      )
      let toZhouSent = []
      try {
        const sent = await emailClient.fetchMessages(cfg, auth, sentPath, 500)
        toZhouSent = sent.filter((m) =>
          (m.to || []).some(
            (t) => (t.name || '').includes('周维') || /zhou\s*wei|zhouw/i.test(t.address || ''),
          ),
        )
      } catch (e2) {
        /* ignore sent scan error */
      }
      step('zhouwei', {
        inboxCount: toZhouIn.length,
        sentCount: toZhouSent.length,
        inboxSample: toZhouIn.slice(0, 5).map((m) => ({ from: m.from.address, subject: m.subject, date: m.date })),
        sentSample: toZhouSent
          .slice(0, 5)
          .map((m) => ({ to: m.to.map((t) => t.address), subject: m.subject, date: m.date })),
      })
    } catch (err) {
      step('zhouwei', errInfo(err))
    }

    for (const target of ['554163483@qq.com', e.email]) {
      try {
        const info = await emailSender.sendMail(cfg, auth, {
          to: target,
          subject: '[e日志Skill自测] 发送测试 ' + new Date().toISOString(),
          text: '本邮件由 e日志 skill 邮件自测脚本自动发出，请忽略。若您收到，说明 SMTP 发送链路正常。',
        })
        step('send_' + target, {
          ok: true,
          messageId: info.messageId,
          accepted: info.accepted,
          response: info.response,
        })
      } catch (err) {
        step('send_' + target, { ok: false, ...errInfo(err) })
      }
    }

    finish(0)
  } catch (e2) {
    step('unexpected', { error: e2 && e2.message })
    finish(1)
  }
})
