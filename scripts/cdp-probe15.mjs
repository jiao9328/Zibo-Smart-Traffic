/* 定向回归：任务「底部功能栏新增交通可视化大屏，把实时数据/库表数据联动起来用」。
 *
 * 分三段验：
 *   A 入口与层叠 —— 第 11 个按钮真的有字形、大屏真的全屏盖住底栏（这是本功能唯一
 *     与「浮层绝不盖住底栏」规则冲突的地方，必须用断言把例外固化成事实）；
 *   B 内容与对账 —— ★ 核心：大屏上的每个数字都必须等于**从 /api/mapdata 独立复算**的结果。
 *     对不上就说明屏里有硬编码的假数据，那"把数据用起来"就是表演；
 *   C 四种用法 —— 每种交互都验证"关屏后地图上真的到了那个位置、真的开了那个图层"。
 *
 * 前置：pnpm dev(:5180) + 后端(:3001) + Chrome headless --remote-debugging-port=9223
 * 用法：node scripts/cdp-probe15.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`

/* 同一口径复算：直接从后端拿原始行，不复用页面里的任何数字 —— 这是"对账"的全部意义。
 * ★ 必须放在建 WebSocket 之前：模块体在这里 await 会挂起让出事件循环，socket 趁这段时间
 * 就打开了，而那时 ws.onopen 还没绑定 —— open 事件永久丢失，脚本静默死等到天荒地老
 * （本文件踩过：看门狗 240s 触发时 CDP 轨迹是空的，一条命令都没发出去）。 */
const api = await (await fetch(BASE + '/api/mapdata')).json()
const D = api?.data || {}
const faultCam = (D.cameras || []).filter((c) => c.status === 'fault').length
const faultLight = (D.traffic_lights || []).filter((l) => l.state === 'fault').length
const offDuty = (D.police || []).filter((p) => !(p.onDuty === true || p.on_duty === true)).length
const maxFlow = Math.max(...(D.congestion || []).map((c) => c.flow || 0))
console.log(`后端原始行：探头 ${(D.cameras || []).length}(故障 ${faultCam}) 信号灯 ${(D.traffic_lights || []).length}(故障 ${faultLight}) 警员 ${(D.police || []).length}(离勤 ${offDuty}) 拥堵 ${(D.congestion || []).length}(峰值 ${maxFlow}) 警情 ${(D.alerts || []).length} 区县 ${(D.districts || []).length}`)

/* 复用已有 page 标签页（没有才新建）：反复 /json/new 会堆一地 about:blank，
 * 且新标签页在 headless 下偶尔不响应首条 CDP 命令 —— 上一次跑就在这卡死了 600s。 */
const targets = await (await fetch(`http://localhost:${CDP}/json/list`)).json()
let target = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE)) || targets.find((t) => t.type === 'page')
if (!target) {
  target = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
}
if (!target?.webSocketDebuggerUrl) { console.log('无法获取标签页'); process.exit(1) }
console.log(`连接标签页：${target.url.slice(0, 60)}`)
const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const trace = []
const idMethod = {}
const T0 = Date.now()
/* ★ 必须带超时：CDP 一旦不回（渲染进程崩了 / 标签页被回收），无超时的 Promise 会把
 * 整个脚本挂死且什么都不打印 —— 排查成本极高。超时后返回空结果，让断言如实失败。 */
const send = (m, p = {}) =>
  new Promise((r) => {
    const i = ++msgId
    trace.push(`${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`)
    if (trace.length > 14) trace.shift()
    idMethod[i] = m
    pending[i] = r
    try { ws.send(JSON.stringify({ id: i, method: m, params: p })) }
    catch (e) { delete pending[i]; console.log(`  ! 发送失败 ${m}: ${e.message}`); r({}) ; return }
    setTimeout(() => { if (pending[i]) { delete pending[i]; console.log(`  ! CDP 超时(20s)：${m}`); r({}) } }, 20000)
  })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    // 必须报出方法名：CDP 只回一句「Invalid parameters」时，不知道是哪个命令、哪个参数，
    // 只能靠猜（本文件为此白跑了一轮）
    if (m.error) console.log(`  ! CDP ${idMethod[m.id] || '?'} 失败：${m.error.message}${m.error.data ? ' ' + JSON.stringify(m.error.data) : ''}`)
    pending[m.id](m.result); delete pending[m.id]
  }
}
ws.onerror = (e) => console.log(`  ! WebSocket 错误：${e?.message || e?.type || '未知'}`)
ws.onclose = (e) => console.log(`  ! WebSocket 已关闭 code=${e.code} reason=${e.reason || ''}`)
/* 看门狗：整体超时就带着「最后 14 次 CDP 调用」退出，不让排查变成猜 */
const watch = setTimeout(() => {
  console.log('\n!! 看门狗触发：脚本运行超时。最后 CDP 调用轨迹：')
  console.log(trace.map((t) => '   ' + t).join('\n'))
  console.log('!! 若停在 Runtime.evaluate，则页面/渲染进程无响应；若停在 enable/navigate，则标签页未就绪')
  process.exit(3)
}, 240000)
watch.unref?.()
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

