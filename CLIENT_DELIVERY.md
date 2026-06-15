# MyLog 桌面通知助手 - 客户交付说明

## 两种交付物(选一种)

| 类型 | 文件 | 适合场景 |
|------|------|---------|
| **NSIS 安装版**(推荐) | `dist-installer-new/MyLog通知助手 Setup 1.0.0.exe` | 正式客户,有管理员权限,需要桌面/开始菜单快捷方式 |
| **免安装便携版** | `dist-portable/win-unpacked/MyLog通知助手.exe` | 内部测试、U 盘携带、不想留注册表痕迹 |

---

## 客户机器运行要求

- Windows 10 / 11(64 位)
- 约 200 MB 磁盘空间(便携版含 Electron 运行时)
- WebSocket 端口 `18999` 不能被占用(且需允许 `127.0.0.1` 回环)

---

## 一键重新打包(开发用)

```bat
:: 在项目根目录双击或运行
scripts\build-all.bat
```

效果:
1. 自动 `npm install`(已装则跳过)
2. 产出 NSIS 安装版到 `dist-installer-new/`
3. 产出便携版到 `dist-portable/`

---

## 客户验收清单(SMOKE TEST)

发给客户前,在自己机器跑一遍:

- [ ] 双击 `.exe` 启动,**系统托盘出现 MyLog 图标**
- [ ] 右键托盘 → 菜单显示"打开 / 退出"两项
- [ ] 浏览器扩展或调用方连接 `ws://127.0.0.1:18999` 能收到 `CONNECTED`
- [ ] 触发来电通知 → **屏幕中央弹窗 + 铃声响起**
- [ ] 触发消息通知 → **右下角 Toast 弹出**
- [ ] 30 秒内不操作 → 弹窗自动关闭(超时)
- [ ] 关闭主程序后,资源管理器里 **没有残留进程**

---

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| 双击 exe 闪退 | 缺 VC++ 运行库 | 安装 [Microsoft Visual C++ 2015-2022 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) |
| 端口 18999 占用 | 上一实例未退干净 | 任务管理器结束 `MyLog通知助手` 进程 |
| 铃声不响 | `assets/ringtone.m4a` 缺失 | 见 `assets/ringtone.m4a` 占位说明 |
| 托盘图标灰色 | 浏览器侧 WebSocket 没连上 | 检查浏览器扩展是否启用 |

---

## 给团队的话

- **配置改完记得改版本号**:`package.json` 里的 `version` 字段
- **图标修改后请覆盖 4 个状态**:`icon.png` / `icon-gray.png` / `icon-unread.png` / `icon.png` 闪烁态
- **不要手动改 `dist-*` 目录**,这是构建产物,改了下次打包就被冲掉
- **真正的代码改动在**:`main.js` / `src/*.html` / `config.js`,改完跑 `scripts\build-all.bat`
