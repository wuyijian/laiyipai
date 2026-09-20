const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const app = require('../app.json')
const homeSource = fs.readFileSync(path.join(root, 'pages/home/home.js'), 'utf8')
const homeTemplate = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8')
const clientApiSource = fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8')
const venueTemplate = fs.readFileSync(path.join(root, 'pages/venue-detail/venue-detail.wxml'), 'utf8')

assert(!app.permission || !app.permission['scope.userLocation'], '不应申请用户定位权限')
assert(!Array.isArray(app.requiredPrivateInfos) || !app.requiredPrivateInfos.includes('getLocation'), '不应声明 getLocation 私有接口')
assert(!fs.existsSync(path.join(root, 'utils/location.js')), '不应保留用户定位实现')
assert(!homeSource.includes("require('../../utils/location')"))
assert(!homeSource.includes('locateNearby'))
assert(!homeSource.includes('locationState'))
assert(!homeSource.includes('api.venues.nearby'))
assert(!clientApiSource.includes("nearby: action('venues.nearby')"))
assert(!homeTemplate.includes('bindtap="locateNearby"'))
assert(!homeTemplate.includes('定位中'))
assert(homeTemplate.includes('mode="selector"'), '城区仍应允许手动筛选')
assert(homeTemplate.includes('杭州球馆'))

// 场馆坐标是公开供给数据；打开已录入场馆的地图不读取或保存用户当前位置。
assert(homeTemplate.includes('catchtap="openVenueMap"'))
assert(venueTemplate.includes('class="venue-location" bindtap="openMap"'))

console.log('user location removal passed')
