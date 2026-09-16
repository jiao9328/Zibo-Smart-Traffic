/* 放大截取某个元素，用于看清 canvas 里的小字（vision 在原始尺寸下容易误读）。
 * 用法：node scripts/cdp-zoom.mjs out.png .g2-pie [倍率] [先点的按钮]
 */
import { writeFileSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.PORT || '5180'
const out = process.argv[2] || 'zoom.png'
const sel = process.argv[3] || '.g2-pie'
const scale = +(process.argv[4] || 4)
const btn = process.argv[5] || ''

const list = await (await fetch(`http://localhost:${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.log('NO PAGE TARGET')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => {
    const mid = ++id
    pending[mid] = r
    ws.send(JSON.stringify({ id: mid, method: m, params: p }))
  })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    pending[m.id](m.result)
    delete pending[m.id]
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r?.exceptionDetails ? null : r?.result?.value
  )

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}`
  })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  let ok = false
  for (let i = 0; i < 90; i++) {
    if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) { ok = true; break }
    await sleep(1000)
  }
  if (!ok) console.log('警告：底部工具条未出现')
  await sleep(2000)

  if (btn) {
    const b = await ev(
      `(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes(${JSON.stringify(btn)}));
        if(!it) return null; const r=it.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2} })()`
    )
    if (b && typeof b === 'object') {
      const p = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
      await sleep(50)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
      await sleep(2600)
    }
  }

  const rect = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if(!el) return null; const r = el.getBoundingClientRect();
    return JSON.stringify({x:r.x, y:r.y, w:r.width, h:r.height}) })()`)
  const r = typeof rect === 'string' ? JSON.parse(rect) : null
  if (!r) {
    console.log('找不到元素：' + sel)
    process.exit(1)
  }
  // 往外扩 12px，确认卡片边缘有没有把内容切掉
  const clip = {
    x: Math.max(0, r.x - 12),
    y: Math.max(0, r.y - 12),
    width: r.w + 24,
    height: r.h + 24,
    scale
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`saved ${out}  (元素 ${Math.round(r.w)}x${Math.round(r.h)} @${scale}x)`)
  process.exit(0)
}
