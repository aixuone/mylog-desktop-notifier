# siever-mail 替代性审查报告

> 审查对象：https://github.com/beltromatti/siever-mail
> 审查目标：评估其能否替换 desktop-notifier 现有邮箱功能（出口A 给人用 / 出口B 给 WorkBuddy 读写）
> 审查日期：2026-10-15
> 维度：项目本体 · 现有实现 · 能力映射 · 架构兼容 · 许可合规 · 安全性与用户数据（商用）· 结论

---

## 一句话结论

**siever-mail 是一个完整的桌面邮件客户端应用，不是可嵌入的邮件引擎库——不能直接"替换"我们的邮箱功能。** 但它印证了我们"用 imapflow + nodemailer 做 Node 原生邮件引擎"的技术选型，且其 Apache-2.0 许可比我们现有的 SnappyMail（AGPL-3.0）更利于商用合规。最大价值是**借鉴其引擎实现**，而非整体采用。

---

## 一、siever-mail 项目本体

| 项 | 内容 |
|---|---|
| 定位 | 跨平台桌面邮件客户端（Electron 应用） |
| 技术栈 | Electron 39 · React 19 · TypeScript · Tailwind · Vite 7 · Prisma 7 / better-sqlite3 |
| 协议库 | `imapflow`(IMAP) + `nodemailer`(SMTP) + `mailparser`(解析) + `dompurify`(清洗) + `googleapis`(Gmail OAuth) |
| 数据模型 | 本地 SQLite + OS 钥匙串（Electron `safeStorage`），无遥测、无云 |
| 许可证 | **Apache 2.0**（宽松） |
| 成熟度（关键） | 创建 2026-02-20，最后提交 2026-09-27，**GitHub 5 star / 0 fork / 0 open issue**，package 版本 `0.0.0`，**单一维护者**（Mattia Beltrami，米兰），无正式 Release |

> 形态本质：它是"一个应用"，不是"一个组件"。邮件引擎 `src/main/services/mail-engine/` 深度耦合 Electron 专有 API（`net.isOnline`、`powerMonitor`、`safeStorage`、`ipcMain`），文档明确"不能在应用外使用"，也不是 npm 包。

---

## 二、我们的现有邮箱实现（对照）

- **出口A（给人用）**：SnappyMail 2.38.2（AGPL-3.0）+ 便携 PHP 8.4.26，BrowserWindow 加载；`mylog-provider` 插件做服务商下拉（阿里标准/外贸、腾讯企业邮、QQ、网易企业邮、Gmail、Outlook、自定义）。
- **出口B（给 WorkBuddy 读写，部分完成）**：`lib/emailClient.js`（imapflow + mailparser + sanitize-html，已含 IDLE 监听）、`lib/emailCreds.js`（safeStorage 加密授权码）、`emailSender.js`（nodemailer，**未建**）；经本地 WS 18999 处理。
- **合规现状**：`THIRD-PARTY-LICENSES.md`；AGPL 义务靠随包附 SnappyMail 完整源码履行。

---

## 三、能力映射

| 能力 | 我们现有 / 规划 | siever-mail |
|---|---|---|
| 多账户 IMAP/SMTP | ✅（SnappyMail + 规划出口B） | ✅ |
| Gmail OAuth | ❌（现无） | ✅（googleapis XOAUTH2） |
| 服务商自动填 host | ✅（mylog-provider 插件） | ❌（需自建） |
| 统一收件箱 / 分类 | ✅（SnappyMail） | ✅（TUTTI、分组、字段搜索） |
| 本地缓存 | ✅ | ✅（SQLite + 游标 / reconciliation） |
| 凭据安全 | ✅（safeStorage） | ✅（safeStorage） |
| 实时推送（IDLE） | 部分（出口B） | ✅（双连接 primary/sync） |
| 程序化读写（出口B） | 规划中 | ❌（纯前端客户端，无 API 出口） |

> 结论：siever-mail 在"给人用的客户端"维度更现代、原生感强；但缺我们已做的**服务商自动配置**和**程序化出口B**。

---

## 四、架构兼容性（为什么不能直接替换）

1. **形态错配**：siever-mail 是完整 Electron 应用（electron-vite + React 渲染进程），我们的 desktop-notifier 本身也是 Electron 应用——一个 Electron 应用无法"嵌入"另一个。
2. **引擎不可复用**：其邮件引擎耦合 Electron 专有 API，文档声明无法在应用外使用，也不是 npm 包。
3. **替换出口A 的唯一路径** = fork 整个项目、把它的 React 渲染进程塞进我们的邮件窗口 → 等于重写邮件 UI 子系统，并背上 5-star 上游的维护。
4. **替换出口B** = 抄其引擎逻辑进 `main.js`，但那是单维护者的耦合代码，不是干净库。

