# 通知助手 · 自检测试功能（PRD + 设计 + 验收标准）

> 角色：产品经理（需求/设计/验收）  →  开发实现  →  产品经理验收
> 关联问题：客户反馈「安装后只有铃声没有弹窗」「屏幕共享/全屏点击无响应」。

## 1. 背景与目标
售后排查长期依赖让客户口述环境，效率低、易误判。本功能在应用内新增**诊断测试**模块，让客户/测试人员一键自检，自动输出 PASS/FAIL 报告，并支持手工确认，覆盖近期高频问题域。

## 2. 需求清单
| 编号 | 需求 | 类型 |
|------|------|------|
| R1 | 弹窗可见性：验证通知窗确实出现且在可视区内 | 自动 + 手工 |
| R2 | 铃声播放：验证铃声路径有效且能播放 | 自动 + 手工 |
| R3 | 全屏能力：验证 `requestFullscreen()` 可用（修复点击无响应） | 自动 + 手工 |
| R4 | 权限矩阵：验证主页面域 media/display-capture/fullscreen/clipboard/pointerLock/notifications 全部放行（含屏幕共享） | 自动 |
| R5 | 多显示器环境检测：展示显示器数量、主屏、光标所在屏、通知窗落点，辅助解释「有声无窗」 | 展示 |

## 3. 测试项与验收标准
每条自动项输出 `PASS / FAIL`；手工项由测试人员勾选确认。

### 3.1 弹窗可见性（R1）
- **自动**：主进程显示真实通知窗，回报 `visible === true` 且窗口 `bounds` 落在**任一显示器 workArea** 内（`onScreen === true`）；2.5s 后自动收起。
  - 验收：`visible && onScreen` → PASS，否则 FAIL。
- **手工**：点「触发测试弹窗」→ 出现带「诊断测试」文案的小白窗 → 勾选「我看到了」。

### 3.2 铃声播放（R2）
- **自动**：解析 `message` 场景铃声路径 → `fs.existsSync` 校验文件存在 → 触发播放 → 回报 `{ path, exists }`。
  - 验收：`path` 非空且 `exists === true` → PASS，否则 FAIL（并提示路径，便于定位上传铃声丢失）。
- **手工**：点「播放铃声」→ 听到声音 → 勾选「我听到了」。

### 3.3 全屏能力（R3）
- **自动**：① 权限矩阵中 `fullscreen` 对主页面域 = allow；② 诊断窗内对测试元素调用 `requestFullscreen()`，Promise 不 reject。
  - 验收：① && ② → PASS，否则 FAIL。
- **手工**：点「全屏演示」→ 进入全屏 → 勾选「已进入全屏」→ 提供「退出全屏」。

### 3.4 权限矩阵（R4，含屏幕共享）
- **自动**：对主页面域模拟 `media / display-capture / fullscreen / clipboard-read / clipboard-write / pointerLock / notifications`，全部 = allow。
  - 验收：7 项全 allow → PASS，否则 FAIL（列出被拒项）。

### 3.5 多显示器环境（R5）
- 展示：显示器数量、主屏 id、光标所在屏 id、通知窗将落点坐标 `ncRect`。
- 无 PASS/FAIL，供排查；若 `displayCount > 1` 给出「弹窗将跟随光标所在屏」的说明。

## 4. 设计
- **入口**：设置 → 通用 → 「诊断测试」按钮，打开独立窗口 `src/diagnostics.html`（frame 窗口，可移动/缩放，居中到光标所在屏）。
- **通信**：经 preload 桥 `electronAPI` 调用主进程诊断 IPC：
  - `open-diagnostics` / `diag:display-info` / `diag:permission-matrix` / `diag:run-auto` / `diag:push-test` / `diag:play-ringtone`
- **主进程侧**：
  - `notificationCenter` 新增 `getWindowState()` / `previewRingtone()` / `pushTest()` / `hideWindow()`。
  - 权限判定抽取为 `permissionAllowed(url, permission)`；`trusted` 正则增加 `^file://`，使本机内置页面受信（设置/诊断窗可获得 `fullscreen`/`clipboard` 等安全权限，纯收益、零风险）。
- **安全**：诊断窗口仅用本机 `file://` 与可信远程域，不新增任何对外权限；`file://` 仅放行 safe 列表内权限，不放开 camera 等危险项。

## 5. PM 验收方式
1. `node --check` 全部通过。
2. 真机运行自动测试：单屏环境 5 项应全绿；多屏环境 R1 仍应 `onScreen=true`（已改为跟随光标所在屏）。
3. 手工四项：测试人员在单屏、多屏各确认一次，截图归档。
4. 边界：铃声总开关关闭（静音/勿扰）时 R2 自动应 FAIL 并提示「当前模式静音」——验证模式联动正确。
