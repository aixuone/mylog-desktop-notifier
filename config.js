// MyLog 桌面通知助手 - 配置文件
// 所有配置项均支持修改，修改后需重启应用生效

module.exports = {
  // WebSocket 服务端口（起始端口），用于与浏览器扩展通信
  wsPort: 18999,

  // 图标配置
  icons: {
    default: 'assets/icon.png',      // 默认托盘图标（用户未登录时使用）
    incoming: 'assets/icon-call.png', // 来电中状态图标
    unread: 'assets/icon-unread.png'  // 有未读消息状态图标
  },

  // 铃声配置
  ringtone: {
    path: 'assets/ringtone.m4a',     // 铃声文件路径
    loop: true,                      // 是否循环播放
    volume: 0.7,                     // 音量（0-1）
    startTime: 0                     // 开始播放位置（秒，0表示从头开始）
  },

  // 通话窗口配置（屏幕居中显示）
  callWindow: {
    width: 380,   // 窗口宽度（像素）
    height: 280   // 窗口高度（像素）
  },

  // 会议邀请窗口配置（屏幕居中显示）
  meetingWindow: {
    width: 380,   // 窗口宽度（像素）
    height: 320   // 窗口高度（像素）
  },

  // Toast 消息窗口配置（右下角弹出）
  toastWindow: {
    width: 340,   // 窗口宽度（像素）
    height: 100,  // 窗口高度（像素）
    margin: 20    // 与屏幕边缘的距离（像素）
  },

  // 超时配置（单位：毫秒）
  timeout: {
    call: 45000,  // 通话/会议邀请超时自动关闭（45秒）
    toast: 8000   // 消息 Toast 自动关闭（8秒）
  },

  // 去重配置（防止重复通知，单位：毫秒）
  deduplication: {
    callWindowMs: 5000,   // 通话/会议通知去重窗口（5秒内相同ID只显示一次）
    toastWindowMs: 3000   // 消息通知去重窗口（3秒内相同内容只显示一次）
  },

  // HTTP 握手服务配置
  handshake: {
    maxAttempts: 50        // 端口冲突时最大重试次数
  }
}
