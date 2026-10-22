// lib/emailCreds.js
// 用 Electron safeStorage 加密保存阿里企业邮箱「客户端授权码」，绝不落明文。
// 服务器地址/邮箱账号本身是公开配置，明文存在 settings.json；唯独授权码走 OS 钥匙串级加密。

const fs = require('fs')
const path = require('path')
const { app, safeStorage } = require('electron')

const CREDS_PATH = () => path.join(app.getPath('userData'), 'emailCreds.json')

function available() {
  try { return !!safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable() }
  catch (e) { return false }
}

// code: 明文授权码字符串
function saveAuthCode(code) {
  if (!available()) throw new Error('当前系统不支持凭据加密（safeStorage 不可用）')
  const enc = safeStorage.encryptString(String(code))
  const b64 = enc.toString('base64')
  fs.writeFileSync(CREDS_PATH(), JSON.stringify({ enc: b64 }))
}

function loadAuthCode() {
  try {
    const p = CREDS_PATH()
    if (!fs.existsSync(p)) return null
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (!data || !data.enc) return null
    const buf = Buffer.from(data.enc, 'base64')
    return safeStorage.decryptString(buf)
  } catch (e) {
    console.error('[EmailCreds] load failed:', e && e.message)
    return null
  }
}

function clearAuthCode() {
  try { const p = CREDS_PATH(); if (fs.existsSync(p)) fs.unlinkSync(p) } catch (e) {}
}

module.exports = { available, saveAuthCode, loadAuthCode, clearAuthCode }
