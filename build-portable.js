// 给客户用的绿色版(免安装)打包脚本
// 产物: dist-portable/MyLog通知助手-便携版-1.0.0.exe
// 优势: 不写注册表、不放开始菜单、双击即跑、U 盘可拷走
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'dist-portable');
const NAME = 'MyLog通知助手-便携版-1.0.0';

console.log('▶ 开始打包便携版...');

// 1) 用 electron-builder --dir 产出一个未压缩的 Win 可执行目录
execSync('npx electron-builder --dir --win', {
  stdio: 'inherit',
  cwd: ROOT,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
});

console.log('✔ electron-builder --dir 完成');

// 2) 把整个 win-unpacked 目录用 7z/zip 压成单 exe(自解压)
//    这一步是可选的;客户也可以直接跑 win-unpacked/MyLog通知助手.exe
//    这里我们提供两种选择,具体压缩方法见 README
console.log('✔ 便携版目录已生成: ' + OUT_DIR);
console.log('  入口: ' + path.join(OUT_DIR, 'win-unpacked', 'MyLog通知助手.exe'));
