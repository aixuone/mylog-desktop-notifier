// preload.js - 预加载脚本（安全桥接）
// 弹窗页面通过此文件安全地与主进程通信

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 用户点击接听/挂断/忽略
  sendCallAction: (action) => ipcRenderer.send('call-action', action),

  // 关闭消息提醒弹窗
  closeToast: () => ipcRenderer.send('close-toast'),

  // 监听弹窗数据
  onCallData: (callback) => ipcRenderer.on('call-data', (_, data) => callback(data)),

  // 监听消息提醒数据
  onToastData: (callback) => ipcRenderer.on('toast-data', (_, data) => callback(data)),

  // 打开浏览器（协议唤起）
  openBrowser: (url) => ipcRenderer.send('open-browser', url),
})
