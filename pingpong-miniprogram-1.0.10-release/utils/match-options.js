const PRACTICE_INTENTS = Object.freeze(['随便练练', '切磋球技'])
const DEFAULT_PRACTICE_INTENT = PRACTICE_INTENTS[0]
const DEFAULT_CAPACITY = 2
const DISTRICTS = Object.freeze(['滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区'])
const DISTRICT_OPTIONS = Object.freeze(['暂不选择'].concat(DISTRICTS))

function districtValue(value) { return DISTRICTS.includes(value) ? value : '' }

function normalizePracticeIntent(value, legacySkills) {
  if (PRACTICE_INTENTS.includes(value)) return value
  if (Array.isArray(legacySkills)) {
    if (legacySkills.includes('切磋球技') || legacySkills.includes('实战对抗')) return '切磋球技'
    if (legacySkills.includes('随便练练')) return '随便练练'
  }
  return DEFAULT_PRACTICE_INTENT
}

module.exports = {
  DISTRICTS,
  DISTRICT_OPTIONS,
  districtValue,
  DEFAULT_CAPACITY,
  PRACTICE_INTENTS,
  DEFAULT_PRACTICE_INTENT,
  normalizePracticeIntent
}
