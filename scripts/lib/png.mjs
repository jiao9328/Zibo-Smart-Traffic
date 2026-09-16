/* 极简 PNG 解码 + 区域比色计数。
 *
 * 为什么要自己写：环境里没有任何 png 解码依赖（pngjs/sharp/jimp 都没有），
 * 而 CDP 探针要回答的是个纯视觉问题——「这一屏上到底有没有画出这个颜色的像素」。
 * 先把截图丢回浏览器用 canvas 解码的写法试过：base64 塞进 Runtime.evaluate 之后
 * 整条 CDP 调用不返回也不报错，探针直接挂死（8 分钟 0 CPU），故改为在 Node 侧解。
 *
 * 只认自己截图会产出的那几种 PNG：8bit、真彩 RGB/RGBA/灰度、无隔行。
 */
import { inflateSync } from 'node:zlib'

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 } // 灰度 / RGB / 灰度+A / RGBA

/**
 * @param {Buffer} buf PNG 文件内容
 * @returns {{width:number, height:number, rgba:Uint8Array}} rgba 为逐像素 4 通道
 */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let off = 8
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const tag = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (tag === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      type = data[9]
      interlace = data[12]
    } else if (tag === 'IDAT') {
      idat.push(data)
    } else if (tag === 'IEND') {
      break
    }
    off += len + 12
  }
  if (depth !== 8) throw new Error(`只支持 8bit PNG，这次是 ${depth}bit`)
  if (interlace) throw new Error('不支持隔行 PNG')
  const ch = CHANNELS[type]
  if (!ch) throw new Error(`不支持的色彩类型 ${type}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const rgba = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        // Paeth
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = (y * width + x) * 4
      if (ch >= 3) {
        rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2]
        rgba[d + 3] = ch === 4 ? cur[s + 3] : 255
      } else {
        rgba[d] = rgba[d + 1] = rgba[d + 2] = cur[s]
        rgba[d + 3] = ch === 2 ? cur[s + 1] : 255
      }
    }
    prev = cur
  }
  return { width, height, rgba }
}

const hex2rgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim())
  if (!m) throw new Error(`不是 #RRGGBB：${hex}`)
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

/* redmean 加权 RGB 距离：比裸 RGB 距离更贴肉眼判断（明度权重算进去了）。
 * 判据用它而不是「逐通道容差」的原因：图标带 0.9 透明度，实际渲染色是被底图混过的
 * #7C4DFF → 约 (135,93,253)，逐通道容差 12 直接判成「不是这个色」（假失败）。 */
const redmean = (r, g, b, R, G, B) => {
  const rm = (r + R) / 2, dr = r - R, dg = g - G, db = b - B
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

/**
 * 在图片的指定区域内按「最近色」给像素归类计数。
 * @param {{width:number,height:number,rgba:Uint8Array}} img decodePNG 的返回值
 * @param {{x:number,y:number,width:number,height:number}} rect 统计区域（超出边界自动截断）
 * @param {{key:string,hex:string,maxDist?:number}[]} specs 要比的颜色；maxDist 默认 70，
 *   即「离这个色比离别的候选色都近、且不超过 70」才计入，其余落进 other
 * @returns {Record<string, number>} key → 像素数，外加 other
 */
export function classifyPixels(img, rect, specs) {
  const ts = specs.map((s) => ({ key: s.key, maxDist: s.maxDist ?? 70, rgb: hex2rgb(s.hex) }))
  const out = { other: 0 }
  for (const t of ts) out[t.key] = 0
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(img.width, Math.round(rect.x + rect.width))
  const y1 = Math.min(img.height, Math.round(rect.y + rect.height))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      const r = img.rgba[i], g = img.rgba[i + 1], b = img.rgba[i + 2]
      let bestKey = null, bestD = Infinity, bestMax = 0
      for (const t of ts) {
        const d = redmean(r, g, b, t.rgb[0], t.rgb[1], t.rgb[2])
        if (d < bestD) { bestD = d; bestKey = t.key; bestMax = t.maxDist }
      }
      if (bestD <= bestMax) out[bestKey]++
      else out.other++
    }
  }
  return out
}

/**
 * 找出与某色相近的像素构成的连通块（4 邻接），返回每块的像素数与包围盒，按面积降序。
 *
 * 用途：光数像素说明不了「画的是图标」——底图里也可能有相近色糊一大片。
 * 图标应该是若干**离散小块**（4~6px 的形状去掉白描边后约 3~40px），
 * 这个判据能把「真画了图标」和「底图噪声撞色」分开。
 *
 * @param {{width:number,height:number,rgba:Uint8Array}} img
 * @param {{x:number,y:number,width:number,height:number}} rect 搜索区域
 * @param {string} hex 目标色
 * @param {number} maxDist redmean 容差，默认 45
 * @returns {{n:number,x0:number,y0:number,x1:number,y1:number,cx:number,cy:number}[]}
 */
export function colorBlobs(img, rect, hex, maxDist = 45) {
  const [R, G, B] = hex2rgb(hex)
  const W = rect.width, H = rect.height
  const seen = new Uint8Array(W * H)
  const hit = (x, y) => {
    const i = ((rect.y + y) * img.width + rect.x + x) * 4
    return redmean(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], R, G, B) <= maxDist
  }
  const out = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = y * W + x
      if (seen[id] || !hit(x, y)) continue
      seen[id] = 1
      const st = [[x, y]]
      let n = 0, x0 = x, x1 = x, y0 = y, y1 = y
      while (st.length) {
        const [cx, cy] = st.pop()
        n++
        if (cx < x0) x0 = cx
        if (cx > x1) x1 = cx
        if (cy < y0) y0 = cy
        if (cy > y1) y1 = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const ni = ny * W + nx
          if (seen[ni] || !hit(nx, ny)) continue
          seen[ni] = 1
          st.push([nx, ny])
        }
      }
      out.push({
        n, x0: rect.x + x0, y0: rect.y + y0, x1: rect.x + x1, y1: rect.y + y1,
        cx: rect.x + Math.round((x0 + x1) / 2), cy: rect.y + Math.round((y0 + y1) / 2)
      })
    }
  }
  return out.sort((a, b) => b.n - a.n)
}
