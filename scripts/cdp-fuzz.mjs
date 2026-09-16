// 随机序列真实点击底部栏：把"本应有效果却完全没反应"的点击揪出来
const PORT = process.env.PORT || '5173'
const BASE = `http://localhost:${PORT}`
const list = await (await fetch('http://localhost:9222/json')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
function send(m, p = {}) { return new Promise((r) => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })) }) }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value)

const clickAt = async (x, y) => {
  const p = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
}
const snapshot = `(() => ({
  path: location.pathname + location.search,
  charts: !!document.querySelector('.g2-left'),
  data: !!document.querySelector('.dm-panel'),
  pop: !!document.querySelector('.popover-w'),
  on: [...document.querySelectorAll('.btn-groups .item.on p')].map(p=>p.textContent.trim()).join(','),
  c: window.__map ? [+window.__map.getCenter().lng.toFixed(3), +window.__map.getCenter().lat.toFixed(3), +window.__map.getZoom().toFixed(2)] : null,
  errs: (window.__errs||[]).slice(-2)
}))()`

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  await send('Page.navigate', { url: BASE + '/' })
  await sleep(4000)
  for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.btn-groups .item').length >= 10`)) break; await sleep(500) }
  await sleep(3000)

  const names = ['首页', '地球自转', '城市视角', '控制中心', '数据管理', '地图测量', '拉框查询', '区域搜索', '导航', '切换风格']
  const seq = [2, 0, 3, 6, 0, 2, 8, 1, 0, 7, 2, 5, 9, 0, 4, 2, 6, 3, 2, 1, 0, 2, 7, 8, 2, 0]
  for (const i of seq) {
    const box = await ev(`(() => { const it = document.querySelectorAll('.btn-groups .item')[${i}]; if (!it) return null; const b = it.querySelector('button').getBoundingClientRect(); return { x: b.left+b.width/2, y: b.top+b.height/2 } })()`)
    if (!box) { console.log(`[#${i} ${names[i]}] 底部栏不存在`); continue }
    const before = await ev(snapshot)
    await clickAt(box.x, box.y)
    await sleep(1600)
    const after = await ev(snapshot)
    const routeChanged = before.path !== after.path
    const anyChanged = routeChanged || before.charts !== after.charts || before.data !== after.data || before.pop !== after.pop || before.on !== after.on || JSON.stringify(before.c) !== JSON.stringify(after.c)
    const dup = !routeChanged && before.path === after.path
    const tag = anyChanged ? 'OK   ' : (dup ? 'DUP  ' : 'DEAD ')
    console.log(`${tag} [#${i} ${names[i].padEnd(4)}] ${before.path} -> ${after.path} c=${JSON.stringify(after.c)} ${after.errs.length ? 'ERR:'+after.errs.join('|') : ''}`)
  }
  process.exit(0)
}
