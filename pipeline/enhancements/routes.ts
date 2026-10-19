import { parseNetwork } from '../../web/core/enhancements';
import type { ActorKind, Diagnostic, Edge, Network, Polygon2, XY } from '../../web/core/enhancements';
import type { Bounds } from '../../web/core/types';
import { validateSource } from './fetch';
import { boundsOverlap, distance, hull, lerp, polygonBounds, polygonsIntersect, project, rectangle, sweptEnvelope, validateEnvelope } from './geometry';

export const ACTORS: Record<ActorKind, { length: number; width: number; radius: number }> = {
  'car-a': { length: 4.4, width: 1.8, radius: 5 },
  'car-b': { length: 4.7, width: 1.9, radius: 5.5 },
  bus: { length: 10, width: 2.5, radius: 10 },
  'person-a': { length: 1.12, width: 0.601, radius: 0 },
  'person-b': { length: 1.12, width: 0.601, radius: 0 },
};
interface SourceNode { type: 'node'; id: number; lon: number; lat: number; tags?: Record<string,string> }
interface SourceWay { type: 'way'; id: number; nodes: number[]; tags: Record<string,string> }
interface Relation { type: 'relation'; id: number; tags: Record<string,string>; members: {type:string;ref:number;role:string}[] }
interface SelectedWay { id: string; nodeIds: number[]; tags: Record<string,string> }
export interface Selection {
  version: 1; baseDataset: string; bounds: Bounds;
  driveWays: SelectedWay[]; walkWays: SelectedWay[];
  showcase: { target: XY; heading: number; pitch: number; range: number };
  crossings: { ways: string[]; from: {node:string;sideRoute:string}; to: {node:string;sideRoute:string};
    crossedRoads: {way:string;node:string}[] }[];
  excludedWays: Record<string,string[]>; diagnostics: Diagnostic[];
}
function fail(message: string): never { throw new Error(message); }
const plain = (v: unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(x=>typeof x==='string' && /^way\/[1-9]\d*$/.test(x));
export function parseSelection(value: unknown, source: unknown): Selection {
  validateSource(source);
  if(!plain(value) || value.version!==1 || typeof value.baseDataset!=='string' || !/^[\w-]+$/.test(value.baseDataset)) fail('Invalid selection');
  const s=value as unknown as Selection;
  if(!Array.isArray(s.bounds) || s.bounds.length!==4 || !s.bounds.every(Number.isFinite)
    || s.bounds[0]>=s.bounds[2] || s.bounds[1]>=s.bounds[3] || Math.abs(s.bounds[0])>180 || Math.abs(s.bounds[2])>180
    || Math.abs(s.bounds[1])>=90 || Math.abs(s.bounds[3])>=90 || s.bounds[2]-s.bounds[0]>0.1 || s.bounds[3]-s.bounds[1]>0.1) fail('Invalid selection bounds');
  if(!plain(s.showcase) || !Array.isArray(s.showcase.target) || s.showcase.target.length!==2
    || !s.showcase.target.every(Number.isFinite) || ![s.showcase.range,s.showcase.heading,s.showcase.pitch].every(Number.isFinite)
    || s.showcase.range<=0 || s.showcase.target[0]<s.bounds[0] || s.showcase.target[0]>s.bounds[2]
    || s.showcase.target[1]<s.bounds[1] || s.showcase.target[1]>s.bounds[3]) fail('Invalid showcase');
  if(!Array.isArray(s.driveWays) || !Array.isArray(s.walkWays) || !plain(s.excludedWays) || !Array.isArray(s.crossings)
    || !Array.isArray(s.diagnostics)) fail('Invalid selection inventories');
  const elements=(source as {elements:(SourceNode|SourceWay|Relation)[]}).elements;
  const ways=new Map(elements.filter((e): e is SourceWay=>e.type==='way').map(w=>[`way/${w.id}`,w]));
  const selected=new Map<string,SelectedWay>();
  for(const w of [...s.driveWays,...s.walkWays]) {
    if(!plain(w) || !ids([w.id]) || selected.has(w.id) || !Array.isArray(w.nodeIds) || w.nodeIds.length<2
      || !w.nodeIds.every(Number.isSafeInteger) || !plain(w.tags)) fail('Invalid/duplicate selected way');
    const original=ways.get(w.id);
    if(!original) fail(`Missing selected source ${w.id}`);
    const start=original.nodes.indexOf(w.nodeIds[0]);
    if(start<0 || w.nodeIds.some((id,i)=>original.nodes[start+i]!==id)) fail(`Noncontiguous source subsequence ${w.id}`);
    const tags=original.tags??{};
    if(Object.keys(tags).length!==Object.keys(w.tags).length || Object.entries(tags).some(([k,v])=>w.tags[k]!==v)) fail(`Forged source tags ${w.id}`);
    selected.set(w.id,w);
  }
  const inventory=new Set(selected.keys());
  for(const group of Object.values(s.excludedWays)) {
    if(!ids(group)) fail('Invalid exclusion inventory');
    for(const id of group) {
      if(!ways.has(id) || inventory.has(id)) fail('Duplicate/missing excluded source');
      inventory.add(id);
    }
  }
  if(ways.size!==inventory.size) fail('Source ways must be selected or explicitly excluded');
  const nodes=new Map(elements.filter((e):e is SourceNode=>e.type==='node').map(n=>[`node/${n.id}`,n]));
  for(const c of s.crossings) {
    if(!plain(c) || !ids(c.ways) || !c.ways.length || !plain(c.from) || !plain(c.to) || !Array.isArray(c.crossedRoads)) fail('Invalid crossing');
    let at=c.from.node;
    for(const id of c.ways) {
      const w=selected.get(id);
      if(!w || !s.walkWays.includes(w)) fail('Missing crossing source');
      const first=`node/${w.nodeIds[0]}`, last=`node/${w.nodeIds.at(-1)}`;
      if(at!==first && at!==last) fail('Disconnected crossing chain');
      at=at===first?last:first;
    }
    if(at!==c.to.node) fail('Disconnected crossing endpoint');
    for(const side of [c.from,c.to]) {
      const w=selected.get(side.sideRoute);
      if(!w || !s.walkWays.includes(w) || !w.nodeIds.some(id=>`node/${id}`===side.node)) fail('Crossing lacks sourced side route');
    }
    if(!c.crossedRoads.length) fail('Crossing lacks road evidence');
    for(const road of c.crossedRoads) {
      const n=nodes.get(road.node), w=selected.get(road.way);
      if(!n || n.tags?.highway!=='crossing' || !w || !s.driveWays.includes(w) || !w.nodeIds.includes(n.id)
        || !c.ways.some(id=>selected.get(id)!.nodeIds.includes(n.id))) fail('Crossing lacks shared road node');
    }
  }
  for(const d of s.diagnostics) if(!plain(d) || !Array.isArray(d.sourceIds) || !d.sourceIds.every(x=>typeof x==='string')
    || typeof d.code!=='string' || typeof d.message!=='string') fail('Invalid diagnostic');
  return s;
}
export const lineLength = (points: XY[]): number => points.slice(1).reduce((n,p,i)=>n+distance(points[i],p),0);
function numeric(value: string|undefined, fallback: number, type: 'width'|'lanes'|'speed'): number {
  if(value===undefined) return fallback;
  const m=/^(\d+(?:\.\d+)?)\s*(m|km\/h|mph)?$/.exec(value);
  if(!m || !Number.isFinite(Number(m[1])) || Number(m[1])<=0 || (type==='lanes' && (m[2] || !Number.isInteger(Number(m[1]))))
    || (type==='width' && m[2] && m[2]!=='m') || (type==='speed' && m[2]==='m')) fail(`Invalid ${type}: ${value}`);
  return Number(m[1])*(type==='speed' ? (m[2]==='mph'?0.44704:1/3.6):1);
}
function clip(a: XY,b: XY,bounds: Bounds): [XY,XY,number,number]|undefined {
  let lo=0, hi=1;
  for(let axis=0;axis<2;axis++) {
    const d=b[axis]-a[axis];
    if(Math.abs(d)<1e-12) { if(a[axis]<bounds[axis]||a[axis]>bounds[axis+2]) return; }
    else {
      const t0=(bounds[axis]-a[axis])/d,t1=(bounds[axis+2]-a[axis])/d;
      lo=Math.max(lo,Math.min(t0,t1)); hi=Math.min(hi,Math.max(t0,t1));
    }
  }
  if(hi<=lo) return;
  return [lerp(a,b,lo),lerp(a,b,hi),lo,hi];
}
function curve(a: XY,b: XY,u: XY,v: XY): XY[] {
  const control=distance(a,b)*0.45;
  const p: XY=[a[0]+u[0]*control,a[1]+u[1]*control], q: XY=[b[0]-v[0]*control,b[1]-v[1]*control];
  // The derivative is a convex combination of three control differences.
  const count=Math.max(2,Math.ceil(3*Math.max(distance(a,p),distance(p,q),distance(q,b))/0.24));
  return Array.from({length:count+1},(_,i)=>{
    if(i===0)return a;if(i===count)return b;
    const t=i/count,k=1-t;
    return [k*k*k*a[0]+3*k*k*t*p[0]+3*k*t*t*q[0]+t*t*t*b[0],
      k*k*k*a[1]+3*k*k*t*p[1]+3*k*t*t*q[1]+t*t*t*b[1]] as XY;
  });
}
function minRadius(ps: XY[]): number {
  let min=Infinity;
  for(let i=1;i<ps.length-1;i++) {
    const a=ps[i-1],b=ps[i],c=ps[i+1],area=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
    if(area>1e-10) min=Math.min(min,distance(a,b)*distance(b,c)*distance(c,a)/(2*area));
  }
  return min;
}
interface SegmentInfo { edge: Edge; start: string; end: string; direction: XY; way: SelectedWay; lane: number; terminalStart: boolean; terminalEnd: boolean }

export function compileNetwork(source: unknown, selection: unknown, buildings: Polygon2[], water: Polygon2[]): {network:Network;diagnostics:Diagnostic[]} {
  const s=parseSelection(selection,source), diagnostics: Diagnostic[]=[...s.diagnostics];
  const origin: XY=[(s.bounds[0]+s.bounds[2])/2,(s.bounds[1]+s.bounds[3])/2];
  const local0=project([s.bounds[0],s.bounds[1]],origin),local1=project([s.bounds[2],s.bounds[3]],origin);
  const boundary: Polygon2=[[[local0[0],local0[1]],[local1[0],local0[1]],local1,[local0[0],local1[1]],local0]];
  const elements=(source as {elements:(SourceNode|SourceWay|Relation)[]}).elements;
  const nodes=new Map(elements.filter((e):e is SourceNode=>e.type==='node').map(n=>[n.id,n]));
  const relations=elements.filter((e):e is Relation=>e.type==='relation' && e.tags?.type==='restriction');
  const blocked=new Set<string>(), restrictions: Relation[]=[];
  const note=(sourceIds:string[],code:string,message:string)=>diagnostics.push({sourceIds,code,message});
  for(const r of relations) {
    const from=r.members.filter(m=>m.role==='from'),via=r.members.filter(m=>m.role==='via'),to=r.members.filter(m=>m.role==='to');
    if(from.length!==1 || from[0].type!=='way' || via.length!==1 || via[0].type!=='node'
      || to.length!==1 || to[0].type!=='way' || r.members.length!==3
      || !/^(no|only)_(left_turn|right_turn|straight_on|u_turn)$/.test(r.tags.restriction??'')
      || Object.keys(r.tags).some(k=>k.includes('conditional')||k==='except'||k.startsWith('restriction:'))) {
      const affected=r.members.filter(m=>m.type==='way').map(m=>`way/${m.ref}`);
      affected.forEach(id=>blocked.add(id)); note([`relation/${r.id}`,...affected],'UNSUPPORTED_RESTRICTION','All member ways excluded; no invented turn');
    } else restrictions.push(r);
  }
  const all: SegmentInfo[]=[], roads: Polygon2[]=[], footpaths: Polygon2[]=[];
  const roadSources: {way:string;nodes:number[];polygon:Polygon2}[]=[];
  for(const [mode,ways] of [['drive',s.driveWays],['walk',s.walkWays]] as const) {
    const counts=new Map<number,number>();
    for(const w of ways) for(const id of w.nodeIds) counts.set(id,(counts.get(id)??0)+1);
    for(const w of ways) {
      const t=w.tags;
      try {
        if(blocked.has(w.id)) continue;
        if(['bridge','tunnel','cutting'].some(k=>t[k] && t[k]!=='no') || (t.layer!==undefined && t.layer!=='0')
          || t.level!==undefined && t.level!=='0') fail('Unsupported vertical geometry');
        const prohibitions=mode==='drive'?['access','vehicle','motor_vehicle','motorcar','bus','psv']:['access','foot'];
        if(prohibitions.some(k=>t[k] && !['yes','designated','permissive'].includes(t[k]))) fail('Access prohibited/unsupported');
        if(w.nodeIds.some(id=>prohibitions.some(k=>nodes.get(id)!.tags?.[k] && !['yes','designated','permissive'].includes(nodes.get(id)!.tags![k]))
          || nodes.get(id)!.tags?.barrier && nodes.get(id)!.tags?.barrier!=='no')) fail('Node access/barrier unsupported');
        if(w.nodeIds.some(id=>Object.keys(nodes.get(id)!.tags??{}).some(k=>
          k.includes('conditional')||prohibitions.some(p=>k.startsWith(`${p}:`))))) fail('Unsupported node directional/conditional access');
        if(mode==='drive' && !['primary','secondary','tertiary','residential','unclassified','service','living_street','primary_link','secondary_link','tertiary_link'].includes(t.highway)) fail('Not a driving road');
        if(mode==='walk' && !['footway','path','pedestrian'].includes(t.highway))
          fail('No independent footway geometry; tagged sidewalks are not centreline walking routes');
        if(t.area==='yes') fail('Area is not route');
        if(t.oneway!==undefined && !['yes','1','true','no','0','false','-1'].includes(t.oneway)) fail('Invalid oneway');
        if(Object.keys(t).some(k=>k.includes('conditional')||prohibitions.some(p=>k.startsWith(`${p}:`)))) fail('Unsupported directional/conditional access');
        if(mode==='walk' && (t['oneway:foot']!==undefined || t.oneway && !['no','0','false'].includes(t.oneway)))
          fail('Unsupported walking direction');
        const lanes=numeric(t.lanes,2,'lanes'), width=numeric(t.width,mode==='drive'?lanes*3:2,'width');
        const speed=mode==='drive'?Math.min(8,numeric(t.maxspeed,8,'speed')):1.2;
        const inferred=['layer=0 topology only', ...(t.width?[]:[mode==='drive'?'3m assumed lane width':'2m assumed footway width']),
          ...(t.maxspeed?[]:[mode==='drive'?'8m/s demonstration cap':'1.2m/s walking cap']),
          ...(mode==='walk'?['0.6m x 0.6m conservative pedestrian body']:[])];
        if(!t.lanes && mode==='drive') inferred.push('2 assumed lanes');
        const directions=mode==='walk'?[1,-1]:t.oneway==='-1'?[-1]:['yes','1','true'].includes(t.oneway)?[1]:[1,-1];
        if(mode==='drive' && lanes<directions.length) fail('Insufficient lanes for directions');
        if(Object.keys(t).some(k=>k.startsWith('turn:lanes:'))
          || t['turn:lanes']!==undefined && (mode!=='drive' || directions.length!==1 || directions[0]!==1))
          fail('Unsupported directional turn lanes');
        const turnTag=t['turn:lanes'];
        if(turnTag!==undefined && (turnTag.split('|').length!==lanes
          || turnTag.split(/[|;]/).some(x=>!['left','right','through','slight_left','slight_right'].includes(x))))
          fail('Unsupported turn:lanes');
        for(const direction of directions) {
          const ordered=direction===1?w.nodeIds:[...w.nodeIds].reverse();
          const lane=Math.floor(lanes/2), offset=mode==='drive'
            ? (directions.length===1?(lane+0.5)*width/lanes-width/2:width/lanes/2):0;
          for(let i=1;i<ordered.length;i++) {
            const na=nodes.get(ordered[i-1])!,nb=nodes.get(ordered[i])!;
            const clipped=clip([na.lon,na.lat],[nb.lon,nb.lat],s.bounds); if(!clipped) continue;
            const [ga,gb,lo,hi]=clipped,a=project(ga,origin),b=project(gb,origin),len=distance(a,b);
            if(len<0.1) { note([w.id],'SHORT_SEGMENT','Excluded segment shorter than 0.1m'); continue; }
            const u: XY=[(b[0]-a[0])/len,(b[1]-a[1])/len];
            const raw=rectangle(a,b,width/2,width/2);
            (mode==='drive'?roads:footpaths).push(raw);
            if(mode==='drive') roadSources.push({way:w.id,nodes:[na.id,nb.id],polygon:raw});
            const terminalStart=lo>0 || i===1 && counts.get(ordered[0])===1;
            const terminalEnd=hi<1 || i===ordered.length-1 && counts.get(ordered.at(-1)!)===1;
            // Use available short junction-link space for turns, retaining a nonzero middle segment.
            const junction=mode==='drive' && (counts.get(na.id)!>1 || counts.get(nb.id)!>1);
            const trim=Math.min(mode==='drive'?10:1,len*(junction?0.45:0.3));
            const shifted=(p:XY):XY=>[p[0]+u[1]*offset,p[1]-u[0]*offset];
            const points=[shifted(lerp(a,b,trim/len)),shifted(lerp(a,b,1-trim/len))];
            const id=`${mode}/${w.id}/${ordered[i-1]}-${ordered[i]}`;
            all.push({start:lo>0?`${id}/clip-start`:`node/${na.id}`,end:hi<1?`${id}/clip-end`:`node/${nb.id}`,
              direction:u,way:w,lane,terminalStart,terminalEnd,
              edge:{id,sourceIds:[w.id],from:`${id}/start`,to:`${id}/end`,mode,points,length:lineLength(points),
                width:mode==='drive'?width/lanes:width,speed,allowed:[],next:[],corridor:[],conflicts:[],inferred}});
          }
        }
      } catch(error) { note([w.id],'EXCLUDED_WAY',String(error)); }
    }
  }
  const network: Network={origin,bounds:s.bounds,edges:[],routes:[],zones:[],buildings,water};
  const validate=(e:Edge): boolean=>{
    e.corridor=(e.mode==='drive'?roads:footpaths).filter(p=>boundsOverlap(polygonBounds(p),polygonBounds(hull(e.points.flatMap(p=>[[p[0]-12,p[1]-12],[p[0]+12,p[1]+12]] as XY[])))));
    const radius=minRadius(e.points);
    if(e.mode==='walk') {
      const body=sweptEnvelope(e.points,0.6,0.6);
      const unsupported=roadSources.filter(road=>body.some(p=>polygonsIntersect(p,road.polygon))
        && !s.crossings.some(c=>c.ways.some(id=>e.sourceIds.includes(id))
          && c.crossedRoads.some(r=>r.way===road.way)));
      if(unsupported.length) {note([...new Set([...e.sourceIds,...unsupported.map(r=>r.way)])],'UNSOURCED_CROSSING',
        `${e.id}: walking body enters road segments without a shared tagged crossing: ${unsupported.map(r=>r.nodes.join('-')).join(',')}`);return false;}
    }
    for(const [kind,body] of Object.entries(ACTORS) as [ActorKind,typeof ACTORS[ActorKind]][]) {
      if(kind.startsWith('person')!==(e.mode==='walk') || body.width+0.002>e.width || radius<body.radius) continue;
      try {
        const sweep=sweptEnvelope(e.points,body.length,body.width);
        validateEnvelope(sweep,e.corridor,buildings,water);
        validateEnvelope(sweep,[boundary],[],[]);
        e.allowed.push(kind);
      } catch { /* Eligibility fails closed for this complete body. */ }
    }
    if(!e.allowed.length) { note(e.sourceIds,'UNSAFE_EDGE',`${e.id}: no eligible full body; radius=${radius}`); return false; }
    network.edges.push(e); return true;
  };
  const valid=all.filter(x=>validate(x.edge));
  for(const a of valid) for(const b of valid) {
    if(a.end!==b.start || a.edge.mode!==b.edge.mode || a.start===b.end) continue;
    const dot=a.direction[0]*b.direction[0]+a.direction[1]*b.direction[1];
    if(dot<-.8) continue;
    if(a.edge.mode==='drive') {
      const cross=a.direction[0]*b.direction[1]-a.direction[1]*b.direction[0];
      const turn=dot>0.85?'through':cross>0?'left':'right';
      const forbidden=restrictions.some(r=>{
        const from=r.members.find(m=>m.role==='from')!,via=r.members.find(m=>m.role==='via')!,to=r.members.find(m=>m.role==='to')!;
        return a.way.id===`way/${from.ref}` && a.end===`node/${via.ref}` &&
          (r.tags.restriction.startsWith('no_')?b.way.id===`way/${to.ref}`:
            b.way.id!==`way/${to.ref}` || r.tags.restriction!==`only_${turn==='through'?'straight_on':`${turn}_turn`}`);
      });
      if(forbidden) { note([a.way.id,b.way.id,a.end],'RESTRICTED_TURN','Source via-node restriction'); continue; }
      const tag=a.way.tags[a.way.tags.oneway==='-1'?'turn:lanes:backward':'turn:lanes'];
      if(tag && a.way.id!==b.way.id) {
        if(!tag.split('|')[a.lane].split(';').includes(turn)) {
          note([a.way.id,b.way.id,a.end],'LANE_TURN_EXCLUDED',`Selected lane ${a.lane+1}: ${tag}; movement ${turn}`); continue;
        }
      }
    }
    const points=curve(a.edge.points.at(-1)!,b.edge.points[0],a.direction,b.direction);
    const e: Edge={id:`turn/${a.edge.id}/${b.edge.id}`,sourceIds:[...new Set([a.way.id,b.way.id,a.end])],
      from:a.edge.to,to:b.edge.from,mode:a.edge.mode,points,length:lineLength(points),width:Math.min(a.edge.width,b.edge.width),
      speed:Math.min(a.edge.speed,b.edge.speed, a.edge.mode==='drive'?4:1.2),allowed:[],next:[b.edge.id],corridor:[],
      conflicts:[],inferred:['sampled cubic <=0.25m chord; continuous body sweep','car radii 5/5.5m; bus radius 10m']};
    if(validate(e)) { e.allowed=e.allowed.filter(k=>a.edge.allowed.includes(k)&&b.edge.allowed.includes(k)); if(e.allowed.length) a.edge.next.push(e.id); else network.edges.pop(); }
  }
  addConflicts(network);
  const edgeMap=new Map(network.edges.map(e=>[e.id,e]));
  const centre=project(s.showcase.target,origin), centralRadius=s.showcase.range*0.15;
  const starts=valid.filter(x=>x.edge.mode==='drive' && x.terminalStart && distance(x.edge.points[0],centre)>centralRadius);
  const ends=new Set(valid.filter(x=>x.edge.mode==='drive' && x.terminalEnd && distance(x.edge.points.at(-1)!,centre)>centralRadius).map(x=>x.edge.id));
  // One directed path per walking source component avoids opposing crowds on
  // narrow paths. A sourced non-crossing loop can have off-centre entry/exit.
  const walking=valid.filter(x=>x.edge.mode==='walk'), visited=new Set<string>();
  const walkingEnds=new Map<string,string>();
  for(const seed of walking) {
    if(visited.has(seed.start)) continue;
    const component=new Set([seed.start]), queue=[seed.start];
    while(queue.length) {
      const node=queue.shift()!;
      for(const e of walking) if(e.start===node || e.end===node) for(const next of [e.start,e.end]) {
        if(!component.has(next)){component.add(next);queue.push(next);}
      }
    }
    component.forEach(id=>visited.add(id));
    const eligible=walking.filter(e=>component.has(e.start) && e.way.tags.footway!=='crossing'
      && distance(e.edge.points[0],centre)>centralRadius && distance(e.edge.points.at(-1)!,centre)>centralRadius);
    const start=eligible.find(e=>e.terminalStart)??eligible[0];
    if(!start) continue;
    const exit=[...eligible].filter(e=>e.end!==start.start).sort((a,b)=>
      distance(b.edge.points.at(-1)!,start.edge.points[0])-distance(a.edge.points.at(-1)!,start.edge.points[0]))[0];
    if(exit) {starts.push(start);walkingEnds.set(start.edge.id,exit.edge.id);}
  }
  for(const start of starts) {
    for(const kind of start.edge.allowed) {
      const queue=[[start.edge.id]], seen=new Set<string>();
      while(queue.length) {
        const path=queue.shift()!,id=path.at(-1)!;
        if(seen.has(id)) continue; seen.add(id);
        if(start.edge.mode==='drive'?ends.has(id):walkingEnds.get(start.edge.id)===id) {
          // Do not silently change lanes on untagged intersection connector ways.
          // A through-only approach keeps its street until the source exit.
          const pathWays=path.flatMap(id=>edgeMap.get(id)!.sourceIds.filter(id=>id.startsWith('way/')));
          const invalidLane=pathWays.some((id,i)=>{
            const approach=valid.find(e=>e.way.id===id), tags=approach?.way.tags;
            const tag=tags?.[tags.oneway==='-1'?'turn:lanes:backward':'turn:lanes'];
            return tags?.name && tag?.split('|')[approach!.lane]==='through'
              && pathWays.slice(i+1).some(id=>valid.find(e=>e.way.id===id)?.way.tags.name!==tags.name);
          });
          if(invalidLane) {note([...new Set(pathWays)],'LANE_CONTINUITY_EXCLUDED','Through-only source approach cannot change street via an untagged connector');continue;}
          const key=path.join('>');
          const prior=network.routes.find(r=>r.edges.join('>')===key);
          if(prior) prior.allowed.push(kind);
          else network.routes.push({id:`route/${network.routes.length}`,mode:start.edge.mode,edges:path,allowed:[kind],entry:path[0],exit:id});
          continue;
        }
        for(const next of edgeMap.get(id)!.next) if(edgeMap.get(next)!.allowed.includes(kind) && !path.includes(next)) queue.push([...path,next]);
      }
    }
  }
  if(!network.routes.length) fail(`No safe entry-to-exit routes: ${JSON.stringify(diagnostics)}`);
  for(const route of network.routes) {
    const edges=route.edges.map(id=>edgeMap.get(id)!);
    for(let i=1;i<edges.length;i++) for(const kind of route.allowed) {
      const a=edges[i-1],b=edges[i],body=ACTORS[kind];
      validateEnvelope(sweptEnvelope([a.points.at(-2)!,a.points.at(-1)!,b.points[1]],body.length,body.width),
        [...new Set([...a.corridor,...b.corridor])],buildings,water);
    }
  }
  note([], 'ASSUMPTIONS', `Central spawn exclusion radius=${centralRadius}m; person body=0.6x0.6m; actor dimensions=${JSON.stringify(ACTORS)}`);
  return {network:parseNetwork(network),diagnostics};
}

function addConflicts(n: Network): void {
  const sampled=new Map(n.edges.map(e=>[e.id,e.points.flatMap((p,i)=>{
    if(!i)return [p];
    const a=e.points[i-1],count=Math.ceil(distance(a,p)/2);
    return Array.from({length:count},(_,j)=>lerp(a,p,(j+1)/count));
  })]));
  const sweeps=new Map(n.edges.map(e=>{
    const length=Math.max(...e.allowed.map(k=>ACTORS[k].length)),width=Math.max(...e.allowed.map(k=>ACTORS[k].width));
    return [e.id,sweptEnvelope(sampled.get(e.id)!,length,width)];
  }));
  const bounds=new Map(n.edges.map(e=>[e.id,polygonBounds(hull(sweeps.get(e.id)!.flatMap(p=>p[0])))]));
  const candidates: {id:string;polygon:Polygon2;edges:string[]}[]=[];
  for(let i=0;i<n.edges.length;i++) for(let j=i+1;j<n.edges.length;j++) {
    const a=n.edges[i],b=n.edges[j];
    if(a.mode==='walk' && b.mode==='walk') continue;
    if(!boundsOverlap(bounds.get(a.id)!,bounds.get(b.id)!)) continue;
    // A predecessor/successor is one continuous movement; following owns spacing.
    if(a.next.includes(b.id)||b.next.includes(a.id)) continue;
    if(a.mode===b.mode && a.sourceIds.filter(id=>id.startsWith('way/')).length===1
      && b.sourceIds.filter(id=>id.startsWith('way/')).length===1 && a.sourceIds[0]===b.sourceIds[0]) continue;
    const hit: XY[]=[];
    for(const p of sweeps.get(a.id)!) for(const q of sweeps.get(b.id)!) if(polygonsIntersect(p,q)) hit.push(...p[0],...q[0]);
    if(hit.length) candidates.push({id:`zone/${candidates.length}`,polygon:hull(hit),edges:[]});
  }
  // Merge overlapping zones so crossing and vehicle bodies cannot acquire
  // separate reservations for the same physical space.
  for(let i=0;i<candidates.length;i++) {
    for(let j=i+1;j<candidates.length;j++) if(polygonsIntersect(candidates[i].polygon,candidates[j].polygon)) {
      candidates[i].polygon=hull([...candidates[i].polygon[0],...candidates[j].polygon[0]]);
      candidates.splice(j,1); i=-1; break;
    }
  }
  for(const z of candidates) {
    z.id=`zone/${n.zones.length}`;
    for(const e of n.edges) {
      if(!boundsOverlap(bounds.get(e.id)!,polygonBounds(z.polygon))) continue;
      let at=0,enter=Infinity,exit=-Infinity;
      const length=Math.max(...e.allowed.map(k=>ACTORS[k].length)),width=Math.max(...e.allowed.map(k=>ACTORS[k].width));
      const ps=sampled.get(e.id)!;
      for(let i=1;i<ps.length;i++) {
        const d=distance(ps[i-1],ps[i]);
        if(sweptEnvelope([ps[i-1],ps[i]],length,width).some(p=>polygonsIntersect(p,z.polygon))) {
          enter=Math.min(enter,at);exit=Math.max(exit,at+d);
        }
        at+=d;
      }
      if(exit>enter) { e.conflicts.push({zone:z.id,enter,exit:Math.min(exit,e.length)});z.edges.push(e.id); }
    }
    if(z.edges.length) n.zones.push(z);
  }
}

export function activeMotorConflict(n: Network): {routes:string[];edges:string[];node:string;zone:string}|undefined {
  const routes=n.routes.filter(r=>r.mode==='drive'), edges=new Map(n.edges.map(e=>[e.id,e]));
  for(let i=0;i<routes.length;i++) for(let j=i+1;j<routes.length;j++) {
    const a=routes[i],b=routes[j];
    for(const aid of a.edges) for(const bid of b.edges) {
      if(b.edges.includes(aid) || a.edges.includes(bid)) continue;
      const x=edges.get(aid)!,y=edges.get(bid)!;
      // Following, diverging and merging on one approach are not a crossing demonstration.
      if(x.from===y.from || x.to===y.to) continue;
      const node=x.sourceIds.find(id=>id.startsWith('node/') && y.sourceIds.includes(id));
      const zone=x.conflicts.find(c=>y.conflicts.some(d=>c.zone===d.zone))?.zone;
      if(!node || !zone) continue;
      const xs=sweptEnvelope(x.points,Math.max(...a.allowed.map(k=>ACTORS[k].length)),Math.max(...a.allowed.map(k=>ACTORS[k].width)));
      const ys=sweptEnvelope(y.points,Math.max(...b.allowed.map(k=>ACTORS[k].length)),Math.max(...b.allowed.map(k=>ACTORS[k].width)));
      if(xs.some(p=>ys.some(q=>polygonsIntersect(p,q)))) return {routes:[a.id,b.id],edges:[aid,bid],node,zone};
    }
  }
}

export function capacity(n: Network): {vehicles:number;pedestrians:number;entries:{route:string;slots:number}[]} {
  const occupied: Polygon2[]=[], entries:{route:string;slots:number}[]=[];
  let vehicles=0,pedestrians=0;
  for(const r of n.routes) {
    const edges=r.edges.map(id=>n.edges.find(e=>e.id===id)!);
    const spacing=r.mode==='drive'?12:1.2, length=edges.reduce((sum,e)=>sum+e.length,0);
    let slots=0, offset=0, index=0;
    for(let at=spacing;at<length-spacing;at+=spacing) {
      while(index<edges.length-1 && at>=offset+edges[index].length) offset+=edges[index++].length;
      const e=edges[index], along=at-offset;
      if(e.id.startsWith('turn/') || e.conflicts.some(c=>along>=c.enter-spacing/2 && along<=c.exit+spacing/2)) continue;
      let local=0;
      for(let i=1;i<e.points.length;i++) {
        const a=e.points[i-1], b=e.points[i], d=distance(a,b);
        if(along<=local+d) {
          const p=lerp(a,b,(along-local)/d), u:XY=[(b[0]-a[0])/d,(b[1]-a[1])/d];
          // Physical storage boxes also prevent double counting overlapping routes.
          const body=rectangle([p[0]-u[0]*(spacing-0.01)/2,p[1]-u[1]*(spacing-0.01)/2],
            [p[0]+u[0]*(spacing-0.01)/2,p[1]+u[1]*(spacing-0.01)/2],0,Math.max(...r.allowed.map(k=>ACTORS[k].width))/2+0.001);
          if(!occupied.some(other=>polygonsIntersect(body,other))) {occupied.push(body);slots++;}
          break;
        }
        local+=d;
      }
    }
    entries.push({route:r.id,slots});
    if(r.mode==='drive')vehicles+=slots;else pedestrians+=slots;
  }
  return {vehicles,pedestrians,entries};
}
