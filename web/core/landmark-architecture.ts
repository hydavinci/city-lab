import type { ArchitectureMaterial, ArchitectureMeshWriter } from './architectural-mesh';
import { projectRings, type XY, type XYZ } from './architectural-geometry';
import type { ArchitectureLod } from './building-architecture';
import type { CityStyle } from './city-architecture';
import type { BuildingFeature } from './types';
import { landmarkFor, landmarkModel } from './landmarks';
import { localMesh } from './landmark-mesh';
import { gateTower, ifsTower } from './landmark-towers';
import { pagoda } from './landmark-pagodas';
import { suzhouCenter } from './landmark-mall';
import { skylineTower } from './landmark-skyline';
import { observationWheel } from './landmark-wheel';

function materials(id: string, skyline: boolean): ArchitectureMaterial[] {
  const wheel = id === 'suzhou-eye', pale = wheel || id.startsWith('hong-leong');
  const modern = skyline || wheel || id === 'gate-to-the-east' || id === 'suzhou-ifs', mall = id === 'suzhou-center';
  const brick = id === 'tiger-hill-pagoda';
  const create = (name: string, color: XYZ, metallic = 0, roughness = 0.8, emission?: XYZ): ArchitectureMaterial => ({
    name, pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: metallic, roughnessFactor: roughness },
    ...(emission ? { emissiveFactor: emission } : {}),
  });
  return [
    create('Wall', brick ? [0.48, 0.38, 0.28] : [0.78, 0.73, 0.61]),
    create('Roof', brick ? [0.38, 0.30, 0.23] : mall ? [0.68, 0.78, 0.78] : [0.16, 0.20, 0.22], mall ? 0.35 : 0),
    create('Frame', pale ? [0.84, 0.86, 0.84] : modern || mall ? [0.48, 0.53, 0.55] : [0.34, 0.12, 0.07], modern ? 0.5 : 0),
    create('Stone', brick ? [0.43, 0.35, 0.27] : [0.63, 0.62, 0.55]),
    create('Metal', [0.42, 0.46, 0.47], 0.55, 0.4),
    create('Window - warm', wheel ? [0.98, 0.77, 0.48] : [0.22, 0.37, 0.41],
      wheel ? 0.05 : 0.25, wheel ? 0.2 : 0.28, wheel ? [1, 0.78, 0.42] : [0.85, 0.55, 0.22]),
    create('Window - dark', modern || mall ? [0.15, 0.28, 0.33] : [0.075, 0.065, 0.05], modern ? 0.3 : 0, 0.35),
    create('Roof detail', mall ? [0.27, 0.39, 0.22] : [0.23, 0.27, 0.28]),
  ];
}

export function emitLandmark(mesh: ArchitectureMeshWriter, feature: BuildingFeature, lod: ArchitectureLod, origin: XY) {
  const landmark = landmarkFor(feature);
  if (!landmark) return undefined;
  const source = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const points = source.flatMap(rings => projectRings(rings, origin).flat());
  const minimum = [0, 1].map(axis => Math.min(...points.map(p => p[axis])));
  const maximum = [0, 1].map(axis => Math.max(...points.map(p => p[axis])));
  const center: XY = [(minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2];
  let style: CityStyle = 'historic';
  if (landmark.id === 'gate-to-the-east') {
    gateTower(localMesh(mesh, center, 101 * Math.PI / 180), lod);
    style = 'office';
  } else if (landmark.id === 'suzhou-ifs') {
    ifsTower(localMesh(mesh, center), lod);
    style = 'office';
  } else if (landmark.id === 'suzhou-center') {
    const site: XY = [120.674, 31.319], offset = projectRings([[site]], origin)[0][0];
    for (const rings of source) suzhouCenter(localMesh(mesh, offset), projectRings(rings, site), lod);
    style = 'commercial';
  } else if (landmark.skyline) {
    for (const rings of source) skylineTower(mesh, projectRings(rings, origin), landmark, lod);
    style = 'office';
  } else if (landmark.id === 'suzhou-eye') {
    observationWheel(localMesh(mesh, center, -38 * Math.PI / 180), lod);
    style = 'commercial';
  } else {
    const tiger = landmark.id === 'tiger-hill-pagoda';
    const radius = tiger ? 6.83 : Math.min(maximum[0] - minimum[0], maximum[1] - minimum[1]) * 0.48;
    const lean: XY = tiger ? [2.3 / Math.sqrt(2) / 48, 2.3 / Math.sqrt(2) / 48] : [0, 0];
    pagoda(localMesh(mesh, center, 0, lean), landmark.id, radius, lod);
  }
  return { origin, style, materials: materials(landmark.id, Boolean(landmark.skyline)), model: landmarkModel(landmark) };
}