/* 真实鼠标事件（不是 el.click()）：命中测试/浮层遮挡这类问题只有真事件才暴露 */
const clickAt = async (x, y) => {
  /* ★ 坐标必须自己校验：CDP 收到 undefined/NaN 只回一句「Invalid parameters」，
   * 而调用方看到的是「点击没生效」—— 排查方向会被彻底带偏。 */
  if (!Number.isFinite(x) || !Number.isFinite(y)) { console.log(`  ! 点击坐标非法 (${x}, ${y})，已跳过`); return }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 0 }); await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(120)
}
/** 在 sel 命中、文本含 sub 的第 nth 个元素中心点一下；找不到返回 false
 *
 * ★ 必须做命中测试再点：scrollIntoView 之后立刻读 rect，若滚动还在进行（CSS smooth 或
 * 长列表惯性），算出的坐标是**滚动前的**，鼠标事件会打到别处 —— 表现为「点了没反应」，
 * 排查方向会被带偏（本文件为此空过一轮）。所以：读坐标 → elementFromPoint 核对
 * 目标真的在那个点上 → 不对就等 300ms 重试，仍不对则打印"挡路的是谁"。 */
const clickEl = async (sel, sub = '', nth = 0) => {
  for (let i = 0; i < 3; i++) {
    const r = await evj(`(()=>{
      const es=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>!${JSON.stringify(sub)}||e.textContent.includes(${JSON.stringify(sub)}))
      const e=es[${nth}]; if(!e) return null
      e.scrollIntoView({ block: 'center', behavior: 'instant' })
      const b=e.getBoundingClientRect()
      if(b.width<1||b.height<1) return JSON.stringify({ zero: true, cls: e.className })
      const x=Math.round(b.left+b.width/2), y=Math.round(b.top+b.height/2)
      const hit=document.elementFromPoint(x, y)
      return JSON.stringify({ x, y, ok: !!hit && (e===hit||e.contains(hit)), hit: hit ? (hit.className||hit.tagName) : 'null' })})()`)
    /* evaluate 报错时 evj 返回的是 '<<SyntaxError...>>' 这类**真值字符串**，
     * 直接取 r.x 会得到 undefined 再喂给 Input —— 这里必须挡住并喊出来 */
    if (!r || typeof r !== 'object' || !Number.isFinite(r.x)) { console.log(`  ! 找不到可点元素：${sel} ${sub ? `(文本含「${sub}」)` : ''}${typeof r === 'string' ? ' | ' + r : ''}`); return false }
    if (r.ok) { await clickAt(r.x, r.y); return true }
    if (i < 2) { await sleep(300); continue }
    console.log(`  ! 点击被遮挡：${sel} ${sub ? `(文本含「${sub}」)` : ''} 中心(${r.x},${r.y}) 命中的是 ${JSON.stringify(r.hit)}`)
  }
  return false
}
const esc = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)
}
const openScreen = async () => { await clickEl('.btn-groups .item', '交通大屏'); await sleep(700) }
const screenOpen = () => ev(`!!document.querySelector('.ts-screen')`)
const center = () => evj(`JSON.stringify({lng:window.__map.getCenter().lng, lat:window.__map.getCenter().lat, zoom:window.__map.getZoom()})`)
/* 两点的曼哈顿距离（度）：用来断言"相机真的动了"。绝不能只断言"中心在某要素附近"——
 * 初始中心就在张店区，那样的断言恒真，等于没断言（本文件为此空过一轮）。 */
