# City Detail and Jinji Lake Mobility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade citywide static building/road detail and deliver an offline Jinji Lake district with authored models and safe, visibly active simulated vehicles and pedestrians.

**Architecture:** Keep the existing React/Cesium application and versioned base dataset. A separately validated enhancement package supplies metre-based roads, a source-audited district, authored GLBs, and distinct driving/walking graphs; a deterministic CPU simulation feeds a lifecycle-owned Cesium layer. Data validity, a real-browser asset slice, and measured safety/performance are release gates, not optional follow-up work.

**Tech Stack:** Existing TypeScript, React, Cesium, Node/tsx, Vitest and Playwright; local Blender background Python for self-authored assets. No second renderer, hosted runtime services, or new dependency is planned.

**Spec:** `docs/superpowers/specs/2026-10-15-city-detail-and-mobility-design.md` (approved 2026-10-15).

## Global Constraints

- 全城升级指静态建筑与道路表现；首版动态车人仅在金鸡湖示范区运行，不宣称已经实现全市交通模拟。
- 数据准备阶段从该片区选定一个约 0.5–1 平方公里的连贯范围，最终边界、源道路 ID、过街点和排除项写入随库清单。
- 独立、可测试的确定性模拟核心，使用固定 0.05 秒时间步。
- 每帧最多补算 5 步；长时间暂停不累积追赶量，不突然跨越整个路口。
- 暂停、标签页隐藏、离开示范区、关闭全部动态层时停止推进。
- 新配置采用 v2，明确迁移已有 v1 配置，保留原字段和用户原选择。
- 拟定默认：街区细节、车辆、行人开启；模拟未手动暂停。
- 增强包压缩前新增发布资源目标不超过 30 MB，可编辑 Blender 源文件另计。
- 在本机硬件加速浏览器、1600×900 视口、DPR 1、均衡档、固定示范区相机路径上，预热后采样 60 秒：帧耗时 p95 目标不超过 33.3 ms，模拟更新 p95 不超过 4 ms。
- 首个交付场景在均衡档应能持续展示至少 20 辆车、30 名行人的活动，而不是为了性能全部隐藏或让对象静止。
- 连续进入／离开示范区 10 次，不遗留模拟计时器、活动模型或无限增长的缓存。
- 流畅上限 24 辆车 / 40 名行人；均衡 60 / 100；精细 100 / 160。
- Four waiting vehicles, one per approach, clear exits, no arrivals: every vehicle receives passage within 30 simulated seconds. Public seeded safety run: at least 600 simulated seconds.
- Preserve footprints, holes, IDs and height provenance. Missing sidewalks, bridge elevations, landmarks and crossing connections must not be invented.
- Keep Chinese controls, current navigation and all orbit/pan/zoom behavior. Keep base `CityManifest.version: 1`; introduce an independent enhancement schema.
- Download only in explicit preparation commands. Ship all runtime resources locally. Never modify the user's open Blender scene.
- Do not claim full readiness for a failed/mismatched enhancement package; base-city browsing remains usable with explicit unavailable/error status and retry.

---

## Execution boundaries and known integration points

This is one dependent delivery, not independent traffic and art applications. Its independently reviewable milestones are (A) audited data, (B) asset slice and static detail, (C) pure simulation, (D) integrated acceptance. Complete Tasks 1–3 before expanding assets; do not spend on a full model pack if the real routes cannot satisfy the spec.

Execution starts in an isolated workspace using the worktree skill, preserving the running application and any unrelated changes. Do not install dependencies unless a chosen command fails because they are missing. Do not push commits without a new user request. Each task stages only its named files and generated deliverables after reviewing `git diff --check`.

Current source anchors (line numbers may shift during execution):

| Existing file | Integration point |
|---|---|
| `pipeline/build.ts` | `buildDataset`, surface property projection, dataset content hash, last manifest rename |
| `pipeline/normalize.ts` | `validateOverpass`, `OverpassResponse`; reuse validation, do not copy a second response parser |
| `web/core/types.ts` | `SceneSettings`, `SceneStats`; keep original building and manifest fields |
| `web/core/settings.ts` | `defaultSettings`, `parseSettings`, `encodeSettings`, `SETTINGS_KEY` |
| `web/scene/CityScene.ts` | `initialize`, `addSurface`, `loadTile`, `updateTiles`, `updateSettings`, `report`, `retry`, `screenshot`, `destroy` |
| `web/scene/materials.ts` | `buildingMaterial`, `facadeVertexShader`; existing night windows are baseline, not a new feature |
| `web/App.tsx` | local-storage bootstrap, layer controls, ready/error UI, screenshot button, data provenance panel |
| `tests/fixtures/clarity.ts` | existing direct scene browser harness; preserve its behavior |
| `playwright.config.ts` | existing software-rendered regression suite; do not turn this into hardware evidence |

### File map

| New path | Responsibility |
|---|---|
| `pipeline/enhancements/fetch.ts` | explicit bounded OSM fetch/cache and complete relation/node acquisition |
| `pipeline/enhancements/build.ts` | candidate compilation, provenance/diagnostics, atomic release |
| `pipeline/enhancements/routes.ts` | source-tag normalization, separate graphs, verified turns/crossings and route capacity |
| `pipeline/enhancements/geometry.ts` | local projection, polygon/segment containment and swept-envelope validation |
| `web/core/enhancements.ts` | shared serializable contracts and strict runtime parser, no Node/Cesium imports |
| `web/core/mobility.ts` | deterministic state, fixed-step stepping, following, reservations and pedestrian rules |
| `web/core/detail.ts` | deterministic facade profiles, safe accessory placement, LOD policy |
| `web/scene/DetailLayer.ts` | batched near-road and building detail geometry; regional static assets |
| `web/scene/MobilityLayer.ts` | load GLBs, synchronize pose/animation, own frame loop and disposal |
| `assets/city/generate.py` | isolated Blender geometry/material/animation creation and export |
| `assets/city/SOURCES.md` | authorship, axes, scale, generation and inferred-detail disclosure |
| `assets/city/city-assets.blend` | editable asset source, outside runtime byte budget |
| `data/enhancements/jinji-lake-selection.json` | audited boundary, source IDs, crossings, exclusions, camera and placement choices |
| `public/enhancements/manifest.json` | atomic pointer to a validated content-addressed package |
| `public/enhancements/<id>/` | network, static roads, provenance, placement inventory and GLBs |
| `tests/fixtures/mobility.{html,ts}` | real Cesium integration/asset harness, typed test controls |
| `tests/fixtures/enhancements.ts` | small hand-auditable synthetic source graphs, never public geographic evidence |
| `tests/unit/enhancements.test.ts` | input/geometry/topology/publication tests |
| `tests/unit/detail.test.ts` | footprint constraints, stable facade profiles and hysteresis |
| `tests/unit/mobility.test.ts` | deterministic time, following, reservations, pedestrians and liveness |
| `tests/unit/mobility-soak.test.ts` | published-network 600-second seeded safety/activity run |
| `tests/e2e/enhancements.spec.ts` | GLBs, animation, lifecycle, error/retry, settings and offline behavior |
| `tests/e2e/enhancements-visual.spec.ts` | fixed before/after and per-asset runtime captures |
| `tests/performance/mobility.spec.ts` | hardware frame/update/count/camera-path measurement |
| `playwright.performance.config.ts` | separate headed hardware configuration, no software flags |
| `docs/city-enhancements.md` | commands, assumptions, controls, provenance, limitations and measured results |

Generated candidate resources go to `data/enhancements/staging/`, not the active public manifest. Raw downloaded responses remain in `data/raw/jinji-lake/`. Inspect `.gitignore` when adding these paths; ignore raw/staging/intermediate files, not the audited selection, source script, editable asset file or final runtime resources.

### Shared contract decisions

