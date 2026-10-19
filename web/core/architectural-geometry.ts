export type XY = [number, number];
export type XYZ = [number, number, number];
export interface WallEdge { start: XY; end: XY; courtyard: boolean }

export function polygonArea(ring: XY[]): number {
  return ring.reduce((sum, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
}

function openRing(ring: XY[]): XY[] {
  if (ring.some(p => p.length < 2 || !p.every(Number.isFinite))) throw new Error('Invalid architectural footprint coordinates.');
  const points = ring.filter((p, i) => !i || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
  if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
  if (points.length < 3 || Math.abs(polygonArea(points)) < 1e-8) throw new Error('Degenerate architectural footprint.');
  return points;
}

export function projectRings(rings: number[][][], origin: XY): XY[][] {
  const radians = Math.PI / 180;
  const longitude = origin[0] * radians, latitude = origin[1] * radians;
  const ecef = (lng: number, lat: number): XYZ => {
    const eccentricity = 6.6943799901413165e-3;
    const radius = 6378137 / Math.sqrt(1 - eccentricity * Math.sin(lat) ** 2);
    return [radius * Math.cos(lat) * Math.cos(lng), radius * Math.cos(lat) * Math.sin(lng),
      radius * (1 - eccentricity) * Math.sin(lat)];
  };
  const anchor = ecef(longitude, latitude);
  const east: XYZ = [-Math.sin(longitude), Math.cos(longitude), 0];
  const north: XYZ = [-Math.sin(latitude) * Math.cos(longitude), -Math.sin(latitude) * Math.sin(longitude), Math.cos(latitude)];
  return rings.map(ring => ring.map(p => {
    if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error('Invalid geographic footprint.');
    const xyz = ecef(p[0] * radians, p[1] * radians);
    const delta = xyz.map((v, i) => v - anchor[i]);
    return [delta.reduce((sum, v, i) => sum + v * east[i], 0),
      delta.reduce((sum, v, i) => sum + v * north[i], 0)];
  }));
}

export function wallEdges(rings: XY[][]): WallEdge[] {
  if (!rings.length) throw new Error('Empty architectural footprint.');
  return rings.flatMap((ring, index) => {
    const points = openRing(ring);
    if ((polygonArea(points) > 0) !== (index === 0)) points.reverse();
    return points.map((start, i) => ({ start, end: points[(i + 1) % points.length], courtyard: index > 0 }));
  });
}

export function roofPatches(source: XY[][]): XY[][] {
  if (!source.length) throw new Error('Empty architectural footprint.');
  const rings = source.map(openRing);
  const outer = rings[0];
  if (polygonArea(outer) < 0) outer.reverse();
  if (rings.length === 1 && outer.length === 4) {
    const convex = outer.every((a, i) => {
      const b = outer[(i + 1) % 4], c = outer[(i + 2) % 4];
      return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= 0;
    });
    if (convex) {
      const lengths = outer.map((a, i) => Math.hypot(a[0] - outer[(i + 1) % 4][0], a[1] - outer[(i + 1) % 4][1]));
      return [lengths[0] + lengths[2] >= lengths[1] + lengths[3] ? outer : [...outer.slice(1), outer[0]]];
    }
  }
  const edges = rings.flatMap(ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]] as [XY, XY]));
  const [a, b] = edges.reduce((longest, edge) =>
    Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]) >
    Math.hypot(longest[1][0] - longest[0][0], longest[1][1] - longest[0][1]) ? edge : longest);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
  const local = rings.map(ring => ring.map(([x, y]): XY => [x * ux + y * uy, -x * uy + y * ux]));
  const localEdges = local.flatMap(ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [XY, XY]));
  const breaks = [...new Set(local.flatMap(ring => ring.map(p => p[0])))].sort((x, y) => x - y);
  const at = ([p, q]: [XY, XY], x: number) => p[1] + (x - p[0]) * (q[1] - p[1]) / (q[0] - p[0]);
  const result: XY[][] = [];
  for (let i = 1; i < breaks.length; i++) {
    const left = breaks[i - 1], right = breaks[i], middle = (left + right) / 2;
    if (right - left < 1e-8) continue;
    const crossings = localEdges.filter(([p, q]) => Math.min(p[0], q[0]) < middle && middle < Math.max(p[0], q[0]))
      .sort((p, q) => at(p, middle) - at(q, middle));
    if (crossings.length % 2) throw new Error('Architectural footprint has unpaired boundary intersections.');
    for (let j = 0; j < crossings.length; j += 2) {
      const low = crossings[j], high = crossings[j + 1];
      const points: XY[] = [[left, at(low, left)], [right, at(low, right)], [right, at(high, right)], [left, at(high, left)]];
      const patch = points.map(([x, y]): XY => [x * ux - y * uy, x * uy + y * ux]);
      if (Math.abs(polygonArea(patch)) > 1e-8) result.push(patch);
    }
  }
  if (!result.length) throw new Error('Architectural footprint has no roof area.');
  return result;
}

export function roofPoint(patch: XY[], u: number, v: number, height: number, rise: number): XYZ {
  const [a, b, c, d] = patch;
  return [
    (1 - v) * (a[0] * (1 - u) + b[0] * u) + v * (d[0] * (1 - u) + c[0] * u),
    (1 - v) * (a[1] * (1 - u) + b[1] * u) + v * (d[1] * (1 - u) + c[1] * u),
    height - rise + rise * (1 - Math.abs(2 * v - 1)) ** 1.35,
  ];
}
