const config = {
  // 当前项目只有一个已启用的云环境；开发、体验与正式版使用同一环境。
  productionCloudEnvId: 'laiyipai-d2gks4fmq84ce6b44',

  // 仅供自动化测试临时覆盖；真实构建请保持为空。
  cloudEnvId: '',
  apiFunctionName: 'api',
  apiVersion: 2,
  privacyPolicyVersion: '2026-09-13',
  termsVersion: '2026-09-13',
  appVersion: '1.0.10',

  resolveCloudEnvId() {
    if (this.cloudEnvId) return this.cloudEnvId
    return this.productionCloudEnvId
  }
}

module.exports = config
