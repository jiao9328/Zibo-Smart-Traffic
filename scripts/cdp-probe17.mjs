/* 定向回归：2026-09-15 用户十条符号系统改动的验收（v4 emoji 版）。
 *
 * 覆盖：
 *   A 点位符号装配 —— 形状名 / 尺寸（四层统一 9px 常量）/ 用色 / **绑定**的是图片模型
 *   B 烤出来的位图本体 —— 把 __traffic.emoji(k) 的 data URL 拿到 Node 侧解码：
 *     墨迹占比（真烤出 emoji 了没）、遮罩模式是不是「纯白底 + 状态色挖洞」
 *   C 裁剪 —— 图层要素数 == 用**独立实现**在 Node 侧重算的「离路网 ≤500m」行数
 *   D 悬停光标 —— 进要素 pointer、出要素收回；隐藏图层也收回（第 7 条）
 *   E 道路图层变细 + 建筑 sweep 动画已删（第 8 条）
 *   F 大屏数据同源 + 点行 → 缩放到对应（第 9 条）
 *   H 聚合桶像素 —— hide/show 差分取墨迹掩膜，证明桶上画的是与散点**同一枚、同一尺寸**的
 *     emoji（用户 2026-09-15：「深色实心圆 + 居中白数字不要，缩小后还是 emoji」）
 *
 * ★ 本文件**不 import src/ 下的模块**：那些模块走 vite 的 '@' 别名 + 依赖 @antv/l7，
 *   Node 直接 import 会解析失败（probe14 只 import 了无依赖的 trafficIcons.js 才能跑）。
 *   凡是「期望值」都从源码文本里解析 / 独立重算，反而比 import 实现更硬（不是自己验自己）。
 *
 * 前置：npm run dev(:5173)、npm run server(:3001)、headless Chrome --remote-debugging-port=9223
 * 用法：APP_PORT=5173 node scripts/cdp-probe17.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { decodePNG, classifyPixels } from './lib/png.mjs'

const require = createRequire(import.meta.url)
const SRC = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8')

/* ---- 期望值 1：emoji 字符表（从 trafficIcons.js 源码正则解析，不 import） ---- */
const ICONS = {}
for (const m of SRC('tools/trafficIcons.js').matchAll(
  /(\w+):\s*\{\s*id:\s*'([^']+)',\s*char:\s*'([^']+)',\s*fallbackShape:\s*'[^']*',\s*mode:\s*'(\w+)'/g
)) ICONS[m[1]] = { id: m[2], char: m[3], mode: m[4] }
const POINTS = ['camera', 'trafficLight', 'police', 'busStop']
const SYMBOL = Number(/const SYMBOL = (\d+)/.exec(SRC('tools/initTrafficLayers.js'))[1])

/* ---- 期望值 2：分级道路宽度（同样正则解析） ---- */
const ROAD_W = {}
for (const m of SRC('tools/roadClassLayers.js').matchAll(
  /key:\s*'(\w+)',\s*label:\s*'[^']+',[^}]*width:\s*([\d.]+)\s*\}/g
)) ROAD_W[m[1]] = Number(m[2])
const BASE_ROAD_W = Number(/\.size\(([\d.]+)\)\s*\/\/ 全路网/.exec(SRC('tools/initLayer.js'))[1])

/* ---- 期望值 3：裁剪阈值 ---- */
const MAX_M = Number(/export const MAX_M = (\d+)/.exec(SRC('tools/roadCoverage.js'))[1])

/* ---- 期望值 4：独立重算「离最近路网顶点 ≤ MAX_M」----
 * 故意不复用 roadCoverage.js：那份实现用 0.01° 网格 + ±3 格搜索，这里用**全量暴力**
 * （4.6 万顶点 × 几百行，秒级），两套实现结论一致才说明阈值口径是真的。 */
const ROADS = require('../src/assets/GIS_Data/Zibo_roads.json')
const VERTS = []
for (const f of ROADS.features) for (const c of f.geometry.coordinates) VERTS.push(c)
const M_LAT = 110540
const keepOnRoad = (rows) => {
  let kept = 0
  for (const r of rows) {
    const lng = Number(r.lng), lat = Number(r.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    const kx = 111320 * Math.cos((lat * Math.PI) / 180)
    let best = Infinity
    for (const v of VERTS) {
      const dx = (v[0] - lng) * kx, dy = (v[1] - lat) * M_LAT
      const d = dx * dx + dy * dy
      if (d < best) best = d
    }
    if (Math.sqrt(best) <= MAX_M) kept++
  }
  return kept
}

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5173'
const BASE = `http://127.0.0.1:${PORT}`

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created?.webSocketDebuggerUrl) { console.log('无法创建标签页'); process.exit(1) }
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    if (m.error) console.log(`  ! CDP ${m.error.message}`)
    pending[m.id](m.result); delete pending[m.id]
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>'
      : r?.result?.value)
const evj = (x) => ev(x).then((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return s } })

