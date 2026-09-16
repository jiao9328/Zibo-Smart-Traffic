/* 临时排查：打印某块卡片内部的 DOM 层级与各层实际高度，用来定位「canvas 恒为 400px」
 * 到底是哪一层没有确定高度。用法：node scripts/cdp-dom-tree.mjs [选择器]
 */
const CDP = process.env.CDP_PORT || '9223'
const SEL = process.argv[2] || '.g2-pie'

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
  const card = document.querySelector(${JSON.stringify(SEL)});
  if (!card) return 'not found: ' + ${JSON.stringify(SEL)};
  const out = [];
  const walk = (el, d) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push('  '.repeat(d) + el.tagName.toLowerCase()
      + (el.className ? '.' + String(el.className).trim().split(/\\s+/).slice(0, 3).join('.') : '')
      + '  rect=' + Math.round(r.width) + 'x' + Math.round(r.height)
      + '  client=' + el.clientWidth + 'x' + el.clientHeight
      + '  cssH=' + cs.height + '  flex=' + cs.flex + '  minH=' + cs.minHeight
      + (el.getAttribute('style') ? '  style="' + el.getAttribute('style') + '"' : '')
      + (el.tagName === 'CANVAS' ? '  attrWH=' + el.width + 'x' + el.height : ''));
    if (d < 6) for (const c of el.children) walk(c, d + 1);
  };
  walk(card, 0);
  return out.join('\\n');
})()`

ws.onopen = async () => {
  await send('Runtime.enable')
  console.log(await ev(expr))
  process.exit(0)
}
