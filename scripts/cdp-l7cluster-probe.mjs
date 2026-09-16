/* 一次性实验（**前置门槛**，不进产品代码）：把「L7 自带聚合 + 桶上数字 + 三层叠画符号」
 * 在真地图上各验一遍 —— 它们决定 trafficIcons.js / initTrafficLayers.js 怎么写。
 *
 * 读 L7 2.15.2 源码（node_modules/@antv/l7-layers|core|source）得到的四条硬约束：
 *   ① 图标着色器是 `step(0.01, textureColor.z) * v_color`（拿纹理**蓝通道**当二值遮罩）
 *      ⇒ 遮罩分支里 **纹理 alpha 完全不参与**，任何「带透明度的图」都会被切成硬边。
 *      想保留纹理 alpha（柔和投影、抗锯齿）只能让图层色**精确等于纯白** → 走
 *      `gl_FragColor = textureColor` 原色分支。所以：
 *        · 白底板/阴影层 → `.color('#FFFFFF')`（必须 6 位满值，d3 插值出来的白不算）
 *        · 阴影图**自己画成深色带 alpha**，而不是「蓝色 + 35% alpha」
 *        · 徽章本体要按状态换色 → 只能留在遮罩分支（硬边，和现有图标一致）
 *   ② `.size(field, cb)` 的回调**只收到字段值**，字段不存在时收到 0 个参数 ⇒ 回调必须恒返回数字
 *   ③ `.filter(field, cb)` 在 encodeData 之前过滤（不画、不参与拾取、不占纹理格），
 *      且不动 `size` 属性形态 ⇒ **比 size 回调更优**（避免改 cdp-probe14 读到的属性结构）
 *   ④ 单点也有 `point_count = 1`（source.js 补的），而补的时机在首帧之后 ⇒
 *      过滤谓词要写 `!(n > 1)`，写 `n <= 1` 会把首帧的单点全滤掉（黑一下）
 *
 * 验的事（E0~E6）：
 *   E0 聚合成立：桶字段 / Σ桶内点数+散点数 == 原始要素数（不吞点）/ 首帧 point_count 时序
 *   E1 互斥显示：filter 路线（主）+ size 回调路线（备）**同屏带对照层**
 *   E3 数字：`.shape('point_count','text')` 能画出数字且 filter 只让桶有数字
 *   E5 三层叠画：白描边 + 白图形 + 柔和投影（像素扫描线 + 识图复核）
 *   E6 点击载荷：开聚合后 `e.feature.properties` 是否还在（现有 4 个 popup 全靠它）
 *
 * 用法：node scripts/cdp-l7cluster-probe.mjs （前置：pnpm dev(:5180) + headless Chrome(:9223)）
 * 产物：logs/l7cluster-*.png
 */
import { writeFileSync } from 'node:fs'
import { decodePNG, colorBlobs } from './lib/png.mjs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created?.webSocketDebuggerUrl) { console.log('无法创建标签页'); process.exit(1) }
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
let lastAction = '(启动)'
const send = (m, p = {}) => {
  lastAction = m + ' ' + JSON.stringify(p).slice(0, 120)
  return new Promise((r) => {
    const i = ++msgId; pending[i] = r
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
    setTimeout(() => { if (pending[i]) { delete pending[i]; console.log(`  ! 超时 ${m}`); r({}) } }, 20000)
  })
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    if (m.error) console.log(`  ! CDP ${m.error.message}`)
    pending[m.id](m.result); delete pending[m.id]
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (x) =>
  send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then((r) =>
    r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>'
      : r?.result?.value)
const evj = (x) => ev(x).then((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return s } })
const waitFor = async (expr, ms = 40000, step = 400) => { for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) } return false }
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const buf = Buffer.from(s.data, 'base64')
  writeFileSync(`logs/${name}.png`, buf)
  console.log(`  ·  截图 logs/${name}.png`)
  return decodePNG(buf)
}
/* 取 (x,y) 周围 patch 的像素：平均色 + 量化直方图 */
const patch = (img, cx, cy, r = 3) => {
  const hit = {}
  let rs = 0, gs = 0, bs = 0, n = 0
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue
      const o = (y * img.width + x) * 4
      const key = [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]].map((v) => Math.round(v / 24) * 24).join(',')
      hit[key] = (hit[key] || 0) + 1
      rs += img.rgba[o]; gs += img.rgba[o + 1]; bs += img.rgba[o + 2]; n++
    }
  }
  return { n, hist: hit, avg: n ? [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)] : null }
}
const px = (img, x, y) => { const o = (y * img.width + x) * 4; return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]] }
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
const hex2rgb = (h) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim()); return m ? [+('0x' + m[1]), +('0x' + m[2]), +('0x' + m[3])] : null }
const dist = (a, b) => { const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2], rm = (a[0] + b[0]) / 2; return Math.round(Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)) }
const near = (avg, hex, tol) => !!avg && dist(avg, hex2rgb(hex)) <= tol
const hasColor = (hist, hex, tol) => Object.keys(hist || {}).some((k) => dist(k.split(',').map(Number), hex2rgb(hex)) < tol)

