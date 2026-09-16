/**
 * 动态车辆模拟引擎（纯前端演示层，不入库）
 *
 * 沿淄博真实路网（Zibo_roads.json 主干道）跑 ~15 辆 🚗，与「信号灯/拥堵」数据联动：
 *   信号灯：模拟器自带相位调度（绿 45s → 黄 5s → 红 45s，按灯 id 错峰），
 *           车辆遇前方 70m 内红灯/黄灯减速、10m 内停车等待，绿灯恢复行驶
 *           ——地图上的信号灯图层保持库中静态状态（仅分析层联动，见需求决策）
 *   拥堵：  车辆所在道路名命中 congestion 表 → 按该路 avg_speed 限速，
 *           level=0（严重）再降速 40%，并计入 onCongested 统计
 * 渲染：mapboxgl.Marker（DOM）+ 🚗 emoji，1 tick ≈ 0.3s 位置插值更新，
 *       内层元素按行驶方位角 rotate（外层 transform 归 mapbox 管，不能动）
 *
 * 与既有架构的接口：
 *   initVehicleSim(scene, map)  —— App.vue boot 里调用（scene 保留引用备用）
 *   setVehicleVisible(v)        —— 显示/隐藏车辆 marker，同步 store.trafficOn.vehicle
 *   （initTrafficLayers.setTrafficLayerVisible('vehicle', …) 委托到本函数，
 *     因此 RealtimeBar 开关 / AI 助手说话开关走同一条链路）
 * 数据源：store.dbData（SQL Server，后端未就绪回退 mockData 同种子单例）
 */
import mapboxgl from 'mapbox-gl'
import { reactive, watch } from 'vue'
import roadData from '@/assets/GIS_Data/Zibo_roads.json'
import { store } from '../store'
import { trafficLights as mockLights, congestion as mockCongestion } from './mockData'
import { CAR_COLORS } from './palette'

/* ================= 车辆标识：编号 + 专属颜色 =================
 * 15 辆车原来全是同一个 🚗，列表和地图对不上号。现在每辆车有
 *   - 稳定的 id（0..14）
 *   - 对用户可见的编号 carNo（id+1，即 1..15）
 *   - 专属颜色 carColor（列表行徽标与地图 marker 同源，这是「认得哪辆」的主要锚点）
 */
/** 车辆专属色（按 id 取模，色板见 palette.js） */
export const carColor = (id) => CAR_COLORS[id % CAR_COLORS.length]
/** 对用户可见的车辆编号（1 起） */
export const carNo = (car) => car.id + 1

/** 俯视车形 SVG。车头朝上 —— 与 tick 里 `angle = atan2(...) + 90` 的约定一致
 *  （那个 +90° 原本就是为了让「车头朝上」的 🚗 emoji 对准行驶方向）。
 *  车身用 currentColor，颜色由 .vehicle-marker 上的 --vm-color 提供。 */
const CAR_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="6.2" y="2.4" width="11.6" height="19.2" rx="4.6" fill="currentColor"/>
  <rect x="8.3" y="6.4" width="7.4" height="5.2" rx="1.5" fill="#fff" opacity=".55"/>
  <rect x="8.3" y="13.6" width="7.4" height="3.2" rx="1.3" fill="#fff" opacity=".35"/>
