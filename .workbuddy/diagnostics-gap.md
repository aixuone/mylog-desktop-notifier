# 诊断测试功能 · PM 验收与补充清单

> 视角：产品经理验收  
> 目标：检验项目已有功能是否都被测试功能覆盖，找出缺口，给出补充优先级与验收标准。  
> 配套：`.workbuddy/diagnostics-prd.md`（原始 PRD）、`src/diagnostics.html`（当前实现）
>
> **✅ 实施状态：P0 + P1 已全部落地**（2026-07-29）。诊断测试现已覆盖 11 项自动检查（R1–R11）+ 7 项手工确认，原 7 项零覆盖功能均已补齐。代码侧 node --check 全过，待真机验收。P2（设置持久化/托盘用户/未读同步）仍为可选排期。

---

## 一、检验结论（摘要）

当前诊断测试已覆盖 **5 项自动检查 + 3 项手工确认**，能防止"有声无窗""点了没反应"类基础回归，质量基线合格。

但对照项目**全部 12 项功能**，仍有 3 项 **P0 缺口直接对应客户已报问题却未被覆盖**，最突出的一点：

> **屏幕共享只测了"权限是否放行"，没测"源到底能不能取到"**。  
> 而权限放行 ≠ 共享能用——那位客户报"意外出错"，根因极可能是本机 `desktopCapturer.getSources` 失败（驱动/显卡/多屏），权限层 PASS 也发现不了。**这是当前测试最大的盲区。**

---

## 二、项目功能全景（12 项）

| # | 功能模块 | 说明 | 代码位置 |
|---|---|---|---|
| 1 | 桌面通知弹窗 | 自绘窗口，alwaysOnTop，多屏跟随光标 | `lib/notificationCenter.js` |
| 2 | 消息铃声 | 场景铃声 + 联系人专属 + 上传自定义 | `lib/ringtoneResolver.js` |
| 3 | 通知模式 | 正常 / 静音 / 勿扰，总开关联动 | 设置窗口 `syncMasterSwitch` |
| 4 | 消息点击聚焦 | WS `FOCUS_CONVERSATION` 聚焦网页 tab；未连则 `openExternal` 兜底 | `notificationCenter.js:322` |
| 5 | 网页端离线/被踢常驻通知 | `sysAlert`（offline/kick），sticky 不自动收起 | `notificationCenter.js:235` |
| 6 | 托盘菜单 | 在线用户列表 + 头像 + 状态、版本号、关机图标 | `main.js` 托盘段 |
| 7 | 屏幕共享 | `getDisplayMedia` + `desktopCapturer.getSources`（video-only） | `main.js setupScreenShare` |
| 8 | 全屏能力 | `requestFullscreen` | 权限矩阵 + 页面验证 |
| 9 | 来电/会议浮窗 | `callWindow`/`meetingWindow`，frame:false | `main.js` |
| 10 | 设置持久化 | `settingsStore` 读写 | `main.js` |
| 11 | WebSocket 服务 | `broadcast` / focus / reconnect | `main.js` |
| 12 | 开机自启 | `set-auto-start` | `main.js:1684` |

---

## 三、当前诊断测试覆盖矩阵

