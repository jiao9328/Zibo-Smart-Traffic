/* 一次性探查：L7 实例上「我设的 shape/size/color 到底存在哪」。
 * getLayerConfig() 拿到的是默认配置（shape:circle, size:10），说明样式走的是别的通路，
 * 探针要断言必须找对取值的字段。用法：node scripts/cdp-l7introspect.mjs */
const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value)
const waitFor = async (expr, ms = 40000) => { for (let t = 0; t < ms; t += 400) { if (await ev(expr)) return true; await sleep(400) } return false }

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'a'}))}catch(e){}` })
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(`!!(window.__traffic && window.__map)`)
  await sleep(1500)
  await ev(`window.__traffic.setVisible('camera', true)`)
  await sleep(800)

  const r = await ev(`(()=>{const it=window.__traffic.registry.camera; const l=it&&it.layer; if(!l) return 'no-layer'
    const out={}
    out.keys=Object.keys(l).slice(0,60)
    out.hasSAS=!!l.styleAttributeService
    out.styleOptions=JSON.stringify(l.styleOptions||null).slice(0,400)
    try{ out.sasKeys=Object.keys(l.styleAttributeService||{}) }catch(e){ out.sasKeys='err' }
    try{ const m=l.styleAttributeService.attributeMap; out.attrKeys=m?[...m.keys()]:null }catch(e){ out.attrKeys='err:'+e.message }
    try{ const cfgs=l.styleAttributeService.styleAttributeConfigs||l.styleAttributeService.layerStyleService
      out.sasConfigs=cfgs?Object.keys(cfgs):null }catch(e){}
    try{ out.layerConfig=JSON.stringify(l.getLayerConfig()).slice(0,600) }catch(e){}
    try{ const s=l.getSource(); out.srcKeys=Object.keys(s||{}).slice(0,40)
         out.srcData=s&&s.data?('features:'+(s.data.features||[]).length):(s&&s.originData?'originData':'?') }catch(e){ out.srcKeys='err:'+e.message }
    return JSON.stringify(out,null,1)})()`)
  console.log(r)

  /* styleAttributeService 里每个属性的当前值 */
  const r2 = await ev(`(()=>{const l=window.__traffic.registry.camera.layer
    const sas=l.styleAttributeService; const o={}
    const tryGet=(n)=>{try{ const c=sas.getStyleAttributeConfig&&sas.getStyleAttributeConfig(n)
      if(c) return {scaleField:c.scale&&c.scale.field, values:c.values, scale:c.scale&&Object.keys(c.scale)}
      const f=sas.getLayerStyleAttributeValue&&sas.getLayerStyleAttributeValue(n)
      return f?{from:'valueFn'}:'none'}catch(e){return 'err:'+e.message}}
    for(const n of ['color','shape','size','stroke','strokeWidth','opacity']) o[n]=tryGet(n)
    return JSON.stringify(o,null,1)})()`)
  console.log(r2)

  const r3 = await ev(`(()=>{const l=window.__traffic.registry.camera.layer; const sas=l.styleAttributeService
    const out={}
    for(const k of ['getStyleAttributeConfig','getLayerStyleAttribute','getStyleAttribute','getLayerStyleAttributeValue','getStyleAttributeScale','attributeMap','styleAttributeService','layerStyleService']) out[k]=typeof sas[k]
    return JSON.stringify(out,null,1)})()`)
  console.log(r3)
  ws.close(); await sleep(150)
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
  process.exit(0)
}
