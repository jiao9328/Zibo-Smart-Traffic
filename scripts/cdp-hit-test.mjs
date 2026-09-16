// 临时排查脚本：底部功能栏按钮真实命中测试（elementFromPoint 看谁盖住了按钮）
const PORT = process.env.PORT || '5173'
const BASE = `http://localhost:${PORT}`
const list = await (await fetch('http://localhost:9222/json')).json()
let page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    pending[mid] = resolve
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (expression) =>
  send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value)

// 命中探测：返回每个底部按钮中心的栈顶元素，以及是否有非按钮祖先拦截
const PROBE = `(() => {
  const out = []
  const items = [...document.querySelectorAll('.btn-groups .item')]
  for (const it of items) {
    const btn = it.querySelector('button')
    const r = btn.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    const label = (it.querySelector('p')?.textContent || '').trim()
    const hitsSelf = top === btn || btn.contains(top) || top === it || it.contains(top)
    out.push({
      label,
      hit: hitsSelf,
      top: top ? (top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/).slice(0,2).join('.') : '')) : 'null',
      topText: top ? (top.textContent || '').trim().slice(0, 18) : '',
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      zTop: top ? (() => { const s = getComputedStyle(top); return s.zIndex + '/' + s.position })() : '',
    })
  }
  return { items: out, path: location.pathname, vp: [innerWidth, innerHeight] }
})()`

// 关键：从某元素一路向上找祖先，找出谁有 z-index 且覆盖整屏
const CULPRIT = `(() => {
  const items = [...document.querySelectorAll('.btn-groups .item')]
  if (!items.length) return 'no-footer'
  const btn = items[0].querySelector('button')
  const r = btn.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const top = document.elementFromPoint(x, y)
  const chain = []
  let n = top
  while (n && n !== document.documentElement) {
    const s = getComputedStyle(n)
    chain.push(n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).slice(0,3).join('.') : '') + ' [' + s.position + ' z=' + s.zIndex + ' pe=' + s.pointerEvents + ']')
    n = n.parentElement
  }
  return chain
})()`

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  // 预置登录态（sessionStorage 只存用户名/显示名）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({ username: 'probe', display_name: '探针' })) } catch(e) {}`
  })

  const routes = ['/', '/eventinfo', '/areasearch', '/navigation', '/changestyle', '/cityview', '/mapdraw/drawRectTool']
  for (const r of routes) {
    await send('Page.navigate', { url: BASE + r })
    await sleep(r === '/' ? 9000 : 6000)
    const res = await ev(PROBE)
    if (!res || !res.items) { console.log(`\n### ${r} -> no footer`); continue }
    console.log(`\n### ${r}  vp=${res.vp.join('x')}  path=${res.path}`)
    for (const it of res.items) {
      console.log(`  ${it.hit ? 'OK  ' : 'BLOCK'} ${it.label.padEnd(6)} top=${it.top} z=${it.zTop} ${it.hit ? '' : '<= 被遮挡! text="' + it.topText + '"'}`)
    }
  }

  // 面板打开后复测（首页）
  await send('Page.navigate', { url: BASE + '/' })
  await sleep(8000)
  const clickItem = async (label) => {
    await ev(`(() => { const it = [...document.querySelectorAll('.btn-groups .item')].find(i => i.textContent.includes('${label}')); if (it) it.click() })()`)
    await sleep(1800)
  }
  for (const label of ['控制中心', '数据管理']) {
    await clickItem(label)
    const res = await ev(PROBE)
    console.log(`\n### / + ${label}打开`)
    for (const it of res.items) {
      console.log(`  ${it.hit ? 'OK  ' : 'BLOCK'} ${it.label.padEnd(6)} top=${it.top} ${it.hit ? '' : '<= 被遮挡! text="' + it.topText + '"'}`)
    }
    await clickItem(label) // 关掉
  }
  console.log('\n=== 遮挡链（若被挡）===')
  console.log(JSON.stringify(await ev(CULPRIT), null, 1))
  process.exit(0)
}
