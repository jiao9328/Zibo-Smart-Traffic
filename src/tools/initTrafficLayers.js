/**
 * 智慧交通图层模块（L7）
 *
 * 7 类交通图层懒创建注册表：首次显示才 scene.addLayer，之后 show/hide 复用实例。
 *   camera       监控探头（📹 emoji，原色；故障点整枚染红 #F04438）
 *   trafficLight 信号灯（🚦 emoji 剪影，state 四色 green/red/yellow/fault）
 *   police       警员分布（👮 emoji，原色＝深蓝制服；blue 是用户指定色）
 *   busRoute     公交线路（LineLayer 青绿，无动画）
 *   congestion   道路拥堵（真实路名 → 本地路网几何匹配，三色分级）
 *   heat         交通热力（HeatmapLayer 绿→黄→橙→红）
 *   busStop      公交站点（🚏 emoji，原色）
 *
 * 两条全局口径（用户 2026-09-15 提的第 1/2/6 条）：
 *   · **符号一律 18px**（SYMBOL=9，L7 的 size 是半径），与动态车辆的 22px 盒子同一量级
 *     （车形 SVG 的墨迹只有 17.6px，所以两者视觉等大）；聚合点与图标**同一个尺寸** ——
 *     上一版聚合气泡会随桶内点数涨到 22px，缩小反而变大，正是用户说的「滚轮向下缩小时符号变大」。
 *   · **裁剪**：点位/线路都只画落在大路网 MAX_M 范围内的要素，见 tools/roadCoverage.js
 *     （用户拍板「只裁地图图层」，库表/大屏 KPI 仍是全量）。
 * building/mainRoad 为桥接别名：控制基础图层（城市建筑/道路流线）
 *
 * 数据源：SQL Server（后端 /api/mapdata → store.dbData），不再是本地 JSON/mock。
 * 图层工厂在「创建/重建」瞬间从 store.dbData 读最新行并经 dbAdapter 转 GeoJSON，
 * 因此数据管理面板增删改后调用 refreshTrafficLayer(name) 重建即可实时上图层。
 *
 * 导出：
 *   setTrafficLayerVisible(name, visible) / toggleTrafficLayer(name) / isTrafficLayerVisible(name)
 *   refreshTrafficLayer(name) / refreshVisibleTrafficLayers()
 *   DEV 下挂 window.__traffic 供 CDP 验证断言
 */
import { PointLayer, LineLayer, HeatmapLayer, Popup } from '@antv/l7'
import roadData from '@/assets/GIS_Data/Zibo_roads.json'
import { baseLayerMap } from './initLayer'
import { TRAFFIC_ICONS, emojiDataUrl } from './trafficIcons'
import { store } from '../store'
import { pointFC, routeFC, layerProps } from './dbAdapter'
import { clipPoints, clipLines } from './roadCoverage'
import { setVehicleVisible } from './vehicleSim' // 动态车辆为前端模拟层（marker），开关委托它统一管理

/* ---------------- 本地路网索引（仅供拥堵按路名匹配几何，模块加载时一次） ---------------- */
const roadByName = new Map()
for (const f of roadData.features) {
  const name = f.properties.name
  if (name && !roadByName.has(name)) roadByName.set(name, f)
}

/* 当前行的简写（图层创建瞬间读取最新 DB 数据） */
const rows = (t) => (store.dbData && store.dbData[t]) || []

/* 拥堵层 FC：行 + 路网几何匹配（找不到的退化为短线段占位） */
const congestionFC = () => ({
  type: 'FeatureCollection',
  features: rows('congestion').map((c) => {
    const rf = roadByName.get(c.name)
    return {
      type: 'Feature',
      properties: layerProps('congestion', c),
      geometry: rf ? rf.geometry
        : { type: 'LineString', coordinates: [[c.lng, c.lat], [c.lng + 0.01, c.lat + 0.005]] }
    }
  })
})

/* ---------------- 共享 Popup ---------------- */
const popup = new Popup({ closeButton: true, offsets: [0, -10] })
let sceneRef = null

// 统一弹窗：已打开则复用更新，已关闭/首次则 addPopup（重复 add 同一实例会重复入栈）
const showPopup = (lngLat, html) => {
  popup.setLnglat(lngLat).setHTML(html)
  if (!popup.isOpen()) sceneRef.addPopup(popup)
}
const evLngLat = (e) => (e.lngLat ? [e.lngLat.lng, e.lngLat.lat] : [118.05, 36.81])

