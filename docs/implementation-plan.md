# Suzhou City Lab Implementation Plan

> Execution: implement tasks in dependency order with test-first development.

**Goal:** 在本目录交付可本地运行、真实数据驱动的苏州市三维工作台。

**Architecture:** 离线 TypeScript 管线生成全市 GeoJSON 分块和元数据；
React 工作台通过 CesiumJS 按视口加载数据，所有渲染依赖随应用本地部署。

**Tech Stack:** TypeScript, React, Vite, CesiumJS, osmtogeojson, Vitest, Playwright.

**Spec:** `docs/design.md`

## Global Constraints

- 使用整个苏州市 OSM 行政边界，WGS84 坐标。
- 不伪造建筑轮廓、路网或数据完整性。
- 高度估算可追溯；远景抽稀必须明确提示。
- 缓存失败或上游部分响应不得覆盖可用数据版本。
- 本地资源、localhost 服务；无云令牌依赖。

## Task 1: Geographic rules and data normalization

Files: `web/core/geo.ts`, `web/core/types.ts`, `pipeline/normalize.ts`,
`tests/unit/geo.test.ts`, `tests/unit/pipeline.test.ts`.

Consumes: OSM GeoJSON and WGS84 Polygon/MultiPolygon.
Produces: normalized BuildingFeature[], height provenance, tile indices.

- [x] Write tests with hand-checked rings, heights, tile bounds and source IDs.
- [x] Run `npm test` and observe the missing implementation failures.
- [x] Implement `deriveHeight`, `insideBoundary`, `validateRing`, `tileId`,
  `tileBounds`, `selectTiles`, `normalizeBuildings`, `validateOverpass`.
- [x] Run `npm test` to verify real outputs and invalid-input failures.

## Task 2: Reproducible full-city data

Files: `pipeline/fetch.ts`, `pipeline/build.ts`, `public/data/manifest.json`,
`public/data/<version>/`.

Consumes: complete Overpass responses in `data/raw/`.
Produces: versioned boundary, surface, building tiles, dataset manifest.

- [x] Reject HTTP errors and Overpass remark responses.
- [x] Validate cached responses before reuse; only publish complete JSON.
- [x] Normalize data, retain holes, deduplicate IDs, partition buildings once.
- [x] Write assets under a new version directory, then atomically publish manifest.
- [x] Execute `npm run data:build`; inspect counts, skipped records and tile totals.

## Task 3: Scene configuration

Files: `web/core/settings.ts`, `tests/unit/settings.test.ts`.

Consumes: untrusted saved/imported JSON.
Produces: validated versioned SceneSettings.

- [x] Add round-trip and invalid-value tests; run them before implementing.
- [x] Validate every public setting and reject unknown versions.
- [x] Use the same encoder/parser for storage and file import.
- [x] Run `npm test`.

## Task 4: Offline 3D workbench

Files: `web/scene/CityScene.ts`, `web/scene/materials.ts`, `web/App.tsx`,
`web/styles.css`, `web/main.tsx`, `tests/e2e/city.spec.ts`, `playwright.config.ts`.

Consumes: manifest, GeoJSON assets and SceneSettings.
Produces: navigable city, selection details, scene controls and export.

- [x] Add browser tests for startup, day/night, configuration, screenshots,
  layer controls, source disclosures and errors.
- [x] Configure Cesium without hosted terrain, imagery, geocoder or sky resources.
- [x] Build batched geometry and bounded, cancellable per-view tile loading.
- [x] Render the workbench, responsive controls, errors, provenance and exports.
- [x] Run `npm run build` and `npm run test:e2e`.

## Task 5: Delivery

Files: `README.md`, `docs/data.md`.

- [x] Verify all local assets and production preview with HTTP requests.
- [x] Record actual downloaded data counts and known limitations.
- [x] Review the implementation for correctness and address concrete findings.
- [x] Leave a responsive local development server and report its address.

Initial development started without a Git repository. Publication targets the `main`
branch of `hydavinci/city-lab`; generated caches, dependencies and build outputs remain untracked.
