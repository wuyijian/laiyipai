// A trace carries timings, not business payloads. Fast successes are sampled;
// failures and slow requests are always emitted to the existing cloud log.
function createTrace(options = {}) {
  const now = options.now || Date.now
  const emit = options.emit || (value => console.info('API_TIMING', JSON.stringify(value)))
  const started = now()
  const stages = {}
  return {
    async measure(stage, task) {
      const start = now()
      try { return await task() } finally { stages[stage] = Math.max(0, now() - start) }
    },
    finish({ action, requestId, code = 'OK', firstInvocation = false }) {
      const totalMs = Math.max(0, now() - started)
      if (code === 'OK' && totalMs < 1000 && (options.sample || Math.random)() >= .05) return
      try {
        emit({
          action: /^[A-Za-z][A-Za-z.]{1,59}$/.test(action || '') ? action : 'invalid',
          requestId: /^[A-Za-z0-9_-]{8,80}$/.test(requestId || '') ? requestId : '',
          code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'INTERNAL', firstInvocation, totalMs,
          identityMs: stages.identity || 0, rateLimitMs: stages.rateLimit || 0, handlerMs: stages.handler || 0
        })
      } catch (_) { /* Diagnostics must never change a business result. */ }
    }
  }
}
module.exports = { createTrace }
