# Citywide Vehicle and Pedestrian Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow the user's execution choice; do not infer permission for a multi-agent workflow.

**Goal:** Deliver visible, rule-based vehicles and walking people in the real city homepage, backed by an audited citywide offline road network and bounded nearby simulation.

**Architecture:** Prepare immutable road-network chunks with verified geometry, explicit source coverage and cross-chunk ports. A renderer-independent fixed-step world manages nearby actors and shared conflict reservations; a Cesium layer owns loading, surfaces, models, animation and lifecycle. Integrate controls and frozen screenshot capture without rebuilding city architecture.

**Tech Stack:** Existing TypeScript, Node.js, Cesium, React, Vitest, Playwright and authored GLB assets. No new runtime engine or simulation service.

**Spec:** `docs/superpowers/specs/2026-10-21-citywide-mobility-design.md`

**Execution status (2026-10-21):** Tasks 1–4 implemented on `feat/citywide-mobility`.
The actual municipality intersects 2,232 acquisition cells. Public-service probes timed out or
returned HTTP 406; no full-city sources or mobility release have been published. The user approved
continuing compiler, simulation and UI implementation while leaving publication/data acceptance incomplete.

## Global Constraints

- “全城”指采集、编译、覆盖清单和运行时分块机制覆盖当前苏州市边界。
- 日常浏览不请求外部地图服务。
- 不把未知人行道当作存在，不凭平面交叉虚构拓扑连接。
- 本功能不修改建筑生成器，也不要求全城建筑重建。
- 固定时间步 0.05 秒，每帧最多补算 5 步，长暂停不追赶累计时间。
- 车辆/行人活动窗口总上限：流畅 24/36，均衡 60/90，精细 120/180。
- 使用源模型尺度 1，不通过像素最小尺寸夸大对象。
- roads=false 同时隐藏并暂停依赖路面的活动。
- 跨块连接端点偏差不超过 0.05 m；该容差不放宽障碍净距。
- 模拟活动，非实时交通。
- Preserve existing building resources, source properties, navigation and user settings.
- Do not weaken existing route/body-envelope/animation checks to increase coverage.
- Never treat failed downloads, unsupported topology or missing data as a successful empty network.
- Commit source, tests and reproducible generation commands; keep bulk generated chunks and caches out of Git.
- Include normal session/co-author trailers on implementation commits.

## File and Interface Map

Keep the existing district package format and its tests working. The new citywide format wraps local `Network` values instead of accepting dangling cross-chunk edges inside `parseNetwork`.

| Files | Responsibility |
|---|---|
| `web/core/mobility.ts` | Citywide manifest/chunk contracts, strict parsing, budgets and shared snapshot types |
| `pipeline/mobility/fetch.ts` | Bounded city-boundary acquisition, resumable cache and source consistency |
| `pipeline/mobility/compile.ts` | Automatic source selection and validated local network/surfaces |
| `pipeline/mobility/stitch.ts` | Stable ownership, boundary ports, seam and conflict reconciliation |
| `pipeline/mobility/build.ts` | Audited immutable publication and coverage |
| `web/core/mobility-world.ts` | Actor lifecycle, fixed steps, routes, spawning and following |
| `web/core/mobility-conflicts.ts` | Shared conflict requests, fairness, entry and complete-body release |
| `web/scene/MobilityLayer.ts` | Chunk/asset lifecycle, road surfaces, model transforms and clock scheduling |
| `web/core/types.ts`, `web/core/settings.ts`, `web/App.tsx` | Settings v2, migration, controls and truthful status |
| `web/scene/CityScene.ts`, `web/scene/DetailLayer.ts` | Production lifecycle, readiness, road replacement and screenshot freeze |
| `pipeline/mobility/audit.ts` | Independent published-data audit and multi-area acceptance selection |
| `tests/fixtures/citywide-mobility.ts` | Synthetic data, deterministic world gates and adjacent chunk fixtures |
| `tests/fixtures/citywide-mobility-review.ts` | Test-only observation of the real homepage, never a production debug global |

The following new contracts are defined in Task 1 and remain authoritative:

