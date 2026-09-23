<template>
  <div class="ts-screen" role="dialog" aria-label="淄博市交通可视化大屏">
    <!-- ===================== 顶栏：标题 + 数据源徽标 + KPI ===================== -->
    <div class="ts-header">
      <div class="ts-title">
        <i class="iconfont icon-gaikuang"></i>
        <b>淄博市交通可视化大屏</b>
        <!-- 数据源徽标：把「库里来的数」和「前端模拟的实时数」分开讲清楚，
             否则用户会以为满屏数字都在实时跳动（这 10 张表根本没有时间戳列） -->
        <span class="ts-badge" :class="dbBadge.tone" :title="store.dbError || '数据来自 SQL Server 业务表快照'">
          {{ dbBadge.text }}
        </span>
      </div>
      <div class="ts-kpis">
        <div v-for="k in kpis" :key="k.label" class="ts-kpi">
          <b class="screen-num">{{ k.value }}</b>
          <span class="ts-kpi-name">{{ k.label }}</span>
          <span class="item-sub" :class="k.tone">{{ k.sub }}</span>
        </div>
      </div>
      <span class="ui-close" title="关闭大屏（Esc）" @click="close">✕</span>
    </div>

    <!-- ===================== 主体：6 张卡 ===================== -->
    <div class="ts-grid">
      <!-- ① 区县穿透统计：把 6 张互不相关的表按区县聚到一起（原来只能 一张一张图层看） -->
      <div class="ts-card ui-panel" data-card="district">
        <div class="ui-panel-title">
          区县穿透统计
          <span class="item-sub ts-title-sub">6 类数据源按区县聚合</span>
        </div>
        <div class="ts-list">
          <div v-for="d in districtRows" :key="d.name" class="ts-row"
            :class="{ on: isActive('district:' + d.name) }" role="button" tabindex="0"
            @click="pick('district:' + d.name)" @keydown.enter.prevent="pick('district:' + d.name)"
            @dblclick="locateActive">
            <span class="ts-row-name">{{ d.name }}</span>
            <span class="item-sub">覆盖 {{ d.covered }}/6 源</span>
            <span class="ts-nums">
              <i>探头 <b :class="{ zero: !d.camera }">{{ d.camera }}</b>
                <em v-if="d.cameraFault">故障 {{ d.cameraFault }}</em></i>
              <i>信号灯 <b :class="{ zero: !d.light }">{{ d.light }}</b>
                <em v-if="d.lightFault">故障 {{ d.lightFault }}</em></i>
              <i>警力 <b :class="{ zero: !d.police }">{{ d.police }}</b>
                <em v-if="d.policeOff">离勤 {{ d.policeOff }}</em></i>
              <i>拥堵 <b :class="{ zero: !d.congestion }">{{ d.congestion }}</b>
                <em v-if="d.congestSevere">严重 {{ d.congestSevere }}</em></i>
              <i>警情 <b :class="{ zero: !d.alert }">{{ d.alert }}</b>
                <em v-if="d.alertPending">待处置 {{ d.alertPending }}</em></i>
              <i>事件 <b :class="{ zero: !d.event }">{{ d.event }}</b></i>
            </span>
          </div>
          <p v-if="!districtRows.length" class="ts-empty item-sub">{{ EMPTY }}</p>
        </div>
        <!-- 源数据覆盖说明：探头/信号灯/拥堵三类只覆盖部分区县，不写清楚的话
             「点开博山区一整屏 0」会被当成 bug -->
        <p class="item-sub ts-note">
          源数据限制：探头覆盖 4 个区县、信号灯 4 个、拥堵 3 个；警力与事件为 8 区县全覆盖。
          <b>0 表示该区无此类设施</b>，不是告警。
        </p>
      </div>

      <!-- ② 拥堵路段排行：点一条 → 底部详情 → 「在地图上查看」飞过去并打开拥堵图层 -->
      <div class="ts-card ui-panel" data-card="congestion">
        <div class="ui-panel-title">
          拥堵路段排行
          <span class="item-sub ts-title-sub">按流量降序 · {{ congestRank.length }} 条</span>
        </div>
        <div class="ts-list">
          <div v-for="c in congestRank" :key="c.id" class="ts-row"
            :class="{ on: isActive('congestion:' + c.id) }" role="button" tabindex="0"
            @click="pick('congestion:' + c.id)" @keydown.enter.prevent="pick('congestion:' + c.id)"
            @dblclick="locateActive">
            <span class="ts-row-name ts-ellipsis">{{ c.name }}</span>
            <span class="item-sub">{{ c.area }}</span>
            <span class="ts-bar"><i :style="{ width: barW(c.flow), background: levelColor(c.level) }"></i></span>
            <span class="ts-row-val">{{ c.flow }}<i>辆/h</i></span>
            <span class="item-sub">{{ c.level_name }} · {{ c.avg_speed }}km/h</span>
          </div>
          <p v-if="!congestRank.length" class="ts-empty item-sub">{{ EMPTY }}</p>
        </div>
      </div>

      <!-- ③ 待处置警情：这类数据**没有对应地图图层**，定位靠飞行 + 要素气泡 -->
      <div class="ts-card ui-panel" data-card="alert">
        <div class="ui-panel-title">
          警情处置清单
          <span class="item-sub ts-title-sub">待处置优先 · 按已过时长降序</span>
        </div>
        <div class="ts-chips">
          <span v-for="f in alertFilters" :key="f.key" class="ts-chip"
            :class="{ on: alertFilter === f.key }" @click="alertFilter = f.key">
            {{ f.label }} {{ f.n }}
          </span>
        </div>
        <div class="ts-list">
          <div v-for="a in alertRank" :key="a.id" class="ts-row"
            :class="{ on: isActive('alert:' + a.id) }" role="button" tabindex="0"
            @click="pick('alert:' + a.id)" @keydown.enter.prevent="pick('alert:' + a.id)"
            @dblclick="locateActive">
            <span class="ts-lv" :class="'lv' + a.level">{{ a.level }}级</span>
            <span class="ts-row-name">{{ a.type }}</span>
            <span class="item-sub ts-ellipsis">{{ a.area }} · {{ a.road }}</span>
            <span class="ts-row-val">{{ a.minutes_ago }}<i>分钟前</i></span>
            <span class="ts-tag" :class="a.status">{{ a.status === 'pending' ? '待处置' : '处理中' }}</span>
          </div>
          <p v-if="!alertRank.length" class="ts-empty item-sub">当前筛选下没有警情记录</p>
        </div>
      </div>

      <!-- ④ 设备工况巡检：三类故障汇成一张「待处理清单」 -->
      <div class="ts-card ui-panel" data-card="fault">
        <div class="ui-panel-title">
          设备工况巡检
          <span class="item-sub ts-title-sub">按影响通行程度排序</span>
        </div>
        <div class="ts-chips">
          <span v-for="f in faultChips" :key="f.key" class="ts-chip"
            :class="{ on: faultFilter === f.key, zero: !f.n }" @click="faultFilter = f.key">
            {{ f.label }} {{ f.n }}
          </span>
        </div>
        <div class="ts-list">
          <div v-for="f in faultList" :key="f.key" class="ts-row"
            :class="{ on: isActive(f.key) }" role="button" tabindex="0"
            @click="pick(f.key)" @keydown.enter.prevent="pick(f.key)" @dblclick="locateActive">
            <span class="ts-tag" :class="f.kind">{{ f.kindLabel }}</span>
            <span class="ts-row-name">{{ f.name }}</span>
            <span class="item-sub">{{ f.area }}</span>
            <span class="item-sub ts-ellipsis">{{ f.road }}</span>
          </div>
          <p v-if="!faultList.length" class="ts-empty item-sub">
            {{ faultRows.length ? '当前筛选下没有记录' : '巡检正常：无故障探头 / 故障信号灯 / 离勤警员' }}
          </p>
        </div>
      </div>

      <!-- ⑤ 车辆实时追踪：15 辆车的编号/颜色与地图 marker、左侧车辆面板三方同源 -->
      <div class="ts-card ui-panel" data-card="vehicle">
        <div class="ui-panel-title">
          车辆实时追踪
          <span class="item-sub ts-title-sub">前端模拟 · 300ms 刷新</span>
        </div>
        <div class="ts-vstat">
          <span>行驶 <b class="ok">{{ vs.running }}</b></span>
          <span>红灯停 <b class="warn">{{ vs.waiting }}</b></span>
          <span>拥堵缓行 <b class="warn">{{ vs.onCongested }}</b></span>
          <span>均速 <b class="cy">{{ vs.avgSpeed }}</b> km/h</span>
        </div>
        <div class="ts-vlayer">
          <span class="item-sub">地图车辆图层：{{ store.trafficOn.vehicle ? '已开' : '已关' }}</span>
          <span v-if="!store.trafficOn.vehicle" class="ts-chip on" @click="setTrafficLayerVisible('vehicle', true)">
            打开图层
          </span>
        </div>
        <div class="ts-list">
          <div v-for="v in vehicles" :key="v.id" class="ts-row"
            :class="{ on: isActive('vehicle:' + v.id) }" :style="{ '--vm-color': carColor(v.id) }"
            role="button" tabindex="0" @click="pick('vehicle:' + v.id)"
            @keydown.enter.prevent="pick('vehicle:' + v.id)" @dblclick="locateActive"
            @mouseenter="store.hoveredVehicleId = v.id" @mouseleave="store.hoveredVehicleId = null">
            <b class="ts-no">{{ carNo(v) }}</b>
            <span class="ts-dot" :class="v.state"></span>
            <span class="ts-plate">{{ v.plate }}</span>
            <span class="item-sub ts-ellipsis">{{ v.road }}</span>
            <span class="ts-light" :class="v.lightColor">{{ v.lightColor === 'none' ? '·' : '◉' }}</span>
            <span class="ts-row-val">{{ kmh(v) }}<i>km/h</i></span>
          </div>
        </div>
      </div>

      <!-- ⑥ 运行态势：唯一一处真·实时序列（每秒刷新） -->
      <div class="ts-card ui-panel" data-card="trend">
        <div class="ui-panel-title">
          运行态势
          <span class="item-sub ts-title-sub">近 60 秒 · 每秒刷新</span>
        </div>
        <div class="ts-cong3">
          <div v-for="(lv, i) in congLevels" :key="i" class="ts-cong3-item">
            <b class="screen-num" :class="lv.tone">{{ lv.n }}</b>
            <span class="item-sub">{{ lv.label }}</span>
          </div>
        </div>
        <div class="g2-body">
          <LineChart v-bind="lineChart" />
        </div>
        <p class="item-sub ts-note">
          车队均速实时曲线（唯一实时序列，每秒 1 点）；本屏其余数字均为业务表快照。
        </p>
      </div>
    </div>

    <!-- ===================== 底部详情条 =====================
         点行 = 看（不动地图），点这里的按钮 = 去（关大屏并在地图上定位）。
         全屏大屏没有"半屏让位"形态，所以「去」必须把大屏关掉，否则飞过去也看不见。 -->
    <div class="ts-detail" v-if="detail">
      <span class="ts-detail-kind">{{ detail.kind }}</span>
      <span v-for="d in detail.items" :key="d.k" class="ts-detail-item"><i>{{ d.k }}</i>{{ d.v }}</span>
      <span class="item-sub">{{ detail.hint }}</span>
      <el-button type="primary" size="small" @click="locateActive">在地图上查看</el-button>
    </div>
  </div>
