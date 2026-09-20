const { ApiError } = require('./errors')

function unavailable() {
  throw new ApiError('FEATURE_UNAVAILABLE', '当前版本已不提供动态回复，请在球局内沟通')
}

// 回复列表只存在于已下线的动态详情中，不返回旧 UGC 内容。
async function list() { return unavailable() }
async function send() { return unavailable() }

module.exports = { list, send, _private: { unavailable } }
