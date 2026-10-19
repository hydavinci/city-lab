/** Continuous interval enclosure of the deliberately restricted authored glTF rig.
 * LINEAR single-axis quaternions follow the short arc. Every interval includes
 * endpoint AND interior trig extrema; no frame sampling is used as a proof.
 */
type Box = { min: number[]; max: number[] };
type Track = { times: number[]; values: number[][]; path: 'translation' | 'rotation' };
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`GLB animation bounds: ${message}`);
}
const empty = (): Box => ({min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]});
const include = (box: Box, p: number[]) => {
  p.forEach((v,i)=>{box.min[i]=Math.min(box.min[i],v);box.max[i]=Math.max(box.max[i],v);});
};
function corners(box: Box): number[][] {
  return Array.from({length:8},(_,mask)=>[0,1,2].map(i=>(mask & 1<<i) ? box.max[i] : box.min[i]));
}
function extrema(a: number, b: number, lo: number, hi: number): [number,number] {
  const values=[a*Math.cos(lo)+b*Math.sin(lo),a*Math.cos(hi)+b*Math.sin(hi)];
  const phase=Math.atan2(b,a);
  for(let k=Math.ceil((lo-phase)/Math.PI);k<=Math.floor((hi-phase)/Math.PI);k++) {
    const t=phase+k*Math.PI; values.push(a*Math.cos(t)+b*Math.sin(t));
  }
  return [Math.min(...values),Math.max(...values)];
}
function sample(track: Track, time: number): number[] {
  let i=0;
  while(i<track.times.length-2 && time>track.times[i+1]) i++;
  const t=Math.max(0,Math.min(1,(time-track.times[i])/(track.times[i+1]-track.times[i])));
  if(track.path==='rotation') {
    const a=2*Math.atan2(track.values[i][0],track.values[i][3]);
    const b=2*Math.atan2(track.values[i+1][0],track.values[i+1][3]);
    return [a+(b-a)*t];
  }
  return track.values[i].map((v,j)=>v+(track.values[i+1][j]-v)*t);
}

