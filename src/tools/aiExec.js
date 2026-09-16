/**
 * AI 助手动作执行器
 *
 * 统一执行两类来源的动作，让"说话驱动页面"走同一条代码路径：
 *   1) DeepSeek 函数调用（tool_calls）：map_action / fly_to / set_road_class /
 *      set_traffic_layer / set_control_center / goto_page / get_status
 *   2) agent.js 离线规则引擎动作：zoom / map / layer / road / charts / chart / reply
 *      （大模型 key 失效 / 断网 / 无 key 时的自动降级通道）
 *
 * 地图实例由调用方传入 ctx.map（App.vue 注入的 $scene_map.map），
 * 图层 / 道路分级 / 控制中心操作内部自带 scene 引用（对应 init*.js 模块）。
 */
import { store } from '../store'
import { selectRoadClass } from './roadClassLayers'
import { setTrafficLayerVisible, isTrafficLayerVisible } from './initTrafficLayers'
import { resolvePlace, suggestPlaces, geocodeOnline } from './places'
import router from '../router'

const ZB_CENTER = [118.05, 36.81]

/* ---------------- 中文标签 ---------------- */
export const LAYER_LABEL = {
  camera: '监控探头', trafficLight: '信号灯', police: '警员分布', congestion: '道路拥堵',
  heat: '热力图', busRoute: '公交线路', busStop: '公交站点', vehicle: '动态车辆',
  building: '城市建筑', mainRoad: '道路图层'
}
export const ROAD_LABEL = { total: '总道路', highway: '高速公路', first: '一级道路', second: '二级道路', third: '三级道路' }
const PAGE_LABEL = {
  home: '首页', rotation: '地球自转', cityview: '城市视角', eventinfo: '事件信息',
  areasearch: '区域搜索', navigation: '导航', changestyle: '切换风格'
}

/* 与 ChangeStyle.vue mapStyles 同序同名的风格列表 */
export const STYLE_LABELS = ['街道风格', '高对比度街道风格', '深色风格', '卫星影像', '地形风格', '高清街道风格', '夜间街道风格', '导航风格（白天）', '导航风格（夜间）', '海图风格']

/* 测量工具（BottomTools 地图测量弹层同款路由） */
const MEASURE_TOOL_ZH = { drawPolygonTool: '多边形', drawRectTool: '矩形', drawCircleTool: '圆形', line: '线段' }

/* 图层打开时的自动取景缩放（AI 打开图层后飞到能看清该图层的视角） */
const AUTO_FIT_ZOOM = { building: 9.6, mainRoad: 9.8 }
const fitToLayer = (map, layer) => {
  if (!map) return
  map.flyTo({
    center: ZB_CENTER,
    zoom: AUTO_FIT_ZOOM[layer] || 10.2,
    pitch: 40,
    duration: 1400
  })
}

/* 可飞往地点：快表（区县/地标）由 places.js 统一管理 */
export { PLACES } from './places'

