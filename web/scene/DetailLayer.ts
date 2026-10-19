import {
  BoundingSphere, Cartesian2, Cartesian3, Color, CorridorGeometry, CornerType,
  ColorGeometryInstanceAttribute, GeometryInstance, Material, MaterialAppearance, Math as CesiumMath,
  PerInstanceColorAppearance,
  PolygonGeometry, PolygonHierarchy, PolylineGeometry, PolylineMaterialAppearance,
  Primitive, PrimitiveCollection, ShowGeometryInstanceAttribute, Model, Matrix3, Matrix4, Transforms, type Viewer,
} from 'cesium';
import type { FeatureCollection, Position } from 'geojson';
import type { Bounds, BuildingFeature, SceneSettings } from '../core/types';
import { parseEnhancementManifest, parseNetwork, parsePlacements,
  type Diagnostic, type EnhancementManifest, type Placement, type XY } from '../core/enhancements';
import { buildingDetails, detailBudget, detailVisible, type DetailSurface } from '../core/detail';
import { geometryBounds, intersects, selectTiles, tileId } from '../core/geo';
import { project, unproject } from '../../pipeline/enhancements/geometry';
import { colorMaterial } from './materials';

interface Road {
  id: string; sourceId: string; line: Position[]; width: number; basis: string; eligible: boolean;
}
interface RoadRegion {
  id: string; bounds: Bounds; count: number; roads: Road[];
  near?: Primitive; overviewVisible: boolean;
}
interface DetailTile {
  buildings: BuildingFeature[]; active: Set<string>; primitive?: Primitive; diagnostics: Diagnostic[];
  instances?: GeometryInstance[]; night?: boolean;
}
const detailColors: Record<DetailSurface, [string,string]> = {
  stone:['#c7bfac','#475058'],metal:['#95a6a5','#34454e'],
  dark:['#354348','#182a32'],glass:['#517986','#294754'],
};

export class DetailLayer {
  private collection: PrimitiveCollection;
  private roadRegions = new Map<string, RoadRegion>();
  private tiles = new Map<string, DetailTile>();
  private loadedIds = new Set<string>();
  private excludedBuildings: ReadonlySet<string> = new Set();
  private overview?: Primitive;
  private diagnostics: Diagnostic[] = [];
  private settings?: SceneSettings;
  private failure?: Error;
  private disposed = false;
  private removeRender: () => void;
  private district?: {manifest: EnhancementManifest; placements: Placement[]; origin: XY};
  private districtGeneration = 0;
  private districtAbort?: AbortController;
  private districtLoading = false;
  private districtFailure?: Error;
  private districtModels = new Map<number, Model>();
  private districtPending = new Set<number>();
  private districtWanted = new Set<number>();
  private districtURLs = new Map<string, Promise<string>>();
  private districtBlobs = new Set<string>();
  private roadAppearance = new MaterialAppearance({ material: colorMaterial('#70756e'), translucent: false, flat: true });
  private accessoryAppearance = new PerInstanceColorAppearance({ translucent:false,closed:true });

  constructor(private viewer: Viewer, private onError: (message: string) => void) {
    this.collection = viewer.scene.primitives.add(new PrimitiveCollection());
    // Only the replaceable detail batches belong to this render-error boundary.
    const collection = this.collection as PrimitiveCollection & { update(frameState: unknown): void };
    const update = collection.update.bind(collection);
    collection.update = frameState => {
      try { update(frameState); }
      catch (error) { this.fail(error); throw error; }
    };
    this.removeRender = viewer.scene.postRender.addEventListener(() => this.syncOverview());
  }

  get error(): Error | undefined { return this.failure; }

  get ready(): boolean {
    if (this.failure || this.disposed) return false;
    if (this.districtLoading || this.districtPending.size || [...this.districtModels.values()].some(m=>!m.ready)) return false;
    if (this.overview?.show && !this.overview.ready) return false;
    for (let i=0;i<this.collection.length;i++) {
      const p = this.collection.get(i) as Primitive;
      if (p.show && !p.ready) return false;
    }
    return true;
  }

