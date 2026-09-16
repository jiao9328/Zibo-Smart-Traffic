// 临时排查脚本：用真实鼠标事件点底部功能栏，看每次点击后路由/DOM 是否响应
const PORT = process.env.PORT || '5173'
const BASE = `http://localhost:${PORT}`
const list = await (await fetch('http://localhost:9222/json')).json()
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    pending[mid] = resolve
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (expression) =>
  send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value)

// 真实鼠标点击底部第 i 个按钮
const realClick = async (i) => {
  const box = await ev(`(() => {
    const it = document.querySelectorAll('.btn-groups .item')[${i}]
    if (!it) return null
    const b = it.querySelector('button').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, label: it.querySelector('p').textContent.trim() }
  })()`)
  if (!box) return { label: '?', ok: false, why: 'no-item' }
  const p = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
  return box
}

// 等待底部栏出现（地图 style 加载完才挂载）
const waitFooter = async (max = 30000) => {
  for (let i = 0; i < max / 500; i++) {
    const n = await ev(`document.querySelectorAll('.btn-groups .item').length`)
    if (n >= 10) return true
    await sleep(500)
  }
  return false
}
const state = `(() => ({
  path: location.pathname + location.search,
  charts: !!document.querySelector('.g2-left'),
  data: !!document.querySelector('.dm-panel'),
  on: [...document.querySelectorAll('.btn-groups .item.on p')].map(p => p.textContent.trim()).join(','),
  pop: !!document.querySelector('.popover-w'),
  errs: (window.__errs || []).slice(-3)
}))()`

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      try { sessionStorage.setItem('zb_auth_user', JSON.stringify({ username: 'probe', display_name: '探针' })) } catch(e) {}
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push('ERR ' + (e.error?.message || e.message)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('REJ ' + (e.reason?.message || String(e.reason))))
    `
  })

  const routes = ['/', '/eventinfo', '/navigation', '/changestyle', '/areasearch']
  const names = ['首页', '地球自转', '城市视角', '控制中心', '数据管理', '地图测量', '拉框查询', '区域搜索', '导航', '切换风格']
  for (const r of routes) {
    await send('Page.navigate', { url: BASE + r })
    await sleep(2500)
    if (!(await waitFooter())) { console.log(`\n### 起点 ${r} -> 底部栏一直没挂载（地图未 load）`); continue }
    console.log(`\n### 起点 ${r}`)
    for (let i = 0; i < 10; i++) {
      const before = await ev(state)
      const info = await realClick(i)
      await sleep(1100)
      const after = await ev(state)
      const changed = before.path !== after.path || before.charts !== after.charts || before.data !== after.data || before.pop !== after.pop || before.on !== after.on
      console.log(`  ${changed ? 'OK   ' : 'NO-OP'} [#${i} ${names[i]}] ${before.path} -> ${after.path} ${after.on ? 'on=' + after.on : ''} ${after.errs?.length ? 'ERR:' + after.errs.join('|') : ''}`)
      // 每次点完若跳走了，回到起点重来，保证每格独立
      if (after.path !== r) { await send('Page.navigate', { url: BASE + r }); await sleep(2500); if (!(await waitFooter())) break }
    }
  }
  process.exit(0)
}
