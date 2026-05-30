// Generates build/icon.ico and build/icon.png — a flat printer glyph on an
// indigo rounded badge. Pure Node (zlib), no image deps. Run: node scripts/make-icon.mjs
import zlib from 'node:zlib'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------- PNG encoder ---------- */
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([len, tb, data, crc])
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/* ---------- drawing ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
function composite(rgba, size, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return
  const i = (y * size + x) * 4
  const da = rgba[i + 3] / 255
  const oa = a + da * (1 - a)
  if (oa <= 0) return
  rgba[i] = Math.round((r * a + rgba[i] * da * (1 - a)) / oa)
  rgba[i + 1] = Math.round((g * a + rgba[i + 1] * da * (1 - a)) / oa)
  rgba[i + 2] = Math.round((b * a + rgba[i + 2] * da * (1 - a)) / oa)
  rgba[i + 3] = Math.round(oa * 255)
}
function roundRect(rgba, size, cx, cy, hw, hh, r, color) {
  for (let y = Math.floor(cy - hh - 2); y <= Math.ceil(cy + hh + 2); y++) {
    for (let x = Math.floor(cx - hw - 2); x <= Math.ceil(cx + hw + 2); x++) {
      const qx = Math.abs(x - cx) - (hw - r)
      const qy = Math.abs(y - cy) - (hh - r)
      const ax = Math.max(qx, 0)
      const ay = Math.max(qy, 0)
      const d = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
      const a = clamp(0.5 - d, 0, 1)
      if (a > 0) composite(rgba, size, x, y, color, a)
    }
  }
}
const circle = (rgba, size, cx, cy, r, color) => roundRect(rgba, size, cx, cy, r, r, r, color)

function drawIcon(size) {
  const s = size / 256
  const rgba = Buffer.alloc(size * size * 4) // transparent
  const indigo = [79, 70, 229]
  const white = [255, 255, 255]
  const green = [34, 197, 94]

  // badge
  roundRect(rgba, size, 128 * s, 128 * s, 108 * s, 108 * s, 48 * s, indigo)
  // top paper (behind body)
  roundRect(rgba, size, 128 * s, 78 * s, 42 * s, 26 * s, 6 * s, white)
  // output receipt (behind body bottom)
  roundRect(rgba, size, 128 * s, 188 * s, 40 * s, 28 * s, 6 * s, white)
  // printer body
  roundRect(rgba, size, 128 * s, 132 * s, 64 * s, 34 * s, 16 * s, white)
  // paper-feed slot + exit slot (indigo cuts on the white body)
  roundRect(rgba, size, 128 * s, 116 * s, 52 * s, 5 * s, 5 * s, indigo)
  roundRect(rgba, size, 128 * s, 162 * s, 50 * s, 4 * s, 4 * s, indigo)
  // status LED
  circle(rgba, size, 168 * s, 140 * s, 6 * s, green)
  // receipt text lines (on the visible part below the body)
  for (const ly of [186, 197, 208]) roundRect(rgba, size, 128 * s, ly * s, 28 * s, 2.4 * s, 2 * s, indigo)

  return rgba
}

/* ---------- ICO wrapper ---------- */
function wrapIco(pngBuffers) {
  // pngBuffers: [{ size, data }]
  const count = pngBuffers.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const entries = []
  let offset = 6 + count * 16
  for (const { size, data } of pngBuffers) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // width (0 = 256)
    e[1] = size >= 256 ? 0 : size // height
    e[2] = 0 // colors
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)])
}

/* ---------- main ---------- */
const sizes = [256, 48, 32, 16]
const pngs = sizes.map((size) => ({ size, data: encodePng(size, drawIcon(size)) }))

await fs.mkdir(join(ROOT, 'build'), { recursive: true })
await fs.writeFile(join(ROOT, 'build', 'icon.ico'), wrapIco(pngs))
// 512×512 PNG for macOS (.icns is generated from it) and Linux.
await fs.writeFile(join(ROOT, 'build', 'icon.png'), encodePng(512, drawIcon(512)))
await fs.writeFile(join(ROOT, 'build', 'tray.png'), encodePng(32, drawIcon(32)))
console.log('wrote build/icon.ico (' + sizes.join(',') + '), build/icon.png (512), build/tray.png')
