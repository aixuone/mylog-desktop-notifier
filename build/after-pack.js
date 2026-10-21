// build/after-pack.js —— 把「与当前构建架构匹配」的静态 PHP 放进 app 里
//
// 为什么必须在这一步做：
//   1. vendor/php-mac/bin 下同时有 php-arm64 / php-x64（两份各约 100MB），
//      若通过 extraResources 整个拷进去，每个 dmg 都会白塞一倍体积；
//   2. mac 的目标架构是 x64 + arm64 双份，而 extraResources 是「按平台」而非
//      「按架构」生效，只能靠钩子按 context.arch 挑。
//   3. afterPack 的时机正好：extraResources 已拷完、签名还没开始，于是
//      package.json 里 mac.binaries 指定的 Contents/Resources/vendor/php/php
//      在 osx-sign 运行时确实存在 —— 少签了这个二进制，公证必然 Invalid。
//
// Windows 构建直接返回，不受影响。

const fs = require('fs')
const path = require('path')

// builder-util 的 Arch 枚举
const ARCH_NAME = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const archName = ARCH_NAME[context.arch] || 'arm64'
  const projectDir = context.packager.projectDir
  const appName = context.packager.appInfo.productFilename
  const vendorDir = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'vendor')
  const phpDir = path.join(vendorDir, 'php')

  const src = path.join(projectDir, 'vendor', 'php-mac', 'bin', `php-${archName}`)
  if (!fs.existsSync(src)) {
    throw new Error(
      `缺少 macOS 静态 PHP：${src}\n` +
        '先在仓库根目录执行 python3 scripts/fetch-vendor-mac.py'
    )
  }

  fs.mkdirSync(phpDir, { recursive: true })
  const dest = path.join(phpDir, 'php')
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)

  // 万一 extraResources 的 filter 没生效，把多余的架构删掉，避免 dmg 白胖一倍
  const binDir = path.join(phpDir, 'bin')
  if (fs.existsSync(binDir)) fs.rmSync(binDir, { recursive: true, force: true })

  const mb = (fs.statSync(dest).size / 1048576).toFixed(1)
  console.log(`  • email php (${archName}, ${mb}MB) -> Contents/Resources/vendor/php/php`)
}
