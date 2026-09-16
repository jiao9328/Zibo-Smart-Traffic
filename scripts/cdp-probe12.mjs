/* 定向回归：任务2「实时数据栏不再遮挡导航 / 区域搜索的输入框」。
 *
 * 这两处遮挡此前一直存在，且都是「panel 压 panel」——只有量矩形 + elementFromPoint
 * 两个一起看才能证明修好了：矩形不相交只是前提，真正能不能输入还得看命中测试。
 *
 *   A 区域搜索页（/areasearch）：.rt-panel（或收起态 .rt-tab）与 .headerAS 不相交，
 *     且输入框中心 elementFromPoint 命中的是 input 本身；
 *   B 导航页（/navigation）：.rt-panel 与 .mapboxgl-ctrl-directions 不相交，
 *     起终点两个 input 中心都命中自身，并且真的能点进去拿到焦点；
 *   C 收起/展开两条路径都可点：点 ✕ 收起后小标签不被遮挡，再点小标签能展开回来。
 *
 * 前置：pnpm dev(:5180)、Chrome headless --remote-debugging-port=9223
 * 用法：node scripts/cdp-probe12.mjs
 */
const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created?.webSocketDebuggerUrl) { console.log('无法创建标签页'); process.exit(1) }
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    // CDP 命令失败时只有 m.error、result 是 undefined，静默吞掉就是一堆莫名的假失败
    if (m.error) console.log(`  ! CDP ${m.error.message}`)
    pending[m.id](m.result); delete pending[m.id]
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>'
      : r?.result?.value)
const evj = (x) => ev(x).then((s) => {
  if (typeof s !== 'string') return s
  if (s[0] !== '{' && s[0] !== '[') return s
  try { return JSON.parse(s) } catch { return s }
})

let pass = 0, fail = 0
const fails = []
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; fails.push(label); console.log(`  ❌ ${label} ${detail !== undefined ? '→ ' + JSON.stringify(detail) : ''}`) }
}
const info = (label, v) => console.log(`  ·  ${label}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)

const waitFor = async (expr, ms = 15000, step = 300) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) }
  return false
}
const errs = () => evj(`JSON.stringify((window.__errs||[]).slice(0,5))`)
const errReset = () => ev(`window.__errs && (window.__errs.length = 0)`)

/* 真实鼠标事件：elementFromPoint 命中 ≠ 点得到，最终还是要发真事件 */
const clickAt = async (x, y) => {
  const p = { x, y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 }); await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, buttons: 1 }); await sleep(45)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, buttons: 0 }); await sleep(50)
}

/* 矩形读数：不存在返回 null（面板可能还没挂/已卸载）。
 * ★ 直接用 returnByValue 拿对象，不要 JSON.stringify —— 元素不存在时表达式求值成字符串
 * "null"，evj 会在第 23 行看 s[0]==='n' 就原样返回这个字符串，而 "null" 是 truthy：
 * 于是「元素不在 DOM 里」会被断言成「元素存在」，后面的 cx/cy 全是 undefined（本探针踩过）。 */
const box = (sel) => ev(`${`window.__box=window.__box||((s)=>{const e=document.querySelector(s);if(!e)return null;
  const r=e.getBoundingClientRect();if(!r.width&&!r.height)return null;
  return {l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom),
  w:Math.round(r.width),h:Math.round(r.height),cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)}});`}
  __box(${JSON.stringify(sel)})`)

const overlapArea = (a, b) => {
  if (!a || !b) return 0
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l)
  const h = Math.min(a.b, b.b) - Math.max(a.t, b.t)
  return w > 0 && h > 0 ? w * h : 0
}

/* 命中测试：坐标上最顶层的元素，是不是「就是它 / 在它里面」 */
const hitTest = (sel, x, y) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)})
  if(!e) return 'no-el'; const el=document.elementFromPoint(${x},${y})
  return el ? (e===el||e.contains(el) ? 'self' : el.tagName+'.'+(el.className||'').toString().split(' ')[0]) : 'null'})()`)

/* 输入框中心：取 .headerAS_div_input / 导航控件第 i 个 input。
 * 顺手把该元素记在 window.__tgt 上：焦点断言要比「是不是同一个元素」，
 * 而不是比 className —— 导航控件的 input 根本没有 class，比字符串只会永远失败（踩过）。 */
const inputBox = (i = 0) => evj(`(()=>{const list=[...document.querySelectorAll('input')]
    .filter(el=>el.offsetParent!==null&&el.getBoundingClientRect().width>20)
  const e=list[${i}]; if(!e) return null; window.__tgt=e; const r=e.getBoundingClientRect()
  return {l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom),
    w:Math.round(r.width),h:Math.round(r.height),cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),
    cls:e.className, ph:e.placeholder||''}})()`)

/* 点完之后：拿到焦点的到底是不是刚才标记的那个输入框 */
const focusedTarget = () => ev(`(()=>{const a=document.activeElement
  if(!a) return 'null'
  return (window.__tgt&&a===window.__tgt?'self:':'other:')+a.tagName+'.'+String(a.className||'').split(' ')[0]})()`)

