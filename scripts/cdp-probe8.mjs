/* 任务3 验证：车辆列表 ↔ 地图车辆 双向对应
 *
 * 覆盖的原始缺陷：
 *   - VehiclePanel 的 .vp-row 完全没有点击/悬停处理器，点列表毫无反应
 *   - 15 辆车全是同一个 🚗 emoji，长得一模一样，认不出是哪辆
 *   - markers 以 plate 为 key，外部只能靠车牌反查
 *
 * 前置：pnpm dev --port 5180 --strictPort
 *       Chrome 必须 headless 启动（原因见 cdp-probe6.mjs 顶部注释）
 * 用法：node scripts/cdp-probe8.mjs
 */
const PORT = process.env.PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const CDP = process.env.CDP_PORT || '9223'

const list = await (await fetch(`http://localhost:${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.log(`NO PAGE TARGET — Chrome 未以 --remote-debugging-port=${CDP} 启动？`)
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => {
    const mid = ++id
    pending[mid] = r
    ws.send(JSON.stringify({ id: mid, method: m, params: p }))
  })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    pending[m.id](m.result)
    delete pending[m.id]
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r && r.result ? r.result.value : '<<' + (r?.exceptionDetails?.exception?.description || 'no-result') + '>>'
  )
/* Runtime.evaluate 返回的字符串可能是 JSON 对象或数组，两种都要还原。
 * （只判 '{' 的话数组会原样留下，后面做 .every/.length 断言就会莫名其妙地挂） */
const evj = (x) =>
  ev(x).then((s) => {
    if (typeof s !== 'string') return s
    const c = s[0]
    if (c !== '{' && c !== '[') return s
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  })

let pass = 0
let fail = 0
const check = (ok, label, detail) => {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}`, detail !== undefined ? JSON.stringify(detail) : '')
  } else {
    fail++
    console.log(`  ❌ ${label}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

/** 真实鼠标点击某个矩形中心 */
const clickAt = async (x, y) => {
  const p = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
}

/** 把鼠标真实移到某个元素中心（触发 mouseenter） */
const hoverEl = async (sel) => {
  const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if(!el) return null; const b = el.getBoundingClientRect();
    return JSON.stringify({x: b.left + b.width/2, y: b.top + b.height/2}) })()`)
  if (typeof r !== 'string' || r[0] !== '{') return false
  const p = JSON.parse(r)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  await sleep(250)
  return true
}

