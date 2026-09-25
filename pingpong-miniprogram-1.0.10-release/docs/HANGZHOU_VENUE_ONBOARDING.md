# 杭州首批球馆核验清单

最近核验：2026-09-08。以下是生产入库候选，不是自动种子数据。取得场馆确认前只能标记为“资料已核验”，不能标记为“搭拍子合作场馆”；电话、价格和开放时段在入库当天仍需回拨或通过官方预约渠道复核。

## P0：优先回访入库

| 球馆 | 地区与地址 | 当前可核实信息 | 坐标（纬度, 经度） | 来源 |
| --- | --- | --- | --- | --- |
| 浙江省黄龙体育中心·省老年体育活动中心 | 西湖区黄龙路 1 号 | 官方热线 0571-96218；官方页面载明乒乓球社会开放时段与分时价格 | 30.266763, 120.133775 | [场馆官方开放说明](https://www.zjhlsports.cn/zoujinhuanglong)、[高德点位](https://www.amap.com/place/B0FFF60QZ9) |
| 杭州全民健身中心 | 上城区富春路 80 号 | 曾公布咨询电话 0571-88173503；近期官方报道确认仍有乒乓球惠民时段，其他场次以官方预约为准 | 待同一地图服务标注 | [杭州政协转载官方资料](https://www.hzzx.gov.cn/cshz/content/2022-07/01/content_8295955.htm)、[近期运营报道](https://www.hzxcw.gov.cn/content_46440.html) |
| 杭州大关游泳健身馆 | 拱墅区大关小区东四苑 18 号 | 市体育局资料电话 0571-88315200；近期运营报道确认乒乓球开放 | 30.307363, 120.156725 | [杭州市体育局场馆表](https://ty.hangzhou.gov.cn/art/2021/10/27/art_1693538_58831451.html)、[近期运营报道](https://www.hzxcw.gov.cn/content_46440.html)、[高德点位](https://www.amap.com/place/B023B07CB8) |
| 西湖区文体中心 | 西湖区晴川街 217 号 | 现行官方购票页仍列乒乓球项目；历史项目咨询电话 0571-87170525 需回拨 | 待同一地图服务标注 | [现行场馆购票页](https://xihuwenti.juyancn.cn/wechat/buyticket/home)、[杭州官方媒体项目资料](https://pic.hangzhou.com.cn/hzyx/content/content_8596538_2.html) |

## P1：补充核验后入库

| 球馆 | 地区与地址 | 待核实项 | 坐标（纬度, 经度） | 来源 |
| --- | --- | --- | --- | --- |
| 杭州体育馆 | 拱墅区体育场路 210 号 | 多来源电话不一致，展示前必须回拨；常态场次查“杭州体育在线” | 30.270698, 120.172978 | [杭州市文旅局地址](https://wgly.hangzhou.gov.cn/art/2022/12/7/art_1229695695_58943309.html)、[开放说明](https://www.hzzx.gov.cn/cshz/content/2022-05/24/content_8262231.htm)、[高德点位](https://www.amap.com/place/B0GD2OUAO4) |
| 三墩文体中心 | 西湖区三墩镇北沙斗弄 20 号 | 已确认设有乒乓球项目，当前专线与常态时段待确认 | 待同一地图服务标注 | [现行场馆购票页](https://xihuwenti.juyancn.cn/wechat/buyticket/home)、[开馆介绍](https://town.zjol.com.cn/czjsb/202306/t20230630_25919924.shtml) |
| 江南体育中心 | 滨江区春晓路 411 号 | 高德电话 0571-58103587；常态营业时段待官方确认 | 30.203003, 120.213138 | [乒乓球活动报道](https://zjnews.zjol.com.cn/zjnews/90zxw/202606/t20260611_31718581.shtml)、[高德点位](https://www.amap.com/place/B023B0BI4I) |
| 萧山体育中心综合馆 | 萧山区市心南路 398 号 | 当前总机 0571-82665366；历史乒乓球专线需回拨 | 30.153795, 120.266453 | [近期开放信息](https://hznews.hangzhou.com.cn/chengshi/content/2025-08/06/content_9054363_2.htm)、[项目历史信息](https://hznews.hangzhou.com.cn/chengshi/content/2023-08/08/content_8596424_0.htm)、[高德点位](https://www.amap.com/place/B0J1573HQU) |
| 萧潮乒乓球馆 | 萧山区城厢街道通惠南路 350 号秀王体育中心 | 高德公开名称为“萧潮乒乓球俱乐部”；正式上架前确认名称别名及实际入口 | 30.153527, 120.285361 | [高德点位](https://www.amap.com/place/B0J2S1LIY1)、[赛事佐证](https://www.ttb0571.com/content/2023-11/20/070029.html) |

## 名称型默认球馆

| 球馆名称 | 活动标签 |
| --- | --- |
| 桂语朝阳乒乓球室 | 切磋 |

`database/default-venues.name-only.json` 仍保留两条安全的名称型上架输入，避免在位置未核验前伪造导航。`database/hangzhou-venue-candidates.pending.json` 已把萧潮候选补成下架的完整记录，待人工确认名称别名和入口后，可用同一 `venueId` 经 `admin.venues.upsert` 升级；桂语朝阳尚无可靠的球室入口坐标，继续保持名称型候选。客户端不得为名称型记录显示空地址、导航、电话、“资料已核验”或“合作场馆”。

## 入库规则

- 坐标统一采用同一个地图服务，不混用不同坐标系；缺坐标的候选保持不上架。
- 开放时间和价格是会过期的信息，必须保存核验日期和来源，不写死在客户端。
- 初次写入使用 `verificationStatus: pending`、`active: false`；回访完成后才改为 `verified` 并上架。
- `partnerVerified` 必须默认为 false；只有签署合作或取得明确授权后才能展示合作关系。
- 场馆图片需单独取得使用授权，网页图片不能因公开可见就直接用于产品。
- 未找到可靠精确地址或不能确认日常对外开放的商业品牌和赛事场地暂缓上线。
