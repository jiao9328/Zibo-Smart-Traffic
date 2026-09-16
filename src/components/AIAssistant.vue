<template>
  <!-- ================= AI 助手 ================= -->
  <!-- 悬浮按钮：右下角放大缩小按钮左侧 -->
  <div class="ai-fab" :class="{ on: open }" title="AI 智能助手" @click="open = !open">
    <span class="ai-fab-pulse" v-if="!open"></span>
    <span class="ai-fab-logo">AI</span>
    <span class="ai-fab-label">助手</span>
  </div>

  <!-- 对话框：悬浮按钮上方展开 -->
  <div class="ai-panel" v-show="open" :class="{ show: open }">
    <!-- 头部 -->
    <div class="ai-head">
      <div class="ai-head-logo">AI</div>
      <div class="ai-head-info">
        <span class="ai-head-title">AI 智能助手</span>
        <span class="ai-head-sub">{{ modeText }}</span>
      </div>
      <div class="ai-dot" :class="mode"></div>
      <div class="ai-close" @click="open = false">✕</div>
    </div>

    <!-- 消息区 -->
    <div class="ai-msgs" ref="msgsBox">
      <div v-if="!msgs.length" class="ai-welcome">
        <p>你好，我是本系统的 AI 助手 🤖</p>
        <p class="ai-welcome-sub">你可以让我：查看/关闭交通图层、切换道路分级、控制中心开合、地图缩放视角、飞到各区县，或直接跟我聊聊路况。</p>
      </div>
      <div
        v-for="(m, i) in msgs"
        :key="i"
        class="ai-msg"
        :class="'ai-' + m.role"
      >{{ m.text }}</div>
      <div v-if="busy" class="ai-msg ai-ai ai-thinking">
        <span class="ai-dots"><i></i><i></i><i></i></span>
      </div>
    </div>

    <!-- 快捷指令：点一下先填入输入框，点「发送」后实现对应功能 -->
    <div class="ai-chips" v-if="!busy">
      <span class="ai-chips-tip">你可以说：</span>
      <span v-for="c in chips" :key="c" class="ai-chip" @click="fillChip(c)">{{ c }}</span>
    </div>

    <!-- 输入区 -->
    <div class="ai-input-row">
      <input
        ref="inputBox"
        v-model="input"
        class="ai-input"
        placeholder="试试：显示监控探头 / 飞到临淄区 / 切换到二级道路…"
        @keyup.enter="send()"
      />
      <button class="ai-send" :disabled="busy || !input.trim()" @click="send()">发送</button>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { execTool, execRuleAction, LAYER_LABEL, ROAD_LABEL } from '../tools/aiExec'
import { parseCommand } from '../tools/agent'

const sm = inject('$scene_map')

const KEY = import.meta.env.VITE_DEEPSEEK_KEY || ''
const MODEL = import.meta.env.VITE_DEEPSEEK_MODEL || 'deepseek-v4-pro'
// Anthropic 兼容端点（与 Claude Code 同协议），DeepSeek 官方支持
const API = 'https://api.deepseek.com/anthropic/v1/messages'

/* ---------------- 界面状态 ---------------- */
const open = ref(false)
const busy = ref(false)
const input = ref('')
const inputBox = ref(null)
const msgsBox = ref(null)
const msgs = reactive([]) // { role: 'user' | 'ai' | 'sys', text }
const mode = ref('idle') // idle | llm | rule

const modeText = computed(() => {
  if (!KEY) return '未配置 Key · 离线指令模式'
  if (mode.value === 'llm') return 'Deepseek V4 Pro 在线对话 · 可自由交流'
  if (mode.value === 'rule') return '离线指令模式（模型连不上，指令照常执行）'
  return 'Deepseek V4 Pro 就绪'
})

const chips = [
  '显示监控探头', '切换到二级道路', '打开控制中心', '区域搜索淄博市', '切换卫星影像',
  '导航到博山区', '我想去海岱楼', '从张店区去博山区', '测量矩形', '飞到临淄区', '飞到张南路', '淄博今天天气怎么样？'
]

// 点击快捷指令：把按钮文字自动填入输入框（发送后实现对应功能）
const fillChip = (c) => {
  input.value = c
  inputBox.value?.focus()
}

