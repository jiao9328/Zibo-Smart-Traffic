/* 任务1 验证：城市视角 + 地球自转
 *
 * 覆盖三类场景：
 *   S1 首页点按钮 SPA 跳转（原 CityView 的 map 未赋值必然报错）
 *   S2 直接输网址 / 直接刷新（原 Rotation 的 map 为 null 竞态）
 *   S3 自转的自愈能力（原 moveend→easeTo 链被掐断后永久停摆）
 *
 * 前置：pnpm dev 在 :5173；Chrome 以 --remote-debugging-port=9222 启动
 * 用法：node scripts/cdp-probe6.mjs
 */
/* 默认 5180：本机 5173 被另一个项目的 vite（绑定 0.0.0.0）占用，
 * 会导致 localhost:5173 解析到 ::1 时打到别人的服务上。用独立端口 + 显式 127.0.0.1 避免歧义。
 * 覆盖：PORT=xxxx node scripts/cdp-probe6.mjs */
const PORT = process.env.PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const CDP = process.env.CDP_PORT || '9223'

/* Chrome 必须跑在 headless 模式下，且这不是「随便选的」：
 * mapbox-gl 的渲染循环挂在 requestAnimationFrame 上。页面处于 hidden 状态时
 * Chrome 会**完全停掉 rAF**（实测 3 秒 0 帧，setTimeout 也被降频到 ~1/10），
 * 于是 map 永远不渲染 → 不发瓦片请求 → loaded() 恒为 false → 'load' 事件不触发
 * → App.vue 的 boot() 不执行 → loadMap 恒 false、window.__map 恒 undefined。
 * 症状是 waitBoot() 一直等不到 .btn-groups，看起来像前端挂了，其实是环境问题。
 * 有窗口的 `cmd /c start chrome` 如果窗口没真正显示出来同样是 hidden，故一律用 headless。 */
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

/** 相机快照 */
const cam = () =>
  ev(`JSON.stringify({
    p: location.pathname,
    lng: +window.__map.getCenter().lng.toFixed(3),
    lat: +window.__map.getCenter().lat.toFixed(3),
    z: +window.__map.getZoom().toFixed(2),
    pitch: +window.__map.getPitch().toFixed(0),
    errs: (window.__errs || []).slice(-3)
  })`).then((s) => (typeof s === 'string' && s[0] === '{' ? JSON.parse(s) : s))

/** 真实鼠标点击底部工具条按钮 */
const click = async (label) => {
  const b = await ev(
    `(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes('${label}')); if(!it) return null; const r=it.querySelector('button').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`
  )
  if (!b || typeof b !== 'object') return 'no-btn'
  const p = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
  return 'ok'
}

