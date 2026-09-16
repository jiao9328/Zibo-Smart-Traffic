/* 一次性分析：各图层要素到最近路网的距离分布，用来定「裁剪」口径。
 * 用法：node scripts/analyze-clip.mjs
 */
import { readFileSync } from 'node:fs'

const roads = JSON.parse(readFileSync('src/assets/GIS_Data/Zibo_roads.json', 'utf8'))

/* 路网点网格索引：cell 0.01° ≈ 1.1km × 0.9km */
const CELL = 0.01
const grid = new Map()
const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
for (const f of roads.features) {
  for (const c of f.geometry.coordinates) {
    const k = key(c[0], c[1])
    let a = grid.get(k)
    if (!a) grid.set(k, (a = []))
    a.push(c)
  }
}
const mPerDegLat = 110540
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)
function distToRoad(lng, lat) {
  const R = 12 // 搜 12 圈（最多 ~12km）
  let best = Infinity
  const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL)
  for (let i = -R; i <= R; i++) {
    for (let j = -R; j <= R; j++) {
      const a = grid.get(`${cx + i},${cy + j}`)
      if (!a) continue
      for (const c of a) {
        const dx = (c[0] - lng) * mPerDegLng(lat)
        const dy = (c[1] - lat) * mPerDegLat
        const d = dx * dx + dy * dy
        if (d < best) best = d
      }
    }
  }
  return Math.sqrt(best)
}

const res = await fetch('http://127.0.0.1:3001/api/mapdata')
const { data } = await res.json()
const POINT_TABLES = ['cameras', 'traffic_lights', 'police', 'bus_stops']
const pct = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0

for (const t of POINT_TABLES) {
  const rows = data[t] || []
  const ds = rows.map((r) => distToRoad(r.lng, r.lat))
  console.log(`\n${t}  n=${rows.length}`)
  console.log('  距离路网(m)  p50/p80/p90/p95/p99/max =',
    [0.5, 0.8, 0.9, 0.95, 0.99, 1].map((p) => Math.round(pct(ds, p))).join(' / '))
  for (const th of [300, 500, 800, 1500, 3000, 6000]) {
    console.log(`  > ${th}m 的要素：${ds.filter((d) => d > th).length}`)
  }
  // 最远的几条及其区县
  const far = rows.map((r, i) => ({ d: ds[i], r })).filter((x) => x.d > 3000).slice(0, 4)
  if (far.length) console.log('  例：', far.map((x) => `${x.r.name || x.r.cam_id || x.r.tl_id || x.r.stop_id}@${(x.r.area || x.r.district)} ${Math.round(x.d)}m`).join('; '))
}

/* 线图层：公交线路 —— 多少比例的顶点离路网 > 1km */
const bus = JSON.parse(readFileSync('src/assets/GIS_Data/bus_routes.json', 'utf8'))
let tot = 0, far1 = 0, far3 = 0
for (const f of bus.features) {
  for (const c of f.geometry.coordinates) {
    tot++
    const d = distToRoad(c[0], c[1])
    if (d > 1000) far1++
    if (d > 3000) far3++
  }
}
console.log(`\nbus_routes 顶点 n=${tot}  >1km ${far1} (${(far1 / tot * 100).toFixed(1)}%)  >3km ${far3} (${(far3 / tot * 100).toFixed(1)}%)`)
