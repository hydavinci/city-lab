import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { Bounds, SourceHeightBasis, TileInfo } from './types';

const TILE_SIZE = 0.025;

export function deriveHeight(tags: Record<string, unknown>): {
  height: number; basis: SourceHeightBasis; estimated: boolean;
} {
  const text = String(tags.height ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(m|ft|')?$/i.exec(text);
  if (match) {
    const metres = Number(match[1]) * (match[2] && match[2].toLowerCase() !== 'm' ? 0.3048 : 1);
    if (metres > 0 && metres <= 1000) return { height: metres, basis: 'height', estimated: false };
  }
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0 && levels <= 200) {
    return { height: Math.round(levels * 32) / 10, basis: 'levels', estimated: true };
  }
  const kind = String(tags.building ?? 'yes');
  const height = ['house', 'detached', 'terrace', 'residential'].includes(kind) ? 9.6
    : ['industrial', 'warehouse', 'commercial'].includes(kind) ? 10
      : ['garage', 'garages', 'shed'].includes(kind) ? 3.2 : 12.8;
  return { height, basis: 'fallback', estimated: true };
}

function inRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function insideBoundary(point: Position, geometry: Polygon | MultiPolygon): boolean {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(([outer, ...holes]) => inRing(point, outer) && !holes.some((ring) => inRing(point, ring)));
}

export function validateRing(ring: Position[]): boolean {
  return ring.length >= 4
    && ring.every((point) => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])
      && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
    && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1];
}

export function geometryBounds(geometry: Polygon | MultiPolygon): Bounds {
  const points = geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
  const result: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const point of points) {
    result[0] = Math.min(result[0], point[0]);
    result[1] = Math.min(result[1], point[1]);
    result[2] = Math.max(result[2], point[0]);
    result[3] = Math.max(result[3], point[1]);
  }
  return result;
}

export function tileId(point: Position): string {
  return `${Math.floor(point[0] / TILE_SIZE + 1e-8)}_${Math.floor(point[1] / TILE_SIZE + 1e-8)}`;
}

export function tileBounds(id: string): Bounds {
  if (!/^-?\d+_-?\d+$/.test(id)) throw new Error(`Invalid tile ID: ${id}`);
  const [x, y] = id.split('_').map(Number);
  return [x * TILE_SIZE, y * TILE_SIZE, (x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE]
    .map((n) => Number(n.toFixed(6))) as Bounds;
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function selectTiles<T extends TileInfo>(tiles: T[], view: Bounds, centre: Position, limit: number): T[] {
  const distance = (tile: T) =>
    ((tile.bounds[0] + tile.bounds[2]) / 2 - centre[0]) ** 2
    + ((tile.bounds[1] + tile.bounds[3]) / 2 - centre[1]) ** 2;
  return tiles.filter((tile) => intersects(tile.bounds, view))
    .sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
