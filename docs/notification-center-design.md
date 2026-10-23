# 消息提醒（通知中心）技术设计 · v2

> 产品需求与全量场景清单见 **`docs/notification-center-prd.md`**（S1.x ~ S5.x）。
> 本文只讲实现：不变量、状态机、IPC 协议、以及 v1 的缺陷是如何被架构性消除的。
>
> 涉及文件：
> - `lib/notificationCenter.js` —— 状态与决策（主进程）
> - `src/notification-center.html` —— 渲染（单一快照驱动，键控增量更新）
> - `src/preload.js` —— 桥（`onNcState` / `onNcMeasure` 为 v2 新增）
> - 网页端 `web/src/components/layout.vue` / `utils/desktop-notifier.ts` —— 事件来源（契约未变）

---

## 一、v1 为什么修不好

v1（批次集合版）的展示集合 `batchIds` 被 **三个来源**同时写：

| 来源 | 能做什么 |
| --- | --- |
| `SHOW_MESSAGE_NOTIFICATION` → `pushMessage` | 加行 + `showWindow()` |
| `SYNC_UNREAD` → `syncUnread` | 加行、删行、`showWindow()`、`dismissWindow()` |
| `MARK_READ` / 点击 | 删行、`dismissWindow()` |

网页端对**同一条新消息**会同时下发前两条（`syncDesktopUnread()` 与 `showMessage()` 相邻调用）。
两者交错时,"刚弹出来的窗口被另一条通道清掉再弹"就成为必然 —— 这不是时序 bug 能靠 `setTimeout` 调出来的，
是**多写入者模型**的必然结果。同理,"窗口高度先 1 行后 2 行"来源于主进程需要**猜**高度。

## 二、v2 的四个不变量

| 编号 | 不变量 | 落地方式 |
| --- | --- | --- |
| **I1** | 窗口"出现"的**主**入口是 `pushMessage` / `pushSysAlert`；`SYNC_UNREAD` 只在**未读增长**时兜底开窗（D13），其余情况只校正内容 | `syncUnread()` 里唯一能走到 `present()` 的是 `notifyFromSync()`，触发条件为 `c > 上次同步值` 且已过基线；双通道同到时会因 `added=false && ringed 已含` 直接跳过 |
| **I2** | 窗口一旦可见，只 `setBounds()`，绝不 `hide()`，直到超时/用户操作 | `present()` 首行 `if (isVisible()) { pushState(); resetHideTimer(); return }` |
| **I3** | 栈内只增不减（除已读/归零）；同会话更新不移动行位置 | `addToStack()` 只在 `indexOf < 0` 时 `unshift` |
| **I4** | 窗口高度以渲染进程实测为准 | `nc-measure` 请求 → `nc-resize` 回传 → `actuallyShow()` |

> 由此产生一个副产品：**「收起后 1.2s 冷却」不再需要**。旧版需要冷却来挡"收起动作自身触发的 SYNC 把窗口弹回来"，
> 而 v2 里 SYNC 只在**未读增长**时才开窗——收起动作本身不会让未读数变大。

> **I1 的修订（D13，2026-10-22）**：最初 I1 是绝对的（SYNC 完全无权开窗）。
> 实测发现网页端 v6 SDK 的增量判断用 `deep watch` 的 `oldValue`，新旧值同引用 → 恒为 false
> → `SHOW_MESSAGE_NOTIFICATION` 一次都不发 → 桌面端彻底静音。
> 绝对 I1 把可用性押在网页端单个判断上，风险过高，故保留一条条件极窄的兜底（见 PRD §2.4）。
> 兜底只「加」不「减」，不会重现「弹出→被清→再弹」。

**I5（多客户端消歧）**：桌面主窗口（UA 含 `MylogDesktop`）在线时，`SHOW_MESSAGE_NOTIFICATION` 与
`SYNC_UNREAD` **只采信应用窗口客户端**，外部浏览器标签页发来的这两类事件被忽略（`main.js: isMirrorClient`）。
否则同一账号在两个客户端各自维护 `unreadCount` 并全量下发，弹窗里的未读数会在 `3 / 1 / 3 / 1` 之间跳 ——
这是"数字闪动"的独立来源，与窗口动画无关。用户主动行为（`MARK_READ`）仍全客户端生效。