```ts
interface MobilityResource { uri: string; bytes: number; sha256: string }
type CellStatus = 'ready' | 'empty' | 'excluded';
interface MobilityCell {
  id: string; bounds: Bounds; status: CellStatus;
  neighbours: string[]; resource?: MobilityResource;
  driveMetres: number; walkMetres: number; diagnosticCodes: string[];
}
interface MobilityCoverage {
  cells: number; ready: number; empty: number; excluded: number; failed: number;
  driveMetres: number; walkMetres: number;
}
interface MobilityManifest {
  version: 1; id: string; baseDataset: string; generatedAt: string; bounds: Bounds;
  assets: MobilityResource; cells: MobilityCell[]; coverage: MobilityCoverage;
}
interface MobilitySurface {
  id: string; sourceIds: string[]; mode: 'drive' | 'walk';
  points: XY[]; width: number; height: number; inferred: string[];
}
interface MobilityPort {
  id: string; edge: string; at: 'entry' | 'exit';
  coordinate: XY; heading: number; allowed: ActorKind[];
  links: { cell: string; port: string }[];
}
interface MobilityChunk {
  version: 1; id: string; bounds: Bounds; network: Network;
  ownedEdges: string[]; ports: MobilityPort[];
  zoneIds: Record<string, string>; surfaces: MobilitySurface[];
}
interface MobileActor extends Actor { cell: string }
interface WorldSnapshot extends MobilitySnapshot {
  actors: readonly MobileActor[];
}
interface SpawnGate {
  canSpawn(cell: string, position: XY, kind: ActorKind): boolean;
  canRetire(cell: string, position: XY, kind: ActorKind): boolean;
}
```

`Bounds` comes from `web/core/types.ts`; `Actor`, `ActorKind`, `MobilityOptions`,
`MobilitySnapshot`, `Network`, `Polygon2` and `XY` come from `web/core/enhancements.ts`.
Port coordinates are geographic WGS84; network and surface points use their chunk's local origin.
Resource URIs are safe same-origin paths fetched as `/${uri}`, not third-party URLs.
Runtime manifests cannot contain failed cells; acquisition/build reports may contain failures.
Asset references identify the existing enhancement manifest and verify its hash/bytes.

## Dependencies and Review Gates

Tasks 1–5 produce the audited offline network; Tasks 6–7 produce pure simulation.
Task 8 consumes both, Task 9 renders actors, Task 10 adds persisted controls, Task 11 integrates the homepage,
and Task 12 verifies actual production output. These are dependent parts of one delivery, not separate demos.
Commit each passing task; do not declare the overall feature complete before Task 12.

Before execution, load `using-git-worktrees` and establish an isolated workspace without deleting/recreating
the existing generated building package. Resolve ignored-resource availability explicitly.
Use the test-driven-development skill; verify every new regression fails for the intended missing behavior.
Use `apply_patch` for source edits and existing runners for validation.

### Task 1: Strict Citywide Contracts and Test Fixtures

**Files:** Create `web/core/mobility.ts`, `tests/fixtures/citywide-mobility.ts`,
`tests/unit/mobility-manifest.test.ts`.

**Consumes:** Existing `Network`, `parseNetwork`, `ActorKind`, `Bounds` and `tests/fixtures/enhancements.ts::network`.

**Produces:**
`parseMobilityManifest(value: unknown, baseDataset: string): MobilityManifest`,
`parseMobilityChunk(value: unknown, cell: MobilityCell): MobilityChunk`,
`mobilityBudget(quality: SceneSettings['quality']): { vehicles: number; pedestrians: number }`,
and `mobilityFixture(): { manifest: MobilityManifest; chunk: MobilityChunk }`.

- [x] Add a fixture wrapping a structured clone of the existing synthetic network. Declare synthetic provenance;
  use internally consistent cell bounds, resources and byte/hash values. Never use it as geographic evidence.
- [x] Add failing contract tests:

```ts
it('rejects failed publication coverage instead of hiding missing city cells', () => {
  const { manifest } = mobilityFixture();
  expect(() => parseMobilityManifest({
    ...manifest, coverage: { ...manifest.coverage, failed: 1 },
  }, manifest.baseDataset)).toThrow();
});
it('budgets the whole active window', () => {
  expect(mobilityBudget('medium')).toEqual({ vehicles: 60, pedestrians: 90 });
});
```

- [x] Run `npm test -- tests/unit/mobility-manifest.test.ts`; observe missing-contract failures.
- [x] Implement the interfaces above and strict parsers. Check finite ordered geographic bounds, IDs,
  matching base dataset, valid timestamps, safe URIs, positive sizes, SHA-256 shape, unique cells,
  referenced neighbours/ports, exact coverage sums, ready/resource equivalence, no failed publication,
  and nonnegative lengths. Parse the embedded network using `parseNetwork`; require every owned edge,
  local port edge and local zone alias to exist, and surface coordinates/width/height to be valid.
  Ready cells must have at least one usable route; empty/excluded cells are explicit inventory entries.
- [x] Test corrupted paths, dangling edges, duplicate ownership, malformed zones, future versions,
  tampered totals and legitimate empty/excluded cells.
- [x] Run `npm test -- tests/unit/mobility-manifest.test.ts tests/unit/enhancements.test.ts`
  and `npx tsc --noEmit`; commit `feat: define audited citywide mobility contracts`.

