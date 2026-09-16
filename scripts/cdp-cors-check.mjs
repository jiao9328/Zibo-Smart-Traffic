/* 诊断：应用页面里能不能直连外部数据接口（截图/功能异常时先排除跨域）。
 *
 * 为什么要它：区域搜索的行政边界/天气是页内 fetch 高德 REST 接口取的，
 * 从命令行 curl 通不代表浏览器里通（跨域要被 CORS 响应头放行）。截图里边界不出现时，
 * 先分清是「接口挂了」还是「浏览器拦了」，否则会去改根本没坏的代码。
 *
 * 用法：node scripts/cdp-cors-check.mjs
 */
import { readFileSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'

/* 从 .env 取高德 key（Key 只用于拼 URL，不打印到控制台 —— 这仓库的约定是 .env 不进 git） */
const envKey = (name) => {
  try {
    const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(name + '='))
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : ''
  } catch (e) { return '' }
}

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) { pending[m.id](m.error ? { error: m.error } : m.result); delete pending[m.id] }
}
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value)

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  // 从应用自己的 origin 发起，才是页内 fetch 的真实处境
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/login` })
  await new Promise((r) => setTimeout(r, 3500))

  for (const [name, url] of [
    ['高德地理编码', 'https://restapi.amap.com/v3/geocode/geo?address=%E5%BC%A0%E5%BA%97%E5%8C%BA&key=' + envKey('VITE_AMAP_KEY')],
    ['行政边界 geojson', 'https://geo.datav.aliyun.com/areas_v3/bound/370303_full.json']
  ]) {
    const r = await ev(`fetch(${JSON.stringify(url)}).then(r=>r.ok?'HTTP '+r.status:'HTTP '+r.status)
      .catch(e=>'FETCH_FAIL: '+e.message)`)
    console.log(`${name} → ${r}`)
  }
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch (e) { /* 已关 */ }
  ws.close()
  process.exitCode = 0
}
