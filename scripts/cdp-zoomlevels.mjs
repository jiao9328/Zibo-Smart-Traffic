/* 缩放级别体检：把四类点图层打开，逐级缩小（10.5 → 5.5），每级截图 + 记账。
 *
 * 起因（用户 2026-09-15）：「聚合标注有问题，缩小之后还是 emoji 符号丢失，变成含数字的实心大圆形」，
 * 以及后来推翻桶样式的那句「深色实心圆 + 居中白数字不要，缩小后还是 emoji」。
 * 光看源码看不出问题（同一份配置在 L7 的空数据分支上会建成完全不同的模型），所以这里**只做测量**：
 * 每一级都问 L7 的聚合索引「这一级会出几个桶几个散点」，同时截图数彩色墨迹像素。
 *
 * ★ 现在的读法（桶也画 emoji 之后）：符号尺寸全程恒定 ⇒ **彩色墨迹px / 视图内要素数**应当
 *   大体是个常数。哪一级这个比值塌下去，就说明那一级有符号没画出来（正是用户抱怨的现象）。
 *   上一版桶是纯色圆盘，在这个比值上表现为「越缩越小」——那正是要抓的病。
 *   注意这只是**近似量**：底图本身也有蓝/橙系像素，所以看趋势，不看绝对值。
 *
 * 记账口径：supercluster 的树 zoom = floor(mapZoom - 1)（DataSourcePlugin.js:104/110），
 * 所以查索引要用 floor(zoom-1)，不是 floor(zoom)。
 *
 * 前置：npm run dev(:5173) + headless Chrome(:9223)
 * 用法：APP_PORT=5173 node scripts/cdp-zoomlevels.mjs
 * 产物：logs/zoom-z*.png
 */
import { writeFileSync } from 'node:fs'
import { decodePNG, classifyPixels } from './lib/png.mjs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5173'
/* zoom 11.3 = 「整条路网刚好铺满 1440×900」的级别（路网 bbox 29.6×38.4km 算出来的，
 * 也是用户 2026-09-15 说的「缩放到看到整个道路网时」）。聚类在这级**仍然是开的**
 * （树 zoom = floor(mapZoom-1) = 10 < maxZoom 11），所以这一级最能暴露「太稀疏」。
 * 用 ZOOMS=12,11.3,10 node scripts/cdp-zoomlevels.mjs 可以只跑几档，调半径时快很多。 */
const ZOOMS = (process.env.ZOOMS || '12,11.3,10.5,9.5,8.5,7.5').split(',').map(Number)
const KEYS = ['camera', 'trafficLight', 'police', 'busStop']

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created?.webSocketDebuggerUrl) { console.log('无法创建标签页'); process.exit(1) }
const ws = new WebSocket(created.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
let msgId = 0
const pending = {}
const send = (m, p) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) { if (m.error) console.log('! CDP', m.error.message); pending[m.id](m.result); delete pending[m.id] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || '').split('\n')[0] + '>>' : r?.result?.value)

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'z',display_name:'z'}))}catch(e){}`
})
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
let ok = false
for (let i = 0; i < 60; i++) { if (await ev('!!(window.__map && window.__traffic)')) { ok = true; break } await sleep(500) }
if (!ok) { console.log('页面没就绪'); ws.close(); process.exit(1) }
// 四层全开（点位图层懒创建，不开就没有实例可查）
await ev(`(()=>{for(const k of ${JSON.stringify(KEYS)}) window.__traffic.setVisible(k,true); return 1})()`)
await sleep(1500)
// 关掉动态车辆与底图流线，免得把「变色小车」数进墨迹里
await ev(`(()=>{try{window.__traffic.setVisible('vehicle',false)}catch(e){}
  try{const r=window.__base.get('淄博道路'); r&&r.hide()}catch(e){}
  return 1})()`)
await sleep(500)

console.log('zoom | 桶数 | 散点数 | 桶内最多 | 彩色墨迹px | 视图内总要素 | 墨迹/要素')
const rows = []
for (const z of ZOOMS) {
  await ev(`(()=>{window.__map.jumpTo({zoom:${z},center:[118.037,36.813]}); return 1})()`)
  await sleep(1400) // 等聚合重算 + 重绘（实测 1400 足够，太快会截到上一级）
  /* 问索引「这一级出几个桶几个散点」。两个图层各建了一棵树，取图标层那棵即可（同源同参）。 */
  const book = await ev(`(()=>{try{
    const out={}
    for(const k of ${JSON.stringify(KEYS)}){
      const it=window.__traffic.registry[k]; const l=it&&it.layer
      const idx=l&&l.layerSource&&l.layerSource.clusterIndex
      if(!idx){out[k]={err:'no-index'};continue}
      const b=window.__map.getBounds()
      const t=Math.floor(window.__map.getZoom()-1)
      const cl=idx.getClusters([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],t)
      let buckets=0,scatter=0,max=0
      for(const f of cl){const n=(f.properties&&f.properties.point_count)||1
        if(n>1){buckets++;if(n>max)max=n}else scatter++}
      out[k]={t,buckets,scatter,max,total:cl.length}
    }
    return JSON.stringify({out, mapZoom:window.__map.getZoom()})
  }catch(e){return '<<'+e.message+'>>'}})()`)
  const b = typeof book === 'string' && book.startsWith('{') ? JSON.parse(book) : { out: {} }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = `logs/zoom-z${String(z).replace('.', '_')}.png`
  const buf = Buffer.from(shot.data, 'base64')
  writeFileSync(file, buf)
  const img = decodePNG(buf)
  /* 彩色墨迹：四类符号的自有色（📹深灰蓝 / 👮蓝 / 🚏蓝橙 / 🚦四状态色）—— 用整屏「高饱和」近似。
   * 桶已经不再画纯色圆盘（旧版的四个「聚合*」色类随之删掉），所以不再单列「深色块px」。 */
  const sat = classifyPixels(img, { x: 0, y: 0, width: img.width, height: img.height }, [
    { key: '绿', hex: '#12B76A', maxDist: 55 },
    { key: '红', hex: '#F04438', maxDist: 55 },
    { key: '橙', hex: '#F79009', maxDist: 55 }
  ])
  const ink = sat.绿 + sat.红 + sat.橙
  const tot = KEYS.map((k) => b.out[k] || {}).reduce((a, c) => a + (c.buckets || 0) + (c.scatter || 0), 0)
  const maxN = Math.max(...KEYS.map((k) => (b.out[k] && b.out[k].max) || 0))
  console.log(
    `${String(z).padStart(4)} | ${String(KEYS.reduce((a, k) => a + ((b.out[k] || {}).buckets || 0), 0)).padStart(4)} | ` +
    `${String(KEYS.reduce((a, k) => a + ((b.out[k] || {}).scatter || 0), 0)).padStart(6)} | ${String(maxN).padStart(8)} | ` +
    `${String(ink).padStart(10)} | ${String(tot).padStart(11)} | ${(tot ? ink / tot : 0).toFixed(1).padStart(9)}`
  )
  rows.push({ z, out: b.out, ink, tot })
  if (b.out.camera && b.out.camera.err) console.log('   ! camera:', b.out.camera.err)
}
console.log('\n分层明细（桶/散点，树 zoom=t）：')
for (const r of rows) {
  console.log(` ${String(r.z).padStart(4)}: ` + KEYS.map((k) => {
    const o = r.out[k] || {}
    return `${k} ${o.buckets ?? '?'}/${o.scatter ?? '?'}(t=${o.t ?? '?'})`
  }).join('  '))
}

try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
ws.close()
