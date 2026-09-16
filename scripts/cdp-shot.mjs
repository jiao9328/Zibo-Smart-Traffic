/* 截图工具：打开首页 →（可选）点某个底部按钮 → 截图存盘。
 * 用法：
 *   node scripts/cdp-shot.mjs out.png                 # 只截首页
 *   node scripts/cdp-shot.mjs out.png 控制中心        # 点「控制中心」后再截
 *   node scripts/cdp-shot.mjs out.png 控制中心 1920 1080
 * 环境变量：
 *   PAGE=/areasearch   要打开的路由（默认 /）
 *                      在 Git-Bash 里必须写成 MSYS_NO_PATHCONV=1 PAGE=/areasearch ...
 *   AUTH=0             不预置登录态（截登录页用）
 *   PRE_JS=...         截图前在页面里跑的表达式
 *   PRE_WAIT=2000      跑完 PRE_JS 后等多久
 *   DPR=2              像素比
 */
import { writeFileSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.PORT || '5180'
const out = process.argv[2] || 'shot.png'
const btn = process.argv[3] || ''
const W = +(process.argv[4] || 1440)
const H = +(process.argv[5] || 900)

/* Git-Bash(MSYS) 会把「以 / 开头的环境变量值」当路径自动转成 Windows 路径：
 *   PAGE=/login  →  PAGE=C:/Program Files/Git/login
 * 拼出来就是 http://127.0.0.1:5180C:/Program Files/Git/login —— 非法 URL，
 * Chrome 停在 about:blank，截图静默变成一张白图（不报错，只是「页面不对」）。
 * 直接在入口拦掉并给出正确命令，比事后对着一张白图猜要省事得多。 */
if (/^[A-Za-z]:[\\/]/.test(process.env.PAGE || '')) {
  console.log(
    `PAGE 被 Git-Bash 转换成了 Windows 路径：${process.env.PAGE}\n` +
      `请改用：MSYS_NO_PATHCONV=1 PAGE=/areasearch node scripts/cdp-shot.mjs out.png`
  )
  process.exit(1)
}

/* ★ 每次都在新开的标签页里截，用完关掉。
 *
 * 原因是 Page.addScriptToEvaluateOnNewDocument 的注册绑在 target 上且长期生效，
 * 之前跑过的探针注册的「预置登录态」脚本会一直在同一个标签页的每个新文档里抢先执行。
 * 后果是 AUTH=0 也进不去登录页 —— 守卫拿到脚本塞好的 zb_auth_user 直接把 /login 重定向到 /，
 * 截出来永远是首页（这个坑已经踩过一次，且因为报错被 try/catch 吞掉而毫无征兆）。
 * 新 target 天然干净，不依赖「后注册的脚本能盖掉先注册的」这种执行顺序假设。 */
const created = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!created || !created.webSocketDebuggerUrl) {
  console.log('无法创建新的浏览器标签页（需要 PUT /json/new）；若已有一个空白页可手动关闭重试')
  process.exit(1)
}

const ws = new WebSocket(created.webSocketDebuggerUrl)
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
    r?.exceptionDetails ? null : r?.result?.value
  )

const closeTarget = async () => {
  try { await fetch(`http://localhost:${CDP}/json/close/${created.id}`) } catch { /* 关不掉也不影响截图结果 */ }
}

ws.onopen = async () => {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: +(process.env.DPR || 1), mobile: false
  })
  if (process.env.AUTH !== '0') {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { sessionStorage.setItem('zb_auth_user', JSON.stringify({username:'p',display_name:'p'})) } catch(e){}`
    })
  }
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${process.env.PAGE || '/'}` })

  // 等 boot（登录页没有底部工具条，不能拿它当就绪信号，给固定等待即可）
  if (process.env.AUTH !== '0') {
    let ok = false
    for (let i = 0; i < 90; i++) {
      if (await ev(`document.querySelectorAll('.btn-groups .item').length>=10`)) { ok = true; break }
      await sleep(1000)
    }
    if (!ok) console.log('警告：底部工具条未出现，截图可能是半成品')
  }
  await sleep(2500)

  if (btn) {
    const b = await ev(
      `(() => { const it=[...document.querySelectorAll('.btn-groups .item')].find(i=>i.textContent.includes(${JSON.stringify(btn)}));
        if(!it) return null; const r=it.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2} })()`
    )
    if (b && typeof b === 'object') {
      const p = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
      await sleep(50)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p })
      await sleep(2600)
    } else {
      console.log('没找到按钮：' + btn)
    }
  }

  /* 可选：截图前先在页面里跑一段表达式（用环境变量传，避免和位置参数打架）。
   * 例：PRE_JS="window.__vehicleSim.setVisible(true)" node scripts/cdp-shot.mjs a.png */
  if (process.env.PRE_JS) {
    const v = await ev(process.env.PRE_JS)
    console.log('PRE_JS →', JSON.stringify(v))
    await sleep(+(process.env.PRE_WAIT || 1500))
  }

  // 落在哪个路由要如实报出来：截图内容对不上时，这一行能立刻区分「页面没跳过去」和「样式不对」
  const landed = await ev('location.pathname')
  const want = process.env.PAGE || '/'
  console.log('URL:', landed, landed === want ? '' : `← 与预期的 ${want} 不一致，截图内容不可信`)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(r.data, 'base64'))
  console.log('saved ' + out)
  // 先关 ws 再关 target：Windows 上 ws 还开着就 process.exit 会撞 libuv 断言
  ws.close()
  await sleep(150)
  await closeTarget()
  process.exit(0)
}