</template>

<script>
import { Popup } from '@antv/l7'

/* 大屏私有的要素气泡，做成**模块级单例**（写法对齐 initTrafficLayers.js:56）。
 * 不随组件卸载销毁：「关掉大屏」正是联动结果要被看见的时刻，若在 onUnmounted 里 close()，
 * 用户点完「在地图上查看」会看到气泡凭空消失；而每次挂载各建一个，又会随开关次数堆出多个气泡。 */
const popup = new Popup({ closeButton: true, offsets: [0, -10] })

const showPopup = (scene, lngLat, html) => {
  if (!scene) return
  popup.setLnglat(lngLat).setHTML(html)
  if (!popup.isOpen()) scene.addPopup(popup) // 重复 add 同一实例会重复入栈
}
</script>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { LineChart } from '@opd/g2plot-vue'
import { store } from '../store'
import { AXIS_TEXT, DANGER, OK, PRIMARY, WARN } from '@/tools/palette'
import { vehicles, carColor, carNo, selectVehicle } from '@/tools/vehicleSim'
import { setTrafficLayerVisible } from '@/tools/initTrafficLayers'
import { useMapReady } from '@/Hooks/useMapReady'

const EMPTY = '数据库未连接或无数据：请启动后端服务并执行 db/seed.sql 入库'