</svg>`

/* ================= 常量 ================= */
const CAR_COUNT = 15
const TICK_MS = 300            // 模拟刷新间隔（≈3.3Hz，15 个 DOM marker 无压力）
const LOOK_AHEAD_M = 70        // 前方信号灯参与决策的距离
const STOP_AT_M = 14           // 停车目标距离（含减速超调 ~6m，实际停在灯前 ~8m ≈ 停止线前）
const PHASE_GREEN_S = 45       // 绿 45s / 黄 5s / 红 45s，周期 95s
const PHASE_YELLOW_S = 5
const GEOM_TYPES = ['motorway', 'trunk', 'primary', 'secondary'] // 可行驶主干道类型
const TYPE_BASE_SPEED = { motorway: 22, trunk: 16.5, primary: 16.5, secondary: 13.9 } // m/s

/* 经纬度 → 近似米（模拟精度足够，避免 turf 依赖/开销） */
function d2m(a, b) {
  const dy = (b[1] - a[1]) * 110540
  const dx = (b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180)
  return Math.sqrt(dx * dx + dy * dy)
}

/* 稳定字符串 hash（灯相位错峰 / 车辆个体差异用） */
function strHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/* ================= 走廊抽取：有名字的主干道、优先「灯在沿线」的城区段 =================
 * 同一条路在 OSM 里被切成多段，若按名字取最长段会抽中郊区外环段（灯稀少）；
 * 且灯密段集中在张店城区少数几条路上（实测单段上限 ~4 盏/80m 折点邻域）。
 * 策略：逐 feature 统计「折点 80m 邻域内去重灯数」，按灯数排序直接取最密的多段
 * （同名路段是相互独立的可行驶走廊，面板按车显示路名，同名多车正常）。 */
function pickCorridors(count) {
  const feats = []
  for (const f of roadData.features) {
    const g = f.geometry
    if (g.type !== 'LineString' || g.coordinates.length < 4) continue
    const p = f.properties || {}
    if (!p.name || p.name === '无名称道路') continue
    if (!GEOM_TYPES.includes(p.type)) continue
    feats.push({ name: p.name, type: p.type, pts: g.coordinates })
  }
  const congestedNames = new Set(mockCongestion.map((c) => c.name))
  for (const f of feats) {
    let n = 0
    const seen = new Set()
    for (const pt of f.pts) {
      const cosLat = Math.cos(pt[1] * Math.PI / 180)
      const kx = 111320 * cosLat
      for (const L of mockLights) {
        if (seen.has(L.id)) continue
        const dy = (L.lat - pt[1]) * 110540
        if (dy > 80 || dy < -80) continue // 快速纬度剔除，免去 trig
        const dx = (L.lng - pt[0]) * kx
        if (dx * dx + dy * dy <= 6400) { seen.add(L.id); n++ }
      }
    }
    // 灯数 = 唯一主权重。不能 + 大额拥堵加成：会拿没灯的拥堵路霸占前 15 名，
    // 把灯最密的城区段挤出走廊队列（实测 perCorr 只剩 [4,2,0…]）。
    // 拥堵只是同分时的次级排序键，保证仍有车在路上缓行可演示。
    f.score = n
  }
  const ranked = feats.sort((a, b) =>
    b.score - a.score
    || (congestedNames.has(b.name) ? 1 : 0) - (congestedNames.has(a.name) ? 1 : 0)
    || b.pts.length - a.pts.length
    || strHash(b.name) - strHash(a.name))
  const picked = []
  // OSM 同名路被切成多段，每段都是独立走廊（面板按车显示路名，同名多车正常）。
  // 只约束「起点间距」防止多段挤进同一路口：先松后紧三级间距，灯密城区段全部收下。
  const spreadOf = (f, minM) => picked.every((c) => d2m(f.pts[0], c.pts[0]) >= minM)
  for (const gate of [1600, 400, 0]) {
    if (picked.length >= count) break
    for (const f of ranked) {
      if (picked.length >= count) break
      if (spreadOf(f, gate)) picked.push(f) // 已被选中者间距 0 < gate，天然不会重复入选
    }
  }
  // 每走廊：预计算折线分段累计长度（车沿弧长推进用）
  for (const c of picked) {
    const cum = [0]
    let total = 0
    for (let i = 1; i < c.pts.length; i++) { total += d2m(c.pts[i - 1], c.pts[i]); cum.push(total) }
    c.segCum = cum
    c.totalLen = total
  }
  return picked
}
const corridors = pickCorridors(CAR_COUNT)
console.log(`[vehicleSim] 走廊就绪：${corridors.length} 条主干道`, corridors.map((c) => c.name))

/* ================= 灯光源 / 拥堵源（DB → mock 回退，~18s 重建跟随数据管理面板改动） ================= */
function lightRows() {
  let rows = store.dbStatus === 'ok' ? store.dbData.traffic_lights : null
  if (!rows || !rows.length) rows = mockLights
  return rows
    .filter((r) => r.state !== 'fault') // 故障灯不参与调度（图层仍显示故障点）
    .map((r) => ({ id: String(r.tl_id ?? r.id), lng: Number(r.lng), lat: Number(r.lat) }))
}
function congestionMap() {
  let rows = store.dbStatus === 'ok' ? store.dbData.congestion : null
  if (!rows || !rows.length) rows = mockCongestion
  const m = {}
  for (const c of rows) m[c.name] = { level: Number(c.level), speed: Number(c.avg_speed ?? c.avgSpeed) || 0 } // DB 列 avg_speed / mock 字段 avgSpeed
  return m
}

/* ================= 信号灯相位（仅内存调度） ================= */
/** 秒级相位：0-45 绿 / 45-50 黄 / 50-95 红；每灯按 id 错峰 offset（0~94s） */
function lightPhaseAt(lightId, epochSec) {
  const offset = strHash(lightId) % 95
  const t = ((epochSec + offset) % 95 + 95) % 95
  if (t < PHASE_GREEN_S) return 'green'
  if (t < PHASE_GREEN_S + PHASE_YELLOW_S) return 'yellow'
  return 'red'
}

/* ================= 车辆 ================= */
function genPlate(idx) {
  const n = 80000 + (strHash('p' + idx) % 10000)
  return '鲁C·' + n
}
function makeCar(idx) {
  const corrIdx = idx % Math.max(1, corridors.length)
  const corr = corridors[corrIdx]
  const span = Math.max(1, Math.floor(corr.totalLen * 0.6))
  const along = corr.totalLen * 0.2 + (strHash('car' + idx) % span)
  return {
    id: idx,
    plate: genPlate(idx),
    corrIdx,
    road: corr.name,
    base: (TYPE_BASE_SPEED[corr.type] || 14) * (0.9 + (strHash('b' + idx) % 20) / 100), // m/s，个体差异 0.9~1.09
    along,
    dir: 1,
    speed: 8 + (strHash('s' + idx) % 40) / 10,      // m/s
    state: 'running',                               // running | waiting（红灯停）
    congested: false,                               // 当前道路命中拥堵表
    lng: 0, lat: 0, angle: 0,
    lightId: '', lightColor: 'none', lightDist: 0   // 前方 70m 内信号灯（模拟相位）
  }
}
export const vehicles = reactive(Array.from({ length: CAR_COUNT }, (_, i) => makeCar(i)))

/* ================= 模拟器状态 ================= */
let map = null
let epochSec = 0
let cacheTick = 0
let lastHistorySec = -1
let lightCache = lightRows()
let congCache = congestionMap()
let lightsAtCorridor = null // [{ cum, lights:[{id,...}...] }...] per corridor：灯挂在最近走廊点弧长上
let visible = false
let timer = null
const markers = new Map()   // car.id → mapboxgl.Marker
const forcedColor = {}      // 调试/CDP：carId → 'red'|'yellow'|'green'|'auto'(清除)
/* 选中的车共用同一个 Popup 实例（原来每次点击 new 一个，连点会叠一堆关不掉的气泡） */
let popup = null
let popupCarId = null
let popupOpen = false // 气泡当前是否挂在地图上（addTo 只能调一次，见 showPopup 注释）

/** 弧长 → 折线段下标（cum 单调递增，二分） */
function findSeg(cum, along) {
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] >= along) hi = mid
    else lo = mid + 1
  }
  return Math.min(Math.max(lo - 1, 0), cum.length - 2)
}

/* 重建灯/拥堵缓存 + 灯-走廊预匹配（每 60 tick ~18s 一次，感知数据管理面板改动）
 * 匹配算法：灯点到走廊**线段**做投影（等距柱状平面），垂距 ≤60m 即归属该走廊，
 * 挂到「灯距走廊起点的弧长」位置 —— 只查折点会把长直线路段中间的灯全漏掉。 */
function rebuildCache() {
  lightCache = lightRows()
  congCache = congestionMap()
  lightsAtCorridor = corridors.map((corr) => {
    const cosLat = Math.cos((corr.pts[0][1] + corr.pts[corr.pts.length - 1][1]) / 2 * Math.PI / 180)
    const CX = 111320 * cosLat
    const CY = 110540
    const segs = []
    for (let j = 0; j + 1 < corr.pts.length; j++) {
      const a = corr.pts[j]
      const b = corr.pts[j + 1]
      segs.push({
        ax: a[0] * CX, ay: a[1] * CY,
        bx: b[0] * CX, by: b[1] * CY,
        cum0: corr.segCum[j], len: Math.max(1, corr.segCum[j + 1] - corr.segCum[j])
      })
    }
    const out = []
    for (const L of lightCache) {
      const px = L.lng * CX
      const py = L.lat * CY
      let best = null
      for (const s of segs) {
        const vx = s.bx - s.ax
        const vy = s.by - s.ay
        const wx = px - s.ax
        const wy = py - s.ay
        const l2 = vx * vx + vy * vy
        let t = l2 ? (wx * vx + wy * vy) / l2 : 0
        t = Math.max(0, Math.min(1, t))
        const dx = wx - t * vx
        const dy = wy - t * vy
        const d = dx * dx + dy * dy
        if (!best || d < best.d2) best = { d2: d, cum: s.cum0 + t * s.len }
      }
      if (best && best.d2 <= 3600) out.push({ id: L.id, cum: best.cum }) // 60m² 半径
    }
    return out.sort((x, y) => x.cum - y.cum)
  })
}

/** 查车行进方向前方 LOOK_AHEAD_M 内最近的一盏参与决策的信号灯（桶按 cum 升序）
 * 必须按 dir 定向：dir=+1 朝 cum 增大方向开，看 cum > along 的灯；
 * dir=-1 掉头向起点开，看 cum < along 的灯。只看几何前方（cum>along）会把
 * 「背对着开」的灯也当成决策灯 —— 逼红后车反而越开越远（实测 S4 挂）。 */
function nextLightFor(car) {
  const at = lightsAtCorridor[car.corrIdx]
  if (!at) return null
  let best = null
  for (const L of at) { // 桶很小（每走廊 ≤ ~6 盏），全扫无性能顾虑
    const d = car.dir > 0 ? L.cum - car.along : car.along - L.cum
    if (d <= 0 || d > LOOK_AHEAD_M) continue // 身后灯 / 超出决策窗
    if (!best || d < best.dist) best = { id: L.id, dist: d }
  }
  return best
}

/* ================= 主循环 ================= */
function tick() {
  epochSec += TICK_MS / 1000
  cacheTick++
  if (cacheTick % 60 === 0) rebuildCache()
  if (!lightsAtCorridor) rebuildCache()

  let running = 0
  let waiting = 0
  let congested = 0
  let speedSum = 0

  for (const car of vehicles) {
    const corr = corridors[car.corrIdx]
    const nl = nextLightFor(car)
    let target = car.base
    let color = 'none'
    car.lightId = ''
    car.lightDist = 0

    if (nl) {
      color = forcedColor[car.id] || lightPhaseAt(nl.id, epochSec)
      car.lightId = nl.id
      car.lightDist = Math.round(nl.dist)
      if (color !== 'green') {
        // 红/黄：距灯越近目标速度越低；STOP_AT_M 内 → 停车目标
        target = Math.min(target, Math.max(0, (nl.dist - STOP_AT_M) * 0.9))
        if (nl.dist <= STOP_AT_M) target = 0
      }
    }
    // 拥堵联动：所在道路命中 congestion → 按真实路况限速；level=0（严重）再 ×0.6
    const cg = congCache[corr.name]
    if (cg && cg.speed > 0) {
      car.congested = true
      target = Math.min(target, (cg.speed / 3.6) * (cg.level === 0 ? 0.6 : 1))
    } else {
      car.congested = false
    }

    // 速度平滑逼近目标（加速 2.4 m/s²、减速 7 m/s² 上限，0.3s tick）
    const maxStep = (target > car.speed ? 2.4 : 7.0) * (TICK_MS / 1000)
    car.speed = target > car.speed
      ? Math.min(target, car.speed + maxStep)
      : Math.max(target, car.speed - maxStep)

    // 乒乓推进：到走廊端点掉头
    let along = car.along + car.speed * (TICK_MS / 1000) * car.dir
    if (along >= corr.totalLen - 1) { along = corr.totalLen - 1; car.dir = -1 }
    else if (along <= 1) { along = 1; car.dir = 1 }
    car.along = along

    // 弧长 → lngLat + 朝向角（分段线性插值；angle 含 +90° 是因为 🚗 emoji 车头朝上）
    const seg = findSeg(corr.segCum, along)
    const a = corr.pts[seg]
    const b = corr.pts[Math.min(seg + 1, corr.pts.length - 1)]
    const segLen = Math.max(1, d2m(a, b))
    const k = Math.min(1, Math.max(0, (along - corr.segCum[seg]) / segLen))
    car.lng = a[0] + (b[0] - a[0]) * k
    car.lat = a[1] + (b[1] - a[1]) * k
    car.angle = Math.atan2(b[1] - a[1], (b[0] - a[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180)) * 180 / Math.PI + 90
    car.lightColor = color

    car.state = car.speed < 0.4 ? 'waiting' : 'running'
    if (car.state === 'waiting') waiting++
    else running++
    if (car.congested) congested++
    speedSum += car.speed * 3.6

    const mk = markers.get(car.id)
    if (mk) {
      mk.setLngLat([car.lng, car.lat])
      mk.getElement().querySelector('.vm-inner').style.transform = `rotate(${car.angle % 360}deg)`
      syncMarkerState(car) // 类名统一走这里，别在 tick 里直接改 className
      // 气泡跟着车走（否则车开走了气泡还钉在原地）
      if (popupCarId === car.id && popup) popup.setLngLat([car.lng, car.lat]).setHTML(popupHtml(car))
    }
  }

  // 统计镜像（控制中心/列表/折线图共用）
  store.vehicleStats.total = vehicles.length
  store.vehicleStats.running = running
  store.vehicleStats.waiting = waiting
  store.vehicleStats.onCongested = congested
  store.vehicleStats.avgSpeed = vehicles.length ? Math.round((speedSum / vehicles.length) * 10) / 10 : 0
  const sec = Math.floor(epochSec)
  if (sec !== lastHistorySec) {
    lastHistorySec = sec
    const d = new Date()
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    store.vehicleStats.history.push({ t: `${hh}:${mm}:${ss}`, speed: store.vehicleStats.avgSpeed })
    if (store.vehicleStats.history.length > 60) store.vehicleStats.history.shift()
  }
}

/* ================= marker 状态同步 =================
 * 所有 marker 类名只能由这里改。
 * 起因：tick 每 300ms 跑一次，若在 tick 里用 `el.className = '...'` 覆盖式赋值，
 * 会把选中/悬停的 vm-focus / vm-hover 一起冲掉（高亮活不过 300ms）。
 * 必须用 classList.toggle 逐个开关，且选中态与 tick 状态互不覆盖。 */
function syncMarkerState(car) {
  const mk = markers.get(car.id)
  if (!mk) return
  const el = mk.getElement()
  el.classList.toggle('vm-waiting', car.state === 'waiting')
  el.classList.toggle('vm-focus', store.selectedVehicleId === car.id)
  el.classList.toggle('vm-hover', store.hoveredVehicleId === car.id)
}

/* 列表侧改选中/悬停时，立刻同步到地图（不等 tick，否则悬停高亮要慢 300ms） */
watch(
  () => [store.selectedVehicleId, store.hoveredVehicleId],
  () => {
    for (const car of vehicles) syncMarkerState(car)
  }
)

/* ================= Popup（选中车辆的详情气泡，单实例复用） ================= */
const LIGHT_ZH = { green: '绿灯', yellow: '黄灯', red: '红灯', none: '—' }

function popupHtml(car) {
  return `<b><i class="vm-popup-no" style="background:${carColor(car.id)}">${carNo(car)}</i>${car.plate}</b><br/>
    道路：${car.road}<br/>
    速度：${Math.round(car.speed * 3.6)} km/h<br/>
    状态：${car.state === 'waiting' ? '红灯等待中' : '行驶中'}${car.congested ? '（拥堵缓行）' : ''}<br/>
    前方信号灯：${LIGHT_ZH[car.lightColor] || car.lightColor}${car.lightDist ? `（距 ${car.lightDist} m）` : ''}`
}

function ensurePopup() {
  if (popup) return popup
  popup = new mapboxgl.Popup({ closeButton: true, offset: 20, className: 'vm-popup' })
  /* close 的两种来源必须区分开：
   *   - 用户主动关（气泡上的 ×，或点地图空白处触发 closeOnClick）→ 同步解除选中，
   *     否则会出现「列表还高亮着但气泡没了」；
   *   - 我们程序性 remove（hidePopup / 切换成不开气泡）→ 选中态由调用方负责，
   *     这里绝不能插一脚。
   * 判据用 popupCarId：hidePopup 会先把它清空再 remove，回调据此早退。 */
  popup.on('close', () => {
    popupOpen = false
    if (popupCarId === null) return // 程序性关闭
    popupCarId = null
    store.selectedVehicleId = null
  })
  return popup
}

function showPopup(car) {
  if (!map) return
  const p = ensurePopup()
  popupCarId = car.id
  p.setLngLat([car.lng, car.lat]).setHTML(popupHtml(car))
  /* ★ 只在「当前没显示」时才 addTo，已显示就只更新内容。
   *
   * mapbox-gl 2.14 的 Popup.addTo 第一句是 `this._map && this.remove()`，而
   * Popup.remove() 结尾是 `this.fire(new Event('close'))` —— 注意这个 fire 是
   * 无条件的，不看有没有挂在地图上。于是「点第二辆车」这条最普通的路径会变成：
   *   selectVehicle 设好选中 → showPopup → addTo → remove() → fire('close')
   *   → close 回调把 selectedVehicleId 清成 null，且 popupCarId 也一起清掉。
   * 结果是刚点中的车不高亮，气泡内容虽然换成了新车却再没人能关掉它
   * （popupCarId 为 null 时 hidePopup 直接早退）。实测由 cdp-probe8 的 S5 抓到。 */
  if (!popupOpen) {
    p.addTo(map)
    popupOpen = true
  }
}

function hidePopup() {
  if (!popup || !popupOpen) return
  popupCarId = null // 先清空：close 回调据此判定为程序性关闭
  popupOpen = false
  popup.remove()
}

/* ================= 选中 / 清除（列表与地图共用同一入口） ================= */
/**
 * 选中某辆车：高亮 marker + 对应列表行 +（可选）飞行定位与详情气泡。
 * @param {number} id 车辆 id（0..14）
 * @param {{fly?:boolean, zoom?:number, openPopup?:boolean}} [opts]
 */
export function selectVehicle(id, { fly = false, zoom = 15, openPopup = false } = {}) {
  const car = vehicles.find((v) => v.id === id)
  if (!car) return
  store.selectedVehicleId = id
  if (fly && map) {
    map.stop() // 打断在途动画（首页 flyTo / 自转 ease），否则相机指令互相打断
    map.flyTo({ center: [car.lng, car.lat], zoom, duration: 1200, essential: true })
  }
  if (openPopup) showPopup(car)
  else hidePopup()
}

/** 清除选中（关闭气泡、去掉所有高亮） */
export function clearVehicleSelection() {
  store.selectedVehicleId = null
  hidePopup()
}

/* ================= marker / 开关 ================= */
function buildMarker(car) {
  const el = document.createElement('div')
  el.className = 'vehicle-marker'
  el.dataset.carId = String(car.id)
  // 专属色挂在 marker 根节点上：车身 SVG 用 currentColor、徽标用 var(--vm-color)，同源
  el.style.setProperty('--vm-color', carColor(car.id))
  // 徽标必须是 .vm-inner 的兄弟节点 —— .vm-inner 的 transform 每 tick 被 inline rotate 覆盖
  el.innerHTML = `<span class="vm-inner">${CAR_SVG}</span><b class="vm-badge">${carNo(car)}</b>`

  const m = new mapboxgl.Marker({ element: el, anchor: 'center' })
    .setLngLat([car.lng, car.lat])
    .addTo(map)

  el.addEventListener('click', (e) => {
    e.stopPropagation() // 关键：mapboxgl.Popup 默认 closeOnClick（监听地图容器 click），
    // 不挡住的话同一个 click 冒泡到容器，会把刚弹出的详情窗立刻关掉
    selectVehicle(car.id, { openPopup: true })
  })
  el.addEventListener('mouseenter', () => { store.hoveredVehicleId = car.id })
  el.addEventListener('mouseleave', () => { store.hoveredVehicleId = null })

  markers.set(car.id, m)
  // 建的时候就把当前状态刷上：图层关掉再打开时，之前选中的车应当仍是高亮的
  syncMarkerState(car)
}

/** 显示/隐藏车辆图层（唯一写入 store.trafficOn.vehicle 的地方，避免双写漂移） */
export function setVehicleVisible(v) {
  visible = !!v
  store.trafficOn.vehicle = visible
  if (!map) return
  if (visible) {
    if (!markers.size) vehicles.forEach((car) => buildMarker(car))
    else markers.forEach((m) => { m.getElement().style.display = '' })
    /* 选中态是跨开关保留的（见 buildMarker 注释），所以重开图层时要把它的详情气泡一并挂回来，
     * 否则会留下「车高亮着、却没有详情」的半个状态。 */
    if (store.selectedVehicleId !== null) {
      const car = vehicles.find((c) => c.id === store.selectedVehicleId)
      if (car) showPopup(car)
    }
  } else {
    markers.forEach((m) => { m.getElement().style.display = 'none' })
    /* 关图层必须连气泡一起收：气泡是挂在车上的，车既然不可见了，气泡就没有着落。
     * 而且 tick 一直在跑，气泡会跟着那辆隐形的车在图上自己漂（实测：关掉「动态车辆」
     * 后气泡仍浮在地图上并持续移动）。关图层与面板 ✕ 都走这里，一处覆盖两条入口。 */
    hidePopup()
  }
}

/** App.vue 地图 boot 后调用一次；逻辑层随模块加载即跑，开图层时才建 marker */
export function initVehicleSim(scene, mapboxMap) {
  map = mapboxMap
  rebuildCache()
  // 车辆起点就位（沿弧长定位到坐标，面板在未开图层时也能读到真实位置）
  for (const car of vehicles) {
    const corr = corridors[car.corrIdx]
    const seg = findSeg(corr.segCum, car.along)
    const a = corr.pts[seg]
    const b = corr.pts[Math.min(seg + 1, corr.pts.length - 1)]
    const k = Math.min(1, Math.max(0, (car.along - corr.segCum[seg]) / Math.max(1, d2m(a, b))))
    car.lng = a[0] + (b[0] - a[0]) * k
    car.lat = a[1] + (b[1] - a[1]) * k
  }
  if (!timer) timer = setInterval(tick, TICK_MS)
  if (import.meta.env.DEV) {
    window.__vehicleSim = {
      vehicles,
      stats: () => ({ ...store.vehicleStats }),
      setVisible: setVehicleVisible,
      corridors: corridors.map((c) => c.name),
      /** CDP 验证钩子：forceLight(carId, 'red'|'yellow'|'green'|'auto') */
      forceLight: (id, color) => { forcedColor[id] = color },
      /** 探针：灯光源规模 / 每走廊灯桶 / 当前前方有灯车辆数（联调用） */
      debug: () => ({
        dbStatus: store.dbStatus,
        lightCount: lightCache.length,
        congCount: Object.keys(congCache).length,
        perCorr: lightsAtCorridor.map((a) => a.length),
        corrLighted: lightsAtCorridor.filter((a) => a.length).length,
        carOnLight: vehicles.filter((v) => v.lightId !== '').length
      }),
      tick,
      /* ---- 选中联动（任务3）---- */
      select: selectVehicle,
      clearSelection: clearVehicleSelection,
      selected: () => store.selectedVehicleId,
      hovered: () => store.hoveredVehicleId,
      /** 编号 / 颜色 / 编号徽标文本，供探针断言「列表与地图同源」 */
      carNo,
      carColor,
      /** 当前所有 marker 上实际渲染出的徽标编号（按 DOM 顺序） */
      badgeNos: () =>
        [...document.querySelectorAll('.vehicle-marker .vm-badge')].map((b) => b.textContent),
      /** 某个编号的 marker 当前类名（断言高亮状态用） */
      markerClass: (no) =>
        (document.querySelector(`.vehicle-marker[data-car-id="${no - 1}"]`) || {}).className || null
    }
  }
}
