// Page data is JSON-compatible. Compare before crossing the JS/view bridge;
// preserve whole-array replacement semantics for removals and reordering.
function equal(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]))
}

function changedPatch(current, incoming) {
  const patch = {}
  Object.keys(incoming).forEach(key => {
    if (!equal(current[key], incoming[key])) patch[key] = incoming[key]
  })
  return patch
}

module.exports = { changedPatch }
