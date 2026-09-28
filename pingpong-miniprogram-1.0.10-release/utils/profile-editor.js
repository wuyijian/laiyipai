const levels = require('./player-levels')
function view(profile, groupIndex = 0) {
  const value = levels.normalize(profile.playingProfile)
  const group = levels.ABILITY_GROUPS[groupIndex] || levels.ABILITY_GROUPS[0]
  return {
    editLevel: levels.level(profile.ratingPlatform, profile.ratingValue),
    equipmentFields: levels.EQUIPMENT.map(item => Object.assign({}, item, { index: item.options.indexOf(value[item.key]) })),
    traitGroups: levels.TRAITS.map(item => Object.assign({}, item, {
      count: value[item.key].length,
      choices: item.options.map(label => ({ label, selected: value[item.key].includes(label) }))
    })),
    abilityRows: group.items.map(item => Object.assign({}, item, {
      state: value.abilities[item.id] || 0,
      hint: levels.ABILITY_HINTS[value.abilities[item.id] || 0]
    })),
    assessedCount: Object.keys(value.abilities).length
  }
}
module.exports = { view }
