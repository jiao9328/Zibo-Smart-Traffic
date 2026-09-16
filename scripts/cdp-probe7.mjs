/* 任务2 验证：控制中心图表不再互相遮盖、不再挡底部按钮、不再挡地图拖拽
 *
 * 覆盖的原始缺陷：
 *   - useLeftTop/useLeftBottom/useRightTop 与 G2Charts 行内写死 height:270/92，
 *     面板按百分比缩放时内容溢出，被下一块面板盖住
 *   - .g2-chart 是 content-box + padding:20px → 横向溢出 40px
 *   - .people-sum 用 top:-58px 把标题顶到面板外面
 *   - .g2-left/.g2-right z-index:100 高过底部工具条(90)与实时数据栏(46)
 *   - ::before/::after 装饰角压在 canvas 上抢点击
 *
 * 前置：pnpm dev --port 5180 --strictPort
 *       Chrome 必须 headless 启动（原因见 cdp-probe6.mjs 顶部注释）
 * 用法：node scripts/cdp-probe7.mjs
 */
const PORT = process.env.PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const CDP = process.env.CDP_PORT || '9223'

const list = await (await fetch(`http://localhost:${CDP}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.log(`NO PAGE TARGET — Chrome 未以 --remote-debugging-port=${CDP} 启动？`)
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
    r && r.result ? r.result.value : '<<' + (r?.exceptionDetails?.exception?.description || 'no-result') + '>>'
  )

let pass = 0
let fail = 0
const check = (ok, label, detail) => {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}`, detail !== undefined ? JSON.stringify(detail) : '')
  } else {
    fail++
    console.log(`  ❌ ${label}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

/** 两个矩形是否相交（留 1px 容差，避免亚像素误差误报） */
const hit = (a, b) =>
  a.x < b.rt - 1 && a.rt > b.x + 1 && a.y < b.b - 1 && a.b > b.y + 1

/** 把页面里所有相关矩形一次性量出来 */
const measure = () =>
  ev(`(() => {
    const R = (el) => { const r = el.getBoundingClientRect()
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
               rt: +r.right.toFixed(1), b: +r.bottom.toFixed(1) } }
    const cards = [...document.querySelectorAll('.g2-chart')].map((c) => {
      const cv = c.querySelector('canvas')
      const ti = c.querySelector('.people-sum')
      return {
        cls: (c.className || '').replace('g2-chart', '').trim() || '(plain)',
        box: R(c),
        canvas: cv ? R(cv) : null,
        title: ti ? R(ti) : null,
        // 内容比可视区高/宽 → 说明内部内容溢出（原 height:270 的症状）
        over: { x: c.scrollWidth - c.clientWidth, y: c.scrollHeight - c.clientHeight },
        overflowY: getComputedStyle(c).overflowY,
      }
    })
    const q = (s) => { const el = document.querySelector(s); return el ? R(el) : null }
    return JSON.stringify({
      vw: innerWidth, vh: innerHeight,
      cards,
      header: q('.header'),
      footer: q('.footer'),
      btns: q('.btn-groups'),
      rt: (() => { const el = document.querySelector('.rt-panel')
        return el && el.offsetParent !== null ? R(el) : null })(),
      vp: (() => { const el = document.querySelector('.vp-panel')
        return el && el.offsetParent !== null ? R(el) : null })()
    })
  })()`)

const parse = (s) => (typeof s === 'string' && s[0] === '{' ? JSON.parse(s) : s)

const RES = [
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1366, 768],
  [1280, 720]
]

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}
      window.__errs=[]; addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||String(e.reason))))`
  })

  const vis = await ev(`document.visibilityState`)
  const fps = await ev(`new Promise(r=>{const t0=performance.now();let n=0;
    const f=()=>{n++; performance.now()-t0<1000 ? requestAnimationFrame(f) : r(n)};
    requestAnimationFrame(f); setTimeout(()=>r(n),1600)})`)
  if (vis !== 'visible' || !fps) {
    console.log(`\n环境不合格：visibilityState=${vis}, 1秒内 rAF 帧数=${fps}`)
    console.log('mapbox 渲染循环依赖 rAF，页面 hidden 时地图永远不会 load。请用 headless 模式启动 Chrome。')
    process.exit(1)
  }

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  })
  await send('Page.navigate', { url: BASE + '/' })

  // 等地图 boot 完成（.btn-groups 才会挂载）
  let booted = false
  for (let i = 0; i < 90; i++) {
    if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) { booted = true; break }
    await sleep(1000)
  }
  if (!booted) {
    console.log('\n底部工具条始终没出现，后续断言无意义，先排查地图 boot（见 cdp-probe6.mjs）')
    process.exit(1)
  }

  /* 打开控制中心 */
  const b = await ev(
    `(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes('控制中心'));
      if(!it) return null; const r=it.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2} })()`
  )
  if (!b || typeof b !== 'object') {
    console.log('找不到「控制中心」按钮')
    process.exit(1)
  }
  const mp = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mp })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mp })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mp })
  await sleep(1800)

  const nCards = await ev(`document.querySelectorAll('.g2-chart').length`)
  console.log(`\n=== 控制中心已打开，共 ${nCards} 块卡片 ===`)
  check(nCards === 6, '左右两列共 6 块卡片', { nCards })

  /* ---------------- 多分辨率几何检查 ---------------- */
  for (const [w, h] of RES) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false
    })
    await sleep(700) // 等 autoFit / ResizeObserver 重排
    const m = parse(await measure())
    console.log(`\n=== ${w}×${h} ===`)
    if (!m || typeof m !== 'object' || !m.cards) {
      check(false, '测量失败', m)
      continue
    }
    const cards = m.cards

    // 1) 卡片之间互不重叠（含左右两列之间）
    const overlaps = []
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        if (hit(cards[i].box, cards[j].box)) overlaps.push([cards[i].cls, cards[j].cls])
      }
    }
    check(overlaps.length === 0, '卡片之间无重叠', overlaps)

    // 2) 不盖底部工具条 / Header
    const badFooter = cards.filter((c) => m.btns && hit(c.box, m.btns)).map((c) => c.cls)
    const badHeader = cards.filter((c) => m.header && hit(c.box, m.header)).map((c) => c.cls)
    check(badFooter.length === 0, '不遮挡底部工具条', badFooter)
    check(badHeader.length === 0, '不遮挡顶部 Header', badHeader)

    // 3) 不盖左上实时数据栏
    const badRt = cards.filter((c) => m.rt && hit(c.box, m.rt)).map((c) => c.cls)
    check(badRt.length === 0, '不遮挡实时数据栏', badRt)

    // 4) 标题在卡片内（原 top:-58px 把标题顶到面板外）
    const badTitle = cards
      .filter((c) => c.title && (c.title.y < c.box.y - 1 || c.title.b > c.box.b + 1))
      .map((c) => c.cls)
    check(badTitle.length === 0, '卡片标题未越界', badTitle)

    // 5) canvas 不超出卡片（原 height:270 溢出的直接症状）
    const badCanvas = cards
      .filter((c) => c.canvas && (c.canvas.b > c.box.b + 2 || c.canvas.rt > c.box.rt + 2))
      .map((c) => ({ c: c.cls, cardH: c.box.h, cvH: c.canvas.h }))
    check(badCanvas.length === 0, 'canvas 未超出卡片', badCanvas)

    // 6) 卡片内部无滚动溢出
    const badOver = cards.filter((c) => c.over.y > 2 || c.over.x > 2).map((c) => ({ c: c.cls, ...c.over }))
    check(badOver.length === 0, '卡片内容未溢出', badOver)

    // 7) 卡片在视口内
    const off = cards.filter((c) => c.box.x < -1 || c.box.rt > w + 1 || c.box.y < -1 || c.box.b > h + 1)
      .map((c) => ({ c: c.cls, ...c.box }))
    check(off.length === 0, '卡片都在视口内', off)
  }

  /* ---------------- 交互：装饰角不再抢点击 + tooltip 不被裁 ---------------- */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  })
  await sleep(700)
  console.log('\n=== 交互 ===')

  // 鼠标移到饼图中心：应出现 .g2-tooltip，且不被 .g2-chart 的 overflow 裁掉
  const pie = await ev(`(() => {
    const p = document.querySelector('.g2-pie');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, box: {x:r.left,y:r.top,rt:r.right,b:r.bottom} };
  })()`)
  if (!pie || typeof pie !== 'object') {
    check(false, '找到饼图卡片', pie)
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pie.x + 20, y: pie.y })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pie.x, y: pie.y })
    await sleep(900)
    const tip = await ev(`(() => {
      const el = document.querySelector('.g2-tooltip');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { empty: true };
      const card = document.querySelector('.g2-pie').getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x:+r.x.toFixed(1), y:+r.y.toFixed(1), rt:+r.right.toFixed(1), b:+r.bottom.toFixed(1),
               opacity: cs.opacity, visibility: cs.visibility,
               outsideCard: r.left < card.left || r.right > card.right || r.top < card.top || r.bottom > card.bottom };
    })()`)
    if (!tip || typeof tip !== 'object') {
      check(false, '悬停饼图出现 tooltip', tip)
    } else if (tip.empty) {
      check(false, '悬停饼图出现 tooltip', 'tooltip 存在但尺寸为 0')
    } else {
      check(
        +tip.opacity > 0.5 && tip.visibility === 'visible',
        '悬停饼图出现 tooltip 且可见',
        { opacity: tip.opacity, visibility: tip.visibility }
      )
      // 越界即被 overflow:hidden 裁掉。允许轻微越界（探出 2px 内视觉无感）
      check(!tip.outsideCard, 'tooltip 未被卡片裁切', { outsideCard: tip.outsideCard, tip })
    }
  }

  // 卡片之间的空隙应当可以拖到地图（列容器 pointer-events:none）
  const gapHit = await ev(`(() => {
    const l = document.querySelector('.g2-left').getBoundingClientRect();
    // 取左列正中、接近底部（两卡片之间的 gap 区域）
    const cards = [...document.querySelectorAll('.g2-left .g2-chart')].map(c=>c.getBoundingClientRect());
    if (cards.length < 2) return null;
    const y = (cards[0].bottom + cards[1].top) / 2;
    const x = l.left + l.width / 2;
    const el = document.elementFromPoint(x, y);
    return { tag: el ? el.tagName : null, cls: el ? (el.className||'').toString().slice(0,60) : null,
             hitsCard: !!(el && el.closest && el.closest('.g2-chart')) };
  })()`)
  if (gapHit && typeof gapHit === 'object') {
    check(!gapHit.hitsCard, '两卡片间隙不拦截指针（可拖地图）', gapHit)
  }

  const errs = await ev(`JSON.stringify((window.__errs||[]).slice(0,5))`)
  check(errs === '[]', '无运行时错误', errs)

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
  process.exit(fail ? 1 : 0)
}
