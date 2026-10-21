// src/email-bridge-preload.js
// 邮箱窗口专用 mini preload：只暴露一个「保存邮箱凭据」通道。
// 注意：与主页面 preload（屏幕共享/标题栏等）完全无关，邮箱窗口不加载那个。
// 注入层（SnappyMail Index.html）在用户登录成功后调用 saveCredentials，
// 主进程用 safeStorage 加密保存授权码并热重启后台同步（email:config-save 已内置）。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ebMailBridge', {
  saveCredentials: (cfg) => {
    try { return ipcRenderer.invoke('email:config-save', cfg) } catch (e) { return Promise.resolve({ ok: false, error: e.message }) }
  },
})