/* ---------------- 地图操作 ---------------- */
async function mapOp(map, kind, payload = {}) {
  if (!map) return '地图尚未就绪，请稍后再试'
  switch (kind) {
    case 'zoom_in':
      map.easeTo({ zoom: map.getZoom() + 1, duration: 600 })
      return '已放大地图一级'
    case 'zoom_out':
      map.easeTo({ zoom: map.getZoom() - 1, duration: 600 })
      return '已缩小地图一级'
    case 'reset':
      map.flyTo({ center: ZB_CENTER, zoom: 9.5, pitch: 0, bearing: 0, duration: 1500 })
      return '已复位到淄博全景'
    case 'rotate':
      map.rotateTo(map.getBearing() + 360, { duration: 20000 })
      return '开始旋转视角（20 秒转一圈）'
    case 'top':
      map.setPitch(0)
      return '已切换俯视视角'
    case 'tilt':
      map.setPitch(55)
      return '已切换到斜视视角'
    case 'fly': {
      const kw = String(payload.place || '').trim()
      if (!kw) return '你想飞到哪？告诉我地名，比如「飞到临淄区」「飞到张南路」「飞到齐都医院」'
      // 本地多级命中：区县/地标 → 道路 → POI（医院/博物馆/景点/商场/小区）
      const p = resolvePlace(kw)
      if (p) {
        map.flyTo({ center: p.center, zoom: p.zoom, pitch: 45, duration: 2000 })
        return `已飞到「${p.name}」（${p.kind}）`
      }
      // 在线兜底：学校等本地没有点数据的地方（3.5s 超时）
      const net = await geocodeOnline(kw)
      if (net) {
        map.flyTo({ center: net.center, zoom: 15, pitch: 45, duration: 2000 })
        return `已飞到「${kw}」（${net.kind}）`
      }
      // 都没找到：给本地候选，方便用户确认
      const sg = suggestPlaces(kw)
      if (sg.length) {
        return `本地没找到「${kw}」，你是不是想找：${sg.map((s) => `${s.name}（${s.kind}）`).join('、')}？对我说「飞到+名字」就能过去`
      }
      return `未找到「${kw}」，试试：张店区、临淄区、张南路、海岱楼、齐都医院`
    }
    default:
      return `不支持的地图操作：${kind}`
  }
}

/* ---------------- LLM 工具执行（返回给大模型的纯文本结果） ---------------- */
const LLM_ACTION_KIND = {
  zoom_in: 'zoom_in', zoom_out: 'zoom_out', reset_view: 'reset',
  rotate_view: 'rotate', top_view: 'top', tilt_view: 'tilt'
}

const toolImpl = {
  /** 查询页面状态（地图 / 图层 / 分级 / 控制中心 / 天气） */
  get_status({ map }) {
    const onLayers = Object.keys(LAYER_LABEL).filter(
      (k) => (k === 'building' || k === 'mainRoad') ? isTrafficLayerVisible(k) : !!store.trafficOn[k]
    )
    const parts = []
    if (map) {
      parts.push(`地图：淄博 zoom ${map.getZoom().toFixed(1)} 经度${map.getCenter().lng.toFixed(2)} 纬度${map.getCenter().lat.toFixed(2)}`)
    }
    parts.push(`当前道路分级：${ROAD_LABEL[store.roadClass] || '总道路（全部路网）'}`)
    parts.push(`已开图层：${onLayers.length ? onLayers.map((k) => LAYER_LABEL[k]).join('、') : '无'}`)
    parts.push(`控制中心：${store.chartsOpen ? '已打开' : '未打开'}`)
    const w = store.weather
    if (w && w.temperature !== '—') parts.push(`天气：${w.city} ${w.weather} ${w.temperature}℃ 湿度${w.humidity}`)
    return parts.join('；')
  },

  /** 地图动作 */
  map_action({ action }, ctx) {
    const kind = LLM_ACTION_KIND[action]
    if (!kind) return `未知地图动作：${action}`
    return mapOp(ctx.map, kind)
  },

  /** 飞到某地 */
  fly_to({ place }, ctx) {
    return mapOp(ctx.map, 'fly', { place })
  },

  /** 道路分级切换 */
  set_road_class({ level }) {
    const key = level === 'total' ? null : level
    selectRoadClass(key)
    store.roadClass = key || null
    return `道路已切换为：${ROAD_LABEL[level] || level}`
  },

  /** 交通图层开关（打开时自动飞到能看清该图层的视角） */
  set_traffic_layer({ layer, on }, ctx) {
    const ok = setTrafficLayerVisible(layer, !!on)
    if (!ok) return `未知图层：${layer}`
    if (on) fitToLayer(ctx.map, layer)
    return `${on ? '已打开' : '已关闭'}${LAYER_LABEL[layer] || layer}图层`
  },

  /** 控制中心（统计图表浮层）开关 */
  set_control_center({ open }) {
    store.chartsOpen = !!open
    return open ? '已打开控制中心' : '已收起控制中心'
  },

  /** 页面跳转 */
  goto_page({ page }) {
    const map = { home: '/', rotation: '/rotation', cityview: '/cityview', eventinfo: '/eventinfo', areasearch: '/areasearch', navigation: '/navigation', changestyle: '/changestyle' }
    if (!map[page]) return `未知页面：${page}`
    router.push(map[page])
    return `已跳转到「${PAGE_LABEL[page]}」页面`
  },

  /** 区域搜索：进入区域搜索页并搜索该地区（与底部功能栏操作同一套流程） */
  area_search({ keyword }) {
    const kw = String(keyword || '').trim()
    if (!kw) return '请告诉我要搜索哪个地区，比如「淄博市」「山东省」'
    router.push({ path: '/areasearch', query: { area: kw } })
    return `已进入区域搜索，正在搜索「${kw}」的行政边界与天气`
  },

  /** 切换地图风格：进入切换风格页并点选对应风格（与手动点选同一套流程） */
  change_style({ style }) {
    if (!STYLE_LABELS.includes(style)) {
      return `我认识的风格有：${STYLE_LABELS.join('、')}，你要哪一个？`
    }
    router.push({ path: '/changestyle', query: { style } })
    return `已切换为「${style}」`
  },

  /** 地图测量：进入对应测量工具页（与地图测量弹层同款工具） */
  map_measure({ tool }) {
    if (!MEASURE_TOOL_ZH[tool]) {
      return `可用的测量工具有：drawPolygonTool（多边形）、drawRectTool（矩形）、drawCircleTool（圆形）、line（线段）`
    }
    router.push('/mapdraw/' + tool)
    return `已打开「${MEASURE_TOOL_ZH[tool]}」测量工具，在地图上点击即可开始测量`
  },

  /** 导航：进入导航页并规划起终点路线 */
  start_navigation({ origin, destination }) {
    const to = String(destination || '').trim()
    if (!to) return '请告诉我要导航去哪里，比如「导航到临淄区」'
    const from = String(origin || '').trim() || '淄博站'
    router.push({ path: '/navigation', query: { from, to } })
    return `正在规划「${from} → ${to}」的导航路线`
  }
}

