// lib/emailSender.js
// 发信引擎：基于 nodemailer 连接阿里企业邮箱 SMTP，发送邮件。
// 与 emailClient.js（IMAP 收信）分离，职责单一。
// 凭据复用 getEmailConfig() 返回的 { email, smtpHost, smtpPort, smtpSecure, authCode }。

const nodemailer = require('nodemailer')

// 构造 SMTP transport（secure 视端口而定：465 → true，587/25 → false 走 STARTTLS）
function makeTransport(config, authCode) {
  return nodemailer.createTransport({
    host: config.smtpHost || 'smtp.qiye.aliyun.com',
    port: Number(config.smtpPort) || 465,
    secure: config.smtpSecure !== false,
    auth: { user: config.email, pass: authCode },
  })
}

// opts: { to, subject, text, html?, from? }
// 返回 { messageId, accepted, rejected, response }
async function sendMail(config, authCode, opts) {
  if (!opts || !opts.to) throw new Error('缺少收件人 to')
  if (!opts.subject) throw new Error('缺少主题 subject')
  const t = makeTransport(config, authCode)
  const info = await t.sendMail({
    from: opts.from || config.email,
    to: opts.to,
    subject: opts.subject,
    text: opts.text || '',
    html: opts.html || '',
  })
  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  }
}

module.exports = { sendMail, makeTransport }
