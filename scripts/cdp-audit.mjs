/* 全功能巡检：把系统里每个可见入口都真点一遍，看它到底有没有反应。
 *
 * 与前几个探针的分工：probe6/7/8/9 是「某个 bug 修好了没有」的定向回归，
 * 本脚本是「有没有哪个功能压根没接线」的普查 —— 断言只关心三件事：
 *   1. 点下去有没有发生变化（路由 / store / 地图图层 / 面板 DOM）
 *   2. 有没有运行时错误
 *   3. 该出数据的地方有没有数据
 *
 * 所以每节都是独立的，一节挂掉不影响后面；最后统一打印失败清单。
 *
 * 前置：
 *   pnpm dev（:5180）
 *   pnpm server（:3001，连 SQL Server）—— 缺了它 7 类业务图层/数据管理/图表全是空的，
 *   那属于环境没起，不算功能坏；脚本会把它标成「依赖数据服务」而不是失败。
 *   Chrome headless --remote-debugging-port=9223
 *
 * 用法：node scripts/cdp-audit.mjs [--keep]
 *   默认跑完关掉自己开的标签页；--keep 留着方便手工看现场。
 */
const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const KEEP = process.argv.includes('--keep')

/* ---------- 浏览器连接（新开一个干净标签页，避免被之前探针注册的注入脚本污染） ---------- */
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

