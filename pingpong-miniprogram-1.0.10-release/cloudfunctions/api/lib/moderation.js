const { ApiError } = require('./errors')

async function checkText(context, values, scene = 2) {
  const content = values.filter(Boolean).join('\n').trim()
  if (!content) return
  try {
    const response = await context.cloud.openapi.security.msgSecCheck({
      content: content.slice(0, 2500),
      version: 2,
      scene,
      openid: context.openid
    })
    const errCode = Number(response.errCode !== undefined ? response.errCode : response.errcode || 0)
    if (errCode && errCode !== 0) {
      if (errCode === 87014) throw new ApiError('CONTENT_REJECTED', '内容未通过安全检查，请修改后重试')
      throw new ApiError('CONTENT_CHECK_UNAVAILABLE', '内容安全检查暂不可用，请稍后重试')
    }
    const suggest = response.result && response.result.suggest || response.suggest
    if (!suggest) throw new ApiError('CONTENT_CHECK_UNAVAILABLE', '内容安全检查返回异常，请稍后重试')
    if (suggest !== 'pass') throw new ApiError('CONTENT_REJECTED', '内容未通过安全检查，请修改后重试')
  } catch (error) {
    if (error instanceof ApiError) throw error
    console.error('CONTENT_CHECK_FAILED', context.requestId, error)
    throw new ApiError('CONTENT_CHECK_UNAVAILABLE', '内容安全检查暂不可用，请稍后重试')
  }
}

module.exports = { checkText }
