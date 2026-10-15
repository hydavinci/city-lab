# Task 2 report — validated district mobility routes

**Status: DONE_WITH_CONCERNS** — static feasibility and publication gate implemented.
No assets authored, runtime simulation started, renderer changed, or real public enhancement package published.

## Scope and implementation

- Added `pipeline/enhancements/geometry.ts`: browser-safe projection, inverse projection,
  continuous translation/rotation envelopes with 1 mm body inflation, exact polygon-union
  coverage by arrangement slabs, holes/concavity/intersection/containment obstacle checks.
- Added `pipeline/enhancements/routes.ts`: strict source-faithful selection parsing, separate
  driving/walking graphs, clipped right-offset lanes, shared-node level-compatible connections,
  sampled turns with ≤0.25 m chords, actor-specific radius/body checks, physical conflict
  zones, entry-to-exit routing, safe off-centre endpoints and deduplicated storage capacity.
- Added `pipeline/enhancements/build.ts`: candidate mode, base-obstacle loading and evidence,
  complete-package validation, asset byte/hash/actual GLB geometry checks, placement geometry,
  content-addressed immutable packages and manifest-last atomic publication.
- Exported the existing `validateSource` rather than copying the source validator.
- Added the build script, synthetic route/crossing/publication fixtures and regression tests;
  updated `docs/city-enhancements.md` and the audited selection.
- Existing base data, shared manifest version, renderer and runtime remain unchanged.

## Real candidate and source adjustment

Candidate: ignored `data/enhancements/staging/candidate.json`.
Base dataset: `dbbaf1f81d32fc39`.
Bounds: `[120.674,31.312,120.684,31.320]`, unchanged **0.845042 km²**.
Road snapshot: `2026-10-15T03:50:21Z`; base building/water snapshot:
`2026-05-31T22:37:44Z`. These are not a synchronized geographic snapshot.
Loaded obstacle inventory: **123 building polygons / 5 water polygons**.
Source inventory: **10 drive ways + 14 walk ways + 117 excluded ways = 141 ways**.

The original northbound endpoint was 162.95 m from the showcase target, inside the
165 m exclusion radius. The selected source subsequence now follows the existing
same-street `way/834477631`, from shared `node/4199012338` to `node/7789692195`.
This is cached source geometry, not invented roadway. No bbox, width, clearance,
turning-radius or population threshold was relaxed. The through-only approach on
`way/935142613` cannot silently switch to 苏惠路 through the untagged connector.

### Every selected route and actor class

| Route | Source ways, in traversal order | Actors | Edges | Length m | Storage slots |
|---|---|---|---:|---:|---:|
| route/0 | 539348179 → 935142611 → 935142610 | car-a, car-b | 37 | 506.046 | 17 |
| route/1 | 935142613 → 935142615 → 935142612 → 834477631 | car-a, car-b, bus | 29 | 380.736 | 9 |
| route/2 | 935142617 → 935142629 → 935142619 → 935142620 → 935142621 | person-a, person-b | 21 | 122.247 | 76 |
| route/3 | 838960246 | person-a, person-b | 29 | 517.946 | 407 |

All numeric source-way IDs above have the `way/` prefix. The complete graph has
**242 validated edges**; many graph alternatives are intentionally not active routes.

| Route | Entry edge | Exit edge |
|---|---|---|
| route/0 | `drive/way/539348179/5219141097-5219141096` | `drive/way/935142610/5085989483-8619162845` |
| route/1 | `drive/way/935142613/8619162847-5085989488` | `drive/way/834477631/5219141131-7789692195` |
| route/2 | `walk/way/935142617/8665853163-8665853140` | `walk/way/935142621/8665853143-8665853144` |
| route/3 | `walk/way/838960246/4683166972-4683166971` | `walk/way/838960246/4683166960-4683166959` |

Local east/north entry → exit positions (metres from network origin):

- route/0: `[-286.211,183.500] → [-340.799,-318.131]`
- route/1: `[-295.682,-191.265] → [-260.638,186.282]`
- route/2: `[-281.556,-135.049] → [-327.723,-69.116]`
- route/3: `[100.503,82.617] → [178.298,-409.249]`

Entry and exit bodies are validated; each endpoint is outside the 165 m central
exclusion. Walk routes use one direction per source component; the lake and junction
remain disconnected. No blind loop or teleport joins their ends.

### Junctions and crossing conflict IDs

The main divided junction uses source nodes `4227521260`, `4227521259`,
`5211745753`, `5211745754`. Source crossing evidence:

| Crossing chain | Walking source ways | Road crossing nodes |
|---|---|---|
| West, 苏惠路 | 935142622 → 935142623 → 935142624 | 8665853148, 8665853147 |
| North, 星港街 | 935142620 → 935142619 → 935142629 | 8665853150, 8665853152 |
| South, 星港街 | 935142625 → 935142626 → 935142627 → 935142628 | 8665853149, 8665853151 |

All six nodes carry source crossing tags and belong to both their road and walking
sources; all three chains have source-connected walking sides. The selected walking
route uses the north chain in reverse traversal order.