### Task 2: Resumable Public Road Acquisition

**Files:** Create `pipeline/mobility/fetch.ts`, `tests/unit/mobility-fetch.test.ts`;
modify `package.json`, `.gitignore`, `README.md`.

**Consumes:** `CityManifest`, boundary GeoJSON, existing `validateSource(unknown): void`,
Overpass source-node/relation handling in `pipeline/enhancements/fetch.ts`.

**Produces:**
`planCells(boundary: FeatureCollection, span?: number): { id: string; bounds: Bounds }[]`,
`fetchMobility(options: { baseDir: string; cacheDir: string; refresh: boolean }): Promise<void>`,
and persisted cache/progress under `data/raw/mobility/`.

- [x] Write tests intercepting public HTTP responses, not filesystem success:

```ts
it('does not reuse an incomplete highway response as a valid cache', async () => {
  const response = { ...overpass, remark: 'runtime error: Query timed out' };
  expect(() => validateSource(response)).toThrow();
});
```

  Add new tests around `fetchMobility` with temporary base/cache directories and existing `overpass`
  fixture: first response fails, retry succeeds, a second run uses the valid cache, and a different
  query/bounds/base identity causes revalidation. Assert partial replies never acquire completed status.
- [x] Run `npm test -- tests/unit/mobility-fetch.test.ts`; require failures in the new collector tests.
- [x] Implement a deterministic 0.02-degree acquisition grid intersecting the actual municipality polygon,
  not only its bounding rectangle. Include a bounded topology halo and full referenced way/node/restriction
  members. Fetch supported surface-road classes, independent walking ways and crossings; retain unhandled
  source elements for explicit diagnostics. Use one sequential request at a time, validated cache reuse,
  the existing 15/30-second backoff pattern and three attempts, with 300-second request timeout.
- [x] Validate complete responses before atomic cache writes. Record query, cell/halo, fetched time,
  OSM timestamp and source hashes. Deduplicate by source type/ID; reject coordinate, tag or membership
  disagreements. Write the exact failed cell and retained source error to progress; throw on unrecovered
  failure. Resuming must not restart valid completed requests.
- [x] Add `data:mobility:fetch` for `tsx pipeline/mobility/fetch.ts`. Ignore `public/mobility/`;
  existing `data/raw/` already excludes caches. Document public-service use and offline runtime behavior.
- [x] Run targeted tests and type-check; commit `feat: acquire resumable citywide road sources`.

### Task 3: Automatic Validated Local Network Compilation

**Files:** Create `pipeline/mobility/compile.ts`, `tests/unit/mobility-compile.test.ts`;
modify `pipeline/enhancements/routes.ts` only where shared geometry/compiler behavior is required.

**Consumes:** Validated source response, source IDs/tags, base building/water polygons,
existing `compileNetwork`, `sweptEnvelope`, `validateEnvelope`, `ACTORS` and continuous GLB envelopes.

**Produces:**
`compileCell(input: { id: string; bounds: Bounds; source: unknown; baseDataset: string;
buildings: Polygon2[]; water: Polygon2[]; placements: Polygon2[] }):
{ chunk?: MobilityChunk; status: CellStatus; diagnostics: Diagnostic[] }`.

- [x] Add deterministic compile tests using `routeFixture()` and `crossingFixture()` from existing fixtures:

```ts
it('compiles automatically without a hand-maintained district selection', () => {
  const { source, selection } = routeFixture();
  const input = {
    id: 'cell/0', bounds: selection.bounds, source,
    baseDataset: selection.baseDataset, buildings: [], water: [], placements: [],
  };
  const first = compileCell(input), second = compileCell(input);
  expect(first.status).toBe('ready');
  expect(first.chunk!.network.routes.length).toBeGreaterThan(0);
  expect(second).toEqual(first);
});
```

- [x] Run `npm test -- tests/unit/mobility-compile.test.ts`; observe missing compiler.
- [x] Build source-backed automatic selection for each bounded cell/halo: roads vs independent walk ways,
  shared-node connectivity, access/direction/turn restrictions, and crossing chains supported by source
  crossing nodes and connected side routes. Every retained/excluded way gets a reason; no handwritten
  per-district inventories.
- [x] Reuse existing body/turn verification and restriction behavior. Replace showcase-specific route
  endpoint policy with explicit cell ports for the citywide caller, preserving old district behavior
  and its golden tests. Use bounded route traversal rather than enumerating every citywide path.
  Build spatial candidate indexes before envelope/obstacle checks.
- [x] Emit source-ID-backed road/walk surfaces once per physical segment, with explicit width/elevation
  assumptions. Check complete vehicle/person envelopes against corridor, buildings, water and placements.
  Reject unknown water widths affecting candidate routes; do not ignore unbounded water lines.
