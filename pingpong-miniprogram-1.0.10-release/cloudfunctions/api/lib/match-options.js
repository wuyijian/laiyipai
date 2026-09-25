const PRACTICE_INTENTS = Object.freeze(['随便练练', '切磋球技'])
const DEFAULT_PRACTICE_INTENT = PRACTICE_INTENTS[0]
const DISTRICTS = Object.freeze(['滨江区', '萧山区', '上城区', '西湖区', '拱墅区', '余杭区', '临平区', '钱塘区', '富阳区', '临安区'])

function normalizeStoredPracticeIntent(value, legacySkills) {
  if (PRACTICE_INTENTS.includes(value)) return value
  if (Array.isArray(legacySkills)) {
    if (legacySkills.includes('切磋球技') || legacySkills.includes('实战对抗')) return '切磋球技'
    if (legacySkills.includes('随便练练')) return '随便练练'
  }
  return DEFAULT_PRACTICE_INTENT
}

module.exports = {
  DISTRICTS,
  PRACTICE_INTENTS,
  DEFAULT_PRACTICE_INTENT,
  normalizeStoredPracticeIntent
}
