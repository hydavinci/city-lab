# 城市增强数据准备与安全路线编译（Tasks 1–2）

Task 1 准备共享类型、严格解析器和可追溯的金鸡湖候选源数据；
Task 2 增加米制路线、完整身体扫掠验证、静态容量和原子发布门禁。
**不是增强功能发布**：已生成 staging 路线，没有创作模型、模拟或 public 增强清单。
原 `CityManifest.version: 1`、基础数据 `dbbaf1f81d32fc39` 和现有浏览功能保持不变。

## 显式下载

```sh
# 原始调查窗口（不是最终示范区）
npm run data:enhancements:fetch

# 本次实际成功使用的端点与最终候选窗口
OVERPASS_ENDPOINT=https://overpass-api.de/api/interpreter \
  npm run data:enhancements:fetch -- \
  --bounds=120.674,31.312,120.684,31.320 \
  --cache-dir=data/raw/jinji-lake/selected
```

`--refresh` 强制重新下载；否则复用响应、查询、范围、端点主机名和快照信息
均通过校验的缓存。刷新后的快照必须重新审计，不能沿用旧清单的成功结论。
默认端点继承既有管线的 `overpass.private.coffee`，可用 `OVERPASS_ENDPOINT` 覆盖。
本次默认端点三次返回 HTTP 500；备用端点调查窗口成功，最终窗口两次
HTTP 504 后第三次成功。没有改变全城下载器或默认端点。

- bbox 是 `west,south,east,north`，必须是有限、有效的经纬度，每个跨度最多 0.1°。
- 每次 HTTP 请求及响应读取使用 300 秒 abort signal，最多三次，
  重试等待 15、30 秒；Overpass 查询 timeout 为 180 秒。
- 查询所有 highway ways、crossing nodes、restriction relations，并递归获取成员和节点。
- 复用 `pipeline/normalize.ts` 的 `validateOverpass`；附加源 ID、坐标、标签、
  way 节点及 relation 成员完整性检查，不另造通用 Overpass 解析器。
- 原始完整响应与 query/bbox/endpoint/fetchedAt/OSM snapshot 存入同一 JSON envelope，
  经校验后用同目录唯一临时文件和 rename 原子替换。失败不覆盖旧文件。
- 原始缓存 `data/raw/` 和后续 staging 均忽略；不提交下载缓存。
  `dev`、`build`、运行时模块导入均不触发下载。没有新增依赖。

## 冻结候选与证据

`data/enhancements/jinji-lake-selection.json` 是人工审计清单：

- 范围 `[120.674,31.312,120.684,31.320]`，球面矩形面积 **0.845042 km²**，
  含湖水，不等于同面积陆地。
- 最终道路快照 `2026-10-15T03:50:21Z`：1096 nodes、141 ways、2 restrictions。
- 星港街／苏惠路共享节点 `4227521259` 位于
  `way/935142611` 和 `way/893261890` 内部，保留四条相接的地面路段；
  另外三个明确共享节点组成分隔式路口。Task 2 扩展后十条选定机动车源 way 均为 `oneway=yes`。
- 选用完整有源步行环：`way/935142617` 至 `way/935142629`。
  西侧过街由 `935142622 → 935142623 → 935142624` 连接，
  两侧分别接 `935142621` 和 `935142618` 的 `footway=sidewalk`。
  过街节点 `8665853148`、`8665853147` 均为 `highway=crossing,crossing=marked`，
  且确实属于对应机动车道路；不是靠平面相交推断。
- 湖滨 `way/838960246` 从节点 `4683166972` 到 `4683166959` 的连续
  16 节点子段约 520 米，止于桥梁前，靠近金鸡湖 `relation/6819705`
  的外环 `way/581877599`。
- **路口步行环与湖滨步道是两个独立组件**。没有虚构连接、双侧人行道或桥梁高程。
  单纯有 crossing 标签但两端缺少步行来源的 `way/848683740` 不用。
- 选定源子段不是编译路线。西侧两条道路端部须在 Task 2 按现有几何裁剪，
  不得把车辆出口放在过街节点上。Task 2 编译结果与假设见下文；源标签不足的宽度
  仍是记录在案的保守假设，不是实地测量。
- 所有 141 条候选响应 way 都明确列为选用或排除；安全相关排除项保留标签证据。
  两个限制关系原样保留，相关 way 全部排除。北侧调查的复杂 via-way 限制
  保存在调查缓存与诊断中，未授权这些移动。
- 建筑／水面缓存来自 `2026-05-31`，与道路快照不同。清单标识该差异，
  记录 123 个 bbox 相交建筑和三个带高度／层数标签的近景候选，不伪造入口或地标。