/** 点某一行列表项 */
const clickRow = async (no) => {
  const r = await ev(`(() => { const el = document.querySelector('#vp-row-' + ${no - 1});
    if(!el) return null; const b = el.getBoundingClientRect();
    return JSON.stringify({x: b.left + b.width/2, y: b.top + b.height/2}) })()`)
  if (typeof r !== 'string' || r[0] !== '{') return false
  const p = JSON.parse(r)
  await clickAt(p.x, p.y)
  return true
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
    console.log(`\n环境不合格：visibilityState=${vis}, 1秒内 rAF 帧数=${fps}`)
    console.log('mapbox 渲染循环依赖 rAF，页面 hidden 时地图永远不会 load。请用 headless 模式启动 Chrome。')
    process.exit(1)
  }

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  })
  await send('Page.navigate', { url: BASE + '/' })

  let booted = false
  for (let i = 0; i < 90; i++) {
    if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) { booted = true; break }
    await sleep(1000)
  }
  if (!booted) {
    console.log('\n底部工具条始终没出现，先排查地图 boot（见 cdp-probe6.mjs）')
    process.exit(1)
  }

  /* ============ S1 打开「动态车辆」图层：编号徽标唯一且与列表一致 ============ */
  console.log('\n=== S1 开图层：地图徽标 ↔ 列表徽标 ===')
  const toggled = await ev(`(() => {
    const it = [...document.querySelectorAll('.rt-item')].find(e => e.textContent.includes('动态车辆'));
    if (!it) return 'no-item';
    it.click(); return 'ok';
  })()`)
  check(toggled === 'ok', '实时数据栏里点开「动态车辆」', toggled)
  await sleep(2000)

  const badges = await evj(`JSON.stringify({
    map: window.__vehicleSim.badgeNos(),
    list: [...document.querySelectorAll('.vp-badge')].map(b => b.textContent)
  })`)
  check(Array.isArray(badges?.map) && badges.map.length === 15, '地图上 15 个车辆 marker', {
    n: badges?.map?.length
  })
  check(new Set(badges?.map || []).size === 15, '15 个编号互不重复', {
    uniq: new Set(badges?.map || []).size
  })
  check(
    JSON.stringify(badges?.map) === JSON.stringify(badges?.list),
    '地图徽标编号序列 == 列表徽标编号序列（同源）',
    { map: badges?.map, list: badges?.list }
  )

  // 每个 marker 都有专属色，且颜色两两不同
  const colors = await evj(`JSON.stringify(
    [...document.querySelectorAll('.vehicle-marker')].map(m => m.style.getPropertyValue('--vm-color'))
  )`)
  check(new Set(colors || []).size === 15, '15 辆车 15 种专属色', { uniq: new Set(colors || []).size })
  check((colors || []).every((c) => /^#[0-9a-fA-F]{6}$/.test(c)), '专属色都是合法色值', colors?.[0])
  // 车身用 currentColor 上色，必须真的渲染出颜色（不是黑/透明）
  const fillColor = await ev(
    `getComputedStyle(document.querySelector('.vehicle-marker .vm-inner svg')).color`
  )
  check(
    typeof fillColor === 'string' && fillColor !== 'rgb(0, 0, 0)' && fillColor !== 'rgba(0, 0, 0, 0)',
    '车身 SVG 取到专属色（currentColor 生效）',
    fillColor
  )

  /* ============ S2 点列表第 3 行 → 地图上第 3 辆高亮 + 气泡 + 定位 ============ */
  console.log('\n=== S2 点列表第 3 行 ===')
  const ok3 = await clickRow(3)
  check(ok3, '找到并点击 #vp-row-2（第 3 行）')
  await sleep(2200) // flyTo 1200ms

  const s2 = await evj(`JSON.stringify({
    selected: window.__vehicleSim.selected(),
    rowFocus: (document.querySelector('#vp-row-2')||{}).className,
    marker: window.__vehicleSim.markerClass(3),
    popupNo: (document.querySelector('.mapboxgl-popup .vm-popup-no')||{}).textContent || null,
    popupOpen: !!document.querySelector('.mapboxgl-popup'),
    zoom: +window.__map.getZoom().toFixed(2),
    errs: (window.__errs||[]).slice(0,3)
  })`)
  check(s2?.selected === 2, 'store.selectedVehicleId = 2（第 3 辆）', s2?.selected)
  check(/focus/.test(s2?.rowFocus || ''), '列表第 3 行进入 focus 态', s2?.rowFocus)
  check(/vm-focus/.test(s2?.marker || ''), '地图第 3 辆车 marker 加 vm-focus', s2?.marker)
  check(s2?.popupOpen === true, '地图上弹出详情气泡', s2?.popupOpen)
  check(s2?.popupNo === '3', '气泡里的编号是 3（与列表行一致）', s2?.popupNo)
  check((s2?.zoom || 0) >= 14, '相机定位到车辆（zoom≥14）', s2?.zoom)
  check((s2?.errs || []).length === 0, '无运行时错误', s2?.errs)

  /* ============ S3 高亮必须扛过 tick（每 300ms 一次类名刷新） ============ */
  console.log('\n=== S3 高亮稳定性（等 1.5s ≈ 5 个 tick）===')
  await sleep(1500)
  const s3 = await evj(`JSON.stringify({
    marker: window.__vehicleSim.markerClass(3),
    rowFocus: (document.querySelector('#vp-row-2')||{}).className,
    selected: window.__vehicleSim.selected()
  })`)
  check(/vm-focus/.test(s3?.marker || ''), '1.5s 后 marker 仍是 vm-focus（未被 tick 冲掉）', s3?.marker)
  check(/focus/.test(s3?.rowFocus || ''), '1.5s 后列表行仍是 focus', s3?.rowFocus)
  check(s3?.selected === 2, '1.5s 后选中态未丢', s3?.selected)

  /* ============ S4 悬停列表行 → 对应 marker 高亮（双向之一） ============ */
  console.log('\n=== S4 悬停第 11 行 → 第 11 辆车高亮 ===')
  const okH = await hoverEl('#vp-row-10')
  check(okH, '悬停 #vp-row-10')
  await sleep(300)
  const s4 = await evj(`JSON.stringify({
    hovered: window.__vehicleSim.hovered(),
    marker11: window.__vehicleSim.markerClass(11),
    row10: (document.querySelector('#vp-row-10')||{}).className
  })`)
  check(s4?.hovered === 10, 'store.hoveredVehicleId = 10', s4?.hovered)
  check(/vm-hover/.test(s4?.marker11 || ''), '地图第 11 辆车 marker 加 vm-hover', s4?.marker11)
  check(/hover/.test(s4?.row10 || ''), '列表行自身也是 hover 态', s4?.row10)

  /* ============ S5 点地图 marker → 列表行高亮（双向之二） ============ */
  /* 先决条件：S2 的 flyTo 已经把相机锁在第 3 辆车上（zoom 15），此时第 11 辆车的
   * marker 在 (5107,4744) —— 视口只有 1440×900，它在屏幕外几公里。
   * 对屏幕外的坐标派发鼠标事件，事件会落在视口边缘的无关元素上，测试必然假失败。
   * 所以先把目标车挪到画面正中，并用 elementFromPoint 确认它真的没被别的 marker 压住。 */
  const bringIntoView = async (no) => {
    const ll = await ev(`JSON.stringify((()=>{const v=window.__vehicleSim.vehicles[${no - 1}];
      return {lng:v.lng, lat:v.lat}})())`)
    if (typeof ll !== 'string' || ll[0] !== '{') return { ok: false, why: 'no-vehicle', raw: ll }
    const c = JSON.parse(ll)
    let last = null
    // 逐级放大：低 zoom 下别的车可能压在同一像素上，放大了自然散开
    for (const z of [11, 13, 15]) {
      // 用 jumpTo 而非 flyTo：动画中的相机会干扰后续断言，jumpTo 一帧到位
      await ev(`window.__map.jumpTo({ center: [${c.lng}, ${c.lat}], zoom: ${z} })`)
      await sleep(500)
      const r = await evj(`JSON.stringify((()=>{
        const el = document.querySelector('.vehicle-marker[data-car-id="${no - 1}"]')
        if (!el) return { ok:false, why:'no-marker' }
        const b = el.getBoundingClientRect()
        const x = b.left + b.width/2, y = b.top + b.height/2
        if (x < 4 || y < 4 || x > innerWidth - 4 || y > innerHeight - 4)
          return { ok:false, why:'offscreen', x:Math.round(x), y:Math.round(y) }
        const hit = document.elementFromPoint(x, y)
        const owner = hit && hit.closest ? hit.closest('.vehicle-marker') : null
        const mine = !!(owner && owner.dataset.carId === '${no - 1}')
        return { ok: mine, x: Math.round(x), y: Math.round(y)
          , at: owner ? 'car-' + owner.dataset.carId : (hit ? String(hit.className || hit.tagName) : 'nothing') }
      })())`)
      last = { ...r, zoom: z }
      if (r && r.ok) return last
    }
    return last
  }

  console.log('\n=== S5 点地图上的 marker 11 ===')
  const v11 = await bringIntoView(11)
  check(!!v11?.ok, '第 11 辆车 marker 已进入视口且可点（未被遮挡）', v11)
  if (v11?.ok) {
    await clickAt(v11.x, v11.y)
    await sleep(900)
    const s5 = await evj(`JSON.stringify({
      selected: window.__vehicleSim.selected(),
      marker11: window.__vehicleSim.markerClass(11),
      row10: (document.querySelector('#vp-row-10')||{}).className,
      popupNo: (document.querySelector('.mapboxgl-popup .vm-popup-no')||{}).textContent || null,
      errs: (window.__errs||[]).slice(0,3)
    })`)
    check(s5?.selected === 10, '点 marker → 选中的是第 11 辆', s5?.selected)
    check(/vm-focus/.test(s5?.marker11 || ''), 'marker 进入 vm-focus', s5?.marker11)
    check(/focus/.test(s5?.row10 || ''), '列表第 11 行反向高亮', s5?.row10)
    check(s5?.popupNo === '11', '气泡编号为 11', s5?.popupNo)
    check((s5?.errs || []).length === 0, '无运行时错误', s5?.errs)
  }

  /* ============ S5b 点靠后的车 → 列表必须把它滚进可视带 ============ */
  /* 第 11 行本来就在 .vp-list 的可视范围内，看不出 scrollIntoView 有没有生效；
   * 第 15 行（id 14）在 15 行列表里位于折叠线以下，才真正验证得到。 */
  console.log('\n=== S5b 点地图 marker 15 → 第 15 行滚入视野 ===')
  const v15 = await bringIntoView(15)
  check(!!v15?.ok, '第 15 辆车 marker 已进入视口且可点', v15)
  if (v15?.ok) {
    // 先手动把列表滚到顶部，制造「目标行在折叠线以下」的初始状态
    await ev(`(()=>{const l=document.querySelector('.vp-list'); if(l) l.scrollTop = 0})()`)
    await sleep(200)
    const before = await evj(`JSON.stringify((()=>{
      const row = document.querySelector('#vp-row-14'), list = document.querySelector('.vp-list')
      return { scrollTop: Math.round(list.scrollTop), listH: Math.round(list.clientHeight),
        rowBottom: Math.round(row.getBoundingClientRect().bottom - list.getBoundingClientRect().top) }
    })())`)
    check(
      (before?.rowBottom || 0) > (before?.listH || 0),
      '前置：第 15 行初始在可视带之下（否则本用例无意义）',
      before
    )

    await clickAt(v15.x, v15.y)
    await sleep(1400) // scrollIntoView behavior:'smooth' 要跑一会儿
    const s5b = await evj(`JSON.stringify((()=>{
      const row = document.querySelector('#vp-row-14'), list = document.querySelector('.vp-list')
      const rb = row.getBoundingClientRect(), lb = list.getBoundingClientRect()
      return { selected: window.__vehicleSim.selected()
        , row14: row.className
        , scrolled: Math.round(list.scrollTop)
        , inside: rb.top >= lb.top - 1 && rb.bottom <= lb.bottom + 1
        , popupNo: (document.querySelector('.mapboxgl-popup .vm-popup-no')||{}).textContent || null }
    })())`)
    check(s5b?.selected === 14, '点 marker 15 → 选中第 15 辆', s5b?.selected)
    check(/focus/.test(s5b?.row14 || ''), '列表第 15 行反向高亮', s5b?.row14)
    check((s5b?.scrolled || 0) > (before?.scrollTop || 0), '列表已自动滚动', { from: before?.scrollTop, to: s5b?.scrolled })
    check(s5b?.inside === true, '第 15 行完全落在列表可视带内（真的滚进视野了）', s5b)
    check(s5b?.popupNo === '15', '气泡编号为 15', s5b?.popupNo)
  }

  /* ============ S6 图层关开往返后，高亮应当恢复 ============ */
  console.log('\n=== S6 图层关开往返 ===')
  await ev(`window.__vehicleSim.setVisible(false)`)
  await sleep(500)
  const off = await ev(`document.querySelectorAll('.vehicle-marker').length`)
  check(off === 15, '关闭后 marker 只是隐藏（不销毁）', { n: off })
  await ev(`window.__vehicleSim.setVisible(true)`)
  await sleep(800)
  const s6 = await evj(`JSON.stringify({
    marker15: window.__vehicleSim.markerClass(15),
    selected: window.__vehicleSim.selected(),
    n: document.querySelectorAll('.vehicle-marker').length
  })`)
  check(s6?.n === 15, '重开后仍是 15 辆车', { n: s6?.n })
  check(/vm-focus/.test(s6?.marker15 || ''), '重开后第 15 辆仍是 vm-focus（高亮恢复）', s6?.marker15)
  check(s6?.selected === 14, '选中态跨开关保留', s6?.selected)

  /* ============ S7 清除选中 ============ */
  console.log('\n=== S7 清除选中 ===')
  await ev(`window.__vehicleSim.clearSelection()`)
  await sleep(500)
  const s7 = await evj(`JSON.stringify({
    selected: window.__vehicleSim.selected(),
    marker15: window.__vehicleSim.markerClass(15),
    popupOpen: !!document.querySelector('.mapboxgl-popup')
  })`)
  check(s7?.selected === null, '选中已清除', s7?.selected)
  check(!/vm-focus/.test(s7?.marker15 || ''), 'marker 去掉 vm-focus', s7?.marker15)
  check(s7?.popupOpen === false, '气泡已关闭', s7?.popupOpen)

  /* ============ S8 地图车辆的编号/颜色是各车独立且稳定的 ============ */
  console.log('\n=== S8 颜色与编号的稳定性 ===')
  const stab = await evj(`JSON.stringify({
    a: window.__vehicleSim.carColor(0) + window.__vehicleSim.carColor(14),
    n: window.__vehicleSim.carNo(window.__vehicleSim.vehicles[0]) + '/' +
       window.__vehicleSim.carNo(window.__vehicleSim.vehicles[14])
  })`)
  check(stab?.n === '1/15', '编号 1..15 且对用户可见', stab?.n)
  check(typeof stab?.a === 'string' && stab.a.length === 14, '颜色函数对首尾车辆都返回色值', stab?.a)

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
  process.exit(fail ? 1 : 0)
}
