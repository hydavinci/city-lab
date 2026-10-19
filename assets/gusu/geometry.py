"""Footprint-preserving geometry, independent of Blender."""
import math


def polygon_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1]
               for a, b in zip(ring, ring[1:] + ring[:1])) / 2


def open_ring(ring):
    points = [tuple(point[:2]) for point in ring]
    return points[:-1] if points[0] == points[-1] else points


def project_rings(rings, origin):
    """Project WGS84 to the same east/north frame as Cesium's model matrix."""
    longitude, latitude = map(math.radians, origin)
    eccentricity = 6.6943799901413165e-3

    def ecef(lng, lat):
        radius = 6378137 / math.sqrt(1 - eccentricity * math.sin(lat) ** 2)
        return (radius * math.cos(lat) * math.cos(lng),
                radius * math.cos(lat) * math.sin(lng),
                radius * (1 - eccentricity) * math.sin(lat))

    anchor = ecef(longitude, latitude)
    east = (-math.sin(longitude), math.cos(longitude), 0)
    north = (-math.sin(latitude) * math.cos(longitude),
             -math.sin(latitude) * math.sin(longitude), math.cos(latitude))
    result = []
    for ring in rings:
        projected = []
        for point in ring:
            xyz = ecef(*map(math.radians, point[:2]))
            delta = [v - origin_v for v, origin_v in zip(xyz, anchor)]
            projected.append((sum(a * b for a, b in zip(delta, east)),
                              sum(a * b for a, b in zip(delta, north))))
        result.append(projected)
    return result


def roof_patches(rings):
    """Partition the exact polygon, including holes, into roofable trapezoids."""
    rings = [open_ring(ring) for ring in rings]
    outer = rings[0]
    if polygon_area(outer) < 0:
        outer = list(reversed(outer))
        rings[0] = outer
    if len(rings) == 1 and len(outer) == 4:
        turns = [
            (outer[(i + 1) % 4][0] - p[0]) * (outer[(i + 2) % 4][1] - outer[(i + 1) % 4][1])
            - (outer[(i + 1) % 4][1] - p[1]) * (outer[(i + 2) % 4][0] - outer[(i + 1) % 4][0])
            for i, p in enumerate(outer)
        ]
        if min(turns) >= 0:
            lengths = [math.dist(p, outer[(i + 1) % 4]) for i, p in enumerate(outer)]
            start = 0 if lengths[0] + lengths[2] >= lengths[1] + lengths[3] else 1
            return [outer[start:] + outer[:start]]

    edges = [(a, b) for ring in rings for a, b in zip(ring, ring[1:] + ring[:1])]
    longest = max(edges, key=lambda edge: math.dist(*edge))
    length = math.dist(*longest)
    ux, uy = ((longest[1][i] - longest[0][i]) / length for i in range(2))
    local = [[(x * ux + y * uy, -x * uy + y * ux) for x, y in ring] for ring in rings]
    local_edges = [(a, b) for ring in local for a, b in zip(ring, ring[1:] + ring[:1])]
    breaks = sorted({p[0] for ring in local for p in ring})
    patches = []

    def at(edge, x):
        a, b = edge
        return a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0])

    for left, right in zip(breaks, breaks[1:]):
        if right - left < 1e-8:
            continue
        middle = (left + right) / 2
        crossings = [edge for edge in local_edges
                     if min(edge[0][0], edge[1][0]) < middle < max(edge[0][0], edge[1][0])]
        crossings.sort(key=lambda edge: at(edge, middle))
        if len(crossings) % 2:
            raise ValueError("Footprint does not have paired boundary intersections")
        for low, high in zip(crossings[::2], crossings[1::2]):
            points = [(left, at(low, left)), (right, at(low, right)),
                      (right, at(high, right)), (left, at(high, left))]
            patch = [(x * ux - y * uy, x * uy + y * ux) for x, y in points]
            if abs(polygon_area(patch)) > 1e-8:
                patches.append(patch)
    return patches


def eave_height(height):
    return height + 0.5 - min(3.3, height * 0.25)


def roof_point(patch, u, v, height):
    a, b, c, d = patch
    x = (1 - v) * (a[0] * (1 - u) + b[0] * u) + v * (d[0] * (1 - u) + c[0] * u)
    y = (1 - v) * (a[1] * (1 - u) + b[1] * u) + v * (d[1] * (1 - u) + c[1] * u)
    rise = min(3.3, height * 0.25)
    profile = (1 - abs(2 * v - 1)) ** 1.35
    return (x, y, eave_height(height) + rise * profile)


def wall_edges(rings):
    result = []
    for index, ring in enumerate(rings):
        points = open_ring(ring)
        if (polygon_area(points) > 0) != (index == 0):
            points.reverse()
        for a, b in zip(points, points[1:] + points[:1]):
            if math.dist(a, b) > 1e-8:
                result.append({"start": a, "end": b, "courtyard": index > 0})
    return result