/* 页面内查询：某选择器在候选列表里的序号（避开跨次求值重复声明的坑，全部包在 IIFE 里） */
const authScript = `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'admin',display_name:'巡检'}))}catch(e){}`

const goto = async (path) => {
  await send('Page.navigate', { url: BASE + path })
  await waitFor(`!!(window.__map && window.__scene)`, 30000)
  await sleep(1200)
}

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))));
      ${authScript}`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })

  /* ===================== A 区域搜索页 ===================== */
  console.log('\n===== A /areasearch：实时数据栏 vs 搜索输入框 =====')
  await goto('/areasearch')
  await sleep(1500)

  const rt = await box('.rt-panel')
  const rtTab = await box('.rt-tab')
  const as = await box('.headerAS')
  info('实时数据栏 .rt-panel', rt)
  info('搜索结果条 .headerAS', as)
  check(!!rt && !!as, '两者都在页面上（缺少任一则后面无从断言）', { rt: !!rt, as: !!as })

  const ov = overlapArea(rt, as)
  check(ov === 0, '实时数据栏与搜索条矩形不相交', { 重叠面积: ov, rt, as })

  if (as) {
    const hit = await hitTest('.headerAS_div_input', as.cx, as.cy)
    check(hit === 'self', '搜索输入框中心命中自己（没被实时数据栏压住）', hit)
    const ib = await inputBox(0)
    check(!!ib && ib.w > 40 && ib.h > 20, '搜索输入框仍有可点面积（未被挤没）', ib)
    if (ib) {
      await clickAt(ib.cx, ib.cy)
      await sleep(300)
      const focused = await focusedTarget()
      check(/^self:/.test(focused || ''), '真实点击后输入框拿到焦点（可输入）', focused)
    }
  }

  /* ===================== B 导航页 ===================== */
  console.log('\n===== B /navigation：实时数据栏 vs 导航起终点输入框 =====')
  await goto('/navigation')
  await sleep(2000)

  const rt2 = await box('.rt-panel')
  const ctrl = await box('.mapboxgl-ctrl-directions')
  info('实时数据栏 .rt-panel', rt2)
  info('导航控件 .mapboxgl-ctrl-directions', ctrl)
  check(!!ctrl, '导航控件已渲染', !!ctrl)
  if (ctrl) {
    const ov2 = overlapArea(rt2, ctrl)
    check(ov2 === 0, '实时数据栏与导航控件矩形不相交', { 重叠面积: ov2, rt: rt2, ctrl })
    /* 起终点两个输入框逐个命中 */
    for (const i of [0, 1]) {
      const ib = await inputBox(i)
      info(`导航输入框[${i}]`, ib)
      if (!ib) { check(false, `导航输入框[${i}] 存在`, ib); continue }
      const hit = await ev(`(()=>{const el=document.elementFromPoint(${ib.cx},${ib.cy})
        return el?((el.tagName==='INPUT'||el.closest?.('.mapboxgl-ctrl-geocoder'))?'self':el.tagName+'.'+(el.className||'').toString().split(' ')[0]):'null'})()`)
      check(hit === 'self', `导航输入框[${i}] 中心命中自己`, hit)
      await clickAt(ib.cx, ib.cy)
      await sleep(250)
      const focused = await focusedTarget()
      check(/^self:/.test(focused || ''), `导航输入框[${i}] 点击后拿到焦点`, focused)
    }
  }

  /* ===================== C 收起 / 展开两条路径 ===================== */
  console.log('\n===== C 实时数据栏收起/展开都可点 =====')
  const closeBtn = await box('.rt-close')
  check(!!closeBtn, '展开态下 ✕ 收起按钮存在', closeBtn)
  if (closeBtn) {
    const hitClose = await hitTest('.rt-close', closeBtn.cx, closeBtn.cy)
    check(hitClose === 'self', '✕ 收起按钮可点（未被遮挡）', hitClose)
    await clickAt(closeBtn.cx, closeBtn.cy)
    await sleep(400)
  }
  const tab = await box('.rt-tab')
  check(!!tab, '收起后出现小标签 .rt-tab', !!tab)
  if (tab) {
    const hitTab = await hitTest('.rt-tab', tab.cx, tab.cy)
    check(hitTab === 'self', '小标签可点（未被遮挡）', hitTab)
    await clickAt(tab.cx, tab.cy)
    await sleep(400)
    const back = await box('.rt-panel')
    check(!!back, '再点小标签能展开回面板', !!back)
    /* 展开后仍不压导航控件 */
    if (back && ctrl) check(overlapArea(back, ctrl) === 0, '重新展开后与导航控件仍不相交', overlapArea(back, ctrl))
  }

  const e = await errs()
  check((e || []).length === 0, '本段无运行时错误', e)
  await errReset()

  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`)
  if (fail) console.log('失败项：\n - ' + fails.join('\n - '))
  /* 收尾别直接 process.exit：Windows 上 WebSocket 还在关闭中就退出，libuv 会抛
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码被冲成 127 ——
   * 明明 16 项全过，脚本对外却是失败。改为设 exitCode，让事件循环自己收干。 */
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
  ws.close()
  process.exitCode = fail ? 1 : 0
}