/* ===================== 数据读取 =====================
 * 严格只读 store.dbData / store.vehicleStats / vehicles —— 本屏的卖点就是「把库里的数据
 * 用起来」，混入演示兜底数据会让满屏数字失去意义，也没法和控制中心、数据管理对账。
 * 库没连上时各卡走空态文案，不假装有数。 */
const rows = (t) => store.dbData[t] || []

const dbBadge = computed(() => {
  if (store.dbStatus === 'ok') return { text: '实时库已连接', tone: 'ok' }
  if (store.dbStatus === 'loading') return { text: '数据加载中…', tone: 'warn' }
  return { text: '数据库未连接', tone: 'warn' }
})

/* 在勤口径与控制中心 G2Charts.vue:103 完全一致（库表列是 on_duty，本地兜底数据是 onDuty） */
const onDuty = (p) => p.onDuty === true || p.on_duty === true

/* ===================== 顶栏 KPI =====================
 * 八块磁贴全部现算自库表 / 实时源，没有一个写死的数字。副行必须写明口径与来源，
 * 否则用户会以为 220 个探头也在逐秒跳动（这 10 张业务表里根本没有时间戳列）。 */
const kpis = computed(() => {
  const cam = rows('cameras')
  const light = rows('traffic_lights')
  const pol = rows('police')
  const alerts = rows('alerts')
  const cong = rows('congestion')
  const vs = store.vehicleStats
  const faultCamN = cam.filter((c) => c.status === 'fault').length
  const faultLightN = light.filter((l) => l.state === 'fault').length
  const onDutyN = pol.filter(onDuty).length
  const pendingN = alerts.filter((a) => a.status === 'pending').length
  const severeN = cong.filter((c) => c.level === 0).length
  return [
    { label: '监控探头', value: cam.length, sub: `故障 ${faultCamN}`, tone: faultCamN ? 'warn' : 'ok' },
    { label: '信号灯', value: light.length, sub: `故障 ${faultLightN}`, tone: faultLightN ? 'warn' : 'ok' },
    { label: '在勤警力', value: `${onDutyN}/${pol.length}`, sub: `离勤 ${pol.length - onDutyN}`, tone: 'ok' },
    { label: '待处置警情', value: pendingN, sub: `共 ${alerts.length} 条`, tone: pendingN ? 'warn' : 'ok' },
    { label: '拥堵路段', value: cong.length, sub: `严重 ${severeN}`, tone: severeN ? 'warn' : 'ok' },
    { label: '公交线路', value: rows('bus_routes').length, sub: `站点 ${rows('bus_stops').length}`, tone: 'ok' },
    { label: '模拟车辆', value: vs.total, sub: `行驶 ${vs.running}`, tone: 'ok' },
    { label: '车队均速', value: vs.avgSpeed, sub: '近 60 秒 · 实时', tone: 'ok' },
  ]
})