/** 等底部工具条渲染出来（loadMap=true 才会挂载） */
const waitBoot = async (max = 90) => {
  for (let i = 0; i < max; i++) {
    if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) return true
    await sleep(1000)
  }
  // 等不到就把现场打出来，省得再手写一遍诊断脚本
  const diag = await ev(`JSON.stringify({
    vis: document.visibilityState,
    mapKids: [...(document.getElementById('map')||{children:[]}).children].map(c=>c.className).filter(Boolean),
    btns: document.querySelectorAll('.btn-groups .item').length,
    hasMap: typeof window.__map, hasScene: typeof window.__scene,
    errs: (window.__errs||[]).slice(0,3)
  })`)
  console.log('  ⚠️ waitBoot 超时，现场：', diag)
  return false
}

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  // 注入登录态 + 错误收集（守卫读 sessionStorage）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })

  /* 先验环境：hidden 页面下 rAF 停摆，mapbox 永远不 load，后面几十秒的等待全是白等。
   * 提前 1 秒判掉，避免把环境问题误诊成前端 bug。 */
  const vis = await ev(`document.visibilityState`)
  const fps = await ev(`new Promise(r=>{const t0=performance.now();let n=0;
    const f=()=>{n++; performance.now()-t0<1000 ? requestAnimationFrame(f) : r(n)};
    requestAnimationFrame(f); setTimeout(()=>r(n),1600)})`)
  if (vis !== 'visible' || !fps) {
    console.log(`\n环境不合格：visibilityState=${vis}, 1秒内 rAF 帧数=${fps}`)
    console.log('mapbox 渲染循环依赖 rAF，页面 hidden 时地图永远不会 load。')
    console.log('请用 headless 模式启动 Chrome（见本文件顶部注释），再重跑本脚本。')
    process.exit(1)
  }

  /* ================= S0 首页基线 ================= */
  await send('Page.navigate', { url: BASE + '/' })
  const boot = await waitBoot()
  console.log('\n=== S0 首页 ===')
  check(boot, '底部工具条就绪')
  const base = await cam()
  check(base.z === 9.5, '初始 zoom=9.5', { z: base.z })

  /* ================= S1 城市视角（SPA 跳转） ================= */
  console.log('\n=== S1 城市视角（从首页点按钮） ===')
  await click('城市视角')
  await sleep(4000) // flyTo duration 2500
  const city = await cam()
  check(city.p === '/cityview', '路由到 /cityview', { p: city.p })
  check(city.z === 12, 'zoom=12', { z: city.z })
  check(city.pitch === 70, 'pitch=70（依赖 maxPitch:85，否则会被夹到 60）', { pitch: city.pitch })
  check(Math.abs(city.lng - 118.05) < 0.01 && Math.abs(city.lat - 36.81) < 0.01, '居中到淄博 118.05,36.81', {
    lng: city.lng,
    lat: city.lat
  })
  check(city.errs.length === 0, '无运行时错误', city.errs)

  /* ================= S2 地球自转 ================= */
  console.log('\n=== S2 地球自转（从城市视角点按钮） ===')
  await click('首页')
  await sleep(2800)
  await click('地球自转')
  await sleep(2500) // 入镜 ease 800ms + 起转
  const rotA = await cam()
  check(rotA.p === '/rotation', '路由到 /rotation', { p: rotA.p })
  check(Math.abs(rotA.z - 1.2) < 0.05, 'zoom≈1.2（世界尺度）', { z: rotA.z })
  check(rotA.pitch === 0, 'pitch=0', { pitch: rotA.pitch })
  check(rotA.errs.length === 0, '无运行时错误', rotA.errs)

  // 采样：Δlng 应 ≈ -6°/s × 3s = -18°
  const a = rotA.lng
  await sleep(3000)
  const b = (await cam()).lng
  const d = +(b - a).toFixed(3)
  check(d < -10 && d > -26, '持续自转：Δlng≈-18°/3s（6°/s）', { from: a, to: b, d })

  /* ================= S3 反脆弱：打断后应自愈 ================= */
  console.log('\n=== S3 自愈：jumpTo + dragstart 打断后仍续转 ===')
  await ev(`void window.__map.jumpTo({ center: [118, 36], zoom: 1.2 })`)
  await ev(`void window.__map.fire('dragstart')`)
  await sleep(2000) // 等过 RESUME_MS(800)
  const c1 = (await cam()).lng
  await sleep(2500)
  const c2 = (await cam()).lng
  const d2 = +(c2 - c1).toFixed(3)
  check(d2 < -8, '打断后自愈并继续自转', { c1, c2, d: d2 })

  /* ================= S4 直接刷新 / 直接输网址（竞态） ================= */
  console.log('\n=== S4 直接打开 /rotation（原 null 竞态） ===')
  await send('Page.navigate', { url: BASE + '/rotation' })
  const boot2 = await waitBoot()
  check(boot2, '直接打开 /rotation 后工具条就绪')
  await sleep(2500)
  const direct = await cam()
  check(direct.errs.length === 0, '直接打开无运行时错误', direct.errs)
  check(Math.abs(direct.z - 1.2) < 0.05, '直接打开也会拉到 zoom≈1.2', { z: direct.z })
  const d1 = direct.lng
  await sleep(2500)
  const d2b = (await cam()).lng
  check(+(d2b - d1).toFixed(3) < -8, '直接打开也在持续自转', { from: d1, to: d2b, d: +(d2b - d1).toFixed(3) })

  /* ================= S5 直接打开 /cityview ================= */
  console.log('\n=== S5 直接打开 /cityview ===')
  await send('Page.navigate', { url: BASE + '/cityview' })
  await waitBoot()
  await sleep(4000)
  const directCity = await cam()
  check(directCity.errs.length === 0, '直接打开 /cityview 无运行时错误', directCity.errs)
  check(directCity.pitch === 70 && directCity.z === 12, '直接打开也压到 zoom12/pitch70', {
    z: directCity.z,
    pitch: directCity.pitch
  })

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
  process.exit(fail ? 1 : 0)
}
