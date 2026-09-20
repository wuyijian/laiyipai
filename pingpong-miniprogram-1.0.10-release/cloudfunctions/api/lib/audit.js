const { COLLECTIONS } = require('./constants')

async function writeAudit(context, action, resourceType, resourceId, summary = {}) {
  try {
    await context.db.collection(COLLECTIONS.auditLogs).add({
      data: {
        actorId: context.openid,
        action,
        resourceType,
        resourceId,
        requestId: context.requestId,
        summary,
        createdAt: context.serverDate()
      }
    })
  } catch (error) {
    console.error('AUDIT_WRITE_FAILED', context.requestId, error)
  }
}

module.exports = { writeAudit }