## 共享解析契约

`web/core/enhancements.ts` 无 Node/Cesium 依赖，类型名称、字段沿用批准计划。
网络坐标是相对 `origin` 的东／北米制坐标；origin、bounds 和 showcase.target 为经纬度。

`parseEnhancementManifest` / `parseNetwork` 拒绝不完整数据、版本与基础 dataset
不匹配、非有限数、非正网络尺寸／速度、重复或空 ID、悬空／不一致引用、
错误模式和 actor 权限、断开的路线、长度不一致、非法冲突区间。
Polygon 要闭环、有非零面积、无自交；孔洞必须在外环内，不能相交或相互包含。
包路径只接受由安全相对路径段组成的本地路径，拒绝 URL、绝对路径、点路径段、
反斜线、百分号编码、查询串和 fragment。
Actor 仅定义共享类型；未新增 actor 状态解析器，模拟中零速度仍合法。

## 验证与后续门槛

```sh
npm test -- tests/unit/enhancements.test.ts
npm test
npm run build
```

测试夹具明确为 synthetic；`(0,0) → (40,0) → (80,0)` 的测试道路
不用于任何真实地理证据。缓存测试只 mock 网络与重试等待，不 mock 文件写入／rename，
失败刷新直接比较旧缓存字节。

2026-10-15 Task 1 历史结果：增强单测 112/112；完整单测 129/129（5 个文件）；
TypeScript + Vite build 通过。真实源审计核对 23 个选用 way、118 个排除 way、
三个过街链的两端步行连接及六个明确过街节点；机动车源为一个组件，
步行源为 13-way 路口环和 1-way 湖滨段两个组件。检查的 75 条源线段
没有落入建筑／水面内部或与其边界发生严格相交；这不是车身扫掠、接触容差
或完整可通行走廊验证。湖滨段按局部米制距离计算为 519.817 米。

Task 1 的源中心线检查不能替代 Task 2 的身体扫掠验收。
静态容量不等于实际活动人口，仍不声称通过运行时、可视效果或性能验收。

## Task 2：编译与发布命令

```sh
# 默认仅写入被忽略的 data/enhancements/staging/candidate.json，不需要资产
npm run data:enhancements:build

# 只有全部资产、摆放和验证满足时才写 public/enhancements/manifest.json
npm run data:enhancements:build -- --publish

# 可覆盖输入／输出；参数采用 --name=value
npm run data:enhancements:build -- \
  --raw-dir=data/raw/jinji-lake/selected \
  --selection=data/enhancements/jinji-lake-selection.json \
  --base-dir=public/data \
  --asset-dir=data/enhancements/staging/assets \
  --output-dir=data/enhancements/staging
```

只读取已有源缓存和基础建筑／水面，不在 build、dev 或模块导入时下载。
候选文件包含 `candidate`、`diagnostics`、`roads`、`provenance`；后者记录源响应、
选择、基础快照、障碍物文件 SHA-256、actor 假设、路线、冲突区和容量。

### 几何、权限与运行时契约

- `geometry.ts` 无 Node 依赖：`project` / `unproject` 使用区内同一切平面近似；
  `sweptEnvelope` 对身体四周膨胀 **1 mm**，包含每段连续平移和折点连续转身，
  转身采样凸包另加圆弧余量。`validateEnvelope` 验证整个身体在走廊并集内，
  且不接触建筑／水面；处理凹多边形、孔洞、包含关系、线段相交和边界接触。
- 机动车与步行图分离，仅共享源节点连接；拒绝高架、隧道、非零高程层、
  不支持的复杂限制、条件／定向访问和目的地专用通行。缺失 sidewalk 不推断人行道。
  独立 footway 才生成步行线；仅有 road sidewalk 标签不生成中心线步行。
- 支持普通／逆向单行、显式宽度／车道数、`mph` / `km/h`；非法数字拒绝。
  车辆默认每车道 3 m、最多 8 m/s，转弯最多 4 m/s；步行默认宽 2 m、1.2 m/s。
  正向单行的 `turn:lanes` 按选中车道执行；其他方向／双向 turn-lane 组合保守排除，
  不忽略显式权限。支持 via-node 的 `no_*` / `only_*`；no 限制可保守扩大排除。
- 转接使用最大弦长 0.25 m 的采样三次曲线，再验证连续扫掠和最小半径；
  车身上限为 car-a 4.4×1.8 m、car-b 4.7×1.9 m、bus 10×2.5 m，
  最小半径分别 5 / 5.5 / 10 m，person-a/b 均为 0.6×0.6 m。
  运行时必须沿输出折线移动并遵守上述姿态包络；不能自行平滑或放大模型。
