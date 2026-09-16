// 多分辨率 + 全浮层打开时的底部按钮命中测试
const PORT = process.env.APP_PORT || '5180' // 5173 被别的项目占着，dev server 固定跑 5180
const BASE = `http://127.0.0.1:${PORT}`
const CDP = process.env.CDP_PORT || '9223' // 必须 headless（原因见 cdp-probe6.mjs 顶部）
const list = await (await fetch(`http://localhost:${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
function send(m, p = {}) { return new Promise((r) => { const mid = ++id; pending[mid] = r; ws.send(JSON.stringify({ id: mid, method: m, params: p })) }) }
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value)

const PROBE = `(() => {
  const f = document.querySelector('.footer')
  const fr = f ? f.getBoundingClientRect() : null
  const bad = []
  const items = [...document.querySelectorAll('.btn-groups .item')]
  for (const it of items) {
    const btn = it.querySelector('button')
    const r = btn.getBoundingClientRect()
    const x = r.left + r.width/2, y = r.top + r.height/2
    const top = document.elementFromPoint(x, y)
    if (!(top === btn || btn.contains(top) || it.contains(top))) {
      bad.push({ label: it.querySelector('p').textContent.trim(), x: Math.round(x), y: Math.round(y),
                 top: top ? top.tagName.toLowerCase() + '.' + (typeof top.className === 'string' ? top.className.trim().split(/\\s+/).slice(0,2).join('.') : '') : 'null' })
    }
  }
  return { n: items.length, footer: fr ? [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)] : null, bad }
})()`

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}`
  })
  const sizes = [[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1280, 720]]
  for (const [w, h] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: BASE + '/' })
    await sleep(9000)
    // 等底部栏挂载
    for (let i = 0; i < 40; i++) { if (await ev(`document.querySelectorAll('.btn-groups .item').length >= 10`)) break; await sleep(500) }
    // 打开 控制中心 + 数据管理 + AI 面板
    await ev(`(() => {
      const it = [...document.querySelectorAll('.btn-groups .item')]
      it.find(i => i.textContent.includes('控制中心')).click()
      it.find(i => i.textContent.includes('数据管理')).click()
      document.querySelector('.ai-fab').click()
    })()`)
    await sleep(2500)
    const r1 = await ev(PROBE)
    const open = await ev(`({charts: !!document.querySelector('.g2-left'), data: !!document.querySelector('.dm-panel'), ai: !!document.querySelector('.ai-panel.show') })`)
    console.log(`\n### ${w}x${h}  浮层=${JSON.stringify(open)}  footer rect=${JSON.stringify(r1.footer)}`)
    console.log(r1.bad.length ? '  BLOCKED: ' + JSON.stringify(r1.bad) : '  全部按钮可点')
    // 关掉面板再测一次
    await ev(`(() => {
      const it = [...document.querySelectorAll('.btn-groups .item')]
      it.find(i => i.textContent.includes('控制中心')).click()
      it.find(i => i.textContent.includes('数据管理')).click()
      document.querySelector('.ai-fab').click()
    })()`)
    await sleep(1500)
    const r2 = await ev(PROBE)
    console.log(r2.bad.length ? '  (浮层关闭后) BLOCKED: ' + JSON.stringify(r2.bad) : '  (浮层关闭后) 全部按钮可点')
  }
  process.exit(0)
}
