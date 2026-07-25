// MyLog 桌面通知助手 - 配置文件
// 所有配置项均支持修改，修改后需重启应用生效
// 读取项目根目录package.json
const pkg = require('./package.json');
module.exports = {
  version: pkg.version, 
  // WebSocket 服务端口（起始端口），用于与浏览器扩展通信
  wsPort: 18999,

  // 图标配置（.ico/.png 格式，支持多状态切换 + 闪烁）
  icons: {
    default: 'assets/icon.png',          // 正常状态（已连接）
    gray:    'assets/icon-gray.ico',      // 灰色状态（未连接/离线/被踢）
    ringing: 'assets/icon.png',           // 响铃中（与 gray 交替闪烁）
    unread:  'assets/icon.png'            // 未读消息（与透明图标交替闪烁）
  },

  // 铃声配置
  ringtone: {
    path: 'assets/ringtone.m4a',     // 默认铃声文件路径（兜底）
    loop: true,                      // 是否循环播放
    volume: 1,                     // 音量（0-1）
    startTime: 0,                    // 开始播放位置（秒，0表示从头开始）
    timeout: 62000                   // 呼叫超时时间（毫秒），必须与 timeout.call 一致
  },

  // 内置铃声预设（随包，被 asarUnpack 解包）。
  // - default：系统默认（通话/会议场景回退到 ringtone.m4a）
  // - message：消息通知可选铃声集合
  // - builtin：全部内置铃声，供所有场景的铃声选择器展示
  ringtonePresets: {
    default:   'assets/ringtone.m4a',
    call_audio:[ 'assets/ringtone.m4a' ],
    call_video:[ 'assets/ringtone.m4a' ],
    meeting:   [ 'assets/ringtone.m4a' ],
    message:   [ 'assets/ringtones/default.mp3', 'assets/ringtones/msg1.mp3', 'assets/ringtones/msg2.mp3', 'assets/ringtones/msg3.mp3', 'assets/ringtones/msg4.mp3' ],
    builtin:   [ 'assets/ringtones/default.mp3', 'assets/ringtones/msg1.mp3', 'assets/ringtones/msg2.mp3', 'assets/ringtones/msg3.mp3', 'assets/ringtones/msg4.mp3' ],
  },
  // 候选项展示名（与文件解耦，便于改名）
  ringtoneNames: {
    'assets/ringtone.m4a': '经典铃声',
    'assets/ringtones/default.mp3': '默认',
    'assets/ringtones/msg1.mp3': '消息 1',
    'assets/ringtones/msg2.mp3': '消息 2',
    'assets/ringtones/msg3.mp3': '消息 3',
    'assets/ringtones/msg4.mp3': '消息 4',
  },

  // 通知中心窗口（右下角常驻预加载）
  notificationCenter: {
    width: 360,
    height: 520,
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
    call: 62000,  // 通话/会议邀请超时自动关闭（60秒）
    toast: 4000   // 消息 Toast 自动关闭（4秒）
  },

  // 去重配置（防止重复通知，单位：毫秒）
  deduplication: {
    callWindowMs: 3000,   // 通话/会议通知去重窗口（5秒内相同ID只显示一次）
    toastWindowMs: 3000   // 消息通知去重窗口（3秒内相同内容只显示一次）
  },

  // HTTP 握手服务配置
  handshake: {
    maxAttempts: 50        // 端口冲突时最大重试次数
  }
}
