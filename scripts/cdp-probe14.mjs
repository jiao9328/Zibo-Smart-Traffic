/* 定向回归：任务1「实时数据每类图层的图标要醒目、互相区分、不能太大、不能撞底图路网的蓝」。
 *
 * 分两层验：
 *   A 配置层 —— 直接读 L7 实例的 layerConfig，断言每层的 shape / size / color 就是规范里的那套；
 *   B 视觉层 —— 逐层单独打开、飞到该层数据密集处截图（人工/识图复核形状是否真的画出来了）；
 * 再加客观判据：所有图层用色与底图总道路蓝 #1990FF 的 redmean 色差（≥120）、层与层之间色相 ≥25°，
 * 避免「看起来像蓝」的主观争论。
 *
 * 前置：本项目的 dev 服务器在 **5173**、Chrome headless --remote-debugging-port=9223
 * 用法：APP_PORT=5173 node scripts/cdp-probe14.mjs
 *   ★ 必须显式带上 APP_PORT —— 本文件的默认值 5180 是「单页 demo」那套的端口，漏了会
 *     整轮 boot 失败、后面几十条全红，看起来像把符号改坏了（踩过一次，教训在案）。
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { decodePNG, classifyPixels } from './lib/png.mjs'
import { TRAFFIC_ICONS } from '../src/tools/trafficIcons.js'

/* 底图路网（L7 的「淄博道路」）覆盖范围：只画了淄博市区一带，区县点（如临淄的信号灯）压根不在
 * 路网上。取样点若落在范围外，「图标 vs 路网蓝」这一条就无从谈起 —— 取样时优先挑范围内的点，
 * 实在挑不到就明确记录「本条跳过」，而不是悄悄放过。 */
const require = createRequire(import.meta.url)
const ROAD_FEATURES = require('../src/assets/GIS_Data/Zibo_roads.json').features
const ROAD_BOX = (() => {
  const b = { minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity }
  for (const f of ROAD_FEATURES) {
    const g = f.geometry
    const ls = g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates
    for (const p of ls) {
      if (p[0] < b.minx) b.minx = p[0]
      if (p[0] > b.maxx) b.maxx = p[0]
      if (p[1] < b.miny) b.miny = p[1]
      if (p[1] > b.maxy) b.maxy = p[1]
    }
  }
  return b
})()
// 放宽约 1km（0.01°纬 ≈ 1.1km），贴着边界的那一屏其实还能看见路网
const onRoadNet = ([lng, lat]) =>
  lng >= ROAD_BOX.minx - 0.01 && lng <= ROAD_BOX.maxx + 0.01 &&
  lat >= ROAD_BOX.miny - 0.01 && lat <= ROAD_BOX.maxy + 0.01

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const ROAD_BLUE = '#1990FF' // 底图总道路色（initLayer.js）

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
    // CDP 命令失败时只有 m.error、result 是 undefined：静默吞掉就会变成「读到一堆 undefined」
    // 的假失败（本文件踩过一次），所以这里统一吭一声再把 result 交回去
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

let pass = 0, fail = 0
const fails = []
const skipped = [] // 因环境不具备而明确跳过的判据（不是「通过」，汇总里单列）
const check = (ok, label, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; fails.push(label); console.log(`  ❌ ${label}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`) }
}
const info = (l, v) => console.log(`  ·  ${l}${v !== undefined ? ' → ' + JSON.stringify(v) : ''}`)
const waitFor = async (expr, ms = 40000, step = 400) => {
  for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step) }
  return false
}

/* 颜色工具：hex → HSL 色相（层与层之间比色相）+ redmean 加权 RGB 距离（跟底图蓝比「像不像」）。
 *
 * 为什么不用裸 RGB 距离：浅蓝和深蓝的 RGB 距离可能比蓝和紫还大，量「视觉上像不像」不靠谱。
 * 为什么光比色相也不够：青绿 #0E9AA7 与路网蓝 #1990FF 只差 24°，单看色相会误判成「同色」；
 * redmean 把明度权重算进去，结论才和肉眼一致（识图复核：青绿线路与蓝色路网一眼可分）。
 * 参考值：路网蓝 vs 原警员蓝 #3d7bff ≈ 68、vs 原公交站青 #00c2ff ≈ 106（这两个实测就是糊在一起），
 *        vs 现在的青绿 #0E9AA7 ≈ 152。阈值取 120。 */
