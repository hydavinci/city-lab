import type { BuildingHeightRecord } from './building-heights';

export const buildingHeightRecords: readonly BuildingHeightRecord[] = [
  {
    sourceId: 'way/505305793', name: '苏州中心 · The Summit（39 层塔楼）', height: 166.9, floors: 39,
    bounds: [120.6648924, 31.3165187, 120.665548, 31.3171513],
    checkedAt: '2026-10-20',
    identity: 'CTBUH map marker 120.665062,31.316860 lies inside the separate southern tower footprint. The architect distinguishes the 39-floor tower from the 16-floor parcel. Satellite imagery confirms this independent outline; the northern 80.6 m building way/462717404 is not changed.',
    sources: [
      { label: 'CTBUH · 2017 年建成、166.9 m / 39 层', url: 'https://www.skyscrapercenter.com/building/the-summit-plot-554/18927' },
      { label: 'CTBUH · 独立塔楼位置', url: 'https://www.skyscrapercenter.com/map/building/18927' },
      { label: 'GP · 双地块与塔楼设计', url: 'https://www.gpchicago.com/architecture/summit/' },
    ],
  },
  {
    sourceId: 'way/822635143', name: '张家港汇金中心 1 号楼', height: 188,
    bounds: [120.569892, 31.8730779, 120.570404, 31.8735501],
    checkedAt: '2026-10-20',
    identity: 'CTBUH map marker 120.570267,31.873356 lies inside the independent western tower footprint. Tower 2 has its own eastern footprint and marker; the distinct shared podium way/822635142 is not raised. No independently verified floor count is asserted.',
    sources: [
      { label: 'CTBUH · 2019 年建成、188 m', url: 'https://www.skyscrapercenter.com/building/huijin-center-tower-1/43634' },
      { label: 'CTBUH · 1 号楼位置', url: 'https://www.skyscrapercenter.com/map/building/43634' },
    ],
  },
  {
    sourceId: 'way/822635144', name: '张家港汇金中心 2 号楼', height: 188,
    bounds: [120.5713659, 31.8726875, 120.5718189, 31.873135],
    checkedAt: '2026-10-20',
    identity: 'CTBUH map marker 120.571617,31.873014 lies inside the independent eastern tower footprint. Tower 1 has its own western footprint and marker; the distinct shared podium way/822635142 is not raised. No independently verified floor count is asserted.',
    sources: [
      { label: 'CTBUH · 2021 年建成、188 m', url: 'https://www.skyscrapercenter.com/building/huijin-center-tower-2/43597' },
      { label: 'CTBUH · 2 号楼位置', url: 'https://www.skyscrapercenter.com/map/building/43597' },
    ],
  },
  {
    sourceId: 'way/802754584', name: '苏州 ICC', height: 303.2, floors: 68,
    bounds: [120.7110962, 31.3254534, 120.7117035, 31.3259954],
    checkedAt: '2026-10-20',
    identity: 'CTBUH WGS84 marker 120.711411,31.325821 lies inside this tower footprint, 10.8 m from its centroid.',
    sources: [
      { label: 'CTBUH · 建筑高度与楼层', url: 'https://www.skyscrapercenter.com/building/suzhou-icc/10738' },
      { label: 'CTBUH · 建筑位置', url: 'https://www.skyscrapercenter.com/map/building/10738' },
    ],
  },
  {
    sourceId: 'way/822365267', name: '苏州恒和广场', height: 175, floors: 48,
    bounds: [120.5789905, 31.3052801, 120.5795036, 31.3059083],
    checkedAt: '2026-10-20',
    identity: 'CTBUH WGS84 marker 120.579239,31.305651 lies inside this tower footprint, 3.2 m from its centroid. The overlapping larger podium way/822365266 is not raised.',
    sources: [
      { label: 'CTBUH · 建筑高度与楼层', url: 'https://www.skyscrapercenter.com/building/suzhou-henghe-plaza/2529' },
      { label: 'CTBUH · 建筑位置', url: 'https://www.skyscrapercenter.com/map/building/2529' },
    ],
  },
  {
    sourceId: 'way/475616606', name: '苏州新地中心（西塔）', height: 232, floors: 54,
    bounds: [120.5542573, 31.2945195, 120.5546482, 31.2948683],
    checkedAt: '2026-10-20',
    identity: 'CTBUH WGS84 marker 120.554291,31.294689 lies inside the separate western tower footprint of Suzhou Xindi Center. Satellite imagery distinguishes it from the eastern tower and shared podium way/475616608, which is not raised.',
    sources: [
      { label: 'CTBUH · 建筑高度与楼层', url: 'https://www.skyscrapercenter.com/building/suzhou-xindi-center/1081' },
      { label: 'CTBUH · 建筑位置', url: 'https://www.skyscrapercenter.com/map/building/1081' },
    ],
  },
  {
    sourceId: 'way/475616607', name: '苏州国际商务中心东塔', height: 125, floors: 28,
    bounds: [120.5550151, 31.2944852, 120.5553428, 31.2947642],
    checkedAt: '2026-10-20',
    identity: 'CTBUH WGS84 marker 120.555099,31.294580 lies inside the separate eastern tower footprint of Suzhou International Commerce Center. Satellite imagery distinguishes it from the western tower and shared podium way/475616608, which is not raised.',
    sources: [
      { label: 'CTBUH · 建筑高度与楼层', url: 'https://www.skyscrapercenter.com/building/suzhou-international-commerce-center-east-tower/14490' },
      { label: 'CTBUH · 建筑位置', url: 'https://www.skyscrapercenter.com/map/building/14490' },
    ],
  },
  {
    sourceId: 'way/475616603', name: 'Metropolitan Tower A', height: 210, floors: 52,
    bounds: [120.5550648, 31.2934769, 120.5553589, 31.2938812],
    checkedAt: '2026-10-20',
    identity: 'CTBUH WGS84 marker 120.555153,31.293640 lies inside the separate northeastern tower footprint of the Metropolitan complex south of Suzhou Xindi Center. Satellite imagery distinguishes it from Tower B and shared podium way/475616605, which is not raised.',
    sources: [
      { label: 'CTBUH · 建筑高度与楼层', url: 'https://www.skyscrapercenter.com/building/metropolitan-tower-a/1453' },
      { label: 'CTBUH · 建筑位置', url: 'https://www.skyscrapercenter.com/map/building/1453' },
    ],
  },
  {
    sourceId: 'way/475616604', name: 'Metropolitan Tower B', height: 210, floors: 52,
    bounds: [120.55454, 31.2927788, 120.5549003, 31.2931313],
    checkedAt: '2026-10-20',
    identity: 'CTBUH WGS84 marker 120.554672,31.292971 lies inside the separate southwestern tower footprint of the Metropolitan complex south of Suzhou Xindi Center. Satellite imagery distinguishes it from Tower A and shared podium way/475616605, which is not raised.',
    sources: [
      { label: 'CTBUH · 建筑高度与楼层', url: 'https://www.skyscrapercenter.com/building/metropolitan-tower-b/1454' },
      { label: 'CTBUH · 建筑位置', url: 'https://www.skyscrapercenter.com/map/building/1454' },
    ],
  },
  {
    sourceId: 'way/482784883', name: '圆融星座 · 西公寓塔', height: 100, approximate: true,
    bounds: [120.7097593, 31.3200086, 120.7102368, 31.3204687],
    checkedAt: '2026-10-20',
    identity: 'The architect project photo and Esri World Imagery distinguish the western apartment tower from the southern apartment tower and northeastern office tower. Its independent frozen OSM footprint is separate from shared podium way/482784880. Jangho describes both apartment towers as approximately 100 m; no floor count is asserted.',
    sources: [
      { label: '江河幕墙 · 两座公寓约 100 m', url: 'https://mcw.jangho.com/html/gongchengyeji/guoneigongcheng/2013/0114/398.html' },
      { label: '中衡设计 · 圆融星座塔楼布局', url: 'https://www.artsgroup.cn/zhonghengdongtai/zhonghengxinwen/2024-07-03/1167.html' },
    ],
  },
  {
    sourceId: 'way/482784884', name: '圆融星座 · 南公寓塔', height: 100, approximate: true,
    bounds: [120.7101266, 31.3191495, 120.7107279, 31.3195058],
    checkedAt: '2026-10-20',
    identity: 'The architect project photo and Esri World Imagery distinguish the southern apartment tower from the western apartment tower and northeastern office tower. Its independent frozen OSM footprint is separate from shared podium way/482784880. Jangho describes both apartment towers as approximately 100 m; no floor count is asserted.',
    sources: [
      { label: '江河幕墙 · 两座公寓约 100 m', url: 'https://mcw.jangho.com/html/gongchengyeji/guoneigongcheng/2013/0114/398.html' },
      { label: '中衡设计 · 圆融星座塔楼布局', url: 'https://www.artsgroup.cn/zhonghengdongtai/zhonghengxinwen/2024-07-03/1167.html' },
    ],
  },
  {
    sourceId: 'way/482784885', name: '圆融星座 · 办公塔', height: 160,
    bounds: [120.7109898, 31.3201026, 120.7114823, 31.3206918],
    checkedAt: '2026-10-20',
    identity: 'The architect project photo and Esri World Imagery identify the northeastern glazed office tower, distinct from the two apartment towers and shared podium way/482784880. Use the Jangho project table height of 160 m, not its rounded narrative of approximately 150 m; no floor count is asserted.',
    sources: [
      { label: '江河幕墙 · 项目表建筑高度 160 m', url: 'https://mcw.jangho.com/html/gongchengyeji/guoneigongcheng/2013/0114/398.html' },
      { label: '中衡设计 · 圆融星座塔楼布局', url: 'https://www.artsgroup.cn/zhonghengdongtai/zhonghengxinwen/2024-07-03/1167.html' },
    ],
  },
];
