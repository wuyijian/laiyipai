const PRACTICE_INTENTS = Object.freeze(['随便练练', '切磋球技'])
const DEFAULT_PRACTICE_INTENT = PRACTICE_INTENTS[0]
const DEFAULT_CAPACITY = 2

function normalizePracticeIntent(value, legacySkills) {
  if (PRACTICE_INTENTS.includes(value)) return value
  if (Array.isArray(legacySkills)) {
    if (legacySkills.includes('切磋球技') || legacySkills.includes('实战对抗')) return '切磋球技'
    if (legacySkills.includes('随便练练')) return '随便练练'
  }
  return DEFAULT_PRACTICE_INTENT
}

module.exports = {
  DEFAULT_CAPACITY,
  PRACTICE_INTENTS,
  DEFAULT_PRACTICE_INTENT,
  normalizePracticeIntent
}