/* ===================== 地图就绪（不要直接读 sm.map） =====================
 * 直接刷新时子组件 mounted 早于 App 的地图 boot()，裸读 sm.map 会是 null；
 * useMapReady 把两条路径（已就绪 / 等容器赋值）收口，见 Hooks/useMapReady.js 注释。 */
let mapRef = null
let sceneRef = null
/* ★ useMapReady() 只返回 { onReady }，本身不吃回调。写成 useMapReady(cb) 时回调会被静默丢掉：
 * mapRef/sceneRef 永远是 null，flyTo/showPopup 双双空转 —— 点「在地图上查看」只剩关屏、
 * 地图纹丝不动，且不报任何错（本文件就这么错过一次，靠 CDP 探针的地图位移断言抓出来）。 */
const { onReady } = useMapReady()
onReady((map, scene) => {
  mapRef = map
  sceneRef = scene
})

/* ===================== 选中态与详情条 =====================
 * 全屏唯一选中：key 形如 'district:张店区' / 'congestion:12' / 'alert:JQ20260000'
 * / 'fault:camera:CAM1000' / 'vehicle:3'。点行只改这个 ref，不动地图。 */
const active = ref('')
const isActive = (k) => active.value === k
const pick = (k) => {
  active.value = active.value === k ? '' : k
}
const close = () => {
  store.screenOpen = false
}

/* ===================== 定位动作（唯一出口 locateActive） ===================== */
const flyTo = (lng, lat, zoom) => {
  if (!mapRef) return
  /* ★ 必须先 stop()：地球自转 / 首页的 flyTo 在途时，相机会互相打断、飞不到位
   *（vehicleSim.js:462 里 selectVehicle 也是这么处理的） */
  mapRef.stop()
  mapRef.flyTo({ center: [lng, lat], zoom, duration: 1100, essential: true })
}

/* 各类要素 → 地图图层名。警情/事件**没有对应图层**（initTrafficLayers 里没有这两类），
 * 所以它们的「在地图上查看」靠飞行 + 要素气泡，不去调不存在的图层。
 * 车辆走 vehicleSim 的 selectVehicle（飞过去 + marker 高亮光环 + 气泡 + 左侧面板联动）。 */
const LAYER_OF = { camera: 'camera', trafficLight: 'trafficLight', police: 'police', congestion: 'congestion' }

const locateActive = () => {
  const t = detail.value?.target
  if (!t) return
  if (t.type === 'vehicle') {
    setTrafficLayerVisible('vehicle', true)
    selectVehicle(t.id, { fly: true, zoom: 15, openPopup: true })
  } else if (t.type === 'district') {
    // 区县不自动开图层：一个区县同时命中 5 类要素，全开会在 1 秒内堆 7 个图层把地图糊住。
    // 改为在该区中心弹出汇总气泡 —— 既能看到"落到哪了"，也能看到这个区的全部数字。
    flyTo(t.lng, t.lat, 10.5)
    showPopup(sceneRef, [t.lng, t.lat], t.html)
  } else {
    if (t.layer) setTrafficLayerVisible(t.layer, true)
    flyTo(t.lng, t.lat, t.zoom)
    showPopup(sceneRef, [t.lng, t.lat], t.html)
  }
  close() // 全屏盖着地图，不关掉就看不见刚才的联动结果
}

/* ===================== ① 区县穿透统计 ===================== */
/* 连接键逐表写死：只有 police 用 district，其余 6 张用 area。
 * 不要写成 r.area || r.district —— police 没有 area 列，看似"兼容"实则会把
 * location（"张店区淄河大道路段"这类值）当成区县静默匹配错。 */
const AREA_KEY = {
  cameras: (r) => r.area,
  traffic_lights: (r) => r.area,
  police: (r) => r.district,
  congestion: (r) => r.area,
  alerts: (r) => r.area,
  events: (r) => r.area
}

const districtRows = computed(() => {
  const at = (t, name) => rows(t).filter((r) => AREA_KEY[t](r) === name)
  return rows('districts').map((d) => {
    const c = at('cameras', d.name)
    const l = at('traffic_lights', d.name)
    const p = at('police', d.name)
    const g = at('congestion', d.name)
    const a = at('alerts', d.name)
    const e = at('events', d.name)
    return {
      name: d.name,
      lng: d.lng,
      lat: d.lat,
      population: Number(d.population) || 0,
      camera: c.length,
      cameraFault: c.filter((x) => x.status === 'fault').length,
      light: l.length,
      lightFault: l.filter((x) => x.state === 'fault').length,
      police: p.length,
      policeOff: p.filter((x) => !onDuty(x)).length,
      congestion: g.length,
      congestSevere: g.filter((x) => x.level === 0).length,
      avgSpeed: g.length ? Math.round(g.reduce((s, x) => s + (Number(x.avg_speed) || 0), 0) / g.length) : 0,
      alert: a.length,
      alertPending: a.filter((x) => x.status === 'pending').length,
      event: e.length,
      /* 覆盖度：6 类源里该区有几类真的有数据（源数据只覆盖部分区县） */
      covered: [c, l, g, a, p, e].filter((arr) => arr.length > 0).length
    }
  })
})

