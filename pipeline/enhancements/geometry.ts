import type { Polygon2, XY } from '../../web/core/enhancements';

const RAD = Math.PI / 180, R = 6378137;
export const CLEARANCE = 0.001;
const EPS = 1e-9;
export const distance = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: XY, b: XY, t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export function project([lng, lat]: XY, [lng0, lat0]: XY): XY {
  return [(lng - lng0) * RAD * R * Math.cos(lat0 * RAD), (lat - lat0) * RAD * R];
}
export function unproject([x, y]: XY, [lng0, lat0]: XY): XY {
  return [lng0 + x / (RAD * R * Math.cos(lat0 * RAD)), lat0 + y / (RAD * R)];
}
const cross = (a: XY, b: XY, c: XY) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
type Segment = [XY, XY];
const segments = (p: Polygon2): Segment[] => p.flatMap(r => r.slice(1).map((b, i) => [r[i], b] as Segment));
const on = (a: XY, b: XY, p: XY) => Math.abs(cross(a,b,p)) < EPS &&
  p[0] >= Math.min(a[0],b[0])-EPS && p[0] <= Math.max(a[0],b[0])+EPS &&
  p[1] >= Math.min(a[1],b[1])-EPS && p[1] <= Math.max(a[1],b[1])+EPS;
function intersection([a,b]: Segment, [c,d]: Segment): XY | undefined {
  const den = (b[0]-a[0])*(d[1]-c[1])-(b[1]-a[1])*(d[0]-c[0]);
  if (Math.abs(den) < EPS) return undefined;
  const t = ((c[0]-a[0])*(d[1]-c[1])-(c[1]-a[1])*(d[0]-c[0]))/den;
  const u = ((c[0]-a[0])*(b[1]-a[1])-(c[1]-a[1])*(b[0]-a[0]))/den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? lerp(a,b,t) : undefined;
}
function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i=0; i<ring.length-1; i++) {
    const a=ring[i], b=ring[i+1];
    if ((a[1]>p[1]) !== (b[1]>p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
export function inPolygon(p: XY, polygon: Polygon2): boolean {
  return inRing(p,polygon[0]) && !polygon.slice(1).some(r=>inRing(p,r));
}
export function polygonBounds(p: Polygon2): [number,number,number,number] {
  const points=p[0];
  return [Math.min(...points.map(p=>p[0])), Math.min(...points.map(p=>p[1])),
    Math.max(...points.map(p=>p[0])), Math.max(...points.map(p=>p[1]))];
}
export function boundsOverlap(a: number[], b: number[]): boolean {
  return a[0]<=b[2] && b[0]<=a[2] && a[1]<=b[3] && b[1]<=a[3];
}
export function polygonsIntersect(a: Polygon2, b: Polygon2): boolean {
  if (!boundsOverlap(polygonBounds(a),polygonBounds(b))) return false;
  for (const [p,q] of segments(a)) for (const [r,s] of segments(b)) {
    if (intersection([p,q],[r,s]) || on(p,q,r) || on(p,q,s) || on(r,s,p) || on(r,s,q)) return true;
  }
  return inPolygon(a[0][0],b) || inPolygon(b[0][0],a);
}
export function hull(points: XY[]): Polygon2 {
  const sorted = [...new Map(points.map(p=>[`${p[0]},${p[1]}`,p])).values()]
    .sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  const half = (ps: XY[]) => {
    const result: XY[]=[];
    for (const p of ps) {
      while (result.length>=2 && cross(result[result.length-2],result[result.length-1],p)<=EPS) result.pop();
      result.push(p);
    }
    return result;
  };
  const ring = [...half(sorted).slice(0,-1), ...half([...sorted].reverse()).slice(0,-1)];
  if (ring.length<3) throw new Error('Degenerate envelope');
  return [[...ring,ring[0]]];
}
export function rectangle(a: XY, b: XY, halfLength: number, halfWidth: number): Polygon2 {
  const d=distance(a,b), u: XY=[(b[0]-a[0])/d,(b[1]-a[1])/d];
  return hull([a,b].flatMap(p=>[-1,1].flatMap(s=>[-1,1].map(t=>
    [p[0]+s*u[0]*halfLength-t*u[1]*halfWidth,p[1]+s*u[1]*halfLength+t*u[0]*halfWidth] as XY))));
}
export function sweptEnvelope(points: XY[], length: number, width: number): Polygon2[] {
  if (points.length<2 || ![length,width].every(n=>Number.isFinite(n)&&n>0)
    || points.some(p=>p.length!==2 || !p.every(Number.isFinite))) throw new Error('Invalid sweep');
  const result: Polygon2[]=[];
  for (let i=1;i<points.length;i++) {
    if (distance(points[i-1],points[i])<=EPS) throw new Error('Zero sweep segment');
    result.push(rectangle(points[i-1],points[i],length/2+CLEARANCE,width/2+CLEARANCE));
    if (i===points.length-1) continue;
    const a=points[i-1], p=points[i], b=points[i+1];
    const start=Math.atan2(p[1]-a[1],p[0]-a[0]);
    let turn=Math.atan2(b[1]-p[1],b[0]-p[0])-start;
    turn=Math.atan2(Math.sin(turn),Math.cos(turn));
    const count=Math.max(1,Math.ceil(Math.abs(turn)/0.02));
    // Convex hull of rotation samples plus a circumscribed sagitta pad bounds
    // every corner's continuous arc, including an instantaneous polyline bend.
    const radius=Math.hypot(length/2+CLEARANCE,width/2+CLEARANCE);
    const pad=radius*(1-Math.cos(Math.abs(turn)/count/2));
    const corners: XY[]=[];
    for(let j=0;j<=count;j++) {
      const angle=start+turn*j/count, u: XY=[Math.cos(angle),Math.sin(angle)];
      for(const s of [-1,1]) for(const t of [-1,1]) {
        const q: XY=[p[0]+s*u[0]*(length/2+CLEARANCE)-t*u[1]*(width/2+CLEARANCE),
          p[1]+s*u[1]*(length/2+CLEARANCE)+t*u[0]*(width/2+CLEARANCE)];
        for(const dx of [-pad,pad]) for(const dy of [-pad,pad]) corners.push([q[0]+dx,q[1]+dy]);
      }
    }
    result.push(hull(corners));
  }
  return result;
}
function intervals(p: Polygon2, x: number): [number,number][] {
  const ys=segments(p).filter(([a,b])=>(a[0]>x)!==(b[0]>x))
    .map(([a,b])=>a[1]+(x-a[0])*(b[1]-a[1])/(b[0]-a[0])).sort((a,b)=>a-b);
  const result: [number,number][]=[];
  for(let i=0;i+1<ys.length;i+=2) result.push([ys[i],ys[i+1]]);
  return result;
}
function covered(body: Polygon2, corridor: Polygon2[]): boolean {
  const box=polygonBounds(body);
  const nearby=corridor.filter(p=>boundsOverlap(box,polygonBounds(p)));
  if (!nearby.length) return false;
  const all=[body,...nearby], edges=all.flatMap(segments);
  const xs=all.flatMap(p=>p.flatMap(r=>r.map(p=>p[0]))).filter(x=>x>=box[0]&&x<=box[2]);
  for(let i=0;i<edges.length;i++) for(let j=i+1;j<edges.length;j++) {
    const p=intersection(edges[i],edges[j]);
    if(p && p[0]>box[0] && p[0]<box[2]) xs.push(p[0]);
  }
  const sorted=[...new Set(xs)].sort((a,b)=>a-b);
  // Edge ordering is constant within each arrangement slab. Checking interval
  // coverage here catches edge crossings AND enclosed complement components.
  for(let i=1;i<sorted.length;i++) {
    if(sorted[i]-sorted[i-1]<EPS) continue;
    const x=(sorted[i]+sorted[i-1])/2;
    const available=nearby.flatMap(p=>intervals(p,x)).sort((a,b)=>a[0]-b[0]);
    for(const [lo,hi] of intervals(body,x)) {
      let end=lo;
      for(const [a,b] of available) {
        if(a>end+EPS) break;
        if(b>end) end=b;
      }
      if(end<hi-EPS) return false;
    }
  }
  return true;
}
export function validateEnvelope(envelope: Polygon2[], corridor: Polygon2[], buildings: Polygon2[], water: Polygon2[]): void {
  if(!envelope.length || !corridor.length) throw new Error('Empty envelope/corridor');
  for(const body of envelope) {
    if(!covered(body,corridor)) throw new Error('Body outside corridor');
    if(buildings.some(p=>polygonsIntersect(body,p))) throw new Error('Body intersects building');
    if(water.some(p=>polygonsIntersect(body,p))) throw new Error('Body intersects water');
  }
}
