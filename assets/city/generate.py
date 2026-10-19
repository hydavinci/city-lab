"""Author nine district assets in an isolated Blender process."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
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


def rod(name, start, end, radius, tip_radius, surface, parent):
    start, end = Vector(start), Vector(end)
    direction = end - start
    bpy.ops.mesh.primitive_cone_add(
        vertices=12, radius1=radius, radius2=tip_radius, depth=direction.length,
        location=(start + end) / 2, rotation=direction.to_track_quat("Z", "Y").to_euler(),
    )
    return finish(bpy.context.object, name, surface, parent)


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


def car(wagon=False):
    root = empty("car-b" if wagon else "car-a")
    paint = material("car / paint", (0.5, 0.22, 0.035) if wagon else (0.035, 0.28, 0.4), 0.35, 0.3)
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
    if wagon:
        box("wagon-roof-rail-left", (-0.55, 0, 1.45), (0.035, 1.6, 0.06), alloy, root)
        box("wagon-roof-rail-right", (0.55, 0, 1.45), (0.035, 1.6, 0.06), alloy, root)
        for obj in root.children:
            obj.location.x *= 1.9 / 1.8
            obj.location.y *= 4.7 / 4.4
            obj.location.z *= 1.7 / 1.48
            if obj.type == "MESH":
                for vertex in obj.data.vertices:
                    vertex.co.x *= 1.9 / 1.8
                    vertex.co.y *= 4.7 / 4.4
                    vertex.co.z *= 1.7 / 1.48
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


def person(second=False):
    root = empty("person-b" if second else "person-a")
    jacket = material("person / jacket", (0.055, 0.34, 0.26) if second else (0.65, 0.17, 0.055), roughness=0.85)
    shirt = material("person / ivory shirt", (0.8, 0.77, 0.64), roughness=0.9)
    pants = material("person / indigo trousers", (0.035, 0.08, 0.14), roughness=0.9)
    skin = material("person / skin", (0.52, 0.28, 0.15), roughness=0.85)
    hair = material("person / hair", (0.24, 0.12, 0.04) if second else (0.03, 0.018, 0.012), roughness=0.95)
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
    if second:
        ellipsoid("hair-bun", (0, 0.1, 1.70), (0.14, 0.14, 0.12), hair, root)
    for frame, angle in [(1, 0), (61, 0.45), (121, 0), (181, -0.45), (241, 0)]:
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
    for frame in range(1, 242):
        bpy.context.scene.frame_set(frame)
        root.location.z = 0
        root.location.z = 0.002 - bounds(root)["min"][2]
        root.keyframe_insert(data_path="location", frame=frame, group="Walk")
    return root


def bus():
    root = empty("bus")
    paint = material("bus / jade", (0.04, 0.45, 0.34), 0.25)
    glass = material("bus / glass", (0.025, 0.055, 0.08), 0.2, 0.2)
    rubber = material("bus / rubber", (0.02, 0.025, 0.03))
    light = material("bus / headlights", (1, 0.85, 0.55), emission=0.4)
    red = material("bus / tail lamps", (0.7, 0.02, 0.01), emission=0.4)
    box("coach-body", (0, 0, 1.7), (2.5, 10, 2.8), paint, root, 0.16)
    for side in [-1, 1]:
        for y in [-3.5, -2, -0.5, 1, 2.5, 4]:
            box("passenger-window", (side*1.246, y, 2.25), (0.008, 1.23, 1.15), glass, root, 0)
        for y in [-3.1, 3.1]:
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.48, depth=0.16,
                location=(side*1.16, y, 0.48), rotation=(0, math.pi/2, 0))
            finish(bpy.context.object, "bus-wheel", rubber, root, 0.025)
        for y, surface in [(-4.99, light), (4.99, red)]:
            box("bus-lamp", (side*0.85, y, 0.9), (0.35, 0.02, 0.22), surface, root, 0.01)
    box("front-windscreen", (0, -4.99, 2.15), (2.1, 0.02, 1.2), glass, root, 0.01)
    box("passenger-door", (1.247, -3.4, 1.35), (0.006, 1.15, 1.9), glass, root, 0)
    return root


def static_asset(kind):
    root = empty(kind)
    metal = material(kind+" / metal", (0.31, 0.39, 0.4), 0.6, 0.35)
    dark = material(kind+" / dark", (0.04, 0.07, 0.08), 0.15)
    if kind == "tree":
        bark = material("tree / bark", (0.24, 0.12, 0.055), roughness=0.95)
        leaves = [material(f"tree / foliage {i}", color, roughness=0.95) for i, color in enumerate([
            (0.08, 0.23, 0.045), (0.15, 0.34, 0.07), (0.24, 0.41, 0.10),
        ])]
        rod("tapered-trunk", (0,0,0), (0,0,2.65), 0.13, 0.035, bark, root)
        for i, (x,y,z) in enumerate([(-0.30,0.04,2.35),(0.29,-0.15,2.65),(0.02,0.19,3.03),(-0.19,-0.10,3.08)]):
            rod(f"branch-{i}", (0,0,1.45+i*0.23), (x,y,z), 0.055, 0.018, bark, root)
            for j in range(5):
                angle = j * math.tau / 5 + i
                centre = (x+0.13*math.cos(angle), y+0.12*math.sin(angle), z+0.12*math.sin(j*2))
                bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1, location=centre)
                obj = bpy.context.object
                obj.scale = (0.26,0.29,0.35)
                finish(obj, f"leaf-cluster-{i}-{j}", leaves[(i+j) % len(leaves)], root)
        for i in range(5):
            angle = i * math.tau / 5
            rod(f"root-flare-{i}", (0.17*math.cos(angle),0.17*math.sin(angle),0.018),
                (0,0,0.38), 0.025,0.045,bark,root)
    elif kind == "lamp":
        rod("tapered-pole", (0,0,0.12), (0,0,4), 0.07,0.04,metal,root)
        box("base-plate", (0,0,0.035), (0.3,0.3,0.07), metal, root, 0.015)
        for x in [-0.105,0.105]:
            for y in [-0.105,0.105]:
                rod(f"anchor-bolt-{x}-{y}", (x,y,0.07), (x,y,0.10),0.018,0.018,dark,root)
        rod("arm", (0,0,3.93), (0,-0.43,3.93),0.038,0.03,metal,root)
        rod("arm-brace", (0,0,3.65), (0,-0.27,3.9),0.018,0.018,metal,root)
        box("service-hatch", (0,-0.067,0.48), (0.068,0.015,0.24),dark,root,0.012)
        box("luminaire", (0,-0.32,3.9), (0.27,0.38,0.12), dark, root, 0.035)
        glow = material("lamp / diffuser", (1,0.87,0.6), emission=1)
        for i,y in enumerate([-0.43,-0.32,-0.21]):
            box(f"led-module-{i}", (0,y,3.833), (0.19,0.075,0.015),glow,root,0.008)
    elif kind == "entrance":
        glass = material("entrance / blue glazing", (0.10,0.24,0.28),0.3,0.18)
        for x in [-0.85,0.85]:
            box("frame-post", (x,0,1.1), (0.12,0.4,2.2), metal, root)
        box("frame-header", (0,0,2.15), (1.82,0.4,0.1), metal, root)
        box("threshold", (0,0,0.035), (1.58,0.4,0.07),metal,root,0.012)
        box("transom", (0,0,1.86), (1.58,0.13,0.055),metal,root,0.006)
        box("transom-glazing", (0,0,2.0), (1.58,0.06,0.22),glass,root,0.005)
        for side in [-1,1]:
            box("door-leaf", (side*0.40,0,0.965), (0.76,0.06,1.77),glass,root,0.01)
            box("door-stile", (side*0.027,-0.05,0.965), (0.028,0.035,1.77),metal,root,0.004)
            box("kick-plate", (side*0.40,-0.042,0.23), (0.73,0.018,0.29),metal,root,0.004)
            rod(f"door-handle-{side}", (side*0.12,-0.13,0.85),(side*0.12,-0.13,1.30),0.016,0.016,metal,root)
            for z in [0.89,1.26]:
                rod("handle-bracket",(side*0.12,-0.045,z),(side*0.12,-0.13,z),0.012,0.012,metal,root)
    else:
        casing = material("roof-unit / powder coating", (0.64,0.66,0.59),0.25,0.6)
        box("equipment-housing", (0,0,0.585), (1.4,2,0.93), casing, root, 0.04)
        for x in [-0.48,0.48]:
            for y in [-0.73,0.73]:
                box(f"isolator-{x}-{y}", (x,y,0.06), (0.22,0.24,0.12),dark,root,0.02)
        box("service-panel", (0.699,0.35,0.61), (0.012,0.77,0.68),metal,root,0.008)
        box("service-latch", (0.712,0.55,0.63), (0.02,0.09,0.035),dark,root,0.005)
        for index,y in enumerate([-0.66,0,0.66]):
            rod(f"fan-well-{index}", (0,y,1.04),(0,y,1.058),0.285,0.285,dark,root)
            rod(f"fan-hub-{index}", (0,y,1.052),(0,y,1.09),0.058,0.045,metal,root)
            for blade in range(5):
                angle = blade*math.tau/5
                obj = box(f"fan-blade-{index}-{blade}", (0.14*math.cos(angle),y+0.14*math.sin(angle),1.065),
                    (0.20,0.075,0.015),metal,root,0.005)
                obj.rotation_euler.z = angle+0.3
            for radius in [0.12,0.20,0.278]:
                bpy.ops.mesh.primitive_torus_add(major_radius=radius,minor_radius=0.009,
                    major_segments=24,minor_segments=6,location=(0,y,1.10))
                finish(bpy.context.object,f"fan-guard-{index}-{radius}",metal,root)
            for x in [-0.1,0.1]:
                rod("fan-guard-spoke", (x,y-0.25,1.108),(x,y+0.25,1.108),0.008,0.008,metal,root)
        for side in [-1,1]:
            box("vent-recess", (0,side*0.995,0.59), (1.16,0.025,0.62),dark,root,0.008)
            for z in [0.33,0.44,0.55,0.66,0.77,0.88]:
                box("vent-louvre", (0,side*1.002,z), (1.1,0.016,0.028),metal,root,0.004)
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
    for frame in range(1, 242) if animated else [1]:
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
        "boundsSampling": ("241 frames; supplemental only; publisher proves continuous exported tracks"
                           if animated else "neutral pose, all mesh vertices"),
        "polygons": sum(len(obj.data.polygons) for obj in descendant_meshes(root)),
        "size": ([1.12, 0.601, 1.8] if animated else {
            "car-a": [4.4, 1.8, 1.45], "car-b": [4.7, 1.9, 1.7], "bus": [10, 2.5, 3.1],
        }.get(root.name, [
            round(2*max(abs(neutral["min"][1]),abs(neutral["max"][1]))+0.000001,6),
            round(2*max(abs(neutral["min"][0]),abs(neutral["max"][0]))+0.000001,6),
            round(neutral["max"][2]+0.000001,6)])),
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
    scene.render.fps = 240
    scene.frame_start, scene.frame_end = 1, 241
    roots = [car(), car(True), bus(), person(), person(True)]
    roots += [static_asset(kind) for kind in ["tree","lamp","entrance","roof-unit"]]
    for root in roots:
        empty(root.name+"-front", (0,-0.2,0.7), root)
        empty(root.name+"-back", (0,0.2,0.7), root)
    inventory = [export(root, output, root.name.startswith("person-")) for root in roots]
    (output / "assets.json").write_text(json.dumps(inventory, indent=2) + "\n")
    scene.frame_set(1)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(__file__).resolve().parent / "city-assets.blend"))
    print(json.dumps(inventory, indent=2))


if __name__ == "__main__":
    main()