/* ===================== ② 拥堵路段排行 ===================== */
const congestRank = computed(() =>
  rows('congestion').slice().sort((a, b) => (b.flow || 0) - (a.flow || 0))
)
const LEVEL_COLOR = [DANGER, WARN, OK] // level 0 严重 / 1 中度 / 2 轻度
const levelColor = (lv) => LEVEL_COLOR[lv] || OK
const barW = (flow) => {
  const max = congestRank.value[0]?.flow || 1
  return Math.max(6, Math.round(((flow || 0) / max) * 100)) + '%'
}

/* ===================== ③ 警情处置清单 ===================== */
const alertFilter = ref('all')
const alertFilters = computed(() => [
  { key: 'all', label: '全部', n: rows('alerts').length },
  { key: 'pending', label: '待处置', n: rows('alerts').filter((a) => a.status === 'pending').length },
  { key: 'handling', label: '处理中', n: rows('alerts').filter((a) => a.status === 'handling').length }
])
const alertRank = computed(() =>
  rows('alerts')
    .filter((a) => alertFilter.value === 'all' || a.status === alertFilter.value)
    /* 待处置排前面，同组内按已过时长降序 —— minutes_ago 是这些表里唯一的时间线索 */
    .slice()
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.minutes_ago || 0) - (a.minutes_ago || 0))
)

/* ===================== ④ 设备工况巡检 ===================== */
/* 口径：探头 status==='fault'、信号灯 state==='fault'、警员非在勤（与控制中心同一口径） */
const faultRows = computed(() => {
  const out = []
  for (const l of rows('traffic_lights').filter((x) => x.state === 'fault')) {
    out.push({ key: 'fault:trafficLight:' + l.tl_id, kind: 'trafficLight', kindLabel: '信号灯故障', name: l.name || l.tl_id, area: l.area, road: '状态 ' + l.state, lng: l.lng, lat: l.lat, zoom: 17, raw: l })
  }
  for (const p of rows('police').filter((x) => !onDuty(x))) {
    out.push({ key: 'fault:police:' + p.pol_id, kind: 'police', kindLabel: '警员离勤', name: p.name, area: p.district, road: p.location, lng: p.lng, lat: p.lat, zoom: 17, raw: p })
  }
  for (const c of rows('cameras').filter((x) => x.status === 'fault')) {
    out.push({ key: 'fault:camera:' + c.cam_id, kind: 'camera', kindLabel: '探头故障', name: c.name, area: c.area, road: c.road, lng: c.lng, lat: c.lat, zoom: 17, raw: c })
  }
  return out
})
const faultFilter = ref('all')
const faultChips = computed(() => [
  { key: 'all', label: '全部', n: faultRows.value.length },
  { key: 'trafficLight', label: '信号灯', n: faultRows.value.filter((f) => f.kind === 'trafficLight').length },
  { key: 'police', label: '警力', n: faultRows.value.filter((f) => f.kind === 'police').length },
  { key: 'camera', label: '探头', n: faultRows.value.filter((f) => f.kind === 'camera').length }
])
const faultList = computed(() =>
  faultFilter.value === 'all' ? faultRows.value : faultRows.value.filter((f) => f.kind === faultFilter.value)
)

/* ===================== ⑤ 车辆实时追踪 ===================== */
/* 列表顺序固定按 id 升序：这些行每 300ms 重渲染一次，若跟着速度实时重排，
 * 肉眼完全没法读（行会一直跳）。要排序只能做成"点一下排一次"的快照排序。 */
const vs = computed(() => store.vehicleStats)
const kmh = (v) => Math.round(v.speed * 3.6)

/* ===================== ⑥ 运行态势 ===================== */
const congLevels = computed(() => {
  const g = rows('congestion')
  return [
    { label: '严重拥堵', n: g.filter((x) => x.level === 0).length, tone: 'danger' },
    { label: '中度拥堵', n: g.filter((x) => x.level === 1).length, tone: 'warn' },
    { label: '轻度拥堵', n: g.filter((x) => x.level === 2).length, tone: 'ok' }
  ]
})
/* 配置照抄 G2Charts.vue:112-122（含 data 那行的数组变异技巧）：
 * push/shift 是原地变更，不读一次 .length 就不会触发重算。 */
const lineChart = computed(() => ({
  xField: 't',
  yField: 'speed',
  smooth: true,
  color: PRIMARY,
  lineStyle: { lineWidth: 2 },
  xAxis: { label: { style: { fill: AXIS_TEXT, fontSize: 10 } }, tickCount: 6 },
  yAxis: { label: { style: { fill: AXIS_TEXT, fontSize: 10 } }, min: 0 },
  data: (store.vehicleStats.history.length, store.vehicleStats.history.slice())
}))

