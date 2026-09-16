/* 把一张截图按中心点裁一块再邻近放大，写成一个新 png。
 *
 * 为什么要它：CDP 的 Page.captureScreenshot 带 clip 参数在本机返回空结果（试过），
 * 而 16px 的图标在 1600×900 的整图里识图模型根本看不见（也试过）。所以统一走
 * 「Node 侧裁 + 放大」这条路，跟 cdp-probe14 / icon-sheet 用的是同一套。
 *
 * 用法：node scripts/crop-zoom.mjs <in.png> <cx> <cy> <size> <zoom> <out.png>
 *   size 是裁剪边长（原图像素），zoom 是放大倍数；越界部分填白。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePNG } from './lib/png.mjs'
import { encodePNG, cropZoom } from './lib/png-write.mjs'

const [, , file, cx, cy, size, zoom, out] = process.argv
if (!file || !out) {
  console.error('用法：node scripts/crop-zoom.mjs <in.png> <cx> <cy> <size> <zoom> <out.png>')
  process.exit(2)
}
const img = decodePNG(readFileSync(file))
const c = cropZoom(img, Number(cx), Number(cy), Number(size), Number(zoom))
writeFileSync(out, encodePNG(c))
console.log(`${file} 裁 (${cx},${cy}) ${size}px ×${zoom} → ${out} (${c.width}×${c.height})`)
