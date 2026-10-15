import { Cartesian3, Color, Material, Matrix3, Matrix4, Transforms } from 'cesium';
import { facadeKinds, type FacadeKind } from '../core/detail';

const FACADE_ORIGIN = Cartesian3.fromDegrees(120.65, 31.32);
const origin = [FACADE_ORIGIN.x, FACADE_ORIGIN.y, FACADE_ORIGIN.z];
// Multiples of 2^16 are exactly representable; the remainder retains sub-metre precision.
const high = origin.map((n) => Math.trunc(n / 65536) * 65536);
const originHigh = high.map((n) => n.toFixed(9)).join(', ');
const originLow = origin.map((n, i) => (n - high[i]).toFixed(9)).join(', ');

export const facadeVertexShader = `
  in vec3 position3DHigh;
  in vec3 position3DLow;
  in vec3 normal;
  in vec2 st;
  in float batchId;
  out vec3 v_positionEC;
  out vec3 v_normalEC;
  out vec2 v_st;
  out vec3 v_facadePosition;
  void main() {
    vec4 position = czm_computePosition();
    v_positionEC = (czm_modelViewRelativeToEye * position).xyz;
    v_normalEC = czm_normal * normal;
    v_st = st;
    // Camera-independent, locally anchored coordinates retain metre-scale facade detail.
    v_facadePosition = (position3DHigh - vec3(${originHigh}))
      + (position3DLow - vec3(${originLow}));
    gl_Position = czm_modelViewProjectionRelativeToEye * position;
  }
`;

export function buildingMaterial(night: boolean, glow: number, kind: FacadeKind = 'residential'): Material {
  const basis = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(FACADE_ORIGIN), new Matrix3());
  const profiles = {
    residential: { bay:4.2, floor:3.4, pane:0.27, color:'#abb8b3' },
    office: { bay:3.2, floor:3.8, pane:0.38, color:'#92aeb8' },
    commercial: { bay:5.2, floor:4.2, pane:0.34, color:'#b6b1a1' },
    industrial: { bay:6.4, floor:5.0, pane:0.20, color:'#a4aca9' },
  };
  const profile = profiles[kind];
  return new Material({
    fabric: {
      type: 'SuzhouFacade',
      uniforms: {
        nightMode: night ? 1 : 0,
        glow,
        profile: facadeKinds.indexOf(kind),
        bayWidth: profile.bay,
        floorHeight: profile.floor,
        paneHalfWidth: profile.pane,
        facadeColor: Color.fromCssColorString(profile.color),
        east: Matrix3.getColumn(basis, 0, new Cartesian3()),
        north: Matrix3.getColumn(basis, 1, new Cartesian3()),
        up: Matrix3.getColumn(basis, 2, new Cartesian3()),
      },
      source: `
        in vec3 v_facadePosition;
        float windowHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec3 normal = normalize(czm_inverseViewRotation * materialInput.normalEC);
          vec3 delta = v_facadePosition;
          float roof = step(0.65, abs(dot(normal, up)));
          float horizontal = abs(dot(normal, east)) > abs(dot(normal, north))
            ? dot(delta, north) : dot(delta, east);
          vec2 grid = vec2(horizontal / bayWidth, dot(delta, up) / floorHeight);
          vec2 cell = fract(grid);
          vec2 footprint = max(fwidth(grid), vec2(0.0001));
          vec2 aa = footprint * 0.5;
          vec2 paneLo = vec2(0.5 - paneHalfWidth, 0.22);
          vec2 paneHi = vec2(0.5 + paneHalfWidth, 0.73);
          vec2 paneMask = smoothstep(paneLo - aa, paneLo + aa, cell)
            * (1.0 - smoothstep(paneHi - aa, paneHi + aa, cell));
          vec2 frameMask = smoothstep(paneLo - vec2(0.035) - aa, paneLo - vec2(0.035) + aa, cell)
            * (1.0 - smoothstep(paneHi + vec2(0.035) - aa, paneHi + vec2(0.035) + aa, cell));
          float detail = 1.0 - smoothstep(0.25, 0.85, max(footprint.x, footprint.y));
          float occupancy = step(0.48, windowHash(floor(grid)));
          // Unresolved windows converge to their average light instead of flickering single pixels.
          float lit = mix(0.143, occupancy * paneMask.x * paneMask.y, detail) * (1.0 - roof);
          float pane = paneMask.x * paneMask.y;
          float frame = max(0.0, frameMask.x * frameMask.y - pane);
          float floorBand = 1.0 - smoothstep(0.035 - aa.y, 0.035 + aa.y, min(cell.y, 1.0 - cell.y));
          float wallDetail = detail * (1.0 - roof);
          vec3 dayColor = mix(facadeColor.rgb, vec3(0.28, 0.39, 0.40), roof);
          dayColor = mix(dayColor, vec3(0.72, 0.77, 0.75), frame * wallDetail);
          dayColor = mix(dayColor, vec3(0.22, 0.34, 0.39), pane * wallDetail);
          dayColor = mix(dayColor, facadeColor.rgb * 0.64, floorBand * wallDetail);
          vec3 nightColor = mix(vec3(0.16, 0.21, 0.24), vec3(0.10, 0.17, 0.20), roof);
          m.diffuse = mix(dayColor, nightColor, nightMode);
          m.emission = nightMode * (nightColor * 0.25
            + lit * vec3(1.0, 0.76, 0.45) * glow * 1.3);
          m.specular = 0.12;
          m.shininess = 12.0;
          m.alpha = 1.0;
          return m;
        }
      `,
    },
  });
}

export function colorMaterial(color: string): Material {
  return Material.fromType('Color', { color: Color.fromCssColorString(color) });
}