/* ===================== 底部详情条：把选中那条的全部字段摊开 ===================== */
const detail = computed(() => {
  const k = active.value
  if (!k) return null
  const i = k.indexOf(':')
  const card = k.slice(0, i)
  const rest = k.slice(i + 1)

  if (card === 'district') {
    const d = districtRows.value.find((x) => x.name === rest)
    if (!d) return null
    const rate = (f, t) => (t ? Math.round((f / t) * 100) + '%' : '—')
    return {
      kind: '区县',
      items: [
        { k: '常住人口', v: d.population + ' 万' },
        { k: '探头', v: `${d.camera}（故障 ${d.cameraFault}，故障率 ${rate(d.cameraFault, d.camera)}）` },
        { k: '信号灯', v: `${d.light}（故障 ${d.lightFault}，故障率 ${rate(d.lightFault, d.light)}）` },
        { k: '警力', v: `${d.police}（离勤 ${d.policeOff}）` },
        { k: '拥堵路段', v: `${d.congestion}（严重 ${d.congestSevere}${d.avgSpeed ? '，均速 ' + d.avgSpeed + 'km/h' : ''}）` },
        { k: '警情', v: `${d.alert}（待处置 ${d.alertPending}）` },
        { k: '事件', v: d.event + ' 条' }
      ],
      hint: '定位到该区中心（不改变当前图层）',
      target: {
        type: 'district', lng: d.lng, lat: d.lat,
        html: `<b>${d.name}</b> · 常住人口 ${d.population} 万<br/>探头 ${d.camera}（故障 ${d.cameraFault}）<br/>信号灯 ${d.light}（故障 ${d.lightFault}）<br/>警力 ${d.police}（离勤 ${d.policeOff}）<br/>拥堵路段 ${d.congestion}（严重 ${d.congestSevere}）<br/>警情 ${d.alert}（待处置 ${d.alertPending}）<br/>事件 ${d.event} 条`
      }
    }
  }

  if (card === 'congestion') {
    const c = congestRank.value.find((x) => String(x.id) === rest)
    if (!c) return null
    return {
      kind: '拥堵路段',
      items: [
        { k: '路段', v: c.name }, { k: '区县', v: c.area }, { k: '等级', v: c.level_name },
        { k: '均速', v: c.avg_speed + ' km/h' }, { k: '流量', v: c.flow + ' 辆/h' },
        { k: '坐标', v: `${c.lng}, ${c.lat}` }
      ],
      hint: '打开「道路拥堵」图层并飞往该路段',
      target: {
        type: 'point', layer: LAYER_OF.congestion, lng: c.lng, lat: c.lat, zoom: 16,
        html: `<b>${c.name}</b><br/>区县：${c.area}<br/>等级：${c.level_name}<br/>均速：${c.avg_speed} km/h<br/>流量：${c.flow} 辆/h`
      }
    }
  }

  if (card === 'alert') {
    /* ★ 必须用数值主键 id 查（同 congestion 分支）：模板里 pick 的是 'alert:' + a.id，
     * 而 alert_id 是业务编号（JQ2026xxxx），拿它去比对永远不相等 —— 结果每条警情
     * 都成了死点击：不摊详情、不弹提示、不报错，用户点了和没点一样。 */
    const a = rows('alerts').find((x) => String(x.id) === rest)
    if (!a) return null
    return {
      kind: '警情',
      items: [
        { k: '编号', v: a.alert_id }, { k: '类型', v: a.type }, { k: '等级', v: a.level + ' 级' },
        { k: '区县', v: a.area }, { k: '道路', v: a.road || '—' },
        { k: '已过', v: a.minutes_ago + ' 分钟' },
        { k: '状态', v: a.status === 'pending' ? '待处置' : '处理中' },
        { k: '关联车辆', v: a.car_num || '—' }
      ],
      hint: '警情没有对应地图图层，将用气泡标注位置',
      target: {
        type: 'point', layer: null, lng: a.lng, lat: a.lat, zoom: 16,
        html: `<b>${a.type}（${a.level} 级）</b><br/>编号：${a.alert_id}<br/>区县：${a.area}<br/>道路：${a.road || '—'}<br/>已过 ${a.minutes_ago} 分钟 · ${a.status === 'pending' ? '待处置' : '处理中'}`
      }
    }
  }

  if (card === 'fault') {
    const f = faultRows.value.find((x) => x.key === k)
    if (!f) return null
    const r = f.raw
    const items = [{ k: '类型', v: f.kindLabel }, { k: '名称', v: f.name }, { k: '区县', v: f.area }]
    if (r.badge) items.push({ k: '警号', v: r.badge })
    if (r.cam_id || r.tl_id || r.pol_id) items.push({ k: '编号', v: r.cam_id || r.tl_id || r.pol_id })
    if (r.location) items.push({ k: '位置', v: r.location })
    if (r.road) items.push({ k: '道路', v: r.road })
    items.push({ k: '坐标', v: `${f.lng}, ${f.lat}` })
    return {
      kind: f.kindLabel, items,
      hint: `打开「${LAYER_OF[f.kind] === 'camera' ? '监控探头' : LAYER_OF[f.kind] === 'trafficLight' ? '信号灯' : '警员分布'}」图层并飞往该点`,
      target: {
        type: 'point', layer: LAYER_OF[f.kind], lng: f.lng, lat: f.lat, zoom: f.zoom,
        html: `<b>${f.kindLabel} · ${f.name}</b><br/>区县：${f.area}<br/>${f.road || ''}`
      }
    }
  }

  if (card === 'vehicle') {
    const v = vehicles.find((x) => String(x.id) === rest)
    if (!v) return null
    return {
      kind: '模拟车辆',
      items: [
        { k: '编号', v: carNo(v) + ' 号车' }, { k: '车牌', v: v.plate }, { k: '道路', v: v.road },
        { k: '速度', v: kmh(v) + ' km/h' },
        { k: '状态', v: (v.state === 'waiting' ? '红灯等待中' : '行驶中') + (v.congested ? '（拥堵缓行）' : '') },
        { k: '前方信号灯', v: v.lightColor === 'none' ? '无' : v.lightColor + (v.lightDist ? `（${v.lightDist} m）` : '') }
      ],
      hint: '选中该车并飞往其位置（同时联动左侧车辆面板）',
      target: { type: 'vehicle', id: v.id }
    }
  }
  return null
})

