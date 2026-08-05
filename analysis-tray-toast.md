# 托盘闪烁 & 消息弹窗不显示 —— 成因分析（未改代码）

> 分析对象：`main.js` + `lib/notificationCenter.js`
> 结论：两个问题的根因都可精确定位到具体代码路径。下面的修复方向仅供参考，本次按需求**只做分析、未改任何代码**。

---

## 问题 1：托盘图标闪烁，已无未读消息却仍闪

### 闪烁的判定链路
- 闪烁 = `trayIconState === 'unread'`，而 `'unread'` 完全由 `unreadCount > 0` 决定
  - `deriveTrayState()`：`if (unreadCount > 0) return 'unread'`（main.js 271）
  - `updateUnreadCount()`：`if (unreadCount > 0) setTrayState('unread')`（main.js 542）
- 即：**只要 `unreadCount > 0`，托盘就闪；归零才停**。

### `unreadCount` 有两条写入通道，终点都是 `updateUnreadCount`
1. **A 路（网页端权威值）**：`UPDATE_UNREAD_COUNT` → `updateUnreadCount(payload.count)`（main.js 1264）
2. **B 路（桌面端自增）**：通知中心收到消息 `pushMessage`（main.js 1246）→ 累加 `unreadMap` → `onUnreadChange(totalUnread())`
   - 而 `onUnreadChange` 在 main.js 989 被绑定为 `updateUnreadCount`
   - 所以 B 路：`pushMessage` 自增后，经 `onUnreadChange` 把 `unreadCount` 顶成 `>0` → 闪烁

### 用户场景「打开聊天框 + 对方发消息」的事件流
1. 网页端 IM 因聊天框在前台，新消息通常被视作「已读/实时」，**不一定下发 `UPDATE_UNREAD_COUNT(0)` 或 `MARK_READ`**。
2. 但桌面端仍会收到 `SHOW_MESSAGE_NOTIFICATION` → `pushMessage`：
   - `pushMessage` 在 payload 未带权威 `unreadCount` 时，走 `existing.count + 1` 的自增逻辑（notificationCenter.js 72-76、90）
   - 自增后经 B 路把 `unreadCount` 顶成 `>0` → **开始闪烁**
3. 由于 A 路的「归零信号」在「前台开着聊天框收消息」场景下**不保证下发**（网页端视角：用户在看，无需再提示），主进程的 `unreadCount` 就**卡在 >0**，托盘一直闪——即使网页端「明明没有未读」。

### 根因
**桌面端未读计数与网页端 IM SDK 的「已读状态」脱节**：
- 桌面端：以「是否收到 `SHOW_MESSAGE_NOTIFICATION`」作为未读增量依据（`pushMessage` 自增）；
- 网页端：以「会话是否打开/已读」作为未读依据。

两者在「聊天框打开中对方发消息」这个场景不一致；且 B 路 `pushMessage` 的自增会**覆盖**此前任何 A 路的归零结果——只要之后没有新的 `UPDATE_UNREAD_COUNT` 把 `unreadCount` 拉回 0，闪烁就停不下来。

> 注：即使 A 路补发了归零，`SHOW_MESSAGE_NOTIFICATION` 与 `UPDATE_UNREAD_COUNT` 的**到达顺序**也不受控。若消息事件后到，会把刚归零的值又顶上去，后续无新归零即持续闪。

---

## 问题 2：通话窗口正常显示，消息通知弹窗不显示但能听到铃声

### 两类窗口的差异
| | 通话/会议窗口 | 消息通知弹窗 |
|---|---|---|
| 实现 | 独立 `BrowserWindow`，`showCallWindow/showMeetingWindow` 创建即 `show` | 通知中心**单一常驻窗口**，`preCreate` 启动时创建一次，之后只 `show/hide` 复用 |
| `focusable` | 默认 `true`（makePopupWindowOpts 未设） | **`false`**（notificationCenter.js 33） |
| `alwaysOnTop` | `true` | `true` |
| 显示机制 | 新建即显示 | `showWindow()` → `win.show()` |

### 消息到达时的执行路径（`pushMessage`，notificationCenter.js 105-109）
```
const blocked = st.notifyMode === 'dnd' || st.notifyMode === 'blockChat'
if (!blocked) {
  ringtoneResolver.resolve('message', ...)   // 解析铃声文件
  showWindow()                                // 显示窗口
  send('nc-play', { path: rp })              // 渲染进程播放铃声
}
```
- 「能听到铃声」⇒ `!blocked` 分支**确实执行了** ⇒ `showWindow()` 被调用了 ⇒ `win` 存在且 `webContents` 活着（否则 `send` 会跳过、铃声不会响）。
- **结论：窗口本体确实被 `show()` 了，但它不可见。**

### 最可能成因：通知中心窗口 `focusable: false` + `alwaysOnTop: true` 的 Windows 组合坑
在 Windows（尤其 Win10/11 + 多屏/DPI 场景）上，`focusable: false` 且 `alwaysOnTop: true` 的 `BrowserWindow` 在 `show()` 后常出现**不进入 DWM 绘制 / 不真正置顶 / 实际不可见**的已知问题。
- 通话窗口 `focusable` 默认 `true`，不受此影响 → **正常显示**；
- 消息通知弹窗 `focusable: false` → **不显示**，但渲染进程的 `nc-play` 音频通道与窗口是否可见无关 → **能听到铃声**。

这恰好吻合用户描述的三要素：**通话窗正常（focusable=true）+ 消息弹窗不显示（focusable=false）+ 能听到铃声（音频走 webContents，不依赖窗口绘制）**。

### 需排查的次要成因（可一并验证）
- **坐标算到屏外**：`showWindow` 用 `getWindowRect(W, H)` 算右下角（notificationCenter.js 116）。多屏/DPI 异常时可能落在可见区外，但通常偶发，不是「稳定永不显示」。
- **竞态 hide**：`syncUnread`/`markRead` 在 `unreadMap` 为空时可能 `win.hide()`（notificationCenter.js 211、148）。但 `pushMessage` 同步执行完 `showWindow` 才返回，且消息刚到时 `unreadMap` 非空，不会被此处 hide。

---

## 修复方向（仅供参考，本次未改代码）

### 问题 1（托盘闪烁）
- **让未读计数单一以网页端权威值为准**：`unreadCount` 只由 `UPDATE_UNREAD_COUNT` / `SYNC_UNREAD` 写入，`pushMessage` 不再自增 `unreadCount`（只负责弹窗内容渲染）。
- 或：在「聊天框打开中收消息」场景，由网页端保证下发 `MARK_READ` / `UPDATE_UNREAD_COUNT(0)`，使桌面端计数与网页端一致。
- 当前症结代码：`notificationCenter.js` 72-76（`existing.count = authoritative ? payload.unreadCount : existing.count + 1`）+ `onUnreadChange: updateUnreadCount`（main.js 989）。

### 问题 2（消息弹窗不显示）
- 主要验证项：把通知中心窗口的 `focusable: false` 改为 `true`（notificationCenter.js 33），观察消息弹窗是否恢复显示。
- 若业务上确实需要「点击穿透/不抢焦点」，可改用 `showInactive()` 或调整 `alwaysOnTop` 策略 + 多屏回归测试，而非简单 `focusable: false`。
- 顺带验证 `getWindowRect` 在多屏/DPI 下的坐标是否落在可见区。
