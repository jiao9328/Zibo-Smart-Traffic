// 终极判定：地图实例本身能不能动（绕开所有业务代码）
const list = await (await fetch('http://localhost:9222/json')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = {}
const send = (m, p = {}) => new Promise((r) => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value)

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  for (let i = 0; i < 80; i++) { await sleep(1000); if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) break }
  console.log('底部栏就绪:', await ev(`document.querySelectorAll('.btn-groups .item').length`))
  console.log('地图状态:', await ev(`JSON.stringify({
    hasMap: !!window.__map, loaded: window.__map && window.__map.loaded(),
    styleLoaded: window.__map && window.__map.isStyleLoaded && window.__map.isStyleLoaded(),
    c: window.__map ? [+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().zoom !== undefined ? 0 : 0] : null,
    center: window.__map ? [+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().lat.toFixed(2), +window.__map.getZoom().toFixed(2)] : null,
    canvas: (() => { const c = document.querySelector('.mapboxgl-canvas'); return c ? [c.clientWidth, c.clientHeight] : null })(),
    container: (() => { const c = document.getElementById('map'); return c ? [c.clientWidth, c.clientHeight] : null })(),
    errs: window.__errs
  })`))
  // 直接命令地图动：绕开所有业务代码
  await ev(`window.__map.flyTo({ center: [117.0, 36.0], zoom: 12, duration: 0 })`)
  await sleep(1500)
  console.log('手工 flyTo 后:', await ev(`JSON.stringify([+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().lat.toFixed(2), +window.__map.getZoom().toFixed(2)])`))
  await ev(`window.__map.easeTo({ center: [119.0, 37.0], zoom: 6, duration: 100 })`)
  await sleep(1500)
  console.log('手工 easeTo 后:', await ev(`JSON.stringify([+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().lat.toFixed(2), +window.__map.getZoom().toFixed(2)])`))
  process.exit(0)
}