/* ===================== 键盘：Esc 关闭 ===================== */
const onKey = (e) => {
  if (e.key === 'Escape') close()
}
onMounted(() => window.addEventListener('keydown', onKey))
/* 本组件不开任何定时器（数据源 store.vehicleStats 1Hz / vehicles 300ms 自己会更新），
 * 唯一的清理义务就是这个全局键盘监听。 */
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
/* 全屏大屏：亮色，与站内白卡片皮肤一致（token 全部引 main.css，无裸色值 / 裸 z-index）。
 * z-index 走 --z-screen(300)：全站唯一故意盖住底部工具条与 AI 悬浮球的浮层。 */
.ts-screen {
  position: fixed;
  inset: 0;
  z-index: var(--z-screen);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-sub);
  color: var(--text);
}

/* ===== 顶栏 ===== */
.ts-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 18px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
}

.ts-title {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
}

.ts-title .iconfont {
  font-size: 20px;
  color: var(--primary);
}

.ts-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: normal;
  border: 1px solid;
}

.ts-badge.ok {
  color: var(--ok);
  background: var(--ok-soft);
  border-color: var(--ok);
}

.ts-badge.warn {
  color: var(--warn);
  background: var(--warn-soft);
  border-color: var(--warn);
}

.ts-kpis {
  flex: 1 1 auto;
  display: flex;
  align-items: stretch;
  gap: 6px;
  overflow-x: auto;
}

.ts-kpi {
  flex: none;
  min-width: 88px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2px 12px;
  border-left: 1px solid var(--border);
}

.ts-kpi .screen-num {
  font-size: 22px;
  line-height: 1.15;
}

.ts-kpi-name {
  font-size: 11px;
  color: var(--text-sub);
}

/* KPI 副行口径标注（故障 N / 离勤 N / 严重 N）：本文件的 .ok/.warn 一律挂在具体父选择器下
 * （.ts-vstat b.ok 等），裸的 .item-sub 拿不到配色，不写这两条故障数就不会显红。
 * 口径同 .ts-vstat：warn 用 danger（故障是要处理的），ok 用 ok。 */
.ts-kpi .item-sub.ok {
  color: var(--ok);
}

.ts-kpi .item-sub.warn {
  color: var(--danger);
}

/* ===== 卡片网格 ===== */
.ts-grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: var(--gap);
  padding: var(--gap);
}

/* 窄屏（1280 档）自动回流成两列并允许整屏滚动，避免三列被挤爆 */
@media (max-width: 1440px) {
  .ts-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: none;
    grid-auto-rows: minmax(260px, auto);
    overflow-y: auto;
  }
}

.ts-card {
  display: flex;
  flex-direction: column;
  min-height: 0; /* 不写这行卡片会被内容撑破网格（flex/grid 子项默认 min-height:auto） */
  overflow: hidden;
  padding: 10px 12px 8px;
}

.ts-title-sub {
  margin-left: auto;
  font-weight: normal;
}

/* ===== 列表行 ===== */
.ts-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-right: -4px;
  padding-right: 4px;
}

.ts-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 3px 8px;
  box-sizing: border-box;
  border-radius: var(--radius-sm);
  border-left: 3px solid transparent;
  font-size: 12px;
  color: var(--text-sub);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.ts-row:hover {
  background: var(--bg-hover);
}

/* 选中行：浅蓝底 + 主色左竖条（与 .ui-panel-title::before 同一套视觉语言） */
.ts-row.on {
  background: var(--primary-soft);
  border-left-color: var(--primary);
  color: var(--text);
}

.ts-row-name {
  color: var(--text);
  flex: none;
  max-width: 40%;
}

.ts-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ts-row-val {
  flex: none;
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
}

