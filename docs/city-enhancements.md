# 城市增强数据准备（Task 1）

本次仅准备共享类型、严格解析器和可追溯的金鸡湖候选源数据。
**不是增强功能发布**：没有生成路线、车道、模型、模拟或 public 增强清单。
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
  另外三个明确共享节点组成分隔式路口。九条选定机动车源 way 均为 `oneway=yes`。
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
  不得把车辆出口放在过街节点上。实际车道宽度、转弯、生成位置和容量尚未验证。
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

2026-10-15 本次结果：增强单测 112/112；完整单测 129/129（5 个文件）；
TypeScript + Vite build 通过。真实源审计核对 23 个选用 way、118 个排除 way、
三个过街链的两端步行连接及六个明确过街节点；机动车源为一个组件，
步行源为 13-way 路口环和 1-way 湖滨段两个组件。检查的 75 条源线段
没有落入建筑／水面内部或与其边界发生严格相交；这不是车身扫掠、接触容差
或完整可通行走廊验证。湖滨段按局部米制距离计算为 519.817 米。

Task 2 仍须建立分离图、裁剪与走廊、车身扫掠和建筑／水面／孔洞检查，
遵守 `turn:lanes`，排除不支持的限制，证明实际活动容量与可见入出口。
Task 1 的源中心线检查不能替代这些验收。不生成大批资产，不声称已经支持
20 车／30 人、通过运行时或性能验收。

### 公开标签语义参考（OSM 原始文档）

- `https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL`：递归 relation 成员。
- `https://wiki.openstreetmap.org/wiki/Key:layer`：缺失 layer 的拓扑默认值不是高程。
- `https://wiki.openstreetmap.org/wiki/Key:oneway`：方向以源节点顺序为准。
- `https://wiki.openstreetmap.org/wiki/Tag:highway%3Dcrossing`：crossing 节点与独立步行 way。
- `https://wiki.openstreetmap.org/wiki/Key:footway`：sidewalk／crossing 的细分。