- 全局冲突区来自身体扫掠重叠，重叠区域合并；行人／车辆共享 ID，
  进入／退出距离是保守区间。后续运行时还必须实现共享预约、跟车和生成间距。
  每个步行源组件只选一个方向，避免窄路对向人群。

### 真实候选静态结果（2026-10-15）

范围仍为 0.845042 km²，现有 24 条选用 way（10 drive / 14 walk）、
117 条明确排除；障碍物为 123 个建筑 polygon、5 个水面 polygon。
原北向终点距展示中心 162.95 m，小于 `showcase.range × 0.15 = 165 m` 排除半径；
沿同一缓存中的共享节点续接 `way/834477631` 至 `node/7789692195`，
不改变 bbox、宽度、净距或转弯半径，不让 through-only 车道经连接道偷偷左转。

| 路线 | 模式／允许 actor | 长度 m | 去重安全存储位 |
|---|---|---:|---:|
| route/0 | 南行 car-a、car-b | 506.046 | 17 |
| route/1 | 北行 car-a、car-b、bus | 380.736 | 9 |
| route/2 | 路口步行 person-a、person-b | 122.247 | 76 |
| route/3 | 湖滨步行 person-a、person-b | 517.946 | 407 |

共 242 条有效边、4 条 entry-to-exit 路线、4 个物理冲突区。
**26 车／483 人是静态存储容量，不是已运行的数量**；以车辆 12 m、行人 1.2 m
间距，全局去重，避开转弯、冲突区及路线端部。足以进入后续 20 车／30 人实验，
但尚未证明入口流量、持续活动、无拥堵、摄影视角隐藏生成或动态安全。
所有入出口在中心排除半径之外，源拓扑不连通的湖滨和路口仍独立，无盲目循环。

`zone/0` 与 `zone/2` 覆盖北侧过街；`zone/1` 保守合并主路口和西／南侧冲突；
`zone/3` 包括东南侧过街。三条有源过街链和六个 crossing 节点均保留，
实际路线仅选其中安全的北侧链。完整边、节点和排除原因以候选 provenance 为准。
四个小半径转弯排除，另两次 through-only 换街候选排除；不是放宽阈值强求容量。

### 完整包与原子门禁

资产目录须提供 `assets.json`（`Asset[]`）及其引用的九种 GLB：
car-a、car-b、bus、person-a、person-b、tree、lamp、entrance、roof-unit。
校验字节数、SHA-256、GLB 2.0 结构、实际顶点和层级变换后的尺寸；
坐标约定 Y-up、X 为宽、Z 为长、足底 y=0、水平中心为原点。
`size` 是 `[length,width,height]` 米。禁止外部资源和符号链接。
当前门禁**拒绝动画、蒙皮、morph 和扩展 GLB**，后续必须先补充经过验证的
动态边界适配器再发布此类模型，不能只信任声明的 bounding box。

`placements.json` 是对象数组，每项含 `asset`（四种静态种类之一）、`sourceIds`、
`position: [east,north]`（米）、`heading`（弧度，从北顺时针）、
闭环带孔 `footprint: Polygon2` 和字符串数组 `inferred`。
要求四种静态种类齐全、实际模型完整落在 footprint 内、无水面／互相／活动路线碰撞；
tree/lamp 必须在其源走廊且避开建筑，entrance/roof-unit 必须在所指建筑 footprint 内。
这是摆放数据门禁，不是本任务生成的摆放或资产。

发布还要求至少 20/30 静态容量、严格 manifest/network 解析。roads 包含每条边的
源 ID、模式及已验证 corridor；provenance 同上，placements 完整写入包内。
内容 ID 对 schema、基础数据／源证据、假设、路线、资产／摆放字节哈希，
不包含本次生成的 manifest 时间。先写唯一 staging 包，再重命名不可变内容目录，
最后原子替换 manifest；目录锁拒绝并发发布，已有目录必须逐文件字节一致。
任何验证失败抛异常，CLI 非零退出，旧 manifest 和不可变文件保留。
当前无真实资产，真实 `--publish` 应失败且不会写 public 增强清单。

### 公开标签语义参考（OSM 原始文档）

- `https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL`：递归 relation 成员。
- `https://wiki.openstreetmap.org/wiki/Key:layer`：缺失 layer 的拓扑默认值不是高程。
- `https://wiki.openstreetmap.org/wiki/Key:oneway`：方向以源节点顺序为准。
- `https://wiki.openstreetmap.org/wiki/Tag:highway%3Dcrossing`：crossing 节点与独立步行 way。
- `https://wiki.openstreetmap.org/wiki/Key:footway`：sidewalk／crossing 的细分。
