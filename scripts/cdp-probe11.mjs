/* 定向回归：任务3「动态车辆 —— 点左下车辆信息，要能认出图中是哪辆车」。
 *
 * 这条需求此前只有实现、没有验证：
 *   - cdp-vehicle.mjs（S0~S8）验的是「模拟跑没跑起来、marker 动没动、点 marker 出不出气泡」；
 *   - cdp-audit.mjs 的 C 段只断言「marker 数 == 车辆数」。
 * 而「列表 ↔ 地图」的对应关系（编号徽标、专属色、双向高亮、飞行定位）一条都没断到，
 * vehicleSim 里为此专门留了 badgeNos/markerClass/selected/hovered 钩子也一直没人用。
 *
 * 本脚本就断这层对应关系，按用户能感知的顺序：
 *   A 同源   —— 面板 15 行徽标编号/颜色 与 地图 15 个 marker 一一对应（「认得哪辆」的锚点）
 *   B 列表→地图 —— 点某行：该车高亮 + 飞行定位 + 弹出气泡（气泡里编号还是那只）
 *   C 悬停    —— hover 某行只临时亮那一辆，不干扰已选中的那辆
 *   D 地图→列表 —— 点地图上某辆车：列表对应行高亮并滚进视野（反向联动）
 *   E 开关    —— 关图层后重开，选中态仍在（设计如此，见 buildMarker 注释）
 *
 * 前置：pnpm dev(:5180)、Chrome headless --remote-debugging-port=9223
 * 用法：node scripts/cdp-probe11.mjs
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
const mapReady = (ms = 25000) => waitFor(`!!(window.__map && window.__scene)`, ms)

/* 真实鼠标事件（elementFromPoint 命中了也未必点得到 —— 还是发真事件最可信） */
const moveTo = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(120)
}
const clickAt = async (x, y) => {
  const p = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 }); await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, buttons: 1 }); await sleep(45)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, buttons: 0 }); await sleep(50)
}

/* ---------- 读现场 ---------- */
/* --vm-color 在三处分别是内联 hex、计算后的 rgb 等不同写法，比颜色前先各自归一化，
 * 否则同一个色值会因写法不同被判成不等（hex vs rgb）。
 * 挂到 window 上而不是 `const`：Runtime.evaluate 各次都在同一个全局作用域里跑，
 * 用 const 第二次求值会直接 SyntaxError（已声明过）。 */
const RGB = `window.__rgb=window.__rgb||(v=>{const d=document.createElement('div');d.style.color=v;
  document.body.appendChild(d);const c=getComputedStyle(d).color;d.remove();return c});`

const bridge = () => evj(`JSON.stringify((()=>{const b=window.__vehicleSim
  return b?{badges:b.badgeNos(), selected:b.selected(), hovered:b.hovered()}:null})())`)

/** 面板每行：id / 编号 / 颜色（--vm-color 是同一个内联变量，列表与 marker 同源） */
const rows = () => evj(`${RGB}JSON.stringify([...document.querySelectorAll('.vp-row')].map(r=>{
  const cs=getComputedStyle(r); const b=r.querySelector('.vp-badge')
  return { id:+r.id.replace('vp-row-',''), no:+b.textContent.trim(),
    color:__rgb(cs.getPropertyValue('--vm-color').trim()),
    focus:r.classList.contains('focus'), hover:r.classList.contains('hover'),
    cx:Math.round(r.getBoundingClientRect().left+r.getBoundingClientRect().width/2),
    cy:Math.round(r.getBoundingClientRect().top+r.getBoundingClientRect().height/2) }}))`)

/** 地图每辆车：编号 / 颜色 / 类名 / 屏幕坐标（类名由 syncMarkerState 统一刷） */
const markers = () => evj(`${RGB}JSON.stringify([...document.querySelectorAll('.vehicle-marker')].map(m=>{
  const r=m.getBoundingClientRect()
  return { id:+m.dataset.carId, no:+m.querySelector('.vm-badge').textContent.trim(),
    color:__rgb(getComputedStyle(m).getPropertyValue('--vm-color').trim()),
    cls:m.className, shown:m.style.display!=='none',
    cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2) }}))`)
const clsOf = (ms, id) => (ms.find((m) => m.id === id) || {}).cls || ''
const focusIds = (ms) => ms.filter((m) => /vm-focus/.test(m.cls)).map((m) => m.id)
const hoverIds = (ms) => ms.filter((m) => /vm-hover/.test(m.cls)).map((m) => m.id)

