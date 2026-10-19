"""Import the runtime generator's six representatives into an editable library."""
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix

ROOT = Path(__file__).resolve().parent
source = json.loads((ROOT / "source.json").read_text())
if not bpy.app.background:
    raise RuntimeError("Build the library in an isolated background Blender process.")
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = "METRIC"
bpy.context.scene["source_dataset"] = source["dataset"]
bpy.context.scene["architecture"] = source["inferred"]
for index, entry in enumerate(source["buildings"]):
    collection = bpy.data.collections.new(entry["style"])
    bpy.context.scene.collection.children.link(collection)
    for lod in ("near", "mid"):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / f"{entry['style']}-{lod}.glb"))
        imported = set(bpy.data.objects) - before
        offset = Matrix.Translation(((index % 3) * 220, (index // 3) * 260 + (100 if lod == "mid" else 0), 0))
        for obj in imported:
            if obj.parent not in imported:
                obj.matrix_world = offset @ Matrix.Rotation(-math.pi / 2, 4, "X") @ obj.matrix_world
            for previous in list(obj.users_collection):
                previous.objects.unlink(obj)
            collection.objects.link(obj)
            obj["source_id"] = entry["feature"]["properties"]["id"]
            obj["lod"] = lod
            obj["style"] = entry["style"]
        meshes = [obj for obj in imported if obj.type == "MESH"]
        if len(meshes) != 1 or not meshes[0].data.polygons:
            raise RuntimeError(f"Missing editable mesh: {entry['style']}/{lod}")
        bpy.context.view_layer.update()
        mesh = meshes[0]
        z = [(mesh.matrix_world @ vertex.co).z for vertex in mesh.data.vertices]
        height = entry["feature"]["properties"]["height"]
        if min(z) < 0.49 or max(z) > height + 0.51:
            raise RuntimeError(f"Invalid source height/orientation: {entry['style']}/{lod}")
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "library.blend"))
bpy.ops.wm.open_mainfile(filepath=str(ROOT / "library.blend"))
meshes = [obj for obj in bpy.data.objects if obj.type == "MESH"]
expected = {(entry["feature"]["properties"]["id"], lod) for entry in source["buildings"] for lod in ("near", "mid")}
if len(meshes) != 12 or {(obj["source_id"], obj["lod"]) for obj in meshes} != expected:
    raise RuntimeError("Saved library does not contain all twelve source-linked meshes.")
print(f"Verified editable library: {len(meshes)} meshes, {sum(len(obj.data.polygons) for obj in meshes)} polygons")
