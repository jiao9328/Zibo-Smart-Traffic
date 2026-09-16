/* README 系统截图重截脚本（1440×900 真实运行捕获 → screenshots/*.png）
 *
 * 与上一版的区别（上一版已经跑不动了，所以整篇重写）：
 *   · 旧版连的是 :9333 上「别人已经打开好的 :5173 页面」，dev server 早就是 5180 了，
 *     且要求先手动开页面 —— 换台机器就必挂。现在自己 PUT /json/new 开标签页，端口可用
 *     APP_PORT / CDP_PORT 覆盖，跟 cdp-probe*.mjs 同一套连法。
 *   · 旧版只截 4 张（mapdraw / changestyle / navigation / areasearch），README 里实际有 10 张，
 *     另外 6 张（login / main / layers-camera / charts / rotation / ai-assistant）来路不明。
 *     现在 10 张全覆盖，顺序就是 README 里的展示顺序。
 *   · 登录态：除 login.png 外都要先注入 sessionStorage 的 zb_auth_user（路由守卫会拦），
 *     旧版靠手动登录；login.png 反而必须「未登录」，所以第一张先截、截完再注入。
 *
 * 用法：APP_PORT=5173 node scripts/shot-readme.mjs [名字...]
 *   不带参数 = 全截；带名字只截其中几张（如 `APP_PORT=5173 node scripts/shot-readme.mjs main charts`）
 *   前置：dev server 在跑、headless Chrome 带 --remote-debugging-port=9223 在跑
 *
 *   ★ **必须带 APP_PORT=5173**：下面的默认值 5180 是历史遗留（那阵子 dev server 跑在 5180），
 *     现在的 `npm run dev` 就是 vite 默认的 5173。漏了不会报错，只会整轮卡在
 *     「等 .login-card」超时、然后每张图都截成空白页 —— 与 cdp-probe14.mjs 是同一个坑。
 */