## 三、状态机

```
        pushMessage(允许展示) / pushSysAlert / showWindow()
   idle ────────────────────────────────▶ arming ─(150ms 首屏合并)─▶ doShow()
     ▲                                       │                         │
     │                                       │ 全部已读/超时            │ nc-measure → nc-resize
     │                                       ▼                         ▼
     └────────── 超时 / ✕ / 点完最后一条 / 全部已读 ◀──────────────  shown
```

- `arming` 期间到达的会话**只更新内容**，不重置 150ms 计时器（防"源源不断到达导致永不显示"，S3.12）。
- `shown` 期间到达的任何消息 → `resetHideTimer()`，时长从**最新一条**重新计（S3.5）。
- 关闭唯一出口 `closeStack(reason, forceHide)`：清定时器、清栈、`hide()`、推空快照。

## 四、高度协议（消除"先一条后两条"）

```
主进程 doShow():  applyHeight(lastHeight || MIN_H)   // 先给个不错的高度，避免默认尺寸闪
                  pendingShow = true
                  send('nc-measure')                 // 要一次真实高度
渲染层:           measure(true) → resizeNc(h)        // 强制回传，不受 lastSentH 去重影响
主进程 nc-resize: applyHeight(h); actuallyShow()     // 尺寸已定 → 立刻 show
兜底:             200ms 未回传 → 用当前高度 show（保证极端情况可用）
```

`getNcRect(w, h)` 按**底边 20px 边距**计算 y，因此高度增大时 y 减小 —— 视觉上「底边固定、向上生长」（S3.2）。

## 五、IPC 协议

**主 → 渲染**

| 通道 | 载荷 | 说明 |
| --- | --- | --- |
| `nc-state` | `{ settings, unread[], sysAlerts[], focusId, canClose, phase }` | **全量快照，唯一数据源**。`unread` 已按展示顺序排好，渲染层不排序 |
| `nc-measure` | — | 要求立即回传真实高度 |
| `nc-show` | — | 仅"隐藏→可见"时发，触发整窗入场动画 |
| `nc-play` | `{ path }` | 播放铃声 |

旧通道 `nc-init` / `nc-unread` / `nc-sysalert` / `nc-sysalert-dismiss` / `nc-settings-changed`
在 preload 中保留（兼容），渲染层已不再监听。

**渲染 → 主**

| 通道 | 载荷 | 说明 |
| --- | --- | --- |
| `nc-resize` | `h` | 实测内容高度（clamp 132~520） |
| `nc-open-conversation` | `{ conversationId, url }` | 点击某行 |
| `nc-mark-read` | `id \| 'all'` | 已读 |
| `nc-dismiss-sysalert` | `id` | 消隐系统卡 |
| `nc-close` | `force` | ✕（渲染层恒传 `true`） |

## 六、渲染层关键约束

1. **不排序**：`unread` 顺序即展示顺序。排序会让整列跳动 —— 用户感知就是"闪"（PRD 2.2）。
2. **键控复用**：`rowMap[cid] = { el, parts, avatar }`；签名相同则**一个字节都不写**（有断言守着，
   见 `R5 重复推送零 DOM 写入`）。
3. **差分写入**：所有 `textContent` / `style.display` / `classList` 都先比较再写。`badgeEl.textContent`
   曾经无条件赋值，导致每次推送都产生 3 次 DOM 变更 —— 这是"看不见但真实存在"的抖动源。
4. **头像先解码再显示**：`img.onload` 后才加 `.has-img`，避免"白块 → 头像"闪一下（S1.9）。
5. **行级动画只作用于新行**（`.is-new`），整窗动画只由 `nc-show` 触发（S1.5）。

## 七、v1 缺陷账本（v2 如何消除）

