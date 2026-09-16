// 定点排查：1) 地图测量 popover 是否打得开 2) 城市视角为何无反应
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
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
}

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })

  await send('Page.navigate', { url: BASE + '/' })
  await sleep(12000)

  /* ---- 1. 地图测量 popover ---- */
  const box = await ev(`(() => {
    const it = [...document.querySelectorAll('.btn-groups .item')].find(i => i.textContent.includes('地图测量'))
    const b = it.querySelector('button').getBoundingClientRect()
    return { x: b.left + b.width/2, y: b.top + b.height/2 }
  })()`)
  console.log('地图测量按钮坐标', JSON.stringify(box))
  await clickAt(box.x, box.y)
  await sleep(1200)
  console.log('真实点击后 popover:', await ev(`JSON.stringify({
    pop: !!document.querySelector('.popover-w'),
    anyPopper: document.querySelectorAll('.el-popper').length,
    drawerTags: [...document.querySelectorAll('.el-popper')].map(p => (p.textContent||'').trim().slice(0,20))
  })`))
  // 再点一次（切换）
  await clickAt(box.x, box.y)
  await sleep(800)
  console.log('再点一次后 popover:', await ev(`!!document.querySelector('.popover-w')`))
  // 用 JS click 对照
  await ev(`(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes('地图测量')); it.click() })()`)
  await sleep(1000)
  console.log('JS click 后 popover:', await ev(`!!document.querySelector('.popover-w')`))

  /* ---- 2. 城市视角 ---- */
  await send('Page.navigate', { url: BASE + '/cityview' })
  await sleep(8000)
  console.log('城市视角:', await ev(`JSON.stringify({
    path: location.pathname,
    center: window.__map ? [+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().lat.toFixed(2)] : null,
    zoom: window.__map ? +window.__map.getZoom().toFixed(1) : null,
    pitch: window.__map ? +window.__map.getPitch().toFixed(0) : null,
    errs: window.__errs
  })`))

  /* ---- 3. 从首页点「城市视角」按钮，看地图是否动 ---- */
  await send('Page.navigate', { url: BASE + '/' })
  await sleep(9000)
  const before = await ev(`JSON.stringify({z:+window.__map.getZoom().toFixed(1), p:+window.__map.getPitch().toFixed(0), path:location.pathname})`)
  const b2 = await ev(`(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes('城市视角')); const b=it.querySelector('button').getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2} })()`)
  await clickAt(b2.x, b2.y)
  await sleep(3500)
  const after = await ev(`JSON.stringify({z:+window.__map.getZoom().toFixed(1), p:+window.__map.getPitch().toFixed(0), path:location.pathname, errs:window.__errs})`)
  console.log('点城市视角前:', before)
  console.log('点城市视角后:', after)
  process.exit(0)
}