/* 悬停光标：图层上的要素「可点击」时，把 mapbox 默认的抓取手（grab，用户形容为「四处抓的小白手」）
 * 换成 pointer（用户 2026-09-15 第 7 条）。
 * L7 的 mouseenter/mouseleave 是**按要素**触发的，进出要素各切一次光标。
 * 离开时恢复成 '' 而不是写死 'grab'：光标本体的规则挂在 canvas 容器上（mapbox-gl.css 的
 * .mapboxgl-canvas-container.mapboxgl-interactive），交回它管，拖拽/缩放时该显示的手势才不会被打乱。 */
const clickable = (layer) => {
  const set = (v) => {
    const cv = sceneRef && sceneRef.map && sceneRef.map.getCanvas && sceneRef.map.getCanvas()
    if (cv) cv.style.cursor = v
  }
  layer.on('mouseenter', () => set('pointer'))
  layer.on('mouseleave', () => set(''))
}

/* 图层隐藏时把光标收回默认值：鼠标正停在要素上时关掉图层，mouseleave 不会再触发，
 * 光标会一直留在 pointer 上（悬停在空地图上却显示可点击）。 */
const resetCursor = () => {
  const cv = sceneRef && sceneRef.map && sceneRef.map.getCanvas && sceneRef.map.getCanvas()
  if (cv && cv.style.cursor === 'pointer') cv.style.cursor = ''
}

/* ---------------- 图层图标规范 ----------------
 * 一个图层一套「专属符号 + 专属色」，目标是扫一眼地图就知道那是什么图层：
 *
 *   图层        符号                着色                   怎么认
 *   监控探头    📹 emoji            原色；故障点整枚染红   #F04438 的实心剪影＝故障
 *   信号灯      🚦 emoji 的剪影     状态四色 绿/红/黄/灰   红绿一眼分得开
 *   警员分布    👮 emoji            原色（深蓝制服）       用户 2026-09-15 指定要蓝
 *   公交站点    🚏 emoji            原色
 *   公交线路    线                  #0E9AA7 青绿实线
 *   道路拥堵    线                  红/橙/黄 语义三色（分严重/中度/轻度，不改）
 *   动态车辆    —                   专属色                 车形 SVG（vehicleSim 用 DOM marker 单独渲染）
 *
 * 符号本体（emoji 位图）在 tools/trafficIcons.js，这里只放「用哪个符号 + 什么颜色 + 多大 + 聚合成什么样」。
 *   · 尺寸：**四层统一 SYMBOL=9**（L7 的 size 是半径 ⇒ 屏幕上 18px）。上一版是 9~10 的徽章本体，
 *     外面还套 1.5px 白描边 + 投影，视觉总宽 ≈26px，用户连说三次「太大」。18px 的依据是动态车辆：
 *     车 marker 的盒子是 22px，但车形 SVG 的墨迹只占 11.6×19.2（24 格里）⇒ 屏幕上 10.6×17.6px，
 *     所以 18px 的满框 emoji 与车**视觉等大**（烤图时墨迹占方框 96%，故实际墨迹 ≈17px）。
 *   · 着色：彩色 emoji 靠「图层色＝白」走原色分支，想要「整枚染成某个颜色」就给非白色
 *     （遮罩分支）—— 信号灯的状态四色、探头故障点的红都走这条，详见 trafficIcons.js 文件头。
 *   · 聚合点（缩小时挨得近被合并的那些）**照画同一枚 emoji、同一尺寸** —— 用户 2026-09-15：
 *     「深色实心圆 + 居中白数字不要，缩小后还是 emoji」。所以桶和散点看起来一模一样，
 *     「这一撮有几个」不再由符号承担，改由**点击**给出（见 pointStack 的 onClusterClick）。
 *     尺寸全程恒定，绝不随桶内点数变（第 6 条：滚轮向下缩小时符号不要变大）。
 */
const SYMBOL = 9 // 点符号半径（px）：四层统一，屏幕直径 18px

