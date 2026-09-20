function number(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && !value.trim()) return null
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : null
}

function normalizePoint(value) {
  if (!value || typeof value !== 'object') return null
  const coordinates = Array.isArray(value.coordinates) ? value.coordinates : null
  const longitude = number(coordinates ? coordinates[0] : value.longitude)
  const latitude = number(coordinates ? coordinates[1] : value.latitude)
  if (longitude === null || latitude === null) return null
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null
  return { longitude, latitude }
}

module.exports = { normalizePoint }
