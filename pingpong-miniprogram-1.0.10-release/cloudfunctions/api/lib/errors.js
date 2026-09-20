class ApiError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

function assert(condition, code, message, details) {
  if (!condition) throw new ApiError(code, message, details)
}

module.exports = { ApiError, assert }
