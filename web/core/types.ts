import type { Feature, MultiPolygon, Polygon } from 'geojson';

export type Bounds = [number, number, number, number];
export type HeightBasis = 'height' | 'levels' | 'fallback';
export interface BuildingProperties {
  id: string;
  name: string;
  kind: string;
  height: number;
  basis: HeightBasis;
  estimated: boolean;
}
export type BuildingFeature = Feature<Polygon | MultiPolygon, BuildingProperties>;
export interface TileInfo {
  id: string;
  bounds: Bounds;
  count: number;
}
export interface CityManifest {
  version: 1;
  dataset: string;
  generatedAt: string;
  osmTimestamp: string;
  boundaryId: number;
  bounds: Bounds;
  attribution: string;
  source: string;
  counts: {
    buildings: number;
    measured: number;
    levels: number;
    fallback: number;
    skipped: number;
    roads: number;
    water: number;
    green: number;
  };
  tiles: TileInfo[];
}
export interface SceneSettings {
  version: 1;
  night: boolean;
  glow: number;
  quality: 'low' | 'medium' | 'high';
  buildings: boolean;
  roads: boolean;
  water: boolean;
  green: boolean;
  boundary: boolean;
  labels: boolean;
}
export interface SceneStats {
  loadedTiles: number;
  loadedBuildings: number;
  loading: boolean;
  overview: boolean;
  height: number;
  longitude: number;
  latitude: number;
}
