const { COLLECTIONS } = require('./constants')
const { assert } = require('./errors')
const validate = require('./validate')
const presenters = require('./presenters')
const { stableId, getDocument } = require('./database')
const { writeAudit } = require('./audit')
const { checkText } = require('./moderation')
const terms = require('./terms')

async function create(context, payload) {
  const termsVersion = terms.requireAcceptance(payload)
  const slotId = validate.id(payload.slotId, '教练时段 ID')
  const note = validate.text(payload.note || '', '预约备注', { required: false, max: 200 })
  await checkText(context, [note], 2)
  validate.id(context.requestId, '请求 ID')
  const bookingId = stableId('coach-booking', context.openid, slotId)
  const existing = await getDocument(context.db.collection(COLLECTIONS.coachBookings).doc(bookingId))
  if (existing && existing.requestId === context.requestId) return { booking: presenters.booking(existing), idempotent: true }
  if (existing && existing.status === 'confirmed') return { booking: presenters.booking(existing), idempotent: true }

  let idempotent = false
  await context.db.runTransaction(async (transaction) => {
    const bookingRef = transaction.collection(COLLECTIONS.coachBookings).doc(bookingId)
    const currentBooking = await getDocument(bookingRef)
    if (currentBooking && (currentBooking.requestId === context.requestId || currentBooking.status === 'confirmed')) {
      idempotent = true
      return
    }
    const slotRef = transaction.collection(COLLECTIONS.coachSlots).doc(slotId)
    const slot = await getDocument(slotRef)
    assert(slot && slot.status === 'open', 'SLOT_CLOSED', '该教练时段已不可预约')
    assert(new Date(slot.startAt).getTime() > Date.now(), 'SLOT_CLOSED', '该教练时段已开始')
    assert(Number(slot.bookedCount || 0) < Number(slot.capacity || 1), 'SLOT_FULL', '该教练时段已约满')
    const coach = await getDocument(transaction.collection(COLLECTIONS.coaches).doc(slot.coachId))
    const venue = await getDocument(transaction.collection(COLLECTIONS.venues).doc(slot.venueId))
    assert(coach && coach.active && coach.verificationStatus === 'verified', 'NOT_FOUND', '教练当前不可预约')
    assert(venue && venue.active && venue.verificationStatus === 'verified', 'NOT_FOUND', '上课球馆当前不可用')
    const bookedCount = Number(slot.bookedCount || 0) + 1
    await slotRef.update({ data: {
      bookedCount,
      status: bookedCount >= Number(slot.capacity || 1) ? 'full' : 'open',
      version: Number(slot.version || 1) + 1,
      updatedAt: context.serverDate()
    } })
    const bookingData = {
      userId: context.openid,
      userSnapshot: presenters.playerSnapshot(context.user),
      coachId: slot.coachId,
      coachSnapshot: { id: slot.coachId, name: coach.name, avatarFileId: coach.avatarFileId || '' },
      slotId,
      venueId: slot.venueId,
      venueSnapshot: { id: slot.venueId, name: venue.name, address: venue.address },
      startAt: slot.startAt,
      endAt: slot.endAt,
      price: Number(slot.price || 0),
      note,
      status: 'confirmed',
      cancellationReason: '',
      cancellationRequestId: '',
      cancelledAt: null,
      version: Number(currentBooking && currentBooking.version || 0) + 1,
      requestId: context.requestId,
      termsVersion,
      termsAcceptedAt: context.serverDate(),
      createdAt: currentBooking && currentBooking.createdAt || context.serverDate(),
      updatedAt: context.serverDate()
    }
    if (currentBooking) await bookingRef.update({ data: bookingData })
    else await bookingRef.set({ data: bookingData })
  })
  const booking = await getDocument(context.db.collection(COLLECTIONS.coachBookings).doc(bookingId))
  await writeAudit(context, 'coachBookings.create', 'coachBooking', bookingId, { slotId })
  return { booking: presenters.booking(booking), idempotent }
}

async function cancel(context, payload) {
  const bookingId = validate.id(payload.bookingId, '预约 ID')
  const expectedVersion = validate.integer(payload.expectedVersion, '预约版本', { min: 1 })
  const reason = validate.text(payload.reason, '取消原因', { min: 2, max: 120 })
  await checkText(context, [reason], 2)
  const cutoffHours = Number(process.env.LAIYIPAI_COACH_CANCEL_HOURS || 12)
  await context.db.runTransaction(async (transaction) => {
    const bookingRef = transaction.collection(COLLECTIONS.coachBookings).doc(bookingId)
    const booking = await getDocument(bookingRef)
    assert(booking && booking.userId === context.openid, 'NOT_FOUND', '预约不存在')
    if (booking.status === 'cancelled' && booking.cancellationRequestId === context.requestId) return
    assert(Number(booking.version || 1) === expectedVersion, 'VERSION_CONFLICT', '预约状态已更新，请刷新后重试')
    if (booking.status === 'cancelled') return
    assert(booking.status === 'confirmed', 'BOOKING_CLOSED', '当前预约无法取消')
    assert(new Date(booking.startAt).getTime() - Date.now() >= cutoffHours * 60 * 60 * 1000, 'CANCELLATION_WINDOW_CLOSED', `开课前 ${cutoffHours} 小时内请联系球馆处理`)
    const slotRef = transaction.collection(COLLECTIONS.coachSlots).doc(booking.slotId)
    const slot = await getDocument(slotRef)
    await bookingRef.update({ data: {
      status: 'cancelled',
      cancellationReason: reason,
      cancellationRequestId: context.requestId,
      cancelledAt: context.serverDate(),
      version: expectedVersion + 1,
      updatedAt: context.serverDate()
    } })
    if (slot) {
      await slotRef.update({ data: {
        bookedCount: Math.max(0, Number(slot.bookedCount || 0) - 1),
        status: 'open',
        version: Number(slot.version || 1) + 1,
        updatedAt: context.serverDate()
      } })
    }
  })
  const booking = await getDocument(context.db.collection(COLLECTIONS.coachBookings).doc(bookingId))
  await writeAudit(context, 'coachBookings.cancel', 'coachBooking', bookingId, {})
  return { booking: presenters.booking(booking) }
}

module.exports = { create, cancel }
