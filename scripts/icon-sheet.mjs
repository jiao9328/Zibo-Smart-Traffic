/* 把 logs/icon-*.png 里的图标裁出来拼成对照图 logs/icon-sheet.png（每行一类图层）。
 *
 * 为什么需要：图标只有 4.5~6px，在 1600×900 的整图里肉眼和识图模型都看不见（真试过：
 * 识图回复「图中未见明显圆点状标记」）。裁 26px 小块 ×10 倍邻近放大后，形状才看得出来，
 * 于是「圆/三角/菱形/五边形各不相同」这句话才有画面证据，不只是配置里的一个字符串。
 *
 * 用法：node scripts/icon-sheet.mjs            （用已有的截图，需先跑 cdp-probe14.mjs）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePNG, colorBlobs } from './lib/png.mjs'
import { encodePNG, cropZoom, montage } from './lib/png-write.mjs'

const CLIP = { x: 380, y: 180, width: 840, height: 540 }
const TILE = 32 // 裁多大一块（图标 15~17px，留足周边便于看图形）
const ZOOM = 8 // 邻近放大倍数（32×8 = 256px 一格，够看清笔画走向）
const PER_ROW = 6

/* 行顺序即图标顺序：每层取自己主色（故障/状态色单独看，避免一行里混着两种形状认知） */
const ROWS = [
  { name: 'camera 监控探头', file: 'logs/icon-camera.png', colors: ['#7C4DFF'] },
  { name: 'trafficLight 信号灯', file: 'logs/icon-trafficLight.png', colors: ['#12B76A', '#F79009', '#F04438'] },
  { name: 'police 警员分布', file: 'logs/icon-police.png', colors: ['#E2447E'] },
  { name: 'busStop 公交站点', file: 'logs/icon-busStop.png', colors: ['#EF6820'] }
]

const tiles = []
for (const row of ROWS) {
  const img = decodePNG(readFileSync(row.file))
  // 每层的主色块按面积降序取前几个；只认「一个图标那么大」的块（15~17px 图标实心约 150~350px）
  const boxes = []
  for (const hex of row.colors) boxes.push(...colorBlobs(img, CLIP, hex).filter((b) => b.n >= 40))
  boxes.sort((a, b) => b.n - a.n)
  const pick = boxes.slice(0, PER_ROW)
  console.log(`${row.name}: 检出 ${boxes.length} 个图标块，取前 ${pick.length} 个`)
  for (const b of pick) tiles.push(cropZoom(img, b.cx, b.cy, TILE, ZOOM))
  // 不足一行就补白块，保证每行整齐对应一类图层
  while (tiles.length % PER_ROW !== 0) {
    tiles.push({ width: TILE * ZOOM, height: TILE * ZOOM, rgba: new Uint8Array(TILE * ZOOM * TILE * ZOOM * 4).fill(255) })
  }
}

const sheet = montage(tiles, PER_ROW, 8)
writeFileSync('logs/icon-sheet.png', encodePNG(sheet))
console.log(`\n对照图：logs/icon-sheet.png (${sheet.width}×${sheet.height})`)
console.log(`行序：${ROWS.map((r) => r.name).join(' / ')}（每行 ${PER_ROW} 个，放大 ${ZOOM}×）`)
