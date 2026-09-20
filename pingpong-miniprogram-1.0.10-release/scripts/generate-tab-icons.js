// Code-native, supersampled line icons. No external fonts, images or packages.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const size = 72
const output = path.join(__dirname, '..', 'assets', 'tabbar')
const line = (x, y, a, b, c, d, w = 3.2) => {
  const dx = c - a, dy = d - b
  const t = Math.max(0, Math.min(1, ((x - a) * dx + (y - b) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - a - t * dx, y - b - t * dy) <= w / 2
}
const ring = (x, y, a, b, r, w = 3.2) => Math.abs(Math.hypot(x - a, y - b) - r) <= w / 2
const icons = {
  home: (x, y) => [[16,22,56,22],[56,22,56,52],[56,52,16,52],[16,52,16,22],[36,17,36,57],[16,37,56,37]].some(s => line(x,y,...s)),
  publish: (x, y) => ring(x,y,36,36,23) || line(x,y,26,36,46,36) || line(x,y,36,26,36,46),
  orders: (x, y) => [[18,21,54,21],[54,21,54,56],[54,56,18,56],[18,56,18,21],[18,31,54,31],[27,16,27,25],[45,16,45,25],[27,41,34,41],[42,41,45,41],[27,48,34,48]].some(s => line(x,y,...s)),
  profile: (x, y) => ring(x,y,36,25,10) || (y >= 44 && y <= 57 && Math.abs(Math.hypot((x-36), (y-62)) - 21) <= 1.6) || line(x,y,16,57,56,57)
}
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
  const label = Buffer.from(type)
  const n = Buffer.alloc(4), crc = Buffer.alloc(4)
  n.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([label,bytes])))
  return Buffer.concat([n,label,bytes,crc])
}
function png(draw, color) {
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
    let coverage = 0
    for (let sy=0; sy<4; sy++) for (let sx=0; sx<4; sx++) coverage += draw(x+(sx+.5)/4,y+(sy+.5)/4) ? 1 : 0
    const offset = y * (size * 4 + 1) + 1 + x * 4
    rows.set([...color, Math.round(coverage / 16 * 255)], offset)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8; header[9]=6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])
}
fs.mkdirSync(output,{recursive:true})
for (const [name,draw] of Object.entries(icons)) {
  fs.writeFileSync(path.join(output,`${name}.png`),png(draw,[119,129,123]))
  fs.writeFileSync(path.join(output,`${name}-active.png`),png(draw,[15,92,69]))
}
console.log('Generated 8 native tab bar icons (72 × 72).')
