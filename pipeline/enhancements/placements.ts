import type { Asset, Network, Placement, Polygon2, XY } from '../../web/core/enhancements';
import { polygonBounds, polygonsIntersect, rectangle, sweptEnvelope, validateEnvelope } from './geometry';
import { ACTORS } from './routes';

/** Sparse, deterministic source-relative candidates; every accepted body is checked. */
export function makePlacements(network: Network, assets: Asset[], hosts: Map<string, { polygons: Polygon2[]; height: number }>,
  boundary: Polygon2): Placement[] {
  const active = network.routes.flatMap(route => {
    const points = route.edges.flatMap((id,i) => {
      const e = network.edges.find(e=>e.id===id)!;
      return i ? e.points.slice(1) : e.points;
    });
    return sweptEnvelope(points, Math.max(...route.allowed.map(k=>ACTORS[k].length)),
      Math.max(...route.allowed.map(k=>ACTORS[k].width)));
  });
  const result: Placement[] = [];
  const add = (asset: Placement['asset'], sourceIds: string[], position: XY, heading: number,
    allowed: Polygon2[], obstacles: Polygon2[], height = 0) => {
    const size=assets.find(a=>a.kind===asset)!.size, forward=[Math.sin(heading),Math.cos(heading)];
    const footprint=rectangle([position[0]-forward[0]*1e-6,position[1]-forward[1]*1e-6],
      [position[0]+forward[0]*1e-6,position[1]+forward[1]*1e-6],size[0]/2+0.01,size[1]/2+0.01);
    try {
      validateEnvelope([footprint],allowed,obstacles,network.water);
      validateEnvelope([footprint],[boundary],[],[]);
      if([...active,...result.map(p=>p.footprint)].some(p=>polygonsIntersect(p,footprint))) return false;
    } catch { return false; }
    result.push({asset,sourceIds,position,heading,height,footprint,
      inferred:[asset==='tree'||asset==='lamp'
        ? 'Inferred sparse verge furnishing inside sourced corridor, outside all active swept envelopes; not surveyed vegetation.'
        : 'Inferred roof-access/equipment inside assigned source building; source height, not surveyed equipment.']});
    return true;
  };
  for(const kind of ['tree','lamp'] as const) {
    let count=0;
    for(const edge of network.edges) {
      if(count>=8) break;
      for(let i=1;i<edge.points.length && count<8;i++) {
        const a=edge.points[i-1],b=edge.points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
        if(length<8) continue;
        const heading=Math.atan2(b[0]-a[0],b[1]-a[1]);
        for(const side of [-1,1]) {
          const size=assets.find(a=>a.kind===kind)!.size;
          const offset=side*(edge.width/2-size[1]/2-0.1);
          const point: XY=[(a[0]+b[0])/2+Math.cos(heading)*offset,(a[1]+b[1])/2-Math.sin(heading)*offset];
          if(add(kind,edge.sourceIds,point,heading,edge.corridor,network.buildings)) {count++;break;}
        }
      }
    }
  }
  for(const kind of ['entrance','roof-unit'] as const) {
    let count=0;
    for(const [id,host] of [...hosts].sort(([a],[b])=>a.localeCompare(b))) {
      if(count>=4) break;
      for(const polygon of host.polygons) {
        const [w,s,e,n]=polygonBounds(polygon);
        let done=false;
        for(const fy of [0.25,0.5,0.75]) {
          for(const fx of [0.25,0.5,0.75]) {
            if(add(kind,[id],[w+(e-w)*fx,s+(n-s)*fy],0,[polygon],
              network.buildings.filter(p=>!host.polygons.includes(p)),host.height+0.5)) {count++;done=true;break;}
          }
          if(done) break;
        }
        if(done) break;
      }
    }
  }
  if(!['tree','lamp','entrance','roof-unit'].every(kind=>result.some(p=>p.asset===kind)))
    throw new Error('No safe sourced candidate for every static kind');
  return result;
}
