# 第三方组件与许可声明（THIRD-PARTY LICENSES）

本产品（e日志 桌面端）在开发与分发过程中使用了以下**免费开源**第三方组件。
**本项目未使用任何需要付费、订阅或商业授权的组件。**

---

## 一、随安装包一起分发的运行时组件

| 组件 | 版本 | 许可 | 用途 | 源码获取 |
|---|---|---|---|---|
| **SnappyMail** | 2.38.2 | **AGPL-3.0** | 邮箱界面（收发信件、文件夹、搜索、附件、PGP） | https://github.com/the-djmaze/snappymail |
| **PHP** | 8.4.26 (NTS x64) | **PHP License v3.01** | 运行 SnappyMail 的运行时 | https://www.php.net/downloads |

### 许可合规说明

- **SnappyMail（AGPL-3.0）**：本项目将其**完整源码原样**随安装包分发（位于
  `<安装目录>/resources/vendor/snappymail/`），因此已满足 AGPL 关于「向使用者提供
  对应源码」的要求。SnappyMail 作为**独立进程**运行，通过本机回环 HTTP 与主程序通信，
  不构成对本项目自有代码的许可传染；本项目自有代码仍为闭源。
  AGPL 全文见 `vendor/snappymail/LICENSE`。
- **PHP（PHP License v3.01）**：许可全文见 `vendor/php/license.txt`；PHP 二进制中所捆绑
  的第三方组件声明见 `vendor/php/readme-redist-bins.txt`。

## 二、随应用打包的 npm 依赖（均为 MIT 系许可，可商用）

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| imapflow | 2.4.2 | MIT | IMAP 收件、实时推送（供 WorkBuddy 读写邮件） |
| mailparser | 3.9.x | MIT | 邮件内容解析 |
| nodemailer | 10.x | MIT-0 | SMTP 发信 |
| sanitize-html | 2.17.0 | MIT | HTML 内容清洗 |
| pinyin-pro | 3.x | MIT | 拼音处理 |
| solarlunar | 3.x | MIT | 农历换算 |
| ws | 8.18.0 | MIT | 本地 WebSocket 通道 |
| Electron | 32.3.3 | MIT | 桌面应用框架 |

> 说明：`sanitize-html` 锁定在 **2.17.0**。2.18 起依赖纯 ESM 的 `htmlparser2@12`，
> 会在 CommonJS 主进程中导致启动即崩，故不可升级。

## 三、明确未使用的收费组件

以下常见方案**经评估后已排除**，本产品不依赖它们：

- Nylas / Context.IO 等**商业邮件 API**（按量计费）
- Mailspring Pro、RainLoop Premium 等**付费增强版**
- 任何需要购买授权或订阅的邮件 SDK / 界面组件

## 四、重新获取第三方运行时

`vendor/` 目录不入版本库。在全新环境构建前，先执行：

```bash
python scripts/fetch-vendor.py
```

该脚本会按上表版本下载并裁剪组件，并把所需的许可文件一并放入 `vendor/`。