const ICON = {
  camera: { faulty: '#F04438', title: '监控', z: 20 },
  trafficLight: {
    // 四色与弹窗 stateMap 同源（green/red/yellow/fault），按状态取色而不是按数组下标
    state: { green: '#12B76A', red: '#F04438', yellow: '#F79009', fault: '#8C9AB0' },
    title: '信号灯', z: 25
  },
  police: { title: '警员', z: 30 },
  busStop: { title: '公交站', z: 15 },
  /* 公交线路：源数据 50 条线路的 color 列全是 #2b8cff（≈ 底图路网蓝），
   * 照数据着色就等于把线路藏进路网里，故本层统一用青绿（图层视觉决策，不读 color 列）。 */
  busRoute: { color: '#0E9AA7', width: 1.8 },
  /* 说明：这里原本还有一个 active（悬停高亮色 #1A2233），改用 emoji 后取消 ——
   * L7 的 .active({color}) 是**改图层色**，而彩色 emoji 靠「图层色＝白」走原色分支，
   * 一旦被改成高亮色就会整枚变成剪影。悬停反馈改由光标承担（见 clickable）。 */
}

/* ---------------- 聚合（L7 自带 cluster，内部就是 supercluster） ----------------
 * 用图层自带的 `source(data, {cluster:true})` 而不是自己分桶：DataSourcePlugin 会在缩放变化时
 * 自动重算（zoom 空间 = floor(mapZoom-1)），不需要任何 zoom 监听——全项目现在也确实一个都没有。
 *
 * radius 是**屏幕像素**：四类点疏密差得远，按层调。
 * ★ 这套数值是 2026-09-15 为**18px 的小 emoji 符号**重新调小的，不是上一版徽章时代的值。
 *   上一版是 {camera:22, trafficLight:12, police:16, busStop:16} —— 那是给更大的徽章调的，
 *   符号缩到 18px 后明显偏大，用户 2026-09-15 说「太稀疏了，缩放到看到整个道路网时
 *   也要能看到几十个点」，实测默认视图只剩 8 个散点、整网视图 82 个要素，都太少。
 * 量尺是 scripts/cdp-zoomlevels.mjs（逐级缩小，向活索引查这一级出几个桶几个散点 + 截图数像素）。
 *   调小之后的实测（四层全开，中心 [118.037,36.813]，视图内总要素 = 桶 + 散点）：
 *     zoom 12   → 231   11.3 → 190（＝整条路网刚好铺满屏幕那一级，用户要的「几十个」在这里）
 *     zoom 10.5 → 116    9.5 →  68（默认视图）   8.5 → 38   7.5 → 22
 *   桶内最多：11.3 只有 26，9.5 才 63，要 zoom ≤8.5 才上到 212/225 —— 即「一撮几十上百个」
 *   只出现在缩得比较远的几级，那些级别上桶长什么样直接决定整张图的观感。
 * maxZoom 取 11 是刻意的：
 *   · 由 zoom 空间定义（mapZoom-1）⇒ map zoom ≥ 12 时**全部散开**，默认视图 9.5 出聚合点、
 *     区县视图 12 过渡、放大到 13+ 全是个体图标；
 *   · 大屏/巡检的定位用的是 zoom 16~17（TrafficScreen.vue），不会出现「飞过去了却只有一个
 *     聚合点、图标不见了」；
 *   · 顺带保住 cdp-probe14 的取样缩放（首次 15、回退 13.5/12 —— 都 ≥12，图标照常画出来）。
 */
const CLUSTER = { camera: 8, trafficLight: 5, police: 6, busStop: 6, maxZoom: 11 }

/* 尺寸写**常量**，不再写 `.size('point_count', 回调)`：散点和聚合点都画同一枚 emoji、同一个大小，
 * 已经不存在「桶上不画 / 散点上不画」这种互斥了，回调随之删掉。
 * ★ 也绝不要再引入 `.filter()`：filter 会把被滤掉的记录清成 {}，L7 的 PointLayer 在「空数据」
 *   分支上认不出 { field: 'zb-emoji-*' } 这种图标名，模型退化成普通方块
 *   （根因与实测见下面 pointStack 的注释，cdp-probe14 曾因此一直假通过）。没有 filter 就没这个坑。
 * ★ 尺寸**恒定**，绝不随桶内点数变化：上一版聚合气泡半径 12→22px 随点数增长，于是滚轮缩小、
 *   散点并成桶时符号反而变大 —— 正是用户第 6 条「滚轮向下缩小时图层符号不要变大」。 */

