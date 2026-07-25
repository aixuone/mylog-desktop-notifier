# 桌面通知助手 · 缺陷修复概述

修复了 `mylog-pc/desktop-notifier`（Electron 通知助手）的两个问题。

## 问题 1：用户上传的铃声不响

**根因**：`lib/ringtoneResolver.js → toFile()` 中，`userDataDir` 已经是
`…/userData/ringtones` 目录，而用户铃声的 rel 形如 `ringtones/<hash>.<ext>`，
两者直接拼接得到 `…/ringtones/ringtones/<hash>.<ext` —— 文件实际只存在于
`…/ringtones/<hash>.<ext`，路径多了一层 `ringtones/`，导致音频文件找不到、播放无声。
内置 `assets/…` 铃声因路径不同而不受影响，所以表现为"只有上传的不响"。

**修复**：rel 以 `ringtones/` 开头时，先去掉前缀再与 `userDataDir` 拼接。
修改点：`lib/ringtoneResolver.js`（仅此一处，所有铃声解析统一走 `toFile`，
因此通话/会议/消息/被踢等场景的上传铃声一并修复）。

**验证**：node 模拟确认解析为 `…/ringtones/<hash>.<ext`，与 `pick-ringtone`
落盘位置一致。

## 问题 2：离线 / 被踢提醒需与聊天消息区分且常驻不自动关闭

**根因**：
- 离线/被踢提醒虽在通知中心独立"系统通知"分区渲染，但窗口右上角 ✕（`nc-close`）
  在有常驻系统通知时仍会收起窗口，表现为"自动关闭、下条消息又弹回"。
- `kick`（被踢下线）提醒在收到 `NET_ONLINE`（重连上线）时不会被消除，只有 `offline` 会被消除。

**修复**：
1. `lib/notificationCenter.js`：`nc-close` 在 `hasStickyAlert()` 时直接 return，
   不再收起窗口（常驻提醒不会被误关）。
2. `src/notification-center.html`：
   - ✕ 按钮在 `sysAlerts` 非空时 no-op；
   - 离线/被踢卡片增加 `🔒 常驻提醒：…后才会消失` 提示，强化与聊天消息的区分。
3. `main.js`：`NET_ONLINE` 时同时 `dismissSysAlert('kick')`（原仅 `offline`），
   满足"直到重连上线或用户手动点关闭"。

行为确认：常驻提醒存在期间，空闲计时器(`resetIdle`)、全部已读(`markRead`)、
未读同步(`syncUnread`) 均不会隐藏窗口；仅当用户点卡片内"关闭/知道了/重新登录"
或重连上线时，对应提醒才消失。

## 修改文件清单
- `lib/ringtoneResolver.js` — 上传铃声路径修正
- `lib/notificationCenter.js` — `nc-close` 常驻保护
- `main.js` — `NET_ONLINE` 消除 `kick` 常驻提醒
- `src/notification-center.html` — ✕ 常驻保护 + 常驻提示文案

## 验证状态
- `node --check` 三个 JS 文件均通过；`toFile` 路径模拟正确。
- 尚未做完整 Electron GUI 运行验证（需图形环境），逻辑已静态确认。
