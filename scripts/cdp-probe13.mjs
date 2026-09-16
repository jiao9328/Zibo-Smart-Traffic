/* 现场清点：实时数据 7 类图层的数据量 / L7 实例配置 / 截图（改图标样式前先看清现状）。
 *
 * 顺带做一次「左上角碰撞扫描」：遍历各路由，列出与实时数据栏矩形相交的可交互元素，
 * 用来验证「面板遮挡页面控件」这个问题到底波及几个页面（任务2）。
 *
 * 前置：pnpm dev(:5180)、Chrome headless --remote-debugging-port=9223
 * 用法：node scripts/cdp-probe13.mjs [路由...]     默认跑一组常用路由
 */
import { writeFileSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
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
  if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>'
      : r?.result?.value)
const waitFor = async (expr, ms = 20000, step = 300) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) }
  return false
}
const info = (label, v) => console.log(`  ·  ${label}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)

/* 碰撞扫描：列出与实时数据栏相交、且「可交互」的元素（能点/能输入的） */
const SCAN = `(()=>{
  window.__scan = window.__scan || ((sel)=>{
    const panel = document.querySelector(sel); if(!panel) return null
    const p = panel.getBoundingClientRect()
    if(!p.width||!p.height) return {hidden:true}
    const hit = []
    for (const el of document.querySelectorAll('input,button,a,select,textarea,[role=button],.mapboxgl-ctrl,.headerAS,.mapboxgl-ctrl-directions *')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (el.closest('.rt-panel,.rt-tab')) continue
      const ov = Math.min(p.right,r.right) - Math.max(p.left,r.left)
      const oh = Math.min(p.bottom,r.bottom) - Math.max(p.top,r.top)
      if (ov > 1 && oh > 1) hit.push({
        tag: el.tagName, cls: String(el.className||'').slice(0,42),
        ctx: (el.closest('.headerAS,.mapboxgl-ctrl-directions,.weatherCondition')||{}).className||'',
        area: Math.round(ov*oh), txt: (el.textContent||el.placeholder||'').trim().slice(0,20)
      })
    }
    return {panel:{l:Math.round(p.left),t:Math.round(p.top),r:Math.round(p.right),b:Math.round(p.bottom)}, hit}
  })
  return JSON.stringify(__scan('.rt-panel')||__scan('.rt-tab'))
})()`

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'admin',display_name:'清点'}))}catch(e){}`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(`!!(window.__map && window.__scene && window.__traffic)`, 40000)
  await sleep(2000)

  /* ---------- 数据面 ---------- */
  console.log('\n===== 数据源 =====')
  const db = await ev(`JSON.stringify({status:window.__vehStoreDbStatus||(window.__traffic&&'n/a')})`)
  const counts = await ev(`JSON.stringify((()=>{const d=window.__storeDbData||null; return null})())`)
  const stats = await ev(`JSON.stringify({
    dbStatus: (window.__map && window.__scene) ? (window.__scene.get('')||null) : null })`)
  /* store 没挂到 window，走 __vehicleSim.debug() 拿 dbStatus（它读的就是 store.dbStatus） */
  info('db 状态', await ev(`window.__vehicleSim ? JSON.stringify(window.__vehicleSim.debug()) : null`))
  const rows = await ev(`JSON.stringify((()=>{const t=window.__traffic; if(!t) return null
    return t.registry ? Object.keys(t.registry) : []})())`)
  info('已注册图层', rows)

  /* 逐个打开 7 类图层（+ 动态车辆），统计实际渲染要素数 */
  console.log('\n===== 逐层开启 =====')
  for (const n of ['camera', 'trafficLight', 'police', 'congestion', 'heat', 'busRoute', 'busStop', 'vehicle']) {
    const ok = await ev(`window.__traffic.setVisible(${JSON.stringify(n)}, true)`)
    await sleep(500)
    const cnt = await ev(`(()=>{const it=window.__traffic.registry[${JSON.stringify(n)}]
      if(!it||!it.layer) return ${JSON.stringify(n)}==='vehicle'?'marker':'no-layer'
      /* 数据挂在 layerSource.originData 上（.data 是老字段，读它是 undefined ⇒ 每层都报 err） */
      try{ const ls=it.layer.layerSource
        const d=ls&&(ls.originData||ls.data); return d? d.features.length : 'n/a' }catch(e){ return 'err:'+e.message }})()`)
    info(n, { 开启: ok, 要素数: cnt })
  }

  /* 城市中心放大，让点位看得清 */
  await ev(`window.__map.jumpTo({center:[118.05,36.81], zoom:13, pitch:0})`)
  await sleep(1800)
  let s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('logs/layers-all-z13.png', Buffer.from(s.data, 'base64'))
  console.log('SHOT: logs/layers-all-z13.png')

  /* ---------- 碰撞扫描（各路由） ---------- */
  console.log('\n===== 左上角碰撞扫描（实时数据栏 vs 页面可交互元素） =====')
  const routes = process.argv.slice(2).length ? process.argv.slice(2)
    : ['/', '/areasearch', '/navigation', '/mapdraw/polygon', '/eventinfo', '/changestyle', '/cityview', '/rotation']
  for (const r of routes) {
    await send('Page.navigate', { url: BASE + r })
    const ready = await waitFor(`!!(window.__map && window.__scene && window.__traffic)`, 40000)
    await sleep(2500)
    const res = await ev(SCAN)
    console.log(`  ${r} ${ready ? '' : '(地图未就绪)'} → ${res}`)
  }

  ws.close()
  await sleep(150)
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
  /* 不显式 process.exit：Node 24 + undici WebSocket 在 Windows 上硬退会踩 libuv 断言
   * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），事件循环自己排空就干净了。 */
}