---

## 五、许可与合规（商用）

- **SnappyMail AGPL-3.0 = 强 copyleft**：任何修改 + 分发（含网络分发）须提供完整对应源码。我们靠"随包附完整源码"履行——对闭源商用产品是**最重**的义务。
- **siever-mail Apache-2.0 = 宽松**：可用于闭源商用，只需保留 NOTICE、声明修改、**无源码披露**、含专利授权。合规负担远轻。
- **推论**：若用 siever-mail 衍生代码**替换** SnappyMail 出口A，反而能卸掉 AGPL 负担（需保留 Apache 署名）；若只是"新增"而不"替换"，AGPL 义务仍在。
- **注意**：不得把 siever-mail 以 "SIEVER Mail" 名义发布（名称虽 disclaim，建议 fork 后重命名）。

---

## 六、安全性与用户数据保护（商用重点）

1. **凭据安全**
   - 出口B：`lib/emailCreds.js` 用 `safeStorage`（OS 钥匙串 DPAPI/Keychain/libsecret），授权码**绝不落明文** ✅ 已达标。
   - siever-mail：同样 `safeStorage` ✅。
   - ⚠️ 风险点：出口A（SnappyMail/PHP）凭据存于 `%APPDATA%` 下 `snappymail-data`，走 SnappyMail 自有加密方案，**未接入 OS 钥匙串**——相比 safeStorage 略弱，但仍为加密存储；PHP 进程本地运行，无外传。建议评估是否满足企业客户要求。

2. **数据驻留 / 隐私**
   - 两者均**纯本地**，邮件不进任何第三方云——对国内企业客户是合规卖点（数据不出本机）。siever-mail 无遥测，符合。

3. **不可信内容处理（HTML 邮件是 XSS/钓鱼主战场）**
   - 出口B：`sanitize-html` 剥离 script + 外层沙箱 iframe（无 `allow-scripts`）+ CSP（`script-src none`）三层兜底 ✅。
   - siever-mail：`dompurify` 清洗 ✅，但渲染是否走 sandbox iframe 文档未明示，**引入前需 code review 确认**。

4. **供应链 / 维护风险（商用关键）**
   - siever-mail：**5 star / 0 fork / 单维护者 / v0.0.0 / 8 个月龄 = bus factor = 1，审计曝光极低**。依赖极新（Electron 39 / React 19 / Prisma 7 / Vite 7），长期安全补丁依赖一人。
   - 对比：SnappyMail 是成熟、广泛部署的 PHP webmail，社区审计多；PHP 运行时我们已踩坑并固化（opcache ASLR、disable_functions 等）。
   - 商用若直接依赖 siever-mail 上游 = 把邮件核心绑在一个无人审计的个人项目上，**风险偏高**。

5. **传输安全**：两者均强制 TLS（我们 993/465 SSL；siever-mail STARTTLS 强制非机会性）✅。

---

## 七、可替代性结论与建议

**结论：不能直接替换。可作为"参考实现 / 上游灵感"，不宜整体采用。**

### 分阶段建议

- **短期（推荐，低风险）**：继续出口B 自研（imapflow + nodemailer + mailparser，已被 siever-mail 同栈验证）。把 siever-mail 的 `mail-engine` 当**最佳实践参考**——借鉴其双连接（IDLE primary + sync）、reconciliation、真实操作结果校验、`net.isOnline` / `powerMonitor` 网络感知，加固 `lib/emailClient.js`。性价比最高。
- **中期（可选）**：若想彻底去掉 PHP 运行时（简化打包 / 合规），再评估"自建 Node 原生邮件 UI"——可基于 siever-mail 渲染端做 fork 改造。但这是一次中型重写，需重做服务商自动配置 UX（mylog-provider 的便利性会丢失），且要承担上游维护风险。**当前不急于做**。
- **合规动作**：① 维持 safeStorage 存凭据（已达标）；② 若未来复制 siever-mail 代码，登记 Apache-2.0 署名到 `THIRD-PARTY-LICENSES.md`；③ 在替换 SnappyMail 前，AGPL 源码随包义务不得删。

### 不建议

- 把 siever-mail 当 npm 依赖直接引入（它不是库）。
- 整体 fork 其作为我们产品的邮件子系统（维护风险 + 重写成本不划算）。

---

## 给决策者的话

这个仓库值得"读代码学模式"，不值得"拿来当组件"。我们的技术方向（Node 原生邮件引擎）已经被它印证，不必换船；PHP 那块若哪天想甩，也是**自建 UI** 而非搬它的。商用场景下，绑一个 5-star、单维护者的上游做邮件核心，比守着成熟的 SnappyMail 风险更高——除非我们打算长期投入维护自己的 fork。
