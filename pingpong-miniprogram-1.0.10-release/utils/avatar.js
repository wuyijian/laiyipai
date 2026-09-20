// Stable variations from a public player ID: no remote images or device storage.
const PALETTES = [
  ['#edf0dd', '#526a3e', '#d7e895'],
  ['#f5e7db', '#b45e43', '#f2bd88'],
  ['#e8e8f4', '#6c68a0', '#c5bfe6'],
  ['#dfefea', '#2f7969', '#9cd0bd'],
  ['#e3ecf3', '#477591', '#b3d2e0'],
  ['#f4e4e9', '#a6647b', '#e7b2c3'],
  ['#f3edce', '#9a7b37', '#e9cd70'],
  ['#e8ebe7', '#53665b', '#bbc9bd']
]

function variant(seed) {
  let hash = 2166136261
  for (const character of String(seed || 'laiyipai')) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  }
  const colors = PALETTES[hash % PALETTES.length]
  return {
    background: colors[0], blade: colors[1], accent: colors[2],
    angle: [-32, -18, 18, 32][(hash >>> 4) % 4],
    ballLeft: (hash >>> 8) % 2 ? '72%' : '15%'
  }
}

module.exports = { variant }
