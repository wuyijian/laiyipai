const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const levels = require('../utils/player-levels')
const root = path.resolve(__dirname, '..')
assert.strictEqual(fs.readFileSync(path.join(root, 'utils/player-levels.js'), 'utf8'), fs.readFileSync(path.join(root, 'cloudfunctions/api/lib/player-levels.js'), 'utf8'), 'client and cloud catalog must stay identical')
for (const [score, code] of [[1,'F'],[899,'F'],[900,'E3'],[1199,'E1'],[1200,'D3'],[1499,'D1'],[1500,'C3'],[1599,'C3'],[1600,'C2'],[1628,'C2'],[1699,'C2'],[1700,'C1'],[1799,'C1'],[1800,'B3'],[2099,'B1'],[2100,'A3'],[2399,'A1'],[2400,'S+'],[9999,'S+']]) {
  assert.strictEqual(levels.level('开球网', score).code, code)
}
for (const value of ['', 0, -1, 10000, null, 1600.1, 'abc']) assert.strictEqual(levels.level('开球网', value).code, '')
assert.strictEqual(levels.level('ChinaTT', '1628').code, '')
assert.strictEqual(levels.level('未填写', '1628').code, '')
assert.strictEqual(levels.summary({}).assessedCount, 0)

let definition, saved
let rejectSave = false, oldServer = false
const notices = []
const api = { profile: { update: async value => {
  if (rejectSave) throw new Error('网络失败')
  saved = JSON.parse(JSON.stringify(value)); return oldServer ? {} : saved
} } }
vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/profile.js'), 'utf8'), {
  Page: value => { definition = value }, setTimeout, clearTimeout,
  wx: { showToast: value => notices.push(value.title), showModal: value => value.success({ confirm: true }) },
  require(name) {
    if (name === '../../utils/api') return api
    if (name === '../../utils/privacy') return { authorize: async () => {} }
    return require(path.resolve(root, 'pages/profile', name))
  }
})
function page() {
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)) })
  p.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = p.data
      while (parts.length > 1) { const name = parts.shift(); target = target[name] || (target[name] = {}) }
      target[parts[0]] = value
    }
  }
  p.data.profile = { nickname: '球友', skills: ['旧技术备注'], ratingPlatform: '未填写', ratingValue: '' }
  p.loadProfile = async () => {}
  p.openEdit()
  return p
}
const event = (value, dataset = {}) => ({ detail: { value }, currentTarget: { dataset } })
async function run() {
  const p = page()
  p.selectDistrict(event(String(p.data.districtOptions.indexOf('西湖区'))))
  assert.strictEqual(p.data.editProfile.district, '西湖区')
  p.selectDistrict(event('0'))
  assert.strictEqual(p.data.editProfile.district, '')
  const legacyDistrict = page()
  legacyDistrict.data.profile.district = '旧地区备注'
  legacyDistrict.openEdit()
  assert.strictEqual(legacyDistrict.data.districtOptions[legacyDistrict.data.editDistrictIndex], '旧地区备注')
  assert.strictEqual(p.data.editLevel.text, '待定级')
  p.changeRatingPlatform(event('1')); p.changeRatingValue(event('1628'))
  assert.strictEqual(p.data.editLevel.text, 'C2 · 进阶')
  p.changeEquipment(event('2', { field: 'handedness' }))
  p.toggleTrait(event('', { field: 'styles', value: '正手主导' }))
  p.toggleTrait(event('', { field: 'styles', value: '控制型' }))
  p.toggleTrait(event('', { field: 'styles', value: '削球型' }))
  assert.strictEqual(p.data.editProfile.playingProfile.styles.length, 2)
  assert(notices.some(value => value.includes('最多选择 2')))
  p.changeAbility(event('4', { id: 'fh_drive' }))
  p.changeAbilityGroup(event('5'))
  p.changeAbility(event('3', { id: 'placement_lines' }))
  assert.strictEqual(p.data.assessedCount, 2)
  assert.strictEqual(p.data.editLevel.code, 'C2', 'ability changes do not affect grade')
  rejectSave = true
  await p.saveProfile()
  assert.strictEqual(p.data.editVisible, true)
  assert.strictEqual(p.data.editProfile.playingProfile.abilities.fh_drive, 4)
  assert.strictEqual(p.data.saving, false)
  rejectSave = false; oldServer = true
  await p.saveProfile()
  assert(p.data.editError.includes('尚未更新'))
  assert.strictEqual(p.data.editVisible, true)
  oldServer = false
  await p.saveProfile()
  assert.strictEqual(p.data.editVisible, false)
  assert.strictEqual(saved.playingProfile.handedness, '左手')
  assert.strictEqual(saved.skills[0], '旧技术备注')
  assert.strictEqual(p.data.profile.playingSummary.assessedCount, 2)
  p.openEdit()
  assert.strictEqual(p.data.editProfile.playingProfile.abilities.fh_drive, 4)
  p.changeAbility(event('0', { id: 'fh_drive' }))
  assert.strictEqual(p.data.assessedCount, 1)
  p.changeRatingPlatform(event('2'))
  assert.strictEqual(p.data.editLevel.text, '待定级')
  p.data.saving = true
  p.changeAbility(event('4', { id: 'fh_drive' }))
  assert.strictEqual(p.data.assessedCount, 1)
  p.data.saving = false
  p.closeEdit(); p.openEdit()
  assert.strictEqual(p.data.editProfile.playingProfile.abilities.fh_drive, 4, 'discard restores saved value')
  const profileTemplate = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8')
  assert(profileTemplate.includes('open-type="feedback"'))
  assert(profileTemplate.indexOf('<button class="feedback-entry"') > profileTemplate.lastIndexOf('</block>'), 'feedback remains available outside authenticated content')
  assert(fs.readFileSync(path.join(root, 'pages/settings/settings.wxml'), 'utf8').includes('open-type="feedback"'))
  console.log('player levels: boundaries, unassessed state, editor, persistence, failed save, legacy server and feedback passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