const push = (role, text) => {
  msgs.push({ role, text })
  scrollToBottom()
}
const scrollToBottom = () => nextTick(() => {
  if (msgsBox.value) msgsBox.value.scrollTop = msgsBox.value.scrollHeight
})

/* ============ 模糊意图反问确认（猜不到时按关键字问「是不是…」，用户说"是"再执行） ============ */
// pending = { list: [{ a: 动作, desc: 描述 }], idx: 当前问到第几个 }
const pending = ref(null)

// 从文本中按关键字猜意图候选
function guessActions(text) {
  const closing = /(关闭|关掉|隐藏|收起|去掉)/.test(text)
  const out = []
  const add = (a, desc) => {
    if (!out.some((x) => x.desc === desc)) out.push({ a, desc })
  }
  // 交通图层关键词
  const LAYER_RE = [
    [/监控|摄像|探头|camera/i, 'camera'],
    [/信号灯|红绿灯|信号机/, 'trafficLight'],
    [/警员|民警|警察|警力|巡逻/, 'police'],
    [/拥堵|堵车|路况|缓行/, 'congestion'],
    [/热力|热度|人流|热区/, 'heat'],
    [/公交|巴士|线路/, 'busRoute'],
    [/站牌|站点/, 'busStop'],
    [/动态车辆|车辆|车流|汽车|行驶的?车|移动的车/, 'vehicle'],
    [/建筑|楼宇/, 'building'],
    [/道路|路网/, 'mainRoad']
  ]
  for (const [re, name] of LAYER_RE) {
    if (re.test(text)) add({ type: 'layer', name, visible: !closing }, `${closing ? '关闭' : '打开'}「${LAYER_LABEL[name]}」图层`)
  }
  // 道路分级关键词
  const ROAD_GUESS = [
    ['高速', 'highway'], ['快速', 'first'], ['主干', 'first'], ['一级', 'first'],
    ['二级', 'second'], ['次干', 'second'], ['三级', 'third'], ['支路', 'third']
  ]
  for (const [kw, level] of ROAD_GUESS) {
    if (text.includes(kw)) add({ type: 'road', level }, `切换到「${ROAD_LABEL[level]}」`)
  }
  // 区县 / 地标：说出行（想去/去/前往/怎么走）→ 优先推「从淄博站导航到X」；纯查看 → 推「飞到X」
  const placeHits = text.match(/张店|临淄|淄川|博山|周村|桓台|高青|沂源|淄博站|火车站|海岱楼|齐盛湖|人民公园|市政府/g)
  if (placeHits) {
    const travel = /(想去|要去|我想去|我要去|打算去|准备去|怎么去|怎么走|怎么到|前往|导航)/.test(text) ||
      (!/(去掉|去除|减去|回去|过去|上去|下去|去看|去看看|看看)/.test(text) && /(?:^|[^，。！？\s、])去/.test(text))
    for (const p of [...new Set(placeHits)]) {
      if (travel) add({ type: 'navigate', origin: '', place: p }, `从淄博站导航到「${p}」`)
      else add({ type: 'map', kind: 'fly', payload: { place: p } }, `飞到「${p}」（自动缩放过去）`)
    }
  }
  // 控制中心
  if (/(控制中心|图表|统计数据|数据面板|统计面板|数据中心)/.test(text)) {
    add({ type: 'charts', open: !closing }, `${closing ? '收起' : '打开'}控制中心`)
  }
  return out.slice(0, 3)
}

// 抛出反问（当前问 list[idx]）
function askGuess(list, idx) {
  if (idx >= list.length) {
    pending.value = null
    push('ai', '我实在猜不到啦…换个说法试试？比如「显示监控探头」「飞到临淄区」「切换到二级道路」')
    return
  }
  pending.value = { list, idx }
  push('ai', `我猜你是不是想【${list[idx].desc}】？回复「是」我就执行；不是的话我再猜别的。`)
}

