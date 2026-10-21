# 数据来源与处理

## 获取范围

- 城市：江苏省苏州市。
- 边界：OpenStreetMap `relation/4430941`，整个地级市行政区域。
- 建筑、路网、水域、绿地：Overpass `area(3604430941)` 查询。
- 坐标：WGS84 经度、纬度（GeoJSON 顺序）。
- 默认下载服务：`https://overpass.private.coffee/api/interpreter`。
- 替代服务通过 `OVERPASS_ENDPOINT` 显式指定，不做静默切换。
- 许可：ODbL 1.0，© OpenStreetMap contributors。

原始文件 `data/raw/{boundary,roads,water,green,buildings}.json` 保留服务器响应，
`surface.json` 是道路、水系和绿地按 OSM 类型与 ID 去重后的集合。
实际建筑数据日期、总数、分块数见 `public/data/manifest.json`；各层下载时间可能不同，
当前界面的“数据快照”指建筑层的 OSM 基础数据库时间，不代表实时城市变化。

OSM 建筑高度字段是社区提供的属性，不保证实测精度。城市边界也以来源版本为准，
本应用不是官方行政区划或法定测绘成果。

## 获取与发布完整性

1. HTTP 非成功状态、非 JSON、带 `remark` 的超时／部分响应都判定为失败。
2. 原始下载先写入临时文件，校验完整后才替换对应缓存。
3. 使用 osmtogeojson 组装多段关系，保留 Polygon/MultiPolygon 和内环。
4. 建筑根据 ID 去重；排除不完整、未闭合、非有限坐标、非面对象。
5. 建筑包围盒中心或任一外环顶点位于行政边界内时保留。
   这属于边界筛选，不做严格多边形裁切；罕见的无顶点交叉情况可能遗漏。
6. 建筑在基准网格中只保存一次，索引 bounds 包含实际轮廓范围，
   因而跨分块建筑可被相邻视口发现。院落孔洞不会被填成实体。
7. 所有输出写入基于源文件内容哈希的版本目录，最后发布清单。
8. 空建筑结果，或任一必需地表层（道路、水域、绿地）没有可用几何时，不发布新清单；
   `building=no` 和未标注为建筑的关系成员不会生成建筑。
   `counts.skipped` 记录规范化时跳过的对象数量。

地表要素保留来源的完整几何，因此跨越市界的道路、河流或湖泊可能延伸到边界外。
不把这种延伸解释为苏州市行政区域扩大。

## 高度规则

| 数据条件 | 输出 | 标记 |
|---|---|---|
| 合法 `height`，0–1000 m 范围内（不含 0） | 直接采用，支持 m、ft、英尺符号 | OSM 标注 |
| 有效 `building:levels`，0–200 范围内（不含 0） | 楼层数 × 3.2 m | 估算／楼层推算 |
| house、detached、terrace、residential | 9.6 m | 估算／类型默认 |
| industrial、warehouse、commercial | 10 m | 估算／类型默认 |
| garage、garages、shed | 3.2 m | 估算／类型默认 |
| 其他 | 12.8 m | 估算／类型默认 |

缺失高度不会使用随机数，也不会为了夜景效果夸大真实高度。
目前没有提取坡屋顶或建筑部件，OSM 属性可通过建筑详情中的原始记录链接核查。

### 通用参考高度插件

`web/core/building-heights.ts` 提供可复用的 `createHeightProvider`：
数据记录与建模代码分离，`building-height-references.ts` 只保存建筑身份、轮廓范围、
高度及其约值标记、可核实的楼层数、来源和核对日期，不为每栋楼编写模型。
新增记录仍走同一套 `emitArchitecture`，覆盖 far／mid／near 三档；
立面、塔冠、窗格分布是通用参数化近似，不是逐楼测绘，楼层数不会被伪造为实测窗格。

通用建筑的亮窗按建筑 ID、立面、窗列和窗层确定性分布，保留亮暗混合；
远／中景只剩少量窗格时，也不会因楼层步长与取模周期重合而整栋全黑或全亮。
三档使用原有窗格和几何预算，不增加装饰面。日景仍关闭窗光自发光，夜景由光晕强度
控制；亮窗并不表示真实楼内入住或营业状态。修改分布后必须重新生成持久模型，
仅更新前端不会改变已有 GLB 内的亮暗窗材质。

插件仅替换 `fallback` 类型默认高度，不覆盖已有 OSM 高度、楼层推算或现有地标模型。
源 ID 必须精确匹配，轮廓范围变化超过 0.00002° 时构建失败，要求重新核对身份；
不会把附近或同小区的记录传播给其他建筑。GLB 的 `heightReference` 元数据与原始
`height`／`basis`／`estimated` 分开保存，点击建筑可以分别查看。
数据和插件代码均参与构建哈希，修改后运行 `npm run data:architecture:build`，
完整生成三档模型后才发布新清单；包围体使用修正高度，避免高楼被裁掉。

2026-10-20 核对并接入的十二条记录（本轮全市核对新增 The Summit 与张家港汇金双塔）：

