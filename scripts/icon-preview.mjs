/* 图标预览图：把四类交通点符号**按它们在地图上的真实样子**合成成一张对照图，
 * 写 logs/icon-preview.png（另出一张 full 版）。
 *
 * 为什么要单独做这个：真机上迭代要跑 cdp-probe17（开地图、找取样点、截图、数像素，几分钟一轮），
 * 改一笔图形就得等一轮。这个脚本几秒钟出一张图，用来快速判「缩到 18px 还看不看得出来」。
 * 上真机前的最后一道验证仍然是 cdp-probe17 + 识图。
 *
 * ★ v4（2026-09-15 emoji 版）的关键改动：位图**不再由本脚本复刻**。
 *   上一版把 L7 的着色逻辑用 canvas 重写了一遍（tinted()），四类符号的 SVG 路径也抄了一份 ——
 *   实现一改（这次就是从手绘 SVG 换成 emoji）预览图就跟真机对不上了，而且看不出来。
 *   现在改成：打开 dev 服务器 → 在页面里 `import('/src/tools/trafficIcons.js')`
 *   拿**真的** TRAFFIC_ICONS / emojiDataUrl / TRAFFIC_GLYPHS，尺寸与聚合点颜色也从
 *   `window.__traffic.registry` 的**活图层**上读。预览图与地图同源，改了实现这里自动跟着变。
 *
 * 用法：node scripts/icon-preview.mjs    （需 dev 服务器在跑 + headless Chrome，见 cdp-probe17 注释）
 *      APP_PORT=5173 node scripts/icon-preview.mjs
 */
