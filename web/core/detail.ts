import type { BuildingFeature, BuildingProperties, SceneSettings } from './types';
import { validatePolygon, type Diagnostic, type Polygon2, type XY } from './enhancements';
import { polygonBounds, polygonsIntersect, project, validateEnvelope } from '../../pipeline/enhancements/geometry';

export type FacadeKind = 'residential' | 'office' | 'commercial' | 'industrial';
export const facadeKinds: FacadeKind[] = ['residential', 'office', 'commercial', 'industrial'];
export const facadeProfiles = {
  residential: { bay:4.2, floor:3.4, pane:0.27, color:'#cdc3ae' },
  office: { bay:3.2, floor:3.8, pane:0.43, color:'#83a6ad' },
  commercial: { bay:5.2, floor:4.2, pane:0.34, color:'#c4b398' },
  industrial: { bay:6.4, floor:5, pane:0.20, color:'#a9b2ae' },
};

export function detailBudget(quality: SceneSettings['quality']): {buildings: number; models: number} {
  return {low:{buildings:12,models:32},medium:{buildings:24,models:64},high:{buildings:48,models:128}}[quality];
}

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
  origin: XY; roofs: Polygon2[]; equipment: Polygon2[]; parapets: Polygon2[]; entrances: Polygon2[]; skipped: Diagnostic[];
} {
  const { origin, polygons } = localPolygons(feature);
  const equipmentFootprints: Polygon2[] = [], parapets: Polygon2[] = [], entrances: Polygon2[] = [], skipped: Diagnostic[] = [];
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
      if (equipment < 2 && accept(box(px-1.2,py-0.8,2.4,1.6),box(px-1.2,py-0.8,2.4,1.6,0.2),equipmentFootprints)) equipment++;
      else if (!entrance && accept(box(px-1,py-1,2,2),box(px-1,py-1,2,2,0.2),entrances)) entrance=true;
    }
    // Inward edge-aligned runs, validated against concavities and courtyard holes.
    let walls = 0;
    for (let i=1; i<polygon[0].length && walls<8; i++) {
      const a=polygon[0][i-1], b=polygon[0][i], length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if (length < 4) continue;
      const ux=(b[0]-a[0])/length, uy=(b[1]-a[1])/length;
      const half = Math.min(10,(length-0.8)/2);
      for (const side of [-1,1]) {
        const segment = (pad: number): Polygon2 => {
          const points: XY[] = [[-half-pad,0.25-pad],[half+pad,0.25-pad],[half+pad,0.55+pad],[-half-pad,0.55+pad]]
            .map(([along,inward])=>[(a[0]+b[0])/2+ux*along-uy*inward*side,(a[1]+b[1])/2+uy*along+ux*inward*side]);
          return [[...points,points[0]]];
        };
        if (accept(segment(0),segment(0.08),parapets)) { walls++; break; }
      }
    }
    if (!equipment && !entrance && !walls) skip('no-legal-accessory', `Part ${part}: no interior candidate with edge/hole clearance.`);
    else skip('inferred-accessories', `Part ${part}: ${equipment} roof units, ${entrance ? 1 : 0} roof-access pavilion, ${walls} parapet runs; not surveyed features.`);
  }
  // No accessory crosses another component even if the source multipolygon is malformed.
  const roofs = [...equipmentFootprints,...parapets], all = [...roofs,...entrances];
  if (all.some((p,i)=>all.slice(i+1).some(q=>polygonsIntersect(p,q)))) {
    skip('overlapping-components', 'Accessory overlap rejected.');
    return { origin, roofs: [], equipment: [], parapets: [], entrances: [], skipped };
  }
  return { origin, roofs, equipment: equipmentFootprints, parapets, entrances, skipped };
}

export type DetailSurface = 'stone' | 'metal' | 'dark' | 'glass';
export interface DetailPiece {
  footprint: Polygon2; bottom: number; top: number; kind: string; surface: DetailSurface;
}

