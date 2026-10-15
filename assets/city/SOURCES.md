# Authored asset slice (Task 3)

These two models are original procedural geometry authored for this project in
`generate.py`, with an editable `city-assets.blend`. No downloaded models, images,
textures, fonts, or external resources are used. Materials are embedded glTF PBR
colours. The source and binaries are a **test-only slice**, not the final nine-asset
package and not an enhancement manifest.

## Rebuild without touching an open Blender file

From the repository root, using the verified local Blender 5.2.2 LTS:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python assets/city/generate.py -- --slice --output public/enhancements/slice
npm run test:e2e -- tests/e2e/enhancements-visual.spec.ts
```

The script requires `--slice` and an explicit output directory; arguments follow
Blender's `--`. It refuses an interactive Blender process. It saves only its own
source file and exports each selected hierarchy separately. `inventory.json`
records byte counts, SHA-256, version, neutral vertex bounds and sampled animated
bounds. Rebuilding does not publish an enhancement manifest or start a download.

## Geometry and animation

- Units are metres. Blender uses Z-up and actor forward **-Y**. Mesh scale and
  rotation are applied; object translations and limb pivot transforms remain
  meaningful. Normals are outward, and thin window panels have real thickness.
- Car: **4.4 × 1.8 × 1.45 m** (length × width × height), footprint-centred root at
  ground. Bevelled body, tapered cabin, six dark window panels, four tires with
  alloy hubs, distinct warm front/red rear lights, grille and handles.
- Person: **1.75 m** neutral height, root on the ground between the feet. Torso,
  head/face, shoulders, pivoted arms/legs, knees, hands and shoes are geometry, not
  a billboard. Neutral footprint is about **0.325 × 0.600 m**.
- One `Walk` clip, **1.000 s**, 24 fps, frames 1–25 exported at times 0–1.
  Legs alternate ±0.45 rad; arms oppose them at 70% amplitude. Phase 0 is neutral,
  phases 0.25/0.75 are opposing strides, phase 1 closes the cycle. Root height is
  sampled each frame to keep the lowest sole at ground. This is a stylized walk,
  not a foot-locked inverse-kinematics gait.

## Actual Cesium axis result

Export uses glTF Y-up. Blender `(x,y,z)` becomes glTF `(x,z,-y)`, so actor forward
is **glTF +Z**. The installed Cesium **1.146.0** default model conversion was
observed on both real rendered models; it maps glTF `(x,y,z)` to local `(z,x,y)`.
Its column-major 4×4 matrix is:

```text
C = [0,1,0,0,  0,0,1,0,  1,0,0,0,  0,0,0,1]
```

Use the **same** additional model rotation for both assets:

```text
modelMatrix = ENU(origin) × Translation(east,north,height) × Rz(π/2 − heading)
heading = clockwise radians from north
effective glTF→ENU rotation = Rz(π/2 − heading) × C
```

Cesium already applies `C`: do **not** multiply it into `modelMatrix` again. At
heading zero, the combined rotation maps glTF +Z to north and +Y to up. Browser
tests measured front-minus-back vectors at headings 0, π/2, π, 3π/2 as north,
east, south, west respectively, and inspected the corresponding visible nose,
lights and face. The test-only observer reads the actual scene-graph conversion
and live named-node matrices, transforming every exported POSITION vertex; it
does not substitute an alternate renderer. That private observation is pinned to
the installed Cesium version and fails explicitly if its shape changes.

## Measured bounds and publication blocker

At north heading, real Cesium neutral ENU dimensions:

| Model | East / width | North / length | Up / height | Bounding-sphere radius |
|---|---:|---:|---:|---:|
| car-a | 1.800000 | 4.400000 | 1.450000 | 2.485080 |
| person-a | 0.600000 | 0.325000 | 1.750000 | 0.939165 |

The 25 browser Walk samples, including live root and limb transformations, have
ENU union bounds relative to the ground root:

```text
min = [-0.300000005, -0.442156832, -0.000000072]
max = [ 0.299999997,  0.541206006,  1.766251033]
```

Minimum ground height across samples is within 0.000000073 m of zero. This is
sampled evidence, **not a continuous-time bound proof**. The animated footprint
has length **0.983363 m**, asymmetrically placed around the root; a root-centred
rectangle covering these samples alone needs length at least **1.082413 m**.
Therefore the current Task 2 **0.6 × 0.6 m pedestrian envelope does not contain
this Walk motion**. Neutral dimensions cannot certify dynamic route safety.
Task 5 must validate continuous animation bounds and either reduce the gait or
recompile/revalidate routes with a sufficient envelope before publication.
The parser/compiler's existing animation rejection is deliberately unchanged.

## Browser evidence and limitations

`tests/fixtures/mobility-baseline.json` preserves the original dataset ID,
selection camera, actual camera vectors, 1600×900/DPR1/medium settings, candidate
origin, 3 m driving / 2 m walking width snapshot, and original PNG checksums.
Before actors are explicitly **absent in the original base**. The fixture uses
those widths for inspection guide lines, not as evidence of route safety.

The browser harness loads `Model.fromGltfAsync` at scale 1, with no minimum-pixel
size boost, waits for actual rendered readiness with bounded errors, and attaches
`Walk` only after readiness. It requests model animation phases independently of
the frozen city time `2026-06-21T04:00:00Z`. Real pixels must contain each actor;
front/rear lamp colours must be visible; Walk pixels and limb matrices must change;
the stopped pose's actor-pixel mask and matrices must remain stable after a delay.
The test-only close-up camera floor is 0.1 m; the production 100 m floor is untouched.

PNG attachments and runtime measurements live in ignored Playwright output
directories (`artifacts/task-3-*`), never in the public bundle. The two GLBs total
483,520 bytes before inventory. This slice verifies visual scale and animation,
not a district simulation, collision safety, final asset budget, or hardware
performance target.