| 功能 | 自动项 | 手工项 | 覆盖度 |
|---|---|---|---|
| 弹窗可见性 (#1) | R1 ✅ | ① ✅ | 完整 |
| 铃声播放 (#2) | R2（**仅 message 场景**）✅ | ② ✅ | **部分**（只测了消息场景，没测 call/meeting/联系人专属） |
| 全屏能力 (#8) | R3 ✅ | ③ ✅ | 完整 |
| 权限矩阵（含屏幕共享权限 #7） | R4 ✅ | — | **仅权限层**（没测共享源能否取到） |
| 多显示器环境 (#1 定位) | R5 ✅（展示） | — | 完整 |
| 点击聚焦 (#4) | — | — | **零覆盖** |
| 网页端离线/被踢 (#5) | — | — | **零覆盖** |
| 来电/会议浮窗 (#9) | — | — | **零覆盖** |
| 通知模式联动 (#3) | R2 静音 FAIL ✅ | — | **部分**（只测了静音下铃声，没测勿扰/总开关 disabled） |
| 设置持久化 (#10) | — | — | 零覆盖 |
| 托盘在线用户 (#6) | — | — | 零覆盖 |
| 未读计数同步 | — | — | 零覆盖 |

**结论**：12 项功能里，3 项完整、2 项部分、7 项零覆盖。

---

## 四、缺口分析（按严重程度）

### 🔴 P0 — 必加，直接对应客户已报问题
1. **屏幕共享"源获取"实测**：权限放行 ≠ 共享可用。客户"意外出错"的根可能就在 `getSources` 本机失败。
2. **通知点击聚焦**：v1.2 重点需求之一（点通知不再开新 tab），但从来没被测过。
3. **网页端离线/被踢常驻通知**：v1.2 重点功能④，sticky 常驻逻辑没验证。

### 🟠 P1 — 重要，覆盖 v1.2 新功能 / 同源坑
4. **铃声多场景解析**：只测了 message，call/meeting/联系人专属铃声的解析正确性未测。
5. **来电/会议浮窗弹出**：与全屏同源的"点击没反应"风险，没测。
6. **通知模式联动**：只测了静音下铃声，勿扰 + 总开关 disabled 状态未测。

### 🟢 P2 — 稳健性，可选排期
7. 设置持久化读写；8. 托盘在线用户列表同步；9. 未读计数同步。

---

## 五、建议补充项（开发落地规格）

### P0-1 屏幕共享源获取实测
- **对应**：功能 #7，直击客户"意外出错"
- **新增 IPC**：`diag:screencapture` → 主进程调 `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{width:1,height:1}})`
- **PASS 标准**：`sources.length > 0`（本机显卡/驱动/权限能拿到源）
- **价值**：直接复现/排除那位客户"getSources 失败"，比只测权限 allow 强一个量级
- **注意**：需记 `[ScreenShare]` 日志，失败原因回填到报告详情

### P0-2 通知点击聚焦
- **对应**：功能 #4
- **测试**：
  - 用例 A：网页在线（`isWebConnected=true`），模拟 `nc-open-conversation{conversationId,url}` → 校验 `wsServer` 发出 `FOCUS_CONVERSATION`
  - 用例 B：网页离线 → 校验回退 `openExternal`（用 spy 拦截，不真开浏览器）
- **PASS 标准**：在线时 broadcast 含 `{type:'FOCUS_CONVERSATION',conversationId}`；离线时触发 openExternal 路径
- **实现要点**：openExternal 实际打开浏览器不合适，主进程用内部 flag/spy 仅校验"会调用"

### P0-3 网页端离线/被踢常驻通知
- **对应**：功能 #5（v1.2 重点④）
- **测试**：`pushSysAlert({type:'offline'})` + `pushSysAlert({type:'kick'})` → 校验：
  ① `getSysAlerts()` 含对应项 ② 调 `nc-close` 时窗口**不收起**（sticky 保护）③ `dismissSysAlert` 后消失
- **PASS 标准**：offline/kick 后 `getSysAlerts` 命中；`nc-close` 不隐藏（hasStickyAlert 生效）

### P1-4 铃声多场景解析
- **对应**：功能 #2
- **测试**：`previewRingtone('call',null)` / `('meeting',null)` / `('message','<联系人id>')`
- **PASS 标准**：各场景返回有效路径且 `exists=true`（联系人专属配置了应命中专属文件）

### P1-5 来电/会议浮窗弹出
- **对应**：功能 #9
- **新增 IPC**：`diag:show-call` / `diag:show-meeting` → 触发 `preCreate+show` 对应浮窗，校验 `win.visible`
- **PASS 标准**：浮窗 `visible=true`（2.5s 后自动关闭，不污染用户）
- **价值**：覆盖"来电/会议按钮点了没反应"类问题

### P1-6 通知模式联动
- **对应**：功能 #3
- **测试**：模式切 `silent`/`dnd` → 跑 R1/R2 预期弹窗与铃声均被抑制；`normal` → 正常；并校验 UI 总开关 `disabled`
- **PASS 标准**：non-normal 下 `pushMessage` 不弹窗、`previewRingtone` `muted=true`；总开关 disabled

### P2（可选，仅列方向）
- 设置持久化：`settings-save` 后 `settings-load` 回读一致
- 托盘用户：对比 `tray-users-get` 与 WS 在线客户端
- 未读同步：`syncUnread` 后计数与渲染一致

---

## 六、PM 验收结论与下一步

- **当前诊断测试**：可作"基础健康度"工具随版本发布（覆盖弹窗/铃声/全屏/权限/多屏）。
- **本迭代必须补**：P0 三项（尤其 P0-1 屏幕共享源实测，是客户已报问题的直接盲区）。
- **建议同迭代补**：P1 三项（覆盖 v1.2 新功能与同源坑）。
- **P2**：排期后续，不阻塞本次发布。

> 请确认补充范围（建议全收 P0+P1），开发据此实现后，PM 在真机逐项验收。
