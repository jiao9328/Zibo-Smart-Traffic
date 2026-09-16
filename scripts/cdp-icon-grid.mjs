/* 一次性小工具：把若干 iconfont 字形放大成一张**带名字标签**的网格图，供识图定性。
 *
 * 起因：底部「交通大屏」按钮和屏内标题用的 icon-tubiaozhizuomobanzhuanqu-02，此前只验过
 * 「这个类名在字体里存在、没被别的按钮占用」，**没验过它画的是什么形状** —— 识图复核时说
 * 它像个购物车。字形存在 ≠ 语义正确，这里把候选一起放大对照，据此换一个语义对的。
 *
 * 用法：node scripts/cdp-icon-grid.mjs [> 输出]   → logs/icon-grid.png
 */
import { writeFileSync } from 'node:fs'

const CDP = process.env.CDP_PORT || '9223'
const PORT = process.env.APP_PORT || '5180'
const BASE = `http://127.0.0.1:${PORT}`

const targets = await (await fetch(`http://localhost:${CDP}/json/list`)).json()
const target = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE)) || targets.find((t) => t.type === 'page')
if (!target?.webSocketDebuggerUrl) { console.log('没有可用的应用标签页，先打开 ' + BASE); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = {}
const send = (m, p = {}) =>
  new Promise((r) => {
    const i = ++msgId; pending[i] = r
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
    setTimeout(() => { if (pending[i]) { delete pending[i]; console.log(`! 超时 ${m}`); r({}) } }, 15000)
  })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { if (m.error) console.log(`! ${m.method} ${m.error.message}`); pending[m.id](m.result); delete pending[m.id] } }
const ev = (x) => send('Runtime.evaluate', { expression: x, returnByValue: true }).then((r) => r?.exceptionDetails ? '<<' + (r.exceptionDetails.exception?.description || '') + '>>' : r?.result?.value)

/* 候选：当前在用的 + 名称语义可能更贴「数据/交通/监控大屏」的 */
const ICONS = [
  'tubiaozhizuomobanzhuanqu-02', 'gaikuang', 'daolu', 'supervision-full',
  'icon-test', 'ziliaoku', 'tucengfengge', 'fuwudiqiu',
  'quyusousuo', 'daohang', 'shoucang', 'paint',
  'shouye-copy', 'ruler',
]

ws.onopen = async () => {
  await send('Runtime.enable')
  const rect = await ev(`(()=>{
    document.getElementById('__icongrid')?.remove()
    const d=document.createElement('div'); d.id='__icongrid'
    d.style.cssText='position:fixed;left:0;top:0;z-index:99999;background:#fff;padding:16px;display:grid;grid-template-columns:repeat(5,1fr);gap:14px;font-family:sans-serif'
    d.innerHTML=${JSON.stringify(ICONS)}.map(n=>\`<div style="text-align:center">
      <i class="iconfont icon-\${n}" style="font-size:56px;line-height:1;color:#1769e0"></i>
      <div style="font-size:11px;color:#555;margin-top:6px">\${n}</div></div>\`).join('')
    document.body.appendChild(d)
    const b=d.getBoundingClientRect()
    return JSON.stringify({x:0,y:0,width:Math.ceil(b.width),height:Math.ceil(b.height)})
  })()`)
  const r = typeof rect === 'string' ? JSON.parse(rect) : rect
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } })
  if (shot?.data) { writeFileSync('logs/icon-grid.png', Buffer.from(shot.data, 'base64')); console.log('已写出 logs/icon-grid.png', r) }
  await ev(`document.getElementById('__icongrid')?.remove()`)
  process.exit(0)
}