  async loadDistrict(input: EnhancementManifest): Promise<void> {
    if (this.disposed) return;
    this.unloadDistrict();
    const generation=this.districtGeneration, controller=new AbortController();
    this.districtAbort=controller; this.districtLoading=true;
    try {
      const manifest=parseEnhancementManifest(input,input.baseDataset);
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]);
      const read=async(path:string)=>{
        const response=await fetch(`/enhancements/${path}`,{signal});
        if(!response.ok) throw new Error(`District HTTP ${response.status}: ${path}`);
        return response.json();
      };
      const [rawPlacements,rawNetwork]=await Promise.all([read(manifest.placements),read(manifest.network)]);
      const placements=parsePlacements(rawPlacements,manifest.assets),network=parseNetwork(rawNetwork);
      if(generation!==this.districtGeneration || this.disposed) return;
      if(JSON.stringify(network.bounds)!==JSON.stringify(manifest.bounds)) throw new Error('District bounds mismatch');
      this.district={manifest,placements,origin:network.origin};
      this.districtLoading=false;
      if(this.settings) this.update(this.settings);
    } catch(error) {
      controller.abort();
      if(generation!==this.districtGeneration || this.disposed) return;
      this.districtLoading=false;throw error;
    }
  }

  unloadDistrict(): void {
    this.clearDistrictModels();
    this.district=undefined;
    this.districtLoading=false;
    this.districtFailure=undefined;
  }

  private clearDistrictModels(): void {
    this.districtGeneration++;
    this.districtAbort?.abort();this.districtAbort=undefined;
    for(const model of this.districtModels.values()) this.collection.remove(model);
    this.districtModels.clear();this.districtPending.clear();this.districtWanted.clear();
    for(const url of this.districtBlobs) URL.revokeObjectURL(url);
    this.districtBlobs.clear();this.districtURLs.clear();
    this.viewer.scene.requestRender();
  }

  private async districtURL(kind: string): Promise<string> {
    const asset=this.district!.manifest.assets.find(a=>a.kind===kind)!;
    const existing=this.districtURLs.get(kind);
    if(existing) return existing;
    const generation=this.districtGeneration;
    const controller=this.districtAbort??=new AbortController();
    const pending=(async()=>{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]);
      const response=await fetch(`/enhancements/${asset.uri}`,{signal});
      if(!response.ok) throw new Error(`District asset HTTP ${response.status}: ${kind}`);
      const bytes=await response.arrayBuffer();
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
        .map(b=>b.toString(16).padStart(2,'0')).join('');
      if(bytes.byteLength!==asset.bytes || hash!==asset.sha256) throw new Error(`District asset hash/bytes mismatch: ${kind}`);
      if(generation!==this.districtGeneration || this.disposed) throw new Error('Obsolete district asset');
      const url=URL.createObjectURL(new Blob([bytes],{type:'model/gltf-binary'}));
      this.districtBlobs.add(url);
      return url;
    })();
    this.districtURLs.set(kind,pending);
    return pending;
  }

  private updateDistrict(settings: SceneSettings, bounds: Bounds, centre: XY, near: boolean): void {
    const district=this.district;
    if(!district || this.districtFailure) return;
    const visible=near && !this.failure && intersects(bounds,district.manifest.bounds)
      && detailVisible(this.districtModels.size>0,this.pixelsPerMetre(district.manifest.bounds,centre))
      && (settings as SceneSettings & {streetDetails?:boolean}).streetDetails!==false;
    const wanted=new Set<number>();
    if(visible) {
      const focus=project(centre,district.origin);
      district.placements.map((p,i)=>({p,i}))
        .filter(({p})=>['tree','lamp','entrance','roof-unit'].includes(p.asset)
          && (p.asset==='tree'?settings.green:p.asset==='lamp'?settings.roads:settings.buildings))
        .sort((a,b)=>Math.hypot(a.p.position[0]-focus[0],a.p.position[1]-focus[1])
          -Math.hypot(b.p.position[0]-focus[0],b.p.position[1]-focus[1]) || a.i-b.i)
        .slice(0,detailBudget(settings.quality).models).forEach(({i})=>wanted.add(i));
    }
    this.districtWanted=wanted;
    for(const [id,model] of this.districtModels) if(!wanted.has(id)) {
      this.collection.remove(model);this.districtModels.delete(id);
    }
    if(!wanted.size) {
      if(this.districtModels.size || this.districtPending.size || this.districtURLs.size) this.clearDistrictModels();
      return;
    }
    for(const id of wanted) {
      if(this.districtModels.has(id) || this.districtPending.has(id)) continue;
      const generation=this.districtGeneration,p=district.placements[id];
      this.districtPending.add(id);
      void (async()=>{
        try {
          const url=await this.districtURL(p.asset);
          if(generation!==this.districtGeneration || !this.districtWanted.has(id) || this.disposed) return;
          const coordinate=unproject(p.position,district.origin);
          const enu=Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...coordinate,p.height??0));
          const rotation=Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(Math.PI/2-p.heading));
          const model=await Model.fromGltfAsync({url,modelMatrix:Matrix4.multiply(enu,rotation,new Matrix4()),
            scale:1,minimumPixelSize:0,id:{asset:p.asset,sourceIds:p.sourceIds,inferred:p.inferred}});
          if(generation!==this.districtGeneration || !this.districtWanted.has(id) || this.disposed) {model.destroy();return;}
          model.errorEvent.addEventListener(error=>{
            // Model.update continues after errorEvent; wait for the render to unwind before disposal.
            queueMicrotask(()=>{
              if(generation===this.districtGeneration && !this.disposed) this.failDistrict(error);
            });
          });
          this.collection.add(model);this.districtModels.set(id,model);
        } catch(error) {
          if(generation===this.districtGeneration && !this.disposed) this.failDistrict(error);
        } finally {
          if(generation===this.districtGeneration) this.districtPending.delete(id);
          if(!this.disposed) this.viewer.scene.requestRender();
        }
      })();
    }
  }

  setRoads(collection: FeatureCollection): void {
    if (this.disposed) return;
    for (const region of this.roadRegions.values()) this.unloadRoad(region);
    if (this.overview) this.viewer.scene.primitives.remove(this.overview);
    this.overview = undefined;
    this.roadRegions.clear();
    this.diagnostics = [];
    const instances: GeometryInstance[] = [], ids = new Set<string>();
    for (const feature of collection.features) {
      if (feature.properties?.layer !== 'roads') continue;
      const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates]
        : feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [];
      const p = feature.properties, tags = p.sourceTags;
      const ground = tags && (!tags.bridge || tags.bridge === 'no')
        && (!tags.tunnel || tags.tunnel === 'no') && (!tags.layer || String(tags.layer) === '0');
      const width = p.widthMetres;
      const eligible = Boolean(ground && Number.isFinite(width) && width >= 0.5 && width <= 80);
      const sourceId = String(feature.id);
      if (!eligible) this.diagnostics.push({ sourceIds: [sourceId], code: 'overview-only-road',
        message: 'Missing metre width/source tags or unsupported bridge/tunnel/layer elevation; overview retained.' });
      for (const [index, line] of lines.entries()) {
        if (line.length < 2) continue;
        const id = `${sourceId}:${index}`;
        if (ids.has(id)) continue;
        ids.add(id);
        const regionId = tileId(lines[0][0]);
        const bounds: Bounds = [Math.min(...line.map(p=>p[0])),Math.min(...line.map(p=>p[1])),
          Math.max(...line.map(p=>p[0])),Math.max(...line.map(p=>p[1]))];
        const region = this.roadRegions.get(regionId) ?? { id: regionId, bounds, count: 0, roads: [], overviewVisible: true };
        region.bounds = [Math.min(region.bounds[0],bounds[0]),Math.min(region.bounds[1],bounds[1]),
          Math.max(region.bounds[2],bounds[2]),Math.max(region.bounds[3],bounds[3])];
        region.count++;
        region.roads.push({ id, sourceId, line, width, basis: p.widthBasis, eligible });
        this.roadRegions.set(regionId,region);
        instances.push(new GeometryInstance({
          id, attributes: { show: new ShowGeometryInstanceAttribute(true) },
          geometry: new PolylineGeometry({
            positions: Cartesian3.fromDegreesArrayHeights(line.flatMap(([x,y])=>[x,y,5])),
            width: /motorway|trunk/.test(p.kind) ? 2 : 1,
            vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
          }),
        }));
      }
    }
    // One overview draw batch, independently switchable by region through per-instance attributes.
    if (instances.length) this.overview = this.viewer.scene.primitives.add(new Primitive({
      geometryInstances: instances,
      appearance: new PolylineMaterialAppearance({material:Material.fromType('Color',{color:Color.fromCssColorString('#8f907c')})}),
    }));
    if (this.settings) this.update(this.settings);
    this.viewer.scene.requestRender();
  }

  setTile(id: string, buildings: BuildingFeature[]): void {
    if (this.disposed) return;
    this.removeTile(id);
    this.tiles.set(id,{buildings,active:new Set(),diagnostics:[]});
    if (this.settings) this.update(this.settings);
  }

  removeTile(id: string): void {
    const tile = this.tiles.get(id);
    if (tile?.primitive) {
      this.collection.remove(tile.primitive);
      this.viewer.scene.requestRender();
    }
    this.tiles.delete(id);
  }

  private pixelsPerMetre(bounds: Bounds, focus?: XY): number {
    const point = focus
      ? [Math.max(bounds[0],Math.min(bounds[2],focus[0])),Math.max(bounds[1],Math.min(bounds[3],focus[1]))]
      : [(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];
    const sphere = new BoundingSphere(Cartesian3.fromDegrees(point[0],point[1]),1);
    const canvas = this.viewer.canvas;
    return 1 / this.viewer.camera.getPixelSize(sphere,canvas.width,canvas.height);
  }

  update(settings: SceneSettings): void {
    if (this.disposed) return;
    const previous = this.settings as (SceneSettings & {streetDetails?: boolean}) | undefined;
    let changed = !previous || previous.buildings !== settings.buildings || previous.roads !== settings.roads
      || previous.green !== settings.green || previous.night !== settings.night || previous.quality !== settings.quality
      || previous.streetDetails !== (settings as SceneSettings & {streetDetails?: boolean}).streetDetails;
    this.settings = settings;
    const camera = this.viewer.camera, scene = this.viewer.scene;
    const view = camera.computeViewRectangle();
    const ray = camera.getPickRay(new Cartesian2(scene.canvas.clientWidth/2,scene.canvas.clientHeight/2));
    const hit = ray && scene.globe.pick(ray,scene);
    const focus = hit ? scene.globe.ellipsoid.cartesianToCartographic(hit) : camera.positionCartographic;
    const centre: XY = [CesiumMath.toDegrees(focus.longitude),CesiumMath.toDegrees(focus.latitude)];
    const bounds: Bounds = view ? [view.west,view.south,view.east,view.north].map(CesiumMath.toDegrees) as Bounds
      : [centre[0]-0.03,centre[1]-0.03,centre[0]+0.03,centre[1]+0.03];
    const near = camera.positionCartographic.height <= 24000;
    const previousDistrict = this.districtWanted;
    this.updateDistrict(settings,bounds,centre,near);
    changed ||= previousDistrict.size !== this.districtWanted.size
      || [...previousDistrict].some(id => !this.districtWanted.has(id));
    const wanted = new Set(near && settings.roads && !this.failure
      ? selectTiles([...this.roadRegions.values()],bounds,centre,{low:4,medium:8,high:14}[settings.quality])
        .filter(r=>detailVisible(Boolean(r.near),this.pixelsPerMetre(r.bounds,centre))).map(r=>r.id) : []);
    try {
      for (const region of this.roadRegions.values()) {
        const previousNear = region.near;
        if (!wanted.has(region.id)) this.unloadRoad(region);
        else if (!region.near) this.loadRoad(region);
        changed ||= previousNear !== region.near;
      }
      const candidates = near && settings.buildings && !this.failure
        ? [...this.tiles.values()].flatMap(tile=>tile.buildings.map(b=>({tile,b,box:geometryBounds(b.geometry)})))
          .filter(({tile,b,box})=>!this.excludedBuildings.has(b.properties.id) && intersects(box,bounds)
            && detailVisible(tile.active.has(b.properties.id),this.pixelsPerMetre(box))) : [];
      const distance=({box}:{box:Bounds})=>Math.hypot((box[0]+box[2])/2-centre[0],(box[1]+box[3])/2-centre[1]);
      const selectedIds=new Set(candidates.sort((a,b)=>distance(a)-distance(b) || a.b.properties.id.localeCompare(b.b.properties.id))
        .slice(0,detailBudget(settings.quality).buildings).map(({b})=>b.properties.id));
      for (const tile of this.tiles.values()) {
        const selected=tile.buildings.filter(b=>selectedIds.has(b.properties.id));
        const ids = new Set(selected.map(b=>b.properties.id));
        if (ids.size===tile.active.size && [...ids].every(id=>tile.active.has(id))) continue;
        changed = true;
        if (tile.primitive) this.collection.remove(tile.primitive);
        tile.primitive=undefined; tile.active=ids; tile.diagnostics=[];
        this.loadAccessories(tile,selected);
      }
    } catch (error) { this.fail(error); }
    if (this.overview) {
      this.overview.show = settings.roads;
      this.overview.appearance!.material.uniforms.color = Color.fromCssColorString(settings.night ? '#817963' : '#8f907c');
    }
    this.roadAppearance.material.uniforms.color = Color.fromCssColorString(settings.night ? '#454d4e' : '#70756e');
    this.syncOverview();
    if (changed) scene.requestRender();
  }

  setExcludedBuildings(ids: ReadonlySet<string>): void {
    if (ids.size === this.excludedBuildings.size && [...ids].every(id => this.excludedBuildings.has(id))) return;
    this.excludedBuildings = ids;
    if (this.settings) this.update(this.settings);
  }

  private loadRoad(region: RoadRegion): void {
    const roads = region.roads.filter(r=>r.eligible && !this.loadedIds.has(r.id));
    if (!roads.length) return;
    const instances = roads.map(r=>new GeometryInstance({
      id: {sourceId:r.sourceId,segmentId:r.id,widthMetres:r.width,widthBasis:r.basis,inferred:true},
      geometry: new CorridorGeometry({
        positions: Cartesian3.fromDegreesArray(r.line.flatMap(([x,y])=>[x,y])),
        width:r.width, height:0.3, cornerType:CornerType.BEVELED,
        vertexFormat:MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }));
    region.near = this.collection.add(new Primitive({
      geometryInstances:instances,appearance:this.roadAppearance,releaseGeometryInstances:false,
    }));
    roads.forEach(r=>this.loadedIds.add(r.id));
  }

  private unloadRoad(region: RoadRegion): void {
    if (!region.near) return;
    this.collection.remove(region.near);
    region.near=undefined;
    region.roads.forEach(r=>this.loadedIds.delete(r.id));
  }

  private loadAccessories(tile: DetailTile, buildings: BuildingFeature[]): void {
    const instances: GeometryInstance[] = [];
    for (const building of buildings) {
      const result = buildingDetails(building);
      tile.diagnostics.push(...result.skipped);
      for (const piece of result.pieces) {
        const ring = piece.footprint[0].slice(0,-1).map(p=>unproject(p,result.origin));
        instances.push(new GeometryInstance({
          id: {...building.properties,detail:piece.kind,surface:piece.surface,inferred:true},
          attributes:{color:ColorGeometryInstanceAttribute.fromColor(
            Color.fromCssColorString(detailColors[piece.surface][this.settings?.night?1:0]))},
          geometry:new PolygonGeometry({
            polygonHierarchy:new PolygonHierarchy(Cartesian3.fromDegreesArray(ring.flat())),
            height:piece.top,extrudedHeight:piece.bottom,
            vertexFormat:PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
        }));
      }
    }
    tile.instances=instances;tile.night=this.settings?.night;
    if (instances.length) tile.primitive = this.collection.add(new Primitive({
      geometryInstances:instances,appearance:this.accessoryAppearance,releaseGeometryInstances:false,
    }));
  }

  private syncOverview(): void {
    if (this.disposed) return;
    for (const tile of this.tiles.values()) {
      if (!tile.primitive?.ready || tile.night===this.settings?.night) continue;
      for (const instance of tile.instances ?? []) {
        const surface=(instance.id as {surface:DetailSurface}).surface;
        const attributes=tile.primitive.getGeometryInstanceAttributes(instance.id);
        attributes.color=ColorGeometryInstanceAttribute.toValue(
          Color.fromCssColorString(detailColors[surface][this.settings?.night?1:0]),attributes.color);
      }
      tile.night=this.settings?.night;
      this.viewer.scene.requestRender();
    }
    if (!this.overview?.ready || this.disposed) return;
    let changed = false;
    for (const region of this.roadRegions.values()) {
      const show = !region.near?.ready || Boolean(this.failure);
      if (show===region.overviewVisible) continue;
      for (const road of region.roads) {
        if (!road.eligible) continue;
        const attributes = this.overview.getGeometryInstanceAttributes(road.id);
        attributes.show = ShowGeometryInstanceAttribute.toValue(show,attributes.show);
      }
      region.overviewVisible=show;
      changed=true;
    }
    if (changed) this.viewer.scene.requestRender();
  }

  private fail(error: unknown): void {
    if (this.failure || this.disposed) return;
    this.failure=error instanceof Error ? error : new Error(String(error));
    this.clearDistrictModels();
    for (const region of this.roadRegions.values()) this.unloadRoad(region);
    for (const tile of this.tiles.values()) {
      if (tile.primitive) this.collection.remove(tile.primitive);
      tile.primitive=undefined; tile.active.clear(); tile.diagnostics=[];
    }
    this.syncOverview();
    this.onError(`静态细节加载失败：${this.failure.message}。道路概览已恢复，可重试加载。`);
  }

  private failDistrict(error: unknown): void {
    if (this.districtFailure || this.disposed) return;
    this.districtFailure=error instanceof Error ? error : new Error(String(error));
    this.clearDistrictModels();
    this.onError(`金鸡湖街景加载失败：${this.districtFailure.message}。基础城市仍可浏览，可点击“重试加载”。`);
  }

  retry(): void {
    this.failure=undefined;
    this.districtFailure=undefined;
    if (this.settings) this.update(this.settings);
  }

  waitUntilReady(): Promise<void> {
    const start=performance.now();
    return new Promise((resolve,reject)=>{
      const check=()=>{
        if (this.disposed) return reject(new Error('细节图层已关闭。'));
        if (this.failure) return reject(this.failure);
        if (this.ready) return resolve();
        if (performance.now()-start>60_000) {
          this.fail(new Error('静态细节几何准备超时。'));
          return reject(this.failure);
        }
        this.viewer.scene.requestRender();
        setTimeout(check,50);
      };
      check();
    });
  }

  resourceCounts(): {primitives:number;models:number;cacheEntries:number} {
    return {primitives:this.disposed ? 0 : this.collection.length+Number(Boolean(this.overview)),
      models:this.districtModels.size,cacheEntries:this.tiles.size+this.loadedIds.size+this.districtURLs.size};
  }

  destroy(): void {
    if (this.disposed) return;
    this.unloadDistrict();
    this.disposed=true;
    this.removeRender();
    this.viewer.scene.primitives.remove(this.collection);
    if (this.overview) this.viewer.scene.primitives.remove(this.overview);
    this.tiles.clear(); this.roadRegions.clear(); this.loadedIds.clear(); this.diagnostics=[];
    this.overview=undefined;
  }
}