Task 1 creates the following types in `web/core/enhancements.ts`. Later tasks extend only the explicitly stated fields; imports use these exact names. Coordinates in graphs are local east/north metres relative to `origin`; do not run braking or widths in degrees. Model position is its footprint centre.

```ts
import type { Bounds } from './types';
export type XY = [number, number];
export type Polygon2 = XY[][]; // outer ring then holes, closed
export type ActorKind = 'car-a' | 'car-b' | 'bus' | 'person-a' | 'person-b';
export interface Diagnostic {
  sourceIds: string[];
  code: string;
  message: string;
}
export interface Edge {
  id: string;
  sourceIds: string[];
  from: string;
  to: string;
  mode: 'drive' | 'walk';
  points: XY[];
  length: number;
  width: number;
  speed: number;
  allowed: ActorKind[];
  next: string[];
  // These are validated metre polygons, not visual line widths.
  corridor: Polygon2[];
  conflicts: { zone: string; enter: number; exit: number }[];
  inferred: string[];
}
export interface Route {
  id: string;
  mode: Edge['mode'];
  edges: string[];
  allowed: ActorKind[];
  // Entry/exit segments must be outside the showcase camera's central view.
  entry: string;
  exit: string;
}
export interface Network {
  origin: XY;
  bounds: Bounds;
  edges: Edge[];
  routes: Route[];
  zones: { id: string; polygon: Polygon2; edges: string[] }[];
  buildings: Polygon2[];
  water: Polygon2[];
}
export interface Asset {
  kind: ActorKind | 'tree' | 'lamp' | 'entrance' | 'roof-unit';
  uri: string;
  sha256: string;
  bytes: number;
  size: [number, number, number]; // length, width, height in metres
  animation: string | null;
}
export interface EnhancementManifest {
  version: 1;
  id: string;
  baseDataset: string;
  generatedAt: string;
  bounds: Bounds;
  network: string;
  roads: string;
  provenance: string;
  placements: string;
  assets: Asset[];
  showcase: { target: XY; heading: number; pitch: number; range: number };
}
export interface Actor {
  id: number;
  kind: ActorKind;
  route: string;
  edge: string;
  distance: number;
  speed: number;
  length: number;
  width: number;
  position: XY;
  heading: number; // radians clockwise from local north
  walkPhase: number; // [0,1), advances with travelled distance only
}
export interface MobilitySnapshot {
  time: number;
  actors: readonly Actor[];
  owners: Readonly<Record<string, number>>;
  passedByEntry: Readonly<Record<string, number>>;
  travelledByKind: Readonly<Record<ActorKind, number>>;
}
export interface MobilityOptions {
  seed: number;
  vehicles: number;
  pedestrians: number;
  arrivals: boolean;
}
```

`parseEnhancementManifest(value: unknown, baseDataset: string): EnhancementManifest` and `parseNetwork(value: unknown): Network` reject unsupported versions, nonfinite or negative dimensions/speeds, duplicate IDs, dangling edges/zones/routes, invalid polygons and mode transitions. Network zero speeds are invalid; zero actor speed is valid. Only same-origin relative package paths are accepted; reject absolute URLs, `..`, encoded traversal, query strings and fragments. A successful JSON fetch alone never proves schema validity.

Commits in each task use the trailer pattern below; this is the Task 1 message. Use the concrete subject listed at the end of each subsequent task and stage only that task's named files:

```bash
git diff --check
git commit -m "feat: prepare audited Jinji Lake source data" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 383756f8-57ee-41e7-ae11-7402b01d58ac"
```

## Task 1: Auditable district candidate and shared schemas

**Files:** Create `web/core/enhancements.ts`, `pipeline/enhancements/fetch.ts`, `tests/fixtures/enhancements.ts`, `tests/unit/enhancements.test.ts`, `data/enhancements/jinji-lake-selection.json`; modify `package.json`, `.gitignore`, `docs/city-enhancements.md`.

**Interfaces:** Consumes `validateOverpass(value, requireElements)` and existing cached boundary/building/water data. Produces the shared contracts above; `fetchDistrict({ bounds, cacheDir, refresh }: { bounds: Bounds; cacheDir: string; refresh: boolean }): Promise<void>`; cached full node/way/restriction relations with snapshot metadata. Selection JSON is data discovered here, not fictional IDs copied from this plan.

- [ ] **1. Write RED schema/cache tests.** In the fixture file define a literal source with nodes `(0,0)`, `(40,0)`, `(80,0)` in test-local coordinates, way IDs `101` and `102`, shared node `2`, plus a separate `highway=footway` source and crossing-tagged node. Label the fixture synthetic. Test malformed schemas separately from graph construction:

  ```ts
  import { expect, it } from 'vitest';
  import { parseEnhancementManifest, parseNetwork } from '../../web/core/enhancements';
  it('rejects malformed data rather than producing an empty successful layer', () => {
    expect(() => parseNetwork({ edges: [] })).toThrow();
    expect(() => parseEnhancementManifest({
      version: 99, baseDataset: '0123456789abcdef',
    }, '0123456789abcdef')).toThrow();
  });
  ```

  Add valid-manifest round-trip and mutation tests for every parser rule above. Fetch tests mock `globalThis.fetch` with Vitest: HTTP 503, Overpass `remark`, truncated node references, valid cached response and explicit refresh. Compare cache bytes before/after a failed download.
