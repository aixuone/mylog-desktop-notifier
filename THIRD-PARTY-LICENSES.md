# 第三方组件与许可声明（THIRD-PARTY LICENSES）

本产品（e日志 桌面端）在开发与分发过程中使用了以下**免费开源**第三方组件。
**本项目未使用任何需要付费、订阅或商业授权的组件。**

---

## 一、随应用打包的 npm 依赖（均为 MIT 系许可，可商用）

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| pinyin-pro | 3.x | MIT | 拼音处理 |
| solarlunar | 3.x | MIT | 农历换算 |
| ws | 8.18.0 | MIT | 本地 WebSocket 通道 |
| Electron | 32.3.3 | MIT | 桌面应用框架 |

## 二、明确未使用的收费组件

以下常见方案**经评估后已排除**，本产品不依赖它们：

- Nylas / Context.IO 等**商业邮件 API**（按量计费）
- Mailspring Pro、RainLoop Premium 等**付费增强版**
- 任何需要购买授权或订阅的邮件 SDK / 界面组件

## 三、邮箱功能的实现方式

本产品的「邮箱」入口直接加载**阿里云邮箱网页版**
（`https://qiye.aliyun.com/alimail/`），由 Electron 以独立持久分区窗口承载，
登录态经 Cookie 持久化实现「关窗 / 重启免登」。

本产品**不内置任何第三方邮件引擎**（如 SnappyMail）或独立协议客户端
（IMAP / SMTP），因此不再随包分发相应运行时与 npm 依赖（imapflow、
mailparser、nodemailer、sanitize-html、PHP 等均已移除）。