- [x] Test no fake crossing for geometrically intersecting unshared nodes, one-way/restriction enforcement,
  bus exclusion on narrow turns, invalid widths, unsupported elevations, inaccessible roads, obstacle
  intrusion, walk-only cells, valid no-road cells, and incomplete input errors.
- [x] Run compiler and existing `enhancements.test.ts`; type-check and commit
  `feat: compile source-grounded mobility cells automatically`.

### Task 4: Stable Seam and Conflict Ownership

**Files:** Create `pipeline/mobility/stitch.ts`, `tests/unit/mobility-stitch.test.ts`;
extend `tests/fixtures/citywide-mobility.ts` with `twoChunkFixture()`.

**Consumes:** Complete compilation results with halos, local ports, local edge source IDs and conflict geometry.

**Produces:**
`stitchChunks(chunks: MobilityChunk[]): MobilityChunk[]`,
`twoChunkFixture(): { left: MobilityChunk; right: MobilityChunk }`.

- [x] Build a two-cell synthetic road crossing the boundary, plus a junction whose bodies overlap the halo.
  Use different local origins and a single physical seam, not two copied coordinate systems.
- [x] Write failing tests:

```ts
it('gives a shared physical conflict one canonical reservation identity', () => {
  const { left, right } = twoChunkFixture();
  const stitched = stitchChunks([left, right]);
  const aliases = stitched.flatMap(chunk => Object.values(chunk.zoneIds));
  expect(new Set(aliases).size).toBe(1);
});
```

- [x] Run the stitch tests red. Derive stable edge/port IDs from source segment, direction/lane and boundary
  position. Give each owned segment one cell using a deterministic geographic tie-break.
  Halo copies remain lookahead/validation data, not extra spawn locations.
- [x] Reconcile source-backed continuation ports by shared topology, compatible direction/permissions
  and geographic endpoints within 0.05 m. Never connect unrelated nearest lines.
  Assign shared junction geometry to one owner using sorted source identities; propagate aliases to
  every halo copy. Split boundaries away from a junction's complete conflict envelope where possible;
  otherwise preserve its single owner and lookahead.
- [x] Reject mismatched seams, asymmetric links, duplicate owners, incompatible modes and contradictory
  source geometry. Test byte-stable IDs under input reordering and zero actor duplication implications.
- [x] Run compiler/stitch tests, type-check; commit `feat: preserve mobility connectivity across cell seams`.

Implementation note: ownership uses whole source-segment midpoints and sourced junction nodes,
with a stable boundary tie-break. Clipped halo fragments have distinct geographic IDs and remain
lookahead/validation data, not extra owned spawn geometry (`CLIPPED_HALO_LOOKAHEAD` diagnostics).
Reconciled conflict polygons recompute complete-body intervals in every intersecting halo network.

### Task 5: Atomic Citywide Publication and Coverage

**Files:** Create `pipeline/mobility/build.ts`, `tests/unit/mobility-publication.test.ts`;
modify `package.json`, `README.md`.

**Consumes:** Complete acquisition inventory, `compileCell`, `stitchChunks`, base-data identity,
verified enhancement assets and existing building/water/static-placement obstacles.

**Produces:**
`buildMobility(options: { baseDir: string; cacheDir: string; outputDir: string;
onProgress?: (completed: number, total: number) => void }): Promise<MobilityManifest>`,
`public/mobility/manifest.json` and immutable hash-addressed payloads/coverage report.

- [ ] Add filesystem tests in a task-local temporary directory:

```ts
it('keeps the old manifest when one required source cell is missing', async () => {
  const before = await readFile(outputManifest, 'utf8');
  await expect(buildMobility(options)).rejects.toThrow();
  expect(await readFile(outputManifest, 'utf8')).toBe(before);
});
```

  Define `options`, `outputManifest`, complete synthetic cache and incomplete-cell variant in the test
  setup; use `publicationFixture()` for base and assets. Do not hide failures with successful empty files.
- [ ] Run red; implement per-cell resumable records bound to source, generator, obstacles, assets and
  base-manifest hashes. Read only needed base building tiles; spatially index water/placements.
  Rebuild invalidated cells, not unrelated building architecture.
- [ ] Compute coverage from actual outputs: every planned cell classified, source/usable road lengths,
  exclusion counts/codes, asset references and timestamps. Validate all chunk bytes/hash, ownership,
  links and accounting before an atomic manifest replacement. `coverage.failed` must be zero to publish.
- [ ] Test corruption recovery, source changes, stale base dataset, empty/excluded cells, incremental reuse,
  deterministic content IDs and interrupted writes. Reject publishing while required cells are failed.
