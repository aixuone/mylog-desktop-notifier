# 通话就绪层（Mic/Speaker Readiness）设计契约 v1.0

> 冻结日期：2026-09-20
> 状态：M0 冻结，M1~M3 以此文档为验收基准
> 目标：消灭「进了会才发现没声音」

---

## 0. 一句话结论

腾讯 TRTC / TUICallKit / TUIRoomKit 只提供**会中零件**（设备枚举、会中切换、热插拔事件、会中音量），
不提供**会前保证**。我们在其上自建一层「就绪层」，分两件事：

| 组件 | 职责 | 启动时机 |
|---|---|---|
| `MicHealthMonitor` | 登录后**常驻**感知 —— 权限 / 设备增减 / 插拔 / 占用 / 静音 | 业务登录成功 |
| `CallReadinessGate` | 呼叫前**硬闸门** —— 麦克风必须出声、扬声器必须确认 | 用户点「呼叫 / 入会」 |

---

## 1. 麦克风状态机（MicHealthMonitor）

### 1.1 状态枚举（冻结）

| state | severity | 含义 | 触发条件 |
|---|---|---|---|
| `ok` | ok | 权限、设备、音量均正常 | 全绿 |
| `no_permission` | err | 系统/浏览器未授予麦克风权限 | `permissions.query` 非 granted，或短探取 `NotAllowedError` |
| `no_device` | err | 无任何输入设备 | `enumerateDevices()` 无 `audioinput` |
| `device_removed` | warn | 当前选定设备已断开 | 选定设备从枚举中消失 |
| `device_in_use` | err | 被其他程序占用 | 短探取 `NotReadableError` |
| `silent` | warn | 设备正常但采样近 0 | 短探电平峰值 < 阈值 |

**判定优先级（自上而下短路）**：`no_permission → no_device → device_removed → device_in_use → silent → ok`

### 1.2 三类信号源（互补，缺一不可）

| 档 | 信号 | 开麦？ | 频率 | 抓什么 |
|---|---|---|---|---|
| 轻量 | `navigator.permissions.query({name:'microphone'}).onchange` | 否 | 事件 | 权限被系统收回 |
| 轻量 | `enumerateDevices()` 比对 | 否 | 5s | 设备增减 |
| 轻量 | `navigator.mediaDevices.ondevicechange` | 否 | 事件 | 插拔即时 |
| 重探 | `getUserMedia({audio:true})` 开 1s 即关 | 是 | 空闲时 30s | 占用、无声、权限 |
| SDK | `trtc.on(TrtcEvent.DEVICE_CHANGED)` | 否 | 事件 | SDK 视角的热插拔（需 SDK 就绪后生效） |

### 1.3 三条硬约束（违反即引入新 bug）

1. **常驻绝不开着麦**：只跑权限/枚举/事件；短探亦为「开 1 秒即关」。否则麦克风指示灯长亮 → 用户反感，且自占用 → 误报 `device_in_use`。
2. **会议进行中暂停重探**：TRTC 占麦时短探必拿 `NotReadableError`，会疯狂误报。进入会议后常驻重探休眠，监测权交接给会中 `AnalyserNode`。
3. **多标签页主从选举**：同源多标签同时 `getUserMedia` 会互相抢麦。用 `BroadcastChannel('mylog-michealth')` 选举唯一「主标签」执行重探，其余只消费广播状态。

---

## 2. 扬声器状态机（无法自动判定，只能确认）

**硬事实**：任何 SDK 都只能知道「输出设备存在」，永远无法知道「用户耳朵听到的是不是它」。
故扬声器只能走**用户确认**，产品上等价于腾讯会议自己的「点击检测扬声器，听到一段音乐即正常」。

| state | severity | 含义 |
|---|---|---|
| `unknown` | neutral | 尚未试听确认（**默认态**，不能当成正常） |
| `confirmed` | ok | 用户点过「听到了」，且其后未更换设备 |
| `failed` | warn | 用户点「没听到」 |
| `device_removed` | err | 选定扬声器已断开 |

**失效规则（关键）**：更换扬声器设备 → 立即回退 `unknown`，必须重新确认。避免"确认过一次就永远绿"。

---

## 3. CallReadinessGate（呼叫前硬闸门）

### 3.1 流程