// 用户对反问的回答：true=已处理该轮；false=是条新指令，正常往下走
function handlePendingAnswer(text) {
  const p = pending.value
  if (!p) return false
  const t = text.trim()
  const num = /^([1-3])$/.exec(t)
  if (/^(不是|不对|算了|取消|不要|换一个|都没有|都不是|没有)/.test(t) && !num) {
    askGuess(p.list, p.idx + 1) // 否定 → 猜下一个
    return true
  }
  if (num) {
    pending.value = null
    const c = p.list[+num[1] - 1]
    if (c) runConfirmed(c)
    else askGuess(p.list, p.idx)
    return true
  }
  if (/^(是|对|好|嗯|确定|没错|执行|要|可以|行|就这么办|对对|嗯嗯|OK|ok)/.test(t) && p.list[p.idx]) {
    pending.value = null
    runConfirmed(p.list[p.idx]) // 确认 → 执行当前候选
    return true
  }
  return false // 其它输入 → 视为新指令
}

async function runConfirmed(c) {
  let out = ''
  try {
    out = await execRuleAction(c.a, { map: sm.map })
  } catch (e) {
    out = '执行出错：' + e.message
  }
  push('sys', '⚙ 已按你的确认执行')
  push('ai', out || '好的，搞定！')
}

/* ---------------- 对话 ---------------- */
// 发给大模型的历史（角色齐全，供 tool_calls 轮询续接）
const llmHist = []

const SYSTEM = '你是「淄博市智慧交通管理系统」网页里的 AI 助手，运行在一个 WebGIS 大屏上。' +
  '你可以通过函数工具操作页面：开关交通图层、切换道路分级、开关控制中心图表、控制地图视角缩放、飞到淄博各区县、跳转页面、查询状态。' +
  '规则：1) 用户意图涉及页面操作时，先调用对应工具，工具结果返回后再用一句话中文回复确认结果，并补充有用信息；' +
  '2) 涉及多个操作可一次调用多个工具；' +
  '3) 不涉及页面操作时（闲聊、问路况、问淄博风土人情等），直接正常中文聊天，不要编造页面功能已执行；' +
  '4) 用户指令含糊时，先用 get_status 了解当前状态，再按最可能的意图调用工具；' +
  '5) 能落到页面二级功能就落到二级：打开某图层时地图会自动飞过去看清该图层；区域搜索某地区用 area_search；' +
  '换风格用 change_style；测量用 map_measure；飞往地点可精确到区县、某条道路（张南路）、某家医院/学校/商场等，用 fly_to；' +
  '6) 出行 vs 查看 分流（重要，选错工具会答非所问）：' +
  '——用户说「飞到X / 飞往X / 定位X / 飞过去看看X」是想查看那个地方 → 用 fly_to（地图自动飞到并缩放到能看清该地的级别）；' +
  '——用户说「想去X / 我要去X / 怎么去X / 到X去 / X怎么走 / 去X的路线 / 导航到X」是想开车过去 → 用 start_navigation，destination=X，origin 留空（默认起点淄博站，进入导航页自动出路线并缩放到全程）；' +
  '——用户说「从A到B / 从A去B / A到B怎么走 / 从A出发去B」→ start_navigation，origin=A、destination=B；' +
  '注意：只要用户表达的是出行/到达意图（去、到、怎么走、路线），就用 start_navigation 而不是 fly_to；' +
  'fly_to 只用于查看地点本身；' +
  '7) 回答简洁友好，200 字以内。'