import { writeFileSync, statSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`
const W = 1440, H = 900

const only = process.argv.slice(2)
const want = (name) => !only.length || only.includes(name)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(created.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => { const i = ++msgId; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    if (m.error) console.log(`  ! CDP ${m.error.message}`) // 不打印就会静默变成 undefined
    pending[m.id](m.result); delete pending[m.id]
  }
}
const ev = (x) => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '>>' : r?.result?.value)
const waitFor = async (expr, ms = 40000) => {
  for (let t = 0; t < ms; t += 400) { if (await ev(expr)) return true; await sleep(400) }
  return false
}
const go = async (path, ms = 0) => {
  await send('Page.navigate', { url: BASE + path })
  if (ms) await sleep(ms)
}
/* 页内路由跳转（SPA）。为什么不用 Page.navigate 直接把每个路由刷一遍：
 * 整页刷新 = 重建 mapbox 地图 = 新建一个 WebGL 上下文，连着跳七八个路由之后浏览器
 * 上下文耗尽，地图创建失败（'load' 不触发 → boot() 不跑 → 只有页头的白图）。
 * 实测：第 7 张 navigation.png 开始变白图，第 10 张 areasearch.png 只有 6KB。
 * 走 router.push 全程只有一个文档、一张地图，跳多少个视图都不会掉。 */
const nav = async (path, ms = 1500) => {
  const r = await ev(`(()=>{const r=window.__router; if(!r) return 'no-router'
    r.push(${JSON.stringify(path)}).catch(()=>{}); return 'ok'})()`)
  if (r !== 'ok') console.log(`  ! 路由跳转失败：${r}`) // 没有 __router = 还没进过应用
  /* 必须等路由真的切过去再返回：ensureHome() 刚 push('/') 就接着 push 目标路由时，
   * 两次 push 会撞车（后一次读到 currentRoute 还是 '/'），定位等待比固定 sleep 可靠。 */
  const target = path.split('?')[0]
  const cond = target === '/'
    ? `String(window.__router.currentRoute.value.path) === '/'` // '/' 是任何路径的前缀，得精确比
    : `String(window.__router.currentRoute.value.path).startsWith(${JSON.stringify(target)})`
  const landed = await waitFor(cond, 8000)
  if (!landed) console.log(`  ! 期望跳到 ${path}，实际停在 ${await ev(`window.__router.currentRoute.value.fullPath`)}`)
  await sleep(ms)
}
/* 地图就绪：App.vue 在 initMap 完成后挂 window.__map/__scene；再等 loaded + 一小段时间
 * 让首个 render 完成（否则截到灰底瓦片） */
const mapReady = async () => {
  const ok = await waitFor(`!!(window.__map && window.__scene && window.__map.loaded && window.__map.loaded())`, 40000)
  if (!ok) console.log('  ! 地图未就绪（超时 40s）')
  await sleep(2500)
  return ok
}
const jump = (lng, lat, zoom, pitch = 0) =>
  ev(`(()=>{window.__map.jumpTo({center:[${lng},${lat}],zoom:${zoom},pitch:${pitch},bearing:0});return 'ok'})()`)
/* 真实鼠标点击：必须 mouseMoved → mousePressed → mouseReleased 三步，
 * 只发 pressed/released 时 L7 / l7-draw 的拾取拿不到 hover 状态（拾取认真实事件）。 */
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 0 })
  await sleep(70)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
/* 双击 = 两次点击（第二次 clickCount:2），l7-draw 靠它给多边形/线收尾 */
const dblClickAt = async (x, y) => {
  await clickAt(x, y)
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 })
}
/* l7-draw 的图形都在 scene 图层里（它不生成工具条 DOM），画没画出来只能查图层 */
const drawLayers = () => ev(`(()=>{const ls=window.__scene.getLayers().filter(l=>!['0','1'].includes(String(l.name)))
  return ls.map(l=>{try{return l.type+':'+(l.getSource().data.dataArray||[]).length}catch(e){return l.type+':?'}}).join(' ')})()`)
/* 单截某几张时（参数只带名字），标签页可能还没进过应用 —— 依赖地图实例的步骤先确保在首页：
 * 没进过应用就整页加载一次（此时是本次唯一的文档），进过就用 SPA 跳回去。 */
const ensureHome = async () => {
  if (!await ev(`!!window.__router`)) { await go('/'); await mapReady(); return }
  if (await ev(`window.__router.currentRoute.value.path !== '/'`)) { await nav('/'); return }
  if (!await ev(`!!window.__map`)) await mapReady()
}

/* 实时数据栏的开态以 store.trafficOn 为准（手动点/AI 调图层都会同步），
 * 所以这里读 class 判断，已经开了就不再点（重复点会关掉）。 */
const setLayer = (label, on) => ev(`(()=>{
  const row=[...document.querySelectorAll('.rt-item')].find(e=>(e.textContent||'').includes(${JSON.stringify(label)}))
  if(!row) return 'no-row'
  const isOn=row.classList.contains('on')
  if(isOn!==${!!on}) row.click()
  return isOn?'already':'clicked'})()`)

/* 底图/浮层的关闭：L7 弹窗自带关闭按钮，先点掉，免得串进下一张图 */
const closePopup = () => ev(`(()=>{const b=document.querySelector('.l7-popup-close-button'); if(b){b.click();return 'closed'} return 'none'})()`)

const shot = async (name) => {
  if (!want(name)) { console.log(`跳过 ${name}（未在参数里）`); return }
  await sleep(500)
  const bad = await ev(`!!document.querySelector('vite-error-overlay')`)
  if (bad) console.log(`  ! ${name}：页面有 vite 报错浮层，这张图别用`)
  const s = await send('Page.captureScreenshot', { format: 'png' }) // 不带 clip：本机 CDP 带 clip 会返回空
  if (!s?.data) { console.log(`FAIL ${name}（截图无数据）`); return }
  const buf = Buffer.from(s.data, 'base64')
  writeFileSync(`screenshots/${name}`, buf)
  console.log(`SHOT ${name}  ${(buf.length / 1024).toFixed(0)}KB  ${statSync(`screenshots/${name}`).size > 40000 ? '' : '← 偏小，可能是空页'}`)
}

ws.onopen = async () => {
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

  /* 先清残留标签页：每个开着本应用的标签页都占一个 WebGL 上下文，堆到十几个之后
   * 新标签页的 mapbox 地图会创建不出来 —— 'load' 事件不触发，App.vue 的 boot() 不执行，
   * window.__map 永远不赋值，截出来就是一张只有页头的空白图（踩过：10 个残留页，全是白图）。
   * 探针崩溃/被中断时会把标签页留在浏览器里，所以每次开跑先扫一遍，只关本应用 origin 的。 */
  const stale = (await (await fetch(`http://localhost:${CDP}/json`)).json())
    .filter((t) => t.type === 'page' && t.id !== created.id && t.url.includes(`:${PORT}`))
  for (const t of stale) { try { await fetch(`http://localhost:${CDP}/json/close/${t.id}`) } catch (e) { /* 已关掉 */ } }
  if (stale.length) console.log(`清掉 ${stale.length} 个残留标签页（每个都占一个 WebGL 上下文）`)

  /* ---- 1) 登录页：必须未登录（sessionStorage 为空），守卫会把 / 重定向到这里 ---- */
  if (want('login.png')) {
    await go('/')
    const ok = await waitFor(`!!document.querySelector('.login-card')`, 25000)
    if (!ok) console.log('  ! 没等到登录卡片，可能是登录态残留')
    await shot('login.png')
  }

  /* ---- 2) 之后都是登录态：新文档注入 sessionStorage（守卫读的是 sessionStorage） ---- */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'jiao9328',display_name:'演示用户'}))}catch(e){}`
  })
  await ev(`try{sessionStorage.setItem('zb_auth_user',JSON.stringify({username:'jiao9328',display_name:'演示用户'}))}catch(e){}`)

  /* ---- 3) 主界面：监控探头 + 信号灯 + 动态车辆（README 原文就是这三层） ---- */
  if (want('main.png')) {
    await ensureHome()
    console.log('  图层：', await setLayer('监控探头', true), await setLayer('信号灯', true), await setLayer('动态车辆', true))
    await jump(118.05, 36.81, 11.2)
    await sleep(7000) // 等车辆跑起来（模拟器 tick 后才看得到车速/位置）
    await shot('main.png')
  }

  /* ---- 4) 监控探头图层：只剩本层，飞到探头最密的一屏，点一个弹详情（README 说「点击要素弹出详情」） ---- */
  if (want('layers-camera.png')) {
    await ensureHome()
    await setLayer('信号灯', false); await setLayer('动态车辆', false); await setLayer('监控探头', true)
    /* 探头数据横跨 20 多公里，取「均值中心」会飞到没有点位的野地（踩过这个坑），
     * 所以按 0.01° 邻域密度找最密的一处飞过去。 */
    const spot = await ev(`(()=>{const l=window.__traffic.registry.camera.layer
      const f=(l&&l.layerSource&&l.layerSource.originData.features)||[]
      if(!f.length) return null
      let best=f[0],bn=-1
      for(const a of f){let n=0
        for(const b of f){const dx=a.geometry.coordinates[0]-b.geometry.coordinates[0]
          const dy=a.geometry.coordinates[1]-b.geometry.coordinates[1]
          if(dx*dx+dy*dy<0.0001)n++}
        if(n>bn){bn=n;best=a}}
      return {lng:best.geometry.coordinates[0],lat:best.geometry.coordinates[1],n:bn,total:f.length}})()`)
    console.log('  最密探头簇：', JSON.stringify(spot))
    if (spot?.lng) {
      await jump(spot.lng, spot.lat, 13.4)
      await sleep(2500)
      /* 点中一个探头要素：把经纬度投影成页面坐标，再发真实鼠标事件（L7 拾取认真实事件） */
      const px = await ev(`(()=>{const m=window.__map,p=m.project([${spot.lng},${spot.lat}])
        const r=document.getElementById('map').getBoundingClientRect()
        return {x:Math.round(p.x+r.left),y:Math.round(p.y+r.top)}})()`)
      if (px?.x) {
        await clickAt(px.x, px.y)
        const hasPopup = await waitFor(`!!document.querySelector('.l7-popup')`, 6000)
        console.log('  要素弹窗：', hasPopup ? '已弹出' : '没弹出来（这张图只有点位）')
      }
    }
    await shot('layers-camera.png')
  }

  /* ---- 5) 控制中心：底部按钮是开关式浮层 ---- */
  if (want('charts.png')) {
    await ensureHome(); await closePopup()
    const r = await ev(`(()=>{const it=[...document.querySelectorAll('.footer .item')].find(e=>(e.textContent||'').includes('控制中心'))
      if(!it) return 'no-btn'; if(!it.classList.contains('on')) it.click(); return 'ok'})()`)
    console.log('  打开控制中心：', r)
    await sleep(3500) // G2Plot 首帧 + 卡片统计
    await shot('charts.png')
    /* 控制中心是全局浮层（App.vue 的 v-if），不关掉的话后面每张图都盖着它。
     * 现在各视图共用一个文档，浮层不会随路由消失 —— 这是换 SPA 跳转后新增的注意点。 */
    await ev(`(()=>{const it=[...document.querySelectorAll('.footer .item')].find(e=>(e.textContent||'').includes('控制中心'))
      if(it&&it.classList.contains('on')) it.click(); return 'ok'})()`)
  }

  /* ---- 6) 空间绘制测量（画多边形工具页） ---- */
  if (want('mapdraw.png')) {
    await ensureHome()
    await closePopup()
    await nav('/mapdraw/drawPolygonTool', 2500)
    await waitFor(`!!(window.__map && window.__scene)`, 10000)
    await sleep(3500)
    /* 这页必须真画一个图形再截：MapDraw.vue 是空模板，而且 l7-draw 的 DrawPolygon 只往
     * scene 里加图层，**不生成任何工具条 DOM**（出工具条的是没用的 DrawControl）——
     * 不画的话这张图和一张普通地图截图没有区别，README 里「绘制与测量」就成了空话。 */
    const armed = await ev(`window.__map.doubleClickZoom.isEnabled() === false`)
    if (!armed) console.log('  ! 绘制态没激活（doubleClickZoom 仍为 true），画出来可能只是拖地图')
    const nodes = [[560, 330], [880, 400], [770, 600], [520, 500]]
    for (const [x, y] of nodes) { await clickAt(x, y); await sleep(420) }
    await sleep(600)
    // 点回首点闭合：闭合后才会算面积（不闭合只有各边长度）
    await clickAt(nodes[0][0], nodes[0][1])
    await sleep(1800)
    console.log('  绘制图层：', await drawLayers())
    await shot('mapdraw.png')
  }

  /* ---- 7) 驾车路径导航：query 直接带起终点 ---- */
  if (want('navigation.png')) {
    await ensureHome()
    const q = encodeURIComponent('淄博站') + '&to=' + encodeURIComponent('山东理工大学')
    await nav(`/navigation?from=${q}`, 3000)
    await sleep(17000) // 路径规划 + 路书渲染
    await shot('navigation.png')
  }

  /* ---- 8) 地球自转（Three.js 地球，冷加载慢） ---- */
  if (want('rotation.png')) {
    await ensureHome()
    await nav('/rotation', 3000)
    await waitFor(`!!document.querySelector('canvas')`, 15000)
    await sleep(6000) // 等地球自转动画铺开（刚进页面还在飞入）
    await shot('rotation.png')
  }

  /* ---- 9) 区域搜索 + 实时天气：query 带区名 ---- */
  if (want('areasearch.png')) {
    await ensureHome()
    await nav(`/areasearch?area=${encodeURIComponent('张店区')}`, 3000)
    await sleep(12000) // 边界 + 天气接口
    await shot('areasearch.png')
  }

  /* ---- 10) AI 助手：开面板 + 发一条快捷指令，让截图里有对话（顺带点亮监控探头图层） ---- */
  if (want('ai-assistant.png')) {
    await ensureHome()
    const opened = await ev(`(()=>{const f=document.querySelector('.ai-fab'); if(!f) return 'no-fab'; f.click(); return 'ok'})()`)
    await sleep(700)
    const chip = await ev(`(()=>{const c=[...document.querySelectorAll('.ai-chip')].find(e=>(e.textContent||'').includes('显示监控探头'))
      if(!c) return 'no-chip'; c.click(); return 'ok'})()`)
    await sleep(600) // 快捷指令只填输入框，等 v-model 回流后「发送」才从 disabled 变可点
    const sent = await ev(`(()=>{const b=document.querySelector('.ai-send'); if(!b||b.disabled) return 'no-send'; b.click(); return 'ok'})()`)
    console.log('  AI 助手：', opened, chip, sent)
    // 等到出现「非思考中」的回复气泡为止（在线大模型慢，最多等 30s；离线规则引擎几乎瞬时）
    await waitFor(`!!document.querySelector('.ai-msg.ai-ai:not(.ai-thinking)')`, 30000)
    await sleep(800)
    await shot('ai-assistant.png')
  }

  /* ---- 11) 底图风格切换：放最后，因为底图样式是全局的 —— 一旦切深色，后面每张图都是深色底图
   * （换 SPA 跳转后各视图共用一个文档，样式不再随整页刷新复位；README 里只有这一张是深色） ---- */
  if (want('changestyle.png')) {
    await ensureHome()
    await nav('/changestyle', 2500)
    const ok = await waitFor(`!!document.querySelector('#menu a')`, 10000)
    if (!ok) console.log('  ! 风格菜单没出来')
    const r = await ev(`(()=>{const a=[...document.querySelectorAll('#menu a')].find(e=>(e.textContent||'').includes('深色风格'))
      if(!a) return 'no-item'; a.click(); return 'ok'})()`)
    console.log('  点击深色风格：', r)
    await sleep(9000) // 换底图样式要重新拉瓦片
    await shot('changestyle.png')
  }

  console.log('\n完成。截图在 screenshots/')
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch (e) { /* 关不掉不影响截图 */ }
  ws.close()
  process.exitCode = 0 // 不能在 ws 关闭过程中 process.exit：本机 libuv 会断言崩溃（exit 127）
}
