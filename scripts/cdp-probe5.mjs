// 重启浏览器后的干净复测：1) 地图实例能否动 2) 从首页点地球自转/区域搜索/城市视角
const list = await (await fetch('http://localhost:9222/json')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = {}
const send = (m, p = {}) => new Promise((r) => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) => (r && r.result ? r.result.value : "<<" + (r?.exceptionDetails?.exception?.description || r?.error?.message || "no-result") + ">>"))

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  let ok = false
  for (let i = 0; i < 90; i++) { await sleep(1000); if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) { ok = true; break } }
  console.log('底部栏就绪:', ok)

  // 1. 直接命令地图动（绕开业务代码）
  await ev(`void window.__map.flyTo({ center: [117.0, 36.0], zoom: 12, duration: 0 })`)
  await sleep(1200)
  console.log('手工 flyTo:', await ev(`JSON.stringify([+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().lat.toFixed(2), +window.__map.getZoom().toFixed(2)])`))

  // 2. 从首页真实点击底部按钮
  const click = async (label) => {
    const b = await ev(`(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes('${label}')); if(!it) return null; const r=it.querySelector('button').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    if (!b) return 'no-btn'
    const p = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p }); await sleep(60)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p }); await sleep(50)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
    return 'ok'
  }
  await click('首页'); await sleep(3000)
  console.log('回首页:', await ev(`JSON.stringify({p:location.pathname, c:[+window.__map.getCenter().lng.toFixed(2),+window.__map.getCenter().lat.toFixed(2),+window.__map.getZoom().toFixed(2)]})`))
  for (const label of ['地球自转', '区域搜索', '城市视角', '区域搜索', '导航']) {
    await click(label); await sleep(4000)
    console.log(`点「${label}」后:`, await ev(`JSON.stringify({p:location.pathname, c:[+window.__map.getCenter().lng.toFixed(2),+window.__map.getCenter().lat.toFixed(2),+window.__map.getZoom().toFixed(2),+window.__map.getPitch().toFixed(0)], errs:window.__errs.slice(-2)})`))
    if (label !== '首页') { await click('首页'); await sleep(2500) }
  }
  process.exit(0)
}
