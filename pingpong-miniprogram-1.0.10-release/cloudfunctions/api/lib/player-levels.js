// Canonical product catalog. Sync the client copy with scripts/sync-player-levels.js.
const ABILITY_STATES = ['未评估', '学习中', '定点会用', '变化会用', '实战熟练']
const ABILITY_HINTS = ['尚未了解或测评，不代表不会', '偶尔能完成，尚不稳定', '面对固定、已知来球，能较稳定完成', '来球位置或旋转变化后，仍能完成', '在相近水平比赛中，能反复有效使用']
const ABILITY_GROUPS = [
  ['正手', ['fh_drive', '正手攻球'], ['fh_topspin', '拉上旋'], ['fh_backspin', '拉下旋'], ['smash', '扣杀']],
  ['反手', ['bh_block', '推挡／拨球'], ['bh_drive', '反手攻球'], ['bh_loop', '反手拉球'], ['rpb', '直拍横打']],
  ['台内', ['fh_push', '正手搓球'], ['bh_push', '反手搓球'], ['short_touch', '摆短'], ['long_push', '劈长'], ['flick', '挑打'], ['bh_flick', '拧拉']],
  ['发球', ['serve_backspin', '下旋发球'], ['serve_no_spin', '不转发球'], ['serve_sidespin', '侧旋发球'], ['serve_length', '长短控制'], ['serve_variation', '旋转变化']],
  ['接发', ['read_spin', '旋转判断'], ['read_length', '长短判断'], ['receive_short', '接短球'], ['receive_long', '接长球'], ['receive_attack', '主动上手']],
  ['落点', ['placement_fixed', '定点控制'], ['placement_lines', '直斜线变化'], ['placement_corners', '两角调动'], ['placement_body', '追身控制'], ['placement_length', '长短变化']],
  ['步法', ['footwork_side', '并步移动'], ['footwork_in', '上步接短'], ['footwork_pivot', '侧身'], ['footwork_recover', '击球后还原']],
  ['衔接与实战', ['transition', '正反手转换'], ['continuous_attack', '连续进攻'], ['defense', '防守相持'], ['serve_attack', '发球抢攻'], ['receive_combination', '接发抢攻']]
].map(([label, ...items]) => ({ label, items: items.map(([id, label]) => ({ id, label })) }))
const EQUIPMENT = [
  { key: 'handedness', label: '持拍手', options: ['未填写', '右手', '左手'] },
  { key: 'grip', label: '握拍', options: ['未填写', '横板', '直板'] },
  { key: 'rubber', label: '胶皮', options: ['未填写', '两面反胶', '反胶', '长胶', '生胶', '正胶', '其他组合'] }
]
const TRAITS = [
  { key: 'styles', label: '主要打法', limit: 2, options: ['正手主导', '反手主导', '两面均衡', '控制型', '防守反击', '削球型'] },
  { key: 'strengths', label: '突出优势', limit: 3, options: ['发球变化多', '正手力量大', '落点精准', '相持稳定', '移动快'] },
  { key: 'habits', label: '使用习惯', limit: 3, options: ['喜欢侧身', '近台快打', '主动抢攻', '善打追身', '擅长变线'] }
]
const LEVEL_BANDS = [
  { min: 0, code: 'F', label: '启蒙', range: '900 以下' },
  { min: 900, code: 'E', label: '入门', range: '900—1199' },
  { min: 1200, code: 'D', label: '基础', range: '1200—1499' },
  { min: 1500, code: 'C', label: '进阶', range: '1500—1799' },
  { min: 1800, code: 'B', label: '熟练', range: '1800—2099' },
  { min: 2100, code: 'A', label: '高阶', range: '2100—2399' },
  { min: 2400, code: 'S+', label: '高水平', range: '2400 及以上' }
]
function level(platform, value) {
  const score = Number(value)
  if (platform !== '开球网' || !String(value || '').trim() || !Number.isInteger(score) || score < 1 || score > 9999) {
    return { code: '', label: '待定级', text: '待定级', note: platform && platform !== '未填写' && platform !== '开球网' ? '其他平台积分不直接换算等级' : '暂无开球网积分，可先填写技术与能力' }
  }
  const band = LEVEL_BANDS.slice().reverse().find(item => score >= item.min)
  const sub = band.code === 'F' || band.code === 'S+' ? '' : String(3 - Math.floor((score - band.min) / 100))
  const code = band.code + sub
  return { code, label: band.label, text: `${code} · ${band.label}`, note: '依据本人填写的开球网积分推导，尚未核验' }
}
function normalize(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const result = { abilities: {} }
  EQUIPMENT.forEach(item => { result[item.key] = item.options.includes(source[item.key]) ? source[item.key] : '未填写' })
  TRAITS.forEach(item => {
    result[item.key] = Array.from(new Set((Array.isArray(source[item.key]) ? source[item.key] : []).filter(v => item.options.includes(v)))).slice(0, item.limit)
  })
  ABILITY_GROUPS.forEach(group => group.items.forEach(item => {
    const state = source.abilities && source.abilities[item.id]
    if (Number.isInteger(state) && state > 0 && state < ABILITY_STATES.length) result.abilities[item.id] = state
  }))
  return result
}
function summary(profile = {}) {
  const value = normalize(profile.playingProfile)
  const abilities = ABILITY_GROUPS.flatMap(group => group.items.filter(item => value.abilities[item.id]).map(item => ({
    id: item.id, label: item.label, state: ABILITY_STATES[value.abilities[item.id]]
  })))
  return {
    level: level(profile.ratingPlatform, profile.ratingValue),
    equipmentText: EQUIPMENT.map(item => value[item.key]).filter(v => v !== '未填写').join(' · '),
    traits: TRAITS.flatMap(item => value[item.key]), abilities, assessedCount: abilities.length,
    source: '本人自评'
  }
}
module.exports = { ABILITY_STATES, ABILITY_HINTS, ABILITY_GROUPS, EQUIPMENT, TRAITS, LEVEL_BANDS, level, normalize, summary }
