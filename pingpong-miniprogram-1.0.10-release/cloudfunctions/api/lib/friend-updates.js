const { ApiError } = require('./errors')
const validate = require('./validate')

// 个人主体审核版不提供公开动态。保留原路由是为了让 1.0.7 客户端
// 在滚动升级期平稳降级，而不是恢复社区能力。
function unavailable() {
  throw new ApiError('FEATURE_UNAVAILABLE', '当前版本已不提供球友动态，请使用发球局约球')
}

async function list(context, payload = {}) {
  const paging = validate.pagination(payload)
  return {
    mine: null,
    items: [],
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: false,
    featureAvailable: false
  }
}

async function get() { return unavailable() }
async function publish() { return unavailable() }
async function remove() { return unavailable() }

module.exports = { list, get, publish, remove, _private: { unavailable } }