- [ ] **2. Run RED.** `npm test -- tests/unit/enhancements.test.ts`; expect unresolved new module/tests, not an unrelated dependency failure.
- [ ] **3. Implement the contracts and bounded fetch.** Start investigation bbox at `[120.671,31.308,120.691,31.330]`; this is a search window, NOT the final published district. Preserve all node IDs and tags; query all highway ways and restriction relations, then recursively retrieve relation members and way nodes. Use the existing endpoint override, timeout/retry/backoff conventions, `validateOverpass`, temporary file and rename. Never attach this command to `dev` or `build`.

  ```ts
  const [west, south, east, north] = bounds;
  const box = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:180];(
    way["highway"](${box});
    node["highway"="crossing"](${box});
    rel["type"="restriction"](${box});
  );(._;>>;);out body;`;
  ```

  Save query, bbox, endpoint hostname, fetched timestamp and OSM snapshot alongside the response. Retain relation membership even when the route compiler later excludes it. Add script `"data:enhancements:fetch": "tsx pipeline/enhancements/fetch.ts"` with a guarded CLI entry.
- [ ] **4. Freeze an evidence-backed candidate.** Run `npm run data:enhancements:fetch` explicitly. Inspect source ways/nodes and existing building/water geometry. Select a connected 0.5–1 km² west-bank district containing an actual same-level junction, an explicitly tagged crossing connecting both sides, and a lake footpath. Record exact selected and excluded source IDs, crossing connections, access/oneway/layer/restriction tags, snapshot and calculated area in selection JSON. Preserve unsupported restrictions as diagnostics and exclude affected movements. If candidate fails, adjust within Jinji Lake and record the reason; if no suitable data exists, stop and ask for scope rather than synthesize routes. No mass asset generation before Task 2 confirms usable capacity.
- [ ] **5. Run GREEN and commit.** `npm test -- tests/unit/enhancements.test.ts && npm run build`. Stage only this task's source/tests/selection/docs/scripts; commit `feat: prepare audited Jinji Lake source data`. Downloaded raw caches remain local. This milestone is preparation, not a working enhancement release.

## Task 2: Metre-based safe route compilation and publish gate

**Files:** Create `pipeline/enhancements/{geometry,routes,build}.ts`; extend `tests/unit/enhancements.test.ts`, `tests/fixtures/enhancements.ts`, `package.json`, `docs/city-enhancements.md`.

**Interfaces:** Consumes Task 1 source/selection and base manifest. Produces:

```ts
export function project(point: XY, origin: XY): XY;
export function unproject(point: XY, origin: XY): XY;
export function sweptEnvelope(points: XY[], length: number, width: number): Polygon2[];
export function validateEnvelope(
  envelope: Polygon2[], corridor: Polygon2[], buildings: Polygon2[], water: Polygon2[],
): void;
export function compileNetwork(
  source: unknown, selection: unknown, buildings: Polygon2[], water: Polygon2[],
): { network: Network; diagnostics: Diagnostic[] };
export function buildEnhancements(options: {
  rawDir: string; selectionPath: string; baseDir: string;
  assetDir: string; outputDir: string; publish: boolean;
}): Promise<EnhancementManifest | { candidate: Network; diagnostics: Diagnostic[] }>;
```

`geometry.ts` owns the four geometric functions; `routes.ts` owns `compileNetwork`; `build.ts` owns `buildEnhancements`. Keep `geometry.ts` browser-safe (no Node imports or file I/O), since static detail and browser diagnostics reuse it. Strictly parse selection/source inputs before use.

- [ ] **1. Write RED topology and swept-geometry tests.** Add fixtures for shared same-level node, mere XY intersection without a shared node, bridge/tunnel, one-way `yes` and `-1`, `access=no`, `motor_vehicle=no`, foot access, missing sidewalk, unsupported via-way restriction, valid `no_*`/`only_*` via-node restrictions and disconnected crossing. Reject rather than invent a connection.

  ```ts
  import { validateEnvelope } from '../../pipeline/enhancements/geometry';
  it('rejects a swept body intersecting an obstacle even with clear endpoints', () => {
    const road: Polygon2 = [[[-10,-4],[10,-4],[10,4],[-10,4],[-10,-4]]];
    const building: Polygon2 = [[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]];
    const body: Polygon2 = [[[-5,-1],[5,-1],[5,1],[-5,1],[-5,-1]]];
    expect(() => validateEnvelope([body], [road], [building], [])).toThrow();
  });
  ```

  Test a concave obstacle, a footprint hole, curve crossing water, narrow bus turn and legal narrow pedestrian path. Include segment-edge intersections and containment in either direction; endpoint/corner-only checks are insufficient.
- [ ] **2. Run RED.** `npm test -- tests/unit/enhancements.test.ts`.
- [ ] **3. Implement projection and lane/turn graphs.** Use one district tangent approximation for computation, with WGS84 output preserved:

  ```ts
  const R = 6378137;
  const rad = Math.PI / 180;
  export function project([lng, lat]: XY, [lng0, lat0]: XY): XY {
    return [(lng-lng0)*rad*R*Math.cos(lat0*rad), (lat-lat0)*rad*R];
  }
  export function unproject([x, y]: XY, [lng0, lat0]: XY): XY {
    return [lng0+x/(rad*R*Math.cos(lat0*rad)), lat0+y/(rad*R)];
  }
  ```

  Preserve source IDs across split edges. Driving lanes are offset right relative to each allowed direction; apply explicit width/lane tags first, otherwise record assumptions (3 m lane, maximum 8 m/s demonstration speed). Strictly parse numeric units including supported `mph`; reject invalid values with diagnostics. Infer no sidewalk from road class. A tagged sidewalk may produce offset walking geometry only after obstacle/width validation; footway sources remain independent.

  Use source shared nodes and compatible levels for connectivity. Exclude unsupported elevated/tunnel segments and complex restrictions before route discovery. Generate turning connections with sampled curves at maximum 0.25 m chord length and conservative swept polygons, including the maximum actor body and between-sample travel. Validate each complete turn, crossing and spawning body against corridors, buildings and water. Use line/polygon intersection and winding tests; test numerical tolerances at 1 mm, inflate bodies by that tolerance rather than accepting near misses.

  Each intersection/crossing zone lists every affected movement. Conservative all-movements-exclusive junctions are acceptable. Build conflict extents from the swept-body intersections, not just centreline intersections. Pedestrian crossings and adjacent vehicle stopping points share the same zone IDs. Validate reachability from source entry to exit; do not teleport between disconnected ends.
- [ ] **4. Add candidate and atomic release modes.** Add `"data:enhancements:build": "tsx pipeline/enhancements/build.ts"`. Default is staging candidate; `--publish` requires complete assets/roads/provenance/placement inventory, all parsers, SHA-256/byte checks and all route validations. Content ID hashes schema, base dataset ID, source, assumptions, routes and assets, excluding wall-clock generation time. Files are immutable inside the content directory; publish `manifest.json` only after all writes and validation succeed:

  ```ts
  const temporary = join(outputDir, `manifest.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(manifest));
  await rename(temporary, join(outputDir, 'manifest.json'));
  ```

  Reject overwriting an existing content directory with different bytes. On failure preserve old manifest and old immutable files and emit `console.error` with nonzero CLI exit. The function throws; no success-shaped fallback.
- [ ] **5. Validate real candidate and capacity.** Run candidate build; derive a report listing junction/crossing IDs, all selected routes/actors, exclusions and conservative entry/route storage capacities. Ensure enough validated route length and safe entries to sustain 20 vehicles/30 pedestrians without sidewalk crowding, central-view spawn or blind loops. This is a static feasibility gate; Task 8 still must prove dynamic activity. Fix candidate bounds/routes if needed before asset expansion.
- [ ] **6. Run GREEN and commit.** `npm test -- tests/unit/enhancements.test.ts && npm run build`. Add a test that publishes one valid fixture package, corrupts a second, and compares previous manifest bytes/content afterward (use existing `build.test.ts` temporary-directory pattern). Commit `feat: compile validated district mobility routes`.

## Task 3: Minimal Blender-to-Cesium asset slice and visual baseline

**Files:** Create `assets/city/generate.py`, `assets/city/SOURCES.md`, `assets/city/city-assets.blend`, `public/enhancements/slice/{car-a,person-a}.glb`, `tests/fixtures/mobility.{html,ts}`, `tests/e2e/enhancements-visual.spec.ts`; extend `docs/city-enhancements.md`.

**Interfaces:** Consumes candidate origin/camera and route widths; produces provisional `car-a.glb` and `person-a.glb` plus inventory in `public/enhancements/slice/`. This explicit test-only slice is served locally without publishing an enhancement manifest; Task 5 removes it after switching the harness to final immutable assets. Harness exposes `window.mobility.ready: Promise<void>`, `scene: CityScene`, `errors: string[]`, `assetViews(): Promise<void>` and `capture(name: string): Promise<Blob>`. Define its `Window` augmentation in the harness, following `clarity.ts`; never add a debug global to the production application.

- [ ] **1. Capture baseline before changing materials/geometry.** In the browser harness load the base city at recorded selection camera, fixed 1600×900/DPR1, medium, day and night. Capture city midrange and district oblique before screenshots into Playwright attachments; save camera settings and base dataset ID beside them. Existing base has no actors: mark vehicle/pedestrian before captures as absent, do not substitute another scene.
- [ ] **2. Write RED real-model tests.** Extend `assetViews()` to place each slice model at a known metre coordinate in the actual Cesium viewer. Load the GLB, inspect model readiness, bounding volume and animation inventory; capture front, side and moving pedestrian views. Assert required `Walk` animation is present, bounds match expected metre dimensions within 5%, person pose changes while walking and is stable when stopped. `npm run test:e2e -- tests/e2e/enhancements-visual.spec.ts` must fail while assets are missing.
- [ ] **3. Author and export slice without touching open Blender.** Use a standalone process:

  ```bash
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --factory-startup \
    --python assets/city/generate.py -- --slice --output public/enhancements/slice
  ```

  Parse script arguments after `--`; require an explicit output directory. Slice car dimensions are 4.4×1.8×1.45 m and person height is 1.75 m. All generated coordinates use metres; Blender Z up, actor forward -Y. Export glTF Y up; confirm resulting axes in the browser rather than applying a guessed 90-degree rotation. Use bevelled car body/cabin, dark windows, four visible wheels, front/rear lights; build the person from jointed torso/head/arms/legs, not a cube or billboard. Create a one-second cyclic `Walk` action with opposing limbs and a neutral pose at phase zero:

  ```python
  import math
  for frame, angle in ((1, 0), (7, 0.45), (13, 0), (19, -0.45), (25, 0)):
      left_leg.rotation_euler.x = angle
      right_leg.rotation_euler.x = -angle
      left_arm.rotation_euler.x = -angle * 0.7
      right_arm.rotation_euler.x = angle * 0.7
      for part in (left_leg, right_leg, left_arm, right_arm):
          part.keyframe_insert(data_path="rotation_euler", frame=frame)
  ```

  The script defines these four limb objects at hip/shoulder pivot origins before keyframing, parents them to the character root, collects animation into `Walk`, uses 24 fps and exports only that asset's objects. Car root is centre of footprint on ground; person root is between feet. Applied transforms and material normals must be correct, with no external texture dependencies. Save the editable `.blend` under `assets/city/`, never the user's current file.
- [ ] **4. Connect actual Cesium models.** Use the installed `Model.fromGltfAsync` and animation types, not a replacement renderer:

  ```ts
  const model = await Model.fromGltfAsync({
    url: assetUrl, modelMatrix, minimumPixelSize: 0, scale: 1,
  });
  viewer.scene.primitives.add(model);
  viewer.scene.requestRender();
  ```

  Wait for rendering readiness before animation attachment or screenshots, with a bounded timeout and explicit error. Verify front heading at north/east/south/west, ground contact, window/body distinction and limb motion in runtime screenshots. Document the resulting single axis correction matrix for all assets in `SOURCES.md`; Task 9 reuses it. Do not advance the frozen global city clock to make one animation work.
- [ ] **5. Run GREEN and commit slice.** Repeat the targeted browser test. Reject flat boxes, invisible limbs, flipped axes or wrong scale before asset expansion. Commit `feat: validate authored vehicle and pedestrian asset slice` with script, source, local slice assets used by tests and baseline metadata; evidence PNGs belong in test artifacts, not the runtime bundle.

## Task 4: Citywide metre roads and deterministic building detail

**Files:** Create `web/core/detail.ts`, `web/scene/DetailLayer.ts`, `tests/unit/detail.test.ts`; modify `pipeline/build.ts`, `web/scene/materials.ts`, `web/scene/CityScene.ts`, `tests/unit/build.test.ts`, `tests/e2e/enhancements-visual.spec.ts`.

**Interfaces:** Consumes `BuildingFeature`, source widths/tags and existing tile selection. Produces:

```ts
export type FacadeKind = 'residential' | 'office' | 'commercial' | 'industrial';
export function facadeKind(building: BuildingProperties): FacadeKind;
export function accessoryFootprints(feature: BuildingFeature): {
  origin: XY; roofs: Polygon2[]; entrances: Polygon2[]; skipped: Diagnostic[];
};
export function detailVisible(previous: boolean, projectedMetres: number): boolean;
```

`accessoryFootprints` returns geometry in local metre coordinates and its WGS84 `origin`, derived from the feature. `DetailLayer(viewer: Viewer, onError: (message: string) => void)` provides `setRoads(collection: FeatureCollection): void`, `setTile(id: string, buildings: BuildingFeature[]): void`, `removeTile(id: string): void`, `update(settings: SceneSettings): void`, `waitUntilReady(): Promise<void>`, `destroy(): void`, `resourceCounts(): { primitives: number; models: number; cacheEntries: number }`. It never owns vehicle rules.

- [ ] **1. Write RED tests for source preservation and legal geometry.**

  ```ts
  import { facadeKind, detailVisible } from '../../web/core/detail';
  it('keeps detail stable through the hysteresis band', () => {
    expect(detailVisible(false, 0.7)).toBe(false);
    expect(detailVisible(true, 0.7)).toBe(true);
    expect(detailVisible(false, 0.9)).toBe(true);
    expect(detailVisible(true, 0.4)).toBe(false);
  });
  ```

  Here `projectedMetres` means projected screen pixels per world metre. Enter at ≥0.8, leave below 0.5. Add rectangle, concave L, courtyard hole, multipolygon and tiny footprint fixtures; check every generated accessory polygon is contained without filling holes, IDs/heights unchanged, and repeated calls produce identical results. For buildings with no legal accessory placement assert a diagnostic, not an exception-free empty success.
- [ ] **2. Run RED.** `npm test -- tests/unit/detail.test.ts tests/unit/build.test.ts`.
- [ ] **3. Preserve road source fields and build visual roads.** Extend surface properties in `pipeline/build.ts` with original width/lanes/access/layer/bridge/tunnel tags and explicit derived metre width plus basis. Increase the build hash's surface recipe marker so output is a new dataset ID; retain old outputs. Old frontend layer/name/kind behavior remains valid. Rebuild from existing validated raw cache, not a mandatory network fetch.

  In `DetailLayer`, use metre-based polygon ribbons/Cesium corridor geometry grouped by visible region. Whole source segments shared across tile edges have stable ownership; overlap bounds discover them, but a loaded-ID set prevents duplicate draws. Keep the existing far road overview; partition it by region so replacement near ribbons suppress only the corresponding overview lines after readiness. Restore lines when detail is unloaded or fails. Exclude unknown bridge/tunnel elevations from near enhancement with diagnostics; retain their old overview representation without implying routability.
- [ ] **4. Implement profiles, daytime frames and legal geometry.** Map known building kinds first; for unknown kinds choose deterministic profile from ID/height/area. Batch building instances into four profile appearances sharing material resources, preserving `GeometryInstance.id` selection metadata. Add profile uniforms to `buildingMaterial` with existing call-site defaults; add day pane/frame/floor masks in the current world-anchored shader and preserve `fwidth` filtering and existing glow settings.

  ```ts
  export function detailVisible(previous: boolean, pixelsPerMetre: number): boolean {
    return previous ? pixelsPerMetre >= 0.5 : pixelsPerMetre >= 0.8;
  }
  ```

  Reuse Task 2 polygon validation for accessories. Choose equipment/entrance footprints via a bounded grid of interior candidates; accept only fully contained polygons clear of all holes/edges and other equipment. Boundary walls use safe inward segments; skip corners that cannot fit instead of approximating the whole roof with a box. Normal unsupported shapes generate counted provenance diagnostics; actual geometry/worker failures go to the existing error channel.
- [ ] **5. Wire tile lifecycle and verify.** `TileEntry` owns its profile primitives plus detail ownership; adapt `surfacesReady`, tile readiness checks, loading count, visibility, error cleanup and disposal for all primitives, not only the former single `primitive`. Keep max tile limits 4/8/14. `DetailLayer.removeTile` runs on every eviction and late-aborted loads never register resources. Ensure roads update even when building display is off. Run unit tests and `npm run build`, then `npm run test:e2e -- tests/e2e/clarity.spec.ts tests/e2e/enhancements-visual.spec.ts`. Capture day/night after evidence and inspect real added geometry, not only changed colors. Commit `feat: add citywide layered facades and metre roads`.

## Task 5: Complete authored assets and audited static placements

**Files:** Extend `assets/city/generate.py`, `assets/city/SOURCES.md`, `assets/city/city-assets.blend`, `pipeline/enhancements/build.ts`, `web/scene/DetailLayer.ts`, `tests/e2e/enhancements-visual.spec.ts`, `docs/city-enhancements.md`; generate final package resources.

**Interfaces:** Produces nine inventory kinds from `Asset`: two cars, bus, two persons, tree, lamp, entrance, roof-unit. Placements JSON contains `{ asset: Asset['kind']; sourceIds: string[]; position: XY; heading: number; inferred: string[]; footprint: Polygon2 }[]`; parser verifies each asset reference and geometry. Road/curb/walkway ribbons are geometric primitives, not extra model kinds. Add `DetailLayer.loadDistrict(manifest: EnhancementManifest): Promise<void>` and `unloadDistrict(): void`; the former loads and validates manifest-referenced placements/assets, while the latter invalidates pending loads and destroys only district resources.

- [ ] **1. Write RED inventory and placement tests.** Require every kind exactly once in inventory; both people have `Walk`, every hash/byte count matches file contents, no GLB external URI, and bounds are plausible. Verify tree/lamp/entrance footprints do not intrude into validated active corridors, buildings except assigned entrance/roof host, or water. Do not populate vegetation by uniform random scattering.

  ```ts
  expect(new Set(manifest.assets.map((asset) => asset.kind))).toEqual(new Set([
    'car-a', 'car-b', 'bus', 'person-a', 'person-b',
    'tree', 'lamp', 'entrance', 'roof-unit',
  ]));
  expect(manifest.assets.filter((asset) => asset.kind.startsWith('person-'))
    .every((asset) => asset.animation === 'Walk')).toBe(true);
  ```
- [ ] **2. Run RED.** Target the inventory tests in `tests/unit/enhancements.test.ts` and the per-asset browser test.
- [ ] **3. Expand script with concrete dimensions and visual differences.** Car A 4.4×1.8×1.45 m sedan, car B 4.7×1.9×1.7 m taller wagon, bus 10×2.5×3.1 m; pedestrians 1.65–1.8 m tall with two clothing/hair appearances. Use these bounds to regenerate route `allowed` lists; exclude buses where clearances/radius are insufficient. Include visibly shaped trunks/canopies, pole/luminaire assemblies, a framed glazed entrance and vented rooftop units. Keep materials shared within each GLB and use low-resolution embedded textures only if necessary.

  ```python
  bpy.context.scene.unit_settings.system = 'METRIC'
  bpy.context.scene.unit_settings.scale_length = 1.0
  bpy.ops.wm.save_as_mainfile(filepath=str(source_path))
  bpy.ops.export_scene.gltf(
      filepath=str(output_path), export_format='GLB',
      use_selection=True, export_animations=True, export_yup=True,
  )
  ```

  The script selects exactly one asset hierarchy for each export and clears selection between exports. Keep polygon counts in the inventory to identify oversized meshes. Create grouped regional static assets where duplication cost dominates, retaining per-model provenance.
- [ ] **4. Publish and integrate static placements.** Use the rebuilt base dataset ID from Task 4; rebuild candidate with exact exported envelopes, add placement/road/provenance files, then run `npm run data:enhancements:build -- --publish`. Loader references only manifest-relative immutable paths. `DetailLayer` loads district static groups only when coverage/LOD/settings allow them, shares resources, and destroys obsolete groups.
  Update the browser harness to resolve assets through that final manifest. Remove only the known provisional slice GLBs/inventory after no tests reference them; do not ship duplicate slice copies or remove unrelated enhancement packages.
- [ ] **5. Run GREEN and commit.** Assert all kinds in actual Cesium, valid walking cycles and correct cardinal heading. Measure complete new published resource bytes before compression; exclude only `.blend` from 30 MB target, not network/road/JSON files. Fix excess meshes/duplication and regenerate before claiming budget success. Commit `feat: ship authored Jinji Lake district assets`.

## Task 6: Deterministic fixed-step simulation and collision-free following

**Files:** Create `web/core/mobility.ts`, `tests/unit/mobility.test.ts`; extend `tests/fixtures/enhancements.ts`.

**Interfaces:** Consumes `Network`, `Asset[]`, `MobilityOptions`. Produces:

```ts
export class Mobility {
  constructor(network: Network, assets: readonly Asset[], options: MobilityOptions);
  advance(elapsedSeconds: number): number; // returns executed fixed steps
  pause(value: boolean): void;
  setPopulation(vehicles: number, pedestrians: number): void;
  seedActors(actors: readonly Actor[]): void; // validates geometry/spacing; used by deterministic scenarios
  snapshot(): MobilitySnapshot;
}
export const populationLimits = {
  low: { vehicles: 24, pedestrians: 40 },
  medium: { vehicles: 60, pedestrians: 100 },
  high: { vehicles: 100, pedestrians: 160 },
} as const;
```

`seedActors` rejects unsafe initial states; it is not a collision-check bypass. Snapshot is detached/read-only data, never live mutable simulation internals.

- [ ] **1. Write RED time and same-lane tests.** Fixtures provide a 200 m straight driving corridor and a disjoint 200 m walking corridor with terminal exits, no obstacles, exact vehicle/person dimensions, source entry/exit IDs. Define `straightNetwork()` and `testAssets()` in `tests/fixtures/enhancements.ts`.

  ```ts
  import { Mobility } from '../../web/core/mobility';
  it('caps catch-up and clears paused debt', () => {
    const sim = new Mobility(straightNetwork(), testAssets(),
      { seed: 7, vehicles: 0, pedestrians: 0, arrivals: false });
    expect(sim.advance(10)).toBe(5);
    expect(sim.snapshot().time).toBeCloseTo(0.25);
    sim.pause(true);
    expect(sim.advance(60)).toBe(0);
    sim.pause(false);
    expect(sim.advance(0.05)).toBe(1);
    expect(sim.snapshot().time).toBeCloseTo(0.30);
  });
  ```

  Add seeded replay equality, frame chunk equivalence within uncapped elapsed time, nonfinite/negative elapsed rejection, mixed-length following, suddenly stopped front car, unsafe spawn rejection, no mid-route teleport and separated pedestrian following.
- [ ] **2. Run RED.** `npm test -- tests/unit/mobility.test.ts`.
- [ ] **3. Implement bounded stepping and deterministic actors.**

  ```ts
  const STEP = 0.05;
  this.accumulator = Math.min(this.accumulator + elapsedSeconds, 5 * STEP);
  let steps = 0;
  while (this.accumulator + 1e-9 >= STEP && steps < 5) {
    this.step(STEP);
    this.accumulator = Math.max(0, this.accumulator - STEP);
    steps++;
  }
  return steps;
  ```

  `advance` validates input before the block, returns zero while paused; `pause` clears accumulator on either transition. `step(dt: number): void` is the class's private fixed-step updater. Use a seeded uint32 PRNG (no `Math.random`, clock time or unordered iteration); sort tie-breaks by stable actor ID. Use cumulative metre arc lengths for all positions/headings and transition through `Route.edges`, carrying overshoot only through an allowed edge.

  For each same-path leader compute rear-to-front gap, not centre distance. Stop-line/leader travel limit:

  ```ts
  const free = Math.max(0, leader.distance - leader.length / 2
    - actor.distance - actor.length / 2 - minimumGap);
  const safeSpeed = Math.min(speedLimit, Math.sqrt(2 * brake * free), free / dt);
  ```

  Compute proposals from the same previous snapshot and validate the next occupied intervals before committing; project leaders across edge boundaries into route distance. Use initial values minimumGap 2 m, brake 4 m/s² for vehicles; 0.5 m and 2 m/s² for pedestrians, plus speed-dependent desired headway. Never allow negative progress; a stopped leader must be recoverable when it moves again. Cross-path conflicts arrive in Task 7.
- [ ] **4. Implement safe generation and exits.** Choose allowed routes/kinds from seeded stable lists; require full spawn body within entry corridor and unoccupied following distance. Spread generation times; reject occupied attempts and retry later without counting them as active. Remove actors only beyond route exits outside central view; do not delete queued actors to mask congestion. Reducing a population cap removes excess models/state deterministically, releases any reservations and records layer-driven removal distinctly from passage.
- [ ] **5. Run GREEN and commit.** `npm test -- tests/unit/mobility.test.ts && npm run build`. Commit `feat: add deterministic mobility stepping and following`.

## Task 7: Fair junction reservations and pedestrian crossings

**Files:** Extend `web/core/mobility.ts`, `tests/unit/mobility.test.ts`, `tests/fixtures/enhancements.ts`.

**Interfaces:** Consumes edge conflict extents/zone membership. Uses existing `snapshot().owners` and `passedByEntry` to expose measured outcomes. Reservations and waiting timestamps are private; no public alternate simulation mode.

- [ ] **1. Write RED junction/crossing tests.** Add `junctionNetwork()` fixture with four driving approaches, explicit turn edges, clear exits and one shared zone; `crossingNetwork()` with two walking approaches sharing a vehicle conflict zone. `waitingVehicles()` returns four valid stationary actors one per junction approach.

  ```ts
  it('serves every waiting approach within thirty simulated seconds', () => {
    const sim = new Mobility(junctionNetwork(), testAssets(),
      { seed: 11, vehicles: 4, pedestrians: 0, arrivals: false });
    sim.seedActors(waitingVehicles());
    for (let i = 0; i < 600; i++) sim.advance(0.05);
    const passed = sim.snapshot().passedByEntry;
    for (const entry of ['north', 'east', 'south', 'west']) {
      expect(passed[entry]).toBeGreaterThanOrEqual(1);
    }
  });
  ```

  Also cover simultaneous requests, blocked exit, long bus rear still inside zone, continuous arrivals, a pedestrian arriving while car cannot safely brake, car yielding then resuming, pedestrian stops/spacing/neutral pose, removal of a zone owner and actors waiting for multiple zones.
- [ ] **2. Run RED.** `npm test -- tests/unit/mobility.test.ts`.
- [ ] **3. Implement conflict reservations.** A request is eligible only with a safe stopping approach, enough downstream room for the full body plus gap, and all required zones free. Keep queue ticket `(arrivalStep, actorId)` stable while waiting. Acquire all zones for a movement atomically; never hold one while waiting for another. Re-evaluate blocked-exit requests without destroying their queue age. Release only after rear distance exceeds zone exit. Use explicit front/rear coordinates on transitions, including actors spanning two edges.

  ```ts
  const requests = [...this.requests.values()].sort((a, b) =>
    a.arrivalStep - b.arrivalStep || a.actorId - b.actorId);
  for (const request of requests) {
    if (request.zones.every((zone) => !this.owners.has(zone))
      && this.exitHasSpace(request)) this.grant(request);
  }
  ```

  Define private `requests: Map<number, { actorId: number; arrivalStep: number; zones: string[] }>`, `owners: Map<string, number>`, `exitHasSpace(request): boolean`, and `grant(request): void` inside `Mobility`; each looks up the actor's already validated next movement. Granted exit capacity is reserved for the owner until its body occupies it, so two grants cannot both claim the same downstream gap.
- [ ] **4. Integrate pedestrian mutual exclusion.** Treat crossing entry as another ticket using the same zones, not a second independent pedestrian flag. A pedestrian cannot receive a ticket grant that requires an approaching vehicle to exceed permitted deceleration; vehicles already committed clear first. Hold related traffic until complete body/crossing clearance. Increment `walkPhase` by actual travelled metres divided by stride length (1.2 m), wrap modulo one; stopped actors use phase zero. Bound waiting occupancy by legal segment spacing.
- [ ] **5. Run GREEN and commit.** `npm test -- tests/unit/mobility.test.ts && npm run build`. Every stop test must also assert later movement/pass count when the blocker is removed; safety assertions alone do not suffice. Commit `feat: coordinate fair junction and crossing reservations`.

## Task 8: Published-network safety, sustained activity and deterministic replay

**Files:** Create `tests/unit/mobility-soak.test.ts`; extend `pipeline/enhancements/geometry.ts`, `docs/city-enhancements.md`.

**Interfaces:** Consumes final manifest/network/assets and `Mobility.snapshot()`. Produces `auditSnapshot(network: Network, snapshot: MobilitySnapshot): Diagnostic[]` in geometry module, independently checking full actor polygons, zone ownership and corridor/obstacle intersection. Test runner maintains prior snapshots to detect unexplained teleport and excessive stationary time.

- [ ] **1. Write RED production-data soak.** Load JSON from `public/enhancements/manifest.json` and its immutable paths using strict parsers; use seed `20261015`, medium counts and arrivals. Warm simulation for 60 seconds, then run 600 seconds at 0.05 s:

  ```ts
  let minimumCars = Infinity, minimumPeople = Infinity;
  for (let tick = 0; tick < 12_000; tick++) {
    sim.advance(0.05);
    const snapshot = sim.snapshot();
    expect(auditSnapshot(network, snapshot)).toEqual([]);
    const cars = snapshot.actors.filter((a) => !a.kind.startsWith('person-'));
    const people = snapshot.actors.filter((a) => a.kind.startsWith('person-'));
    minimumCars = Math.min(minimumCars, cars.length);
    minimumPeople = Math.min(minimumPeople, people.length);
  }
  expect(minimumCars).toBeGreaterThanOrEqual(20);
  expect(minimumPeople).toBeGreaterThanOrEqual(30);
  ```

  Additionally compare rolling 10-second travelled-distance sums (cars ≥20 m, people ≥5 m), per-route passage, successful stop/resume, ownership release and maximum unexplained stationary duration 30 s with clear route/exit. Track moving and waiting counts separately; spawned-but-never-moving actors do not count toward successful activity. Independently check pairwise full body overlap including turns and adjacent edges.
- [ ] **2. Run RED and diagnose real constraints.** `npm test -- tests/unit/mobility-soak.test.ts` with an explicit 120-second test timeout; keep simulation time independent of wall time. Report first failing tick, seed, actor IDs, source route IDs and envelope coordinates. Inspect a stalled command instead of merely increasing timeouts.
- [ ] **3. Fix production behavior/data, not the acceptance floor.** Repair legal route geometry, exit capacity, queue scheduling or spacing responsible for failures. If an entry is blocked by a source mismatch, recompile and republish validated data, retaining previous content. Do not relax assertions, hide actors or remove valid conflicts. If sustained populations cannot fit the audited area, revisit selection within approved Jinji Lake bounds and repeat Tasks 2/5 data gates.
- [ ] **4. Run GREEN and commit.** Run soak plus all mobility/topology tests; replay same seed and compare sampled snapshots byte-for-byte. Record real counts, distance totals, crossings and exclusion diagnostics. Commit `test: verify public district mobility safety and activity`.

## Task 9: Lifecycle-owned Cesium models, animation and fixed-step frame loop

**Files:** Create `web/scene/MobilityLayer.ts`; extend `web/scene/CityScene.ts`, `tests/fixtures/mobility.ts`, `tests/e2e/enhancements.spec.ts`.

**Interfaces:** `MobilityLayer(viewer: Viewer, onError: (message: string) => void)` consumes immutable manifest/network/assets and `Mobility`. Methods:

```ts
load(manifest: EnhancementManifest, network: Network): Promise<void>;
configure(options: {
  vehicles: boolean; pedestrians: boolean; paused: boolean;
  roads: boolean; inDistrict: boolean; quality: 'low' | 'medium' | 'high';
}): void;
freeze(): () => void; // nested-safe; returned release function is idempotent
waitUntilReady(): Promise<void>;
snapshot(): MobilitySnapshot;
resourceCounts(): { models: number; frameLoops: number; pendingLoads: number; cacheEntries: number };
destroy(): void;
```

`CityScene` gains `mobilitySnapshot(): MobilitySnapshot | null`, `enhancementResources(): { models: number; frameLoops: number; pendingLoads: number; detailPrimitives: number; cacheEntries: number }` as read-only diagnostics for real integration tests. Both `MobilityLayer` and `CityScene` expose `mobilityMetrics(): { frame: number; frameMs: number; simulationMs: number } | null`, returning only the last measured frame, not a growing history. The harness collects each frame ID once. Count layer-owned template caches explicitly and compare citywide static cache counts to their preentry baseline rather than assuming a zero total Cesium cache.

- [ ] **1. Write RED real-loop tests.** Harness opens the actual final package, enters district, waits for GLBs, observes changed positions and limb poses. Pause and sample twice; all transforms/animation phases unchanged. Disable vehicles and assert no vehicle models; pedestrians can continue. Disable roads and assert all actors hidden and loop zero; re-enable respects independent switches.

  ```ts
  await page.evaluate(() => window.mobility.setPaused(true));
  const before = await page.evaluate(() => window.mobility.scene.mobilitySnapshot());
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.mobility.scene.mobilitySnapshot());
  expect(after).toEqual(before);
  ```

  `setPaused(value: boolean): void` is added to the harness and calls real layer configuration; it must not fake a snapshot or bypass the production state machine.
- [ ] **2. Run RED.** `npm run test:e2e -- tests/e2e/enhancements.spec.ts`.
- [ ] **3. Implement loading and animation pose.** Load each GLB URL once per reusable template/resource lifecycle and create bounded actor model instances only for actual actors. Use same URL/materials to permit Cesium sharing, inspect actual resources rather than assuming arbitrary `Model` instances share everything. Reject stale async completions using a generation counter and destroy a model resolving after generation change.

  ```ts
  const generation = this.generation;
  const model = await Model.fromGltfAsync({ url, modelMatrix, minimumPixelSize: 0 });
  if (this.disposed || generation !== this.generation) {
    model.destroy();
    return;
  }
  this.viewer.scene.primitives.add(model);
  ```

  Convert local XY via the district ENU frame; use one validated asset axis correction from Task 3. Model heading interpolates along the validated turn tangent, not a guessed constant. Bind animation to snapshot travel phase through the installed `animationTime` callback; set `activeAnimations.animateWhilePaused` when required by the frozen city clock. Request renders while waiting for readiness; set neutral phase for a stopped pedestrian.
- [ ] **4. Own a single bounded RAF and explicit state transitions.** Start only with loaded resources, an enabled nonzero population demand, roads on, document visible, in-district and no manual/screenshot pause. An initially empty simulation must still advance to its first scheduled arrival; do not gate startup on an already-existing actor. Stop when there is no motion, no pending arrival/reservation event and no resource work; do not leave an idle loop. On inactive transition cancel RAF and reset last-time/accumulator; on return use the first callback only as the time baseline. Exiting the area aborts loads, destroys actors and resets/rebuilds seeded state on reentry; it does not leave distant hidden models cached indefinitely. Derive coverage from the ground-view footprint and projected scale, with entry/exit hysteresis, not camera altitude alone.

  ```ts
  const elapsed = this.lastFrame === undefined ? 0 : (now - this.lastFrame) / 1000;
  this.lastFrame = now;
  this.sim.advance(elapsed);
  this.syncModels(this.sim.snapshot());
  this.viewer.scene.requestRender();
  ```

  Define private `syncModels(snapshot: MobilitySnapshot): void` and `lastFrame?: number`; collect simulation-only duration around `advance`, not model rendering. `freeze()` increments a hold counter, remembers no stale settings, and releases against current configuration so toggles during capture are respected. Listen/remove `visibilitychange`; destruction cancels RAF, invalidates generation, destroys models and removes listeners exactly once.
- [ ] **5. Run GREEN and commit.** Extend harness tests for visibility transitions, rapid enter/exit while loading, quality changes and ten region/home cycles. For every exit require `models=0`, `frameLoops=0`, `pendingLoads=0` after canceled requests settle; static city resources may remain but district counters and cache entries must return to baseline. Run build and commit `feat: render lifecycle-managed city mobility`.

## Task 10: v2 settings, honest loading states, controls and screenshot snapshots

**Files:** Modify `web/core/types.ts`, `web/core/settings.ts`, `web/App.tsx`, `web/styles.css`, `web/scene/CityScene.ts`, `tests/unit/settings.test.ts`, `tests/e2e/{city,enhancements}.spec.ts`, `docs/city-enhancements.md`.

**Interfaces:** Extend `SceneSettings` with `version: 2`, `details: boolean`, `vehicles: boolean`, `pedestrians: boolean`, `simulationPaused: boolean`. New `EnhancementState = 'unavailable' | 'loading' | 'ready' | 'error'`; `SceneStats` adds `enhancementState`, `enhancementMessage`, `vehicles`, `pedestrians`, `simulationState: 'outside' | 'paused' | 'running' | 'loading' | 'error'`. Initial values are unavailable/outside/zero, not ready. `CityScene.flyToDistrict(): void` uses the manifest showcase. `retry()` handles both failed tiles and enhancement requests without reloading the entire page.

- [ ] **1. Write RED migration/error tests.** Build a literal complete v1 settings fixture independent of `defaultSettings`. Verify every old field preserved, defaults added, v2 round-trip, malformed v1 field rejection, missing new v2 field rejection and unknown version rejection:

  ```ts
  const v1 = {
    version: 1, night: false, glow: 0.25, quality: 'low',
    buildings: false, roads: false, water: true, green: true,
    boundary: false, labels: false,
  };
  expect(parseSettings(JSON.stringify(v1))).toEqual({
    ...v1, version: 2, details: true, vehicles: true,
    pedestrians: true, simulationPaused: false,
  });
  ```

  Browser tests cover legacy storage, saved v2 preference, corrupt v2 with valid v1 (must report corruption rather than silently choose v1), missing enhancement manifest, mismatched base ID, invalid path/network, failed GLB and retry.
- [ ] **2. Run RED.** `npm test -- tests/unit/settings.test.ts`; run targeted enhancement browser tests.
- [ ] **3. Implement strict migration/persistence.** Use new `SETTINGS_KEY = 'suzhou-city-lab.settings.v2'`, export `LEGACY_SETTINGS_KEY = 'suzhou-city-lab.settings.v1'`. App first reads v2, otherwise legacy. `parseSettings` validates all shared fields before migrating; only version 1 fills new defaults. Do not delete legacy until a successful explicit save; new saves use v2. Keep original import size limit, notification and error behavior.

  ```ts
  const text = localStorage.getItem(SETTINGS_KEY)
    ?? localStorage.getItem(LEGACY_SETTINGS_KEY);
  if (text !== null) saved = parseSettings(text);
  ```

- [ ] **4. Integrate honest UI/state.** Add Chinese switches `街区细节`, `模拟车辆`, `模拟行人`, button `暂停模拟`/`继续模拟`, and `金鸡湖动态街区` locator without replacing existing places. Show current counts, outside/loading/paused state, `模拟交通，非实时数据` and inferred-details disclosure. In the data tab show snapshot, source IDs/provenance and exclusions.

  Base `initialize` succeeds independently, but enhancement `error`/`unavailable` cannot result in unqualified `场景就绪`; show `基础城市可用 · 增强内容不可用` or explicit loading/error. Preserve an enhancement error separately from unrelated toast/base tile errors. Fetch manifest through a controlled request: 404 means unavailable; other HTTP/schema/model failures mean error with retry. Controls remain usable for base browsing. Keep a finite readiness timeout and reject missing resources; never resolve screenshot while a requested visible layer has failed.
- [ ] **5. Freeze captures and restore reliably.** Wrap all geometry/model readiness and `toBlob` completion in the same async try/finally:

  ```ts
  const release = this.mobility?.freeze();
  try {
    this.updateTiles();
    await this.waitForGeometry(true);
    await this.details?.waitUntilReady();
    await this.mobility?.waitUntilReady();
    this.viewer.render();
    return await new Promise<Blob>((resolve, reject) => {
      this.viewer.canvas.toBlob((blob) =>
        blob ? resolve(blob) : reject(new Error('截图生成失败。')), 'image/png');
    });
  } finally {
    release?.();
  }
  ```

  `details` and `mobility` are the private layer references added to `CityScene`; disabled/unrequested layers are excluded from readiness waits. Preserve manual pause across success and failure, nested screenshot holds and settings changes during capture. Browser failure tests make `toBlob` return null and block a needed model, then assert simulation resumes only when it was previously running.
- [ ] **6. Run GREEN and commit.** `npm test -- tests/unit/settings.test.ts && npm run build`; run city and enhancement E2E. Update existing old-package fixture expectations explicitly rather than supplying fake enhancements to make old tests green. Commit `feat: expose district controls and migrate scene settings`.

## Task 11: Offline, visual and existing-behavior acceptance

**Files:** Extend `tests/e2e/{enhancements,enhancements-visual,city}.spec.ts`, `tests/fixtures/mobility.ts`, `docs/city-enhancements.md`, `README.md`.

**Interfaces:** Uses production UI plus typed harness for asset pose/count diagnostics. No new production feature APIs.

- [ ] **1. Add RED offline and full regression coverage.**

  ```ts
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin !== 'http://127.0.0.1:5173') await route.abort();
    else await route.continue();
  });
  ```

  With that policy load final package, enter showcase, observe real motion/animation, toggle day/night, pause/resume and download a PNG. Assert zero attempted external runtime fetches as well as completion. Include failed geometry/model retries, legacy package compatibility, building selection and provenance, layer dependencies, hide/show and screenshot state recovery.
- [ ] **2. Run targeted RED, repair only integration defects.** Existing control tests remain authoritative: upward orbit toward horizon, rightward positive heading, middle/Ctrl-left/Ctrl-right bindings, pan and zoom unchanged. Do not change camera signs or replace screenshots with stub images to satisfy model tests.
- [ ] **3. Record visual evidence.** Use the same Task 3 cameras/resolution/dataset context for midrange city and district day/night pairs; add car/bus front-side views, two people walking/stopped, crossing yield and resume. Use real browser GLBs and record which asset/hash appears in each capture. Accept only visible pane frames, rooftop/entrance geometry, correctly scaled recognizable vehicles and articulated people. A pixel-difference count cannot replace this visual review.
- [ ] **4. Run GREEN and document.** `npm test && npm run build && npm run test:e2e`. README links to the approved spec, plan and `docs/city-enhancements.md`; document preparation commands, offline default, exact new setting defaults/caps, data error recovery, synthetic detail disclaimer and no whole-city traffic claim. Commit `test: cover offline city enhancements and visual behavior`.

## Task 12: Hardware performance, resource budget and delivery gate

**Files:** Create `playwright.performance.config.ts`, `tests/performance/mobility.spec.ts`; extend `tests/fixtures/mobility.ts`, `package.json`, `docs/city-enhancements.md`.

**Interfaces:** Harness adds `measure(durationMs: number): Promise<{ frameMs: number[]; simulationMs: number[]; minimumVehicles: number; minimumPedestrians: number; movingVehicles: number[]; movingPedestrians: number[]; renderer: string; userAgent: string }>` and `runCameraPath(): Promise<void>`. Scene diagnostics measure actual RAF frame intervals and real `Mobility.advance` CPU time separately. Measurements are opt-in and bounded, not unbounded production history arrays.

- [ ] **1. Write RED acceptance assertions.** Add `"test:performance": "playwright test --config playwright.performance.config.ts"`. New config uses headed Chromium, viewport 1600×900, DPR1, one worker, existing local web server pattern, **no** `--use-angle=swiftshader` argument and no permission/security bypass flags.

  ```ts
  function p95(values: number[]): number {
    if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
      throw new Error('Missing or invalid performance samples');
    }
    return [...values].sort((a, b) => a-b)[Math.ceil(values.length * 0.95)-1];
  }
  const result = await page.evaluate(async () => {
    const [measurement] = await Promise.all([
      window.mobility.measure(60_000), window.mobility.runCameraPath(),
    ]);
    return measurement;
  });
  expect(result.renderer).not.toMatch(/swiftshader|llvmpipe|software/i);
  expect(result.minimumVehicles).toBeGreaterThanOrEqual(20);
  expect(result.minimumPedestrians).toBeGreaterThanOrEqual(30);
  expect(p95(result.frameMs)).toBeLessThanOrEqual(33.3);
  expect(p95(result.simulationMs)).toBeLessThanOrEqual(4);
  ```

  Missing/hidden GPU identity is inconclusive, not hardware pass; inspect browser GPU diagnostics and record actual device when extension reporting is unavailable. Require at least 1000 frame samples over ≥60 seconds and advancing simulation snapshots, so a stopped/request-render-only scene cannot pass on a tiny sample.
- [ ] **2. Warm and measure real operation.** Load all showcase resources, simulate 60 seconds warmup at medium, then measure ≥60 seconds. Freeze a camera path in selection metadata: district oblique → junction closer → crossing → district oblique, 15 seconds each, remaining within district detail coverage. Record actual path coordinates/heading/pitch/range from the audited area; do not use different camera paths for comparison. Record browser version, GPU, canvas/backing dimensions, counts/movement and p95 values in result JSON and docs.
- [ ] **3. Iterate on measured bottlenecks.** If frame time fails, inspect model draw/material counts, overdraw and static batching; if simulation time fails, index leaders by edge and conflicts by zone rather than repeated all-actor scans. Keep deterministic order and re-run safety tests after algorithm changes. Reduce asset complexity/repeated static instances before decreasing counts; counts must never drop below the acceptance floor. If hardware acceleration cannot be obtained, report the exact environment blocker and leave this task open.
- [ ] **4. Verify final lifecycle and bytes.** Run ten real enter/exit cycles and assert counters return to district-unloaded baseline, no late models/load promises and no growing cache. Sum every new published runtime file before compression, including JSON/GLBs/textures and applicable added base-road data; use 30,000,000 bytes as the conservative 30 MB ceiling. Do not count only gzip transfer size or exclude duplicated packages shipped to users. Keep historical base data only as required for rollback; distinguish on-disk development history from the published bundle.
- [ ] **5. Commit evidence and hand off only measured outcomes.** Run targeted affected suites after final optimizations, then final build. Save test result JSON/screenshots/trace to test artifacts, with compact numerical outcomes and environment in `docs/city-enhancements.md`. Commit `test: record city mobility performance and delivery evidence`. Final handoff states actual delivered scope and any remaining blocked gate; no push unless requested.

## Requirement-to-task release checklist

| Spec requirement | Implemented / measured by |
|---|---|
| Whole-city static improvements, not a district-only replacement | Task 4 and Task 11 midrange views |
| Audited 0.5–1 km² district, source IDs, junction, crossing, lake paths | Tasks 1–2 selection and topology gate |
| Provenance, restrictions, no invented sidewalks/elevations, old version retained | Tasks 1–2 parsers/diagnostics/atomic tests |
| Full curve/body containment; real capacity and legal bus routes | Tasks 2, 5, 8 |
| Slice before asset expansion; editable local Blender source | Tasks 3, 5 |
| Two cars, bus, two animated people, trees/lamps/building details | Tasks 3, 5, 11 runtime evidence |
| Deterministic .05 s/max5 stepping, following, all pause cases | Tasks 6, 9, 10 |
| Fair reservations, blocked exits, rear-body release, crossings | Tasks 7–8 |
| 30-second four-approach fairness, 600-second safety and liveness | Tasks 7–8 |
| Local models, shared/static batching, no unnecessary render loop | Tasks 4–5, 9, 12 |
| v2 migration, independent toggles, dependent roads, honest states/retry | Task 10 |
| Frozen resource-ready screenshot restored even on error | Tasks 10–11 |
| Offline final resources and old camera/config/error regressions | Task 11 |
| 20/30 sustained activity, 60-second hardware p95, 30 MB, ten cycles | Tasks 8, 12 |

**Stopping rule:** A task marked complete has its stated evidence, not merely its files. Data/asset/geometry failures block dependent work. A working visual demo with unmeasured hardware performance remains an incomplete release; document that plainly instead of silently weakening the design.