const moved = (a, b) => Math.abs(a.lng - b.lng) + Math.abs(a.lat - b.lat)
/* 把相机瞬移到远处再测定位：否则"从张店区飞到张店区"位移≈0，断言无从谈起 */
/* 包一层 IIFE 并返回字符串：jumpTo 返回的是 map 实例本身，直接被 returnByValue 序列化会报
 * 「Object reference chain is too long」（mapbox 实例引用链太深），刷一屏假错误 */
const resetCam = async () => { await ev(`(()=>{window.__map.jumpTo({ center: [117.9, 36.6], zoom: 7 }); return 'ok'})()`); await sleep(600) }

/* 卡片用 data-card 锚点（组件里已加）。★ 不要写「先 find 出卡片元素、再拼 CSS」——
 * 元素表达式不是选择器，拼出来是非法 CSS，querySelectorAll 抛 SyntaxError，
 * 而 evj 会把错误串当字符串返回（真值！），于是拿着 undefined 坐标去点，
 * CDP 只回一句 Invalid parameters：全变成"静默没点"，看起来像功能坏了。 */
const SEL = (card, inner = '') => `[data-card="${card}"]${inner ? ' ' + inner : ''}`
const rowCount = (card) => ev(`(document.querySelector(${JSON.stringify(SEL(card, '.ts-list'))})?.querySelectorAll('.ts-row').length)||0`)
/** 底部详情条的文本（未选中任何行时为 null）—— 点行等于"看"，必须每次都真的摊开 */
const detailText = () => evj(`(()=>{const d=document.querySelector('.ts-detail'); return d?JSON.stringify(d.textContent.replace(/\\s+/g,' ').trim()):null})()`)