- [ ] Add `data:mobility:build` for `tsx pipeline/mobility/build.ts`; document commands and resource layout.
- [ ] Run acquisition/compiler/publication tests and type-check; commit
  `feat: publish audited offline citywide mobility resources`.

### Task 6: Deterministic Actor Motion, Spawning and Following

**Files:** Create `web/core/mobility-world.ts`, `tests/unit/mobility-world.test.ts`;
extend test fixtures with `outsideGate: SpawnGate` allowing both operations.

**Consumes:** `MobilityChunk`, `MobilityOptions`, `ACTORS`, existing validated route paths.

**Produces:**
`class MobilityWorld` with `constructor(options: MobilityOptions)`,
`addChunk(chunk: MobilityChunk): void`, `removeChunk(id: string): void`,
`setOptions(options: MobilityOptions): void`, `step(gate: SpawnGate): void`,
`snapshot(): WorldSnapshot`, `nextWakeTime(): number | undefined`, and `clear(): void`.
One `step` means exactly 0.05 simulated seconds; wall-clock scheduling belongs to Task 9.
`nextWakeTime` returns the next required simulation-time decision/arrival, or undefined when no
time-driven work can progress; adding data or changing options independently wakes the layer.

- [ ] Write deterministic movement tests using real world output:

```ts
it('replays the same traffic from identical seeds and fixed steps', () => {
  const run = () => {
    const world = new MobilityWorld({ seed: 7, vehicles: 2, pedestrians: 2, arrivals: true });
    world.addChunk(mobilityFixture().chunk);
    for (let i = 0; i < 200; i++) world.step(outsideGate);
    return world.snapshot();
  };
  expect(run()).toEqual(run());
});
```

  Separately assert nonzero travelled distance; deterministically equal empty worlds do not satisfy motion.
- [ ] Run red. Implement seeded arrivals at valid entry positions only when body space and `canSpawn`
  permit them. Counts apply globally across chunks; paths/actor kinds must satisfy route permissions.
  Queue/reduce arrivals at capacity rather than inserting overlaps.
- [ ] Implement route-distance movement with segment heading and length accounting, acceleration/braking,
  full-body following and lookahead across route edges. Traverse only validated polyline segments.
  Update `walkPhase` from distance and nominal gait stride, not elapsed time while stopped.
- [ ] Handoff at linked ports without changing actor identity. Hold before unavailable continuation,
  with safe stopping distance; no teleporting, cloning or entering an unknown junction.
  Retire only at valid exits accepted by `canRetire`; retain snapshots/ownership while visible.
  Explicitly reject removing a cell still owning live visible actors; the layer must drain/retain it.
- [ ] Test speed bounds, following at merge/edge/seam, no-spawn gate, capacity, route termination,
  two origins, unavailable neighbour, no loops invented at endpoints, source-mode restrictions,
  snapshot isolation and zero resources after clear.
- [ ] Run pure world tests and type-check; commit `feat: simulate deterministic nearby vehicle and pedestrian movement`.

### Task 7: Shared Conflict Reservations and Fair Progress

**Files:** Create `web/core/mobility-conflicts.ts`, `tests/unit/mobility-conflicts.test.ts`;
modify `web/core/mobility-world.ts`.

**Consumes:** Canonical zone aliases, complete-body enter/exit intervals, actor route lookahead,
current queues, exit capacity and fixed simulation time.

**Produces:**
`class ConflictReservations` with
`request(actor: number, zones: readonly string[], time: number): void`,
`grant(available: (actor: number) => boolean): readonly number[]`,
`release(actor: number): void`, `owners(): Readonly<Record<string, number>>`, `clear(): void`.
Reservations are all-or-none for a route's immediately required overlapping zones.

- [ ] Add the fairness/atomicity counterexample:

```ts
it('does not split multi-zone ownership into circular wait', () => {
  const reservations = new ConflictReservations();
  reservations.request(1, ['a', 'b'], 0);
  reservations.request(2, ['b', 'a'], 0);
  expect(reservations.grant(() => true)).toEqual([1]);
  reservations.release(1);
  expect(reservations.grant(() => true)).toEqual([2]);
});
```

- [ ] Run red. Order requests by first eligible request time, then actor ID; acquire needed zones
  atomically after checking exit storage. Prevent later conflicting requests from starving an older
  eligible one, while allowing independent zones to progress.
- [ ] Integrate vehicle/person requests before their full-body leading edge can cross zone entry;
  retain all ownership until the trailing body edge has left. Use seam aliases, not per-chunk copies.
  Pedestrians and vehicles share the same reservation table.
