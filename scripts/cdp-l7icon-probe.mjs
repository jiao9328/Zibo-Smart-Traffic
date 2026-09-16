/* 一次性探查：L7 的自定义图标（scene.addImage + .shape(图片名)）这条路在本项目里通不通。
 * 先探 API 是否存在、再真的注册一个白色 SVG 图标建个点图层，看渲染出来的到底是不是图标。
 * 用法：node scripts/cdp-l7icon-probe.mjs */
import { writeFileSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    if (m.error) console.log(`  ! CDP ${m.error.message}`)
    pending[m.id](m.result); delete pending[m.id]
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value)
const waitFor = async (expr, ms = 40000) => { for (let t = 0; t < ms; t += 400) { if (await ev(expr)) return true; await sleep(400) } return false }

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'a'}))}catch(e){}` })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(`!!(window.__scene && window.__map)`)
  await sleep(2000)

  console.log('scene 上跟图片有关的 API：')
  console.log(await ev(`JSON.stringify((()=>{const s=window.__scene; const o={addImage:typeof s.addImage, removeImage:typeof s.removeImage, getImage:typeof s.getImage}
    const proto=Object.getPrototypeOf(s)
    o.protoImageMethods=Object.getOwnPropertyNames(proto).filter(k=>/image|icon/i.test(k))
    return o})())`))

  /* 真注册一个图标（纯白符号：L7 用纹理蓝通道当遮罩，白色=全遮罩，再被图层色染） */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <circle cx="32" cy="32" r="26" fill="none" stroke="#fff" stroke-width="6"/>
    <path d="M18 32h28M32 18v28" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>`
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
  console.log('\n注册图标：')
  console.log(await ev(`(async()=>{ try{ await window.__scene.addImage('probe-icon', ${JSON.stringify(url)})
      return 'addImage 返回并完成' }catch(e){ return 'addImage 抛错: '+e.message } })()`))
  console.log('图标表里有它吗：', await ev(`JSON.stringify((()=>{const s=window.__scene
    const svc = s.iconService || (s.getService&&s.getService())
    try{ const m=(s.iconService&&s.iconService.getIconMap&&s.iconService.getIconMap())||null
      return {hasIconService:!!s.iconService, keys:m?Object.keys(m):null} }catch(e){ return 'err:'+e.message }})())`))

  /* 开一个真实图层，看 shape 走的是 image 模型还是退化成 text */
  await ev(`window.__traffic.setVisible('police', true)`)
  await sleep(1200)
  console.log('\npolice 图层模型类型（应为 fill，且 shape 名能在图标表里找到）：')
  console.log(await ev(`JSON.stringify((()=>{const l=window.__traffic.registry.police.layer
    return {modelType:l.model&&l.model.type, shapeOption:l.shapeOption,
      iconMapKeys:(()=>{try{return Object.keys(l.iconService.getIconMap())}catch(e){return 'err'}})()}})())`))

  await ev(`(()=>{window.__map.jumpTo({center:[118.05,36.81], zoom:13, pitch:0}); return 'ok'})()`)
  await sleep(1800)
  const s = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('logs/l7icon-probe.png', Buffer.from(s.data, 'base64'))
  console.log('SHOT: logs/l7icon-probe.png')

  ws.close()
  process.exitCode = 0
}