const HUE = `window.__cm=window.__cm||{
  hex(h){const m=/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h).trim())
    return m?[parseInt(m[1],16),parseInt(m[2],16),parseInt(m[3],16)]:null},
  hsl(h){const c=this.hex(h); if(!c) return null
    const r=c[0]/255,g=c[1]/255,b=c[2]/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,l=(mx+mn)/2
    if(!d) return {h:null,s:0,l:+l.toFixed(2)}
    let x
    if(mx===r) x=((g-b)/d)%6; else if(mx===g) x=(b-r)/d+2; else x=(r-g)/d+4
    x*=60; if(x<0) x+=360
    return {h:Math.round(x),s:+(d/(1-Math.abs(2*l-1))).toFixed(2),l:+l.toFixed(2)}},
  dist(a,b){const x=this.hex(a),y=this.hex(b); if(!x||!y) return null
    const dr=x[0]-y[0],dg=x[1]-y[1],db=x[2]-y[2],rm=(x[0]+y[0])/2
    return Math.round(Math.sqrt((2+rm/256)*dr*dr+4*dg*dg+(2+(255-rm)/256)*db*db))},
  hueDist(a,b){const x=this.hsl(a),y=this.hsl(b); if(!x||!y||x.h===null||y.h===null) return null
    let d=Math.abs(x.h-y.h); if(d>180) d=360-d; return Math.round(d)}
}`

/* 每层规范：形状（图标 id）直接从源码 import —— 抄一份放这儿迟早会跟实现漂移，
 * 图标 id 改名后探针还照样「通过」，那就等于没验。size/颜色仍写在这里（断言要有独立预期）。
 *
 * ★ 2026-09-15 起符号换成 emoji 位图（用户「尽量图层点符号都用对应的简单的小 emoji」）：
 *   · size 四层统一 = SYMBOL 9（屏幕 18px），不再是「一层一个尺寸」；
 *   · 「互相区分」的手段**从颜色换成了字形**：三层走原色分支（图层色恒为 '#FFFFFF'，
 *     只是「放行纹理原色」的开关，不是画出来的颜色），四层靠 📹/👮/🚏/🚦 的形状区分。
 *     所以下面 B 段不再拿点位层的主色两两比 —— 那是上一版（手绘彩色徽章）的判据，现在恒同色。
 *   · 点符号**真的画到屏幕上了吗**由 scripts/cdp-probe17.mjs 的 H 段逐要素数渲染像素来验
 *     （信号灯剪影的状态色是底图里不存在的色，命中即图标），C 段因而只留线图层。 */
const SPEC = {
  camera: { shape: TRAFFIC_ICONS.camera.id, size: [8, 10], colors: ['#FFFFFF', '#F04438'] },
  trafficLight: { shape: TRAFFIC_ICONS.trafficLight.id, size: [8, 10], colors: ['#12B76A', '#F04438', '#F79009', '#8C9AB0'] },
  police: { shape: TRAFFIC_ICONS.police.id, size: [8, 10], colors: ['#FFFFFF'] },
  busStop: { shape: TRAFFIC_ICONS.busStop.id, size: [8, 10], colors: ['#FFFFFF'] },
  busRoute: { shape: 'line', size: [1, 4], colors: ['#0E9AA7'] }
}
const ALL = Object.keys(SPEC)
const POINT_KEYS = ['camera', 'trafficLight', 'police', 'busStop']
/* 视觉层（C 段）只跑线图层：点位层的图层色是白，而亮色底图整片都接近白，
 * 按色数像素会把底图全算进来（假通过）。点位层的渲染证据在 probe17 H 段。 */