/* 取图标名还是退回几何形状：
 * 图标是异步注册的（scene.addImage 内部 new Image + 解码），若在图标就绪前建图层，
 * L7 找不到这个名字会**静默退化成文字渲染**（point/index.js: iconMap 里没有就当 text），
 * 所以没就绪时先用 shape2d 名顶上，注册完成后再重建一次（见 initTrafficLayers 末尾）。 */
const shapeOf = (key) => {
  const icon = TRAFFIC_ICONS[key]
  return sceneRef && icon && sceneRef.hasImage(icon.id) ? icon.id : icon.fallbackShape
}

/* ---------------- 图层注册表 ---------------- */
const registry = {}

/* 每个条目：{ visible: 当前显示状态, layer: 主图层实例, group: 该点位的一套图层 }
 * ★ `layer` 必须始终指向**主图标层**：cdp-probe13 / probe14 / probe16 / shot-readme / cdp-l7*.mjs
 *   都直接读它（读 size/shape/颜色、取 originData、取样计数），字段名与语义不能变。
 *   `group` 是一套点位的那组图层（现在是 1 个：emoji 图标层），显示/隐藏/销毁都整组来。 */
const ensure = (name) => {
  if (!registry[name]) registry[name] = { visible: false, layer: null, group: [] }
  return registry[name]
}

/* 把一套图层挂进场景。工厂返回两种形态：裸 layer（线/热力）或 { main, layers }（点位的一套）。
 * ★ 裸图层**没有** `.layers` 属性 —— 这里一度写成 `built.layers[0]`，于是公交线路/拥堵/热力
 *   一开就抛 "Cannot read properties of undefined (reading '0')"，图层/面板开关全哑
 *   （实测：三层的 setVisible 全部抛错、registry 里 layer 永远为 null）。group[0] 兜底把两种都接住。 */
const mount = (item, built) => {
  const group = built.layers || [built]
  item.layer = built.main || group[0]
  item.group = group
  for (const l of group) sceneRef.addLayer(l)
}

/* ---------------- 点位符号的通用装配（单图层：emoji） ----------------
 * 一套点位 = **1 个** L7 图层：散点和聚合点都画同一枚 emoji 位图，同一个尺寸。
 *   · 着色：.color('#FFFFFF') 走原色分支（全彩）；给非白色则走遮罩分支
 *     （信号灯按 state 染色、探头故障点染红，都是「整枚变色」，见 trafficIcons.js 文件头）
 *   · 聚合桶**不再是特殊符号** —— 用户 2026-09-15 推翻了「深色实心圆 + 居中白数字」：
 *     「深色实心圆 + 居中白数字不要，缩小后还是 emoji」。于是 -聚（圆）与 -数（白数字）
 *     两个图层、以及配套的 scatterSize/clusterSize/countSize/COUNT_STYLE 一起删掉。
 *     「这一撮有几个」改由**点击**给出（见下面的 onClusterClick）。
 *
 * 历史坑（保留作警示，现在的单图层写法天然不会踩）：
 *   · 曾经用 `.filter('point_count', 单散点)` 做「桶上不画图标」，**它是坏的**：
 *     filter 会把被滤掉的记录清成 {}（getEncodedData 里一条带 shape 的记录都不剩），
 *     于是 PointLayer.getModelType()（point/index.js:190）走到「空数据」分支
 *     getModelTypeWillEmptyData()（同文件 :122）—— 那个分支只认 values 数组 / 'text' /
 *     shape2d，认不出 { field: 'zb-emoji-*' } 这种图标名 ⇒ 返回 'normal' ⇒ 建出来的是
 *     **普通方块模型**（且 normal 默认 additive 混合），根本不是图片模型。现场症状：zoom15
 *     图标位置取色 = 255,255,255；而 getModelType() 仍报 'image'（它按**当前数据**算，
 *     绑定的却是当初用空数据建的方块模型）⇒ 断言 getModelType() 抓不住，probe14 长期假通过。
 *   · 后来的补救是 `.size('point_count', 回调)`（每条记录都留着 shape 键 ⇒ 模型恒为 image）。
 *     现在连互斥都不需要了，size 直接写常量 SYMBOL，比回调更直白。
 */
