import type { BuildingHeightRecord } from './building-heights';

export const buildingHeightRecords: readonly BuildingHeightRecord[] = [
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
];
