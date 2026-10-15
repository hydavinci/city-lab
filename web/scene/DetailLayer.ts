import {
  BoundingSphere, Cartesian2, Cartesian3, Color, CorridorGeometry, CornerType,
  GeometryInstance, Material, MaterialAppearance, Math as CesiumMath,
  PolygonGeometry, PolygonHierarchy, PolylineGeometry, PolylineMaterialAppearance,
  Primitive, PrimitiveCollection, ShowGeometryInstanceAttribute, type Viewer,
} from 'cesium';
import type { FeatureCollection, Position } from 'geojson';
import type { Bounds, BuildingFeature, SceneSettings } from '../core/types';
import type { Diagnostic, Polygon2, XY } from '../core/enhancements';
import { accessoryFootprints, detailVisible } from '../core/detail';
import { geometryBounds, intersects, selectTiles, tileId } from '../core/geo';
import { unproject } from '../../pipeline/enhancements/geometry';
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
}

export class DetailLayer {
  private collection: PrimitiveCollection;
  private roadRegions = new Map<string, RoadRegion>();
  private tiles = new Map<string, DetailTile>();
  private loadedIds = new Set<string>();
  private overview?: Primitive;
  private diagnostics: Diagnostic[] = [];
  private settings?: SceneSettings;
  private failure?: Error;
  private disposed = false;
  private removeRender: () => void;
  private removeError: () => void;
  private roadAppearance = new MaterialAppearance({ material: colorMaterial('#70756e'), translucent: false, flat: true });
  private accessoryAppearance = new MaterialAppearance({ material: colorMaterial('#85918d'), translucent: false, closed: true });

  constructor(private viewer: Viewer, private onError: (message: string) => void) {
    this.collection = viewer.scene.primitives.add(new PrimitiveCollection());
    this.removeRender = viewer.scene.postRender.addEventListener(() => this.syncOverview());
    this.removeError = viewer.scene.renderError.addEventListener((_scene, error) => this.fail(error));
  }

  get ready(): boolean {
    if (this.failure || this.disposed) return false;
    for (let i=0;i<this.collection.length;i++) {
      const p = this.collection.get(i) as Primitive;
      if (p.show && !p.ready) return false;
    }
    return true;
  }

  setRoads(collection: FeatureCollection): void {
    if (this.disposed) return;
    for (const region of this.roadRegions.values()) this.unloadRoad(region);
    if (this.overview) this.collection.remove(this.overview);
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
    if (instances.length) this.overview = this.collection.add(new Primitive({
      geometryInstances: instances,
      appearance: new PolylineMaterialAppearance({material:Material.fromType('Color',{color:Color.fromCssColorString('#8f907c')})}),
    }));
    if (this.settings) this.update(this.settings);
  }

  setTile(id: string, buildings: BuildingFeature[]): void {
    if (this.disposed) return;
    this.removeTile(id);
    this.tiles.set(id,{buildings,active:new Set(),diagnostics:[]});
    if (this.settings) this.update(this.settings);
  }

  removeTile(id: string): void {
    const tile = this.tiles.get(id);
    if (tile?.primitive) this.collection.remove(tile.primitive);
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
    const wanted = new Set(near && settings.roads && !this.failure
      ? selectTiles([...this.roadRegions.values()],bounds,centre,{low:4,medium:8,high:14}[settings.quality])
        .filter(r=>detailVisible(Boolean(r.near),this.pixelsPerMetre(r.bounds,centre))).map(r=>r.id) : []);
    try {
      for (const region of this.roadRegions.values()) {
        if (!wanted.has(region.id)) this.unloadRoad(region);
        else if (!region.near) this.loadRoad(region);
      }
      for (const tile of this.tiles.values()) {
        const selected = near && settings.buildings && !this.failure ? tile.buildings.filter(b=>{
          const box = geometryBounds(b.geometry);
          return intersects(box,bounds) && detailVisible(tile.active.has(b.properties.id),this.pixelsPerMetre(box));
        }) : [];
        const ids = new Set(selected.map(b=>b.properties.id));
        if (ids.size===tile.active.size && [...ids].every(id=>tile.active.has(id))) continue;
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
    this.accessoryAppearance.material.uniforms.color = Color.fromCssColorString(settings.night ? '#283c42' : '#85918d');
    this.syncOverview();
    scene.requestRender();
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
      const result = accessoryFootprints(building);
      tile.diagnostics.push(...result.skipped);
      const append = (polygon: Polygon2, height: number, kind: string) => {
        const ring = polygon[0].slice(0,-1).map(p=>unproject(p,result.origin));
        instances.push(new GeometryInstance({
          id: {...building.properties,detail:kind,inferred:true},
          geometry:new PolygonGeometry({
            polygonHierarchy:new PolygonHierarchy(Cartesian3.fromDegreesArray(ring.flat())),
            height:building.properties.height+0.5+height,extrudedHeight:building.properties.height+0.5,
            vertexFormat:MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          }),
        }));
      };
      result.roofs.forEach(p=>append(p,0.8,'roof-unit/parapet'));
      result.entrances.forEach(p=>append(p,1.8,'roof-access'));
    }
    if (instances.length) tile.primitive = this.collection.add(new Primitive({
      geometryInstances:instances,appearance:this.accessoryAppearance,releaseGeometryInstances:false,
    }));
  }

  private syncOverview(): void {
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
    for (const region of this.roadRegions.values()) this.unloadRoad(region);
    for (const tile of this.tiles.values()) {
      if (tile.primitive) this.collection.remove(tile.primitive);
      tile.primitive=undefined; tile.active.clear(); tile.diagnostics=[];
    }
    this.syncOverview();
    this.onError(`静态细节加载失败：${this.failure.message}。道路概览已恢复，可重试加载。`);
  }

  retry(): void {
    this.failure=undefined;
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
    return {primitives:this.disposed ? 0 : this.collection.length,models:0,cacheEntries:this.tiles.size+this.loadedIds.size};
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed=true;
    this.removeRender(); this.removeError();
    this.viewer.scene.primitives.remove(this.collection);
    this.tiles.clear(); this.roadRegions.clear(); this.loadedIds.clear(); this.diagnostics=[];
    this.overview=undefined;
  }
}
