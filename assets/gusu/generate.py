"""Build the source-aligned Gusu sample in a separate background Blender."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from geometry import eave_height, project_rings, roof_patches, roof_point, wall_edges
from publication import publish_manifest

ROOT = HERE.parent.parent


def material(name, color, roughness=0.85, emission=None, texture=False):
    surface = bpy.data.materials.new(name)
    surface.diffuse_color = (*color, 1)
    surface.use_nodes = True
    shader = surface.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    if emission:
        shader.inputs["Emission Color"].default_value = (*emission, 1)
        shader.inputs["Emission Strength"].default_value = 0.8
    if texture:
        image = bpy.data.images.new(f"{name} - locally authored tile courses", width=128, height=128)
        pixels = []
        for y in range(128):
            for x in range(128):
                column = (x % 64) / 64
                course = (y % 32) / 32
                rib = math.cos(column * math.tau) * 0.1
                seam = -0.22 if course < 0.075 else 0.09 * (1 - course)
                grain = (((x * 97 + y * 41) % 31) / 31 - 0.5) * 0.08
                tone = max(0.25, 0.82 + rib + seam + grain)
                pixels.extend([min(1, c * tone) for c in color] + [1])
        image.pixels = pixels
        image.pack()
        node = surface.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        surface.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
    return surface


class Mesh:
    def __init__(self, name, collection, surfaces):
        self.name, self.collection, self.surfaces = name, collection, surfaces
        self.vertices, self.faces, self.materials, self.uvs = [], [], [], []

    def face(self, points, surface, uvs=None):
        if len(points) < 3:
            return
        start = len(self.vertices)
        self.vertices.extend(tuple(p) for p in points)
        self.faces.append(tuple(range(start, start + len(points))))
        self.materials.append(surface)
        self.uvs.append(uvs or [(p[0], p[2]) for p in points])

    def prism(self, points, vector, surface):
        normal = (Vector(points[1]) - Vector(points[0])).cross(Vector(points[2]) - Vector(points[0]))
        if normal.dot(Vector(vector)) < 0:
            points = list(reversed(points))
        top = [tuple(p[i] + vector[i] for i in range(3)) for p in points]
        self.face(list(reversed(points)), surface)
        self.face(top, surface)
        for index, point in enumerate(points):
            next_index = (index + 1) % len(points)
            self.face([point, points[next_index], top[next_index], top[index]], surface)

    def beam(self, start, end, width, depth, surface):
        start, end = Vector(start), Vector(end)
        axis = (end - start).normalized()
        reference = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
        cross = axis.cross(reference).normalized() * width / 2
        normal = axis.cross(cross).normalized() * depth / 2
        points = [start - cross - normal, start + cross - normal,
                  start + cross + normal, start - cross + normal]
        self.prism(points, end - start, surface)

    def finish(self):
        data = bpy.data.meshes.new(self.name)
        data.from_pydata(self.vertices, [], self.faces)
        data.update()
        obj = bpy.data.objects.new(self.name, data)
        self.collection.objects.link(obj)
        for surface in self.surfaces:
            data.materials.append(surface)
        uv_layer = data.uv_layers.new(name="Local architectural meters")
        for polygon, index, coords in zip(data.polygons, self.materials, self.uvs):
            polygon.material_index = index
            for loop, uv in zip(polygon.loop_indices, coords):
                uv_layer.data[loop].uv = uv
        return obj


def wall(mesh, edge, height, detail, seed):
    start, end = edge["start"], edge["end"]
    length = math.dist(start, end)
    if length < 0.05:
        return
    dx, dy = ((end[i] - start[i]) / length for i in range(2))
    nx, ny = dy, -dx
    top = eave_height(height - 0.2)

    def point(x, z, inset=0):
        return (start[0] + dx * x - nx * inset, start[1] + dy * x - ny * inset, z)

    def patch(x0, x1, z0, z1, surface=0, inset=0, thickness=0.30):
        if x1 - x0 < 0.005 or z1 - z0 < 0.005:
            return
        mesh.prism([point(x0, z0, inset), point(x1, z0, inset),
                    point(x1, z1, inset), point(x0, z1, inset)],
                   (-nx * thickness, -ny * thickness, 0), surface)

    patch(0, length, 0.5, 1.12, 2)
    if not detail or length < 2:
        patch(0, length, 1.12, top)
        # Far windows stay recessed; no expensive lattice or individual stonework.
        if length >= 2:
            for bay in range(max(1, min(5, int(length / 3)))):
                center = length * (bay + 0.5) / max(1, min(5, int(length / 3)))
                for z in (2.3, 5.3, 8.0):
                    if z + 1.1 < top:
                        mesh.face([point(center - 0.48, z, -0.006),
                                   point(center + 0.48, z, -0.006),
                                   point(center + 0.48, z + 1.1, -0.006),
                                   point(center - 0.48, z + 1.1, -0.006)], 5 if bay % 3 else 6)
        return

    floors = max(1, round((top - 0.5) / 3.1))
    bays = max(1, min(4, int(length / 2.7)))
    bay_width = length / bays
    floor_height = (top - 1.12) / floors
    for level in range(floors):
        bottom = 1.12 + level * floor_height
        ceiling = bottom + floor_height
        for bay in range(bays):
            left, right = bay * bay_width, (bay + 1) * bay_width
            center = (left + right) / 2
            door = level == 0 and bay == bays // 2 and length > 4 and seed % 2 == 0
            half_width = min(0.80 if door else 0.68, bay_width * 0.28)
            low = bottom if door else bottom + 0.7
            high = min(ceiling - 0.42, low + (2.3 if door else 1.65))
            x0, x1 = center - half_width, center + half_width
            patch(left, x0, bottom, ceiling)
            patch(x1, right, bottom, ceiling)
            patch(x0, x1, bottom, low)
            patch(x0, x1, high, ceiling)
            # The wall really stops at the opening. Glass/door sits behind its reveals.
            mesh.face([point(x0, low, 0.22), point(x1, low, 0.22),
                       point(x1, high, 0.22), point(x0, high, 0.22)],
                      3 if door else (5 if (bay + level + seed) % 4 else 6))
            for a, b in [((x0, low), (x1, low)), ((x1, low), (x1, high)),
                         ((x1, high), (x0, high)), ((x0, high), (x0, low))]:
                mesh.beam(point(*a, inset=0.04), point(*b, inset=0.04), 0.075, 0.10, 3)
            for fraction in (1 / 3, 2 / 3):
                x = x0 + (x1 - x0) * fraction
                z = low + (high - low) * fraction
                mesh.face([point(x - 0.018, low, 0.11), point(x + 0.018, low, 0.11),
                           point(x + 0.018, high, 0.11), point(x - 0.018, high, 0.11)], 3)
                mesh.face([point(x0, z - 0.02, 0.10), point(x1, z - 0.02, 0.10),
                           point(x1, z + 0.02, 0.10), point(x0, z + 0.02, 0.10)], 3)
            patch(x0 - 0.12, x1 + 0.12, high + 0.04, high + 0.14, 3, inset=-0.045, thickness=0.23)
            if door:
                patch(x0 - 0.12, x1 + 0.12, 0.51, 0.68, 2, inset=-0.18, thickness=0.48)
            elif level == 0:
                patch(x0 - 0.08, x1 + 0.08, low - 0.13, low - 0.03, 2, inset=-0.045, thickness=0.28)
    for z in (1.12, top - 0.18):
        mesh.beam(point(0, z, 0.035), point(length, z, 0.035), 0.12, 0.10, 2 if z == 1.12 else 3)
    for x in range(1, math.ceil(length)):
        mesh.face([point(x - 0.008, 0.54, -0.004), point(x + 0.008, 0.54, -0.004),
                   point(x + 0.008, 1.08, -0.004), point(x - 0.008, 1.08, -0.004)], 7)


def roof(mesh, patch, height, detail):
    length = max(math.dist(patch[0], patch[1]), math.dist(patch[3], patch[2]))
    width = max(math.dist(patch[0], patch[3]), math.dist(patch[1], patch[2]))
    roof_height = height - 0.2
    segments = 8 if detail else 4
    for index in range(segments):
        v0, v1 = index / segments, (index + 1) / segments
        points = [roof_point(patch, 0, v0, roof_height), roof_point(patch, 1, v0, roof_height),
                  roof_point(patch, 1, v1, roof_height), roof_point(patch, 0, v1, roof_height)]
        mesh.face(points, 1, [(0, v0 * width), (length, v0 * width),
                             (length, v1 * width), (0, v1 * width)])
    for u in (0, 1):
        for step in range(segments):
            a = roof_point(patch, u, step / segments, roof_height)
            b = roof_point(patch, u, (step + 1) / segments, roof_height)
            points = [(a[0], a[1], eave_height(roof_height) - 0.03),
                      (b[0], b[1], eave_height(roof_height) - 0.03), b, a]
            mesh.face(points if u else list(reversed(points)), 0)
            if detail:
                mesh.beam(a, b, 0.12, 0.13, 2)
    for v in (0, 1):
        a, b = roof_point(patch, 0, v, roof_height), roof_point(patch, 1, v, roof_height)
        mesh.beam(a, b, 0.18, 0.16, 3)
        if detail and length > 0.5:
            for step in range(max(2, int(length / 0.75))):
                u = (step + 0.5) / max(2, int(length / 0.75))
                a = roof_point(patch, u, v, roof_height)
                b = roof_point(patch, u, 0.10 if v == 0 else 0.90, roof_height)
                mesh.beam((a[0], a[1], a[2] - 0.12), (b[0], b[1], b[2] - 0.16), 0.07, 0.09, 3)
    # Rounded ridge caps and the raised rolls make the tile relief real geometry.
    a, b = roof_point(patch, 0, 0.5, roof_height), roof_point(patch, 1, 0.5, roof_height)
    dx, dy = b[0] - a[0], b[1] - a[1]
    norm = math.hypot(dx, dy)
    if norm > 0.01:
        for step in range(6 if detail else 2):
            count = 6 if detail else 2
            points = []
            for endpoint, angle in [(a, step * math.pi / count), (b, step * math.pi / count),
                                    (b, (step + 1) * math.pi / count), (a, (step + 1) * math.pi / count)]:
                points.append((endpoint[0] - dy / norm * math.cos(angle) * 0.13,
                               endpoint[1] + dx / norm * math.cos(angle) * 0.13,
                               endpoint[2] + 0.04 + math.sin(angle) * 0.14))
            mesh.face(points, 4)
    if detail and length > 1 and width > 1:
        rolls = max(2, int(length / 0.38))
        for column in range(1, rolls):
            u = column / rolls
            half = min(0.045 / length, 0.2 / rolls)
            for step in range(segments):
                v0, v1 = step / segments, (step + 1) / segments
                for side in (-1, 1):
                    params = [(u + side * half, v0, 0.012), (u, v0, 0.065),
                              (u, v1, 0.065), (u + side * half, v1, 0.012)]
                    points = []
                    for uu, vv, relief in params:
                        p = roof_point(patch, uu, vv, roof_height)
                        points.append((p[0], p[1], p[2] + relief))
                    if side < 0:
                        points.reverse()
                    mesh.face(points, 4)


def export(collection, path):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=False,
        export_apply=True, export_animations=False, export_materials="EXPORT",
        export_cameras=False, export_lights=False,
    )
    data = path.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + size])
    for node in document["nodes"]:
        node["name"] = node["name"].removeprefix("near:").removeprefix("far:")
    # Blender exports UVs on every material in a mixed mesh. Only tiles use them.
    # Remove unused streams and repack, rather than sacrificing physical detail.
    used_accessors = set()
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            surface = document["materials"][primitive["material"]]
            if "baseColorTexture" not in surface.get("pbrMetallicRoughness", {}):
                primitive["attributes"].pop("TEXCOORD_0", None)
            used_accessors.update(primitive["attributes"].values())
            used_accessors.add(primitive["indices"])
    accessors = sorted(used_accessors)
    accessor_map = {old: new for new, old in enumerate(accessors)}
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {key: accessor_map[value] for key, value in primitive["attributes"].items()}
            primitive["indices"] = accessor_map[primitive["indices"]]
    document["accessors"] = [document["accessors"][index] for index in accessors]
    used_views = {accessor["bufferView"] for accessor in document["accessors"]}
    used_views.update(image["bufferView"] for image in document.get("images", []))
    views = sorted(used_views)
    view_map = {old: new for new, old in enumerate(views)}
    original_binary = data[28 + size:]
    binary = bytearray()
    packed_views = []
    for index in views:
        view = dict(document["bufferViews"][index])
        old_offset = view.get("byteOffset", 0)
        view["byteOffset"] = len(binary)
        binary.extend(original_binary[old_offset:old_offset + view["byteLength"]])
        binary.extend(b"\0" * (-len(binary) % 4))
        packed_views.append(view)
    document["bufferViews"] = packed_views
    for accessor in document["accessors"]:
        accessor["bufferView"] = view_map[accessor["bufferView"]]
    for image in document.get("images", []):
        image["bufferView"] = view_map[image["bufferView"]]
    document["buffers"][0]["byteLength"] = len(binary)
    text = json.dumps(document, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    tail = struct.pack("<II", len(binary), 0x004E4942) + binary
    result = struct.pack("<III", 0x46546C67, 2, 20 + len(text) + len(tail))
    result += struct.pack("<II", len(text), 0x4E4F534A) + text + tail
    path.write_bytes(result)
    triangles = sum(document["accessors"][primitive["indices"]]["count"] // 3
                    for mesh in document["meshes"] for primitive in mesh["primitives"])
    return {"uri": path.name, "bytes": len(result), "sha256": hashlib.sha256(result).hexdigest(),
            "triangles": triangles}


def main():
    if not bpy.app.background:
        raise RuntimeError("Use a separate --background --factory-startup Blender process")
    source = json.loads((HERE / "source.json").read_text())
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.name = "Gusu - source footprints, inferred architectural construction"
    scene.unit_settings.system = "METRIC"
    surfaces = [
        material("White lime plaster", (0.73, 0.70, 0.61)),
        material("Roof - overlapping blue gray tiles", (0.30, 0.35, 0.37), texture=True),
        material("Hand dressed gray stone", (0.27, 0.29, 0.27)),
        material("Dark aged timber", (0.095, 0.058, 0.035)),
        material("Roof - raised rolls and ridge caps", (0.24, 0.28, 0.30)),
        material("Window - warm occupied rooms", (0.14, 0.105, 0.055), roughness=0.4,
                 emission=(1.0, 0.62, 0.22)),
        material("Window - unlit rooms", (0.035, 0.050, 0.055), roughness=0.35),
        material("Stone joints", (0.14, 0.15, 0.13)),
    ]
    output = ROOT / "artifacts" / "gusu-build"
    output.mkdir(parents=True, exist_ok=True)
    inventory, collections = {}, {}
    for lod in ("near", "far"):
        collection = bpy.data.collections.new(f"{lod.upper()} - 45 source buildings")
        scene.collection.children.link(collection)
        collections[lod] = collection
        for index, building in enumerate(source["buildings"]):
            geometry = building["geometry"]
            polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            mesh = Mesh(f"{lod}:{building['properties']['id']}", collection, surfaces)
            height = building["properties"]["height"]
            for polygon in polygons:
                rings = project_rings(polygon, source["origin"])
                for edge_index, edge in enumerate(wall_edges(rings)):
                    wall(mesh, edge, height, lod == "near", index + edge_index)
                for patch in roof_patches(rings):
                    roof(mesh, patch, height, lod == "near")
            obj = mesh.finish()
            obj["source_id"] = building["properties"]["id"]
            obj["source_height_m"] = height
            obj["height_basis"] = building["properties"]["basis"]
            obj["construction"] = "Inferred Jiangnan vernacular treatment; not a survey"
        inventory[lod] = export(collection, output / f"{lod}.glb")
        print(f"GUSU {lod}: {inventory[lod]}", flush=True)
    if inventory["near"]["triangles"] >= 300000 or inventory["far"]["triangles"] >= 45000:
        raise ValueError(f"Architectural triangle budget exceeded: {inventory}")
    if sum(item["bytes"] for item in inventory.values()) >= 16 * 1024 * 1024:
        raise ValueError("Architectural download budget exceeded")
    package_hash = hashlib.sha256("".join(item["sha256"] for item in inventory.values()).encode()).hexdigest()[:32]
    package = ROOT / "public" / "architecture" / package_hash
    package.mkdir(parents=True, exist_ok=True)
    for lod, item in inventory.items():
        content = (output / item["uri"]).read_bytes()
        destination = package / item["uri"]
        if destination.exists():
            if destination.read_bytes() != content:
                raise ValueError("Refusing to overwrite an immutable asset")
        else:
            destination.write_bytes(content)
        item["uri"] = f"{package_hash}/{item['uri']}"
    manifest = {
        "version": 1, "baseDataset": source["baseDataset"], "origin": source["origin"],
        "bounds": source["bounds"], "buildings": [b["properties"] for b in source["buildings"]],
        "inferred": ["Roof profiles and tile patterns", "Plaster, timber and stone materials",
                     "Wall thickness, floors, doors and window placement",
                     "Source heights are estimates; no architectural survey"],
        "lods": inventory,
    }
    text = json.dumps(manifest, indent=2) + "\n"
    collections["far"].hide_viewport = True
    collections["far"].hide_render = True
    scene["base_dataset"] = source["baseDataset"]
    scene["origin_longitude"], scene["origin_latitude"] = source["origin"]
    scene["provenance"] = "Original OSM footprint rings, holes and estimated heights; inferred architectural detail"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE / "gusu-block.blend"))
    publish_manifest(package, text)
    print(f"GUSU published {package_hash}", flush=True)


if __name__ == "__main__":
    main()
