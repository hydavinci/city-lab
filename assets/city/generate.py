"""Author the two-asset inspection slice in an isolated Blender process."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slice", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def material(name, color, metallic=0.0, roughness=0.5, emission=0.0):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Emission Color"].default_value = (*color, 1)
    shader.inputs["Emission Strength"].default_value = emission
    return result


def empty(name, location=(0, 0, 0), parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.parent = parent
    return obj


def finish(obj, name, surface, parent, bevel=0):
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.data.materials.append(surface)
    if bevel:
        modifier = obj.modifiers.new("Soft manufactured edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.parent = parent
    return obj


def box(name, location, dimensions, surface, parent, bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.dimensions = dimensions
    return finish(obj, name, surface, parent, bevel)


def ellipsoid(name, location, dimensions, surface, parent):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.5, location=location)
    obj = bpy.context.object
    obj.scale = dimensions
    result = finish(obj, name, surface, parent)
    for polygon in result.data.polygons:
        polygon.use_smooth = True
    return result


def panel(name, vertices, surface, parent):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], [tuple(range(len(vertices)))])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(surface)
    obj.parent = parent
    # Thin surfaces are geometry on both faces, not negative-scale mirrored normals.
    modifier = obj.modifiers.new("Panel thickness", "SOLIDIFY")
    modifier.thickness = 0.006
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)
    return obj


def car():
    root = empty("car-a")
    paint = material("car / petrol blue paint", (0.035, 0.28, 0.4), 0.35, 0.3)
    glass = material("car / dark blue windows", (0.018, 0.037, 0.055), 0.15, 0.23)
    rubber = material("car / tire rubber", (0.018, 0.022, 0.027), roughness=0.88)
    alloy = material("car / brushed alloy", (0.4, 0.46, 0.5), 0.7, 0.3)
    headlamp = material("car / warm headlamps", (1.0, 0.88, 0.62), emission=0.5)
    taillamp = material("car / red tail lamps", (0.65, 0.016, 0.012), emission=0.3)
    box("car-body", (0, 0, 0.63), (1.72, 4.36, 0.62), paint, root, 0.16)
    box("lower-sill", (0, 0, 0.34), (1.7, 3.95, 0.18), rubber, root, 0.05)
    # Tapered cabin: narrower roof, sloping windscreen and rear screen.
    vertices = [
        (-0.77, -1.12, 0.85), (0.77, -1.12, 0.85), (0.77, 1.12, 0.85), (-0.77, 1.12, 0.85),
        (-0.65, -0.62, 1.45), (0.65, -0.62, 1.45), (0.65, 0.67, 1.45), (-0.65, 0.67, 1.45),
    ]
    mesh = bpy.data.meshes.new("tapered cabin")
    mesh.from_pydata(vertices, [], [(0, 3, 2, 1), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)])
    mesh.update()
    cabin = bpy.data.objects.new("car-cabin", mesh)
    bpy.context.collection.objects.link(cabin)
    bpy.context.view_layer.objects.active = cabin
    cabin.select_set(True)
    finish(cabin, "car-cabin", paint, root, 0.045)
    cabin.select_set(False)
    panel("windscreen", [(-0.66, -1.085, 0.91), (0.66, -1.085, 0.91), (0.57, -0.69, 1.385), (-0.57, -0.69, 1.385)], glass, root)
    panel("rear-window", [(0.66, 1.085, 0.91), (-0.66, 1.085, 0.91), (-0.57, 0.74, 1.385), (0.57, 0.74, 1.385)], glass, root)
    for side in [-1, 1]:
        for name, y0, y1, top0, top1 in [
            ("front", -1.015, -0.06, -0.61, -0.06), ("rear", 0.035, 1.015, 0.035, 0.66),
        ]:
            panel(f"{side}-{name}-window", [
                (side * 0.765, y0, 0.94), (side * 0.765, y1, 0.94),
                (side * 0.666, top1, 1.365), (side * 0.666, top0, 1.365),
            ], glass, root)
        for y in [-1.4, 1.4]:
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.32, depth=0.16,
                                              location=(side * 0.81, y, 0.32), rotation=(0, math.pi / 2, 0))
            finish(bpy.context.object, f"wheel-{side}-{y}", rubber, root, 0.035)
            bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.205, depth=0.015,
                                              location=(side * 0.8925, y, 0.32), rotation=(0, math.pi / 2, 0))
            finish(bpy.context.object, f"hub-{side}-{y}", alloy, root, 0.01)
        for y, surface, name in [(-2.185, headlamp, "headlamp"), (2.185, taillamp, "tail-lamp")]:
            box(f"{name}-{side}", (side * 0.57, y, 0.69), (0.39, 0.03, 0.16), surface, root, 0.025)
        box(f"door-handle-{side}", (side * 0.86, 0.15, 0.86), (0.015, 0.18, 0.035), alloy, root, 0.005)
    box("front-grille", (0, -2.19, 0.47), (0.75, 0.02, 0.13), rubber, root, 0.015)
    empty("car-a-front", (0, -2.2, 0.65), root)
    empty("car-a-back", (0, 2.2, 0.65), root)
    return root


def descendant_meshes(root):
    return [obj for obj in root.children_recursive if obj.type == "MESH"]


def bounds(root):
    bpy.context.view_layer.update()
    points = [obj.matrix_world @ vertex.co for obj in descendant_meshes(root) for vertex in obj.data.vertices]
    return {
        "min": [min(p[i] for p in points) for i in range(3)],
        "max": [max(p[i] for p in points) for i in range(3)],
    }


def person():
    root = empty("person-a")
    jacket = material("person / terracotta jacket", (0.65, 0.17, 0.055), roughness=0.85)
    shirt = material("person / ivory shirt", (0.8, 0.77, 0.64), roughness=0.9)
    pants = material("person / indigo trousers", (0.035, 0.08, 0.14), roughness=0.9)
    skin = material("person / skin", (0.52, 0.28, 0.15), roughness=0.85)
    hair = material("person / hair", (0.03, 0.018, 0.012), roughness=0.95)
    shoes = material("person / shoes", (0.025, 0.03, 0.035), roughness=0.8)
    box("pelvis", (0, 0, 0.87), (0.30, 0.22, 0.18), pants, root, 0.05)
    ellipsoid("torso", (0, 0, 1.18), (0.40, 0.26, 0.59), jacket, root)
    ellipsoid("shirt-front", (0, -0.10, 1.24), (0.11, 0.075, 0.33), shirt, root)
    ellipsoid("neck", (0, 0, 1.48), (0.125, 0.12, 0.14), skin, root)
    ellipsoid("head", (0, -0.008, 1.605), (0.235, 0.235, 0.27), skin, root)
    ellipsoid("hair", (0, 0.01, 1.69), (0.24, 0.235, 0.12), hair, root)
    ellipsoid("nose", (0, -0.126, 1.605), (0.045, 0.055, 0.055), skin, root)
    for x in [-0.045, 0.045]:
        ellipsoid(f"eye-{x}", (x, -0.118, 1.65), (0.018, 0.014, 0.018), hair, root)
    legs, arms = [], []
    for side, name in [(-1, "left"), (1, "right")]:
        leg = empty(f"{name}-leg", (side * 0.095, 0, 0.86), root)
        ellipsoid(f"{name}-thigh", (0, 0, -0.19), (0.16, 0.18, 0.43), pants, leg)
        ellipsoid(f"{name}-knee", (0, -0.01, -0.41), (0.14, 0.15, 0.15), pants, leg)
        ellipsoid(f"{name}-shin", (0, 0, -0.59), (0.125, 0.14, 0.37), pants, leg)
        box(f"{name}-shoe", (0, -0.055, -0.81), (0.155, 0.28, 0.10), shoes, leg, 0.025)
        arm = empty(f"{name}-arm", (side * 0.235, 0, 1.39), root)
        ellipsoid(f"{name}-shoulder", (side * 0.20, 0, 1.35), (0.20, 0.20, 0.22), jacket, root)
        ellipsoid(f"{name}-upper-arm", (0, 0, -0.13), (0.125, 0.135, 0.31), jacket, arm)
        ellipsoid(f"{name}-elbow", (0, -0.018, -0.285), (0.115, 0.12, 0.12), jacket, arm)
        ellipsoid(f"{name}-forearm", (0, -0.025, -0.39), (0.10, 0.115, 0.25), jacket, arm)
        ellipsoid(f"{name}-hand", (0, -0.035, -0.54), (0.09, 0.09, 0.14), skin, arm)
        legs.append(leg)
        arms.append(arm)
    empty("person-a-front", (0, -0.2, 1.2), root)
    empty("person-a-back", (0, 0.2, 1.2), root)
    for frame, angle in [(1, 0), (7, 0.45), (13, 0), (19, -0.45), (25, 0)]:
        for limb, rotation in zip(legs + arms, [angle, -angle, -angle * 0.7, angle * 0.7]):
            limb.rotation_euler.x = rotation
            limb.keyframe_insert(data_path="rotation_euler", frame=frame, group="Walk")
    # Linear curves make intermediate phase bounds predictable. Keep the lower sole
    # on the floor at each exported frame rather than pretending neutral bounds suffice.
    for obj in legs + arms:
        obj.animation_data.action.name = f"Walk-{obj.name}"
        for layer in obj.animation_data.action.layers:
            for strip in layer.strips:
                for channelbag in strip.channelbags:
                    for curve in channelbag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"
    for frame in range(1, 26):
        bpy.context.scene.frame_set(frame)
        root.location.z = 0
        root.location.z = -bounds(root)["min"][2]
        root.keyframe_insert(data_path="location", frame=frame, group="Walk")
    return root


def export(root, output, animated=False):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [root, *root.children_recursive]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.scene.frame_set(1)
    path = output / f"{root.name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_animations=animated,
        export_animation_mode="SCENE", export_nla_strips_merged_animation_name="Walk",
        export_anim_scene_split_object=False, export_anim_slide_to_zero=True,
        export_frame_range=True, export_frame_step=1, export_force_sampling=True,
        export_materials="EXPORT", export_cameras=False, export_lights=False,
    )
    data = path.read_bytes()
    sampled = []
    for frame in range(1, 26) if animated else [1]:
        bpy.context.scene.frame_set(frame)
        sampled.append(bounds(root))
    neutral = sampled[0]
    dynamic = {
        "min": [min(sample["min"][i] for sample in sampled) for i in range(3)],
        "max": [max(sample["max"][i] for sample in sampled) for i in range(3)],
    }
    return {
        "kind": root.name, "uri": path.name, "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "animation": "Walk" if animated else None,
        "blenderNeutralBoundsXYZ": neutral, "blenderSampledBoundsXYZ": dynamic,
        "boundsSampling": ("25 frames, 24 fps; not continuous-time publication validation"
                           if animated else "neutral pose, all mesh vertices"),
        "size": [neutral["max"][1] - neutral["min"][1], neutral["max"][0] - neutral["min"][0],
                 neutral["max"][2] - neutral["min"][2]],
    }


def main():
    args = arguments()
    if not bpy.app.background:
        raise RuntimeError("Run only in a standalone --background --factory-startup process")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.name = "Walk"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    scene.render.fps = 24
    scene.frame_start, scene.frame_end = 1, 25
    car_root, person_root = car(), person()
    inventory = [export(car_root, output), export(person_root, output, True)]
    (output / "inventory.json").write_text(json.dumps({
        "status": "test-only slice; not a publishable enhancement manifest",
        "generator": "assets/city/generate.py", "blender": bpy.app.version_string,
        "assets": inventory,
    }, indent=2) + "\n")
    scene.frame_set(1)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(__file__).resolve().parent / "city-assets.blend"))
    print(json.dumps(inventory, indent=2))


if __name__ == "__main__":
    main()