export function buildingDetails(feature: BuildingFeature): {origin: XY; pieces: DetailPiece[]; skipped: Diagnostic[]} {
  const layout = accessoryFootprints(feature), pieces: DetailPiece[] = [];
  const roof = feature.properties.height+0.5;
  const add = (footprint: Polygon2, bottom: number, top: number, kind: string, surface: DetailSurface) => {
    if (pieces.length<160 && top>bottom) pieces.push({footprint,bottom,top,kind,surface});
  };
  for (const footprint of layout.equipment) {
    const [x,y,maxX,maxY]=polygonBounds(footprint), w=maxX-x, h=maxY-y;
    add(footprint,roof,roof+0.18,'roof-plinth','stone');
    add(box(x+0.12,y+0.12,w-0.24,h-0.24),roof+0.18,roof+1,'roof-housing','metal');
    for (const offset of [0.28,0.72]) {
      const centre: XY=[x+w*offset,y+h/2], radius=Math.min(w*0.18,h*0.30);
      const ring: XY[]=Array.from({length:12},(_,i)=>[
        centre[0]+radius*Math.cos(i*Math.PI/6),centre[1]+radius*Math.sin(i*Math.PI/6),
      ]);
      add([[...ring,ring[0]]],roof+1,roof+1.08,'roof-fan','dark');
    }
  }
  for (const footprint of layout.parapets) {
    add(footprint,roof,roof+0.55,'parapet','stone');
    add(footprint,roof+0.55,roof+0.67,'parapet-cap','metal');
  }
  for (const footprint of layout.entrances) {
    const [x,y,maxX,maxY]=polygonBounds(footprint);
    add(box(x+0.08,y+0.08,maxX-x-0.16,maxY-y-0.16),roof,roof+1.75,'roof-access','stone');
    add(footprint,roof+1.75,roof+1.9,'roof-access-cap','metal');
    add(box(x+0.6,y+0.05,0.8,0.04),roof+0.05,roof+1.55,'roof-access-door','dark');
  }
  const {polygons}=localPolygons(feature), kind=facadeKind(feature.properties,buildingArea(feature));
  const profile=facadeProfiles[kind];
  for (const polygon of polygons) {
    try { validatePolygon(polygon); }
    catch { continue; } // Invalid source parts are already diagnosed by accessoryFootprints.
    const ring=polygon[0];
    const area=ring.slice(1).reduce((sum,b,i)=>sum+ring[i][0]*b[1]-b[0]*ring[i][1],0);
    const sign=area>0 ? -1 : 1;
    for (let i=1;i<ring.length && pieces.length<160;i++) {
      const a=ring[i-1], b=ring[i], length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if (length<3) continue;
      const ux=(b[0]-a[0])/length, uy=(b[1]-a[1])/length;
      const strip=(from:number,to:number,depth:number): Polygon2=>{
        // Shallow relief on the exterior only; base OSM vertices and courtyard walls stay unchanged.
        const points: XY[]=[[from,0.025],[to,0.025],[to,depth],[from,depth]]
          .map(([along,out])=>[a[0]+ux*along-uy*out*sign,a[1]+uy*along+ux*out*sign]);
        return [[...points,points[0]]];
      };
      const safeAdd=(p:Polygon2,bottom:number,top:number,label:string,surface:DetailSurface)=>{
        if (!polygons.some(source=>polygonsIntersect(p,source))) add(p,bottom,Math.min(top,roof),label,surface);
      };
      if (kind==='office' || kind==='industrial') {
        const count=Math.min(8,Math.max(1,Math.floor(length/profile.bay)));
        for (let bay=1;bay<=count;bay++) {
          const centre=length*bay/(count+1), width=kind==='office' ? 0.12 : 0.22;
          safeAdd(strip(centre-width/2,centre+width/2,0.22),0.6,roof,'facade-fin','metal');
        }
      } else {
        const step=profile.floor*(kind==='commercial' ? 2 : 1);
        const levels=Math.min(12,Math.floor((roof-1)/step));
        for (let level=1;level<=levels;level++) {
          const top=level*step+0.5;
          safeAdd(strip(0.4,length-0.4,0.24),top-0.16,top,
            kind==='residential'?'facade-sill':'facade-cornice','stone');
        }
      }
      safeAdd(strip(0.3,length-0.3,0.18),roof-0.25,roof,'facade-roofline','metal');
    }
  }
  if (pieces.length===160) layout.skipped.push({sourceIds:[feature.properties.id],code:'detail-budget',
    message:'Decorative detail capped at 160 pieces; source building geometry is unchanged.'});
  return {origin:layout.origin,pieces,skipped:layout.skipped};
}