const pointStack = (key, data) => {
  const c = ICON[key]
  const cluster = { cluster: true, clusterOptions: { radius: CLUSTER[key], maxZoom: CLUSTER.maxZoom } }
  const main = new PointLayer({ id: `交通-${c.title}`, zIndex: c.z })
    .source(data, cluster)
    .shape(shapeOf(key))
    .size(SYMBOL)
  const layers = [main]

  /* 聚合要素（supercluster 造出来的那些）的 properties 里**没有业务字段** —— 只有
   * cluster_id / point_count / point_count_abbreviated，name/status/state 一律 undefined。
   * 所以四层工厂的逐点弹窗必须先过这道闸，否则点桶会弹出「📹 undefined」。
   * 判据取 cluster_id：散点是 L7 自己补的 point_count = 1（source.js:128-132），桶才有 cluster_id；
   * point_count > 1 作兜底（万一某条路径把 cluster_id 洗掉了，数量仍是可信的）。 */
  const isCluster = (p) => p && (p.cluster_id !== undefined || Number(p.point_count) > 1)

  /* 点聚合点 → 弹「这里有几个点」+ 飞到该桶并放大（聚合点的用途就是「放大看细节」）。
   * 展开级别优先用 supercluster 的 getClusterExpansionZoom（保证这桶真的散开），
   * 拿不到就退化成 +2；上限 15，免得一路飞到楼顶。
   * 点击载荷是**扁平记录**（开聚合后没有 .properties，探针 E6 实测），桶内点数在 p.point_count 上。 */
  const onClusterClick = (p) => {
    const center = p.coordinates || (p.lng != null ? [p.lng, p.lat] : null)
    if (!center || center[0] == null) return
    const n = Number(p.point_count) || 0
    showPopup(center, `
      <div style="min-width:140px">
        <b>${c.title}聚合点</b><br/>
        这里合并了 <b>${n}</b> 个${c.title}点位<br/>
        <span style="color:#667085">已放大到能看清单个符号的级别</span>
      </div>`)
    const map = sceneRef.map // L7 场景里就是 mapbox-gl 的 Map（有 easeTo/getZoom）
    if (!map || !map.easeTo) return
    /* ★ 展开级别要 **+1.5**（probe16 实测出来的 bug）：点气泡时中心精确落到了桶上、zoom 却纹丝不动。
   * 原因是两套 zoom 口径差 1：
   *   · supercluster 的 getClusterExpansionZoom 返回的是**它自己那棵树的** zoom E（`getClusters(E)`
   *     就会散开，看 supercluster@7.1.5 源码就是 originZoom-1 往上试）；
   *   · 而 DataSourcePlugin 是按 `Math.floor(mapZoom - 1)` 建树的（见 l7-layers/plugins/
   *     DataSourcePlugin.js:104/110），所以树 zoom E 对应的地图 zoom 是 **E+1**。
   * 之前写成 `ex + 0.5`：实测那桶的 ex 正好是 9 → 目标 9.5 = 当前 zoom（默认视图就是 9.5），
   * `easeTo` 于是只挪了中心、一级都没放大 —— 看起来像"点了没反应"。改成 +1.5 才是真正上一级。
   * 另加一道有限性兜底：拿不到数字时退化成「当前 +2」（+1 的口径下这是保守值），至少点了有反应。
   * 上限 15 不会截断展开：maxZoom=11 ⇒ 地图 zoom ≥ 12 必定全散。 */
    const go = (z) => {
      const zz = Number(z)
      const target = Number.isFinite(zz) ? zz : map.getZoom() + 2
      map.easeTo({ center, zoom: Math.min(target, 15), duration: 600 })
    }
    let ex = null
    try {
      const idx = main.layerSource && main.layerSource.clusterIndex
      if (idx && p.cluster_id !== undefined) ex = idx.getClusterExpansionZoom(p.cluster_id)
    } catch (err) { ex = null }
    if (ex && typeof ex.then === 'function') ex.then((z) => go(Number(z) + 1.5)).catch(() => go())
    else if (typeof ex === 'number') go(ex + 1.5)
    else go()
  }

  /* 点击路由：聚合要素走 onClusterClick，其余交给各工厂注册的业务弹窗。
   * 工厂一律用 st.onClick(fn) 而不是 st.main.on('click', fn) —— 让这道闸**没法被绕过**
   * （直接挂 main 的话，哪天有人加一层就顺手漏掉了聚合分支）。 */
  const handlers = []
  main.on('click', (e) => {
    const p = e.feature.properties || e.feature
    if (isCluster(p)) return onClusterClick(p)
    for (const h of handlers) h(e)
  })
  clickable(main)
  return { main, layers, onClick: (fn) => handlers.push(fn) }
}

