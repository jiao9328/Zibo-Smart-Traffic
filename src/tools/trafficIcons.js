/**
 * 交通图层的点符号 —— emoji 位图（四类点位：监控探头 / 信号灯 / 警员分布 / 公交站点）。
 *
 * ★ v4（本次，用户 2026-09-15「尽量图层点符号都用对应的简单的小 emoji」）：
 *   符号本体从「手绘 SVG 字形」换成 **emoji 字符**（📹 👮 🚏 🚦），运行时用 canvas
 *   烤成 PNG 位图再交给 L7。换 emoji 的动机（用户三次改口径的落点）：
 *   小尺寸下最重要的事是「一眼认得出」，而 emoji 就是为小尺寸设计的字形库 ——
 *   比自绘 SVG 更简单、更小、更不容易糊。
 *
 * v3 是单层手绘小字形（上一版），v2 是「圆角方块徽章 + 白描边 + 柔影 + 聚合气泡 + 数量文字」
 * 五层栈。v2 → v3 → v4 一路砍掉的都是同一件事：**符号太大、太吵**（用户原话「越小越好」
 * 「别整那么大的数字符号」）。现在一套点位只剩两个 L7 图层：图标 + 聚合点。
 *
 * 为什么 emoji 能既「原色显示」又「按状态染色」（读 L7 的 image 片元着色器定的，不是猜的）：
 *   node_modules/@antv/l7 的 image_frag 里是这么两条分支：
 *     ① 图层色 ≈ 白 ⇒ gl_FragColor = textureColor          —— **原色**，emoji 的彩色靠这条；
 *     ② 否则       ⇒ gl_FragColor = step(0.01, z) * v_color —— 拿纹理**蓝通道**当遮罩填图层色。
 *   所以同一张位图有两种用法：想要彩色就 .color('#FFFFFF')；想要按状态换色就用状态色。
 *   ★ 分支②看的是**蓝通道**、不是 alpha —— 红/绿/黄的像素蓝通道≈0 会被判成透明。
 *   这正是信号灯剪影想要的效果（三个灯位留成洞），但反过来也说明：**别把彩色 emoji
 *   直接丢给分支②**（会掉一半像素）。故 bake(..., 'mask') 先把位图烤成「白色不透明 +
 *   低蓝通道的洞」，把这条规则固化在离线，运行时就不会有意外。
 *
 * 造型原则（沿用前两版实测出来的）：
 *   · **画满方框**：烤图时量一次墨迹外框再缩放，让 emoji 占满 96 的方框 ——
 *     emoji 字体自带的留白很大（Segoe UI Emoji 的字形只占 em 框 ~75%），不修的话
 *     18px 的图标实际只有 13px，四层大小还不一致。
 *   · **四类别撞形**：📹 摄像机、👮 警察、🚏 站牌、🚦 信号灯，剪影两两可辨。
 *
 * 面板小图标（实时数据栏 / 数据管理行首）直接渲染 emoji 字符本身，与地图符号同源，
 * 不再有「面板画一个样、地图画另一个样」的漂移。
 */

/** 统一的 emoji 字体栈：Windows 用 Segoe UI Emoji，macOS/iOS 用 Apple Color Emoji，Linux 用 Noto */
export const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif'

/* 四类点位的符号定义：
 *   char          地图与面板上用的 emoji
 *   id            L7 里注册的图片名（.shape() 用）
 *   fallbackShape 图片没注册好时的几何兜底（L7 找不到图名会**静默退化成文字渲染**，比不画还难看）
 *   mode          'color' = 原色（配 .color('#FFFFFF')）/ 'mask' = 白色遮罩（配状态色） */
export const TRAFFIC_ICONS = {
  camera: { id: 'zb-emoji-camera', char: '📹', fallbackShape: 'circle', mode: 'color', label: '监控探头' },
  trafficLight: { id: 'zb-emoji-trafficLight', char: '🚦', fallbackShape: 'triangle', mode: 'mask', label: '信号灯' },
  police: { id: 'zb-emoji-police', char: '👮', fallbackShape: 'rhombus', mode: 'color', label: '警员分布' },
  busStop: { id: 'zb-emoji-busStop', char: '🚏', fallbackShape: 'pentagon', mode: 'color', label: '公交站点' }
}

/** 面板小图标：直接给 emoji 字符 + 中文名（TrafficGlyph.vue 用） */
export const TRAFFIC_GLYPHS = Object.fromEntries(
  Object.entries(TRAFFIC_ICONS).map(([k, v]) => [k, { char: v.char, label: v.label }])
)

/* ---------------- emoji → 位图（浏览器里现烤，Node 侧不碰） ---------------- */

const BOX = 96 // 位图边长（px）：缩到 18px 有 5 倍余量，再大只是浪费显存
const INK = 0.96 // 墨迹占方框的比例

/** 读一块画布的不透明区域外框（alpha > 8 才算墨） */
function inkBox(ctx, S) {
  const d = ctx.getImageData(0, 0, S, S).data
  let minx = S, miny = S, maxx = -1, maxy = -1
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (d[(y * S + x) * 4 + 3] > 8) {
        if (x < minx) minx = x
        if (x > maxx) maxx = x
        if (y < miny) miny = y
        if (y > maxy) maxy = y
      }
    }
  }
  return maxx < 0 ? null : { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 }
}

/**
 * 把一个 emoji 烤成 PNG data URL。
 * 两趟绘制：第一趟量墨迹外框 → 按外框缩放到目标占比 → 第二趟再按新外框居中。
 * 环境里没有 emoji 字体时（老 Linux 容器）会烤出一张空图，调用方用 fallbackShape 兜底。
 */
function bake(char, mode) {
  const S = BOX
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const put = (px, dx = 0, dy = 0) => {
    ctx.clearRect(0, 0, S, S)
    ctx.font = `${px}px ${EMOJI_FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(char, S / 2 + dx, S / 2 + dy)
  }

  const BASE = Math.round(S * 0.8)
  put(BASE)
  const b1 = inkBox(ctx, S)
  if (!b1) return cv.toDataURL('image/png') // 没装 emoji 字体：留空图，让 fallbackShape 顶上
  const px = Math.max(6, Math.round((BASE * (S * INK)) / Math.max(b1.w, b1.h)))
  put(px)
  const b2 = inkBox(ctx, S)
  if (b2) put(px, S / 2 - (b2.x + b2.w / 2), S / 2 - (b2.y + b2.h / 2))

  if (mode === 'mask') {
    /* 遮罩模式：把彩色 emoji 压成「白色不透明」，并**预先**执行一遍着色器分支②的判据
     * （蓝通道 ≤ 2 的像素判为透明）—— 于是那三个灯位在离线就成了洞，
     * 运行时无论 L7 内部怎么取样，看到的都是同一张底图。 */
    const img = ctx.getImageData(0, 0, S, S)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const solid = d[i + 3] > 8 && d[i + 2] > 2
      d[i] = 255
      d[i + 1] = 255
      d[i + 2] = 255
      d[i + 3] = solid ? 255 : 0
    }
    ctx.putImageData(img, 0, 0)
  }
  return cv.toDataURL('image/png')
}

/* 烤一次缓存住：initTrafficLayers 可能被 HMR 重复调用，重复烤只是白等 100ms */
const baked = {}
/** 取某个图标的位图（data URL）。只在浏览器里调用 —— Node 侧的脚本只 import 上面的定义表。 */
export function emojiDataUrl(key) {
  const def = TRAFFIC_ICONS[key]
  if (!def) return ''
  if (!baked[key]) baked[key] = bake(def.char, def.mode)
  return baked[key]
}