ws.onopen = () => { onOpen().catch((e) => { console.log('!! 探针异常：', e?.stack || e); process.exit(4) }) }
async function onOpen() {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||e.reason)));
      try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'admin',display_name:'核验'}))}catch(e){}`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  check(await waitFor(`!!(window.__map && window.__scene && window.__traffic)`), '地图 boot + __traffic 桥就绪')
  check(await waitFor(`document.querySelectorAll('.btn-groups .item').length>=11`), '底部工具条 11 个入口已挂载')
  await sleep(1500)

  /* ===================== A 入口与层叠 ===================== */
  console.log('\n===== A 入口与层叠 =====')
  const items = await evj(`JSON.stringify([...document.querySelectorAll('.btn-groups .item')].map(e=>e.textContent.trim()))`)
  check((items || []).length === 11, '底部共 11 个入口（原有 10 个 + 交通大屏）', items)
  check((items || [])[10] === '交通大屏', '第 11 个入口是「交通大屏」（追加在末尾，不打乱既有序号）', items?.[10])
  const glyph = await evj(`(()=>{const e=[...document.querySelectorAll('.btn-groups .item')].find(x=>x.textContent.includes('交通大屏'));
    if(!e) return null; const i=e.querySelector('i.iconfont'); if(!i) return null
    return JSON.stringify({cls:i.className, content:getComputedStyle(i,'::before').content})})()`)
  check(!!glyph && glyph.content && glyph.content !== 'none' && glyph.content !== '""', '「交通大屏」图标字形真实存在', glyph)
  info('图标类名', glyph?.cls)

  await openScreen()
  check(await screenOpen(), '点「交通大屏」后大屏挂载')
  const rect = await evj(`(()=>{const e=document.querySelector('.ts-screen'); if(!e) return null
    const b=e.getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:Math.round(b.width),h:Math.round(b.height),iw:innerWidth,ih:innerHeight})})()`)
  check(rect && rect.l === 0 && rect.t === 0 && rect.w === rect.iw && rect.h === rect.ih, '大屏铺满整个视口', rect)
  const zi = await ev(`${(() => `(()=>{const e=document.querySelector('.ts-screen');return e?getComputedStyle(e).zIndex:''})()`)()}`)
  const footerZi = await ev(`getComputedStyle(document.querySelector('.footer')).zIndex`)
  check(Number(zi) > Number(footerZi), '大屏层级高于底部工具条（全屏覆盖是有意的例外）', { screen: zi, footer: footerZi })
  /* 盖住底栏 —— 用命中测试而不是看 z-index 数字 */
  const blockFooter = await evj(`(()=>{const b=document.querySelector('.footer .item button'); const r=b.getBoundingClientRect()
    const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2)
    return JSON.stringify({hit:hit?.className||'', blocked:!b.contains(hit) && hit!==b})})()`)
  check(blockFooter?.blocked, '大屏开着时底部按钮点不到（确实全屏覆盖）', blockFooter)
  const aiFab = await evj(`(()=>{const f=document.querySelector('.ai-fab'); if(!f) return null; const r=f.getBoundingClientRect()
    const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2)
    return JSON.stringify({blocked:!f.contains(hit)&&hit!==f})})()`)
  if (aiFab) check(aiFab.blocked, '大屏开着时 AI 悬浮球也被盖住（不会浮在屏上变成可点的洞）', aiFab)
  else info('未找到 .ai-fab，跳过 AI 悬浮球遮挡断言')

  try { mkdirSync('logs', { recursive: true }) } catch (e) {}
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot?.data) { writeFileSync('logs/screen-full.png', Buffer.from(shot.data, 'base64')); info('截图 logs/screen-full.png') }

  /* Esc 关闭 → 再开（把 Esc 这条退出口也验掉） */
  await esc()
  check(!(await screenOpen()), 'Esc 能关闭大屏')
  await openScreen()

  /* ===================== B 内容与对账 ===================== */
  console.log('\n===== B 内容与对账（大屏数字 vs 后端原始行同口径复算） =====')
  const kpi = await evj(`JSON.stringify([...document.querySelectorAll('.ts-kpi')].map(k=>k.textContent.replace(/\\s+/g,' ').trim()))`)
  check((kpi || []).length >= 6, 'KPI 条渲染出数字卡', kpi?.length)
  const camKpi = (kpi || []).find((s) => s.includes('监控探头'))
  check(!!camKpi && camKpi.includes(String((D.cameras || []).length)), `探头总数与库一致（${(D.cameras || []).length}）`, camKpi)
  check(!!camKpi && camKpi.includes(String(faultCam)), `探头故障数与库一致（${faultCam}）`, camKpi)

  const nDistrict = await rowCount('district')
  check(nDistrict === (D.districts || []).length, `区县卡 ${nDistrict} 行 = 库中 districts 行数（${(D.districts || []).length}）`)
  const zd = await evj(`(()=>{const c=document.querySelector(${JSON.stringify(SEL('district'))}); if(!c) return null
    const row=[...c.querySelectorAll('.ts-row')].find(r=>r.textContent.includes('张店区')); if(!row) return null
    const nums=[...row.querySelectorAll('.ts-nums i')].map(i=>i.textContent.replace(/\\s+/g,' ').trim())
    return JSON.stringify(nums)})()`)
  const zdExpect = (D.cameras || []).filter((c) => c.area === '张店区').length
  check(!!zd && zd[0]?.includes(String(zdExpect)), `张店区探头数与跨表聚合一致（${zdExpect}）`, zd?.[0])
  const zdOff = (D.police || []).filter((p) => p.district === '张店区' && !(p.onDuty === true || p.on_duty === true)).length
  check(!!zd && zd[2]?.includes(String(zdOff)), `张店区离勤警力数一致（警员表字段名是 district，最容易接错的一列：${zdOff}）`, zd?.[2])

  const nCong = await rowCount('congestion')
  check(nCong === (D.congestion || []).length, `拥堵排行 ${nCong} 行 = 库中 congestion 行数（${(D.congestion || []).length}）`)
  const topFlow = await evj(`(()=>{const c=document.querySelector(${JSON.stringify(SEL('congestion'))}); const r=c?.querySelector('.ts-row'); return r?JSON.stringify(r.textContent.replace(/\\s+/g,' ').trim()):null})()`)
  check(!!topFlow && topFlow.includes(String(maxFlow)), `排行第 1 行是最大流量（${maxFlow} 辆/h，排序口径正确）`, topFlow)

  const chips = await evj(`(()=>{const c=document.querySelector(${JSON.stringify(SEL('fault'))}); return JSON.stringify([...c.querySelectorAll('.ts-chip')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()))})()`)
  const chipNum = (label) => { const s = (chips || []).find((x) => x.includes(label)); const m = s && s.match(/(\d+)\s*$/); return m ? Number(m[1]) : null }
  check(chipNum('信号灯') === faultLight, `巡检「信号灯」chip 数字 = 库中故障信号灯数（${faultLight}）`, chips)
  check(chipNum('警力') === offDuty, `巡检「警力」chip 数字 = 库中离勤警力数（${offDuty}）`, chips)
  check(chipNum('探头') === faultCam, `巡检「探头」chip 数字 = 库中故障探头数（${faultCam}）`, chips)

  const nCar = await rowCount('vehicle')
  check(nCar === 15, `车辆卡 ${nCar} 行 = vehicleSim 的 15 辆模拟车`)
  const hasCanvas = await ev(`!!document.querySelector(${JSON.stringify(SEL('trend', 'canvas'))})`)
  check(hasCanvas, '运行态势卡的 G2Plot 折线真的画出来了（canvas 存在）')
  const cong3 = await evj(`(()=>{const c=document.querySelector(${JSON.stringify(SEL('trend'))}); return JSON.stringify([...c.querySelectorAll('.ts-cong3-item')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()))})()`)
  const severe = (D.congestion || []).filter((x) => x.level === 0).length
  check(!!cong3 && cong3[0]?.includes(String(severe)), `严重拥堵数一致（${severe}）`, cong3?.[0])

  /* ===================== C 四种「用起来」 ===================== */
  console.log('\n===== C 四种用法（关屏后地图上真的到位） =====')
  /* 每条都先 jumpTo 到远处（117.9,36.6 / zoom 7）：初始相机本来就在张店区，
   * 不挪走的话"中心落在张店区"这种断言恒真 */
  const GO = '.ts-detail .el-button'
  // ① 区县穿透 → 定位（只飞 + 气泡，不自动开图层）
  await resetCam()
  await clickEl('.ts-row', '张店区')
  const detailShot = await detailText()
  check(!!detailShot && detailShot.includes('常住人口'), '点区县行 → 底部详情条摊开该区全部字段', detailShot)
  check(await clickEl(GO, '在地图上查看'), '详情条的「在地图上查看」按钮可点（不是只画了个按钮）')
  await sleep(1700)
  let c0 = await center()
  check(!(await screenOpen()), '定位后大屏自动关闭（全屏不让位，必须关掉才看得见）')
  const zdCenter = (D.districts || []).find((x) => x.name === '张店区')
  check(moved(c0, { lng: 117.9, lat: 36.6 }) > 0.05, '相机真的动了（不是原地不动就宣称"定位成功"）', c0)
  check(!!zdCenter && Math.abs(c0.lng - zdCenter.lng) < 0.05 && Math.abs(c0.lat - zdCenter.lat) < 0.05,
    '地图中心落到了张店区中心', { now: c0, want: zdCenter })
  check(Math.abs(c0.zoom - 10.5) < 0.6, `区县定位用了概览级 zoom≈10.5（实测 ${c0.zoom}）`)
  check(await ev(`!!document.querySelector('.l7-popup')`), '区县信息气泡弹出（不自动开图层，避免 7 层齐开糊屏）')

  // ② 拥堵路段 → 打开拥堵图层 + 飞过去
  await resetCam()
  await openScreen()
  await clickEl(SEL('congestion', '.ts-row'), '', 0)
  check(!!(await detailText()), '点拥堵行 → 详情条出现')
  await clickEl(GO, '在地图上查看')
  await sleep(1700)
  c0 = await center()
  check(await ev(`window.__traffic.visible('congestion')===true`), '拥堵定位自动打开了「道路拥堵」图层')
  const cgRow = (D.congestion || []).slice().sort((a, b) => b.flow - a.flow)[0]
  check(moved(c0, { lng: 117.9, lat: 36.6 }) > 0.05, '相机真的动了', c0)
  check(Math.abs(c0.lng - cgRow.lng) < 0.05 && Math.abs(c0.lat - cgRow.lat) < 0.05, '地图中心落到了该拥堵路段', { now: c0, want: cgRow })

  // ③ 警情 → 没有对应图层，靠气泡标注
  await resetCam()
  await openScreen()
  await clickEl(SEL('alert', '.ts-row'), '', 0)
  const alDetail = await detailText()
  check(!!alDetail, '点警情行 → 详情条摊开（警情表里若有坐标为空的记录，这里会点了个寂寞）', alDetail)
  await clickEl(GO, '在地图上查看')
  await sleep(1700)
  c0 = await center()
  const alRow = (D.alerts || []).filter((a) => a.status === 'pending').sort((a, b) => b.minutes_ago - a.minutes_ago)[0] || (D.alerts || [])[0]
  check(moved(c0, { lng: 117.9, lat: 36.6 }) > 0.05, '相机真的动了', c0)
  check(Math.abs(c0.lng - alRow.lng) < 0.05 && Math.abs(c0.lat - alRow.lat) < 0.05, '警情定位飞到了该警情位置（警情无图层，气泡是唯一可见结果）', { now: c0, want: alRow })
  check(await ev(`!!document.querySelector('.l7-popup')`), '警情气泡弹出')

  // ④ 设备工况巡检 → 打开探头图层 + 飞过去
  await resetCam()
  await openScreen()
  await clickEl(SEL('fault', '.ts-chip'), '探头')
  const nFaultRow = await rowCount('fault')
  check(nFaultRow === faultCam, `切到「探头」后清单 ${nFaultRow} 行 = 库中故障探头（${faultCam}）`)
  await clickEl(SEL('fault', '.ts-row'), '', 0)
  check(!!(await detailText()), '点巡检行 → 详情条摊开')
  await clickEl(GO, '在地图上查看')
  await sleep(1700)
  c0 = await center()
  check(await ev(`window.__traffic.visible('camera')===true`), '巡检定位自动打开了「监控探头」图层')
  const fcRow = (D.cameras || []).filter((c) => c.status === 'fault')[0]
  check(moved(c0, { lng: 117.9, lat: 36.6 }) > 0.05, '相机真的动了', c0)
  check(Math.abs(c0.lng - fcRow.lng) < 0.05 && Math.abs(c0.lat - fcRow.lat) < 0.05, '地图中心落到了该故障探头', { now: c0, want: fcRow })

  // ⑤ 车辆实时追踪 → selectVehicle（飞 + marker 高亮 + 左侧面板联动）
  await ev(`(()=>{window.__traffic.setVisible('vehicle', true); return 'ok'})()`)
  await sleep(1500)
  await resetCam()
  await openScreen()
  await clickEl(SEL('vehicle', '.ts-row'), '', 0)
  const vDetail = await detailText()
  check(!!vDetail && vDetail.includes('号车'), '点车辆行 → 详情条显示该车字段', vDetail)
  await clickEl(GO, '在地图上查看')
  await sleep(1900)
  const focus = await ev(`document.querySelectorAll('.vehicle-marker.vm-focus').length`)
  /* 车辆在 300ms 持续移动，不能断言"中心等于某车坐标"（追不上），改为断言缩放确实压到跟车级 */
  check(focus === 1, '地图上恰好一辆车处于选中态（放大 + 呼吸光环）', focus)
  c0 = await center()
  check(c0.zoom >= 13, `车辆定位把相机压到跟车级 zoom（实测 ${c0.zoom}）`, c0)
  check(!(await screenOpen()), '车辆定位后大屏自动关闭')

  /* ===================== D 收尾：关屏后底栏必须复活 ===================== */
  console.log('\n===== D 收尾 =====')
  const hits = await evj(`(()=>{const bad=[]
    for(const e of document.querySelectorAll('.btn-groups .item')){
      const b=e.getBoundingClientRect(); const hit=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2)
      if(!(e===hit||e.contains(hit))) bad.push(e.textContent.trim())
    } return JSON.stringify(bad)})()`)
  check((hits || []).length === 0, '关屏后 11 个底部按钮全部可命中（大屏没留下遮挡）', hits)
  const onLeft = await ev(`document.querySelectorAll('.btn-groups .item.on').length`)
  check(onLeft === 0, '关屏后没有按钮残留点亮态', onLeft)
  const errs = await evj(`JSON.stringify(window.__errs||[])`)
  check((errs || []).length === 0, '全程无运行时错误', errs)

  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`)
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '))
  process.exit(fail ? 1 : 0)
}
