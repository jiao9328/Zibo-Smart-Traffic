/* 临时排查：列出文档里所有包含指定关键字的选择器及其声明。
 * 用法：node scripts/cdp-css-rules.mjs g2-body
 */
const CDP = process.env.CDP_PORT || '9223'
const KEY = process.argv[2] || 'g2-body'

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
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r?.exceptionDetails ? '<<' + r.exceptionDetails.exception?.description + '>>' : r?.result?.value
  )

const expr = `(() => {
  const out = [];
  for (const ss of document.styleSheets) {
    let rules;
    try { rules = ss.cssRules } catch (e) { continue }
    if (!rules) continue;
    for (const r of rules) {
      if (!r.selectorText) continue;
      if (r.selectorText.indexOf(${JSON.stringify(KEY)}) === -1) continue;
      out.push(r.selectorText + '  {  ' + r.style.cssText + '  }');
    }
  }
  return out.length ? out.join('\\n') : '(没有匹配的选择器)';
})()`

ws.onopen = async () => {
  await send('Runtime.enable')
  console.log(await ev(expr))
  process.exit(0)
}