let pass = 0, fail = 0
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`) }
}
const info = (l, v) => console.log(`  ·  ${l}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)

/* ---------- 原型图形（验证配方用；定稿按同样配方画 4 类 × 3 张） ---------- */
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`
/* ① 阴影：深色（不是蓝色！）+ 自身 alpha 0.38 + 高斯模糊，配 `.color('#FFFFFF')` 走原色分支 */
const SH_SVG = svg(`<defs><filter id="b" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="2.4"/></filter></defs>
  <g filter="url(#b)"><rect x="4" y="5.5" width="58" height="58" rx="17" fill="#101828" fill-opacity="0.38"/></g>`)
/* ② 白底板：实心无孔（有孔会一路透到底图）、纯白、外扩到 0..64 ⇒ 给徽章当白描边 */
const BG_SVG = svg('<rect x="0" y="0" width="64" height="64" rx="20" fill="#ffffff"/>')
/* ③ 徽章：圆角方块 + 镂空图形（evenodd）+ 图形内的次级细节填回来（呈徽章色）
      —— 摄像头：白机身 + 白取景框 + 彩色镜头 */
const BADGE_SVG = svg(`<path fill="#ffffff" fill-rule="evenodd" d="
    M20 3h24a17 17 0 0 1 17 17v24a17 17 0 0 1-17 17H20A17 17 0 0 1 3 44V20A17 17 0 0 1 20 3z
    M24 18h16v7H24z
    M18 28h28v14a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z"/>
  <circle cx="32" cy="37" r="6.2" fill="#ffffff"/>`)
/* 纯色圆（E1 对照/测试用），只为区分「桶」和「散点」 */
const DOT_SVG = svg('<circle cx="32" cy="32" r="30" fill="#ffffff"/>')

const FC = 'window.__FC'   // 注入到页面里的实验数据（探头 220 点）
/* supercluster zoom 空间 = floor(mapZoom - 1)（DataSourcePlugin 里定的）；map zoom 9.5 ⇒ 8 */
const CL = 'window.__clusters'
const BUCKET = `(f)=>!!(f.properties && (f.properties.cluster === true || (f.properties.point_count || 0) > 1))`
/* 地图可视区（避开左侧「实时数据」栏与底部工具栏）—— 所有像素统计都只在这个框里算 */
const CLIP = { x: 340, y: 110, width: 1230, height: 700 }

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      addEventListener('unhandledrejection',e=>window.__errs.push('REJ '+(e.reason?.message||e.reason)));
      try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'admin',display_name:'核验'}))}catch(e){}`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  check(await waitFor(`!!(window.__scene && window.__map && window.__l7 && window.__traffic)`), '地图 boot + __l7/__traffic 桥就绪')
  await sleep(2000)

  /* 取真数据（探头 220 点）当实验数据，随后关掉真图层，避免和临时层混在一起 */
  await ev(`window.__traffic.setVisible('camera', true)`); await sleep(900)
  const fc = await ev(`JSON.stringify(window.__traffic.registry.camera.layer.layerSource.originData)`)
  await ev(`window.__traffic.setVisible('camera', false)`); await sleep(400)
  if (typeof fc !== 'string' || fc.length < 100) { console.log('拿不到探头数据：', fc); process.exit(2) }
  await ev(`${FC} = ${fc}; window.__FCN = ${FC}.features.length`)
  info('实验数据要素数', await ev('window.__FCN'))
  info('原始要素 properties 键（看 lng/lat 在不在，popup 依赖）', await evj(`JSON.stringify(Object.keys(${FC}.features[0].properties))`))

  /* 注册实验图形（走产品同一条路：scene.addImage + .shape(图片名)） */
  const reg = await ev(`(async()=>{ const S=window.__scene
    const add = async (id,s)=>{ if(S.hasImage(id)) return; await S.addImage(id, 'data:image/svg+xml,'+encodeURIComponent(s)) }
    try{
      await add('x-sh', ${JSON.stringify(SH_SVG)})
      await add('x-bg', ${JSON.stringify(BG_SVG)})
      await add('x-badge', ${JSON.stringify(BADGE_SVG)})
      await add('x-dot', ${JSON.stringify(DOT_SVG)})
      return 'ok'
    }catch(e){ return 'err:'+e.message }})()`)
  check(reg === 'ok', '四个实验图形注册进 iconService（x-sh / x-bg / x-badge / x-dot）', reg)

  /* ================= E0 聚合 + 不吞点 + 首帧时序 ================= */
  console.log('\n===== E0 聚合：桶字段 / 对账 / 首帧 point_count =====')
  await evj(`(()=>{const {PointLayer}=window.__l7
    const l=new PointLayer({id:'e0',zIndex:60})
    l.source(${FC}, {cluster:true, clusterOptions:{radius:22, maxZoom:11}})
      .shape('circle').size(9).color('#ff00aa')
    window.__scene.addLayer(l); window.__e0=l
    return JSON.stringify({ok:true})})()`)
  await ev(`(()=>{window.__map.jumpTo({center:[118.05,36.81], zoom:9.5, pitch:0, bearing:0});return 'ok'})()`)
  await sleep(2500)
  /* 直接从 supercluster 取当前 zoom 的桶集（不依赖渲染管线），做权威对账 */
  await ev(`${CL} = (z)=>window.__e0.layerSource.clusterIndex.getClusters([-180,-90,180,90], z)`)
  const acc = await evj(`(()=>{const z=Math.floor(window.__map.getZoom()-1)
    const all=${CL}(z); let cl=0, sg=0, sum=0, leaves=0
    for(const f of all){ if(${BUCKET}(f)){ cl++; sum+=f.properties.point_count
        try{ leaves += window.__e0.layerSource.clusterIndex.getLeaves(f.properties.cluster_id, Infinity).length }catch(e){} }
      else { sg++; sum+=1 } }
    return JSON.stringify({zoom空间:z, 原始:${FC}.features.length, 桶数:cl, 散点数:sg, 合计:sum,
      getLeaves合计:leaves, 桶样例:all.filter(${BUCKET}).slice(0,3).map(f=>({pc:f.properties.point_count,id:f.properties.cluster_id,c:f.geometry.coordinates.map(v=>+v.toFixed(3))}))})})()`)
  info('E0 对账', acc)
  check(!!acc && acc.桶数 > 0, 'zoom 9.5 确实形成聚合桶', acc && { 桶数: acc.桶数, 散点数: acc.散点数 })
  check(!!acc && acc.合计 === acc.原始, `Σ桶内点数 + 散点数 == 原始要素数（${acc && acc.原始}，不吞点）`, acc && { 合计: acc.合计 })
  check(!!acc && acc.getLeaves合计 === acc.原始, 'getLeaves 反算 == 原始要素数（桶内明细可取，供 probe16 用）', acc && { getLeaves: acc.getLeaves合计 })
  const imgE0 = await shot('l7cluster-e0-agg')
  const blobsE0 = colorBlobs(imgE0, { x: 380, y: 180, width: 840, height: 540 }, '#ff00aa')
  info('E0 桶色像素块', { 块数: blobsE0.length, 前3块面积: blobsE0.slice(0, 3).map((b) => b.n) })
  check(blobsE0.filter((b) => b.n >= 100).length >= 2, '桶真的画到屏幕上（≥2 个成块，size 9 的圆约 250px²）', blobsE0.slice(0, 3).map((b) => b.n))

  /* 首帧时序：point_count 什么时候才出现（决定过滤谓词写法） */
  await ev(`(()=>{const l=window.__e0; window.__trace=[]; const t0=performance.now()
    const rec=(tag)=>{ const d=l.layerSource&&l.layerSource.data; const arr=(d&&d.dataArray)||[]
      window.__trace.push({tag, t:Math.round(performance.now()-t0), n:arr.length,
        有pc:(arr[0]&&('point_count' in arr[0]))?1:0, pc0:arr[0]&&arr[0].point_count, nf:d&&d.features?d.features.length:null}) }
    rec('立即'); setTimeout(()=>rec('100ms'),100); setTimeout(()=>rec('600ms'),600); setTimeout(()=>rec('2000ms'),2000)
    /* 再模拟一次「首帧」：重建图层后立刻读 */
    return 'ok'})()`)
  await sleep(2400)
  const trace = await evj(`JSON.stringify(window.__trace)`)
  info('首帧 point_count 时序（layerSource.data）', trace)
  check(!!trace && trace.some((t) => t.有pc === 1), '渲染后 dataArray 里能读到 point_count（过滤回调有值可判）', trace)
  check(!!trace && trace[0] && (trace[0].有pc === 1 || trace[0].n === 0), '首帧要么已补 point_count、要么数据尚未解析 ⇒ 谓词写 !(n>1) 兜底', trace && trace[0])

  /* ================= E1 互斥显示（filter 主路线 + size 回调备路线 + 对照层） ================= */
  console.log('\n===== E1 互斥显示：桶有气泡、散点只留图标 =====')
  await evj(`(()=>{const {PointLayer}=window.__l7
    /* 对照层：不聚合、固定尺寸 —— 每个原始点都该有它（绿），用来证明「取样点确实在屏上」 */
    const c=new PointLayer({id:'e1-ctl',zIndex:61})
    c.source(${FC}).shape('x-dot').size(4).color('#00cc44')
    window.__scene.addLayer(c); window.__e1c=c
    /* 主路线：filter 只留散点（红）—— 谓词 !(n>1) 兜住「字段还没补上」的首帧 */
    window.__fargs=[]
    const a=new PointLayer({id:'e1-filter',zIndex:62})
    a.source(${FC}, {cluster:true, clusterOptions:{radius:22, maxZoom:11}})
      .shape('x-dot').size(9)
      .filter('point_count', (n)=>{ window.__fargs.push(typeof n); return !(n>1) })
      .color('#ff2200')
    window.__scene.addLayer(a); window.__e1a=a
    /* 备路线：回调式尺寸，散点返回 0（黄） */
    window.__sargs=[]
    const b=new PointLayer({id:'e1-size',zIndex:63})
    b.source(${FC}, {cluster:true, clusterOptions:{radius:22, maxZoom:11}})
      .shape('x-dot').size('point_count', (n)=>{ window.__sargs.push(n); return n>1 ? 20 : 0 })
      .color('#ffcc00')
    window.__scene.addLayer(b); window.__e1b=b
    return JSON.stringify({ok:true})})()`)
  /* 取样缩放：R=22 在默认视图（zoom 9.5）会把探头并成 11 个桶、0 个散点，
   * 而「互斥」必须同屏同时有桶和散点 ⇒ 挪到 zoom 11.5（supercluster z10：约 31 桶 + 5 散）。
   * 中心必须对准数据（上一轮用 [118.05,36.81] 当中心，散点全被挤出视野 ⇒ 取样假失败）。 */
  const ctr = await evj(`(()=>{const fs=${FC}.features, pts=fs.map(f=>f.geometry.coordinates)
    let best=pts[0], bn=-1
    for(const p of pts){let k=0; for(const q of pts) if(Math.abs(p[0]-q[0])<0.012&&Math.abs(p[1]-q[1])<0.012) k++
      if(k>bn){bn=k;best=p}}
    return JSON.stringify({lng:+best[0].toFixed(5), lat:+best[1].toFixed(5), 邻居:bn})})()`)
  info('最密点（E1/E3/E5 的取样中心）', ctr)
  await ev(`(()=>{window.__map.jumpTo({center:[${ctr.lng},${ctr.lat}], zoom:11.5, pitch:0, bearing:0});return 'ok'})()`)
  await sleep(2700)
  const fargs = await evj(`JSON.stringify({n:window.__fargs.length, 类型:[...new Set(window.__fargs)], 前几个:window.__fargs.slice(0,6)})`)
  info('filter 回调收到的参数', fargs)
  check(!!fargs && fargs.类型.length > 0 && fargs.类型.every((t) => t === 'number'), 'filter 回调收到的是**数字字段值**（不是 feature 对象）', fargs && fargs.类型)
  const sargs = await evj(`JSON.stringify({n:window.__sargs.length, 类型:[...new Set(window.__sargs.map(v=>typeof v))], 大于1的:window.__sargs.filter(v=>v>1).slice(0,4)})`)
  info('size 回调收到的参数', sargs)
  check(!!sargs && sargs.类型.length > 0 && sargs.类型.every((t) => t === 'number'), 'size 回调收到的是**数字字段值**', sargs && sargs.类型)

  /* 注：不要用 `layerSource.data.dataArray.length` 判断 filter 是否生效 —— filter 在
   * encode 之前把 dataArray 裁成局部变量 filterData（DataMappingPlugin），不动 source 本身；
   * 上一轮据此读数得「filter 层 35 条」是**仪器错**，不是结论。真正可靠的仪器是像素差分（见下）。 */
  const spots = await evj(`(()=>{const z=Math.floor(window.__map.getZoom()-1); const all=${CL}(z)
    const bs=all.filter(${BUCKET}), sgs=all.filter(f=>!(${BUCKET})(f))
    if(!bs.length||!sgs.length) return JSON.stringify({err:'缺桶或缺散点', 桶:bs.length, 散点:sgs.length})
    const P=(c)=>{const p=window.__map.project([c[0],c[1]]); return {x:Math.round(p.x),y:Math.round(p.y)}}
    /* 必须取**屏幕内**的点（上一轮取到 y=-17 的散点，屏外 ⇒ 判定假失败） */
    const inView=(q)=> q.x>340 && q.x<1570 && q.y>110 && q.y<820
    const bp = bs.map(f=>({f, ...P(f.geometry.coordinates)})).find(inView)
    const sp = sgs.map(f=>({f, ...P(f.geometry.coordinates)})).find(inView)
    if(!bp||!sp) return JSON.stringify({err:'视口内缺桶或缺散点', 桶:bs.length, 散点:sgs.length})
    const inClip=(q)=> q.x>340 && q.x<1570 && q.y>110 && q.y<810
    return JSON.stringify({桶:{x:bp.x,y:bp.y, pc:bp.f.properties.point_count},
      散点:{x:sp.x,y:sp.y}, 桶数:bs.length, 散点数:sgs.length,
      视口内散点数: sgs.map(f=>P(f.geometry.coordinates)).filter(inClip).length})})()`)
  info('E1 取样点', spots)
  const imgE1 = await shot('l7cluster-e1-mutex')
  const pb = spots?.桶 && patch(imgE1, spots.桶.x, spots.桶.y, 4)
  const ps = spots?.散点 && patch(imgE1, spots.散点.x, spots.散点.y, 3)
  if (pb && ps) {
    info('桶中心 平均色/直方图', { avg: pb.avg, hist: pb.hist })
    info('散点中心 平均色/直方图', { avg: ps.avg, hist: ps.hist })
    /* 这两条只是「同屏观感」记录，**不是**互斥生效的证据（40px 气泡会把下面 18px 的图标整个盖住，
     * 「桶上没有红」可能只是遮挡）—— 真正的证据是下面各层单独的 A/B 差分。 */
    info('同屏观感：桶位置被气泡盖住 / 散点位置是图标色', { 桶: { 有红: hasColor(pb.hist, '#ff2200', 60), 有黄: near(pb.avg, '#ffcc00', 90) }, 散点: { 有红: hasColor(ps.hist, '#ff2200', 60) } })
    /* ===== 逐点判定：在该点周围 27×27 的小框里找「最大连通块」，按**形状**判，不按像素计数。
     * 三条实测教训（都在这套环境里量过，别再走回头路）：
     *  ① 差分不可用：什么都不改连拍两张，整屏就有 16 万像素不同（11%，见 logs 里的噪声实测），
     *     连「空位」框里都能差出 300px ⇒ 任何 A/B 差分都被噪声淹没。
     *  ② 计数不可用：同样因为噪声，框内计数 15~155 与「真有图标」的 300 只有 2 倍差，分不开。
     *  ③ 形状可用：真画了图标 ⇒ 框里出现一块 ~300px 的**连通**圆盘；噪声 ⇒ 只有零星 1~3px 碎点。
     *     「最大连通块」把两者拉开 5~10 倍，与底图颜色、渲染 alpha 都无关。
     * 阈值 15 与判据边界都是**实测定的**（logs/l7cluster-e1-*.png 上量的，空位最大 0~3px）：
     *     filter 层：桶位 0~19（无图标）/ 散点位 295~300（图标）
     *     size   层：桶位 729（气泡）/ 散点位 19~26（什么都没画）
     * 另：另一条路线的 40px 气泡会把同位置的 18px 图标整个盖住 —— 所以每条路线各拍一张单独的图。 */
    const boxBlob = (a, cx, cy, r = 13) => {
      const w = a.width, seen = new Set(), px = (x, y) => y * w + x
      const ink = (x, y) => {
        if (x < cx - r || x > cx + r || y < cy - r || y > cy + r) return false
        const i = px(x, y) * 4
        return Math.abs(a.rgba[i] - base.rgba[i]) + Math.abs(a.rgba[i + 1] - base.rgba[i + 1]) + Math.abs(a.rgba[i + 2] - base.rgba[i + 2]) > 15
      }
      let best = 0
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
        if (!ink(x, y) || seen.has(px(x, y))) continue
        let n = 0; const st = [[x, y]]; seen.add(px(x, y))
        while (st.length) {
          const [cxx, cyy] = st.pop(); n++
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cxx + dx, ny = cyy + dy
            if (ink(nx, ny) && !seen.has(px(nx, ny))) { seen.add(px(nx, ny)); st.push([nx, ny]) }
          }
        }
        if (n > best) best = n
      }
      return best
    }
    for (const n of ['__e1a', '__e1b', '__e1c']) await ev(`(()=>{window.${n}.hide();return 'ok'})()`)
    await sleep(800)
    const base = await shot('l7cluster-e1-base') // 三层全关（对照底图）
    const onLayer = async (name, tag) => {
      for (const n of ['__e1a', '__e1b', '__e1c']) await ev(`(()=>{window.${n}.hide();return 'ok'})()`)
      await sleep(700)
      await ev(`(()=>{window.${name}.show();return 'ok'})()`); await sleep(900)
      const img = await shot(`l7cluster-e1-${tag}-only`)
      await ev(`(()=>{window.${name}.hide();return 'ok'})()`); await sleep(200)
      return img
    }
    /* 取样点：视口内的桶与散点（各取前几个，互不重叠 —— 桶间距 ≥ 聚合半径 22px） */
    const samples = await evj(`(()=>{const z=Math.floor(window.__map.getZoom()-1); const all=${CL}(z)
      const P=(c)=>{const p=window.__map.project([c[0],c[1]]); return {x:Math.round(p.x),y:Math.round(p.y)}}
      const inV=(q)=>q.x>300&&q.x<1580&&q.y>100&&q.y<830
      const bs=all.filter(${BUCKET}).map(f=>Object.assign(P(f.geometry.coordinates),{pc:f.properties.point_count})).filter(inV)
      const ss=all.filter(f=>!(${BUCKET})(f)).map(f=>P(f.geometry.coordinates)).filter(inV)
      return JSON.stringify({桶:bs.slice(0,6), 散点:ss.slice(0,4), 视口内桶数:bs.length, 视口内散点数:ss.length})})()`)
    info('E1 逐点取样', samples)
    const imgF = await onLayer('__e1a', 'filter')
    const imgS = await onLayer('__e1b', 'size')
    await ev(`(()=>{window.__e1a.show(); window.__e1c.show(); return 'ok'})()`); await sleep(500)
    const atBucket = (img) => (samples.桶 || []).map((q) => boxBlob(img, q.x, q.y))
    const atSingle = (img) => (samples.散点 || []).map((q) => boxBlob(img, q.x, q.y))
    const fB = atBucket(imgF), fS = atSingle(imgF), sB = atBucket(imgS), sS = atSingle(imgS)
    info('框内最大连通墨迹（真图标 ≈300，真气泡 ≈730，真空位 ≤20）', { filter层: { 桶: fB, 散点: fS }, size层: { 桶: sB, 散点: sS } })
    check(fB.length > 0 && Math.max(...fB) <= 60, `filter 路线在桶的位置上**什么都没画**（${fB.length} 个桶位置最大连通块 ${Math.max(0, ...fB)}px，不是图标形状）`, fB)
    check(fS.length > 0 && Math.min(...fS) >= 150, `filter 路线在散点位置上画了图标（${fS.length} 个散点最小连通块 ${fS.length ? Math.min(...fS) : 0}px ≈ 图标面积）`, fS)
    check(sB.length > 0 && Math.min(...sB) >= 300, `size 路线在桶的位置上画了气泡（${sB.length} 个桶最小连通块 ${sB.length ? Math.min(...sB) : 0}px ≈ 气泡面积）`, sB)
    check(sS.length > 0 && Math.max(...sS) <= 60, `size 路线在散点位置上**什么都没画**（size 回调返回 0 真的不渲染，${sS.length} 个散点最大连通块 ${Math.max(0, ...sS)}px）`, sS)
    /* 全局旁证：气泡层画出来的块全是大块（若 size 0 退化成默认尺寸，会出现 18px 的碎块） */
    const amberBlobs = colorBlobs(imgS, CLIP, '#ffcc00')
    const aMin = amberBlobs.length ? Math.min(...amberBlobs.map((b) => b.n)) : 0
    info('黄块（应≈桶气泡，全图）', { 块数: amberBlobs.length, 最大: Math.max(0, ...amberBlobs.map((b) => b.n)), 最小: aMin })
    check(amberBlobs.length >= 2 && aMin >= 100, '气泡层画出来的块**全是大块**（没有 18px 散点图标那种小块）', { 块数: amberBlobs.length, 最小块: aMin })
  } else { check(false, 'E1 取样点齐全', spots) }

  /* ================= E3 桶上数字 ================= */
  console.log('\n===== E3 桶上的数量文字 =====')
  const e3 = await evj(`(()=>{const {PointLayer}=window.__l7
    const t=new PointLayer({id:'e3',zIndex:64})
    t.source(${FC}, {cluster:true, clusterOptions:{radius:22, maxZoom:11}})
      .shape('point_count', 'text')
      .size(13).color('#ff00ff')
      .filter('point_count', (n)=> !(n>1) ? false : true)
      .style({textAllowOverlap:true, textAnchor:'center', textOffset:[0,0], fontWeight:700})
    window.__scene.addLayer(t); window.__e3=t
    return JSON.stringify({ok:true})})()`)
  info('建 E3 文字层', e3)
  await sleep(2700)
  const e3type = await ev(`(()=>{try{ const t=window.__e3; return String((t.getModelType&&t.getModelType())||'?') }catch(e){ return 'err:'+e.message }})()`)
  info('E3 图层模型类型', e3type)
  check(e3type === 'text', '文字层模型类型是 text（数字真的走文字渲染）', e3type)
  const imgE3 = await shot('l7cluster-e3-text')
  if (spots?.桶 && spots?.散点) {
    const atBucket = patch(imgE3, spots.桶.x, spots.桶.y, 5)
    const atSingle = patch(imgE3, spots.散点.x, spots.散点.y, 3)
    info('桶中心直方图', atBucket.hist)
    info('散点中心直方图', atSingle.hist)
    check(hasColor(atBucket.hist, '#ff00ff', 90), '桶的位置出现洋红像素（数字画出来了）', atBucket.hist)
    check(!hasColor(atSingle.hist, '#ff00ff', 90), '散点的位置没有洋红（filter 把单点的「1」滤掉了）', atSingle.hist)
  } else { check(false, 'E3 取样点齐全', spots) }

  /* ================= E5/E4 三层叠画符号 ================= */
  console.log('\n===== E5 三层叠画：白描边 + 白图形 + 柔和投影 =====')
  await evj(`(()=>{const {PointLayer}=window.__l7
    const mk=(id,shape,size,color,zi)=>{ const l=new PointLayer({id, zIndex:zi})
      l.source(${FC}).shape(shape).size(size).color(color); window.__scene.addLayer(l); return l }
    /* 尺寸：徽章 9（=定稿 size，墨迹 16.3px）；底板 9.75（墨迹 19.5px）⇒ 白描边约 1.5px；
     * 阴影 10.25 再模糊 —— 上一轮底板与徽章同为 10，白边被完全盖住，扫描线上只剩「紫里一点白」。 */
    window.__x_sh = mk('x-sh','x-sh',11,'#FFFFFF',70)    /* 阴影：深色图 + 纯白图层色 ⇒ 原色分支 ⇒ 保留纹理 alpha */
    window.__x_bg = mk('x-bg','x-bg',10.5,'#FFFFFF',71)  /* 白底板：纯白 ⇒ 原色分支（抗锯齿）*/
    window.__x_bd = mk('x-bd','x-badge',9,'#7C4DFF',72)  /* 徽章：状态色 ⇒ 遮罩分支（硬边，和现有图标一致） */
    return JSON.stringify({ok:true, 顺序:['sh(70)','bg(71)','badge(72)']})})()`)
  await ev(`(()=>{window.__map.jumpTo({center:[${ctr.lng},${ctr.lat}], zoom:16, pitch:0, bearing:0});return 'ok'})()`)
  await sleep(2700)
  const imgE5 = await shot('l7cluster-e5-symbol')
  const one = await evj(`(()=>{const P=window.__map.project([${ctr.lng},${ctr.lat}]); return JSON.stringify({x:Math.round(P.x),y:Math.round(P.y)})})()`)
  const seq = []
  for (let dx = -16; dx <= 16; dx++) {
    const c = px(imgE5, one.x + dx, one.y)
    seq.push({ dx, c, 紫: dist(c, hex2rgb('#7C4DFF')) < 75, 白: c[0] > 228 && c[1] > 228 && c[2] > 228, 深: lum(c) < 120 })
  }
  const line = (a) => a.map((s) => `${s.dx}:${s.紫 ? '紫' : s.白 ? '白' : s.深 ? '深' : '·'}`).join(' ')
  info('过中心水平扫描线', line(seq))
  const purple = seq.filter((s) => s.紫).length, white = seq.filter((s) => s.白).length
  check(purple > 0, '扫描线上有徽章色（徽章本体在画）', purple)
  check(white > 0, '扫描线上有**纯白**像素（白描边/白图形 —— 单色遮罩做不到，证明叠画成立）', white)
  const firstPurple = seq.findIndex((s) => s.紫)
  const lastPurple = seq.length - 1 - [...seq].reverse().findIndex((s) => s.紫)
  const outerR = seq.slice(lastPurple + 1), outerL = seq.slice(0, firstPurple)
  /* 两侧都要看：底板 sprite 21px（奇数）与徽章 18px（偶数）中心差半像素，
   * 左右白边落在不同采样格上（上一轮右侧全判成「·」，左侧 -10 才是白）。 */
  check(outerR.some((s) => s.白) || outerL.some((s) => s.白),
    '徽章色之外还有白像素 ⇒ 白描边在徽章外侧', { 左: line(outerL), 右: line(outerR) })
  /* 阴影判据用 A/B：同像素「开阴影 vs 关阴影」比 —— 底图本身有绿地/道路，
   * 拿「上方 patch」当对照会被底图颜色带偏（上一轮上方是绿地，判据假失败）。 */
  const shOn = patch(imgE5, one.x + 2, one.y + 10, 2)
  await ev(`(()=>{window.__x_sh.hide(); return 'ok'})()`)
  await sleep(900)
  const imgE5b = await shot('l7cluster-e5-noshadow')
  await ev(`(()=>{window.__x_sh.show(); return 'ok'})()`)
  await sleep(700)
  /* 沿垂直扫描线找「关阴影后变亮最多」的 dy：阴影只在徽章下缘露出 1~2px，
   * 固定取样点很容易取空（上一轮取 dy=13，已在阴影之外 ⇒ 差 0，假失败） */
  let best = { dy: null, d: -999 }
  for (let dy = -14; dy <= 16; dy++) {
    const a = px(imgE5, one.x + 2, one.y + dy), b = px(imgE5b, one.x + 2, one.y + dy)
    const d = Math.round(lum(b) - lum(a))
    if (d > best.d) best = { dy, d, 开: a, 关: b }
  }
  info('垂直扫描线最大「关阴影变亮」处', best)
  check(best.d >= 8, `关阴影后 dy=${best.dy} 变亮 ${best.d} ⇒ 投影确实画在徽章下缘`, best)
  check(!!best.开 && lum(best.开) > 60, '投影是**半透明**的（不是硬黑块，luma>60）', best.开 && Math.round(lum(best.开)))
  /* 出 8 倍放大图供识图复核（1600×900 里的 20px 符号，vision 看不清细节）——
   * 用 CDP 自带的 clip.scale 放大截图，省掉自己写 PNG 编码器 */
  const s8 = await send('Page.captureScreenshot', { format: 'png', clip: { x: one.x - 26, y: one.y - 26, width: 52, height: 52, scale: 8 } })
  if (s8?.data) { writeFileSync('logs/l7cluster-e5-zoom.png', Buffer.from(s8.data, 'base64')); info('8 倍放大图 logs/l7cluster-e5-zoom.png（供识图复核）', { at: one }) }

  /* ================= E6 点击载荷（开聚合后 popup 还活不活） ================= */
  console.log('\n===== E6 点击载荷：e.feature.properties 还在吗 =====')
  const payload = await evj(`(()=>{const l=window.__e1a; const s=l.layerSource
    const z=Math.floor(window.__map.getZoom()-1); const sg=${CL}(z).filter(f=>!(${BUCKET})(f))
    const out={单点getClusters键:sg[0]?Object.keys(sg[0].properties||{}).slice(0,16):null}
    try{ const f=s.getFeatureById(0); out.getFeatureById_0={有properties:!!(f&&f.properties), 键:f?Object.keys(f).slice(0,14):null} }catch(e){ out.getFeatureById_0='err:'+e.message }
    return JSON.stringify(out)})()`)
  info('E6 载荷', payload)
  const clickTarget = await evj(`(()=>{const z=Math.floor(window.__map.getZoom()-1)
    const sg=${CL}(z).filter(f=>!(${BUCKET})(f)); if(!sg.length) return JSON.stringify({err:'无散点'})
    const c=sg[0].geometry.coordinates
    window.__clicks=[]
    window.__e1a.on('click',(e)=>{ try{ window.__clicks.push({有properties:!!(e.feature&&e.feature.properties),
      键:e.feature?Object.keys(e.feature).slice(0,18):null,
      扁平取值:{name:e.feature&&e.feature.name, lng:e.feature&&e.feature.lng, lat:e.feature&&e.feature.lat}}) }catch(err){ window.__clicks.push({err:err.message}) } })
    window.__map.jumpTo({center:c, zoom:16, pitch:0, bearing:0})
    return JSON.stringify({c:c.map(v=>+v.toFixed(5))})})()`)
  await sleep(2600)
  const pos = await evj(`(()=>{const P=window.__map.project(${JSON.stringify([clickTarget?.c?.[0] ?? 118.05, clickTarget?.c?.[1] ?? 36.81])}); return JSON.stringify({x:Math.round(P.x),y:Math.round(P.y)})})()`)
  info('点击目标/屏幕位置', { clickTarget, pos })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', clickCount: 0 })
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1300)
  const clicks = await evj(`JSON.stringify(window.__clicks||[])`)
  info('真点击收到的载荷', clicks)
  check(!!clicks && clicks.length > 0, '点在散点图标上确实触发了 click（拾取可用）', clicks)
  if (clicks && clicks.length) {
    const c0 = clicks[0]
    check(c0.有properties === true || (c0.扁平取值 && c0.扁平取值.name !== undefined), '载荷里有业务字段可取（有 .properties 或扁平对象）', c0)
    check(!!c0.扁平取值 && c0.扁平取值.lng !== undefined, '扁平形态下 lng/lat 仍直接可取（现有 popup 用 p.lng/p.lat）', c0 && c0.扁平取值)
  }

  const errs = await evj(`JSON.stringify((window.__errs||[]).slice(0,6))`)
  check((errs || []).length === 0, '全程无运行时错误', errs)

  console.log(`\n===== 实验汇总：${pass} 通过 / ${fail} 失败 =====`)
  console.log('看图：logs/l7cluster-e0-agg.png（聚合）· e1-mutex.png（互斥+对照）· e3-text.png（数字）· e5-symbol.png（三层符号）')
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
  ws.close()
  clearTimeout(watchdog)
  process.exit(fail ? 1 : 0)
}

/* 看门狗：卡住时至少把最后一步打出来（本项目踩过「探针挂 600s 且无痕迹」的坑） */
const watchdog = setTimeout(() => { console.log(`
!! 实验超时，最后一步：${lastAction}`); process.exit(3) }, 240000)