import { writeFileSync } from 'node:fs'
import { decodePNG } from './lib/png.mjs' // 只用来回读裁切尺寸做断言

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5173'

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created?.webSocketDebuggerUrl) { console.log('无法创建标签页（需要 PUT /json/new）'); process.exit(1) }
const ws = new WebSocket(created.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
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
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value)

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'preview',display_name:'preview'}))}catch(e){}`
})
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
let ready = false
for (let i = 0; i < 60; i++) { if (await ev('!!(window.__traffic && window.__traffic.registry)')) { ready = true; break } await sleep(500) }
if (!ready) { console.log(`页面/桥没就绪：确认 dev 服务器在 ${PORT} 上跑着（npm run dev）`); ws.close(); process.exit(1) }

/* 画布：四列（一类符号一列），每列自上而下
 *   ① 实际大小（活图层上读到的尺寸）压在一段路网蓝条上，判断「在真实底图上还认不认得出」
 *   ② ZOOM 倍最近邻放大 ③ 散点 / 聚合桶并排（证明桶画的是**同一枚、同一尺寸**的图标）
 *   ④ 实时数据栏里的 15px 小图标
 * ★ 画布**宽高都由排版算出来**（页面里算完返回），本地不写字面量：上一版写死 460×260，
 *   而 ④ 行实际在 y=266 —— 被裁掉不说，露出来的还是页面自己的地图界面，识图直接去描述底图了。
 *   宽度更不能「按画布均分」：列距得容得下放大块，否则相邻两列会叠在一起（见下面 colW 的注释）。 */
const ZOOM = 8

const draw = `(async () => {
  const M = await import('/src/tools/trafficIcons.js')
  const KEYS = Object.keys(M.TRAFFIC_ICONS)
  // 尺寸从**活图层**上读：解析源码或抄一份都会漂移。
  // 读法沿用 cdp-probe17：常量 .size(9) 的值落在 .values 还是 .field 上不定，两个都试；
  // 回调 .size('f',cb) 存的是函数，这里已经不用了（现在四层都是常量）。
  const attr = (l, key) => {
    const a = (l && l.configService && l.configService.getAttributeConfig(l.id)) || {}
    const v = a[key]
    if (!v) return null
    if (typeof v.values === 'function') return v.values(1)
    return v.values !== undefined ? v.values : v.field
  }
  // 图层是**懒创建**的：panel 没打开过 registry[k].layer 就是 null，直接读会全是 null。
  // 先逐个 setVisible(true) 逼它建出来（probe17 A 段同款做法）。
  for (const k of KEYS) window.__traffic.setVisible(k, true)
  await new Promise((r) => setTimeout(r, 900))
  const live = {}
  const missing = []
  for (const k of KEYS) {
    const it = window.__traffic.registry[k] || {}
    live[k] = { size: attr(it.layer, 'size') }
    if (live[k].size === null) missing.push(k)
  }
  // 宁可直接报错也不给兜底值：预览图悄悄按一个假尺寸画出来，比不画更坏
  if (missing.length) throw new Error('读不到尺寸的图层：' + missing.join(',') + '（图层没建出来？）')
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src })
  const urls = {}, imgs = {}
  for (const k of KEYS) urls[k] = M.emojiDataUrl(k)
  for (const k of KEYS) imgs[k] = await load(urls[k])
  // 遮罩分支等效（L7 的 image 片元：图层色≠白时用纹理蓝通道当遮罩填图层色）：
  // 图已离线烤成「纯白不透明 + 洞」，这里 source-in 填色即等价，抗锯齿边缘差 1px 内
  const tinted = (img, color) => {
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height
    const x = t.getContext('2d')
    x.drawImage(img, 0, 0)
    x.globalCompositeOperation = 'source-in'
    x.fillStyle = color; x.fillRect(0, 0, t.width, t.height)
    return t
  }
  const FONT_EMOJI = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'
  const states = ['green', 'red', 'yellow', 'fault']
  const stateHex = { green: '#12B76A', red: '#F04438', yellow: '#F79009', fault: '#8C9AB0' }
  const d = live[KEYS[0]].size * 2      // 屏幕上直径 = size × 2；四类同尺寸（probe17 A 断言过），取第一个算排版
  const z = d * ${ZOOM}
  /* 列距**由放大块宽度推**，不能按画布宽度均分：z=144 而 460/4=115 时，
   * 第 1 列的放大块会伸进第 2 列 29px（上一版就是这样：识图说「无重叠」，量像素才发现
   * 列 2 左边那道深色其实是列 1 监控探头的右半边）。留 12px 净缝。 */
  const colW = z + 12
  const cw = colW * KEYS.length
  const L = {                            // 纵向排版全在 y 里推，改 ZOOM / 尺寸不会把内容顶出画布
    title: 18, iconTop: 26, sizeLabel: 0, zoomTop: 0, dotMid: 0, panelMid: 0, H: 0
  }
  L.sizeLabel = L.iconTop + d + 13
  L.zoomTop = L.sizeLabel + 13
  L.dotMid = L.zoomTop + z + 16 + d / 2
  L.panelMid = L.dotMid + d / 2 + 20
  L.H = Math.ceil(L.panelMid + 16)       // 15px 字的中线 + 半高 + 余量
  const cv = document.createElement('canvas')
  cv.width = cw; cv.height = L.H
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff'
  const g = cv.getContext('2d')
  g.fillStyle = '#F7F9FC'; g.fillRect(0, 0, cv.width, cv.height)
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i], icon = M.TRAFFIC_ICONS[k], x = 6 + i * colW
    // ① 实际大小：压在一条路网蓝线上（底图色 #F7F9FC + 路网 #1990FF），看得清才算能用
    g.fillStyle = '#1990FF'; g.fillRect(x - 6, L.iconTop + d / 2 - 1, d + 30, 3)
    if (icon.mode === 'mask') {
      // 遮罩模式：四个状态色各画一枚 —— 这就是地图上会看到的四种（L7 用纹理蓝通道当遮罩填图层色）
      for (let s = 0; s < states.length; s++) g.drawImage(tinted(imgs[k], stateHex[states[s]]), x + s * (d + 4), L.iconTop, d, d)
    } else {
      g.drawImage(imgs[k], x, L.iconTop, d, d)   // 原色模式：图层色＝白 ⇒ 直接出 emoji 本色
    }
    g.fillStyle = '#1A2233'; g.font = '600 12px sans-serif'
    g.fillText(icon.char + ' ' + icon.label, x, L.title)   // 短标题：带「（遮罩染色）」后缀会横向压到下一列
    g.fillStyle = '#8C9AB0'; g.font = '10px sans-serif'
    g.fillText('实际 ' + d + 'px' + (icon.mode === 'mask' ? ' ×4 状态色' : ' 原色'), x, L.sizeLabel)
    // ② ZOOM 倍放大 ——「这么小还看不看得出来」全靠这一栏
    g.drawImage(icon.mode === 'mask' ? tinted(imgs[k], stateHex.green) : imgs[k], x, L.zoomTop, z, z)
    /* ③ 缩小时的聚合桶：用户 2026-09-15「深色实心圆 + 居中白数字不要，缩小后还是 emoji」
     *   ⇒ 桶与散点画的是**同一枚 emoji、同一个尺寸**，所以这一栏就是并排两枚一模一样的图标。
     *   并排是为了让「一样」这件事在预览图上一眼可查（也方便以后有人改回圆盘时立刻看出来）。 */
    const bucket = icon.mode === 'mask' ? tinted(imgs[k], stateHex.green) : imgs[k]
    g.drawImage(icon.mode === 'mask' ? tinted(imgs[k], stateHex.green) : imgs[k], x, L.dotMid - d / 2, d, d)
    g.drawImage(bucket, x + d + 6, L.dotMid - d / 2, d, d)
    g.fillStyle = '#8C9AB0'; g.font = '10px sans-serif'
    g.fillText('散点 = 聚合桶', x + 2 * d + 12, L.dotMid + 4) // 标签要短：列距只有 z+12，写长了会压到下一列
    // ④ 实时数据栏的 15px 小图标：面板渲染的就是这个字符本身（TrafficGlyph.vue）
    g.font = '15px ' + FONT_EMOJI
    g.textBaseline = 'middle'; g.fillStyle = '#000'
    g.fillText(M.TRAFFIC_GLYPHS[k].char, x, L.panelMid)
    g.textBaseline = 'alphabetic'; g.fillStyle = '#8C9AB0'; g.font = '10px sans-serif'
    g.fillText('面板小图标', x + 18, L.panelMid + 4)
  }
  document.body.appendChild(cv)
  return JSON.stringify({ KEYS, 尺寸: Object.fromEntries(KEYS.map(k => [k, live[k].size])),
    W: cv.width, H: cv.height, d, z, colW, 左起: 6, 落款: L })
})()`
const drew = await ev(draw)
console.log('页面内合成 →', drew)
if (typeof drew !== 'string' || drew.startsWith('<<')) { console.log('画布合成失败，见上面的错误'); ws.close(); process.exit(1) }
const layout = JSON.parse(drew)
await sleep(600)

/* 画布 fixed 在视口左上角：只截它那块，别把右下的地图带进来 —— 带进来了识图会去描述底图。
 * 用 CDP 自己的 clip（服务端裁，精确到像素）。本地的 cropZoom 是**正方形**裁且画面外留白、
 * 画面内照抄，画布 460×300 这种比例会连地图一起框进来（上一版就是靠 W=H 硬凑的）。
 * 裁完**回读尺寸断言**：clip 被忽略时会静默返回整屏 1440×900，正是要防的那种「看起来成功」。 */
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('logs/icon-preview-full.png', Buffer.from(shot.data, 'base64'))
const cut = await send('Page.captureScreenshot', {
  format: 'png', clip: { x: 0, y: 0, width: layout.W, height: layout.H, scale: 1 }
})
writeFileSync('logs/icon-preview.png', Buffer.from(cut.data, 'base64'))
const got = decodePNG(Buffer.from(cut.data, 'base64'))
if (got.width !== layout.W || got.height !== layout.H) {
  console.log(`裁切没生效：得到 ${got.width}×${got.height}，期望 ${layout.W}×${layout.H}（clip 被忽略？）`)
  ws.close(); process.exitCode = 1
} else {
  console.log(`saved logs/icon-preview.png (${got.width}×${got.height}) + icon-preview-full.png`)
}

/* 相邻列的放大块之间必须是一条**干净缝**。列距按画布宽度均分就会叠（踩过），
 * 而且**肉眼/识图都看不出来** —— 只表现为「隔壁列的深色块」混进来。
 * 所以不靠结构保证，直接在成品图上量：缝里应是纯底色。 */
const isBg = (p) => Math.abs(p[0] - 247) < 8 && Math.abs(p[1] - 249) < 8 && Math.abs(p[2] - 252) < 8
const y0 = Math.round(layout.落款.zoomTop), y1 = y0 + layout.z
let dirty = 0
for (let c = 1; c < layout.KEYS.length; c++) {
  const gapL = layout.左起 + c * layout.colW - 10 // 缝：上一列放大块右缘(z 结束) 到 本列 x
  for (let y = y0; y < y1; y++) for (let x = gapL; x < gapL + 8; x++) {
    const i = (y * got.width + x) * 4
    if (!isBg([got.rgba[i], got.rgba[i + 1], got.rgba[i + 2]])) dirty++
  }
}
if (dirty) { console.log(`放大块压到隔壁列了：缝里有 ${dirty} 个非底色像素`); process.exitCode = 1 }
else console.log(`四列放大块互不重叠（${layout.KEYS.length - 1} 条缝全干净）`)

/* 收尾顺序照抄 probe17：先让 CDP 关标签页，再 ws.close()，最后只设 exitCode。
 * 反过来（ws.close() 之后还有 await，再 process.exit()）会在 libuv 里撞上
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" —— 关 socket 与退出抢同一个 async handle。 */
try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
ws.close()
process.exitCode = 0