const layerFactories = {
  camera() {
    const c = ICON.camera
    const st = pointStack('camera', clipPoints(pointFC('cameras', rows('cameras'))))
    /* 彩色 emoji 的着色（读 trafficIcons.js 文件头的两条分支）：
     * 正常点 .color('#FFFFFF') ⇒ 原色分支，直接显示 📹 本身的颜色；
     * 故障点给 #F04438 ⇒ 遮罩分支，整枚染成红的实心剪影 —— 这正是「故障一眼可见」要的效果。
     * 按 status 取值而不是数组下标对号入座，分类顺序变了也不会把正常点染红。
     * 不再调 .active({color})：它会把彩色图标整枚染成高亮色（原色分支的前提是图层色＝白）。
     * 「可点击」的反馈改由光标承担（见 clickable）。 */
    st.main.color('status', (s) => (s === 'fault' ? c.faulty : '#FFFFFF'))
    /* 用 st.onClick 而不是 st.main.on('click')：聚合桶由 pointStack 统一接管（弹「合并了几个」+
     * 放大），只有真散点才会进到这里 —— 否则桶上读到的 name/status 全是 undefined。 */
    st.onClick((e) => {
      /* 开聚合后点击载荷是**扁平记录**（L7 把 cluster 的要素摊平了，没有 .properties；
       * 探针 E6 用真鼠标事件验过 payload 里 lng/lat/name 都直接可取）。兼容两种形态，弹窗逻辑不变。 */
      const p = e.feature.properties || e.feature
      showPopup([p.lng, p.lat], `
        <div style="min-width:150px">
          <b>📹 ${p.name}</b><br/>
          道路：${p.road}<br/>
          状态：${p.status === 'normal' ? '<span style="color:#22c55e">正常</span>' : '<span style="color:#ff3b30">故障</span>'}<br/>
          区县：${p.area}
        </div>`)
    })
    return st
  },
  trafficLight() {
    const c = ICON.trafficLight
    const st = pointStack('trafficLight', clipPoints(pointFC('traffic_lights', rows('traffic_lights'))))
    /* 信号灯走**遮罩分支**（用户 2026-09-15 拍板「整枚按状态染色」）：图层色＝状态色 ⇒
     * 红/绿/黄/灰四色的信号灯剪影，红绿在地图上一眼分得开。
     * 这一层是四层里唯一不显示彩色 emoji 的层 —— 彩色位图改不了色，而「红绿区分」是硬需求。 */
    st.main.color('state', (s) => c.state[s] || c.state.fault)
    st.onClick((e) => {
      const p = e.feature.properties || e.feature
      const stateMap = { green: '绿灯', red: '红灯', yellow: '黄灯', fault: '故障' }
      showPopup([p.lng, p.lat], `
        <div style="min-width:150px">
          <b>🚦 信号灯 ${p.id}</b><br/>
          状态：${stateMap[p.state] || p.state}<br/>
          区县：${p.area}
        </div>`)
    })
    return st
  },
  police() {
    const st = pointStack('police', clipPoints(pointFC('police', rows('police'))))
    /* 警员用 👮 的**原色**（.color('#FFFFFF') 走原色分支）：用户要求「统一改成蓝色」，
     * 👮 本身就是深蓝制服 + 蓝帽，比上一版自定义的品红更贴语义。 */
    st.main.color('#FFFFFF')
    st.onClick((e) => {
      const p = e.feature.properties || e.feature
      showPopup([p.lng, p.lat], `
        <div style="min-width:150px">
          <b>👮 ${p.name}</b><br/>
          警号：${p.badge}<br/>
          状态：${p.onDuty ? '<span style="color:#22c55e">在勤</span>' : '<span style="color:#ff9500">休班</span>'}<br/>
          位置：${p.location}
        </div>`)
    })
    return st
  },
  busRoute() {
    const c = ICON.busRoute
    const layer = new LineLayer({ id: '交通-公交线路', zIndex: 5 })
    layer.source(clipLines(routeFC(rows('bus_routes'))))
      .size(c.width)
      .shape('line')
      .color(c.color) // 图层固定青绿：数据里的 color 列与底图路网同蓝，见 ICON.busRoute 注释
      .style({ opacity: 0.85 }) // 静态美化：压一点透明度，与底图路网叠在一起时不抢眼（用户选了不做动效）

    clickable(layer)
    layer.on('click', (e) => {
      const p = e.feature.properties
      showPopup(evLngLat(e), `
        <div style="min-width:180px">
          <b>🚌 ${p.ref || p.name || '公交线路'}</b><br/>
          起讫：${p.dep_stop || '—'} → ${p.arr_stop || '—'}<br/>
          途经：${p.via || 0} 站
        </div>`)
    })
    return layer
  },
  congestion() {
    const layer = new LineLayer({ id: '交通-拥堵', zIndex: 6 })
    layer.source(congestionFC())
      /* 按等级分粗细（严重最粗）。数值随本次「路网整体变细」一并下调（原 6.5/3）：
       * 底图总道路从 1px 级降到 0.7px 之后，6.5px 的拥堵段像一条压在路网上的色带。 */
      .size('level', [5, 2.5])
      .shape('line')
      .color('level', ['#ff3b30', '#ff9500', '#ffd60a']) // 0严重/1中度/2轻度
    clickable(layer)
    layer.on('click', (e) => {
      const p = e.feature.properties
      showPopup(evLngLat(e), `
        <div style="min-width:160px">
          <b>🚧 ${p.name}</b><br/>
          拥堵：${p.levelName}<br/>
          均速：${p.avgSpeed} km/h<br/>
          流量指数：${p.flow}
        </div>`)
    })
    return layer
  },
  heat() {
    const layer = new HeatmapLayer({ id: '交通-热力', zIndex: 2 })
    /* 热力点也要裁：源数据 336 个点里有 271 个离路网 > 500m（散在临淄/高青那些
     * 没有路网的地方），不裁的话热力斑会飘在一片空白上（用户第 2 条「每个图层都要在总道路范围内」）。
     * 裁剪后 65 个点全部落在张店路网带上，热力斑与路网重合。 */
    layer.source(clipPoints(pointFC('heat_points', rows('heat_points'))))
      .shape('heatmap')
      .size('value', [0, 1])
      .style({
        intensity: 3,
        radius: 24,
        opacity: 0.75,
        rampColors: {
          colors: ['#1443ff', '#00e5ff', '#00ffa3', '#ffd60a', '#ff3b30'],
          positions: [0, 0.25, 0.5, 0.75, 1]
        }
      })
    return layer
  },
  busStop() {
    const st = pointStack('busStop', clipPoints(pointFC('bus_stops', rows('bus_stops'))))
    // 原色分支：🚏 站牌本身的颜色（实测样点最远 254m，裁剪对公交站等于没裁）
    st.main.color('#FFFFFF')
    st.onClick((e) => {
      const p = e.feature.properties || e.feature
      showPopup(evLngLat(e), `
        <div style="min-width:140px">
          <b>🚏 ${p.name}</b><br/>
          公交站点
        </div>`)
    })
    return st
  }
}

