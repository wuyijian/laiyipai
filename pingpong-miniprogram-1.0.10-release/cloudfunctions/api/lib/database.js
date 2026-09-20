const crypto = require('crypto')

function stableId(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

function unwrapDocument(result) {
  if (!result) return null
  if (Array.isArray(result.data)) return result.data[0] || null
  return result.data || null
}

function isMissingDocument(error) {
  const text = `${error && error.errCode || ''} ${error && error.errMsg || ''} ${error && error.message || ''}`
  return /DOCUMENT_NOT_EXIST|not exist|does not exist|找不到|不存在/i.test(text)
}

async function getDocument(ref) {
  try {
    return unwrapDocument(await ref.get())
  } catch (error) {
    if (isMissingDocument(error)) return null
    throw error
  }
}

function stripInternal(document, extraFields = []) {
  if (!document) return null
  const result = Object.assign({}, document)
  ;['_openid', 'openid', 'unionid', 'userId', 'hostId', 'ownerId', 'actorId'].concat(extraFields).forEach((field) => {
    delete result[field]
  })
  return result
}

module.exports = {
  stableId,
  randomId,
  unwrapDocument,
  getDocument,
  stripInternal
}