```
点击「呼叫 / 入会」
  └─ 读 MicHealthMonitor 状态
       ├─ 非 ok  → 【拦截屏】展示原因 + 对应修复入口（修好自动继续）
       └─ ok     → 步骤① 麦克风采集确认（说话 2.5s，需电平峰值 > 阈值）
                    └─ 失败 → 提示「没听到你说话」+ 切设备/重试
                    └─ 通过 → 步骤② 扬声器试听确认（播放试听音 + 用户点击）
                                └─ 「没听到」→ 展开扬声器选择 + 重播
                                └─ 「听到了」→ 步骤③
                                         └─ 【开始呼叫】解锁
```

### 3.2 闸门语义

- 用户可**取消**，但**不可绕过**——非绿态下呼叫按钮保持 `disabled`。若产品需要允许强行呼叫，则必须以「仍要呼叫」次级按钮呈现（默认不提供）。
- 通过后必须**落库记忆**：`lastGoodMic` / `lastGoodSpeaker` 持久化，下次启动**自动应用**。
  （默认设备往往恰恰是那个不发声的设备，不记住就每次踩同一个坑。）

### 3.3 通过后的绑定动作（进会最后一公里）

| 动作 | API |
|---|---|
| 应用麦克风 | `trtc.updateLocalAudio({ option: { microphoneId } })` |
| 应用扬声器 | `TRTC.setCurrentSpeaker(deviceId)`（TRTC）或 `HTMLMediaElement.setSinkId(deviceId)`（原生 `<audio>`/`<video>`） |
| 热插拔兜底 | `DEVICE_CHANGED` 若 `action==='remove'` 且移除的是选定设备 → 自动降级到下一可用设备 + toast 告知 |

---

## 4. 呈现位置（冻结）

| 位置 | 内容 | 端 |
|---|---|---|
| AppHeader | 双 chip：`麦克风·<状态>` / `扬声器·<状态>`，绿/黄/红，点击开设备检测弹层 | web |
| 托盘 tooltip | 反映麦克风 + 扬声器健康态 | desktop |
| 非阻断 toast | `device_removed` / `no_permission` / `no_device` 时弹出，带**一键修复**按钮 | web + desktop |
| 会中提示条 | 「没听到你的声音」——本地电平**持续 >8s 近 0** 才触发（避免轻咳误报） | web |
| 系统深链 | 红态一键 `shell.openExternal('ms-settings:privacy-microphone')` | desktop |

---

## 5. 里程碑与交付物

| 里程碑 | 目标 | 交付物 | 验收标准 |
|---|---|---|---|
| **M0** | 冻结状态机、闸门规则、SDK 接入点 | 本文件 | 用户确认 |
| **M1** | 交互可验证：双 chip + 就绪门三步 + 扬声器试听 + 设备记忆 | `design/mic-health-prototype/index-v2.html` | Playwright 全绿、运行时错误 0 |
| **M2** | web 落地：`micHealthMonitor` store + AppHeader 双 chip + 闸门组件接入呼叫按钮 + 会中提示条 | `mylog-pc/web/src/...` | 真机接 TUICallKit/TUIRoomKit 可跑通 |
| **M3** | 桌面补齐：托盘状态 + `ms-settings` 深链 IPC + 插拔 toast | `desktop-notifier/src/...`、`main.js` | 拔耳机能弹 toast 并一键切换 |

---

## 6. 已知坑清单（实现时逐条对照）

1. **权限失败 ≠ 设备被占用**：前者去系统设置，后者让用户关掉占用程序。引导文案完全不同，不可合并。
2. **Windows「允许桌面应用访问麦克风」**是 Electron 专属黑洞：主进程 `setPermissionRequestHandler` 放行 ≠ 系统隐私开关放行，必须深链引导。
3. **虚拟设备当默认输入**是「有麦无音」经典元凶：`立体声混音 / Stereo Mix / Wave out / 虚拟声卡` 必须进黑名单，智能选设备时排除。
4. **蓝牙热插拔**：进会后才插耳机，TRTC 不保证自动切；`DEVICE_CHANGED` / `ondevicechange` 必须兜底。
5. **会中提示阈值**用「持续 N 秒近 0」，不要单次采样，否则环境噪声下疯狂误报。
6. **切换扬声器后必须重新确认**，否则会出现"显示正常但用户听不到"的假绿。
7. **多标签页抢麦**：必须主从选举，否则自己把自己判成 `device_in_use`。

---

## 7. 不做的事（明确边界）

- 不做「扬声器自动检测正确性」——物理上不可自动判定，只做用户确认。
- 不做设备级音量增益自动调整（`GainNode` 提增益）——会掩盖真实故障且可能引入啸叫。
- 不在常驻监测里持续开麦——见 §1.3 约束 1。
