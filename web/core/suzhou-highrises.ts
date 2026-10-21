import { buildingHeightRecords } from './building-height-references';

export const highriseRegions = [
  'gusu', 'huqiu', 'wuzhong', 'xiangcheng', 'wujiang', 'industrial-park',
  'kunshan', 'changshu', 'zhangjiagang', 'taicang',
] as const;
export type HighriseRegion = typeof highriseRegions[number];
export type HighriseGap = 'missing-footprint' | 'merged-podium' | 'height-conflict'
  | 'unverified-identity' | 'completion-unverified' | 'height-unverified' | 'not-completed';

export interface HighriseCandidate {
  id: string;
  name: string;
  region: HighriseRegion;
  use: 'mixed' | 'office' | 'hotel' | 'residential' | 'industrial-test' | 'unknown';
  status: 'completed' | 'under-construction' | 'planned' | 'on-hold' | 'unknown';
  checkedAt: string;
  height?: number;
  heightKind: 'architectural' | 'project-description' | 'ceiling' | 'unknown';
  approximate?: boolean;
  floors?: number;
  sourceId?: string;
  match?: 'reference' | 'landmark' | 'source';
  gap?: HighriseGap;
  note: string;
  sources: { label: string; url: string }[];
}

const ctbuh = (slug: string, id: number) => [
  { label: 'CTBUH · 建筑资料', url: `https://www.skyscrapercenter.com/building/${slug}/${id}` },
  { label: 'CTBUH · 建筑位置', url: `https://www.skyscrapercenter.com/map/building/${id}` },
];

const referenceIds: Record<string, string> = {
  'way/505305793': 'ctbuh-18927', 'way/822635143': 'ctbuh-43634', 'way/822635144': 'ctbuh-43597',
};
const referenceRegion = (id: string): HighriseRegion => id.startsWith('way/822635') ? 'zhangjiagang'
  : id === 'way/822365267' ? 'gusu' : id.startsWith('way/475616') ? 'huqiu' : 'industrial-park';