let pass = 0, fail = 0
const fails = []
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; fails.push(label); console.log(`  ❌ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`) }
}
const info = (l, v) => console.log(`  ·  ${l}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)
const waitFor = async (expr, ms = 40000, step = 400) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) }
  return false
}

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason&&e.reason.message||e.reason)));
      try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'admin',display_name:'核验'}))}catch(e){}`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  check(await waitFor(`!!(window.__map && window.__scene && window.__traffic)`), '地图 boot + __traffic 桥就绪')
  await sleep(2500)
  info('期望值（从源码解析）', { SYMBOL, MAX_M, 基础路网宽: BASE_ROAD_W, 分级宽: ROAD_W, emoji: Object.fromEntries(Object.entries(ICONS).map(([k, v]) => [k, v.char])) })

  /* ================= A 点位符号装配 ================= */
  console.log('\n===== A 点位符号（形状名 / 尺寸 / 用色 / 绑定模型） =====')
  /* 期望用色：原色分支给 '#FFFFFF'（图层色＝白 ⇒ 用纹理本身的颜色），
   * 信号灯走遮罩分支 ⇒ 四个状态色（从源码解析，不写死第二份）。 */
  const src = SRC('tools/initTrafficLayers.js')
  const STATE = Object.fromEntries([...src.matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2].toUpperCase()]))
  const EXPECT_COLORS = {
    camera: ['#FFFFFF', STATE.faulty],
    trafficLight: [STATE.green, STATE.red, STATE.yellow, STATE.fault],
    police: ['#FFFFFF'],
    busStop: ['#FFFFFF']
  }
  for (const n of POINTS) {
    await ev(`window.__traffic.setVisible(${JSON.stringify(n)}, true)`)
    await sleep(700)
    const r = await evj(`(()=>{const it=window.__traffic.registry[${JSON.stringify(n)}]
      if(!it||!it.layer) return JSON.stringify({err:'no-layer'})
      const l=it.layer
      const a=(l.configService&&l.configService.getAttributeConfig(l.id))||{}
      const val=(k)=>{const o=a[k]; if(!o) return null
        if (typeof o.values==='function'){const out={}
          for(const s of ['normal','fault','green','red','yellow']) { try{out[s]=o.values(s)}catch(e){out[s]='err'} }
          return {field:o.field, byValue:out}}
        if (o.values!==undefined) return {field:o.field, values:o.values}
        return o.field}
      const sz=a.size
      /* 尺寸现在是**常量** .size(SYMBOL)：散点和聚合点画同一个大小（用户 2026-09-15「缩小后还是 emoji」）。
       * 常量写法下 L7 把值直接放在 attributes 上（无 field），取出来就是个数。 */
      const sizeP=(sz&&typeof sz.values!=='function')?(sz.values!==undefined?sz.values:sz.field):null
      const m=(l.models||[])[0]; const us=m?Object.keys(m.uniforms||{}):[]
      const d=l.layerSource&&l.layerSource.originData
      return JSON.stringify({组件数:(it.group||[]).length,
        shape:(l.shapeOption&&l.shapeOption.field)||val('shape'), sizeP, color:val('color'),
        块数:(d&&d.features||[]).length, 模型: m?m.constructor.name:'无',
        u_texture: us.indexOf('u_texture')>=0 && us.indexOf('u_textSize')>=0})})()`)
    info(n, r)
    if (!r || r.err) { check(false, `${n} 图层实例存在`, r); continue }
    check(r.shape === ICONS[n].id, `${n} 形状名 = ${ICONS[n].id}`, r.shape)
    /* 单图层：用户 2026-09-15 推翻了「深色实心圆 + 居中白数字」，-聚 / -数 两层删掉，
     * 缩小时的聚合桶直接照画同一枚 emoji。 */
    check(r.组件数 === 1, `${n} 一套点位 = 1 个 L7 图层（只有 emoji 图标层）`, r.组件数)
    check(r.sizeP === SYMBOL,
      `${n} 尺寸 = ${SYMBOL}px 常量（散点与聚合桶同一个大小，不随点数变）`, r.sizeP)
    check(r.u_texture === true, `${n} **绑定**的模型是图片模型（着色器带 u_texture + u_textSize）`, { 模型: r.模型, u_texture: r.u_texture })
    check(r.块数 > 0, `${n} 图层有数据（${r.块数} 个要素）`, r.块数)
    const got = r.color && r.color.byValue
      ? [...new Set(Object.values(r.color.byValue).filter((v) => typeof v === 'string' && v[0] === '#'))].map((v) => v.toUpperCase()).sort()
      : [String(r.color).toUpperCase()]
    const want = [...EXPECT_COLORS[n]].sort()
    check(JSON.stringify(got) === JSON.stringify(want), `${n} 用色集合 == 本层规范`, { got, want })
  }
  check(new Set(POINTS.map((k) => ICONS[k].char)).size === 4, '四类 emoji 字符两两不同（不撞形）', POINTS.map((k) => ICONS[k].char))

  /* ================= B 烤出来的位图本体 ================= */
  console.log('\n===== B 烤图（__traffic.emoji → Node 侧解码 PNG） =====')
  for (const n of POINTS) {
    const url = await ev(`window.__traffic.emoji(${JSON.stringify(n)})`)
    if (typeof url !== 'string' || !url.startsWith('data:image/png')) { check(false, `${n} 烤出了 PNG data URL`, String(url).slice(0, 40)); continue }
    const img = decodePNG(Buffer.from(url.split(',')[1], 'base64'))
    let ink = 0, colorPx = 0, whitePx = 0
    const d = img.rgba
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] <= 8) continue
      ink++
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2])
      if (mx - mn > 30) colorPx++
      else if (mn > 200) whitePx++
    }
    const total = img.width * img.height
    info(`${n} ${ICONS[n].char}`, { 尺寸: `${img.width}×${img.height}`, 墨迹: ink, 墨迹占比: +(ink / total).toFixed(3), 彩色像素: colorPx, 近白像素: whitePx })
    check(img.width === 96 && img.height === 96, `${n} 位图 96×96`, { 宽: img.width, 高: img.height })
    check(ink / total > 0.02, `${n} 位图有墨迹（占比 ${(ink / total * 100).toFixed(1)}%，说明这台机器有 emoji 字体）`, ink)
    if (ICONS[n].mode === 'mask') {
      /* 遮罩模式：bake 已把整枚压成白色不透明、并挖掉蓝通道 ≤2 的像素（三个灯位）。
       * 判据 = 所有不透明像素都是纯白 + 有洞（墨迹占比明显低于原色字形）。 */
      check(colorPx === 0 && whitePx === ink, `${n} 遮罩模式：不透明像素全是纯白（状态色由运行时染）`, { 彩色: colorPx, 白: whitePx, 墨: ink })
      check(ink / total < 0.85, `${n} 遮罩模式：三个灯位被挖成洞（墨迹占比 ${(ink / total * 100).toFixed(1)}% < 满框）`, ink / total)
    } else {
      check(colorPx > ink * 0.15, `${n} 原色模式：位图保留 emoji 本身的颜色（彩色像素 ${colorPx}/${ink}，运行时不改色）`, { 彩色: colorPx, 墨: ink })
    }
  }

  /* ================= C 裁剪 ================= */
  console.log(`\n===== C 裁剪（只画离路网 ≤${MAX_M}m 的要素；期望值在 Node 侧用暴力最近顶点独立重算） =====`)
  const counts = await evj(`(()=>{const o={}
    for(const n of ${JSON.stringify(POINTS)}){
      const it=window.__traffic.registry[n]
      const d=it&&it.layer&&it.layer.layerSource&&it.layer.layerSource.originData
      o[n]=(d&&d.features||[]).length}
    return JSON.stringify(o)})()`)
  // 后端响应是 { ok, data: { 表名: 行[] } }，不是裸的表字典
  const dbRaw = await (await fetch('http://localhost:3001/api/mapdata')).json().then((j) => j && j.data).catch(() => null)
  if (!dbRaw) {
    check(false, '能取到后端全量数据（裁剪对比的基准；需 npm run server）')
  } else {
    const TABLE_OF = { camera: 'cameras', trafficLight: 'traffic_lights', police: 'police', busStop: 'bus_stops' }
    for (const n of POINTS) {
      const rows = dbRaw[TABLE_OF[n]] || []
      const kept = keepOnRoad(rows)
      info(`${n} 库 ${rows.length} 行 → 独立重算保留 ${kept} → 图层实际 ${counts && counts[n]}`)
      check(counts && counts[n] === kept, `${n} 图层要素数 == 独立重算的裁剪保留数（${kept}）`, { 图层: counts && counts[n], 期望: kept, 库: rows.length })
    }
  }

  /* ================= D 悬停光标 ================= */
  console.log('\n===== D 悬停光标（第 7 条：四处抓的小白手 → 可点击） =====')
  await ev(`window.__traffic.setVisible('camera', true)`)
  await sleep(500)
  const cursorProbe = await evj(`(()=>{const it=window.__traffic.registry.camera
    const l=it&&it.layer; if(!l) return JSON.stringify({err:'no-layer'})
    const cv=window.__map.getCanvas()
    const g=()=>cv.style.cursor||''
    try{ l.emit('mouseenter', {feature:{}}) }catch(e){ return JSON.stringify({err:'emit:'+e.message}) }
    const on=g()
    try{ l.emit('mouseleave', {feature:{}}) }catch(e){}
    const off=g()
    try{ l.emit('mouseenter', {feature:{}}) }catch(e){}
    window.__traffic.setVisible('camera', false)
    const afterHide=g()
    window.__traffic.setVisible('camera', true)
    return JSON.stringify({进要素:on, 出要素:off, 隐藏后:afterHide})})()`)
  info('光标状态', cursorProbe)
  check(cursorProbe && cursorProbe.进要素 === 'pointer', '鼠标进要素 → cursor=pointer', cursorProbe && cursorProbe.进要素)
  check(cursorProbe && cursorProbe.出要素 === '', '鼠标出要素 → cursor 交回 mapbox 自己管（空串）', cursorProbe && cursorProbe.出要素)
  check(cursorProbe && cursorProbe.隐藏后 === '', '隐藏图层 → 光标强制收回（不会卡在 pointer）', cursorProbe && cursorProbe.隐藏后)

  /* ================= E 道路变细 + sweep 已删 ================= */
  console.log('\n===== E 道路图层变细 + 建筑 sweep 动画已删（第 8 条） =====')
  /* ★ 取实例必须走 baseLayerMap（__base.get）：scene.getLayers() 里 L7 把 layer.id 覆写成了
   *   它在场景中的数字序号（实测只有 '0'/'1'），按构造时给的 '淄博道路' 根本找不到。
   * ★ size 的读法：单参 .size(0.7) 存成 { field: 0.7 }、双参 .size('f',[a,b]) 存成 { values }，
   *   只读 .values 会把前者读成 undefined（本文件踩过一次，靠打印原始值才发现）。 */
  const base = await evj(`(()=>{try{const l=window.__base && window.__base.get('淄博道路')
    if(!l) return JSON.stringify({err:'实例为空（图层还没建？）'})
    const a=(l.configService&&l.configService.getAttributeConfig(l.id))||{}
    const size=a.size&&(a.size.values!==undefined?a.size.values:a.size.field)
    return JSON.stringify({size, 可见:!!(l.isVisible&&l.isVisible())})}catch(e){return JSON.stringify({err:e.message})}})()`)
  info('基础路网「淄博道路」', base)
  check(base && !base.err, '基础路网图层实例可读（window.__base 桥）', base)
  if (base && !base.err) {
    check(base.size === BASE_ROAD_W, `基础路网宽度 == 源码里的 ${BASE_ROAD_W}（原来 1，变细了）`, base.size)
  }
  /* 建筑 sweep：**只能看着色器 uniform 判**，不能读 rawConfig。
   * rawConfig 里 style 是平铺的（opacity/baseColor/windowColor/brightColor），根本没有 sweep 这一层的
   * 嵌套 —— 写成 `rawConfig.style.sweep === undefined` 是恒真的假通过（本文件第一版就是这样）。
   * uniform 才是渲染真正吃的东西（L7 city 片元的 u_circleSweep 默认 0=不画光环）。 */
  const bldRes = await evj(`(()=>{try{const l=window.__base && window.__base.get('淄博市')
    if(!l) return JSON.stringify({err:'实例为空'})
    const m=(l.models||[])[0]
    const u=(m&&m.uniforms)||{}
    return JSON.stringify({rawConfig键:Object.keys(l.rawConfig||{}),
      sweep配置:l.rawConfig&&l.rawConfig.sweep?JSON.stringify(l.rawConfig.sweep):null,
      有u_circleSweep:'u_circleSweep' in u,
      u_circleSweep:u.u_circleSweep==null?null:JSON.stringify(u.u_circleSweep),
      u_time:u.u_time==null?null:JSON.stringify(u.u_time),
      可见:!!(l.isVisible&&l.isVisible())})}catch(e){return JSON.stringify({err:e.message})}})()`)
  info('城市建筑「淄博市」', bldRes)
  check(bldRes && !bldRes.err, '城市建筑图层实例可读', bldRes)
  if (bldRes && !bldRes.err) {
    check(bldRes.sweep配置 === null, '建筑 rawConfig 里没有 sweep 配置', bldRes.sweep配置)
    /* u_circleSweep 必须**存在**且为 0：不存在就说明 L7 改了 uniform 名，这条判据失效，
     * 得当成失败（否则删掉 sweep 之后这条会静默恒真） */
    check(bldRes.有u_circleSweep === true && bldRes.u_circleSweep === '0',
      '着色器 uniform u_circleSweep = 0（从中心向外扩散的光环在渲染层面已关）', { 有: bldRes.有u_circleSweep, 值: bldRes.u_circleSweep })
    check(bldRes.u_time === '0', 'u_time = 0（.animate(true) 已去掉，没有动画时间在走）', bldRes.u_time)
  }
  /* 分级道路：逐个切到该等级、从运行时读宽度（实例同样走 __roads.layerOf） */
  for (const [key, want] of Object.entries(ROAD_W)) {
    await ev(`window.__roads.select(${JSON.stringify(key)})`)
    await sleep(500)
    const r = await evj(`(()=>{try{const l=window.__roads.layerOf(${JSON.stringify(key)})
      if(!l) return JSON.stringify({err:'未找到分级道路图层'})
      const a=(l.configService&&l.configService.getAttributeConfig(l.id))||{}
      return JSON.stringify({size:a.size&&(a.size.values!==undefined?a.size.values:a.size.field),
        color:a.color&&(a.color.values!==undefined?a.color.values:a.color.field),
        可见:!!(l.isVisible&&l.isVisible())})}catch(e){return JSON.stringify({err:e.message})}})()`)
    info(`${key} 运行时`, r)
    check(r && r.size === want, `${key} 运行时宽度 == 源码里的 ${want}`, r)
    check(r && r.可见 === true, `${key} 切过去之后确实是显示状态`, r)
  }
  await ev(`window.__roads.select(null)`)
  await sleep(500)

  /* ================= F 大屏数据同源 + 点行定位 ================= */
  console.log('\n===== F 交通大屏（第 9 条：数据同源 + 点行缩放到对应） =====')
  /* 底部工具条的按钮是「.btn-groups .item > button + p」，标签文字在 p 上、点击处理挂在 .item 上 */
  const opened = await evj(`(()=>{const p=[...document.querySelectorAll('.btn-groups p')].find(e=>/交通大屏/.test(e.textContent||''))
    if(!p) return JSON.stringify({err:'找不到大屏按钮', 候选:[...document.querySelectorAll('.btn-groups p')].map(e=>e.textContent.trim())})
    p.click(); return JSON.stringify({ok:true, 点击: p.textContent.trim()})})()`)
  info('打开大屏', opened)
  check(await waitFor(`!!document.querySelector('.ts-screen')`, 6000), '大屏已打开')
  const kpi = await evj(`(()=>{const k=[...document.querySelectorAll('.ts-kpi')].map(e=>e.textContent.trim())
    return JSON.stringify({kpis:k.slice(0,3), 行数:document.querySelectorAll('.ts-row').length})})()`)
  info('大屏 KPI', kpi)
  const dbCam = dbRaw ? (dbRaw.cameras || []).length : null
  check(!!kpi && dbCam !== null && kpi.kpis[0] && kpi.kpis[0].includes(String(dbCam)),
    `大屏「监控探头」KPI == 刚取到的库表行数 ${dbCam}（同一来源，数据改动会同步过来）`, kpi && kpi.kpis[0])
  const clicked = await evj(`(()=>{const rows=[...document.querySelectorAll('.ts-card[data-card="congestion"] .ts-row')]
    if(!rows.length) return JSON.stringify({err:'拥堵排行没有行'})
    rows[0].click(); return JSON.stringify({ok:true, 行数:rows.length, 首行:rows[0].textContent.trim().slice(0,40)})})()`)
  info('点拥堵排行第一行', clicked)
  await sleep(400)
  check(await waitFor(`!!document.querySelector('.ts-detail')`, 4000), '底部详情条出现（点行有反馈）')
  const before = await evj(`JSON.stringify({c:[+window.__map.getCenter().lng.toFixed(5),+window.__map.getCenter().lat.toFixed(5)], z:+window.__map.getZoom().toFixed(2)})`)
  const btn = await evj(`(()=>{const b=[...document.querySelectorAll('.ts-detail button')].find(e=>/在地图上查看/.test(e.textContent||''))
    if(!b) return 'no-btn'; b.click(); return 'ok'})()`)
  await sleep(2400)
  const after = await evj(`JSON.stringify({c:[+window.__map.getCenter().lng.toFixed(5),+window.__map.getCenter().lat.toFixed(5)], z:+window.__map.getZoom().toFixed(2),
    大屏已关:!document.querySelector('.ts-screen'), 拥堵层:window.__traffic.visible('congestion')})`)
  info('「在地图上查看」', { 按钮: btn, 前: before, 后: after })
  // evj 已经把 JSON.parse 过了，别再 parse 一次（会抛 "[object Object]" is not valid JSON）
  const b = before, a = after
  const moved = Math.abs(a.c[0] - b.c[0]) + Math.abs(a.c[1] - b.c[1])
  check(btn === 'ok', '详情条里有「在地图上查看」按钮', btn)
  check(moved > 0.002 || Math.abs(a.z - b.z) > 0.5, '点「在地图上查看」后地图确实飞到了目标（中心或缩放变了）', { 位移: +moved.toFixed(4), 前: b, 后: a })
  check(a.拥堵层 === true, '定位同时把「道路拥堵」图层打开了', a.拥堵层)
  check(a.大屏已关 === true, '定位后大屏自动关闭（否则地图被盖住看不见）', a.大屏已关)

  /* ================= G 真的画在屏幕上了吗（逐要素查渲染像素） =================
   * 上面 A/B 证明的是「配好了、图烤对了」，C 证明「数据留对了」，
   * 但都证明不了「L7 真的把这枚 emoji 画到了那个坐标上」。这里数像素：
   * 信号灯走**遮罩分支**，码出来的是**纯状态色实心剪影**（#12B76A/#F04438/…），
   * 这几个色在亮色底图（灰白路网 + 蓝路网 #1990FF）里不存在 ⇒ 命中即图标。
   * 做法：飞到信号灯密集处 → 把每个要素投影到屏幕坐标 → 在它周围 26×26 的窗口里数状态色像素。 */
  console.log('\n===== G 渲染像素复核（信号灯剪影是否真画在要素坐标上） =====')
  for (const k of POINTS) await ev(`window.__traffic.setVisible(${JSON.stringify(k)}, ${k === 'trafficLight'})`)
  await sleep(900)
  const seed = await evj(`(()=>{const it=window.__traffic.registry.trafficLight
    const fs=(it&&it.layer&&it.layer.layerSource&&it.layer.layerSource.originData.features)||[]
    if(!fs.length) return null
    const s=[...fs].sort((a,b)=>a.geometry.coordinates[0]-b.geometry.coordinates[0])
    const m=s[Math.floor(s.length/2)].geometry.coordinates
    return JSON.stringify({lng:m[0], lat:m[1], 总数:fs.length})})()`)
  info('信号灯取样中心（经度中位数）', seed)
  if (!seed) { check(false, '信号灯层有要素可取样', seed) } else {
    await ev(`(()=>{window.__map.jumpTo({center:[${seed.lng},${seed.lat}],zoom:17,pitch:0});return 'ok'})()`)
    await sleep(2000)
    const targets = await evj(`(()=>{const it=window.__traffic.registry.trafficLight
      const fs=(it&&it.layer&&it.layer.layerSource&&it.layer.layerSource.originData.features)||[]
      const out=[]
      for(const f of fs){const p=f.geometry.coordinates, s=window.__map.project([p[0],p[1]])
        if(s.x>60&&s.x<1540&&s.y>60&&s.y<840) out.push({x:Math.round(s.x),y:Math.round(s.y),state:(f.properties||{}).state})
        if(out.length>=8) break}
      return JSON.stringify(out)})()`)
    info(`视口内信号灯（zoom17）`, targets)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const img = decodePNG(Buffer.from(shot.data, 'base64'))
    const STATES = [STATE.green, STATE.red, STATE.yellow, STATE.fault]
    let hit = 0
    const rows = []
    for (const t of (targets || [])) {
      const px = classifyPixels(img, { x: t.x - 13, y: t.y - 13, width: 26, height: 26 },
        STATES.map((hex) => ({ key: hex, hex, maxDist: 60 })))
      const ink = STATES.reduce((s, hex) => s + (px[hex] || 0), 0)
      // 自己的状态色单独看：画的应该是**它自己那个状态**的颜色（不是别的状态）
      const own = px[STATE[t.state]] || 0
      rows.push({ 状态: t.state, 墨迹: ink, 本色: own })
      if (ink >= 12) hit++
    }
    info('逐要素窗口内的状态色像素', rows)
    check(targets && targets.length >= 3, `视口内至少 3 个信号灯可查（实际 ${(targets || []).length}）`, (targets || []).length)
    check(hit >= Math.max(1, Math.ceil((targets || []).length * 0.7)),
      `≥70% 的信号灯在自己的屏幕坐标处**画出了状态色剪影**（${hit}/${(targets || []).length}；底图里没有这几个色，命中即图标）`, rows)
    /* 同屏还要有底图路网蓝：说明这一屏不是空白，比对才有意义 */
    const roadPx = (() => { const px = classifyPixels(img, { x: 0, y: 0, width: 1600, height: 900 }, [{ key: 'road', hex: '#1990FF', maxDist: 60 }]); return px.road })()
    info('整屏路网蓝像素', roadPx)
    check(roadPx > 0, '同屏能看到底图路网（不是一片空白）', roadPx)
  }

  /* ================= H 聚合桶的渲染像素（本次核心证据） =================
   * A 段只能证明「配置是这么写的」，写对了不等于**画出来了、画的是那个东西**
   * （L7 的坑见文件头：同一份配置在空数据分支上会建成方块模型，断言配置名照样全绿）。
   *
   * 用户 2026-09-15 的诉求：「深色实心圆 + 居中白数字不要，缩小后还是 emoji」。
   * 所以这里要证的是**桶和散点画的是同一枚 emoji、同一个尺寸**，验法是像素级的等价判定：
   *   ① 把 camera 层整层 hide 一帧再 show 一帧，两张截图的差 = 这一层画上去的**墨迹掩膜**
   *      （底图、路网、其它图层在两张图里逐像素相同，差分里一个点都不剩）。
   *      这样拿到的是「这一层到底画了什么形状」，不需要猜背景色、也不用管底图深浅。
   *   ② 取一个**散点**的掩膜当基准，取若干**聚合桶**的掩膜，在 ±2px 内平移对齐后算 IoU。
   *      是同一枚 emoji ⇒ IoU 高；退回上一版的实心圆 ⇒ 形状根本不同，IoU 立刻塌。
   *   ③ 墨迹面积：同一枚 emoji 在桶上和散点上必须基本相等（差 <15%）。
   *      顺便记下实心圆的理论面积（半径 9 ⇒ πr² ≈ 254px）作对照 —— emoji 的墨迹只有一半左右。
   * 为什么不用识图判：vision.js 在小字形上不可信（把四个桶全读成「2」），见 [[vision-js-limits]]。 */
  console.log('\n===== H 聚合桶像素复核（桶上画的是不是与散点同一枚 emoji） =====')
  /* 只留 camera 一层：低 zoom 下四层的桶会塌在市中心同一小片互相压边，
   * 差分里会混进别的层的墨迹（这条是量出来的，不是猜的）。 */
  for (const k of POINTS) await ev(`window.__traffic.setVisible(${JSON.stringify(k)}, ${k === 'camera'})`)
  /* 动态车辆（DOM marker）与底图道路流线要一并关掉：它们是**动的**，两张截图之间
   * 会自己变样，差分里就混进了与本次改动无关的像素（第一次跑就是这么假红的）。
   * 底图是 L7 里另一个图层，不在 camera 的 group 里，hide/show camera 影响不到它。 */
  await ev(`(()=>{try{window.__traffic.setVisible('vehicle', false)}catch(e){}
    try{const r=window.__base.get('淄博道路'); r&&r.hide()}catch(e){}
    return 1})()`)
  await sleep(900)
  /* 11.3 = 「整条路网刚好铺满屏幕」那一级，也正是用户 2026-09-15 说的
   * 「缩放到看到整个道路网时，也要能看到几十个点数据」。 */
  await ev(`(()=>{window.__map.jumpTo({center:[118.037,36.813],zoom:11.3,pitch:0});return 'ok'})()`)
  await sleep(1600)
  /* 取要素：桶（n>1）和散点（n=1）都要，且必须满足两条 ——
   *   · **孤立**：到同层最近邻 ≥22px，贴在一起的两个符号会在同一个 21×21 窗口里重叠；
   *   · **没被 UI 浮层盖住**：中心 + 四角命中到的元素都得落在**地图容器内**。
   *     第一版跑挂了两次，都是这条惹的：
   *       ⓐ 一开始压根没做遮挡检查，取到的散点在 (1082,57) 被顶部导航栏压着，
   *         差分当然是 0，看起来就像「emoji 没画出来」；
   *       ⓑ 改成判 `tagName === 'CANVAS'` 之后**所有**点都被判成被盖住（桶数直接归零）——
   *         因为 L7 自己的 canvas 是 `pointer-events:none`，命中的永远是它上面那层
   *         `DIV.l7-marker-container`（在容器内，属于地图自己的浮层，**不算**被盖）。
   *     所以判据是「在地图容器内」而不是「是不是 canvas」，实测过两条都是必要的。 */
  const bk = await evj(`(()=>{const it=window.__traffic.registry.camera
    const l=it&&it.layer, idx=l&&l.layerSource&&l.layerSource.clusterIndex
    if(!idx) return JSON.stringify({err:'no-index'})
    const b=window.__map.getBounds(), t=Math.floor(window.__map.getZoom()-1)
    const cl=idx.getClusters([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],t)
    const W=window.innerWidth, H=window.innerHeight, all=[], buckets=[], dots=[]
    let 视图内桶=0, 视图内散=0, 被盖=0
    const cont=window.__map.getContainer()
    const clean=(x,y)=>{const o=document.elementFromPoint(x,y); return !!o && (o===cont||cont.contains(o))}
    const clearAll=(x,y)=>clean(x,y)&&clean(x-10,y)&&clean(x+10,y)&&clean(x,y-10)&&clean(x,y+10)
    for(const f of cl){const n=(f.properties&&f.properties.point_count)||1
      const c=f.geometry.coordinates, p=window.__map.project([c[0],c[1]])
      const o={x:p.x,y:p.y,n:n,abbr:f.properties.point_count_abbreviated,status:f.properties.status}
      all.push(o)
      if(o.x<20||o.y<20||o.x>W-20||o.y>H-20) continue
      if(n>1) 视图内桶++; else 视图内散++
      if(!clearAll(Math.round(o.x),Math.round(o.y))){被盖++;continue}
      if(n>1) buckets.push(o); else if(o.status!=='fault') dots.push(o)}
    const near=(a)=>{let best=1e9
      for(const o of all){if(o.x===a.x&&o.y===a.y)continue
        const d=Math.hypot(o.x-a.x,o.y-a.y); if(d<best)best=d}
      return best}
    for(const a of buckets) a.iso=near(a)
    for(const a of dots) a.iso=near(a)
    return JSON.stringify({t:t, 要素数:cl.length, 视图内桶:视图内桶, 视图内散:视图内散, 被浮层盖住:被盖,
      桶数:buckets.length, 散点数:dots.length,
      孤立桶:buckets.filter(o=>o.iso>=22).length, 孤立散点:dots.filter(o=>o.iso>=22).length,
      桶:buckets.filter(o=>o.iso>=22).sort((a,b)=>b.iso-a.iso).slice(0,6),
      散点:dots.filter(o=>o.iso>=22).sort((a,b)=>b.iso-a.iso).slice(0,3)})})()`)
  info('整网视图（zoom 11.3）camera 层', bk && {
    树zoom: bk.t, 视图内要素: bk.要素数, 视图内桶: bk.视图内桶, 视图内散: bk.视图内散,
    被浮层盖住: bk.被浮层盖住, 可用桶: bk.桶数, 可用散点: bk.散点数,
    孤立桶: bk.孤立桶, 孤立散点: bk.孤立散点
  })
  check(bk && bk.要素数 >= 30,
    `整条路网铺满屏幕时能看到「几十个」点数据（实际 ${bk && bk.要素数} 个）`, bk && bk.要素数)
  if (!bk || bk.err || !(bk.桶 || []).length || !(bk.散点 || []).length) {
    check(false, 'camera 层在整网视图同时有未被遮挡的孤立桶与散点可取样', bk)
  } else {
    /* ①②：hide / show 两张图求差 → 墨迹掩膜。差分阈值取 30（sum-abs）：
     * 低于它的只有画布噪声（实测两张无变化截图的自差是 0，L7 的 canvas 没有抖动）。 */
    const shot = async () => decodePNG(Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    /* 先干净地藏一层：setVisible 会走 show()/hide()，clusters 索引不动，回来时形状一致 */
    const grab = async () => {
      await ev(`window.__traffic.setVisible('camera', false)`)
      await sleep(700)
      const off = await shot()
      await ev(`window.__traffic.setVisible('camera', true)`)
      await sleep(900)
      const on = await shot()
      return { off, on }
    }
    const { off, on } = await grab()
    /* 先量一个**总量**：两张图在整屏范围内的差异像素。它应该 ≈ 画出来的符号数 × 单枚墨迹
     * （几十个符号 ⇒ 几千到两万）。要是几十万，说明还有别的东西在动（底图流线没关干净、
     * 浮层里有动画），那种差分不能用来判形状 —— 这一步就是为了让「假红」自己暴露出来。 */
    let 全屏差分 = 0
    for (let y = 0; y < Math.min(off.height, on.height); y++) {
      for (let x = 0; x < Math.min(off.width, on.width); x++) {
        const i = (y * off.width + x) * 4, j = (y * on.width + x) * 4
        if (Math.abs(off.rgba[i] - on.rgba[j]) + Math.abs(off.rgba[i + 1] - on.rgba[j + 1]) + Math.abs(off.rgba[i + 2] - on.rgba[j + 2]) > 30) 全屏差分++
      }
    }
    info('hide/show 差分的全屏差异像素', { 全屏差分, 画布: `${off.width}×${off.height}`, 参考_单枚屏幕墨迹约: 200 })
    /* 参考量级：18px 的 📹 位图本身墨迹占 49.5%（≈160px），屏幕上的差分会把抗锯齿外缘
     * （半透明、与底图混色）一并算进来，实测每枚 ≈200px。视图内有 50 来个要素 ⇒ 约 1 万。 */
    check(全屏差分 > 0 && 全屏差分 < 60000,
      `差分里只有 camera 层自己的墨迹（${全屏差分}px，量级对得上；几十万说明有别的动画在动）`, 全屏差分)
    check(off.width === on.width && off.height === on.height, '两次截图的画布尺寸一致（差分可比）', [off.width, on.width])
    const at = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]] }
    const R = 10 // 取样半径：屏幕 21×21 的窗口，装得下 18px 的 emoji 方框 + 抗锯齿余量
    /* 掩膜 = 该窗口内「这一层画上去的像素」的集合（坐标用窗口内相对量，便于平移对齐） */
    const maskAt = (c) => {
      const cx = Math.round(c.x), cy = Math.round(c.y), m = new Set()
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx, y = cy + dy
        if (x < 0 || y < 0 || x >= off.width || y >= off.height) continue
        const a = at(on, x, y), b = at(off, x, y)
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 30) m.add(dx + ',' + dy)
      }
      return m
    }
    const 参考 = maskAt(bk.散点[0])
    info(`散点基准掩膜 @屏幕(${bk.散点[0].x.toFixed(0)},${bk.散点[0].y.toFixed(0)})`, {
      墨迹像素: 参考.size, 最近邻: +bk.散点[0].iso.toFixed(0),
      对照_实心圆理论面积: +((Math.PI * SYMBOL * SYMBOL).toFixed(0))
    })
    check(参考.size > 60, `散点基准处确实画了符号（墨迹 ${参考.size}px；18px 实心圆的理论面积是 ${Math.round(Math.PI * SYMBOL * SYMBOL)}px）`, 参考.size)
    /* IoU（平移对齐版）：把它整体平移到 ±2px 里最合的落点再算交并比 */
    const iou = (a, b) => {
      let best = 0
      for (let sx = -2; sx <= 2; sx++) for (let sy = -2; sy <= 2; sy++) {
        let inter = 0
        for (const k of a) { const [x, y] = k.split(',').map(Number); if (b.has((x + sx) + ',' + (y + sy))) inter++ }
        const union = a.size + b.size - inter
        if (union > 0 && inter / union > best) best = inter / union
      }
      return best
    }
    const 桶结果 = bk.桶.map((b) => {
      const m = maskAt(b)
      return { 真值: b.n, 缩写: b.abbr, 墨迹: m.size, 最近邻: +b.iso.toFixed(0), 与散点IoU: +iou(m, 参考).toFixed(2) }
    })
    info('聚合桶掩膜 vs 散点掩膜', 桶结果)
    const 空桶 = 桶结果.filter((r) => r.墨迹 === 0)
    check(空桶.length === 0,
      `每个聚合桶上都真画了符号（${桶结果.length} 个桶，无一是空的）——「缩小后 emoji 丢失」没有再犯`, 空桶)
    const 低IoU = 桶结果.filter((r) => r.与散点IoU < 0.75)
    check(低IoU.length === 0,
      `桶上画的形状与散点**逐像素同形**（IoU 最小 ${Math.min(...桶结果.map((r) => r.与散点IoU)).toFixed(2)}，实心圆/方块/文字都会远低于 0.75）`, 低IoU)
    /* ③ 尺寸：桶与散点的墨迹面积必须基本相等（同一枚 emoji、同一个 SYMBOL）。
     * 上一版桶是 14.4px 的圆（面积 163）、图标是 18px 方框，两者差得远；
     * 这一版若有人把桶改回「随点数变大的气泡」，面积差也会立刻暴露。 */
    const 桶面积 = 桶结果.map((r) => r.墨迹)
    const 均桶 = 桶面积.reduce((a, b) => a + b, 0) / 桶面积.length
    const 偏差 = Math.max(...桶面积.map((a) => Math.abs(a - 参考.size) / 参考.size))
    info('墨迹面积对照', { 散点: 参考.size, 桶均值: +均桶.toFixed(1), 桶各自: 桶面积, 最大偏差: +(偏差 * 100).toFixed(1) + '%' })
    check(偏差 <= 0.15,
      `桶的符号与散点**等大**（散点 ${参考.size}px，桶最大偏差 ${(偏差 * 100).toFixed(1)}% ≤15%）——尺寸不随桶内点数变`, { 桶面积, 散点: 参考.size })
  }

  const errs = await evj(`JSON.stringify((window.__errs||[]).slice(0,6))`)
  check((errs || []).length === 0, '全程无运行时错误', errs)

  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`)
  if (fail) console.log('失败项：\n - ' + fails.join('\n - '))
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
  ws.close()
  process.exitCode = fail ? 1 : 0
}
