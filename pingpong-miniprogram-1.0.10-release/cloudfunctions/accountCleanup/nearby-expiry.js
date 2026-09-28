// Do not let a stale cleanup snapshot clear a location the user just refreshed.
module.exports = async function cleanupNearby(db, now = Date.now()) {
  const rows = await db.collection('users')
    .where({ 'profile.nearbyDiscovery.enabled': true, 'profile.nearbyDiscovery.expiresAt': db.command.lt(now + 1) })
    .orderBy('profile.nearbyDiscovery.expiresAt', 'asc').limit(100).field({ _id: true }).get()
  let cleared = 0, failed = 0
  for (const row of rows.data || []) {
    try {
      const changed = await db.runTransaction(async tx => {
        const ref = tx.collection('users').doc(row._id)
        const result = await ref.get()
        const user = Array.isArray(result.data) ? result.data[0] : result.data
        const value = user && user.profile && user.profile.nearbyDiscovery
        if (!value || value.enabled !== true || !Number.isFinite(value.expiresAt) || value.expiresAt > now) return false
        await ref.update({ data: { 'profile.nearbyDiscovery': { enabled: false, point: null, expiresAt: 0 } } })
        return true
      })
      if (changed) cleared++
    } catch (_) { failed++ }
  }
  return { matched: (rows.data || []).length, cleared, failed, batchFull: (rows.data || []).length === 100 }
}
