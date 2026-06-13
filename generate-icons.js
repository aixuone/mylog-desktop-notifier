// generate-icons.js
// 基于 icon.png 生成 icon.ico / icon-gray.ico / icon-unread.ico
// 用法：node generate-icons.js

const Jimp = require('jimp')
const fs = require('fs')
const path = require('path')

const ASSETS_DIR = path.join(__dirname, 'assets')
const SRC_PNG = path.join(ASSETS_DIR, 'icon.png')

function createIcoFromSinglePng(pngBuffer) {
  // ICO header: 6 bytes
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // reserved
  header.writeUInt16LE(1, 2)   // type: ICO
  header.writeUInt16LE(1, 4)   // count: 1 image

  // ICONDIRENTRY: 16 bytes
  const entry = Buffer.alloc(16)
  const pngSize = pngBuffer.length
  // Width/Height = 0 means 256
  entry.writeUInt8(0, 0)            // Width
  entry.writeUInt8(0, 1)            // Height
  entry.writeUInt8(0, 2)            // PaletteSize
  entry.writeUInt8(0, 3)            // Reserved
  entry.writeUInt16LE(1, 4)         // Planes
  entry.writeUInt16LE(32, 6)        // BitCount
  entry.writeUInt32LE(pngSize, 8)   // Size
  entry.writeUInt32LE(6 + 16, 12)  // Offset

  return Buffer.concat([header, entry, pngBuffer])
}

function pngBufferToIco(pngBuf, outputPath) {
  const icoBuf = createIcoFromSinglePng(pngBuf)
  fs.writeFileSync(outputPath, icoBuf)
  console.log(`  ✓ Saved ${path.basename(outputPath)} (${icoBuf.length} bytes)`)
}

// ─── 主逻辑 ─────────────────────────────────────
async function main() {
  if (!fs.existsSync(SRC_PNG)) {
    console.error(`[generate-icons] ERROR: ${SRC_PNG} not found!`)
    process.exit(1)
  }

  console.log('[generate-icons] Reading icon.png...')
  const baseImage = await Jimp.read(SRC_PNG)

  // 统一 resize 到 256x256（PNG 高质量，ICO 由 Windows 缩放）
  const make256 = (img) => img.clone().resize(256, 256)

  // ── 0. 重新生成标准 icon.ico（覆盖损坏的 4.2KB 版本）───
  console.log('[generate-icons] Generating icon.ico (standard)...')
  {
    const img = make256(baseImage)
    const pngBuf = await img.getBufferAsync(Jimp.MIME_PNG)
    pngBufferToIco(pngBuf, path.join(ASSETS_DIR, 'icon.ico'))
  }

  // ── 1. 灰度版本 ──────────────────────────────
  console.log('[generate-icons] Generating icon-gray.ico...')
  {
    const img = make256(baseImage)
    img.greyscale()
    const pngBuf = await img.getBufferAsync(Jimp.MIME_PNG)
    pngBufferToIco(pngBuf, path.join(ASSETS_DIR, 'icon-gray.ico'))
  }

  // ── 2. 未读红点版本 ─────────────────────────
  console.log('[generate-icons] Generating icon-unread.ico...')
  {
    const img = make256(baseImage)
    const w = img.bitmap.width   // 256
    const h = img.bitmap.height  // 256
    // 红点：直径 ≈ 256 * 0.2 = 51px，位置右上角（留 8px 边距）
    const dotR = Math.round(Math.min(w, h) * 0.2)
    const cx = w - dotR - 8
    const cy = 8 + dotR

    for (let y = cy - dotR; y <= cy + dotR; y++) {
      for (let x = cx - dotR; x <= cx + dotR; x++) {
        if (x >= 0 && x < w && y >= 0 && y < h) {
          const dx = x - cx
          const dy = y - cy
          if (dx * dx + dy * dy <= dotR * dotR) {
            // iOS 红色 #FF3B30，Alpha=255（完全不透明）
            img.setPixelColor(Jimp.rgbaToInt(255, 59, 48, 255), x, y)
          }
        }
      }
    }

    const pngBuf = await img.getBufferAsync(Jimp.MIME_PNG)
    pngBufferToIco(pngBuf, path.join(ASSETS_DIR, 'icon-unread.ico'))
  }

  console.log('[generate-icons] ✅ All done!')
}

main().catch(err => {
  console.error('[generate-icons] Error:', err)
  process.exit(1)
})