/* 工具定义（Anthropic tool_use 格式，DeepSeek anthropic 端点兼容） */
const TOOLS = [
  { name: 'get_status', description: '查询页面当前状态：地图缩放级别与中心、道路分级、已开启的图层、控制中心开关、天气', input_schema: { type: 'object', properties: {} } },
  { name: 'map_action', description: '控制地图视角动作', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['zoom_in', 'zoom_out', 'reset_view', 'rotate_view', 'top_view', 'tilt_view'], description: 'zoom_in=放大 zoom_out=缩小 reset_view=复位淄博全景 rotate_view=环绕旋转 top_view=俯视 tilt_view=斜视' } }, required: ['action'] } },
  { name: 'fly_to', description: '地图飞到某个地点并自动缩放到能看清该地的级别（适合查看：区县/道路/地标/POI/学校等任意地名，会多级解析+在线兜底，未命中返回候选名）。注意：仅当用户说「飞到X/飞往X/定位X/去X看看」这种查看意图才用；用户说「想去X/怎么去X/从A到B」是想走路线，必须用 start_navigation，不要用本工具', input_schema: { type: 'object', properties: { place: { type: 'string', description: '地点中文名：区县、道路名、POI 名或任意地名' } }, required: ['place'] } },
  { name: 'set_road_class', description: '切换道路分级显示：total=总道路（全路网）、highway=高速公路、first=一级道路、second=二级道路、third=三级道路', input_schema: { type: 'object', properties: { level: { type: 'string', enum: ['total', 'highway', 'first', 'second', 'third'] } }, required: ['level'] } },
  { name: 'set_traffic_layer', description: '开关交通图层', input_schema: { type: 'object', properties: { layer: { type: 'string', enum: ['camera', 'trafficLight', 'police', 'congestion', 'heat', 'busRoute', 'busStop', 'vehicle', 'mainRoad', 'building'], description: 'camera=监控探头 trafficLight=信号灯 police=警员分布 congestion=道路拥堵 heat=热力图 busRoute=公交线路 busStop=公交站点 vehicle=动态车辆(模拟) mainRoad=道路 building=城市建筑' }, on: { type: 'boolean', description: 'true=打开 false=关闭' } }, required: ['layer', 'on'] } },
  { name: 'set_control_center', description: '开关控制中心（统计图表浮层）', input_schema: { type: 'object', properties: { open: { type: 'boolean' } }, required: ['open'] } },
  { name: 'goto_page', description: '跳转系统功能页', input_schema: { type: 'object', properties: { page: { type: 'string', enum: ['home', 'rotation', 'cityview', 'eventinfo', 'areasearch', 'navigation', 'changestyle'] } }, required: ['page'] } },
  { name: 'area_search', description: '区域搜索：搜索某个城市/行政区的边界轮廓并展示（相当于进入区域搜索页直接搜索）。keyword 传中文地区名，如 淄博市、山东省、济南市', input_schema: { type: 'object', properties: { keyword: { type: 'string', description: '地区中文名，至少要市级' } }, required: ['keyword'] } },
  { name: 'change_style', description: '切换地图风格（相当于切换风格页点选某一风格）', input_schema: { type: 'object', properties: { style: { type: 'string', enum: ['街道风格', '高对比度街道风格', '深色风格', '卫星影像', '地形风格', '高清街道风格', '夜间街道风格', '导航风格（白天）', '导航风格（夜间）', '海图风格'] } }, required: ['style'] } },
  { name: 'map_measure', description: '打开地图测量工具（相当于底部「地图测量」弹层选一种工具）：多边形面积/矩形面积/圆形面积/线段距离', input_schema: { type: 'object', properties: { tool: { type: 'string', enum: ['drawPolygonTool', 'drawRectTool', 'drawCircleTool', 'line'], description: 'drawPolygonTool=多边形 drawRectTool=矩形 drawCircleTool=圆形 line=线段' } }, required: ['tool'] } },
  { name: 'start_navigation', description: '出行路线导航：进入导航页并自动把起终点填入输入框、画出驾车路线并缩放到整条线路（与手动点导航输入起终点效果一样）。用户说「想去X/我要去X/怎么去X/X怎么走/导航到X/到X去」= 只想去某地 → destination 填 X、origin 留空（默认淄博站）；用户说「从A到B/从A去B/A到B怎么走」= 起点终点都明确 → origin 填 A、destination 填 B', input_schema: { type: 'object', properties: { origin: { type: 'string', description: '起点中文地名，如 张店区、淄博站；用户明确说了起点才填（从A到B时必填），只说目的地时留空（默认淄博站）' }, destination: { type: 'string', description: '终点中文地名，必填，如 博山区、海岱楼' } }, required: ['destination'] } }
]

async function callLLM() {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, temperature: 0.6, system: SYSTEM, tools: TOOLS, messages: llmHist })
  })
  if (!r.ok) {
    let msg = ''
    try { msg = (await r.json()).error?.message || '' } catch { /* 非 JSON 错误体 */ }
    throw new Error(`HTTP ${r.status} ${msg}`.trim())
  }
  const d = await r.json()
  const blocks = d.content || []
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    // thinking 块不展示；tool_use 块逐个执行
    toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    raw: d
  }
}