/* ---------- 断言 ---------- */
let pass = 0, fail = 0
const fails = []
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else {
    fail++; fails.push(label)
    console.log(`  ❌ ${label} ${detail !== undefined ? '→ ' + JSON.stringify(detail) : ''}`)
  }
}
const info = (label, v) => console.log(`  ·  ${label}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)

/* ---------- 交互原语 ---------- */
/* 必须走 mouseMoved → mousePressed → mouseReleased 三步：
 * 只发后两个时 Chrome 不合成 click，Vue 的 @click 不触发，测试会假失败。 */
const clickRect = async (r) => {
  const p = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p }); await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p }); await sleep(45)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
}
const rectOf = async (sel, nth = 0) => evj(`JSON.stringify((()=>{
  const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return { hidden: true }
  return { x: r.left + r.width/2, y: r.top + r.height/2 } })())`)
const clickAt = (x, y) => clickRect({ x, y })
/* 按住拖拽（矩形/圆形测量、拉框查询都是 trigger:'drag'）：
 * 中途必须连发多次 mouseMoved 且带 buttons:1，否则 Chrome 不认为发生了拖拽。 */
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
/* 地图手势开关：两个都由 l7-draw 在 enable() 时改（drag 模式锁 dragPan、click 模式锁 doubleClickZoom），
 * 而它的 destroy() 不还原 —— 视图侧手动补，见 MapDraw.vue / EventInfo.vue 的 restoreMapStatus。 */
const mapGestures = () => evj(`JSON.stringify({drag:window.__map.dragPan.isEnabled(), dbl:window.__map.doubleClickZoom.isEnabled()})`)
/* 按可见文本点：底部工具条/图层行的按钮没有稳定类名，靠文字定位最贴近用户操作 */
const rectOfText = async (sel, text) => evj(`JSON.stringify((()=>{
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(e => e.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(text.replace(/\s+/g, ''))}))
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return { hidden: true }
  return { x: r.left + r.width/2, y: r.top + r.height/2 } })())`)
const click = async (sel, nth = 0) => {
  const r = await rectOf(sel, nth)
  if (!r || r.hidden) return false
  await clickRect(r); return true
}
const clickText = async (sel, text) => {
  const r = await rectOfText(sel, text)
  if (!r || r.hidden) return false
  await clickRect(r); return true
}
const waitFor = async (expr, ms = 15000, step = 300) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) }
  return false
}
const errs = () => evj(`JSON.stringify((window.__errs||[]).slice(0,5))`)
const errCount = async () => (await errs() || []).length
/* 每节开始时清错误表：一节里报错要算在这节头上，不能串到别人身上 */
const errReset = () => ev(`window.__errs && (window.__errs.length = 0)`)
const nav = async (path, waitSel = '.btn-groups .item') => {
  await send('Page.navigate', { url: BASE + path })
  if (waitSel) await waitFor(`!!document.querySelector(${JSON.stringify(waitSel)})`)
  await sleep(600)
}

/* ---------- 启动 ---------- */
ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })

  /* ===================== A 登录 ===================== */
  console.log('\n===== A 登录 / 会话 =====')
  // 新标签页 sessionStorage 是空的，这里能测到真实的未登录路径
  await nav('/', '.login-overlay')
  check((await ev('location.pathname')) === '/login', '未登录访问 / 被守卫送到 /login', await ev('location.pathname'))

  // 错误口令
  await ev(`(()=>{const i=document.querySelectorAll('.login-form input');
    i[0].value='admin'; i[0].dispatchEvent(new Event('input',{bubbles:true}));
    i[1].value='wrong-password'; i[1].dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await click('.login-btn')
  await sleep(900)
  check(!!(await ev(`!!document.querySelector('.login-error')`)), '错误密码给出内联报错')
  info('报错文案', await ev(`document.querySelector('.login-error')?.textContent`))
  check((await ev('location.pathname')) === '/login', '错误密码不放行')

  // 正确口令
  await ev(`(()=>{const i=document.querySelectorAll('.login-form input');
    i[0].value='admin'; i[0].dispatchEvent(new Event('input',{bubbles:true}));
    i[1].value='123456'; i[1].dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await click('.login-btn')
  const loggedIn = await waitFor(`!document.querySelector('.login-overlay')`, 12000)
  check(loggedIn, '正确密码（admin/123456）登录成功')
  check((await ev('location.pathname')) === '/', '登录后进入首页')
  check(!!(await ev(`!!sessionStorage.getItem('zb_auth_user')`)), '登录态写入 sessionStorage')
  await errReset()

  /* ===================== B 地图与数据 ===================== */
  console.log('\n===== B 地图 / 数据服务 =====')
  await waitFor(`!!window.__map && window.__map.loaded()`, 40000)
  check(!!(await ev(`!!window.__map`)), '地图实例已暴露')
  check(!!(await ev(`window.__map && window.__map.loaded()`)), '地图完成首帧渲染（loaded()）')
  check(!!(await ev(`!!window.__scene`)), 'L7 scene 已就绪')
  // 注意：车辆 marker 是「开图层才建」的（懒加载），此处的正确断言在 C 段开完 8 类图层之后，
  // 一开始就要求 .vehicle-marker 存在会把正常行为判成失败。

  const health = await evj(`fetch('/api/health').then(r=>r.json()).catch(e=>({err:String(e)}))`)
  check(health?.ok === true, '后端 /api/health 通', health)
  const dataOk = await evj(`fetch('/api/mapdata').then(r=>r.json()).then(d=>({ok:d.ok, n:Object.keys(d.data||{}).length})).catch(e=>({err:String(e)}))`)
  check(dataOk?.n >= 10, '业务表可取（10 张）', dataOk)
  await errReset()

  /* ===================== C 实时数据栏 8 类图层 ===================== */
  console.log('\n===== C 实时数据栏图层开关 =====')
  const LAYERS = ['监控探头', '信号灯', '警员分布', '道路拥堵', '热力图', '公交线路', '公交站点', '动态车辆']
  const keys = ['camera', 'trafficLight', 'police', 'congestion', 'heat', 'busRoute', 'busStop', 'vehicle']
  for (let i = 0; i < LAYERS.length; i++) {
    const label = LAYERS[i], key = keys[i]
    await clickText('.rt-item', label)
    await sleep(1200)
    // 两侧都要亮：图层真的进了 scene（visible），且行 UI 也跟着点亮（on）
    const on = await ev(`window.__traffic ? window.__traffic.visible('${key}') : null`)
    const onUi = await ev(`!![...document.querySelectorAll('.rt-item')].find(e=>e.textContent.includes(${JSON.stringify(label)}) && e.classList.contains('on'))`)
    check(on === true && onUi === true, `${label} 能打开（图层可见 + UI 点亮）`, { on, onUi })
  }
  const allOn = await ev(`window.__scene ? window.__scene.getLayers().length : -1`)
  info('8 类全开时 scene 图层数', allOn)
  check(allOn >= 8, '8 类图层确实进了 scene', { allOn })
  // 车辆 marker 与「动态车辆」图层同生共死，开完图层才有 —— marker 数与车辆数必须一致
  const vN = await ev(`window.__vehicleSim ? window.__vehicleSim.vehicles.length : -1`)
  const mN = await ev(`document.querySelectorAll('.vehicle-marker').length`)
  check(vN > 0 && mN === vN, '动态车辆 marker 与车辆数一致', { vN, mN })
  check((await errCount()) === 0, '图层开关无运行时错误', await errs())

  // 收起 / 展开：.rt-panel 用的是 v-show，DOM 一直在，只能看「可见性」而非「是否存在」
  const visible = () => ev(`(()=>{const el=document.querySelector('.rt-panel'); if(!el) return false
    const cs=getComputedStyle(el); return cs.display!=='none' && cs.visibility!=='hidden'})()`)
  check(await visible(), '实时数据栏初始可见')
  await click('.rt-close')
  await sleep(400)
  check(!(await visible()), '实时数据栏可收起')
  check(!!(await ev(`!!document.querySelector('.rt-tab')`)), '收起后出现小标签')
  await click('.rt-tab')
  await sleep(400)
  check(await visible(), '小标签可再展开')
  await errReset()

  /* ===================== D 道路分级 ===================== */
  console.log('\n===== D 道路分级栏 =====')
  for (const label of ['高速公路', '一级道路', '二级道路', '三级道路']) {
    await clickText('.road-btn', label)
    await sleep(900)
    const on = await ev(`!![...document.querySelectorAll('.road-btn')].find(e=>e.textContent.trim()===${JSON.stringify(label)} && e.classList.contains('on'))`)
    check(on, `${label} 可选中`)
  }
  await clickText('.road-btn', '总道路')
  await sleep(900)
  const totalOn = await ev(`!![...document.querySelectorAll('.road-btn')].find(e=>e.textContent.trim()==='总道路' && e.classList.contains('on'))`)
  check(totalOn, '可切回总道路')
  check((await errCount()) === 0, '道路分级无运行时错误', await errs())
  await errReset()

  /* ===================== E 底部工具条 ===================== */
  console.log('\n===== E 底部工具条 =====')
  const items = await evj(`JSON.stringify([...document.querySelectorAll('.btn-groups .item')].map(e=>e.textContent.trim()))`)
  check((items || []).length === 11, '底部共 11 个入口', items)
  // 图标是否真的有字形（iconfont 类名写错时 ::before 是空的，肉眼看不见但 DOM 看不出来）
  const iconless = await evj(`JSON.stringify([...document.querySelectorAll('.btn-groups .item')].map(e=>{
    const i = e.querySelector('i.iconfont'); if(!i) return null
    const c = getComputedStyle(i, '::before').content
    return (c && c !== 'none' && c !== '""' && c !== "''") ? null : e.textContent.trim()
  }).filter(Boolean))`)
  check((iconless || []).length === 0, '每个入口的图标字形都存在', iconless)

  // 首页按钮：复位视角
  await ev(`window.__map.jumpTo({center:[100,10], zoom:3, pitch:40})`)
  await clickText('.btn-groups .item', '首页')
  await sleep(1200)
  const c = await evj(`JSON.stringify({lng:window.__map.getCenter().lng, lat:window.__map.getCenter().lat, z:window.__map.getZoom(), p:window.__map.getPitch()})`)
  check(Math.abs(c?.lng - 118.05) < 0.2 && Math.abs(c?.z - 9.5) < 0.5, '「首页」复位到淄博 118.05/9.5', c)

  // 地球自转
  await clickText('.btn-groups .item', '地球自转')
  await sleep(3000)
  const r1 = await evj(`JSON.stringify({p:location.pathname, z:window.__map.getZoom()})`)
  check(r1?.p === '/rotation', '「地球自转」进入 /rotation', r1)
  const l1 = await ev(`window.__map.getCenter().lng`); await sleep(2000)
  const l2 = await ev(`window.__map.getCenter().lng`)
  check(l1 !== l2, '自转确实在转', { l1, l2 })

  // 城市视角
  await clickText('.btn-groups .item', '城市视角')
  await sleep(3200)
  const cv = await evj(`JSON.stringify({p:location.pathname, z:window.__map.getZoom(), pitch:window.__map.getPitch()})`)
  check(cv?.p === '/cityview' && cv?.pitch === 70, '「城市视角」压到 pitch 70', cv)

  // 控制中心
  await clickText('.btn-groups .item', '控制中心')
  await sleep(2500)
  const nCards = await ev(`document.querySelectorAll('.g2-chart').length`)
  check(nCards === 6, '「控制中心」开出 6 张卡片', { nCards })
  // 6 张卡片里只有 4 张是 G2Plot 图（其余 2 张是纯统计卡，本来就没有 canvas）：
  // 每张卡片的 canvas 数实测 [1,1,1,0,0,1]，所以断言「有图的卡片都画出来了」而不是「总数>=5」
  const canvases = await evj(`JSON.stringify([...document.querySelectorAll('.g2-chart')].map(c=>c.querySelectorAll('canvas').length))`)
  const withCanvas = (canvases || []).filter(n => n > 0).length
  check(withCanvas === 4 && (canvases || []).every(n => n <= 1), '4 张图表卡片的 canvas 已渲染（另 2 张为纯统计卡）', canvases)
  // 纯统计卡必须有文字内容，否则「没 canvas 也没字」就是真的没渲染
  const statText = await ev(`[...document.querySelectorAll('.g2-chart')].filter(c=>!c.querySelector('canvas')).map(c=>c.innerText.trim().length).join(',')`)
  check(!/^0*$/.test(String(statText).replace(/,/g, '')), '纯统计卡有文字内容', { statText })
  await clickText('.btn-groups .item', '控制中心')
  await sleep(900)
  check((await ev(`document.querySelectorAll('.g2-chart').length`)) === 0, '再点一次关闭控制中心')

  // 数据管理：开关 + 数据
  await clickText('.btn-groups .item', '数据管理')
  await sleep(2200)
  const dmRows = await ev(`document.querySelectorAll('.dm-panel .el-table__body tr.el-table__row').length`)
  check(!!(await ev(`!!document.querySelector('.dm-panel')`)), '「数据管理」面板可打开')
  check(dmRows > 0, '数据管理表格有数据行（需 pnpm server + SQL Server）', { dmRows })
  info('当前表行数', dmRows)
  await clickText('.btn-groups .item', '数据管理')
  await sleep(700)
  check(!(await ev(`!!document.querySelector('.dm-panel')`)), '再点一次关闭数据管理')

  // 地图测量下拉
  await clickText('.btn-groups .item', '地图测量')
  await sleep(900)
  const popTools = await evj(`JSON.stringify([...document.querySelectorAll('.tool-popover .popover-tool')].map(e=>e.textContent.trim()))`)
  check((popTools || []).length === 4, '「地图测量」下拉有 4 个工具', popTools)
  const popIconless = await evj(`JSON.stringify([...document.querySelectorAll('.tool-popover .popover-tool i')].map(i=>{
    const c = getComputedStyle(i, '::before').content
    return (c && c !== 'none' && c !== '""' && c !== "''") ? null : i.className
  }).filter(Boolean))`)
  check((popIconless || []).length === 0, '测量工具的图标字形都存在', popIconless)

  check((await errCount()) === 0, '底部工具条无运行时错误', await errs())
  await errReset()

  /* ===================== F 各功能子页 ===================== */
  console.log('\n===== F 功能子页 =====')

  /* 地图测量（4 种绘制工具）
   *
   * 不能用「DOM 里有没有 .l7-draw-control」来判：MapDraw.vue 用的是 @antv/l7-draw 的
   * 抽屉类（new DrawRect(scene, …)），它只往 L7 scene 里加图层，**不生成任何工具条 DOM**
   * （生成工具条的是另一个 DrawControl 组件，本项目没用）。之前就是这么误判成「绘制失灵」的。
   *
   * 真正可判的三件事：
   *   1. draw.enable() 生效的指纹 —— 它会 scene.setMapStatus({doubleClickZoom:false})；
   *   2. 绘制手势。矩形/圆形只由两个对角点决定，已改成 trigger:'drag'（按下—拖—松开一把画完，
   *      拖拽期间 l7-draw 会把 dragPan 关掉，所以画框不会把地图一起拖走）；
   *      多边形/线要任意个节点，保持 trigger:'click'（逐点点选）。
   *   3. 画完之后绘制图层里真的出现了带坐标的要素。
   * 图层：scene 里除 '0'/'1'（道路流线、城市建筑）外的 6 个就是 l7-draw 的
   * polygon/line/dashLine/point/midPoint/text。
   */
  const drawLayers = () => evj(`JSON.stringify(window.__scene.getLayers().filter(l=>!['0','1'].includes(String(l.name)))
    .map(l=>{try{const d=l.getSource().data.dataArray||[]; const f=d[0]
      return {t:l.type, n:d.length, hasCoord:!!(f&&(f.coordinates||(f.geometry&&f.geometry.coordinates)))} }catch(e){return {t:l.type, err:String(e).slice(0,30)}}}))`)
  const hasShape = (ls) => (ls || []).some(l => l.n > 0 && l.hasCoord)
  for (const [type, label, gesture, pts] of [
    ['drawPolygonTool', '多边形', 'click', [[600, 350], [850, 420], [700, 520]]],
    ['drawRectTool', '矩形', 'drag', [[650, 380], [950, 550]]],
    ['drawCircleTool', '圆形', 'drag', [[700, 400], [900, 550]]],
    ['line', '线', 'click', [[620, 360], [800, 450], [980, 520]]],
  ]) {
    await nav('/mapdraw/' + type, '.btn-groups .item')
    await sleep(2500)
    const armed = await ev(`window.__map.doubleClickZoom.isEnabled() === false`)
    check(armed, `测量·${label} 绘制态已激活（enable 生效）`)
    // 拖拽模式下地图拖拽必须被锁：否则画框的同时地图会跟着跑（改前唯一担心的点）
    if (gesture === 'drag') {
      const gm = await mapGestures()
      const before = await evj(`JSON.stringify(window.__map.getCenter().toArray())`)
      check(gm.drag === false, `测量·${label} 拖拽绘制期间地图拖拽被锁`, gm)
      await dragFrom(...pts[0], ...pts[1])
      const after = await evj(`JSON.stringify(window.__map.getCenter().toArray())`)
      check(JSON.stringify(before) === JSON.stringify(after), `测量·${label} 拖拽画框没有把地图拖走`, { before, after })
    } else {
      for (const [x, y] of pts) { await clickAt(x, y); await sleep(450) }
    }
    await sleep(1200)
    const ls = await drawLayers()
    check(hasShape(ls), `测量·${label} 画完真的生成了图形要素`, { armed, ls })
    check((await errCount()) === 0, `测量·${label} 无运行时错误`, await errs())
    await errReset()
  }

  /* 离开测量页后地图手势必须还原。l7-draw 的 destroy() 只销毁图层和监听，**不还原**它
   * enable() 时改过的地图状态：drag 模式锁的是 dragPan（漏还原 → 整张地图拖不动），
   * click 模式锁的是 doubleClickZoom（漏还原 → 双击不缩放）。两种都无报错、无视觉提示，
   * 只能这样显式断言；上面的矩形/圆形用的是 drag 模式，正好覆盖前者。 */
  await nav('/')
  await waitFor(`!!window.__map`, 20000)
  await sleep(1500)
  const gsAfter = await mapGestures()
  check(gsAfter.drag === true && gsAfter.dbl === true, '离开测量页后地图拖拽/双击缩放都还原', gsAfter)

  /* 拉框查询：拉框 → DrawEvent.Add → turf 点面判断 → 填表。
   * 断言「搜索流程跑起来了」：要么表里有数据行，要么弹出「没有查询到信息」
   * （后者说明 Add 事件确实触发了，只是框内没有事件点）。 */
  await nav('/eventinfo', '.btn-groups .item')
  await sleep(2500)
  const eiBtn = await evj(`JSON.stringify((()=>{
    const b=[...document.querySelectorAll('.el-button')].find(e=>e.textContent.includes('拉框查询'))
    if(!b) return null; const r=b.getBoundingClientRect()
    return {x:r.left+r.width/2,y:r.top+r.height/2} })())`)
  check(!!eiBtn, '拉框查询页有「拉框查询」按钮')
  if (eiBtn) { await clickRect(eiBtn); await sleep(1800) }
  check(await ev(`window.__map.doubleClickZoom.isEnabled() === false`), '点「拉框查询」进入绘制态')
  check((await mapGestures()).drag === false, '拉框查询拖拽期间地图拖拽被锁')
  // 框要开得够大：事件点只有 40 来个、散在整市，小框很可能一个都框不到，
  // 那条分支只会弹「没有查询到信息」，而 ElMessage 3s 就消失 —— 读晚了就成了假失败。
  // 所以这里既框大一点，又轮询着读到即走（读到行数或读到提示都算跑通）。
  await dragFrom(300, 420, 1350, 800)
  let eiRows = 0, eiMsg = ''
  for (let t = 0; t < 8000; t += 250) {
    eiRows = await ev(`document.querySelectorAll('.el-table__body tr.el-table__row').length`)
    if (eiRows > 0) break
    const m = await ev(`[...document.querySelectorAll('.el-message')].map(e=>e.innerText.trim()).join(' | ')`)
    if (m) { eiMsg = m; break }
    await sleep(250)
  }
  check(eiRows > 0 || /没有查询到信息|暂无事件记录/.test(String(eiMsg)), '拉框后搜索流程跑通（出结果或明确提示无结果）', { eiRows, eiMsg })
  info('拉框查询命中行数', eiRows)
  info('拉框提示', eiMsg || '(无)')
  // 拉完框就地 destroy()（Add 回调里），同样得自己还原地图状态
  const eiG = await mapGestures()
  check(eiG.drag === true && eiG.dbl === true, '拉完框后地图拖拽/双击缩放自动还原', eiG)
  check((await errCount()) === 0, '拉框查询无运行时错误', await errs())
  await errReset()

  // 区域搜索：输入城市回车 → 拉边界 + 天气
  await nav('/areasearch', '.btn-groups .item')
  await sleep(1500)
  await ev(`(()=>{const i=document.querySelector('.headerAS_div_input');
    i.value='济南'; i.dispatchEvent(new Event('input',{bubbles:true}));
    i.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}))})()`)
  const gotWeather = await waitFor(`document.querySelector('.c2.weatherData')?.textContent.trim() && document.querySelector('.c2.weatherData').textContent.trim() !== ''`, 15000)
  const weather = await evj(`JSON.stringify([...document.querySelectorAll('.weatherRow')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()))`)
  check(gotWeather, '区域搜索能取到天气数据（需高德 key + 外网）', weather)
  info('天气卡片', weather)
  check((await errCount()) === 0, '区域搜索无运行时错误', await errs())
  await errReset()

  // 导航：控件挂载 + 带 query 真的能规划（起终点走高德解析成精确坐标再喂控件）
  await nav('/navigation', '.btn-groups .item')
  await sleep(1500)
  const ctrl = await waitFor(`!!document.querySelector('.mapboxgl-ctrl-directions')`, 20000)
  check(ctrl, '导航控件已挂载')
  // 只挂控件不算「能用」：用 ?from=&to= 走一遍真实规划流程（与 AI/外部跳转同一条路径）
  await nav('/navigation?from=' + encodeURIComponent('淄博站') + '&to=' + encodeURIComponent('济南'), '.btn-groups .item')
  const planned = await waitFor(`(()=>{const s=window.__map.getSource('directions'); const d=s&&s._data
    return !!(d && d.routes && d.routes.length)})()`, 20000)
  const inputs = await evj(`JSON.stringify([...document.querySelectorAll('.mapboxgl-ctrl-directions .mapboxgl-ctrl-geocoder input')].map(i=>i.value))`)
  const routeInfo = await evj(`JSON.stringify((()=>{
    const s = window.__map && window.__map.getSource('directions')
    const d = s && s._data
    return { hasSource: !!s, routes: d && d.routes ? d.routes.length : 0 } })())`)
  /* 断言分两层：控件里两个输入框被回填成中文地名 ⇒ 高德解析 + setOrigin/setDestination 这条
   * 应用侧链路通了（不依赖外网的路段）；真出现 route ⇒ 外网 mapbox directions 也通。
   * 只把前者当硬断言，后者仅记录：地图样式/字体全走外部 CDN，离线环境跑巡检不该因此判失败。 */
  check(/淄博站/.test(JSON.stringify(inputs)) && /济南/.test(JSON.stringify(inputs)), '导航起终点已解析并回填控件', { inputs, routeInfo })
  info('directions 数据源', routeInfo)
  if (!planned) info('未取到路线（需外网 mapbox directions API）', routeInfo)
  check((await errCount()) === 0, '导航页无运行时错误', await errs())
  await errReset()

  // 切换风格
  await nav('/changestyle', '.btn-groups .item')
  await sleep(1500)
  const menu = await evj(`JSON.stringify([...document.querySelectorAll('#menu a')].map(a=>a.textContent.trim()))`)
  check((menu || []).length >= 2, '切换风格菜单有选项', menu)
  // 不能拿 getStyle().name 比对：streets-v11 与 streets-v12 的 name 都是「Mapbox Streets」，
  // 点第 1 项（streets-v11）时名字不变，会把「真的换了风格」误判成失败。改点第 3 项（深色风格）
  // 并比对 sprite URL —— 每种风格一条，是最省事的唯一指纹。
  const styleSnap = () => evj(`JSON.stringify((()=>{const s=window.__map.getStyle(); return {name:s.name, sprite:s.sprite}})())`)
  const styleBefore = await styleSnap()
  check((menu || []).length >= 3, '风格菜单至少 3 档（含深色）', menu)
  const styleClicked = await clickText('#menu a', '深色')
  await sleep(4500)
  const styleAfter = await styleSnap()
  check(styleClicked && styleBefore?.sprite !== styleAfter?.sprite, '点菜单项真的换了底图风格（sprite 变了）', { styleBefore, styleAfter })
  check((await errCount()) === 0, '切换风格无运行时错误', await errs())
  await errReset()

  // 切换风格按钮的「再点一次退出」语义
  await clickText('.btn-groups .item', '切换风格')
  await sleep(1200)
  check((await ev('location.pathname')) === '/', '在风格页再点「切换风格」退回首页', await ev('location.pathname'))
  await errReset()

  /* ===================== G AI 助手 ===================== */
  console.log('\n===== G AI 助手 =====')
  const fab = await rectOf('.ai-fab')
  check(!!fab && !fab.hidden, '右下角有 AI 悬浮按钮')
  if (fab && !fab.hidden) { await clickRect(fab); await sleep(800) }
  check(!!(await ev(`!!document.querySelector('.ai-panel')`)), 'AI 面板可打开')
  // 离线规则引擎：不依赖外网，先验证指令确实落到图层开关上
  const before = await ev(`window.__traffic ? window.__traffic.visible('camera') : null`)
  await ev(`window.__ai && window.__ai.sendRule('打开监控探头图层')`)
  await sleep(1500)
  const after = await ev(`window.__traffic ? window.__traffic.visible('camera') : null`)
  check(after === true, 'AI 指令能真的打开图层（离线规则引擎）', { before, after })
  const msgs = await evj(`JSON.stringify(window.__ai ? window.__ai.msgs() : [])`)
  check((msgs || []).length >= 2, 'AI 有来有回（至少一问一答）', { n: (msgs || []).length, last: (msgs || []).slice(-2) })
  info('对话', msgs)
  check((await errCount()) === 0, 'AI 助手无运行时错误', await errs())
  await errReset()

  /* ===================== H 退出登录 ===================== */
  console.log('\n===== H 退出登录 =====')
  const out = await rectOf('.logout-btn')
  check(!!out && !out.hidden, '顶部栏有退出按钮')
  /* 先看这个坐标上「谁在最上层」：L7 控件曾经用写死的 z-index:1000 盖住整个 Header，
   * 那时点退出只会触发全屏，报错信息里却不含任何线索。留着这一行，回归时能直接看出被谁挡了。 */
  if (out && !out.hidden) {
    const hitTop = await ev(`(()=>{const el=document.elementFromPoint(${Math.round(out.x)},${Math.round(out.y)})
      return el?el.tagName+'.'+String(el.className).slice(0,40):'null'})()`)
    check(/logout-btn/.test(String(hitTop)), '退出按钮没被地图控件压住', hitTop)
    await clickRect(out); await sleep(1500)
  }
  check((await ev('location.pathname')) === '/login', '退出后回到登录页', await ev('location.pathname'))
  check(!(await ev(`!!sessionStorage.getItem('zb_auth_user')`)), '退出后清掉登录态')

  /* ===================== 汇总 ===================== */
  console.log(`\n===== 巡检结果：${pass} 通过 / ${fail} 失败 =====`)
  if (fails.length) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)) }
  /* 必须等 ws 的 close 事件真正到达再退出。
   * 原先直接 ws.close() 后跟 process.exit() 会撞 Node 在 Windows 上的 libuv 断言
   * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），进程以 **127** 退出 ——
   * 巡检结果明明是 0 失败，退出码却是「命令不存在」，接不进任何自动化。
   * 用 exitCode + 自然退出替代 process.exit，让句柄按顺序收干净。 */
  await Promise.race([new Promise((r) => { ws.onclose = r; ws.close() }), sleep(2000)])
  if (!KEEP) { try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 关不掉不影响结论 */ } }
  process.exitCode = fail ? 1 : 0
}