const VISUAL_KEYS = ['busRoute']
const MIN_DIST = 120 // redmean 距离：低于此值就当作「和路网同色」

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];addEventListener('error',e=>window.__errs.push('ERR '+(e.error?.message||e.message)));
      try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'admin',display_name:'核验'}))}catch(e){}`
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  check(await waitFor(`!!(window.__map && window.__scene && window.__traffic)`), '地图 boot + __traffic 桥就绪')
  await sleep(1500)

  /* ---------- A 配置层：逐层开、读 L7 实例的真实样式 ----------
   * ★ 别用 getLayerConfig()：它返回的是「默认配置」（shape:circle / size:10），
   *   我们设的 shape/size/color 根本不在那儿 —— shape 在 layer.shapeOption，
   *   size/color 在 configService.getAttributeConfig(id)，style() 的项在 rawConfig。
   *   （第一版探针就栽在这儿：所有层都被读成 circle+10，全是假失败。） */
  console.log('\n===== A 图层配置（shape / size / color） =====')
  const READ = (n) => `(()=>{const it=window.__traffic.registry[${JSON.stringify(n)}]
    if(!it||!it.layer) return JSON.stringify({err:'no-layer'})
    const l=it.layer
    const a=(l.configService&&l.configService.getAttributeConfig(l.id))||{}
    // 单参调用时值存在 field 上（.size(4.5) / .color('#fff')），
    // 双参调用时存在 values（.color('status', fn) 的 fn 要喂样本再取值）
    const val=(k)=>{const o=a[k]; if(!o) return null
      if (typeof o.values==='function') { const out={}
        for(const s of ['normal','fault','green','red','yellow','unknown']) { try{out[s]=o.values(s)}catch(e){out[s]='err'} }
        return {field:o.field, byValue:out} }
      if (o.values!==undefined) return {field:o.field, values:o.values}
      return o.field}
    // shape 走同一条 configService 通路，但 layer.shapeOption 读起来更直接
    const shape=(l.shapeOption&&l.shapeOption.field)||val('shape')
    /* ★ 点位层的 size 现在是**常量** .size(SYMBOL)：散点和聚合桶画同一枚 emoji、同一个大小
     *   （用户 2026-09-15 推翻了「深色实心圆 + 居中白数字」）。常量写法下 L7 把值放在 attributes
     *   上、没有 field，落在 .values 还是 .field 上不定，两个都读。 */
    const sz=a.size
    const sizeV=(sz&&typeof sz.values!=='function')?(sz.values!==undefined?sz.values:sz.field):null
    return JSON.stringify({shape, size:val('size'), sizeV, color:val('color'),
      stroke:(l.rawConfig||{}).stroke, strokeWidth:(l.rawConfig||{}).strokeWidth,
      n:(l.layerSource&&l.layerSource.originData&&l.layerSource.originData.features||[]).length})})()`

  const conf = {}
  for (const n of ALL) {
    await ev(`window.__traffic.setVisible(${JSON.stringify(n)}, true)`)
    await sleep(600)
    const raw = await evj(READ(n))
    conf[n] = raw
    info(n, raw)
    check(!!raw && !raw.err, `${n} 图层实例存在`, raw)
    if (!raw || raw.err) continue

    const spec = SPEC[n]
    check(String(raw.shape) === spec.shape, `${n} 形状 = ${spec.shape}`, raw.shape)
    /* 图标层必须真的走图片模型：shape 名不认识时 L7 会**静默退化成文字渲染**
     * （point/index.js 的 iconMap 兜底是 'text'），只断言 shape 名对是抓不住这个的 */
    if (n !== 'busRoute') {
      const mt = await ev(`(()=>{try{return String(window.__traffic.registry[${JSON.stringify(n)}].layer.getModelType())}catch(e){return 'err:'+e.message}})()`)
      check(mt === 'image', `${n} 渲染模型 = image（图标真的被当成图片画，不是退化文字）`, mt)
      /* ★ 上面那条只能证明「按当前数据算出来应该是 image」，证明不了「**绑定**的就是图片模型」：
       *   getModelType() 是每次现算的，而模型实例是建层那一刻按当时的数据定的。实测踩过这个坑 ——
       *   在默认视图（散点 0 个）建层时 getModelType() 返回 'normal'，绑定的就是普通方块模型，
       *   而之后放大到 15 再问 getModelType() 它会回答 'image'，方块却已经绑死了（一直画方块）。
       * 所以必须读**绑定的那个模型实例**（layer.models[0]）本身。
       *
       * ★★ 读法：不能读类名。这个打包（vite 预打包）把重名类都加了数字尾巴 —— 实测
       *   PointLayer2 / Scene2 / 而**四个模型实例的类名全是 'ReglModel2'**：
       *   产品图标层（真图片模型）、形状 'circle' 的层、以及拿 .filter() 把记录清空的那个 bug 形态，
       *   三者类名一字不差（tmp-model2 实测）。所以类名是恒真的废读数，只能读**着色器装了什么**：
       *   图片模型（point/models/image.js）带 u_texture（图集）+ u_textSize（格子尺寸）两个 uniform，
       *   方块/填充模型没有。实测对照：图标+size 回调 → ['u_dataTexture','u_texture','u_textSize']（36 个）；
       *   'circle' → ['u_dataTexture']（40 个）；.filter() 清空记录的那个 → **一个都没有**（18 个）。
       *   这条不恒真：模型一旦退化成方块，这两个键就消失 ⇒ 失败。 */
      const bound = await evj(`(()=>{const l=window.__traffic.registry[${JSON.stringify(n)}].layer
        try{ const m=(l.models||[])[0]
          if(!m) return JSON.stringify({模型:'无',模型数:(l.models||[]).length})
          const us=Object.keys(m.uniforms||{})
          return JSON.stringify({模型:m.constructor.name, u_texture:us.indexOf('u_texture')>=0,
            u_textSize:us.indexOf('u_textSize')>=0, 键数:us.length})
        }catch(e){ return JSON.stringify({err:e.message}) }})()`)
      check(!!bound && bound.u_texture === true && bound.u_textSize === true,
        `${n} **绑定**的模型是图片模型（着色器带 u_texture + u_textSize；退化成方块模型时这两个键就没了）`, bound)
    }
    const szMain = typeof raw.sizeV === 'number' ? raw.sizeV : raw.size
    const sizeOk = typeof szMain === 'number' && szMain >= spec.size[0] && szMain <= spec.size[1]
    check(sizeOk, `${n} 尺寸在 ${spec.size[0]}~${spec.size[1]}px（够看清形状，又不盖底图）`, raw.sizeV != null ? raw.sizeV : raw.size)
    // 颜色：单色层直接比字符串；按状态取色的层（camera/trafficLight）比 byValue 的取值集合
    const got = raw.color && raw.color.byValue
      ? [...new Set(Object.values(raw.color.byValue))].sort()
      : [String(raw.color)]
    const want = [...spec.colors].sort()
    check(JSON.stringify(got) === JSON.stringify(want), `${n} 用色集合 == 本层规范`, { got, want })
    check(typeof raw.n === 'number' && raw.n > 0, `${n} 图层有数据（${raw.n} 个要素）`, raw.n)
    // 第 2 个判据：不许和底图总道路蓝撞色（每个用色都要过，不只主色）
    const road = await evj(`${HUE};JSON.stringify((()=>{const o={}
      for(const c of ${JSON.stringify(spec.colors)}) o[c]={dist:__cm.dist(${JSON.stringify(ROAD_BLUE)},c), hsl:__cm.hsl(c)}
      return {road:__cm.hsl(${JSON.stringify(ROAD_BLUE)}), byColor:o}})())`)
    info(`${n} 各用色 vs 路网蓝`, road && road.byColor)
    const minDist = road ? Math.min(...Object.values(road.byColor).map((v) => v.dist)) : null
    check(minDist !== null && minDist >= MIN_DIST,
      `${n} 最接近路网蓝的用色，redmean 色差 ≥${MIN_DIST}`, { 最小色差: minDist, 路网蓝HSL: road && road.road })
  }

  /* ---------- B 各层互相拉开（点位层看**字形**，线图层看颜色） ---------- */
  console.log(`\n===== B 各层互相拉开（点位层比字形，线图层比颜色 redmean ≥${MIN_DIST}） =====`)
  /* 点位层：颜色不再是区分手段（三层图层色恒为白），改成断言「字形两两不同」——
   * 这跟色相判据是同一件事的替代：用户在图上得能一眼分辨是哪一层。 */
  const chars = POINT_KEYS.map((k) => TRAFFIC_ICONS[k].char)
  const ids = POINT_KEYS.map((k) => TRAFFIC_ICONS[k].id)
  info('四类点符号', POINT_KEYS.map((k) => `${k}=${TRAFFIC_ICONS[k].char}`))
  check(new Set(chars).size === POINT_KEYS.length, '四类点位的 emoji 字符两两不同（不撞形）', chars)
  check(new Set(ids).size === POINT_KEYS.length, '四类点位的 L7 图片名两两不同（不会互相顶掉注册）', ids)
  /* 线图层之间 / 线图层与底图路网：颜色仍然是主要区分手段，判据照旧 */
  const MAIN = JSON.stringify(Object.fromEntries(VISUAL_KEYS.map((n) => [n, SPEC[n].colors[0]])))
  const hues = await evj(`${HUE};JSON.stringify((()=>{const m=${MAIN},o={}
    for(const k in m) o[k]={hsl:__cm.hsl(m[k]), hex:m[k]}
    return o})())`)
  info('参与比色的图层', hues)
  const keys = VISUAL_KEYS.filter((k) => hues && hues[k] && hues[k].hsl && hues[k].hsl.h !== null)
  const pairs = []
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = hues[keys[i]].hex, b = hues[keys[j]].hex
      pairs.push({
        a: keys[i], b: keys[j],
        hue: await evj(`${HUE};__cm.hueDist(${JSON.stringify(a)},${JSON.stringify(b)})`),
        dE: await evj(`${HUE};__cm.dist(${JSON.stringify(a)},${JSON.stringify(b)})`)
      })
    }
  }
  info('两两距离', pairs.map((p) => `${p.a}↔${p.b} 色相${p.hue}° ΔE${p.dE}`))
  if (keys.length >= 2) {
    const badHue = pairs.filter((p) => !(p.hue >= 25))
    const badDE = pairs.filter((p) => !(p.dE >= 60))
    check(badHue.length === 0, `主色两两色相相距 ≥25°（共 ${pairs.length} 对）`, badHue)
    check(badDE.length === 0, `主色两两 redmean 色差 ≥60（共 ${pairs.length} 对）`, badDE)
  } else {
    /* 只有一层参与比色时「两两」是空集 —— 不写成恒真断言，如实说明本条不适用 */
    info('参与比色的线图层不足两层，两两色差判据不适用（点位层的区分手段已换成字形）', keys)
  }

  /* ---------- C 视觉层：逐层单独截图 + 数像素复核 ----------
   * 识图模型看 1600×900 里的 4.5px 圆点会直接说「没看见标记」，所以像素这一关自己数：
   * 截图在 Node 侧解码（scripts/lib/png.mjs），按本层规范色给像素归类计数 ——
   * 数出像素才算真画到屏幕上，配置对≠画出来了。
   *
   * 三个坑（都踩过）：
   *   1. 采样区只取屏幕中央那块：面板里的图层色板跟图标同色，整屏数会把面板算进来；
   *   2. 取样中心不能取「数据均值」：摄像头/信号灯跨 20+km（含区县），均值会落在没有数据的
   *      空地，截出来一片灰 —— 改用「邻居最多的那个点」当中心；
   *   3. 计数不能按逐通道容差：图标带 0.9 透明度，渲染色是被底图混过的，得按 redmean 最近色归类。 */
  console.log('\n===== C 逐层截图 + 像素复核（图标是否真的画出来了） =====')
  const CLIP = { x: 380, y: 180, width: 840, height: 540 }
  /* 裁剪区最上层是地图自己的面（canvas / L7 的 DOM marker 容器）才算「没被面板压住」；
   * 拿到别的元素说明这一屏有面板，面板色板会污染计数，断言就不能作数 */
  const surfaceAt = (x, y) => ev(`(()=>{const e=document.elementFromPoint(${x},${y})
    if(!e) return 'null'
    const cls=String(e.className||'')
    const mapFace = e.tagName==='CANVAS' || /l7-marker-container|mapboxgl-canvas/.test(cls)
    return (mapFace?'MAP:':'UI:')+e.tagName+'.'+cls.split(' ')[0]})()`)

  /* 取样区里有几个该层要素（自适应缩放与像素下限都要用） */
  const countInside = (n) => evj(`(()=>{const it=window.__traffic.registry[${JSON.stringify(n)}]
    const d=it&&it.layer&&it.layer.layerSource&&it.layer.layerSource.originData
    const fs=(d&&d.features)||[]
    const C=${JSON.stringify(CLIP)}
    let k=0
    for(const f of fs){const g=f.geometry||{}
      // MultiLineString 多一层数组，先摊平；只统计「至少有一个顶点落在取样区」的要素
      const pts=g.type==='Point'?[g.coordinates]
        :(g.type==='MultiLineString'?(g.coordinates||[]).flat():(g.coordinates||[]))
      for(const p of pts){const s=window.__map.project([p[0],p[1]])
        if(s.x>=C.x&&s.x<=C.x+C.width&&s.y>=C.y&&s.y<=C.y+C.height){k++;break}}}
    return k})()`)

  for (const n of VISUAL_KEYS) {
    for (const k of ALL) await ev(`window.__traffic.setVisible(${JSON.stringify(k)}, ${k === n})`)
    await sleep(700)
    /* 取样中心：把所有点按「±0.012°（≈1.1km）内邻居数」排个序，取前 6 个候选交给 Node 挑，
     * 因为「挑哪个」要用到路网覆盖范围（Node 侧才有路网数据）；线图层没有点，退化成顶点中位数。 */
    const ctr = await evj(`(()=>{const it=window.__traffic.registry[${JSON.stringify(n)}]
      // 数据在 layerSource.originData（.data 要等图层渲染编码后才有，读它多半是空的）
      const d=it&&it.layer&&it.layer.layerSource&&it.layer.layerSource.originData
      const fs=(d&&d.features)||[]; if(!fs.length) return null
      const pts=[]
      for(const f of fs){const g=f.geometry||{}
        if(g.type==='Point') pts.push(g.coordinates)
        else for(const c of (g.coordinates||[])) pts.push(Array.isArray(c[0])?c[0]:c)}
      if(!pts.length) return null
      const clusters=[]
      for(const p of pts){let k=0
        for(const q of pts) if(Math.abs(p[0]-q[0])<0.012 && Math.abs(p[1]-q[1])<0.012) k++
        clusters.push({lng:+p[0].toFixed(5), lat:+p[1].toFixed(5), n:k})}
      clusters.sort((a,b)=>b.n-a.n)
      const med=(a)=>{const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]}
      return {clusters:clusters.slice(0,6), 总点数:pts.length,
        med:{lng:+med(pts.map(p=>p[0])).toFixed(5), lat:+med(pts.map(p=>p[1])).toFixed(5)}}})()`)
    /* 判据要连**形状**一起判：求值抛错时 evj 返回的是字符串（真值），
     * 只判 `!ctr` 会让错误串溜过去，接着在 ctr.med.lng 上炸成 TypeError，
     * 真正的失败原因（哪个 eval 错了）反而看不到。 */
    if (!ctr || typeof ctr !== 'object' || !ctr.med) { check(false, `${n} 能从实例里取到坐标（取样前提）`, ctr); continue }
    /* 候选取舍：优先落在路网覆盖范围内（否则「跟路网区分开」没法同屏验证），同等条件下取密集的；
     * 密集候选取用前 6 个，若都不在范围内就退回最密集的那个并记录本条跳过。 */
    const cands = (n === 'busRoute' ? [ctr.med] : ctr.clusters).map((c) => [c.lng, c.lat])
    const c0 = cands.find(onRoadNet) || cands[0]
    const roadInFrameExpected = onRoadNet(c0)
    info(`${n} 取样中心`, { 选中: c0, 在路网覆盖内: roadInFrameExpected, 候选: cands.slice(0, 3), 总点数: ctr.总点数 })

    // 自适应缩放：要求取样区里至少有 4 个要素（稀疏层如警员 62 个点铺满全市，zoom15 只有 1 个在画面里）
    let zoom = n === 'busRoute' ? 12.5 : 15
    let inside = 0
    for (let i = 0; i < 5; i++) {
      // 包一层再返回字符串：map.jumpTo 返回的是 map 实例本身，returnByValue 序列化它会报
      //「Object reference chain is too long」（求值成功，只是白报一条 error）
      await ev(`(()=>{window.__map.jumpTo({center:[${c0[0]},${c0[1]}], zoom:${zoom}, pitch:0});return 'ok'})()`)
      await sleep(1500)
      inside = await countInside(n)
      if (inside >= 4 || zoom <= 11) break
      zoom = +(zoom - 1.5).toFixed(1)
    }
    info(`${n} 最终缩放`, zoom)

    /* 跳过去之后核对「取样区里到底有几个该层要素」，否则 0 像素分不清是「没画出来」还是「这屏本来就没数据」 */
    check(inside >= 4, `${n} 取样区内有 ≥4 个要素投影（这一屏确实有数据可看）`, inside)

    const s = await send('Page.captureScreenshot', { format: 'png' })
    const f = `logs/icon-${n}.png`
    writeFileSync(f, Buffer.from(s.data, 'base64'))
    console.log(`  ·  截图 ${f}`)

    /* 裁剪区必须整片落在地图画面上：否则面板里的同色色板会被当成本层图标数进去 */
    const probes = [
      [CLIP.x + CLIP.width / 2, CLIP.y + CLIP.height / 2],
      [CLIP.x + 4, CLIP.y + 4],
      [CLIP.x + CLIP.width - 4, CLIP.y + CLIP.height - 4]
    ]
    const tops = []
    for (const [x, y] of probes) tops.push(await surfaceAt(x, y))
    check(tops.every((t) => /^MAP:/.test(t)), `${n} 裁剪区整片在地图画面上（面板色板不会混进计数）`, tops)

    const t0 = Date.now()
    const img = decodePNG(Buffer.from(s.data, 'base64'))
    // 路网蓝一起进去当候选：同屏看得见底图路网，「跟路网区分得开」才是有意义的结论
    const px = {
      ...classifyPixels(img, CLIP, [
        ...SPEC[n].colors.map((hex) => ({ key: hex, hex })),
        { key: '#1990FF', hex: '#1990FF', maxDist: 60 }
      ]),
      解码耗时ms: Date.now() - t0
    }
    info(`${n} 取样区像素归类`, px)
    const total = SPEC[n].colors.reduce((s, hex) => s + (px[hex] || 0), 0)
    // 下限：每个落在取样区里的要素至少该有 4px 实心（4.5px 圆点去掉 1px 白描边后约 5~9px）
    const min = Math.max(4 * inside, n === 'busRoute' ? 150 : 24)
    check(total >= min, `${n} 规范色像素 ≥${min}（该层图标确实画到屏幕上了）`, { 合计: total })
    /* 「图标必须是若干离散小块」这条判据本来在这里，现已搬到 probe17 的 H 段并**变严**：
     * 不再是「整屏数出 ≥2 个大小合适的块」，而是「逐要素投影到屏幕坐标、在它自己的 26×26 窗口里
     * 数该状态色的像素」—— 位置对不上、颜色用错状态都算失败。原因见 B 段注释：
     * 点位层的图层色现在是白，在亮色底图上按色数像素整片都会被算进来（假通过）。 */
    // 路网蓝同时要在场：不在场说明这一屏根本没路，那「跟路网区分得开」也就无从谈起
    if (roadInFrameExpected) {
      check(px['#1990FF'] > 0, `${n} 同屏能看到底图路网（蓝色像素 >0，区分才有意义）`, px['#1990FF'])
    } else {
      skipped.push(`${n} 同屏路网蓝（该层数据全在路网覆盖范围外，无法同屏比对）`)
      info(`${n} 跳过「同屏路网蓝」：该层密集区在路网覆盖范围外`, c0)
    }
  }

  const errs = await evj(`JSON.stringify((window.__errs||[]).slice(0,5))`)
  check((errs || []).length === 0, '全程无运行时错误', errs)

  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败${skipped.length ? ` / ${skipped.length} 跳过` : ''} =====`)
  if (fail) console.log('失败项：\n - ' + fails.join('\n - '))
  if (skipped.length) console.log('未验证（环境不具备，不计入通过）：\n - ' + skipped.join('\n - '))
  /* 收尾别直接 process.exit：Windows 上 WebSocket 还在关闭中就退出，libuv 会抛
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码被冲成 127 ——
   * 明明 34 项全过，脚本对外却是失败。改为设 exitCode，让事件循环自己收干。 */
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 忽略 */ }
  ws.close()
  process.exitCode = fail ? 1 : 0
}