- [ ] Test opposing vehicles, crossing people, tail-clearance release, blocked exits, cancellation,
  route changes, seam duplicates and eventual service in finite contention with available exits.
  Run a ten-minute synthetic simulation checking every snapshot for body overlap and shared ownership.
- [ ] Run world/conflict tests and type-check; commit `feat: coordinate fair vehicle and pedestrian junction access`.

### Task 8: Nearby Chunk Loading and Matching Road Surfaces

**Files:** Create `web/scene/MobilityLayer.ts`, `tests/unit/mobility-layer.test.ts`;
modify `web/scene/DetailLayer.ts`, `web/core/mobility.ts`.

**Consumes:** Verified manifest, `MobilityWorld`, current viewport/focus, quality budgets and road source IDs.

**Produces:**
`class MobilityLayer` with
`constructor(viewer: Viewer, onError: (message: string) => void,
onReplacedRoads: (ids: ReadonlySet<string>) => void)`,
`load(baseDataset: string): Promise<void>`,
`update(settings: SceneSettings): void`, `retry(): Promise<void>`, `destroy(): void`,
`ready`, `error`, `progress`, and `resources(): MobilityResources`.
Define the shared resources contract in `web/core/mobility.ts`:

```ts
interface MobilityResources {
  state: 'inactive' | 'loading' | 'ready' | 'no-coverage' | 'paused' | 'error';
  reason?: 'roads-hidden' | 'user' | 'page-hidden' | 'overview' | 'export';
  vehicles: number; pedestrians: number; cells: number; models: number;
  urls: number; pending: number; time: number; failure?: string;
}
```

`DetailLayer.setReplacedRoads(ids: ReadonlySet<string>): void` hides only source segments
whose mobility-owned surface is actually render-ready.

- [ ] Write lifecycle tests with deferred real-format JSON/GLB responses and Cesium test doubles:
  move to another area before fetch resolves, then assert the old result registers no cells/models.
  Do not assert only that `abort()` was called.
- [ ] Run red. Load and verify manifest/chunk resource size/hash with 15-second bounded requests.
  Select visible cells plus a prefetch neighbour ring; cap loaded cells initially at 9/16/25 by quality
  and pending requests at 4. These are loader limits in addition to global actor budgets.
  At far overview, deactivate fine simulation rather than selecting the entire municipality.
- [ ] Keep current visible owners and conflict lookahead pinned; evict offscreen unused cells first.
  If pinning fills the limit, stop new arrivals/loading and drain safely rather than exceeding memory
  bounds or deleting visible actors. Use camera changes/visibility tests, not only altitude.
- [ ] Batch corresponding road/walk surfaces, with matching declared height and one source-owned segment.
  Swap old road rendering only after replacement readiness; restore it on failure/unload.
  For split source ways, use segment-level IDs to avoid hiding an entire road for one loaded segment.
  Do not construct per-actor road primitives.
- [ ] Report explicit loading/ready/no-coverage/paused/error states, retain unrelated base city and
  provide retry. Abort pending work and invalidate generations on reload/destroy.
- [ ] Test no-data vs network error, hash mismatch, duplicate surfaces, readiness swaps, failed replacement,
  request limits, pinned cells, rapid camera movement and ten load/unload cycles without resource growth.
- [ ] Run layer tests and existing detail recovery tests; type-check and commit
  `feat: stream bounded mobility cells with source-aligned road surfaces`.

### Task 9: True-Scale Models, Gait and Bounded Render Scheduling

**Files:** Modify `web/scene/MobilityLayer.ts`; create
`tests/unit/mobility-clock.test.ts`, `tests/e2e/mobility-models.spec.ts`.

**Consumes:** Existing immutable enhancement asset manifest and GLBs, `WorldSnapshot`,
verified model axis convention in `assets/city/SOURCES.md`.

**Produces:** MobilityLayer renders actor transforms/animations, exposes
`freeze(): () => void` as an idempotent release lease, and includes model readiness in `ready`.

- [ ] Write failing fixed-clock tests: 1-second stall performs at most five steps, tab resume resets
  the baseline, explicit pause performs zero steps, and actors waiting for a future arrival still wake.
- [ ] Run red. Maintain one independent monotonic accumulator; clamp backlog to five 0.05-second steps
  and reset on pause/resume. Use bounded scheduled rendering while moving; remove idle work when paused
  or inactive, and use `world.nextWakeTime()` to schedule required arrival/decision wakes when everyone
  is stationary. New chunks/settings independently wake the layer; undefined means no timed wake.
  While future arrivals require simulation time, wake at most one fixed step apart without requesting
  unchanged render frames. Do not sleep several simulated seconds and then advance only one step,
  or fast-forward moving actors to make the clocks agree.
  Do not unfreeze or advance the city sun clock.