/* 大模型在线对话（带 tool_use 工具循环） */
async function chatLLM(text) {
  if (llmHist.length > 48) llmHist.splice(0, llmHist.length - 40) // 老对话截断（按整轮移除）
  llmHist.push({ role: 'user', content: text })
  for (let round = 0; round < 6; round++) {
    const m = await callLLM()
    // assistant 原始消息整条入史（含 thinking/tool_use 块），后续续接必须原样保留
    llmHist.push(m.raw)
    if (m.text) push('ai', m.text)
    if (!m.toolUses.length) return
    for (const u of m.toolUses) {
      let out = ''
      try {
        out = await execTool(u.name, u.input, { map: sm.map })
      } catch (e) {
        out = '执行出错：' + e.message
      }
      // 页面上有实际动作才落一行小字提示
      if (!/^(未知|未找到|执行出错|地图尚未)/.test(out)) push('sys', '⚙ 已执行 · ' + out)
      llmHist.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: u.id, content: out }] })
    }
  }
}

/* 离线指令识别（大模型 key 无效 / 断网时的降级） */
async function chatRule(text) {
  const a = parseCommand(text)
  // 规则引擎也没把握（纯回复型）→ 按关键字猜意图反问用户确认
  if (!a || a.type === 'reply') {
    const list = guessActions(text)
    if (list.length) return askGuess(list, 0)
    push('ai', a ? a.reply : '我暂时没听懂，试试对我说：「显示监控探头」「飞到临淄区」「切换到二级道路」')
    return
  }
  let out
  try {
    out = await execRuleAction(a, { map: sm.map })
  } catch (e) {
    out = '执行出错：' + e.message
  }
  push('sys', '⚙ 已执行')
  push('ai', out || a.reply)
}

/* 发送入口 */
async function send(raw) {
  const text = (raw ?? input.value ?? '').trim()
  if (!text || busy.value) return
  input.value = ''
  if (msgs.length > 60) msgs.splice(0, msgs.length - 60)
  push('user', text)
  // 上一条是反问 → 先按「是 / 不是 / 序号」处理
  if (handlePendingAnswer(text)) return
  pending.value = null // 反问被新指令打断
  busy.value = true
  const histLen = llmHist.length // 本轮入史位置：失败时回滚，避免半截对话污染下次请求
  try {
    if (!KEY) throw new Error('no-key') // 未配置 key 直接走离线引擎
    mode.value = 'llm'
    await chatLLM(text)
  } catch (e) {
    llmHist.splice(histLen) // 丢掉的只是这一轮未完成的 user/assistant 轮次，不影响历史
    mode.value = 'rule'
    if (e.message !== 'no-key') push('sys', '⚠ 大模型连接失败，已切换离线指令识别（页面功能照常可用）')
    await chatRule(text)
  } finally {
    busy.value = false
  }
}

/* DEV 调试桥：CDP 验证脚本用 */
onMounted(() => {
  if (import.meta.env.DEV) {
    window.__ai = {
      send: (t) => send(t),
      // 强制走离线规则引擎（验证反问确认流等确定性行为）
      sendRule: (t) => chatRule(t),
      setOpen: (v) => { open.value = v },
      isOpen: () => open.value,
      msgs: () => msgs.map((m) => m.role + ':' + m.text),
      mode: () => mode.value
    }
  }
})
onUnmounted(() => { if (window.__ai) delete window.__ai })
</script>

<style scoped>
/* ================= 悬浮按钮（右下角，放大/缩小按钮左侧） ================= */
.ai-fab {
  position: fixed;
  right: 44px;
  bottom: 8px;
  z-index: var(--z-ai);
  width: 66px;
  height: 56px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  user-select: none;
  color: var(--primary);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  transition: transform 0.2s, box-shadow 0.2s, color 0.2s, background 0.2s;
}
.ai-fab:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
/* 打开态：主色实底，与底部工具条的 .on 态呼应（原为青绿渐变） */
.ai-fab.on {
  color: #fff;
  background: var(--primary);
  border-color: var(--primary);
}
.ai-fab-logo {
  font-size: 17px;
  font-weight: 800;
  font-style: italic;
  letter-spacing: 1px;
  line-height: 1;
  color: inherit;
}
.ai-fab-label { font-size: 11px; color: inherit; line-height: 1; letter-spacing: 1px; opacity: 0.85; }
/* 呼吸光点 */
.ai-fab-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
  animation: aiPulse 1.8s ease-in-out infinite;
}
@keyframes aiPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.8); }
}

