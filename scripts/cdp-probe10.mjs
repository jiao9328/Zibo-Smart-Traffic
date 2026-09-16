/* 定向回归：矩形/圆形/拉框改成 trigger:'drag'（按下—拖—松开一把画完）之后
 *   1. 拖拽画框真的出图形；
 *   2. 拖拽过程中地图**不能**跟着跑（这是改之前唯一担心的点）；
 *   3. 退出绘制页后地图手势必须还原 —— l7-draw 的 destroy() 只销毁图层和监听，
 *      **不还原**它 enable() 时改过的地图状态（drag 模式关的是 dragPan，
 *      click 模式关的是 doubleClickZoom），不手动还原的话离开页面后地图就废了；
 *   4. 仍是 click 模式的多边形/线没被弄坏，且它们不锁地图拖拽（对照组）。
 *
 * 前置：pnpm dev(:5180)、Chrome headless --remote-debugging-port=9223
 * 用法：node scripts/cdp-probe10.mjs
 */
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
const evj = (x) => ev(x).then((s) => {
  if (typeof s !== 'string') return s
  if (s[0] !== '{' && s[0] !== '[') return s
  try { return JSON.parse(s) } catch { return s }
})

let pass = 0, fail = 0
const fails = []
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; fails.push(label); console.log(`  ❌ ${label} ${detail !== undefined ? '→ ' + JSON.stringify(detail) : ''}`) }
}
const info = (label, v) => console.log(`  ·  ${label}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)

const waitFor = async (expr, ms = 15000, step = 300) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) }
  return false
}
const errs = () => evj(`JSON.stringify((window.__errs||[]).slice(0,5))`)
const errCount = async () => (await errs() || []).length
const errReset = () => ev(`window.__errs && (window.__errs.length = 0)`)
const nav = async (path, waitSel = '.btn-groups .item') => {
  await send('Page.navigate', { url: BASE + path })
  if (waitSel) await waitFor(`!!document.querySelector(${JSON.stringify(waitSel)})`)
  await sleep(600)
}
const mapReady = (ms = 25000) => waitFor(`!!(window.__map && window.__scene)`, ms)

/* 单击（用于仍是 click 模式的多边形/线） */
const clickAt = async (x, y) => {
  const p = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 }); await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, buttons: 1 }); await sleep(45)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, buttons: 0 }); await sleep(50)
}

/* 按住拖拽：中途必须发多次 mouseMoved 且带 buttons:1，否则 Chrome 不会把它当成拖拽 */
const dragFrom = async (x1, y1, x2, y2) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'left', buttons: 0 }); await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 }); await sleep(100)
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: Math.round(x1 + (x2 - x1) * i / 6), y: Math.round(y1 + (y2 - y1) * i / 6),
    })
    await sleep(45)
  }
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(500)
}

const drawLayers = () => evj(`JSON.stringify(window.__scene.getLayers().filter(l=>!['0','1'].includes(String(l.name)))
  .map(l=>{try{const d=l.getSource().data.dataArray||[]; const f=d[0]
    return {t:l.type, n:d.length, hasCoord:!!(f&&(f.coordinates||(f.geometry&&f.geometry.coordinates)))} }catch(e){return {t:l.type, err:String(e).slice(0,30)}}}))`)
const hasShape = (ls) => (ls || []).some(l => l.n > 0 && l.hasCoord)
/* 地图手势状态：drag='能拖动地图'、dbl='能双击缩放'。两者都由 l7-draw 在 enable() 时改 */
const gestures = () => evj(`JSON.stringify({
  drag: window.__map.dragPan.isEnabled(),
  dbl: window.__map.doubleClickZoom.isEnabled(),
  center: window.__map.getCenter().toArray().map(v=>+v.toFixed(5)),
  zoom: +window.__map.getZoom().toFixed(3) })`)

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })

  /* 登录态：先落到登录页（占住 origin 的 sessionStorage），写进去再跳目标页 */
  await nav('/', '.login-overlay')
  await ev(`sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'admin',display_name:'巡检'}))`)

  /* ===================== A 矩形：拖拽绘制 ===================== */
  console.log('\n===== A 矩形（trigger: drag）=====')
  await nav('/mapdraw/drawRectTool')
  await mapReady()
  await sleep(1800)
  const g0 = await gestures()
  info('绘制前地图手势', g0)
  check(g0.dbl === false, '矩形绘制态已激活（doubleClickZoom 被 l7-draw 关掉 = enable 生效的指纹）', g0)
  check(g0.drag === false, 'drag 模式下 l7-draw 关掉了地图拖拽（避免画框时地图跟着跑）', g0)

  await dragFrom(650, 380, 950, 550)
  await sleep(1200)
  let ls = await drawLayers()
  const g1 = await gestures()
  check(hasShape(ls), '拖拽画矩形：真的生成了图形要素', ls)
  check(g1.center[0] === g0.center[0] && g1.center[1] === g0.center[1],
    '拖拽画矩形：地图没有被一起拖走（center 未变）', { before: g0.center, after: g1.center })
  check(g1.zoom === g0.zoom, '拖拽画矩形：缩放也没变', { before: g0.zoom, after: g1.zoom })
  check((await errCount()) === 0, '拖拽画矩形：无运行时错误', await errs())
  await errReset()

  /* ===================== B 圆形：拖拽绘制 ===================== */
  console.log('\n===== B 圆形（trigger: drag）=====')
  await nav('/mapdraw/drawCircleTool')
  await mapReady()
  await sleep(1800)
  const gc0 = await gestures()
  check(gc0.drag === false, '圆形：drag 模式下地图拖拽被锁（enable 生效）', gc0)
  await dragFrom(700, 400, 900, 550)
  await sleep(1200)
  ls = await drawLayers()
  const gc1 = await gestures()
  check(hasShape(ls), '拖拽画圆形：真的生成了图形要素', ls)
  check(gc1.center[0] === gc0.center[0] && gc1.center[1] === gc0.center[1],
    '拖拽画圆形：地图没有被一起拖走（center 未变）', { before: gc0.center, after: gc1.center })
  check((await errCount()) === 0, '拖拽画圆形：无运行时错误', await errs())
  await errReset()

  /* ===================== C 对照组：多边形仍是 click，且不锁地图拖拽 ===================== */
  console.log('\n===== C 多边形（保持 trigger: click）=====')
  await nav('/mapdraw/drawPolygonTool')
  await mapReady()
  await sleep(1800)
  const gp0 = await gestures()
  check(gp0.drag === true, '多边形仍是 click 模式：地图拖拽没被锁（与 A/B 形成对照）', gp0)
  check(gp0.dbl === false, '多边形：绘制态仍已激活', gp0)
  for (const [x, y] of [[600, 350], [850, 420], [700, 520]]) { await clickAt(x, y); await sleep(450) }
  await sleep(1200)
  ls = await drawLayers()
  check(hasShape(ls), '多边形：单击逐点绘制仍正常（没被本次改动弄坏）', ls)
  check((await errCount()) === 0, '多边形：无运行时错误', await errs())
  await errReset()

  /* ===================== D 退出绘制页 → 地图手势还原 ===================== */
  console.log('\n===== D 退出绘制页后的地图手势还原 =====')
  await nav('/')
  await mapReady()
  await sleep(1500)
  const gd = await gestures()
  check(gd.drag === true, '离开测量页后地图可拖拽（destroy 不还原 dragPan，靠视图侧手动 setMapStatus 补回来）', gd)
  check(gd.dbl === true, '离开测量页后双击缩放也还原了（这个在改之前就是坏的）', gd)

  /* ===================== E 拉框查询：拖拽拉框 + 还原 ===================== */
  console.log('\n===== E 拉框查询（trigger: drag）=====')
  await nav('/eventinfo')
  await mapReady()
  await sleep(1800)
  const ge0 = await gestures()
  check(ge0.drag === true, '拉框查询未点按钮前，地图拖拽是通的', ge0)
  const btn = await evj(`JSON.stringify((()=>{
    const b=[...document.querySelectorAll('.el-button')].find(e=>e.textContent.includes('拉框查询'))
    if(!b) return null; const r=b.getBoundingClientRect()
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}})())`)
  if (!btn) { check(false, '找到「拉框查询」按钮', btn) }
  else {
    await clickAt(btn.x, btn.y)
    await sleep(900)
    const ge1 = await gestures()
    check(ge1.drag === false, '点「拉框查询」后进入拖拽绘制态（dragPan 被锁）', ge1)
    await dragFrom(300, 420, 1350, 800)
    // 事件点只有 40 来个、散在整市：框要开大才有命中；万一没命中只剩「没有查询到信息」，
    // 而 ElMessage 3s 就消失，所以轮询着读到即走，避免把过期当成假失败。
    let eiRows = 0, eiMsg = ''
    for (let t = 0; t < 8000; t += 250) {
      eiRows = await ev(`document.querySelectorAll('.displayCard .el-table__body tr').length`)
      if (eiRows > 0) break
      const m = await ev(`[...document.querySelectorAll('.el-message')].map(e=>e.innerText.trim()).join(' | ')`)
      if (m) { eiMsg = m; break }
      await sleep(250)
    }
    check(eiRows > 0 || /没有查询到信息|暂无事件记录/.test(String(eiMsg)),
      '拖拽拉框后查询流程跑通（出结果或明确提示无结果）', { eiRows, eiMsg })
    const ge2 = await gestures()
    check(ge2.drag === true && ge2.dbl === true, '拉完框后地图手势自动还原（否则此后整张地图拖不动）', ge2)
    check((await errCount()) === 0, '拉框查询：无运行时错误', await errs())
    await errReset()
  }

  /* ===================== 汇总 ===================== */
  console.log(`\n===== 合计 ${pass} 通过 / ${fail} 失败 =====`)
  if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '))

  await Promise.race([new Promise((r) => { ws.onclose = r; ws.close() }), sleep(2000)])
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch {}
  process.exitCode = fail ? 1 : 0
}