| Shared physical zone | Affected graph edges | Source nodes represented by affected turn edges |
|---|---:|---|
| zone/0 | 9 | 8619162840, 8665853150 |
| zone/1 | 63 | 8665853150, 4227521260, 4227521259, 8665853149, 4680127369, 8665853147, 8665853148, 8665853145, 8665853146, 8665853160, 8665853159, 8665853157, 8665853158, 8665853161 |
| zone/2 | 9 | 8665853152, 8619162848 |
| zone/3 | 17 | 5085989488, 8665853151, 5211745753, 5211745754 |

Every zone includes drive and walk movements. Zone polygons come from overlapping
full-body sweeps, not centreline intersections; overlapping physical zones merge.
Each affected edge references the same zone ID with conservative entry/exit distances.
The candidate contains the complete edge-ID inventory and polygons.

### Exclusions and static feasibility

Selection exclusions: 25 unsupported vertical ways, 3 areas, 3 restriction-affected
ways, 2 motor-vehicle-prohibited ways and 84 other unselected ways. Exact IDs remain
in `selection.excludedWays` and candidate provenance.

Compilation excludes four full-body/radius-ineligible turns:

- `539348179 → 466930064` at node `4227521260`, radius 3.078 m.
- `893261890 → 935142611` at node `4227521259`, radius 3.626 m.
- `893261890 → 935142615` at node `5211745753`, radius 4.283 m.
- `466930064 → 935142611` at node `4227521260`, radius 4.374 m.

Two discovered route/actor attempts to continue `935142613 → 935142615 → 466930064`
are rejected by the through-only street-continuity rule.

Safe storage totals **26 vehicles and 483 pedestrians**, exceeding **20 / 30**.
The count uses 12 m vehicle / 1.2 m pedestrian spacing, full-width physical storage
boxes, global duplicate/overlap removal, no turn/conflict-zone storage and endpoint
margins applied once per continuous route. It is not a claim that 483 people or
26 vehicles have run simultaneously, nor a measured arrival/service rate.

## Validation evidence

Commands executed on October 15, 2026:

- `npm test -- tests/unit/enhancements.test.ts`: **161 passed**.
- `TMPDIR="$PWD/data/enhancements/staging/test-tmp" npm test`: **178 passed / 5 files**.
- First production build caught a fixture-only TypeScript error assigning a new
  `foot` property to an inferred narrow tag type. Replaced it with `Object.assign`;
  its focused regression then passed and `npm run build` passed **TypeScript + Vite**.
- `npm run data:enhancements:build`: real candidate succeeds, 242 edges / 4 routes /
  4 zones / static capacity 26 vehicles and 483 pedestrians.
- Real `npm run data:enhancements:build -- --publish`: intentionally **exit 1** for
  missing `assets/assets.json`; the public enhancement manifest remained absent.
- `git diff --check` and `git diff --cached --check`: clean.
  `git status --short -- public/data`: no changes. Owned test scratch files removed.

RED→GREEN coverage includes topology versus mere XY crossings, shared crossing
permissions and disconnected chains, 1 mm clearance, concavity and holes, corridor
union containment, intermediate sweep collisions, narrow paths and bus turns,
oneway/reverse-oneway, invalid units/access, via-node and unsupported via-way
restrictions, only-right directional correctness, delayed through-only lane evasion,
unsupported directional lane tags, node/way mode permissions, and storage continuity.

Publication tests create a complete synthetic package, republish identical immutable
bytes, then reject missing/corrupt/oversized GLBs, invalid/missing/obstructing placements
and modified/empty immutable-directory collisions. Each failure compares old manifest
and package bytes. These tiny test GLBs are synthetic in-memory fixtures, not district assets.

## Concerns and handoff boundaries

1. **Static feasibility only.** Task 8 must prove sustained 20 vehicles / 30 people,
   conflict reservation, following distances, no deadlock/crowding, camera acceptance
   and performance. Endpoint distance is not a rendered occlusion guarantee.
2. Runtime must respect the compiled polyline pose-envelope contract. Car/bus bounds
   are 4.4×1.8 / 4.7×1.9 / 10×2.5 m; people 0.6×0.6 m. Additional smoothing, larger
   models or different motion require revalidation.
3. Width defaults and unsupported restrictions are explicit conservative assumptions,
   not surveyed lane geometry. Unsupported directional lane tags, conditional access,
   destination-only access and elevated geometry fail closed; generic road sidewalk
   tags are not enough to invent walking geometry.
4. **GLB publication currently rejects animation, skins, morph targets and extensions.**
   A later asset/runtime task must add and test dynamic bounds support before publishing
   these features. Current publication verifies actual transformed static vertex bounds,
   not just trusted descriptor sizes.
5. Building/water data are older than roads. Current claims apply to the recorded
   input snapshots, not real-world safety or current physical conditions.

No public package or static placement inventory was generated. No push, worktree,
subagent, Task 3 implementation or `progress.md` modification is part of this task.
