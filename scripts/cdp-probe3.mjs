// 决定性诊断：SPA 跳转 vs 直接刷新，三种"地图该动"的页面到底动不动
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
const snap = `JSON.stringify({p:location.pathname, c: window.__map ? [+window.__map.getCenter().lng.toFixed(2), +window.__map.getCenter().lat.toFixed(2), +window.__map.getZoom().toFixed(2), +window.__map.getPitch().toFixed(0)] : null, errs:(window.__errs||[]).slice(-2)})`

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })
  const waitFooter = async () => { for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) return true; await sleep(500) } return false }

  /* A. 直接刷新进入各页 */
  for (const r of ['/rotation', '/areasearch', '/cityview']) {
    await send('Page.navigate', { url: BASE + r })
    await sleep(3000)
    await waitFooter()
    await sleep(6000)
    console.log(`[直接刷新 ${r}]`, await ev(snap))
  }

  /* B. 从首页 SPA 跳转 */
  await send('Page.navigate', { url: BASE + '/' })
  await sleep(3000)
  await waitFooter()
  await sleep(5000)
  console.log('[首页稳定后]', await ev(snap))
  for (const [r, label] of [['/rotation', '地球自转'], ['/areasearch', '区域搜索'], ['/cityview', '城市视角']]) {
    await ev(`window.__router ? window.__router.push('${r}') : (location.href = '${r}')`)
    await sleep(5000)
    console.log(`[SPA 跳 ${r} (${label})]`, await ev(snap))
    await ev(`window.__router ? window.__router.push('/') : (location.href = '/')`)
    await sleep(4000)
  }
  process.exit(0)
}
