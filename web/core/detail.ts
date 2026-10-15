import type { BuildingFeature, BuildingProperties } from './types';
import { validatePolygon, type Diagnostic, type Polygon2, type XY } from './enhancements';
import { polygonBounds, polygonsIntersect, project, validateEnvelope } from '../../pipeline/enhancements/geometry';

export type FacadeKind = 'residential' | 'office' | 'commercial' | 'industrial';
export const facadeKinds: FacadeKind[] = ['residential', 'office', 'commercial', 'industrial'];

export function facadeKind(building: BuildingProperties, area = 0): FacadeKind {
  if (/^(apartments|residential|house|detached|terrace|dormitory)$/.test(building.kind)) return 'residential';
  if (/^(office|civic|government)$/.test(building.kind)) return 'office';
  if (/^(commercial|retail|hotel|supermarket)$/.test(building.kind)) return 'commercial';
  if (/^(industrial|warehouse|garage|garages|shed)$/.test(building.kind)) return 'industrial';
  let hash = 2166136261;
  for (const c of `${building.id}:${building.height}:${Math.round(area)}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return facadeKinds[(hash >>> 0) % facadeKinds.length];
}

export function detailVisible(previous: boolean, pixelsPerMetre: number): boolean {
  return Number.isFinite(pixelsPerMetre) && pixelsPerMetre >= (previous ? 0.5 : 0.8);
}

export function buildingArea(feature: BuildingFeature): number {
  const polygons = localPolygons(feature).polygons;
  return polygons.reduce((total, polygon) => total + polygon.reduce((area, ring, i) => {
    const signed = ring.slice(1).reduce((sum, p, j) => sum + ring[j][0]*p[1]-p[0]*ring[j][1],0);
    return area + Math.abs(signed)/2 * (i ? -1 : 1);
  },0),0);
}

function localPolygons(feature: BuildingFeature): { origin: XY; polygons: Polygon2[] } {
  const source = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const origin = source[0][0][0].slice(0,2) as XY;
  return { origin, polygons: source.map(p=>p.map(r=>r.map(p=>project(p.slice(0,2) as XY,origin)))) };
}

function box(x: number, y: number, w: number, h: number, pad = 0): Polygon2 {
  return [[[x-pad,y-pad],[x+w+pad,y-pad],[x+w+pad,y+h+pad],[x-pad,y+h+pad],[x-pad,y-pad]]];
}

export function accessoryFootprints(feature: BuildingFeature): {
  origin: XY; roofs: Polygon2[]; entrances: Polygon2[]; skipped: Diagnostic[];
} {
  const { origin, polygons } = localPolygons(feature);
  const roofs: Polygon2[] = [], entrances: Polygon2[] = [], skipped: Diagnostic[] = [];
  const occupied: Polygon2[] = [];
  const skip = (code: string, message: string) => skipped.push({ sourceIds: [feature.properties.id], code, message });
  for (const [part, polygon] of polygons.entries()) {
    try { validatePolygon(polygon); }
    catch (error) { skip('unsupported-footprint', `Part ${part}: ${String(error)}`); continue; }
    const [x,y,maxX,maxY] = polygonBounds(polygon);
    const accept = (candidate: Polygon2, padded: Polygon2, target: Polygon2[]) => {
      // Use the shared arrangement-based test: checking corners alone misses holes and concavities.
      try { validateEnvelope([padded],[polygon],occupied,[]); }
      catch { return false; }
      target.push(candidate); occupied.push(padded); return true;
    };
    let equipment = 0, entrance = false;
    for (let row=0; row<8; row++) for (let col=0; col<8; col++) {
      const px=x+(maxX-x)*(col+0.5)/8, py=y+(maxY-y)*(row+0.5)/8;
      if (equipment < 2 && accept(box(px-1.2,py-0.8,2.4,1.6),box(px-1.2,py-0.8,2.4,1.6,0.2),roofs)) equipment++;
      else if (!entrance && accept(box(px-1,py-1,2,2),box(px-1,py-1,2,2,0.2),entrances)) entrance=true;
    }
    // Short inward parapet runs, never a bounding-box roof or an unsafe corner approximation.
    let walls = 0;
    for (let i=1; i<polygon[0].length && walls<8; i++) {
      const a=polygon[0][i-1], b=polygon[0][i], length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if (length < 4) continue;
      const ux=(b[0]-a[0])/length, uy=(b[1]-a[1])/length;
      for (const side of [-1,1]) {
        const segment = (pad: number): Polygon2 => {
          const points: XY[] = [[-1.5-pad,0.35-pad],[1.5+pad,0.35-pad],[1.5+pad,0.65+pad],[-1.5-pad,0.65+pad]]
            .map(([along,inward])=>[(a[0]+b[0])/2+ux*along-uy*inward*side,(a[1]+b[1])/2+uy*along+ux*inward*side]);
          return [[...points,points[0]]];
        };
        if (accept(segment(0),segment(0.1),roofs)) { walls++; break; }
      }
    }
    if (!equipment && !entrance && !walls) skip('no-legal-accessory', `Part ${part}: no interior candidate with edge/hole clearance.`);
    else skip('inferred-accessories', `Part ${part}: ${equipment} roof units, ${entrance ? 1 : 0} roof-access pavilion, ${walls} parapet runs; not surveyed features.`);
  }
  // No accessory crosses another component even if the source multipolygon is malformed.
  const all = [...roofs,...entrances];
  if (all.some((p,i)=>all.slice(i+1).some(q=>polygonsIntersect(p,q)))) {
    skip('overlapping-components', 'Accessory overlap rejected.');
    return { origin, roofs: [], entrances: [], skipped };
  }
  return { origin, roofs, entrances, skipped };
}
