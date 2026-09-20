const cloud = require('wx-server-sdk')
const { createHandler } = require('./handler')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = createHandler({ cloud, db })