- [ ] Cache verified asset bytes/URLs by kind and generation; match existing download/hash/error
  patterns without swallowing failures. Instantiate only permitted nearby actors, scale 1,
  minimumPixelSize 0; use the existing ENU/heading conversion exactly once.
  Set height from the displayed surface, not the ground-zero assumption.
- [ ] Drive Walk from distance-derived phase; stop in a stable neutral pose without changing body
  envelope. Use per-model animation phase so two people need not march in lockstep. Do not introduce
  unsupported interpolations/skins or edit certified model scale.
- [ ] Implement freeze leases for nested screenshots/pauses without mutating persisted settings.
  Ensure late model completion destroys stale instances and never re-registers obsolete actors.
- [ ] Browser-test actual model orientation and vertex height at cardinal headings, visible movement
  over multiple frames, leg matrices changing while walking, stable stop pose, and unchanged solar time.
  Use real GLBs and real rendering rather than unit mocks as visual acceptance.
- [ ] Run clock/layer/world tests and `npx playwright test tests/e2e/mobility-models.spec.ts`;
  type-check and commit `feat: animate true-scale city actors with bounded simulation timing`.

### Task 10: Settings v2 and Truthful User Controls

**Files:** Modify `web/core/types.ts`, `web/core/settings.ts`, `web/App.tsx`, `web/styles.css`,
`tests/unit/settings.test.ts`; create `tests/e2e/mobility-controls.spec.ts`.

**Consumes:** Activity state/counts and budgets. Task 11 connects these values to the real scene.

**Produces:** SceneSettings v2 adds `vehicles: boolean`, `pedestrians: boolean`,
`mobilityPaused: boolean`. `parseSettings` migrates legitimate v1 input and rejects corrupt/future input;
`encodeSettings` writes v2. Add `mobility?: MobilityResources` to SceneStats for activity status;
initial/unconnected UI renders an explicit inactive state rather than assuming loaded actors.

- [ ] Write the migration regression with an explicit v1 object:

```ts
it('preserves saved v1 choices while adding documented mobility defaults', () => {
  const old = {
    version: 1, night: false, glow: 0, quality: 'low',
    buildings: false, roads: true, water: true, green: false, boundary: false, labels: true,
  };
  expect(parseSettings(JSON.stringify(old))).toEqual({
    ...old, version: 2, vehicles: true, pedestrians: true, mobilityPaused: false,
  });
});
```

- [ ] Run red. Extend the existing parser/version handling without accepting missing old fields,
  invalid booleans or unsupported versions. Keep lookup of the old localStorage key compatible so
  users' v1 choices are found; migrate on successful parse/save, not by discarding old data.
- [ ] Add accessible controls labelled “模拟车辆”, “模拟行人”, “暂停模拟”/“继续模拟”,
  counts and “模拟活动，非实时交通”. Distinguish loading, no coverage, roads disabled,
  manual pause and failed resources. Keep existing place navigation unchanged.
- [ ] Update directly dependent fixtures/settings literals to v2, retaining explicit v1 migration tests.
  Do not change exported geographic manifests or silently default malformed configuration.
- [ ] Run settings tests and controls browser test, type-check; commit
  `feat: add migratable vehicle and pedestrian simulation controls`.

### Task 11: Homepage Lifecycle, Freeze-Safe Export and Error Isolation

**Files:** Modify `web/scene/CityScene.ts`, `web/App.tsx`, `web/core/types.ts`;
create `tests/e2e/citywide-mobility.spec.ts`,
`tests/fixtures/citywide-mobility-review.ts`.

**Consumes:** Completed MobilityLayer, v2 controls and existing screenshot/readiness/error flow.

**Produces:** Real homepage activity, user-visible MobilityResources/status,
correct initialization/retry/settings/destruction and frozen screenshot output.

- [ ] Write a failing homepage test using published real cells: load `/`, navigate through existing
  controls to a verified area, wait for activity readiness and assert actor positions change between
  observations. A fixture may expose a test-only observer via injected module, not a production global.
- [ ] Integrate MobilityLayer beside city architecture/detail, with scoped errors and bounded
  initialization. Forward settings/camera changes; call destroy before Viewer destruction.
  Keep base city usable if mobility fails and show a dedicated retryable activity error.
- [ ] Add current activity progress to required-view readiness and idle timeout tracking; separate
  failure domains so a mobility retry does not clear building tiles or the static district package.
- [ ] Freeze screenshot snapshots before waiting, then always restore in `finally`, including
  failed `toBlob`, timeout, nested capture and user-paused cases:

```ts
const release = this.mobility.freeze();
try {
  this.updateTiles();
  await this.waitForGeometry(true);
  this.viewer.render();
  return await this.captureCanvas();
} finally {
  release();
}
```

  `captureCanvas(): Promise<Blob>` is a private extraction of the existing screenshot `toBlob` logic;
  it rejects disposed scene/null blob exactly as before. No placeholder implementation.