.ts-row-val i {
  font-size: 10px;
  font-weight: normal;
  font-style: normal;
  color: var(--text-mute);
  margin-left: 2px;
}

/* 区县卡的六项数字 */
.ts-nums {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font-size: 11px;
  color: var(--text-sub);
  margin-left: auto;
}

.ts-nums i {
  font-style: normal;
}

.ts-nums b {
  font-weight: 600;
  color: var(--primary);
}

/* 0 用灰色而不是告警红：源数据只覆盖部分区县，0 是"该区无此类设施"，不是异常 */
.ts-nums b.zero {
  color: var(--text-mute);
}

.ts-nums em {
  font-style: normal;
  color: var(--danger);
  margin-left: 2px;
}

/* ===== 拥堵条形排行（用 DOM 而不是 BarChart：canvas 上的条目既点不到也断言不了） ===== */
.ts-bar {
  flex: 1 1 auto;
  min-width: 40px;
  height: 8px;
  border-radius: 4px;
  background: var(--bg-sub);
  overflow: hidden;
}

.ts-bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s;
}

/* ===== 标签 / 徽标 ===== */
.ts-lv,
.ts-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 15px;
  color: #fff; /* 与 VehiclePanel .vp-badge 同款：彩色底上的白字 */
  background: var(--text-mute);
}

.ts-lv.lv1 { background: var(--ok); }
.ts-lv.lv2 { background: var(--warn); }
.ts-lv.lv3 { background: var(--danger); }
.ts-lv.lv4 { background: var(--danger); }

.ts-tag.pending { background: var(--danger); }
.ts-tag.handling { background: var(--primary); }
.ts-tag.camera { background: var(--primary); }
.ts-tag.trafficLight { background: var(--danger); }
.ts-tag.police { background: var(--warn); }

/* ===== chips ===== */
.ts-chips {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px;
}

.ts-chip {
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-sub);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.ts-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.ts-chip.on {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary);
  font-weight: 600;
}

.ts-chip.zero {
  color: var(--text-mute);
}

/* ===== 车辆卡 ===== */
.ts-vstat {
  flex: none;
  display: flex;
  justify-content: space-around;
  padding: 2px 0 6px;
  font-size: 11px;
  color: var(--text-sub);
}

.ts-vstat b {
  font-size: 14px;
  font-weight: 700;
  color: var(--primary);
}

.ts-vstat b.ok { color: var(--ok); }
.ts-vstat b.warn { color: var(--danger); }
.ts-vstat b.cy { color: var(--primary); }

.ts-vlayer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 6px;
}

.ts-vlayer .ts-chip {
  margin-left: auto;
}

/* 编号徽标：与地图 marker 的 .vm-badge、左侧面板的 .vp-badge 同编号同颜色（--vm-color 同一来源） */
.ts-no {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  font-weight: 700;
  text-align: center;
  color: #fff;
  background: var(--vm-color, #1769e0);
}

.ts-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.ts-dot.running { background: var(--ok); }
.ts-dot.waiting { background: var(--danger); }

.ts-plate {
  flex: none;
  color: var(--text);
  letter-spacing: 0.5px;
}

.ts-light {
  flex: none;
  width: 12px;
  font-size: 11px;
  text-align: center;
}

.ts-light.green { color: var(--ok); }
.ts-light.yellow { color: var(--warn); }
.ts-light.red { color: var(--danger); }
.ts-light.none { color: var(--text-mute); }

/* ===== 运行态势卡 ===== */
.ts-cong3 {
  flex: none;
  display: flex;
  justify-content: space-around;
  padding: 2px 0 8px;
}

.ts-cong3-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.ts-cong3-item .screen-num {
  font-size: 20px;
}

.ts-cong3-item .screen-num.danger { color: var(--danger); }
.ts-cong3-item .screen-num.warn { color: var(--warn); }
.ts-cong3-item .screen-num.ok { color: var(--ok); }

/* G2Plot 宿主：必须有确定高度，否则 autoFit 无从计算会兜底到 400px 撑破卡片。
 * 这一行 + 下面的 :deep 与父级 flex 链三者缺一不可，详见 G2Charts.vue:179-193 的死锁说明。 */
.g2-body {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}

/* 必须写 :deep()：这层 div 是 G2Plot 用 JS 建的，不带 scoped 属性，不加 :deep 选择器匹配不上 */
:deep(.g2-body > div) {
  height: 100%;
}

/* ===== 说明文字 / 空态 ===== */
.ts-note {
  flex: none;
  padding-top: 6px;
  margin-top: 6px;
  border-top: 1px dashed var(--border);
  line-height: 1.5;
}

.ts-empty {
  padding: 14px 4px;
  line-height: 1.6;
  text-align: center;
}

/* ===== 底部详情条 ===== */
.ts-detail {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 18px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  box-shadow: var(--shadow);
  overflow-x: auto;
}

.ts-detail-kind {
  flex: none;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-soft);
  border: 1px solid var(--primary);
}

.ts-detail-item {
  flex: none;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
}

.ts-detail-item i {
  font-style: normal;
  color: var(--text-mute);
  margin-right: 4px;
}
</style>
