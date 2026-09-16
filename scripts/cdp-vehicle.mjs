// 动态车辆模拟 端到端验证：模拟引擎统计 → marker 渲染/移动 → 强制红灯停车 → 绿灯恢复
// → 迷你面板 15 行 → 控制中心第 4 块（统计 + 折线）→ 车辆点击弹窗
import { writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT || '9223' // CDP 调试端口（headless Chrome）
const BASE = `http://127.0.0.1:${process.env.APP_PORT || '5180'}` // 本机 5173 被别的项目占着，dev server 固定跑 5180
const list = await (await fetch(`http://localhost:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
const errors = []
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    pending[mid] = resolve
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    errors.push('EXCEPTION: ' + (d.exception?.description || d.text || '')?.slice(0, 300))
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 200))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (expression) =>
  send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result.value)
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  if (s.data) { writeFileSync(`logs/${name}`, Buffer.from(s.data, 'base64')); console.log('SHOT:', name) }
}
const assert = (ok, label, extra) => console.log((ok ? '✅ ' : '❌ ') + label + (extra !== undefined ? ' => ' + JSON.stringify(extra) : ''))

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push('ERR: ' + (e.error && e.error.message || e.message)))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('REJ: ' + (e.reason && e.reason.message || String(e.reason))))
    // 路由守卫读的是 sessionStorage（不是 localStorage），写错地方会停在登录页
    try { sessionStorage.setItem('zb_auth_user', JSON.stringify({ username: 'admin', display_name: '系统管理员' })) } catch (e) {}
  ` })
  await send('Page.navigate', { url: BASE + '/' })
  // 等地图 boot（首次拉取 mapbox style 可能较慢，最长 60s）
  let booted = false
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    if (await ev(`!!window.__vehicleSim`)) { booted = true; break }
  }
  assert(booted, 'S0 地图 boot 完成（__vehicleSim 挂载）')
  if (!booted) { console.log('ERRLOG:', await ev(`(window.__errs||[]).join(' | ')`)); process.exit(1) }

  // S1 引擎就绪
  const s1 = await ev(`(() => {
    const vs = window.__vehicleSim
    if (!vs) return { bridge: false }
    return {
      bridge: true,
      count: vs.vehicles.length,
      corridors: vs.corridors.length,
      stats: vs.stats(),
      sample: vs.vehicles[0] && { plate: vs.vehicles[0].plate, road: vs.vehicles[0].road, lng: vs.vehicles[0].lng, speed: vs.vehicles[0].speed }
    }
  })()`)
  assert(s1.bridge, 'S1 __vehicleSim 桥存在')
  assert(s1.count === 15, 'S1 车辆数=15', s1.count)
  assert(s1.corridors >= 8, 'S1 走廊数≥8', s1.corridors)
  assert(s1.stats && s1.stats.total === 15, 'S1 stats.total=15', s1.stats)
  console.log('  首车样本:', JSON.stringify(s1.sample))
  assert(!!s1.sample && s1.sample.road, 'S1 车辆已就位于道路', s1.sample?.road)

  // S2 统计随时间变化（引擎在跑）
  await sleep(1100)
  const s2 = await ev(`window.__vehicleSim.stats()`)
  assert(s2.avgSpeed > 0 && s2.running + s2.waiting === 15, 'S2 统计推进 (avgSpeed>0, running+waiting=15)', { avgSpeed: s2.avgSpeed, running: s2.running, waiting: s2.waiting, congested: s2.onCongested })

  // S3 开图层 → marker 渲染且移动
  await ev(`window.__vehicleSim.setVisible(true)`)
  await sleep(900)
  const s3a = await ev(`(() => {
    const mks = document.querySelectorAll('.vehicle-marker')
    const v0 = window.__vehicleSim.vehicles[0]
    return { markers: mks.length, hasRotate: mks.length ? !!mks[0].querySelector('.vm-inner').style.transform : false, lng: v0.lng, lat: v0.lat }
  })()`)
  assert(s3a.markers === 15, 'S3 地图出现 15 个 vehicle-marker', s3a.markers)
  await sleep(1200)
  const s3b = await ev(`(() => {
    const v0 = window.__vehicleSim.vehicles[0]
    return { lng: v0.lng, lat: v0.lat, speed: v0.speed }
  })()`)
  const moved = Math.abs(s3a.lng - s3b.lng) > 0 || Math.abs(s3a.lat - s3b.lat) > 0
  assert(moved, 'S3 车辆坐标随时间变化(移动中)', `Δ(${(s3b.lng - s3a.lng).toFixed(6)}, ${(s3b.lat - s3a.lat).toFixed(6)})`)
  assert(s3a.hasRotate, 'S3 内层元素带 rotate transform', s3a.hasRotate)

  // S4 红灯联动：找一辆正逼近信号灯的车（前方 20~70m 未进停止区），
  // 强制其灯变红 → 应减速停成 waiting；变绿 → 恢复 running。找不到就先等几秒再试
  const s4 = await ev(`(async () => {
    const vs = window.__vehicleSim
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    let pick = null
    for (let i = 0; i < 10 && !pick; i++) {
      if (i) await wait(1500)
      pick = vs.vehicles.find((v) => v.lightId !== '' && v.lightDist > 18 && v.lightDist < 70) || null
    }
    if (!pick) return { found: false }
    const id = pick.id
    vs.forceLight(id, 'red')
    await wait(6500)
    const red = vs.vehicles[id]
    const redState = { state: red.state, speed: red.speed, light: red.lightColor, dist: red.lightDist }
    vs.forceLight(id, 'green')
    await wait(2500)
    const green = vs.vehicles[id]
    return { found: true, id, road: pick.road, red: redState, greenState: green.state, greenSpeed: green.speed, waitingTotal: vs.stats().waiting }
  })()`)
  assert(s4.found, 'S4 找到前方有灯的车可测联动', s4.id)
  if (s4.found) {
    assert(s4.red.state === 'waiting', 'S4 红灯 → 车辆停车 waiting', s4.red)
    assert(s4.greenState === 'running' && s4.greenSpeed > 0.4, 'S4 绿灯 → 恢复行驶', { state: s4.greenState, speed: s4.greenSpeed })
  }

  // S5 迷你面板 15 行 + 汇总
  const s5 = await ev(`(() => {
    const panel = document.querySelector('.vp-panel')
    if (!panel) return { panel: false }
    const rows = [...panel.querySelectorAll('.vp-row')]
    return {
      panel: true,
      rows: rows.length,
      plates: rows.slice(0, 3).map((r) => r.querySelector('.vp-plate').textContent),
      statsText: panel.querySelector('.vp-stat').textContent.replace(/\\s+/g, ' ')
    }
  })()`)
  assert(s5.panel, 'S5 动态车辆面板显示(v-show=图层开)')
  assert(s5.rows === 15, 'S5 面板 15 行', s5.rows)
  assert(s5.plates && s5.plates[0].includes('鲁C·'), 'S5 车牌格式鲁C·', s5.plates)
  console.log('  面板汇总:', s5.statsText)

  // S6 关闭图层 → marker 隐藏、面板隐藏；再开恢复
  await ev(`window.__vehicleSim.setVisible(false)`)
  await sleep(300)
  const s6 = await ev(`(() => {
    const panel = document.querySelector('.vp-panel')
    const m = [...document.querySelectorAll('.vehicle-marker')].filter((x) => x.style.display !== 'none').length
    return { m, p: !!panel && getComputedStyle(panel).display !== 'none' }
  })()`)
  assert(s6.m === 0 && s6.p === false, 'S6 关图层 → marker 隐藏且面板隐藏', s6)
  await ev(`window.__vehicleSim.setVisible(true)`)
  await sleep(400)

  // S7 控制中心第 4 块：点「控制中心」按钮 → 动态车辆·信号灯联动 统计块 + LineChart canvas
  await ev(`(() => {
    const items = [...document.querySelectorAll('.btn-groups .item')]
    const b = items.find((x) => x.textContent.includes('控制中心'))
    if (b) b.click()
    return !!b
  })()`)
  await sleep(1600)
  const s7 = await ev(`(() => {
    const block = [...document.querySelectorAll('.g2-chart')].find((x) => x.textContent.includes('动态车辆·信号灯联动'))
    if (!block) return { block: false, blocks: [...document.querySelectorAll('.people-sum')].map((x) => x.textContent) }
    return {
      block: true,
      hosp4: block.querySelectorAll('.hosp4 .it').length,
      lineCanvas: !!block.querySelector('canvas'),
      text: block.textContent.replace(/\\s+/g, ' ').slice(0, 120)
    }
  })()`)
  assert(s7.block, 'S7 控制中心出现「动态车辆·信号灯联动」块', s7.blocks || 'ok')
  if (s7.block) {
    assert(s7.hosp4 === 4, 'S7 4 项统计卡', s7.hosp4)
    assert(s7.lineCanvas, 'S7 均速折线 canvas 渲染', s7.lineCanvas)
    console.log('  块文本:', s7.text)
  }
  await shot('vehicle-control.png')

  // S8 点击地图车辆 → popup 内容
  const s8 = await ev(`(async () => {
    const mk = document.querySelector('.vehicle-marker')
    if (!mk) return { marker: false }
    mk.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 500))
    const pop = document.querySelector('.mapboxgl-popup-content')
    return { marker: true, popup: !!pop, text: pop ? pop.textContent.replace(/\\s+/g, ' ').slice(0, 90) : '' }
  })()`)
  assert(s8.marker && s8.popup, 'S8 点击车辆弹出 popup', s8.text || 'no popup')
  await shot('vehicle-popup.png')

  const errs = await ev(`window.__errs || []`)
  const all = [...(errs || []), ...errors]
  assert(all.length === 0, '无运行时错误', all.slice(0, 5).join(' || ') || 'none')
  console.log(all.length ? 'ERRORS:' + all.slice(0, 6).join('\n') : 'ERRORS: none')
  process.exit(0)
}
