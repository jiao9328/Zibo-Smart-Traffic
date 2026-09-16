/* 把多张截图缩小后拼成一张对照图，用来「一次看多张页面状态」。
 *
 * 为什么要它：几张 1440×900 的整页截图想同一眼看，只能先缩再拼 ——
 * 识图模型一次看四张大图会漏细节，拼成一张（每张缩到 1/2~1/3）反而更容易比较。
 *
 * 用法：node scripts/montage.mjs <out.png> <缩小倍数> <列数> <图1> <图2> ...
 *   例：node scripts/montage.mjs logs/sheet.png 2 3 screenshots/main.png screenshots/charts.png ...
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { decodePNG } from './lib/png.mjs'
import { encodePNG, downscale, montage } from './lib/png-write.mjs'

const [out, factor, cols, ...files] = process.argv.slice(2)
if (!out || !files.length) {
  console.error('用法：node scripts/montage.mjs <out.png> <缩小倍数> <列数> <图1> <图2> ...')
  process.exit(2)
}
const tiles = files.map((f) => {
  const t = downscale(decodePNG(readFileSync(f)), Number(factor))
  console.log(`  ${basename(f)} → ${t.width}×${t.height}`)
  return t
})
const sheet = montage(tiles, Number(cols), 6)
writeFileSync(out, encodePNG(sheet))
console.log(`拼图：${out} (${sheet.width}×${sheet.height})`)
console.log(`格子顺序：${files.map((f) => basename(f)).join(' / ')}`)
