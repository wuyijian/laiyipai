// Deterministic court illustrations: the same public venue ID looks the same everywhere.
const PALETTES = [
  ['#e6f1eb', '#37785e', '#c8dfd1'],
  ['#e7eef8', '#567ba8', '#cbd9ed'],
  ['#f6eade', '#ad7551', '#ebd1b6'],
  ['#eeebf6', '#8472a8', '#dbd2ec'],
  ['#f6e7eb', '#ad6d82', '#ebcad5'],
  ['#e5f0f0', '#468888', '#c4e0dd'],
  ['#f3efdc', '#a08843', '#e6d99f'],
  ['#edf0e5', '#758354', '#d7dfbd']
]

function variant(seed) {
  let hash = 2166136261
  for (const character of String(seed || 'laiyipai-venue').trim()) {
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0
  }
  const colors = PALETTES[hash % PALETTES.length]
  return {
    background: colors[0], court: colors[1], accent: colors[2],
    angle: [-12, -6, 6, 12][(hash >>> 4) % 4],
    ballLeft: [16, 68, 76][(hash >>> 8) % 3],
    ballTop: [16, 23, 68][(hash >>> 12) % 3],
    accentLeft: (hash >>> 16) % 2 ? -24 : 42
  }
}

module.exports = { variant }
