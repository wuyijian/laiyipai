const META_KEY = 'laiyipai_storage_meta_v1'
const SCHEMA_VERSION = 1

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function isMissing(value) {
  return value === undefined || value === null || value === ''
}

function readRaw(key) {
  try {
    return wx.getStorageSync(key)
  } catch (error) {
    return undefined
  }
}

function read(key, fallback) {
  const value = readRaw(key)
  return isMissing(value) ? clone(fallback) : value
}

function has(key) {
  return !isMissing(readRaw(key))
}

function updateMeta(key) {
  try {
    const current = readRaw(META_KEY)
    const meta = current && typeof current === 'object' ? current : {}
    const keys = Array.isArray(meta.keys) ? meta.keys.slice() : []
    if (key && key !== META_KEY && keys.indexOf(key) < 0) keys.push(key)
    wx.setStorageSync(META_KEY, {
      schemaVersion: SCHEMA_VERSION,
      keys,
      lastWriteAt: new Date().toISOString()
    })
  } catch (error) {
    // 元数据写入失败不应影响已经完成的业务数据写入。
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value)
    updateMeta(key)
  } catch (_) {
    // 筛选和草稿属于便利状态，本地存储失败不能阻断云端业务操作。
  }
  return value
}

function remove(key) {
  try {
    if (typeof wx.removeStorageSync === 'function') wx.removeStorageSync(key)
    else wx.setStorageSync(key, '')
    const meta = readRaw(META_KEY)
    if (meta && Array.isArray(meta.keys)) {
      meta.keys = meta.keys.filter((item) => item !== key)
      meta.lastWriteAt = new Date().toISOString()
      wx.setStorageSync(META_KEY, meta)
    }
  } catch (error) {
    // 清理元数据失败不影响业务数据删除。
  }
}

function init() {
  const meta = readRaw(META_KEY)
  if (!meta || meta.schemaVersion !== SCHEMA_VERSION) updateMeta()
}

function getSummary() {
  const meta = read(META_KEY, { schemaVersion: SCHEMA_VERSION, keys: [], lastWriteAt: '' })
  let currentSize = 0
  let limitSize = 0
  try {
    if (typeof wx.getStorageInfoSync === 'function') {
      const info = wx.getStorageInfoSync()
      currentSize = info.currentSize || 0
      limitSize = info.limitSize || 0
    }
  } catch (error) {
    // 部分开发工具环境不提供容量信息。
  }
  return Object.assign({}, meta, { currentSize, limitSize })
}

module.exports = {
  SCHEMA_VERSION,
  init,
  has,
  read,
  write,
  remove,
  getSummary
}