/* ================= 对话框 ================= */
.ai-panel {
  position: fixed;
  right: 44px;
  bottom: 76px;
  z-index: var(--z-ai);
  width: 350px;
  max-width: calc(100vw - 120px);
  height: min(560px, calc(100vh - 150px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  opacity: 0;
  transform: translateY(14px);
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.ai-panel.show { opacity: 1; transform: translateY(0); pointer-events: auto; }

.ai-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-sub);
  border-bottom: 1px solid var(--border);
}
.ai-head-logo {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 800;
  font-style: italic;
  background: var(--primary);
  color: #fff;
}
.ai-head-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.ai-head-title { font-size: 14px; font-weight: 600; letter-spacing: 1px; color: var(--text); }
.ai-head-sub { font-size: 11px; color: var(--text-mute); }
.ai-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-mute);
}
.ai-dot.llm { background: var(--ok); }
.ai-dot.rule { background: var(--warn); }
.ai-close {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-mute);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ai-close:hover { background: var(--danger-soft); color: var(--danger); }

/* 消息区 */
.ai-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-welcome { font-size: 12px; color: var(--text-sub); line-height: 1.7; padding: 6px 2px; }
.ai-welcome-sub { font-size: 11px; color: var(--text-mute); }

.ai-msg {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.65;
  word-break: break-word;
  white-space: pre-wrap;
  animation: aiIn 0.18s ease;
}
@keyframes aiIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }

/* 用户气泡：主色实底白字；AI 气泡：浅灰底深字（原来是两种深浅不一的蓝，对比度都不够） */
.ai-user {
  align-self: flex-end;
  color: #fff;
  background: var(--primary);
  border-radius: 10px 3px 10px 10px;
}
.ai-ai {
  align-self: flex-start;
  color: var(--text);
  background: var(--bg-sub);
  border: 1px solid var(--border);
  border-radius: 3px 10px 10px 10px;
}
.ai-sys {
  align-self: center;
  font-size: 11px;
  color: var(--text-mute);
  background: var(--bg-sub);
  border: 1px solid var(--border);
  padding: 3px 10px;
  border-radius: 20px;
}

/* 思考动画 */
.ai-thinking { padding: 10px 14px; }
.ai-dots { display: inline-flex; gap: 4px; }
.ai-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--primary);
  animation: aiBounce 1s infinite;
}
.ai-dots i:nth-child(2) { animation-delay: 0.15s; }
.ai-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes aiBounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* 快捷指令 */
.ai-chips {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 0 12px 8px;
  scrollbar-width: none;
}
.ai-chips::-webkit-scrollbar { display: none; }
/* 「你可以说：」前缀 */
.ai-chips-tip {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-mute);
  line-height: 22px;
  padding-left: 2px;
  white-space: nowrap;
}
.ai-chip {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 4px 9px;
  border-radius: 20px;
  color: var(--text-sub);
  background: var(--bg-sub);
  border: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ai-chip:hover { background: var(--primary-soft); color: var(--primary); border-color: var(--primary); }

/* 输入区 */
.ai-input-row {
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--border);
}
.ai-input {
  flex: 1;
  height: 34px;
  box-sizing: border-box;
  padding: 0 12px;
  font-size: 12.5px;
  color: var(--text);
  background: var(--bg-sub);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.ai-input:focus { border-color: var(--primary); background: var(--bg-panel); }
.ai-input::placeholder { color: var(--text-mute); }
.ai-send {
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: var(--radius);
  font-size: 12.5px;
  color: #fff;
  background: var(--primary);
  cursor: pointer;
  transition: background 0.15s;
  letter-spacing: 2px;
}
.ai-send:hover:not(:disabled) { background: var(--primary-hover); }
.ai-send:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
