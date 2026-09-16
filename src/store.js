/**
 * 全局状态（Vue reactive 单例，供所有面板共享）
 * 通过 provide/inject 注入：$store
 */
import { reactive } from 'vue'

/* ================= 登录态（sessionStorage 会话级，只存用户名/显示名，绝不存密码） =================
 * 会话级存储：同一标签页刷新保持登录；关闭浏览器/新开窗口需重新登录 ——
 * 演示/汇报时每次打开都能先看到登录页。旧版 localStorage 的残留 key 不再读取。 */
const AUTH_KEY = 'zb_auth_user'

/** 同步读取当前登录用户（守卫/Header 用）；存储损坏时容错返回 null */
export function getAuthUser() {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}
/** 登录成功：写响应式 store + sessionStorage（顺手清掉旧版 localStorage 残留） */
export function setAuthUser(user) {
  store.user = user
  sessionStorage.setItem(AUTH_KEY, JSON.stringify(user))
  localStorage.removeItem(AUTH_KEY)
}
/** 退出登录：清 store + sessionStorage */
export function clearAuthUser() {
  store.user = null
  sessionStorage.removeItem(AUTH_KEY)
}

export const store = reactive({
  /* ---- 当前登录用户（{ username, display_name } | null），刷新（同标签页）从 sessionStorage 恢复 ---- */
  user: getAuthUser(),

  /* ---- 控制中心浮层（底部按钮开关，点其它按钮不关闭） ---- */
  chartsOpen: false,

  /* ---- 数据管理面板（底部「数据管理」按钮开关，浮层不随路由消失） ---- */
  dataPanelOpen: false,

  /* ---- 交通可视化大屏（底部「交通大屏」按钮开关；全屏浮层，路由切换不消失） ---- */
  screenOpen: false,

  /* ---- SQL Server 业务数据（后端 /api/mapdata 全量拉取后填充） ----
   * dbStatus: idle(未拉取) | loading | ok | fail(含 dbError 原因)
   * dbData：表名 → 行数组，图层工厂 / 控制中心 / 事件检索实时读取 */
  dbStatus: 'idle',
  dbError: '',
  dbData: {
    districts: [],
    cameras: [],
    traffic_lights: [],
    police: [],
    alerts: [],
    events: [],
    congestion: [],
    heat_points: [],
    bus_routes: [],
    bus_stops: []
  },

  /* ---- 道路分级栏当前选中（null=总道路） ---- */
  roadClass: null, // highway | first | second | third

  /* ---- 8 类交通图层开态镜像（实时数据栏 UI 与 AI 助手共用；vehicle 为前端模拟层） ---- */
  trafficOn: {
    camera: false,
    trafficLight: false,
    police: false,
    congestion: false,
    heat: false,
    busRoute: false,
    busStop: false,
    vehicle: false
  },

  /* ---- 动态车辆「列表 ↔ 地图」联动的唯一状态源（vehicleSim 写入，VehiclePanel 读取） ----
   * selectedVehicleId：点击后选中的车辆 id（0..14），null = 未选中；地图 marker 常驻高亮 + 光环
   * hoveredVehicleId ：鼠标悬停的车辆 id，null = 无；列表行与 marker 双向临时高亮
   * 两侧都不直接改对方 DOM，一律写这里再由 watch 反向驱动，保证单向数据流。 */
  selectedVehicleId: null,
  hoveredVehicleId: null,

  /* ---- 动态车辆模拟统计（vehicleSim 每秒 tick 更新；history 为近 60 秒均速，供折线图） ---- */
  vehicleStats: {
    total: 0,        // 模拟车辆总数
    running: 0,      // 行驶中
    waiting: 0,      // 红灯/黄灯等待中
    onCongested: 0,  // 处于拥堵路段（被降速）
    avgSpeed: 0,     // 全车队平均速度 km/h
    history: []      // [{ t: 'HH:MM:SS', speed: number }...] 最近 60 秒
  },

  /* ---- 天气（App 挂载时真实抓取） ---- */
  weather: {
    city: '淄博市',
    weather: '—',
    temperature: '—',
    humidity: '—',
    windDirection: '—',
    windPower: '—',
    reportTime: '—'
  }
})

export const injectStore = { store }
