/* 任务4 验证：换肤后的浮层层级与可读性
 *
 * 覆盖换肤最容易翻车的几处（都不是「好不好看」，而是「能不能用」）：
 *   1. 所有浮层底色必须是白卡片 —— 不能残留深色块（换肤漏改）
 *   2. 深色皮肤遗留的「白字」在白色卡片上会彻底看不见 —— 逐个浮层查文字对比度
 *   3. 图层开关、底部按钮换肤后仍要可点（z-index / pointer-events 没被改坏）
 *   4. 控制中心打开时车辆面板要让位，不能压住图表列
 *
 * 前置：pnpm dev 在 5180；Chrome headless 在 9223（见 cdp-probe6.mjs 顶部）
 * 用法：node scripts/cdp-probe9.mjs
 */
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const CDP = process.env.CDP_PORT || '9223'

const list = await (await fetch(`http://localhost:${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r && r.result ? r.result.value : '<<' + (r?.exceptionDetails?.exception?.description || 'no-result') + '>>')
const evj = (x) => ev(x).then((s) => {
  if (typeof s !== 'string') return s
  if (s[0] !== '{' && s[0] !== '[') return s
  try { return JSON.parse(s) } catch { return s }
})

let pass = 0, fail = 0
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`, detail !== undefined ? JSON.stringify(detail) : '') }
  else { fail++; console.log(`  ❌ ${label}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

/* 页面内注入的通用检查函数：
 *  - panelInfo: 取浮层的底色、边框、阴影、尺寸
 *  - contrast:  取元素文字色与它的实际背景色，算 WCAG 对比度
 *    （背景要沿祖先链找第一个非透明的 background-color，不能只看元素自己） */
const HELPERS = `
window.__probe = {
  bgOf(el) {
    let n = el
    while (n && n.nodeType === 1) {
      const c = getComputedStyle(n).backgroundColor
      if (c && c !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(c)) return c
      n = n.parentElement
    }
    return 'rgb(255,255,255)'
  },
  panelInfo(sel) {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el), b = el.getBoundingClientRect()
    return { bg: cs.backgroundColor, border: cs.borderTopColor, shadow: cs.boxShadow.slice(0, 40),
             w: Math.round(b.width), h: Math.round(b.height),
             x: Math.round(b.left), y: Math.round(b.top) }
  },
  // 相对亮度 → WCAG 对比度
  lum(c) {
    const m = c.match(/[\\d.]+/g).map(Number)
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2])
  },
  contrast(sel) {
    const el = document.querySelector(sel)
    if (!el) return null
    const fg = getComputedStyle(el).color, bg = this.bgOf(el)
    const a = this.lum(fg), b = this.lum(bg)
    const hi = Math.max(a, b), lo = Math.min(a, b)
    return { fg, bg, ratio: +(((hi + 0.05) / (lo + 0.05))).toFixed(2) }
  },
  // 找出所有「白字白底」这类不可读的文字节点
  badText(rootSel) {
    const root = document.querySelector(rootSel)
    if (!root) return []
    const out = []
    for (const el of root.querySelectorAll('*')) {
      if (!el.childNodes.length) continue
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (!hasText) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const c = this.contrastEl(el)
      if (c && c.ratio < 2.0) out.push({ t: el.textContent.trim().slice(0, 14), ...c })
    }
    return out.slice(0, 8)
  },
  contrastEl(el) {
    const fg = getComputedStyle(el).color, bg = this.bgOf(el)
    const a = this.lum(fg), b = this.lum(bg)
    const hi = Math.max(a, b), lo = Math.min(a, b)
    return { fg, bg, ratio: +(((hi + 0.05) / (lo + 0.05))).toFixed(2) }
  }
}`

/* 底部按钮必须走「mouseMoved → mousePressed → mouseReleased」三步。
 * 实测只派发 pressed/released（省掉 mouseMoved）时 Chrome 不会合成 click，
 * Vue 的 @click 也就不触发 —— 这不是应用坏了，是探针发的事件不完整。 */
const clickBottom = async (label) => {
  const b = await evj(`JSON.stringify((() => {
    const it = [...document.querySelectorAll('.btn-groups .item')].find(e => e.textContent.includes(${JSON.stringify(label)}));
    if (!it) return null; const el = it.querySelector('button') || it;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })())`)
  if (!b || typeof b !== 'object') return null
  const mp = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mp })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mp })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mp })
  return b
}

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  const vis = await ev(`document.visibilityState`)
  const fps = await ev(`new Promise(r=>{const t0=performance.now();let n=0;
    const f=()=>{n++; performance.now()-t0<1000 ? requestAnimationFrame(f) : r(n)};
    requestAnimationFrame(f); setTimeout(()=>r(n),1600)})`)
  if (vis !== 'visible' || !fps) {
    console.log(`\n环境不合格：visibilityState=${vis}, rAF 帧数=${fps}。Chrome 需 headless 启动。`)
    process.exit(1)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  let booted = false
  for (let i = 0; i < 90; i++) {
    if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) { booted = true; break }
    await sleep(1000)
  }
  if (!booted) { console.log('\n底部工具条未出现'); process.exit(1) }
  await sleep(1500)
  await ev(HELPERS)

  /* ============ S1 首页各浮层都是白卡片 ============ */
  console.log('\n=== S1 浮层底色 ===')
  // 判定标准：RGB 三分量都 > 235 —— 深色皮肤那些 rgba(5,18,42,.62) 会远低于此
  for (const [name, sel] of [['顶部栏', '.header'], ['底部工具条', '.footer'], ['实时数据栏', '.rt-panel'], ['道路分级栏', '.road-bar']]) {
    const p = await evj(`JSON.stringify(window.__probe.panelInfo(${JSON.stringify(sel)}))`)
    const rgb = (p?.bg || '').match(/[\d.]+/g)?.map(Number) || []
    check(rgb.length >= 3 && rgb[0] > 235 && rgb[1] > 235 && rgb[2] > 235, `${name} 是白卡片`, p?.bg)
  }

  /* ============ S2 文字对比度（白字白底是最容易漏的换肤事故） ============ */
  console.log('\n=== S2 对比度 ===')
  for (const [name, sel] of [['顶部栏标题', '.header-title'], ['底部按钮标签', '.btn-groups .item p'],
                             ['实时数据行', '.rt-item .rt-name'], ['道路分级按钮', '.road-btn']]) {
    const c = await evj(`JSON.stringify(window.__probe.contrast(${JSON.stringify(sel)}))`)
    check((c?.ratio || 0) >= 3.0, `${name} 对比度 ≥ 3（可读）`, c)
  }
  const badHome = await evj(`JSON.stringify(window.__probe.badText('.header, .footer, .rt-panel, .road-bar'))`)
  check((badHome || []).length === 0, '首页无低对比度（<2）文字', badHome)

  /* ============ S3 底部按钮仍可点（换肤别把 z-index/pointer-events 改坏） ============ */
  console.log('\n=== S3 底部按钮命中 ===')
  const hit = await evj(`JSON.stringify((()=>{
    const bad = []
    for (const it of document.querySelectorAll('.btn-groups .item')) {
      const btn = it.querySelector('button') || it
      const r = btn.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2)
      if (!(top === btn || btn.contains(top) || it.contains(top)))
        bad.push({ label: it.textContent.trim(), top: top ? top.className : null })
    }
    return { n: document.querySelectorAll('.btn-groups .item').length, bad }
  })())`)
  check(hit?.n >= 10, '底部按钮数量正常', { n: hit?.n })
  check((hit?.bad || []).length === 0, '每个按钮的中心点都命中自己', hit?.bad)

  /* ============ S4 控制中心：图表卡片白底 + 车辆面板让位 ============ */
  console.log('\n=== S4 控制中心 ===')
  await clickBottom('控制中心')
  await sleep(2200)
  const cards = await evj(`JSON.stringify([...document.querySelectorAll('.g2-chart')].map(e => getComputedStyle(e).backgroundColor))`)
  check((cards || []).length === 6, '控制中心 6 张卡片', { n: (cards || []).length })
  check((cards || []).every((c) => { const m = c.match(/[\d.]+/g).map(Number); return m[0] > 235 && m[1] > 235 && m[2] > 235 }),
    '6 张卡片都是白底', cards?.[0])

  // 车辆面板：开图层后打开控制中心，必须让到图表列右侧且不与之重叠
  await ev(`(()=>{const it=[...document.querySelectorAll('.rt-item')].find(e=>e.textContent.includes('动态车辆')); if(it && !it.classList.contains('on')) it.click()})()`)
  await sleep(1200)
  const geo = await evj(`JSON.stringify((()=>{
    const vp = document.querySelector('.vp-panel'), col = document.querySelector('.g2-left')
    if (!vp || !col) return null
    const a = vp.getBoundingClientRect(), c = col.getBoundingClientRect()
    const overlap = !(a.right <= c.left || a.left >= c.right || a.bottom <= c.top || a.top >= c.bottom)
    return { shift: vp.className.includes('shift'), vp: [Math.round(a.left), Math.round(a.top), Math.round(a.width)],
             col: [Math.round(c.left), Math.round(c.right)], overlap }
  })())`)
  check(geo?.shift === true, '控制中心打开时车辆面板带 .shift 让位', geo)
  check(geo?.overlap === false, '车辆面板与左侧图表列不重叠', geo)

  // 面板内部文字对比度（车辆面板换肤后）
  const badVp = await evj(`JSON.stringify(window.__probe.badText('.vp-panel'))`)
  check((badVp || []).length === 0, '车辆面板无低对比度文字', badVp)

  /* ============ S5 数据管理面板 ============ */
  console.log('\n=== S5 数据管理 ===')
  await ev(`(()=>{const it=[...document.querySelectorAll('.btn-groups .item')].find(e=>e.textContent.includes('数据管理')); it&&it.click()})()`)
  await sleep(1600)
  const dm = await evj(`JSON.stringify(window.__probe.panelInfo('.dm-panel'))`)
  const dmRgb = (dm?.bg || '').match(/[\d.]+/g)?.map(Number) || []
  check(dmRgb.length >= 3 && dmRgb[0] > 235 && dmRgb[1] > 235 && dmRgb[2] > 235, '数据管理面板是白卡片', dm?.bg)
  const badDm = await evj(`JSON.stringify(window.__probe.badText('.dm-panel'))`)
  check((badDm || []).length === 0, '数据管理面板无低对比度文字', badDm)
  const tbl = await evj(`JSON.stringify({
    ths: document.querySelectorAll('.dm-panel .el-table th.el-table__cell').length,
    rows: document.querySelectorAll('.dm-panel .el-table__body tr.el-table__row').length })`)
  check(tbl?.ths > 0, '数据管理表格已渲染（表头存在）', tbl)
  // 行数取决于本地数据服务（pnpm server）是否在跑，不写成断言，只报数
  console.log(`     （数据行 ${tbl?.rows ?? '?'} 行，取决于 pnpm server 是否运行）`)

  /* ============ S6 AI 助手 ============ */
  console.log('\n=== S6 AI 助手 ===')
  await ev(`document.querySelector('.ai-fab').click()`)
  await sleep(700)
  const ai = await evj(`JSON.stringify(window.__probe.panelInfo('.ai-panel'))`)
  const aiRgb = (ai?.bg || '').match(/[\d.]+/g)?.map(Number) || []
  check(aiRgb.length >= 3 && aiRgb[0] > 235 && aiRgb[1] > 235 && aiRgb[2] > 235, 'AI 对话框是白卡片', ai?.bg)
  const badAi = await evj(`JSON.stringify(window.__probe.badText('.ai-panel'))`)
  check((badAi || []).length === 0, 'AI 对话框无低对比度文字', badAi)

  console.log('\n=== 运行时错误（首页） ===')
  const errs = await evj(`JSON.stringify((window.__errs||[]).slice(0,6))`)
  check((errs || []).length === 0, '首页无运行时错误', errs)

  /* ============ S7 其余路由的浮层 ============
   * 这几页平时没人点，换肤最容易漏；而「拉框查询结果表格被实时数据栏压住」
   * 正是任务2 的同类问题，必须断言 —— 但它 v-show 在无查询结果时是 display:none，
   * getBoundingClientRect 全 0，量不到。所以改判 computed left 是否让开了实时栏右缘。 */
  /* ============ S7 窄屏下车辆面板仍不压两列图表 ============
   * .vp-panel.shift 的 left 是 200px + 列宽 + 12px 硬算出来的，列宽是 clamp(280px,25vw,400px)，
   * 视口越窄列宽越小、但面板自身固定 340px 宽 —— 窄到一定程度右边缘就会顶进右侧图表列。
   * 面板 z-index(46) 低于图表(80)，压上就是被盖住，用户看不到车辆列表。
   * 必须在换路由之前做：此时还在首页，且图表与车辆图层都是开的。 */
  console.log('\n=== S7 窄屏几何（1280×720） ===')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  await sleep(1500)
  const narrow = await evj(`JSON.stringify((()=>{
    const vp = document.querySelector('.vp-panel')
    const cols = [document.querySelector('.g2-left'), document.querySelector('.g2-right')].filter(Boolean)
    if (!vp || !cols.length) return null
    const a = vp.getBoundingClientRect()
    const hit = cols.filter(c => { const b = c.getBoundingClientRect()
      return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom) })
    return { vp: [Math.round(a.left), Math.round(a.right)],
             cols: cols.map(c => [Math.round(c.getBoundingClientRect().left), Math.round(c.getBoundingClientRect().right)]),
             overlap: hit.length }
  })())`)
  check(narrow?.overlap === 0, '1280 宽下车辆面板不压左右图表列', narrow)
  check((await ev(`document.querySelectorAll('.btn-groups .item').length`)) >= 10, '窄屏下底部工具条仍在')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(800)

  console.log('\n=== S8 其余路由 ===')
  for (const [name, path, sel] of [
    ['事件信息·拉框查询卡片', '/eventinfo', '.box-card'],
    ['切换风格·菜单', '/changestyle', '#menu']
  ]) {
    await send('Page.navigate', { url: BASE + path })
    /* 等地图就绪（App.vue 的 RealtimeBar/VehiclePanel 都挂 v-if="loadMap"）。
     * 只 sleep 固定秒数不行：mapbox 的 load 事件依赖 rAF 渲染循环，
     * 冷启动这一页可能要好几秒，等不到就整个左上区域都不存在。 */
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!document.querySelector('.rt-panel')`)) break
      await sleep(500)
    }
    // ★ __probe 是用 Runtime.evaluate 注入的，只活在当前文档里；导航一次就没了。
    // 不重新注入的话下面所有取 panelInfo 的断言都拿到 undefined，且不会报错、只报「不是白卡片」。
    await ev(HELPERS)
    const p = await evj(`JSON.stringify(window.__probe.panelInfo(${JSON.stringify(sel)}))`)
    const rgb = (p?.bg || '').match(/[\d.]+/g)?.map(Number) || []
    check(rgb.length >= 3 && rgb[0] > 235 && rgb[1] > 235 && rgb[2] > 235, `${name} 是白卡片`, p?.bg)
    const bad = await evj(`JSON.stringify(window.__probe.badText(${JSON.stringify(sel)}))`)
    check((bad || []).length === 0, `${name} 无低对比度文字`, bad)

    /* 事件信息页：结果表格的定位必须让开左上「实时数据栏」（任务2 的同类遮盖问题）。
     * 必须在循环内、仍在 /eventinfo 上时量 —— 循环末页是 /changestyle，那里压根没有 .rt-panel。
     * 表格无查询结果时是 display:none，getBoundingClientRect 全 0 量不到，
     * 所以判 computed left 是否 ≥ 实时栏右缘。 */
    if (path === '/eventinfo') {
      const geo = await evj(`JSON.stringify((()=>{
        const card = document.querySelector('.displayCard'), rt = document.querySelector('.rt-panel')
        if (!card || !rt) return null
        const left = getComputedStyle(card).left
        const rtRight = rt.getBoundingClientRect().right
        return { left, rtRight: Math.round(rtRight), cleart: parseFloat(left) >= rtRight - 1 }
      })())`)
      check(geo?.cleart === true, '事件信息结果表格让开实时数据栏', geo)
    }
  }

  const errs2 = await evj(`JSON.stringify((window.__errs||[]).slice(0,6))`)
  check((errs2 || []).length === 0, '全程无运行时错误', errs2)

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
  process.exit(fail ? 1 : 0)
}