| 建筑 | 冻结 OSM 轮廓 | 原默认值 | 参考总高 | 地上楼层 | 资料 |
|---|---|---|---|---|---|
| 苏州 ICC | `way/802754584` | 12.8 m | 303.2 m | 68 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/suzhou-icc/10738)、[位置](https://www.skyscrapercenter.com/map/building/10738) |
| 苏州恒和广场 | `way/822365267` | 12.8 m | 175 m | 48 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/suzhou-henghe-plaza/2529)、[位置](https://www.skyscrapercenter.com/map/building/2529) |
| 苏州新地中心（西塔） | `way/475616606` | 12.8 m | 232 m | 54 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/suzhou-xindi-center/1081)、[位置](https://www.skyscrapercenter.com/map/building/1081) |
| 苏州国际商务中心东塔 | `way/475616607` | 12.8 m | 125 m | 28 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/suzhou-international-commerce-center-east-tower/14490)、[位置](https://www.skyscrapercenter.com/map/building/14490) |
| Metropolitan Tower A | `way/475616603` | 12.8 m | 210 m | 52 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/metropolitan-tower-a/1453)、[位置](https://www.skyscrapercenter.com/map/building/1453) |
| Metropolitan Tower B | `way/475616604` | 12.8 m | 210 m | 52 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/metropolitan-tower-b/1454)、[位置](https://www.skyscrapercenter.com/map/building/1454) |
| 圆融星座 · 西公寓塔 | `way/482784883` | 12.8 m | 约 100 m | 未确认 | [江河幕墙项目资料](https://mcw.jangho.com/html/gongchengyeji/guoneigongcheng/2013/0114/398.html)、[中衡设计塔楼布局](https://www.artsgroup.cn/zhonghengdongtai/zhonghengxinwen/2024-07-03/1167.html) |
| 圆融星座 · 南公寓塔 | `way/482784884` | 12.8 m | 约 100 m | 未确认 | [江河幕墙项目资料](https://mcw.jangho.com/html/gongchengyeji/guoneigongcheng/2013/0114/398.html)、[中衡设计塔楼布局](https://www.artsgroup.cn/zhonghengdongtai/zhonghengxinwen/2024-07-03/1167.html) |
| 圆融星座 · 办公塔 | `way/482784885` | 12.8 m | 160 m | 未确认 | [江河幕墙项目表](https://mcw.jangho.com/html/gongchengyeji/guoneigongcheng/2013/0114/398.html)、[中衡设计塔楼布局](https://www.artsgroup.cn/zhonghengdongtai/zhonghengxinwen/2024-07-03/1167.html) |
| The Summit · 39 层塔楼 | `way/505305793` | 12.8 m | 166.9 m | 39 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/the-summit-plot-554/18927)、[位置](https://www.skyscrapercenter.com/map/building/18927)、[GP 设计资料](https://www.gpchicago.com/architecture/summit/) |
| 张家港汇金中心 1 号楼 | `way/822635143` | 12.8 m | 188 m | 未确认 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/huijin-center-tower-1/43634)、[位置](https://www.skyscrapercenter.com/map/building/43634) |
| 张家港汇金中心 2 号楼 | `way/822635144` | 12.8 m | 188 m | 未确认 | [CTBUH 建筑记录](https://www.skyscrapercenter.com/building/huijin-center-tower-2/43597)、[位置](https://www.skyscrapercenter.com/map/building/43597) |

前六条来源地图点均落在各自塔楼轮廓内；ICC、恒和距轮廓质心约 10.8 m／3.2 m。
恒和广场相交的大轮廓 `way/822365266` 保持原状，不把裙楼一并拉高。
狮山四塔结合来源卫星图核对独立塔楼与裙楼：北侧西塔／东塔分别匹配新地中心、
国际商务中心东塔；南侧东北塔／西南塔分别匹配 Metropolitan Tower A／B。
两组共用裙楼 `way/475616608`、`way/475616605` 及邻近 `way/475616602`
仍保留 12.8 m 类型默认值；卫星图只核对身份，不用于测高。

圆融星座按设计方项目照片、Esri World Imagery 与冻结 OSM 独立轮廓核对：
西／南两座公寓采用幕墙承包方描述的约 100 m，`approximate: true` 随 GLB 元数据
保留，信息卡显示「约」和「资料约值」；东北办公塔采用项目表的 160 m。
同一资料正文另有办公塔「约 150 m」的概述，因此不把项目表高度宣称为测绘值。
三塔均未确认楼层数，不据高度反推或显示楼层数。
共用裙楼 `way/482784880` 及低层轮廓 `way/533115311`、`way/533115312`、
`way/533115314`、`way/533115316` 保持原 12.8 m；不新增重复轮廓或抬高整块商场。

The Summit 的来源地图点位于南侧独立塔楼轮廓内，结合设计方对两地块的说明，
只修正 39 层塔楼，不改动北侧 `way/462717404` 的原 80.6 m 高度。
张家港汇金双塔的来源地图点分别落在西／东独立轮廓内，楼层数不明则不显示；
共用裙楼 `way/822635142` 不抬高。位置页坐标按 Esri／OSM 底图解释为 WGS84
兼容，但出版方未明确声明坐标基准，不将其包装为测绘精度。

高德地图用于发现候选和对照地名，不从地图外观推算高度。湖东传媒广场、丰隆中心
已有地标模型，本批不重复添加通用记录；丰隆资料地图点与现有塔楼身份存在冲突，
不据此覆盖现有高度。太平金融大厦的本地轮廓合并了塔楼与裙楼，中海财富中心、
研祥金融中心缺少可确认的独立塔楼轮廓，均未采用；乐嘉大厦、金匙望湖及启迪地块
仍待补足可靠高度或独立轮廓证据。
这里只引用少量事实及来源链接，不复制其照片或模型，不声称 CTBUH 数据具有 ODbL
或开放数据许可；原始 OSM 轮廓仍按 ODbL 署名。

这不是全市高度补齐：56,459 条原始建筑中 55,033 条仍是类型默认来源，
其中 12 条通过通用参考高度修正渲染，原有地标另行覆盖；不能把剩余原始默认记录数
等同于仍以默认高度渲染的建筑数。原始 JSON 与统计不改写。
GBA 和 3D-GloBFP 的苏州样本均未通过高度对照：例如 3D-GloBFP 对有 194.7 m
来源高度的苏州中心 2 号楼约为 88.9 m，因此未批量接入，也未按统一倍数拉伸。
未来扩充必须同时核实高度与建筑身份；增加数据记录不需要增加建模分支。

### 全市百米高楼候选与缺口

范围为苏州全地级市已建成、总高至少 100 m 的各用途建筑，包含住宅，
并覆盖昆山、常熟、张家港、太仓。`web/core/suzhou-highrises.ts` 保存公开资料候选，
逐条区分完工状态、实际／概述高度、规划上限、独立轮廓和待解决原因。
在建、停工、规划与状态不明的项目保留线索，但不按设计高度新增建成模型；
电梯测试塔单列工业测试用途，不作为普通使用高层建筑的统计基线。

运行 `npm run data:highrises:build` 原子生成 `public/highrises/coverage.json`。
在基础数据或候选资料变化后重新生成；修改参考高度还须先运行
`npm run data:architecture:build`，完整发布三档模型后再运行 `npm run build`。
报告可从本地服务的 `/highrises/coverage.json` 读取，不依赖外部运行时接口。
报告校验来源 ID 唯一性、冻结轮廓存在性、完成状态和渲染高度一致性，
并保存基础数据集与所有 616 个分块的 SHA-256，方便复核。

本轮报告含 **31 条候选／项目线索、12 条通用参考覆盖、19 条缺口**；
候选包含尚未拆分到独立塔楼的住宅项目，不能把候选数当作实际楼栋数。
报告为姑苏、虎丘、吴中、相城、吴江、工业园区及四个县级市分别列出候选、
覆盖和缺口数，`gapsByReason` 区分缺失轮廓、裙楼合并、高度冲突、
身份未核实、完工未核实、高度未核实与未建成。
吴中等区域的零条已核实记录只表示本轮资料不足，不代表没有百米高楼。

例如星俪酒店和 CSSD Plaza 保留合并裙楼缺口，常熟金茂高层和太仓新港商务区
保留缺失轮廓缺口；恒力中心的 209 m 来源与原 OSM 楼层推算 121.6 m 冲突单列，
不绕过插件的原始高度保护。昆山世茂蝶湖湾仅保留住宅项目线索，
不把建筑师提到的四座 150 m 塔楼擅自匹配到楼号或轮廓。

`sourceOnly` 另列 31 条原 OSM 高度或楼层推算达到阈值、但未外部核实身份与完工
状态的记录，不计为已核实覆盖；`existingLandmarks` 另列原有地标及其来源，
不冒充本轮新增核实成果。没有逐栋权威完整基线，报告始终保留
`baselineComplete: false`／各区 `exhaustive: false`，不发布全市覆盖百分比，
也不宣称全部百米高楼已补齐。

## 离线与资源预算

默认渲染只从本地 HTTP 服务读取数据、Cesium Workers/Assets/Widgets/ThirdParty。
禁止把 OSM 公共瓦片服务批量下载作为离线地图；本项目没有这种行为。

建筑视口并发下载数为 2；流畅／均衡／精细最多分别保留 4／8／14 个建筑分块。
相机高度超过 24 km 时释放建筑细节，保留全市地表概览。
移出视口的建筑 Primitive 被销毁，过期网络请求被取消；
已释放的 GeoJSON 不保存在无界内存缓存中。
“场景就绪”在启用的地表几何完成 GPU 准备后显示；当前建筑数只统计已就绪、可显示的分块。
截图会等待当前视口所需的启用图层与建筑就绪。遇到分块失败或准备超时会明确报错，
不会导出一张成功形态的空白地图。

截图、灯光和区域定位都不改变源地理数据。配置文件只包括显示状态，
不包括原始数据、访问令牌或个人信息。

立面窗光在顶点阶段使用高低位编码坐标减去固定本地原点，再交给片元阶段，
不在片元中重建数百万米量级的世界坐标。窗光按像素覆盖范围平滑和降采样；
这只是显示精度处理，不增加来源中不存在的立面或建筑细节。