export const highriseCandidates: readonly HighriseCandidate[] = [
  ...buildingHeightRecords.map((record): HighriseCandidate => ({
    id: referenceIds[record.sourceId] ?? `reference-${record.sourceId.replace('/', '-')}`,
    name: record.name, region: referenceRegion(record.sourceId),
    use: record.sourceId === 'way/482784883' || record.sourceId === 'way/482784884' ? 'residential' : 'mixed',
    status: 'completed', checkedAt: record.checkedAt, height: record.height,
    heightKind: record.approximate ? 'project-description' : 'architectural',
    ...(record.approximate ? { approximate: true } : {}),
    ...(record.floors === undefined ? {} : { floors: record.floors }),
    sourceId: record.sourceId, match: 'reference', note: record.identity, sources: record.sources,
  })),
  {
    id: 'ctbuh-41266', name: '苏州星俪酒店', region: 'xiangcheng', use: 'hotel',
    status: 'completed', height: 234, floors: 57, heightKind: 'architectural', checkedAt: '2026-10-20',
    sourceId: 'way/1189391320', gap: 'merged-podium',
    note: '来源标注 2023 年建成；位置点落在包含大面积裙楼的合并轮廓内，不能将整块轮廓抬至 234 m。',
    sources: ctbuh('suzhou-xingli-hotel', 41266),
  },
  {
    id: 'ctbuh-19852', name: 'CSSD Plaza', region: 'industrial-park', use: 'office',
    status: 'completed', height: 222, floors: 47, heightKind: 'architectural', checkedAt: '2026-10-20',
    sourceId: 'way/1239575716', gap: 'merged-podium',
    note: '来源标注 2015 年建成；现有轮廓可能包含相接裙楼，独立塔楼基底尚未确认，暂不抬高。',
    sources: ctbuh('cssd-plaza', 19852),
  },
  {
    id: 'ctbuh-14408', name: '天都广场 1 号楼', region: 'huqiu', use: 'mixed',
    status: 'completed', height: 217, heightKind: 'architectural', checkedAt: '2026-10-20',
    gap: 'unverified-identity', note: '来源标注 2018 年建成；公开位置页未提供可核实标记，尚未确认独立塔楼轮廓。',
    sources: ctbuh('tiandu-plaza-tower-1', 14408),
  },
  {
    id: 'ctbuh-43600', name: 'Days Mansion Tower A', region: 'huqiu', use: 'mixed',
    status: 'completed', height: 217, heightKind: 'architectural', checkedAt: '2026-10-20',
    gap: 'missing-footprint', note: '来源标注 2019 年建成、长江路 211 号；位置点周围未找到可用的冻结建筑轮廓。',
    sources: ctbuh('days-mansion-tower-a', 43600),
  },
  {
    id: 'ctbuh-42345', name: '苏州龙湖中心', region: 'huqiu', use: 'mixed',
    status: 'unknown', height: 212.5, floors: 46, heightKind: 'architectural', checkedAt: '2026-10-20',
    sourceId: 'way/927239527', gap: 'merged-podium',
    note: '已核实来源高度与楼层；本轮未取得独立完工状态证据。位置点落在约 190×150 m 商场合并轮廓内，不能整块抬高。',
    sources: ctbuh('suzhou-longfor-centre', 42345),
  },
  {
    id: 'ctbuh-30255', name: '恒力中心 1 号楼', region: 'wujiang', use: 'mixed',
    status: 'completed', height: 209, floors: 51, heightKind: 'architectural', checkedAt: '2026-10-20',
    sourceId: 'way/1499197731', gap: 'height-conflict',
    note: '来源标注 2020 年建成；独立塔楼身份匹配，但冻结 OSM 为楼层推算 121.6 m。插件不覆盖已有楼层证据，保留原值并显式报告冲突。',
    sources: ctbuh('hengli-center-1', 30255),
  },
  {
    id: 'ctbuh-41136', name: '中海财富中心', region: 'industrial-park', use: 'office',
    status: 'unknown', heightKind: 'unknown', checkedAt: '2026-10-20', gap: 'missing-footprint',
    note: '已取得候选位置，冻结数据无可确认的独立轮廓；本轮未完整核实来源高度与建成状态，不采用二手列表中的数值。',
    sources: ctbuh('zhonghai-building', 41136),
  },
  {
    id: 'ctbuh-22319', name: '昆山金鹰广场', region: 'kunshan', use: 'mixed',
    status: 'completed', height: 252, floors: 55, heightKind: 'architectural', checkedAt: '2026-10-20',
    sourceId: 'way/567987723', gap: 'unverified-identity',
    note: '来源标注 2016 年建成；附近金鹰国际酒店轮廓有楼层推算 160 m，但来源点不在其中，不能按最近距离将其认作 252 m 塔楼。',
    sources: ctbuh('golden-eagle-plaza', 22319),
  },
  {
    id: 'ctbuh-22739', name: '通力昆山测试塔', region: 'kunshan', use: 'industrial-test',
    status: 'completed', height: 235.6, floors: 36, heightKind: 'architectural', checkedAt: '2026-10-20',
    gap: 'missing-footprint',
    note: '2015 年建成的电梯测试塔，非普通使用高层建筑；单列结构用途，不与住宅办公存量混计。冻结数据无可核实轮廓。',
    sources: [...ctbuh('kone-test-tower', 22739), {
      label: 'KONE · 测试用途', url: 'https://www.kone.com.au/stories-and-references/stories/putting-elevators-to-test.aspx',
    }],
  },
  {
    id: 'ctbuh-51041', name: '常熟金茂智慧科学城高层', region: 'changshu', use: 'office',
    status: 'completed', height: 166, floors: 34, heightKind: 'architectural', checkedAt: '2026-10-20',
    gap: 'missing-footprint', note: '来源标注 2025 年建成、黄浦江路 289 号；仅此高层，不代表整个园区。来源位置无可用冻结轮廓。',
    sources: ctbuh('changshu-jinmao-intelligence-and-science-city', 51041),
  },
  {
    id: 'ctbuh-16063', name: '太仓新港商务区 1 号楼', region: 'taicang', use: 'office',
    status: 'completed', height: 155.1, floors: 36, heightKind: 'architectural', checkedAt: '2026-10-20',
    gap: 'missing-footprint', note: '来源标注 2010 年建成、滨江大道；来源位置无可用冻结轮廓，不把相邻建筑当作替代。',
    sources: ctbuh('taicang-new-port-businese-area-no1-building', 16063),
  },
  {
    id: 'taicang-times-financial', name: '太仓时代金融大厦主楼', region: 'taicang', use: 'office',
    status: 'completed', height: 100, approximate: true, floors: 23,
    heightKind: 'project-description', checkedAt: '2026-10-20', gap: 'unverified-identity',
    note: '市财政局证实 2024 年底竣工验收；供应商概述高 100 m，位于阈值且精度不明，不能冒充实测。主塔坐标与轮廓未核实。',
    sources: [
      { label: '太仓市财政局 · 2024 年底竣工验收', url: 'https://www.taicang.gov.cn/taicang/gqyyjg/202504/cc220a96f2ef4712b4ae598a1540478f.shtml' },
      { label: '供应商 · 100 m / 23 层项目概述', url: 'https://www.ipavs.net/caseshow-28-160-1.html' },
    ],
  },
  ...([1, 2] as const).map((tower): HighriseCandidate => ({
    id: `ctbuh-${tower === 1 ? 12402 : 12403}`, name: `沙钢大厦 ${tower} 号楼`,
    region: 'zhangjiagang', use: 'mixed', status: 'planned', height: tower === 1 ? 268 : 188,
    floors: tower === 1 ? 76 : 43, heightKind: 'architectural', checkedAt: '2026-10-20', gap: 'not-completed',
    note: 'CTBUH 实际选定状态为 Vision；页面的所有状态选项不是完工证据。设计高度不用于新增建成模型。',
    sources: [{
      label: 'CTBUH · Vision 状态',
      url: `https://awards-api.skyscrapercenter.com/building/shagang-tower-${tower}/${tower === 1 ? 12402 : 12403}`,
    }],
  })),
  {
    id: 'zhangjiagang-guotai', name: '张家港国泰中心主塔', region: 'zhangjiagang', use: 'office',
    status: 'unknown', height: 158.5, heightKind: 'architectural', checkedAt: '2026-10-20',
    gap: 'completion-unverified',
    note: '2025-02-19 市级报道仍在幕墙与内装施工；预计交付不是竣工证据，也不能据旧报道宣称 2026 年仍在建。',
    sources: [{ label: '张家港市 · 2025-02-19 施工报道', url: 'https://www.zjg.gov.cn/zjg/tpxw/202502/24ea1fc552804e76a156e00ed757a233.shtml' }],
  },
  {
    id: 'kunshan-butterfly-bay', name: '昆山世茂蝶湖湾（住宅项目线索）', region: 'kunshan', use: 'residential',
    status: 'unknown', height: 150, heightKind: 'project-description', checkedAt: '2026-10-20',
    gap: 'unverified-identity',
    note: '建筑师称中轴四座塔楼 150 m，但未确认对应楼号、各栋建成状态与独立轮廓。此为一条项目线索，不虚构四栋或给所有 40–50 层住宅赋相同高度。',
    sources: [{ label: '王董 · 住宅群项目资料', url: 'https://www.wongtung.com/cn/projects/kunshan-shimao-butterfly-bay-2/' }],
  },
  {
    id: 'kunshan-gcl', name: '昆山协鑫数字科技金融中心（审批线索）', region: 'kunshan', use: 'mixed',
    status: 'planned', height: 150, heightKind: 'ceiling', checkedAt: '2026-10-20',
    gap: 'not-completed', note: '2026-05-22 审批仅规定最高不超过 150 m；不是实际塔高或建成证据。',
    sources: [{ label: '昆山市 · 规划审批高度上限', url: 'https://www.ks.gov.cn/kss/gsgg/202605/477377d254424e309df7e9bd0b6d48c9.shtml' }],
  },
  {
    id: 'swan-port', name: 'Swan Port Business Center（项目线索）', region: 'industrial-park', use: 'mixed',
    status: 'on-hold', heightKind: 'unknown', checkedAt: '2026-10-20',
    gap: 'not-completed', note: '公开综合体页的实际状态为 On Hold；不把状态选项中的 Completed 当成已建成，不分配设计高度。',
    sources: [{ label: 'CTBUH · On Hold', url: 'https://www.skyscrapercenter.com/complex/5453' }],
  },
  {
    id: 'gusu-china-central-place', name: '苏州华贸中心（项目线索）', region: 'gusu', use: 'mixed',
    status: 'unknown', heightKind: 'unknown', checkedAt: '2026-10-20',
    gap: 'height-unverified', note: '设计方与业主项目资料提供候选线索，本轮未核实逐栋高度、完工状态与独立塔楼身份。',
    sources: [
      { label: 'KPF · 苏州华贸中心', url: 'https://www.kpf.com/project/suzhou-china-central-place' },
      { label: '华贸 · 苏州公寓项目', url: 'https://www.huamao.cc/en/group/suzhou/apartment' },
    ],
  },
];
