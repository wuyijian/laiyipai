const api = require('../../utils/api')
const privacy = require('../../utils/privacy')
const errors = require('../../utils/error')
const cloudConfig = require('../../utils/cloud-config')

const APPLICATION_STATUSES = ['not_submitted', 'reviewing', 'approved', 'rejected']
const SPECIALTY_VALUES = ['少儿启蒙', '成人零基础', '基本功', '发球接发', '正手进攻', '反手技术', '步法训练', '实战陪练']

function blankForm() {
  return {
    realName: '',
    mobile: '',
    experienceYears: '',
    specialty: [],
    venueName: '',
    qualification: '',
    introduction: ''
  }
}

function unwrapApplication(result) {
  if (!result) return null
  return result.application !== undefined ? result.application : result
}

function normalizeApplication(result) {
  const envelopeStatus = result && result.status
  const raw = unwrapApplication(result)
  const source = raw && typeof raw === 'object' ? raw : {}
  const status = APPLICATION_STATUSES.includes(source.status)
    ? source.status
    : APPLICATION_STATUSES.includes(envelopeStatus) ? envelopeStatus : 'not_submitted'
  const mobile = String(source.mobile || '')
  const experienceYears = source.experienceYears === undefined || source.experienceYears === null
    ? '' : String(source.experienceYears)
  const specialty = Array.isArray(source.specialty) ? source.specialty.filter(Boolean).slice(0, 6) : []
  return Object.assign({}, source, {
    status,
    realName: String(source.realName || ''),
    mobile,
    mobileMasked: mobile.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
    experienceYears,
    experienceText: experienceYears === '' ? '未填写' : `${experienceYears} 年`,
    specialty,
    specialtyText: specialty.length ? specialty.join('、') : '未填写',
    venueName: String(source.venueName || ''),
    introduction: String(source.introduction || ''),
    qualification: String(source.qualification || ''),
    reviewReason: String(source.reviewReason || ''),
    version: Number(source.version || 0)
  })
}

function formFromApplication(application) {
  const form = blankForm()
  if (!application || application.status === 'not_submitted') return form
  Object.keys(form).forEach((key) => {
    if (key === 'specialty') form[key] = application.specialty.slice()
    else form[key] = application[key] === undefined || application[key] === null ? '' : String(application[key])
  })
  return form
}

function specialtyOptions(selected) {
  return SPECIALTY_VALUES.map((value) => ({ value, selected: selected.includes(value) }))
}

