/* 一次性排查脚本：在地图页里找出「林峰」「TL315」这两串文字到底出现在屏幕上的什么地方，
 * 以及四类点图层当前真正渲染的记录里有没有文本/数字。用完即可删。
 * 前置：pnpm dev + Chrome headless --remote-debugging-port=9223
 * 用法：PORT=5173 node scripts/cdp-where-text.mjs
 */
const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.PORT || '5173'

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created?.webSocketDebuggerUrl) { console.log('无法创建标签页'); process.exit(1) }
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) { if (m.error) console.log('! CDP', m.error.message); pending[m.id](m.result); delete pending[m.id] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => (r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value))
const evj = (x) => ev(x).then((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return s } })

await new Promise((r) => { ws.onopen = r })
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}`
})
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
for (let i = 0; i < 90; i++) {
  if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) break
  await sleep(1000)
}
await sleep(2500)
console.log('boot ok, map =', await ev(`!!window.__map`), ' zoom =', await ev(`window.__map && window.__map.getZoom()`))

// 打开四类点图层
console.log('layers →', JSON.stringify(await evj(
  `['camera','trafficLight','police','busStop','busRoute','congestion'].map(n=>[n,window.__traffic.setVisible(n,true)])`)))
await sleep(3000)

/* 1) 屏幕上哪几处在显示「林峰」/「TL315」 */
console.log('\n--- DOM 里含「林峰」的节点 ---')
console.log(JSON.stringify(await evj(`(()=>{
  const hits=[]
  const walk=(n)=>{ if(n.nodeType===3){ const t=n.textContent; if(/林峰/.test(t)) hits.push({text:t.trim().slice(0,40), parent:n.parentElement?.className||n.parentElement?.tagName}) }
    else for(const c of n.childNodes) walk(c) }
  walk(document.body)
  return hits
})()`), null, 1))

console.log('\n--- 地图 canvas 尺寸 & 页面里所有 text 元素（前 40） ---')
console.log(JSON.stringify(await evj(`(()=>{
  const out=[]
  for(const el of document.querySelectorAll('body *')) {
    const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) continue
    if(el.children.length===0 && el.textContent.trim() && el.textContent.trim().length<14){
      out.push({t:el.textContent.trim(), cls:(el.className||'').toString().slice(0,30), x:Math.round(r.x), y:Math.round(r.y)})
    }
  }
  return out.slice(0,40)
})()`), null, 1))

/* 2) 每个点图层的五个子图层：shape / size / 记录里有什么字段 */
console.log('\n--- 点图层的子图层实况 ---')
const info = await evj(`(()=>{
  const reg = window.__traffic.registry
  const out={}
  for(const n of ['camera','trafficLight','police','busStop']){
    const it=reg[n]; if(!it||!it.group.length){ out[n]='未建'; continue }
    out[n] = it.group.map(l=>{
      let enc=null
      try{ const e=l.getEncodedData(); enc = Array.isArray(e)?e:(e&&typeof e==='object'?Object.values(e):[]) }catch(err){ enc='ERR:'+err.message }
      const s = l.getSource ? null : null
      const first = Array.isArray(enc)&&enc[0] ? Object.keys(enc[0]).slice(0,14) : (enc&&enc.length===0?'空':enc)
      const sample = Array.isArray(enc)&&enc[0] ? JSON.stringify({pc:enc[0].point_count, shape:enc[0].shape, tx:enc[0].text, c:enc[0].coordinates&&enc[0].coordinates.map(v=>+v.toFixed(4))}) : null
      return { id:l.id, zIndex:l.zIndex, font:l.getFont ? undefined : undefined, n:Array.isArray(enc)?enc.length:enc, keys:first, sample }
    })
  }
  return out
})()`)
console.log(JSON.stringify(info, null, 1))

/* 3) 主图层的 shape / size / color 配置 */
console.log('\n--- 主图层配置 ---')
console.log(JSON.stringify(await evj(`(()=>{
  const reg=window.__traffic.registry, out={}
  for(const n of ['camera','trafficLight','police','busStop']){
    const it=reg[n]; if(!it?.layer) { out[n]='未建'; continue }
    const l=it.layer
    out[n]={ id:l.id, size:l.getSize?l.getSize():null, shape:l.getShape?l.getShape():null,
             color:l.getColor?l.getColor():null, model:l.getModelType?l.getModelType():null }
  }
  return out
})()`), null, 1))

ws.close()
await sleep(150)
try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch {}
process.exit(0)
