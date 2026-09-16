/* 诊断：区域搜索（?area=某地）在真应用里到底走到了哪一步。
 *
 * 为什么要它：这张页面的外网依赖有三段（高德地理编码 → DataV 行政边界 → 高德天气），
 * 任何一段挂掉都只表现为「截图里少了一块」，光看截图分不出是哪段。
 * 这里把三段请求的状态码、天气卡片的实际 DOM 文本、地图上加了几个填充层一次打出来。
 *
 * 用法：node scripts/cdp-area-debug.mjs [搜索词]   默认「张店区」
 *   前置：dev server 在跑、headless Chrome 带 --remote-debugging-port=9223 在跑
 */
const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const KW = process.argv[2] || '张店区'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const net = []      // 关心的外网请求 {url, status}
const errors = []   // 页内未捕获异常
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; return }
  if (m.method === 'Network.requestWillBeSent' && /amap|aliyun/.test(m.params.request.url)) {
    net.push({ url: m.params.request.url.slice(0, 120), status: '…' })
  }
  if (m.method === 'Network.responseReceived' && /amap|aliyun/.test(m.params.response.url)) {
    const hit = net.filter((n) => n.status === '…' && m.params.response.url.startsWith(n.url.slice(0, 120)))
    if (hit.length) hit[hit.length - 1].status = m.params.response.status
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  }
}
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value)
const waitFor = async (expr, ms = 20000) => {
  for (let t = 0; t < ms; t += 400) { if (await ev(expr)) return true; await sleep(400) }
  return false
}

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable')
  const stale = (await (await fetch(`http://localhost:${CDP}/json`)).json())
    .filter((t) => t.type === 'page' && t.id !== created.id && t.url.includes(`:${PORT}`))
  for (const t of stale) { try { await fetch(`http://localhost:${CDP}/json/close/${t.id}`) } catch (e) { /* 已关 */ } }

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'jiao9328',display_name:'演示用户'}))}catch(e){}
      /* 记下页内所有 fetch 的 URL：网络域事件受缓存影响可能看不到请求，
       * 但 fetch 被调用过就一定在 __netlog 里 —— 「没发请求」和「发了没上报」必须分清 */
      try{ window.__netlog=[]
        var _f=window.fetch
        window.fetch=function(u){ try{window.__netlog.push(String((u&&u.url)||u).slice(0,140))}catch(e){} return _f.apply(this,arguments) }
      }catch(e){}`
  })
  await send('Page.navigate', { url: BASE + '/' })
  if (!await waitFor(`!!window.__router && !!window.__map`, 40000)) console.log('  ! 地图/路由没就绪')
  const q = `/areasearch?area=${encodeURIComponent(KW)}`
  await ev(`(()=>{window.__router.push(${JSON.stringify(q)}).catch(()=>{});return 'ok'})()`)
  await waitFor(`String(window.__router.currentRoute.value.path).startsWith('/areasearch')`, 8000)
  await sleep(12000)

  console.log('路由：', await ev(`window.__router.currentRoute.value.fullPath`))
  console.log('输入框：', await ev(`(document.querySelector('.headerAS_div_input')||{}).value`))
  console.log('天气卡片：', JSON.stringify(await ev(`(document.querySelector('.weatherCondition')||{}).innerText`)))
  console.log('地图填充层：', JSON.stringify(await ev(`(()=>{try{
      const s=window.__map.getStyle()
      return s.layers.filter(l=>l.type==='fill'&&/polygon/i.test(l.id)).map(l=>l.id)
    }catch(e){return 'ERR '+e.message}})()`)))
  /* 第二条路径：手动在输入框里回车（cdp-audit 用的就是这个手法）。
   * 未命中 ?area= 路径时靠它区分「查询参数这条路断了」和「整个功能断了」 */
  console.log('--- 手动回车再搜一次 ---')
  await ev(`window.__netlog=[]`)
  await ev(`(()=>{const i=document.querySelector('.headerAS_div_input')
    if(!i) return 'no-input'
    i.value=${JSON.stringify(KW)}; i.dispatchEvent(new Event('input',{bubbles:true}))
    i.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true})); return 'ok'})()`)
  await sleep(9000)
  console.log('天气卡片(手动)：', JSON.stringify(await ev(`(document.querySelector('.weatherCondition')||{}).innerText`)))
  console.log('缩放：', await ev(`window.__map.getZoom().toFixed(2)`))
  console.log('页内 fetch 调用：')
  for (const u of (await ev(`window.__netlog||[]`)) || []) console.log('  ' + u)
  console.log('外网请求：')
  for (const n of net) console.log(`  ${n.status}  ${n.url}`)
  if (errors.length) { console.log('页内异常：'); for (const e of errors) console.log('  ' + String(e).split('\n')[0]) }
  else console.log('页内异常：无')

  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch (e) { /* 已关 */ }
  ws.close()
  process.exitCode = 0
}
