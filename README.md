# MyLog 桌面通知代理 (方案A 轻量版)

基于 Electron 的系统级通知代理，解决 Web 端通知三大痛点。

## 解决的问题

| 痛点 | Web 端限制 | 本方案 |
|------|----------|--------|
| 铃声受限 | AutoPlay Policy 禁止自动播放 | 系统音频 API，原生播放 |
| 弹窗不可见 | 最小化/被遮挡后看不到 | 系统级 `alwaysOnTop` 窗口 |
| 通知无交互 | 无接听/挂断按钮 | 屏幕中央来电弹窗 + 右下角消息提醒 |

## 项目结构

```
desktop-notifier/
├── main.js                  # Electron 主进程（WS 服务器 + 弹窗管理）
├── package.json
├── src/
│   ├── preload.js           # 安全桥接（IPC）
│   ├── call-window.html     # 来电弹窗 UI（屏幕中央）
│   └── toast-window.html    # 消息提醒 UI（右下角）
└── assets/
    └── icon.png             # 托盘图标（需自行放置）
```

## 启动与部署

```bash
# 1. 安装依赖
cd desktop-notifier
npm install

# 2. 开发运行（需要先安装 Electron）
npm run dev

# 3. 打包为安装程序 (.exe)
npm run dist
```

## 通信协议

- **端口**：`18999`（仅监听 `127.0.0.1`，无网络安全风险）
- **协议**：WebSocket
- **消息格式**：JSON `{ type, payload, timestamp }`

### 浏览器 → 桌面端

| type | 用途 |
|------|------|
| `SHOW_CALL_NOTIFICATION` | 弹出来电/会议通知 |
| `SHOW_MESSAGE_NOTIFICATION` | 弹出右下角消息提醒 |
| `CALL_CONNECTED` | 通话已建立，关闭弹窗 |
| `CALL_ENDED` | 通话已结束 |
| `PING` | 心跳（30s） |

### 桌面端 → 浏览器

| type | 用途 |
|------|------|
| `CONNECTED` | 连接确认 |
| `USER_ACTION` | 用户操作（accept/reject/ignore/timeout）|
| `PONG` | 心跳响应 |

## 注意事项

1. **不安装桌面代理时自动降级**：浏览器内弹窗 + 系统通知保持原有行为
2. **端口互斥**：多实例保护，第二个实例启动时会自动退出
3. **铃声文件**：需在 `assets/ringtone.wav` 放置音频文件
4. **托盘图标**：需在 `assets/icon.png` 放置图标（建议 16x16 / 32x32）
