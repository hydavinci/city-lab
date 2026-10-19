# Authored district assets (Task 5)

All nine models are original procedural geometry from `generate.py`, with editable
`city-assets.blend`. No downloaded models, textures, images, fonts or external
resources are used. Embedded glTF PBR colours are shared within each model.

## Rebuild and publish

Run an independent background Blender process, never an open interactive file:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python assets/city/generate.py -- --output data/enhancements/staging/assets
npm run data:enhancements:build
npm run data:enhancements:build -- --publish
npm run test:e2e -- tests/e2e/enhancements-visual.spec.ts
```

The generator exports one selected hierarchy at a time, clears selection between
exports, and writes `assets.json` with hashes, byte counts, source polygon counts,
neutral bounds and diagnostic sampled bounds. The publisher independently reads
actual exported geometry and animation bytes; sampled bounds are not its proof.
No command above downloads geographic data.

| Kind | Dimensions, length × width × height (m) | Appearance |
|---|---|---|
| car-a | 4.4 × 1.8 × 1.45 | Blue sedan, tapered cabin, tires/hubs, front/rear lights |
| car-b | 4.7 × 1.9 × 1.7 | Copper taller wagon, extended cabin and roof rails |
| bus | 10 × 2.5 × 3.1 | Cream/green bus, repeated windows, doors and wheels |
| person-a | Certified envelope 1.12 × 0.601 × 1.8 | Blue clothing, dark hair, articulated limbs |
| person-b | Certified envelope 1.12 × 0.601 × 1.8 | Different clothing/hair and body proportions |
| tree | 1.179 × 1.327 × 3.549 | Tapered trunk, root flares, branches and clustered three-tone foliage |
| lamp | 1.021 × 0.301 × 4.001 | Tapered pole, base bolts, braced arm, service hatch and three LED modules |
| entrance | 0.401 × 1.821 × 2.201 | Threshold, transom, double glazing, door handles, kickplates and canopy |
| roof-unit | 2.021 × 1.445 × 1.117 | Raised feet, louvres, twin fan blades/grilles, cabinet panels and service pipes |

Exact declared sizes and immutable bytes are authoritative in
`public/enhancements/manifest.json`. Static placements are inferred illustrative
details tied to source ways/building IDs, not surveyed street furniture.
Static dimensions above round the root-centred published envelopes upward to
millimetres. The production city automatically loads these four static kinds;
cars, the bus and people remain inspection assets, not simulated traffic.

## Continuous Walk certification

Both people export a one-second `Walk`, 240 fps / 241 keys, with opposing local-X
limb rotations and root-height translations. A 2 mm sole lift accommodates the
continuous interpolation enclosure. This stylized gait is not foot-locked IK.

The validator accepts only closed, normalized, short-arc local-X quaternion and
translation LINEAR tracks. Each union-of-key-times interval is enclosed using
analytic sine/cosine extrema, including interior extrema, then transformed through
the complete hierarchy. Vertex positions, static matrices/scales and translations
are included. Unsupported interpolation, scale animation, skins, morphs, external
resources, extensions, malformed accessors and animation targets are rejected.

Certified glTF XYZ bounds for person-a:
`[-0.299999997, 0.000461703, -0.442156836]` to
`[0.300000004, 1.768641386, 0.541206012]`.
Person-b has the same horizontal envelope and maximum height `1.778641377`.
Both fit the root-centred **1.12 × 0.601 m** route envelope. Routes and placements
were recompiled against base `c8a953228b2ff6af`, not merely relabelled.
Exported triangle counts and certification results are in package provenance.

## Cesium axis convention and evidence

Blender units are metres, Z-up, forward -Y. Export produces glTF Y-up, forward +Z.
The installed Cesium default conversion maps glTF `(x,y,z)` to local `(z,x,y)`.
Use `ENU(origin) × Translation(east,north,height) × Rz(π/2 − heading)`, with heading
clockwise from north. **Do not repeat Cesium's built-in conversion.**

Browser tests load all nine actual GLBs at scale 1 without minimum-pixel-size
boosts, wait for rendered readiness, inspect every POSITION vertex under live
node transforms, verify cardinal headings and capture pixels. Both Walk clips
change live limb matrices/pixels and return to stable neutral poses independently
of the frozen city clock. The private observer is version-pinned to Cesium.

Task 3 baseline metadata/screenshots remain unchanged. Its provisional two-GLB
slice was removed after the harness migrated to the immutable manifest. Evidence
is in ignored `artifacts/task-5` and Playwright output, never the runtime bundle.
This package does not implement moving actors, population scheduling or prove
hardware frame-rate targets; those remain later tasks.