// 桥接：building/mainRoad 别名映射到基础图层（城市建筑 / 道路流线）
const BRIDGE_NAMES = { building: '淄博市', mainRoad: '淄博道路' }

/** 初始化（App.vue 地图就绪后调用一次：注册图标 + 保存 scene 引用，不建任何图层） */
export function initTrafficLayers(scene) {
  sceneRef = scene
  /* 注册四枚 emoji 位图。走 scene.addImage 而不是直接给 .shape 传 URL：L7 只认注册过的图片名。
   * 位图是**同步**烤出来的（canvas），但 addImage 内部是 new Image + 解码、仍是异步完成，
   * 所以注册完要重建一次已显示的图层 —— 否则开着图层时刷新页面，图层会停在
   * 「图还没就绪」那一刻建的几何形状版（fallback），再也不换回来。 */
  const pending = Object.keys(TRAFFIC_ICONS)
    .filter((k) => !scene.hasImage(TRAFFIC_ICONS[k].id)) // HMR 会重复调 initTrafficLayers，重复注册 L7 只会告警
    .map((k) => scene.addImage(TRAFFIC_ICONS[k].id, emojiDataUrl(k)))
  if (pending.length) {
    Promise.all(pending)
      .then(() => refreshVisibleTrafficLayers())
      .catch((e) => console.warn('[traffic] 主题图标注册失败，图层暂用几何形状兜底：', e))
  }
  if (import.meta.env.DEV) {
    // 调试桥：CDP 验证用
    window.__traffic = {
      names: Object.keys(layerFactories),
      setVisible: (n, v) => setTrafficLayerVisible(n, v),
      toggle: (n) => toggleTrafficLayer(n),
      visible: (n) => isTrafficLayerVisible(n),
      refresh: (n) => refreshTrafficLayer(n),
      /* 烤给 L7 的位图本体（data URL）：CDP 探针要把它取出来在 Node 侧解码，
       * 验「这台浏览器真的烤出了 emoji」而不是只看配置名对不对（scripts/cdp-probe17.mjs） */
      emoji: (k) => emojiDataUrl(k),
      registry
    }
    /* 图层构造器（仅 DEV）：给实验脚本临时建图层用 —— 聚合/文字/阴影这些 L7 能力
     * 必须先在真地图上实测（scripts/cdp-l7cluster-probe.mjs），不能靠读压缩过的 dist 猜。
     * 生产构建里没有这个字段。 */
    window.__l7 = { PointLayer }
  }
}

