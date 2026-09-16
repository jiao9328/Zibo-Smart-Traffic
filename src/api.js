/**
 * 数据服务 REST 客户端（Express :3001）
 *  - 开发模式：vite dev（:5173）把 /api 代理到 :3001（见 vite.config.js server.proxy）
 *  - 生产模式：Express 同源托管 dist + /api
 *
 * 服务端返回统一结构：{ ok:true, ... } / { ok:false, error:'中文原因' }
 */
import axios from 'axios'

const http = axios.create({ baseURL: '/api', timeout: 20000 })

/* 请求失败转友好中文原因：
 *  - 服务端返回业务错误（{ ok:false, error }）→ 透传服务端文案（如库未初始化）
 *  - 无响应 / vite 代理网关错误（后端未启动）→ 固定文案，不暴露 Request failed… 等英文技术细节 */
function reason(e) {
  const d = e?.response?.data
  if (d && typeof d === 'object' && d.error) return String(d.error)
  const st = e?.response?.status
  if (!st || st >= 500) return '数据服务端未启动'
  return e.message || '请求失败'
}

/* 业务表（与后端 server/index.js TABLES 白名单同名同序；图层/面板共用） */
export const DB_TABLES = [
  'cameras', 'traffic_lights', 'police', 'alerts', 'events',
  'congestion', 'bus_routes', 'bus_stops', 'districts', 'heat_points'
]

export const TABLE_LABEL = {
  cameras: '监控探头', traffic_lights: '信号灯', police: '警员分布', alerts: '实时警情',
  events: '事件记录', congestion: '拥堵路段', bus_routes: '公交线路', bus_stops: '公交站点',
  districts: '区县', heat_points: '热力点（只读）'
}

/* 内置登录账号（默认 admin / 123456，可在 .env 用 VITE_ADMIN_USERNAME/VITE_ADMIN_PASSWORD 覆盖）。
 * 登录为纯前端本地校验 —— 不连后端、不连数据库，npm run dev 开箱即用。 */
const LOCAL_ADMIN = {
  username: import.meta.env.VITE_ADMIN_USERNAME || 'admin',
  password: import.meta.env.VITE_ADMIN_PASSWORD || '123456',
  display_name: '系统管理员'
}

export const api = {
  /** 登录：本地账号校验（演示/课程级）。不发网络请求、不依赖数据库 */
  async login(username, password) {
    await new Promise(r => setTimeout(r, 250)) // 轻量延迟，让按钮 loading 可见
    if (username === LOCAL_ADMIN.username && password === LOCAL_ADMIN.password) {
      return { username: LOCAL_ADMIN.username, display_name: LOCAL_ADMIN.display_name }
    }
    throw new Error('用户名或密码错误')
  },
  /** 健康自检（后端通不通 / 库连没连上） */
  async health() {
    try { return (await http.get('/health')).data } catch (e) { throw new Error(reason(e)) }
  },
  /** 一次拉取全部业务表 → { 表名: 行数组 } */
  async fetchMapData() {
    try {
      const d = (await http.get('/mapdata')).data
      if (!d.ok) throw new Error(d.error)
      return d.data
    } catch (e) { throw new Error(reason(e)) }
  },
  async table(t) {
    try {
      const d = (await http.get(`/tables/${t}`)).data
      if (!d.ok) throw new Error(d.error)
      return d.rows
    } catch (e) { throw new Error(reason(e)) }
  },
  async create(t, row) {
    try {
      const d = (await http.post(`/tables/${t}`, row)).data
      if (!d.ok) throw new Error(d.error)
      return d
    } catch (e) { throw new Error(reason(e)) }
  },
  async update(t, id, row) {
    try {
      const d = (await http.put(`/tables/${t}/${id}`, row)).data
      if (!d.ok) throw new Error(d.error)
      return d
    } catch (e) { throw new Error(reason(e)) }
  },
  async remove(t, id) {
    try {
      const d = (await http.delete(`/tables/${t}/${id}`)).data
      if (!d.ok) throw new Error(d.error)
      return d
    } catch (e) { throw new Error(reason(e)) }
  }
}
