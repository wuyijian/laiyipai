// Public reads are an explicit allowlist. Everything else, including private
// reads, continues through the full account/consent identity gate in index.js.
const PUBLIC_READ_ACTIONS = Object.freeze([
  'venues.list',
  'venues.nearby',
  'venues.get',
  'venueReviews.list',
  'matches.list',
  'matches.get',
  'coaches.list',
  'coaches.get',
  'players.get',
  'files.resolve'
])

function isPublicRead(action) {
  return PUBLIC_READ_ACTIONS.includes(action)
}

module.exports = { PUBLIC_READ_ACTIONS, isPublicRead }