/** 显示/隐藏交通图层（懒创建：首次显示时才 addLayer） */
export function setTrafficLayerVisible(name, visible) {
  if (name === 'vehicle') {
    // 动态车辆：DOM marker 由模拟器统一管理（store 镜像也只在 vehicleSim 内写入，避免双写漂移）
    setVehicleVisible(visible)
    return true
  }
  if (BRIDGE_NAMES[name]) {
    // 桥接基础图层（按实例注册表取，scene.getLayerByName 在 L7 2.15 不可用）
    const base = baseLayerMap[BRIDGE_NAMES[name]]
    if (base) {
      visible ? base.show() : base.hide()
      return true
    }
    return false
  }
  if (!layerFactories[name] || !sceneRef) return false
  const item = ensure(name)
  if (visible) {
    if (!item.layer) {
      mount(item, layerFactories[name]())
    } else {
      for (const l of item.group) l.show() // 点位层是一组（现在只有 1 个 emoji 图标层），整组显隐
    }
  } else {
    for (const l of item.group) l.hide()
    resetCursor() // 鼠标正停在要素上时关图层，mouseleave 不会再触发，光标得手动收回
  }
  item.visible = visible
  // 同步到 store.trafficOn 镜像（实时数据栏 UI 与 AI 助手状态查询共用同一来源）
  if (store && store.trafficOn) store.trafficOn[name] = visible
  return true
}

export const toggleTrafficLayer = (name) => {
  const cur = BRIDGE_NAMES[name]
    ? !!baseLayerMap[BRIDGE_NAMES[name]]?.isVisible()
    : name === 'vehicle'
      ? !!store.trafficOn.vehicle
      : ensure(name).visible
  setTrafficLayerVisible(name, !cur)
  return !cur
}

export const isTrafficLayerVisible = (name) => {
  if (BRIDGE_NAMES[name]) {
    return !!baseLayerMap[BRIDGE_NAMES[name]]?.isVisible()
  }
  if (name === 'vehicle') return !!store.trafficOn.vehicle
  return !!ensure(name).visible
}

/**
 * 数据变更后重建图层（数据管理增删改 → store.dbData 已更新 → 调本函数）：
 * 销毁旧实例并从 store.dbData 重读数据建新实例；当前不可见只清缓存，下次显示自然拿到新数据。
 * @returns {boolean} 是否真的发生了重建
 */
export function refreshTrafficLayer(name) {
  if (BRIDGE_NAMES[name] || !layerFactories[name] || !sceneRef) return false
  const item = ensure(name)
  if (item.layer) {
    for (const l of item.group) {
      try { sceneRef.removeLayer(l) } catch (e) { /* 图层可能已不在 scene */ }
    }
    item.layer = null
    item.group = []
  }
  if (item.visible) mount(item, layerFactories[name]())
  return true
}

/** 全部已显示图层重建（App 拉取 DB 全量成功后调用） */
export function refreshVisibleTrafficLayers() {
  for (const name of Object.keys(layerFactories)) refreshTrafficLayer(name)
}