- [ ] Test page visibility, roads=false, separate actor toggles, export during motion,
  export failure, retry, movement across neighbouring chunks and rapid region switching.
  Assert base architecture remains visible and render errors remain explicit.
- [ ] Run new browser test, relevant roaming/settings/recovery tests and type-check; commit
  `feat: integrate citywide mobility into the production scene lifecycle`.

### Task 12: Actual Citywide Preparation, Independent Audit and Acceptance

**Files:** Create `pipeline/mobility/audit.ts`, `tests/unit/mobility-audit.test.ts`;
extend `tests/e2e/citywide-mobility.spec.ts`; modify
`package.json`, `README.md`, `docs/city-enhancements.md`.

**Consumes:** Completed source collector/publisher/runtime, real published bytes and coverage.

**Produces:**
`auditMobility(options: { baseDir: string; mobilityDir: string; outputDir: string }):
Promise<{ cells: number; driveMetres: number; walkMetres: number; areas: string[] }>`,
`data:mobility:audit` command, local `artifacts/citywide-mobility/` evidence and updated operations docs.

- [ ] Add failing audit tests that detect a missing cell, altered payload, duplicate edge owner,
  inconsistent seam, wrong asset envelope and a coverage report disagreeing with resources.
  Audit independently reloads bytes; it does not trust builder success flags.
- [ ] Run red. Implement inventory/hash/base/asset checks and decode chunk data to recheck edge/zone
  ownership, seam offsets, topology and source accounting. Select real acceptance areas from ready
  cells near three different existing navigation regions, at least two outside the old Jinji candidate.
  Record actual eligible locations; never substitute a relocated synthetic fixture.
- [ ] Run `npm run data:mobility:fetch`, inspect bounded acquisition progress and failures,
  then `npm run data:mobility:build` and `npm run data:mobility:audit`.
  Resume valid cache on service limits. If source completeness or required area coverage cannot be
  achieved, report a blocker instead of marking the delivery complete or silently shrinking to Jinji.
- [ ] Run a 12,000-step test on the real verified Jinji network with 20 cars/30 people and arrivals.
  Measure travelled distance by kind, completed entries/exits, per-request service and complete-body
  separation. Include finite-contention tests and low-capacity throttling, not only aggregate counts.
- [ ] Capture real homepage day/night footage or time-separated screenshots for each acceptance area,
  plus conflict waiting, seam handoff and stable stop gait. Record hardware/browser/viewport,
  frame time, cache/model counts and repeated travel resource behavior without hiding buildings.
- [ ] Run `npm test` and `npx tsc --noEmit`, then targeted Playwright suites for mobility, controls,
  roaming and screenshot/recovery. Do not infer movement from loaded asset counts.
- [ ] Verify a production build with actual runtime assets. Inspect available disk and active resource
  directories first: the current public tree contains historical multi-gigabyte architecture packages
  that Vite copies wholesale. Do not delete unrelated packages or change build safety checks.
  If full packaging is blocked by that pre-existing resource volume, report the constraint explicitly;
  retain verified runtime data and do not claim production packaging passed.
- [ ] Update docs with actual coverage and exclusions, generated package identity, reproducible commands,
  measured evidence and supported/not-supported behavior. Do not copy planned numbers as measured results.
- [ ] Commit `test: verify published citywide mobility and document operation`.

## Plan Self-Review and Completion Accounting

| Approved requirement | Tasks |
|---|---|
| Real citywide acquisition with resumable offline publication | 1–5, 12 |
| Source-backed roads, independent walking graph, obstacles and exclusions | 2–5 |
| Visible matching new roads and no duplicate surfaces | 3, 8, 11 |
| Stable seam geometry, actor ownership and shared conflicts | 4, 6–8, 11–12 |
| Following, fair junction service and pedestrian crossing | 6–7, 12 |
| No visible spawning/teleport loop, fixed timing and global budgets | 6, 8–9, 12 |
| Real GLBs, certified gait, matching ground height and render scheduling | 8–9, 12 |
| Settings migration, existing navigation, truthful coverage/status | 10–11 |
| Frozen export, page suspension, retry and zero-resource teardown | 8–9, 11–12 |
| Persistent code plus actually generated usable runtime data | 5, 11–12 |

No implementation commit may imply later tasks are finished. After each passing task, record changed
interfaces and actual validation in the session tracker; preserve the spec as the acceptance authority.
If a required geometry/data/performance constraint cannot be met, stop at that concrete gate and request
an explicit scope decision rather than turning a partial demonstration into a citywide completion claim.
