/**
 * 路网覆盖判定 —— 交通图层的「裁剪」口径（用户 2026-09-15 提的第 2 条：
 * 「每个图层的数据都要在总道路范围内，不要超出」）。
 *
 * 为什么要裁剪：底图那层「总道路」（淄博道路）只画了淄博市区一带，而库里的
 * 信号灯有 191/231、警员有 46/62 落在临淄/淄川/博山那些**没有路网的地方** ——
 * 地图上就是一堆孤零零飘在空白处的符号（这正是用户看到的「超出」）。
 *
 * 口径（用户 2026-09-15 拍板「只裁地图图层」）：
 *   · 只影响地图：图层工厂里过滤掉离路网 > MAX_M 的要素；
 *     数据管理面板、交通大屏 KPI、控制中心图表仍按**全量库表**显示（库里多少就是多少，能继续编辑）。
 *     代价（已与用户确认）：大屏数字（信号灯 231）会与地图上看到的点数（40）对不上。
 *   · 阈值 MAX_M = 500 米，实测依据（scripts/analyze-clip.mjs，2026-09-15 跑的数）：
 *       监控探头 220 个全部**落点即路网顶点**（p50/max 都是 0m）、公交站最远 254m —— 500m 对这两层
 *       等于不裁，它们本来就贴在路上；
 *       信号灯 40 个 ≤500m、其余 191 个全部 >12km（搜不到任何路网顶点）；
 *       警员 16 个 ≤500m（最远 442m），其余 46 个 ≥3km（最近的 3009m）—— 442m 与 3009m 之间是空档，
 *       阈值取在空档里，结论对具体取值不敏感。
 *   · 公交线路 4744 个顶点**没有一个** >500m，拥堵 22 条全部落在路网上 —— 线状图层实际不受影响，
 *     但仍走同一套判定（其余数据将来变脏时不会静默跑出去）。
 *
 * 实现：路网顶点网格索引（模块加载时建一次，0.01° ≈ 1.1km×0.9km 一格）。
 * 用「点到最近路网**顶点**的距离」近似「点到路的距离」：路网顶点在源数据里足够密
 * （见上面实测：探头全部命中 0m），近似误差远小于 500m 这个量级。
 */
import roadData from '@/assets/GIS_Data/Zibo_roads.json'

const CELL = 0.01 // 网格边长（度）
const R = 3 // 搜索半径（格）：0.03° ≈ 3.3km，覆盖 MAX_M 判定绰绰有余

/** 判定阈值（米）：离最近路网顶点超过这个距离 ⇒ 视为「跑出总道路范围」 */
export const MAX_M = 500

const M_PER_DEG_LAT = 110540
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)

/* ---------------- 网格索引（模块加载时一次） ---------------- */
const grid = new Map()
const cellKey = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL)
for (const f of roadData.features) {
  const coords = f.geometry && f.geometry.coordinates
  if (!coords) continue
  for (const c of coords) {
    const k = cellKey(c[0], c[1])
    let arr = grid.get(k)
    if (!arr) grid.set(k, (arr = []))
    arr.push(c)
  }
}

/**
 * 到最近路网顶点的距离（米）。3km 内一个路网顶点都没有时返回 Infinity —— 调用方只做阈值比较，
 * 不会拿它去做算术。
 */
export function distToRoad(lng, lat) {
  const cx = Math.floor(lng / CELL)
  const cy = Math.floor(lat / CELL)
  const kx = mPerDegLng(lat)
  let best = Infinity
  for (let i = -R; i <= R; i++) {
    for (let j = -R; j <= R; j++) {
      const arr = grid.get(`${cx + i},${cy + j}`)
      if (!arr) continue
      for (const c of arr) {
        const dx = (c[0] - lng) * kx
        const dy = (c[1] - lat) * M_PER_DEG_LAT
        const d = dx * dx + dy * dy
        if (d < best) best = d
      }
    }
  }
  return Math.sqrt(best)
}

/** 该点是否落在总道路范围内（阈值内直接 true，超过即 false） */
export const onRoad = (lng, lat) => distToRoad(lng, lat) <= MAX_M

/** 点要素集合裁剪：丢掉跑出路网的点（FeatureCollection → FeatureCollection，不改数据） */
export function clipPoints(fc) {
  if (!fc || !Array.isArray(fc.features)) return fc
  return { ...fc, features: fc.features.filter((f) => onRoad(f.geometry.coordinates[0], f.geometry.coordinates[1])) }
}

/**
 * 线要素集合裁剪：把每条线**按顶点**切成「连续在范围内」的若干段，
 * 跑出去的那几段直接丢掉（而不是整条线丢掉 —— 一条跨区线路不该因为尾巴出界就整条看不见）。
 * 段长 <2 个顶点的片段丢弃（画不出来）。
 * 输出可能从 LineString 变成 MultiLineString，L7 两种都认。
 */
export function clipLines(fc) {
  if (!fc || !Array.isArray(fc.features)) return fc
  const features = []
  for (const f of fc.features) {
    const g = f.geometry
    if (!g || g.type !== 'LineString') {
      features.push(f)
      continue
    }
    const runs = []
    let cur = []
    for (const c of g.coordinates) {
      if (onRoad(c[0], c[1])) cur.push(c)
      else {
        if (cur.length >= 2) runs.push(cur)
        cur = []
      }
    }
    if (cur.length >= 2) runs.push(cur)
    if (!runs.length) continue
    features.push({
      ...f,
      geometry: runs.length === 1 ? { type: 'LineString', coordinates: runs[0] } : { type: 'MultiLineString', coordinates: runs }
    })
  }
  return { ...fc, features }
}