const carOf = (id) => evj(`JSON.stringify((()=>{const c=window.__vehicleSim.vehicles.find(v=>v.id===${id})
  return c?{id:c.id,lng:c.lng,lat:c.lat,plate:c.plate}:null})())`)

/** 气泡：是否在地图上、里面标的编号是多少 */
const popup = () => evj(`${RGB}JSON.stringify((()=>{const p=document.querySelector('.vm-popup')
  if(!p) return {open:false}
  const no=p.querySelector('.vm-popup-no')
  return {open:true, no:no?+no.textContent.trim():null,
    bg:no?__rgb(getComputedStyle(no).backgroundColor):'',
    text:(p.innerText||'').replace(/\\s+/g,' ').slice(0,70)}})())`)

const mapView = () => evj(`JSON.stringify({c:window.__map.getCenter().toArray().map(v=>+v.toFixed(5)),
  z:+window.__map.getZoom().toFixed(2)})`)

/** 挑一个「安全可见」的 marker：避开左右面板与顶部/底部工具条，且当前不在气泡底下 */
const SAFE = { x1: 430, x2: 1330, y1: 150, y2: 640 }
const safeMarker = async () => {
  const ms = (await markers()).filter((m) => m.shown)
  return ms.find((m) => m.cx > SAFE.x1 && m.cx < SAFE.x2 && m.cy > SAFE.y1 && m.cy < SAFE.y2) || null
}
/** elementFromPoint 是否真的落在该 marker 上（排除被面板压住） */
const hitIsMarker = (id) => ev(`(()=>{const m=document.querySelector('.vehicle-marker[data-car-id="${id}"]')
  if(!m) return 'no-marker'; const r=m.getBoundingClientRect()
  const el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2))
  return el ? (m.contains(el)||el===m) : 'null'})()`)

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })

  /* 登录态 → 首页 */
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(`!!document.querySelector('.login-overlay')`)
  await ev(`sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'admin',display_name:'巡检'}))`)
  await send('Page.navigate', { url: BASE + '/' })
  await mapReady()
  await sleep(1500)
  check(await waitFor(`!!window.__vehicleSim`, 8000), '地图 boot 完成（__vehicleSim 桥就绪）')

  /* 开「动态车辆」图层 —— 与 实时数据栏 开关同一个入口函数 */
  await ev(`window.__vehicleSim.setVisible(true)`)
  await sleep(1200)

  /* ===================== A 列表 ↔ 地图 同源 ===================== */
  console.log('\n===== A 列表与地图同源（编号 + 专属色）=====')
  const rs0 = await rows()
  const ms0 = await markers()
  info('面板行数 / 地图 marker 数', { rows: rs0.length, markers: ms0.length })
  check(rs0.length === 15 && ms0.length === 15, '面板 15 行、地图 15 个 marker', { rows: rs0.length, markers: ms0.length })

  const rowByCar = new Map(rs0.map((r) => [r.id, r]))
  const mkByCar = new Map(ms0.map((m) => [m.id, m]))
  const sameNo = rs0.every((r) => (mkByCar.get(r.id) || {}).no === r.no)
  check(sameNo, '每行徽标编号 == 同 id 的 marker 徽标编号',
    rs0.filter((r) => (mkByCar.get(r.id) || {}).no !== r.no).map((r) => ({ id: r.id, row: r.no, marker: (mkByCar.get(r.id) || {}).no })))

  const sameColor = rs0.every((r) => (mkByCar.get(r.id) || {}).color === r.color)
  check(sameColor && !!rs0[0].color, '每行徽标颜色 == 同 id 的 marker 颜色（--vm-color 同源）',
    { 行色: rs0.map((r) => r.color), marker色: ms0.map((m) => m.color) })

  /* 徽标编号必须是 1..15 且互不重复 —— 否则「第几号车」这个说法本身就不成立 */
  const nos = ms0.map((m) => m.no).sort((a, b) => a - b)
  check(nos.join(',') === Array.from({ length: 15 }, (_, i) => i + 1).join(','), '编号 1..15 唯一且连续（认车的前提）', nos)
  check((await errCount()) === 0, 'A 段无运行时错误', await errs())
  await errReset()

  /* ===================== B 点列表行 → 地图认车 ===================== */
  console.log('\n===== B 点面板某行 → 地图上认出这辆车 =====')
  const target = rs0[4] // 第 5 行（id=4），编号与颜色都可预期
  const tCar = await carOf(target.id)
  const v0 = await mapView()
  /* 命中测试：行不能被别的面板压住（本项目历史上真出过面板互相遮挡） */
  const hit = await ev(`(()=>{const el=document.elementFromPoint(${target.cx},${target.cy})
    const row=document.getElementById('vp-row-${target.id}')
    return el && row ? row.contains(el) : false})()`)
  check(hit === true, `第 ${target.no} 号行没被别的面板压住（elementFromPoint 命中该行）`, hit)

  await clickAt(target.cx, target.cy)
  await sleep(2200) // flyTo duration 1200ms + 余量

  const b1 = await bridge()
  check(b1.selected === target.id, `点第 ${target.no} 号行 → 该车被选中`, { expected: target.id, got: b1.selected })

  const ms1 = await markers()
  check(focusIds(ms1).join(',') === String(target.id), '地图上「有且只有」这一辆是高亮态(vm-focus)',
    { focus: focusIds(ms1), target: target.id })
  const rs1 = await rows()
  const tRow = rs1.find((r) => r.id === target.id)
  check(tRow?.focus === true, '该行自身也进入选中态（列表侧同步高亮）', tRow)

  const p1 = await popup()
  check(p1.open && p1.no === target.no, `弹出详情气泡且气泡内编号就是 ${target.no}`, p1)
  check(p1.open && p1.bg === tRow.color, '气泡内编号底色 == 该车专属色（三处同色）', { popup: p1.bg, row: tRow.color })
  info('气泡内容', p1.text)

  const v1 = await mapView()
  const dLng = Math.abs(v1.c[0] - tCar.lng), dLat = Math.abs(v1.c[1] - tCar.lat)
  check(v1.c[0] !== v0.c[0] || v1.c[1] !== v0.c[1], '地图确实动了（不是只高亮不定位）', { before: v0.c, after: v1.c })
  check(dLng < 0.02 && dLat < 0.02, '地图飞到该车所在位置（相机中心 ≈ 车辆坐标）',
    { 中心: v1.c, 车: [+tCar.lng.toFixed(5), +tCar.lat.toFixed(5)], 偏差: [+dLng.toFixed(5), +dLat.toFixed(5)] })
  check(Math.abs(v1.z - 15) < 0.6, '并放大到定位档位 zoom≈15（能从 15 辆车里挑出它）', { z0: v0.z, z1: v1.z })
  check((await errCount()) === 0, 'B 段无运行时错误', await errs())
  await errReset()

  /* ===================== C 悬停：只临时亮一辆，不干扰选中 ===================== */
  console.log('\n===== C 悬停面板行 → 地图临时高亮（不影响已选中）=====')
  const hoverTarget = rs0.find((r) => r.id !== target.id)
  await moveTo(hoverTarget.cx, hoverTarget.cy)
  await sleep(400)
  const ms2 = await markers()
  check(hoverIds(ms2).join(',') === String(hoverTarget.id), `悬停第 ${hoverTarget.no} 号行 → 地图上仅它进入悬停态(vm-hover)`,
    { hover: hoverIds(ms2), expected: hoverTarget.id })
  check(focusIds(ms2).join(',') === String(target.id), `已选中的 ${target.no} 号仍是选中态（悬停不抢占选中）`,
    { focus: focusIds(ms2) })
  const b2 = await bridge()
  check(b2.hovered === hoverTarget.id && b2.selected === target.id, 'store 里 悬停/选中 两个字段各管各的', b2)

  await moveTo(1300, 170) // 挪到地图空白处
  await sleep(400)
  const ms3 = await markers()
  check(hoverIds(ms3).length === 0, '鼠标移开 → 悬停态消失（不留下常亮）', { hover: hoverIds(ms3) })
  check(focusIds(ms3).join(',') === String(target.id), '选中态不受影响，仍在原车', { focus: focusIds(ms3) })
  check((await errCount()) === 0, 'C 段无运行时错误', await errs())
  await errReset()

  /* ===================== D 点地图 marker → 列表反向联动 ===================== */
  console.log('\n===== D 点地图上的车 → 面板对应行高亮并滚进视野 =====')
  /* 先把选中挪到列表末尾，这样点地图别的车时列表必须滚动才看得见该行 */
  await ev(`window.__vehicleSim.select(14, {openPopup:false})`)
  await sleep(500)
  const pick = await safeMarker()
  if (!pick) { check(false, '找到一个可安全点击的地图 marker', pick) }
  else {
    const hitM = await hitIsMarker(pick.id)
    check(hitM === true, `第 ${pick.no} 号 marker 在屏幕可点位置（未被面板遮挡）`, { id: pick.id, hit: hitM })
    const p2 = await carOf(pick.id)
    await clickAt(pick.cx, pick.cy)
    await sleep(1600)
    const b3 = await bridge()
    check(b3.selected === pick.id, `点地图第 ${pick.no} 号车 → 它被选中`, { expected: pick.id, got: b3.selected })
    const ms4 = await markers()
    check(focusIds(ms4).join(',') === String(pick.id), '地图上仅它高亮', { focus: focusIds(ms4) })
    const p3 = await popup()
    check(p3.open && p3.no === pick.no, `地图侧点击同样弹出气泡（编号 ${pick.no}）`, p3)
    const rs2 = await rows()
    const pRow = rs2.find((r) => r.id === pick.id)
    check(pRow?.focus === true, `面板第 ${pick.no} 号行同步进入选中态（列表侧认得是哪辆车）`, pRow)
    /* 滚进视野：行的上下边必须落在 .vp-list 的可见区内 */
    const vis = await evj(`JSON.stringify((()=>{const row=document.getElementById('vp-row-${pick.id}')
      const list=document.querySelector('.vp-list'); if(!row||!list) return null
      const a=row.getBoundingClientRect(), b=list.getBoundingClientRect()
      return {rowTop:Math.round(a.top),rowBottom:Math.round(a.bottom),
        listTop:Math.round(b.top),listBottom:Math.round(b.bottom),
        inView:a.top>=b.top-1&&a.bottom<=b.bottom+1, scrollTop:Math.round(list.scrollTop)}})())`)
    check(vis?.inView === true, '该行已自动滚进可见区（列表超过可视高度时也找得到）', vis)
    check((await errCount()) === 0, 'D 段无运行时错误', await errs())
    await errReset()
    info('该车道路', p2?.plate)
  }

  /* ===================== E 图层开关：选中态保持 ===================== */
  console.log('\n===== E 关图层再开：选中态是否保留 =====')
  const selBefore = (await bridge()).selected
  await ev(`window.__vehicleSim.setVisible(false)`)
  await sleep(700)
  const msOff = await markers()
  check(msOff.every((m) => m.shown === false), '关图层 → 所有 marker 隐藏', { shown: msOff.filter((m) => m.shown).length })
  const panelHidden = await ev(`(()=>{const p=document.querySelector('.vp-panel'); return p?getComputedStyle(p).display==='none':null})()`)
  check(panelHidden === true, '关图层 → 左下车辆面板同时收起（同开同关）', panelHidden)
  /* 气泡必须跟着图层一起收：它挂在车上，车不可见了气泡就没着落，而且 tick 还在跑，
   * 会拖着气泡跟那辆隐形的车在图上漂（本段就是为这个 bug 加的）。 */
  const pOff = await popup()
  check(pOff.open === false, '关图层 → 详情气泡一并收起（不留悬空气泡）', pOff)
  await sleep(1200) // 空转几个 tick，确认气泡不会被 tick 重新挂回来
  const pOff2 = await popup()
  check(pOff2.open === false, '关图层后持续若干 tick 气泡仍不出现（tick 不会把它拽回来）', pOff2)

  await ev(`window.__vehicleSim.setVisible(true)`)
  await sleep(900)
  const msOn = await markers()
  check(msOn.every((m) => m.shown === true), '重开图层 → marker 全部回来', { shown: msOn.filter((m) => m.shown).length })
  check(focusIds(msOn).join(',') === String(selBefore), '重开后之前选中的车仍是高亮态（设计如此）',
    { focus: focusIds(msOn), expected: selBefore })
  const pOn = await popup()
  check(pOn.open === true && pOn.no === (mkByCar.get(selBefore) || {}).no,
    '重开图层 → 选中车的详情气泡跟着回来（不留「高亮着却没详情」的半个状态）',
    { popup: pOn, expectedNo: (mkByCar.get(selBefore) || {}).no })
  check((await errCount()) === 0, 'E 段无运行时错误', await errs())
  await errReset()

  /* ===================== 汇总 ===================== */
  console.log(`\n===== 合计 ${pass} 通过 / ${fail} 失败 =====`)
  if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '))

  await Promise.race([new Promise((r) => { ws.onclose = r; ws.close() }), sleep(2000)])
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch {}
  process.exitCode = fail ? 1 : 0
}