export function continuousBounds(document: any, binary: Buffer, meshes: number[][][], animation: string | null): Box & {
  method: string; intervals: number; polygons: number;
} {
  const tracks=new Map<number,Map<string,Track>>(), times=new Set<number>([0]);
  const read=(id: number, type: string): number[][]=>{
    const a=document.accessors?.[id],v=document.bufferViews?.[a?.bufferView];
    const n=type==='SCALAR'?1:type==='VEC3'?3:4;
    check(a && a.type===type && a.componentType===5126 && !a.sparse && !a.normalized
      && Number.isSafeInteger(a.count) && a.count>=2 && v?.buffer===0,'invalid track accessor');
    const start=(v.byteOffset??0)+(a.byteOffset??0),stride=v.byteStride??n*4;
    check([start,stride,v.byteLength].every(Number.isSafeInteger) && start>=0 && stride>=n*4
      && (a.byteOffset??0)+(a.count-1)*stride+n*4<=v.byteLength
      && start+(a.count-1)*stride+n*4<=document.buffers[0].byteLength,'truncated track');
    return Array.from({length:a.count},(_,i)=>Array.from({length:n},(_,j)=>{
      const x=binary.readFloatLE(start+i*stride+j*4);check(Number.isFinite(x),'nonfinite track');return x;
    }));
  };
  const animations=document.animations??[];
  check(animation===null ? animations.length===0 : animations.length===1 && animations[0].name===animation,
    'declared animation differs from exported clips');
  let moving=false;
  for(const clip of animations) {
    check(clip.name==='Walk' && Array.isArray(clip.channels) && clip.channels.length>0,'required Walk channels');
    const used=new Set<number>();
    for(const c of clip.channels) {
      const node=document.nodes[c.target?.node],path=c.target?.path,s=clip.samplers?.[c.sampler];
      check(node && !node.matrix && (path==='translation'||path==='rotation') && s
        && (s.interpolation??'LINEAR')==='LINEAR','unsupported channel/matrix/interpolation');
      used.add(c.sampler);
      const ts=read(s.input,'SCALAR').map(v=>v[0]),values=read(s.output,path==='rotation'?'VEC4':'VEC3');
      check(ts.length===values.length && ts[0]===0 && ts.at(-1)===1
        && ts.every((t,i)=>i===0 || t>ts[i-1]),'invalid one-second timeline');
      check(values[0].every((v,i)=>Math.abs(v-values.at(-1)![i])<1e-6),'non-looping track');
      if(path==='rotation') for(let i=0;i<values.length;i++) {
        const q=values[i];
        check(q[1]===0 && q[2]===0 && q[3]>0 && Math.abs(Math.hypot(...q)-1)<1e-6,
          'only normalized local-X rotation is certified');
        if(i) check(Math.abs(2*Math.atan2(q[0],q[3])-2*Math.atan2(values[i-1][0],values[i-1][3]))<Math.PI,
          'ambiguous quaternion arc');
      }
      moving ||= values.some(v=>v.some((n,i)=>Math.abs(n-values[0][i])>1e-5));
      const map=tracks.get(c.target.node)??new Map();
      check(!map.has(path),'duplicate channel target');
      map.set(path,{times:ts,values,path});tracks.set(c.target.node,map);
      ts.forEach(t=>times.add(t));
    }
    check(used.size===clip.samplers.length && moving,'unused sampler or motionless Walk');
  }
  const timeline=[...times].sort((a,b)=>a-b);
  if(timeline.length===1) timeline.push(0);
  const parents=new Map<number,number>(),seen=new Set<number>(),chains:{points:number[][];chain:number[]}[]=[];
  const visit=(id: number,chain:number[])=>{
    check(Number.isSafeInteger(id) && document.nodes[id] && !seen.has(id),'invalid hierarchy');
    seen.add(id);
    const n=document.nodes[id],next=[id,...chain];
    if(n.mesh!==undefined) chains.push({points:meshes[n.mesh],chain:next});
    for(const child of n.children??[]) {parents.set(child,id);visit(child,next);}
  };
  for(const id of document.scenes[document.scene??0].nodes) visit(id,[]);
  check([...tracks.keys()].every(id=>seen.has(id)),'unreachable animated node');
  const transform=(box: Box,id: number,start: number,end: number):Box=>{
    const n=document.nodes[id],track=tracks.get(id);
    const translation=track?.get('translation'),rotation=track?.get('rotation');
    const out=empty();
    if(rotation) {
      const a=sample(rotation,start)[0],b=sample(rotation,end)[0],lo=Math.min(a,b),hi=Math.max(a,b);
      const s=n.scale??[1,1,1];
      for(const p of corners(box)) {
        const [x,y,z]=p.map((v,i)=>v*s[i]),yr=extrema(y,-z,lo,hi),zr=extrema(z,y,lo,hi);
        include(out,[x,yr[0],zr[0]]);include(out,[x,yr[1],zr[1]]);
      }
    } else {
      for(const p of corners(box)) {
        if(n.matrix) {
          include(out,[0,1,2].map(i=>n.matrix[i]*p[0]+n.matrix[4+i]*p[1]+n.matrix[8+i]*p[2]+n.matrix[12+i]));
        } else {
          const [x,y,z]=p.map((v,i)=>v*(n.scale??[1,1,1])[i]),[qx,qy,qz,qw]=n.rotation??[0,0,0,1];
          const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);
          include(out,[x+qw*tx+qy*tz-qz*ty,y+qw*ty+qz*tx-qx*tz,z+qw*tz+qx*ty-qy*tx]);
        }
      }
    }
    if(!n.matrix) {
      const a=translation?sample(translation,start):n.translation??[0,0,0];
      const b=translation?sample(translation,end):a;
      for(let i=0;i<3;i++) {out.min[i]+=Math.min(a[i],b[i]);out.max[i]+=Math.max(a[i],b[i]);}
    }
    return out;
  };
  const result=empty();
  for(let i=1;i<timeline.length;i++) for(const {points,chain} of chains) for(const p of points) {
    let box={min:p,max:p};
    for(const id of chain) box=transform(box,id,timeline[i-1],timeline[i]);
    include(result,box.min);include(result,box.max);
  }
  let polygons=0;
  for(const mesh of document.meshes) for(const p of mesh.primitives) {
    check((p.mode??4)===4,'only triangle primitives are supported');
    const count=document.accessors[p.indices??p.attributes.POSITION]?.count;
    check(Number.isSafeInteger(count) && count>0 && count%3===0,'invalid triangle count');
    polygons+=count/3;
  }
  return {...result,method:'continuous exported LINEAR tracks; analytic trig interval enclosure',intervals:timeline.length-1,polygons};
}