/** 执行一个 LLM 工具调用 */
export async function execTool(name, args, ctx) {
  const fn = toolImpl[name]
  if (!fn) return `未知工具：${name}`
  return String(await fn(args || {}, ctx))
}

/** 执行 agent.js 规则引擎动作（大模型不可用时的降级通道） */
export async function execRuleAction(a, ctx) {
  switch (a.type) {
    case 'zoom':
      return mapOp(ctx.map, a.dir === 'in' ? 'zoom_in' : 'zoom_out')
    case 'map':
      // agent.js 飞行动作携带的是解析好的 {lng, lat, name}，直接飞
      if (a.kind === 'fly' && a.payload && a.payload.lng) {
        ctx.map?.flyTo({ center: [a.payload.lng, a.payload.lat], zoom: 12.5, pitch: 45, duration: 2000 })
        return `正在飞往 ${a.payload.name || '目的地'}`
      }
      return mapOp(ctx.map, a.kind, a.payload)
    case 'layer':
      return toolImpl.set_traffic_layer({ layer: a.name, on: a.visible }, ctx)
    case 'road':
      return toolImpl.set_road_class({ level: a.level })
    case 'charts':
      store.chartsOpen = !!a.open
      return a.open ? '已打开控制中心' : '已收起控制中心'
    case 'chart':
      // 离线模式没有图表生成器：退化为打开控制中心查看统计图表
      store.chartsOpen = true
      return '已打开控制中心，可查看交通统计图表（离线模式暂不支持现场生成图表）'
    case 'navigate':
      return toolImpl.start_navigation({ origin: a.origin || '', destination: a.place })
    case 'areasearch':
      return toolImpl.area_search({ keyword: a.keyword })
    case 'style':
      return toolImpl.change_style({ style: a.style })
    case 'measure':
      return toolImpl.map_measure({ tool: a.tool })
    case 'reply':
    default:
      return a.reply || ''
  }
}

/** 当前是否大模型可用（供界面状态提示） */
export const llmConfigured = () => !!import.meta.env.VITE_DEEPSEEK_KEY
