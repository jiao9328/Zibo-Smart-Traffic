/* 最小 PNG 编码 + 放大/裁剪工具。
 *
 * 为什么要写：截图里 4~6px 的图标，肉眼和识图模型在 1600×900 整图里都看不见，
 * 必须「裁小块 + 整数倍邻近放大」拼成对照图才看得出画的是什么形状。
 * 环境里没有 sharp/pngjs，就用 zlib + CRC32 自己拼（8bit 真彩 RGBA，不压缩花活）。
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

const crc32 = (buf) => {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (~c) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * @param {{width:number,height:number,rgba:Uint8Array}} img
 * @returns {Buffer} PNG 文件内容（8bit RGBA）
 */
export function encodePNG(img) {
  const { width, height, rgba } = img
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器 0（无过滤）：文件大点但实现简单，对照图不看体积
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 从源图裁一块并做整数倍邻近放大（放大后才看得清单个像素的形状）。
 * 越界部分补白，方便小图块的边缘不被截断。
 */
export function cropZoom(img, cx, cy, size, factor) {
  const half = Math.floor(size / 2)
  const out = { width: size * factor, height: size * factor, rgba: new Uint8Array(size * factor * size * factor * 4) }
  out.rgba.fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = cx - half + x, sy = cy - half + y
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue
      const si = (sy * img.width + sx) * 4
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const di = ((y * factor + dy) * out.width + (x * factor + dx)) * 4
          out.rgba[di] = img.rgba[si]
          out.rgba[di + 1] = img.rgba[si + 1]
          out.rgba[di + 2] = img.rgba[si + 2]
          out.rgba[di + 3] = 255
        }
      }
    }
  }
  return out
}

/**
 * 整数倍缩小（每 factor×factor 方块取左上角那个像素）。
 * 用途：几张 1440×900 的整页截图要一眼同看时，先缩再拼，否则识图模型看的是四张各自的大图。
 * 最近邻取样会丢细线（小字会糊），只看「页面是什么状态」够用，不要用它看图标细节。
 */
export function downscale(img, factor) {
  const width = Math.max(1, Math.floor(img.width / factor))
  const height = Math.max(1, Math.floor(img.height / factor))
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * factor * img.width + x * factor) * 4
      const d = (y * width + x) * 4
      rgba[d] = img.rgba[s]; rgba[d + 1] = img.rgba[s + 1]
      rgba[d + 2] = img.rgba[s + 2]; rgba[d + 3] = 255
    }
  }
  return { width, height, rgba }
}

/** 把若干张同尺寸小块横向/纵向拼成一张对照图，块与块之间留 borderWidth 像素白缝 */
export function montage(tiles, cols, borderWidth = 6) {
  const tw = tiles[0].width, th = tiles[0].height
  const rows = Math.ceil(tiles.length / cols)
  const width = cols * tw + (cols + 1) * borderWidth
  const height = rows * th + (rows + 1) * borderWidth
  const rgba = new Uint8Array(width * height * 4)
  rgba.fill(255)
  tiles.forEach((t, i) => {
    const ox = borderWidth + (i % cols) * (tw + borderWidth)
    const oy = borderWidth + Math.floor(i / cols) * (th + borderWidth)
    for (let y = 0; y < th; y++) {
      const src = y * tw * 4
      const dst = ((oy + y) * width + ox) * 4
      rgba.set(t.rgba.subarray(src, src + tw * 4), dst)
    }
  })
  return { width, height, rgba }
}