| 编号 | v1 缺陷 | v2 处理 |
| --- | --- | --- |
| D1 | `burstStart` 在首条消息**之后**赋值，时间过滤把第一个会话过滤掉 | 模型不再有时间过滤；顺序 = 入栈顺序 |
| D2 | `SYNC_UNREAD` 能开窗 → 历史未读反复复活 | 基线机制：首次同步只记录不弹（S5.5）；之后仅 `count` 增长才兜底开窗 |
| D3 | 收起后 SYNC 把窗口弹回，只能用"抑制集合"硬挡 | I1 后不需要抑制集合，也不需要冷却 |
| D4 | 主进程用 520 / 上次高度占位 → 先长后短 | I4：`nc-measure` 强制实测 |
| D5 | 首屏无合并 → 先 A 再 A+B 的跳变 | `arming` 150ms 固定窗口（不重置） |
| D6 | 整窗入场动画在每次渲染时重播 | 动画只由 `nc-show` 触发 |
| D7 | `sysRowMap` 存成 DOM 元素而非 `{el,sig}` → `insertBefore` TypeError 中断渲染 | 记录对象类型统一；`placeIn` 增加 `nodeType` 防御 |
| D8 | `dismissWindow` 未清 `pendingShow`/`showTimer` → 收起后 250ms 自动弹回 | `closeStack` 统一清 `pendingShow` 与三类定时器（S3.11） |
| D9 | 3s 内容去重把"连发相同内容"吞掉 | 有权威 `unreadCount` 时以权威值为准，不做内容去重；无权威值才用 300ms 同签名去重（S1.7） |
| D10 | 多写入者模型本身 | 见第一节 |
| D11 | 展示时长固定为设定值，多行堆叠时读不完（6 个会话 5 秒消失） | 时长 = `min(12, max(3,设定值) + (行数-1))` 秒（S1.3/D11 断言） |
| D12 | `markRead(convId \|\| 'all')` 在 cid 为空时清空整个列表，误伤其它会话 | 只有拿到明确 cid 才 `markRead`；无 cid 不做破坏性操作（保守策略） |
| D13 | 网页端 v6 SDK 用 `deep watch` 的 `oldValue` 判断「未读增长」，新旧值同引用 → 恒 false → `SHOW_MESSAGE_NOTIFICATION` 一次不发，桌面端完全静音 | ① 网页端改为自维护未读快照（`lastUnreadCounts`）；② 桌面端 `syncUnread` 以 `count` 增长兜底提醒（`notifyFromSync`，双通道同到不重复） |

## 八、验证

```bash
# 模型层：88 条断言，覆盖 S1.x~S5.x（可控时钟，无需真实等待）
node scripts/verify-notification-center.js        # 或 npm run test:nc

# 渲染层：38 条断言（jsdom，含"重复推送零 DOM 写入"）
NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
  "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" \
  scripts/verify-notification-render.js

# 主进程可载入 / IPC 通道无 ReferenceError
node scripts/verify-main-load.js                  # 或 npm run test:main
```

当前结果：**88/88、38/38、86 个 IPC 通道全部通过**。

### 仍需人工确认（视觉类，自动化无法覆盖）

1. 窗口被其他窗口遮挡时，新消息到达仍在最上层（`screen-saver` 层级）。
2. 增行时"底边固定、向上生长"的视觉感受。
3. 头像加载过程中的过渡是否还有白闪。
4. 点击提醒 → 主窗口跳到对应会话（依赖网页端深链）。
5. 两个不同会话（一个群、一个 C2C）的真实提醒叠加。

### 排查用日志

日志目录 `%APPDATA%\mylog-desktop-notifier\logs`，过滤 `[NC]`：

- `Message: <cid> | stack= N | count= C | isDup= false` —— 每收到一条真实消息。
- `Stack closed: <reason>` —— `timeout` / `user` / `read-one` / `read-all` / `synced-empty` / `sys-cleared`。
- `Suppress toast (active conversation|muted/mode)` —— 被抑制的原因。

若出现"该弹没弹"，先看有没有 `Message:` 行：
有 → 渲染或高度协议问题；没有 → 网页端没发 `SHOW_MESSAGE_NOTIFICATION`（查 `[WS]` 日志）。