Page({
  data: {
    state: 'loading',
    errorMessage: '',
    status: 'not_submitted',
    application: normalizeApplication(null),
    form: blankForm(),
    specialtyOptions: specialtyOptions([]),
    termsAccepted: false,
    submitting: false,
    submitError: ''
  },

  onLoad() {
    this.loadApplication()
  },

  onPullDownRefresh() {
    this.loadApplication().finally(() => wx.stopPullDownRefresh())
  },

  async loadApplication(event) {
    if (this.loading) return this.loading
    this.setData({ state: 'loading', errorMessage: '' })
    this.loading = (async () => {
      try {
        await getApp().ensureSession({ interactive: Boolean(event && event.currentTarget) })
        if (!api.coachApplications || typeof api.coachApplications.get !== 'function') {
          throw new Error('教练认证服务暂未开放')
        }
        const result = await api.coachApplications.get()
        const application = normalizeApplication(result)
        const form = formFromApplication(application)
        this.setData({
          state: 'ready',
          status: application.status,
          application,
          form,
          specialtyOptions: specialtyOptions(form.specialty),
          termsAccepted: false,
          submitError: ''
        })
      } catch (error) {
        this.setData({ state: 'error', errorMessage: errors.message(error, '认证状态暂时无法加载') })
      }
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  },

  changeText(event) {
    if (this.data.submitting) return
    const field = event.currentTarget.dataset.field
    if (!Object.prototype.hasOwnProperty.call(this.data.form, field)) return
    this.setData({ [`form.${field}`]: event.detail.value, submitError: '' })
  },

  changeMobile(event) {
    if (this.data.submitting) return
    const mobile = String(event.detail.value || '').replace(/\D/g, '').slice(0, 11)
    this.setData({ 'form.mobile': mobile, submitError: '' })
  },

  changeExperience(event) {
    if (this.data.submitting) return
    const experienceYears = String(event.detail.value || '').replace(/\D/g, '').slice(0, 2)
    this.setData({ 'form.experienceYears': experienceYears, submitError: '' })
  },

  toggleSpecialty(event) {
    if (this.data.submitting) return
    const value = event.currentTarget.dataset.value
    const current = this.data.form.specialty.slice()
    const index = current.indexOf(value)
    if (index >= 0) current.splice(index, 1)
    else {
      if (current.length >= 6) return wx.showToast({ title: '最多选择 6 项', icon: 'none' })
      current.push(value)
    }
    this.setData({
      'form.specialty': current,
      specialtyOptions: specialtyOptions(current),
      submitError: ''
    })
  },

  changeTerms(event) {
    if (this.data.submitting) return
    const values = event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ termsAccepted: values.includes('accepted'), submitError: '' })
  },

  validateForm() {
    const form = this.data.form
    const realName = form.realName.trim()
    if (realName.length < 2 || realName.length > 20) return '请填写 2—20 个字的真实姓名'
    if (!/^1[3-9]\d{9}$/.test(form.mobile)) return '请填写有效的 11 位手机号'
    if (form.experienceYears === '') return '请填写教学或训练年限；不足一年可填 0'
    const years = Number(form.experienceYears)
    if (!Number.isInteger(years) || years < 0 || years > 60) return '教学或训练年限请填写 0—60'
    if (!form.specialty.length) return '请至少选择 1 项擅长方向'
    if (form.venueName.trim().length < 2) return '请填写常驻或可授课球馆名称'
    const qualification = form.qualification.trim()
    if (qualification.length < 5) return '请用至少 5 个字说明教学或比赛资历'
    if (qualification.length > 300) return '资历说明不能超过 300 字'
    if (form.introduction.trim().length > 500) return '教学简介不能超过 500 字'
    if (!this.data.termsAccepted) return '请先确认资料真实并同意平台规则'
    return ''
  },

  applicationPayload() {
    const form = this.data.form
    const payload = {
      realName: form.realName.trim(),
      mobile: form.mobile,
      experienceYears: Number(form.experienceYears),
      specialty: form.specialty.slice(),
      venueName: form.venueName.trim(),
      introduction: form.introduction.trim(),
      qualification: form.qualification.trim(),
      termsAccepted: true,
      termsVersion: cloudConfig.termsVersion
    }
    if (this.data.status === 'rejected' && this.data.application.version) {
      payload.expectedVersion = this.data.application.version
    }
    return payload
  },

  async submitApplication() {
    if (this.data.submitting) return
    const validationError = this.validateForm()
    if (validationError) return this.setData({ submitError: validationError })
    if (!api.coachApplications || typeof api.coachApplications.submit !== 'function') {
      return this.setData({ submitError: '教练认证服务暂未开放' })
    }

    const payload = this.applicationPayload()
    this.setData({ submitting: true, submitError: '' })
    try {
      await privacy.authorize()
      const result = await api.coachApplications.submit(payload)
      const returned = unwrapApplication(result)
      const application = normalizeApplication(Object.assign({}, payload, returned || {}, {
        status: returned && returned.status || 'reviewing'
      }))
      this.setData({
        submitting: false,
        state: 'ready',
        status: application.status,
        application,
        form: formFromApplication(application),
        specialtyOptions: specialtyOptions(application.specialty)
      })
      wx.pageScrollTo({ scrollTop: 0, duration: 200 })
      wx.showToast({ title: '申请已提交', icon: 'success' })
    } catch (error) {
      this.setData({ submitting: false, submitError: errors.message(error, '提交失败，请稍后重试') })
    }
  },

  retry(event) {
    return this.loadApplication(event)
  }
})
