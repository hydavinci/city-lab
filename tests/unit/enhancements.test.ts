import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnhancementManifest, parseNetwork } from '../../web/core/enhancements';
import { fetchDistrict } from '../../pipeline/enhancements/fetch';
import { manifest, network, overpass, routeFixture, publicationFixture, crossingFixture } from '../fixtures/enhancements';
import type { Polygon2, XY } from '../../web/core/enhancements';
import { project, unproject, sweptEnvelope, validateEnvelope } from '../../pipeline/enhancements/geometry';
import { capacity, compileNetwork } from '../../pipeline/enhancements/routes';
import { buildEnhancements } from '../../pipeline/enhancements/build';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

it('rejects malformed data rather than producing an empty successful layer', () => {
  expect(() => parseNetwork({ edges: [] })).toThrow();
  expect(() => parseEnhancementManifest({ version: 99, baseDataset: manifest.baseDataset }, manifest.baseDataset)).toThrow();
});

describe('immutable enhancement publication', () => {
  let root: string;
  const fixture = publicationFixture;
  let data: ReturnType<typeof fixture>;
  let options: Parameters<typeof buildEnhancements>[0];
  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.release-test-'));
    data = fixture();
    options = { rawDir: join(root,'raw'), selectionPath: join(root,'selection.json'),
      baseDir: join(root,'base'), assetDir: join(root,'assets'), outputDir: join(root,'output'), publish: true };
    await Promise.all([mkdir(options.rawDir), mkdir(options.assetDir),
      mkdir(join(options.baseDir,data.base.dataset,'tiles'), {recursive:true})]);
    const save = (path: string, value: unknown) => writeFile(path,JSON.stringify(value));
    await Promise.all([
      save(options.selectionPath,data.selection),save(join(options.rawDir,'district.json'),data.cache),
      save(join(options.baseDir,'manifest.json'),data.base),
      save(join(options.baseDir,data.base.dataset,'tiles','fixture.json'),data.buildings),
      save(join(options.baseDir,data.base.dataset,'surface.json'),data.surface),
      save(join(options.assetDir,'assets.json'),data.assets),save(join(options.assetDir,'placements.json'),data.placements),
      ...data.assets.map(a=>writeFile(join(options.assetDir,a.uri),data.glb)),
    ]);
  });
  afterEach(async () => { await rm(root,{recursive:true,force:true}); });
  it('stages the real compiler output without a public manifest or asset dependency', async () => {
    await rm(options.assetDir,{recursive:true});
    const result=await buildEnhancements({...options,publish:false});
    expect('candidate' in result).toBe(true);
    expect(await readdir(options.outputDir)).toEqual(['candidate.json']);
    expect(JSON.parse(await readFile(join(options.outputDir,'candidate.json'),'utf8')).provenance.obstacleFiles).toHaveLength(2);
  });
  it('publishes a complete package, reuses immutable bytes and excludes generation time from identity', async () => {
    const first=await buildEnhancements(options);
    expect('id' in first).toBe(true);
    if(!('id' in first)) throw new Error('Expected release');
    expect(parseEnhancementManifest(first,data.base.dataset)).toEqual(first);
    const before=await readFile(join(options.outputDir,first.network));
    const second=await buildEnhancements(options);
    expect('id' in second && second.id).toBe(first.id);
    expect(await readFile(join(options.outputDir,first.network))).toEqual(before);
    expect((await readdir(options.outputDir)).sort()).toEqual([first.id,'manifest.json'].sort());
  });
  it.each(['missing asset','bad hash','invalid GLB','oversized GLB','missing placement','invalid geometry',
    'route obstruction','misplaced asset','immutable collision','empty immutable collision'])(
    'preserves the old manifest and immutable bytes after %s failure', async failure => {
      const first=await buildEnhancements(options);
      if(!('id' in first)) throw new Error('Expected release');
      const oldManifest=await readFile(join(options.outputDir,'manifest.json'));
      const target=join(options.outputDir,first.network);
      if(failure==='missing asset') await rm(join(options.assetDir,'car-a.glb'));
      if(failure==='bad hash') await writeFile(join(options.assetDir,'car-a.glb'),'corrupt');
      if(failure==='invalid GLB') {
        const bytes=Buffer.from(data.glb);bytes.writeUInt32LE(1,4);
        const {createHash}=await import('node:crypto');
        data.assets[0].sha256=createHash('sha256').update(bytes).digest('hex');
        await writeFile(join(options.assetDir,'assets.json'),JSON.stringify(data.assets));
        await writeFile(join(options.assetDir,'car-a.glb'),bytes);
      }
      if(failure==='oversized GLB') {
        const bytes=Buffer.from(data.glb);bytes.writeFloatLE(50,bytes.length-24);
        const {createHash}=await import('node:crypto');
        data.assets[0].sha256=createHash('sha256').update(bytes).digest('hex');
        await writeFile(join(options.assetDir,'assets.json'),JSON.stringify(data.assets));
        await writeFile(join(options.assetDir,'car-a.glb'),bytes);
      }
      if(failure==='missing placement') await writeFile(join(options.assetDir,'placements.json'),'[]');
      if(failure==='invalid geometry') {
        data.placements[0].footprint=[[[250,250],[251,250],[251,251],[250,251],[250,250]]];
        await writeFile(join(options.assetDir,'placements.json'),JSON.stringify(data.placements));
      }
      if(failure==='route obstruction') {
        data.placements[0].position=[-100,350];
        data.placements[0].footprint=[[[-100.26,349.74],[-99.74,349.74],[-99.74,350.26],[-100.26,350.26],[-100.26,349.74]]];
        await writeFile(join(options.assetDir,'placements.json'),JSON.stringify(data.placements));
      }
      if(failure==='misplaced asset') {
        data.placements[0].position=[200,200];
        await writeFile(join(options.assetDir,'placements.json'),JSON.stringify(data.placements));
      }
      if(failure==='immutable collision') await writeFile(target,'tampered immutable bytes');
      if(failure==='empty immutable collision') {
        await rm(join(options.outputDir,first.id),{recursive:true});
        await mkdir(join(options.outputDir,first.id));
      }
      const oldNetwork=failure==='empty immutable collision'?null:await readFile(target);
      await expect(buildEnhancements(options)).rejects.toThrow();
      expect(await readFile(join(options.outputDir,'manifest.json'))).toEqual(oldManifest);
      if(oldNetwork) expect(await readFile(target)).toEqual(oldNetwork);
      else expect(await readdir(join(options.outputDir,first.id))).toEqual([]);
      expect((await readdir(options.outputDir)).sort()).toEqual([first.id,'manifest.json'].sort());
    });
});

it('round-trips valid manifest and metre network including polygon holes', () => {
  expect(parseEnhancementManifest(JSON.parse(JSON.stringify(manifest)), manifest.baseDataset)).toEqual(manifest);
  expect(parseNetwork(JSON.parse(JSON.stringify(network)))).toEqual(network);
});

const manifestMutations: [string, (m: any) => void][] = [
  ['version', m => { m.version = 2; }],
  ['dataset mismatch', m => { m.baseDataset = 'ffffffffffffffff'; }],
  ['missing dataset', m => { delete m.baseDataset; }],
  ['empty ID', m => { m.id = ''; }],
  ['whitespace ID', m => { m.id = ' bad id '; }],
  ['invalid timestamp', m => { m.generatedAt = 'yesterday'; }],
  ['impossible timestamp date', m => { m.generatedAt = '2026-02-31T00:00:00Z'; }],
  ['reversed bounds', m => { m.bounds = [121, 32, 120, 31]; }],
  ['longitude', m => { m.bounds[0] = -181; }],
  ['latitude', m => { m.bounds[3] = 91; }],
  ['bounds arity', m => { m.bounds.push(0); }],
  ['NaN coordinate', m => { m.showcase.target[0] = NaN; }],
  ['showcase latitude', m => { m.showcase.target[1] = 91; }],
  ['showcase heading', m => { m.showcase.heading = Infinity; }],
  ['showcase pitch', m => { m.showcase.pitch = '0'; }],
  ['showcase range', m => { m.showcase.range = 0; }],
  ['asset kind', m => { m.assets[0].kind = 'truck'; }],
  ['duplicate asset kind', m => { m.assets.push(m.assets[0]); }],
  ['hash', m => { m.assets[0].sha256 = 'not-a-hash'; }],
  ['byte count', m => { m.assets[0].bytes = 1.5; }],
  ['zero bytes', m => { m.assets[0].bytes = 0; }],
  ['negative size', m => { m.assets[0].size[0] = -1; }],
  ['zero size', m => { m.assets[0].size[1] = 0; }],
  ['size arity', m => { m.assets[0].size = [1, 2]; }],
  ['nonfinite size', m => { m.assets[0].size[2] = Infinity; }],
  ['animation type', m => { m.assets[0].animation = 4; }],
];
it.each(manifestMutations)('rejects manifest %s', (_, mutate) => {
  const value = structuredClone(manifest); mutate(value);
  expect(() => parseEnhancementManifest(value, manifest.baseDataset)).toThrow();
});

it.each(['https://example.com/a', '//example.com/a', '/a', '../a', 'a/../b', 'a/%2e%2e/b',
  'a/%252e%252e/b', 'a\\b', 'a?x=1', 'a#x', 'data:x', '', './a', 'a//b', 'a/%2f/b'])(
  'rejects unsafe package path %s in every resource field', path => {
    for (const field of ['network', 'roads', 'provenance', 'placements']) {
      expect(() => parseEnhancementManifest({ ...manifest, [field]: path }, manifest.baseDataset)).toThrow();
    }
    const value = structuredClone(manifest); value.assets[0].uri = path;
    expect(() => parseEnhancementManifest(value, manifest.baseDataset)).toThrow();
  });

const networkMutations: [string, (n: any) => void][] = [
  ['missing field', n => { delete n.water; }],
  ['invalid origin', n => { n.origin = [181, 0]; }],
  ['nonfinite bounds', n => { n.bounds[0] = Infinity; }],
  ['empty edges', n => { n.edges = []; }],
  ['empty routes', n => { n.routes = []; }],
  ['duplicate edge ID', n => { n.edges[1].id = 'a'; }],
  ['whitespace edge ID', n => { n.edges[0].id = ' bad id '; }],
  ['empty source IDs', n => { n.edges[0].sourceIds = []; }],
  ['invalid source ID', n => { n.edges[0].sourceIds = ['']; }],
  ['whitespace source ID', n => { n.edges[0].sourceIds = ['way/ 101']; }],
  ['empty endpoint', n => { n.edges[0].from = ''; }],
  ['whitespace endpoint', n => { n.edges[0].from = 'bad node'; }],
  ['mode', n => { n.edges[0].mode = 'fly'; }],
  ['zero length', n => { n.edges[0].length = 0; }],
  ['negative width', n => { n.edges[0].width = -1; }],
  ['zero speed', n => { n.edges[0].speed = 0; }],
  ['nonfinite speed', n => { n.edges[0].speed = Infinity; }],
  ['nonfinite point', n => { n.edges[0].points[0][0] = NaN; }],
  ['point arity', n => { n.edges[0].points[0] = [0, 0, 0]; }],
  ['short line', n => { n.edges[0].points = [[0, 0]]; }],
  ['zero segment', n => { n.edges[0].points = [[0, 0], [0, 0]]; }],
  ['length mismatch', n => { n.edges[0].length = 1; }],
  ['empty allowed actors', n => { n.edges[0].allowed = []; }],
  ['wrong actor mode', n => { n.edges[0].allowed = ['person-a']; }],
  ['unknown actor', n => { n.edges[0].allowed = ['truck']; }],
  ['dangling successor', n => { n.edges[0].next = ['missing']; }],
  ['mode transition', n => { n.edges[0].next = ['w']; }],
  ['disconnected successor', n => { n.edges[1].from = 'other'; }],
  ['inconsistent shared node geometry', n => { n.edges[1].points = [[41, 0], [81, 0]]; }],
  ['empty corridor', n => { n.edges[0].corridor = []; }],
  ['invalid inferred labels', n => { n.edges[0].inferred = [1]; }],
  ['dangling conflict zone', n => { n.edges[0].conflicts[0].zone = 'missing'; }],
  ['negative conflict interval', n => { n.edges[0].conflicts[0].enter = -1; }],
  ['reversed conflict interval', n => { n.edges[0].conflicts[0].exit = 34; }],
  ['conflict beyond edge', n => { n.edges[0].conflicts[0].exit = 41; }],
  ['duplicate zone ID', n => { n.zones.push(n.zones[0]); }],
  ['dangling zone edge', n => { n.zones[0].edges.push('missing'); }],
  ['inconsistent zone membership', n => { n.zones[0].edges = ['w']; }],
  ['missing conflict membership', n => { n.edges[0].conflicts = []; }],
  ['duplicate route ID', n => { n.routes[1].id = 'drive'; }],
  ['empty route', n => { n.routes[0].edges = []; }],
  ['dangling route edge', n => { n.routes[0].edges = ['missing']; }],
  ['mixed route modes', n => { n.routes[0].edges.push('w'); }],
  ['route lacking next link', n => { n.edges[0].next = []; }],
  ['route entry mismatch', n => { n.routes[0].entry = 'b'; }],
  ['route exit mismatch', n => { n.routes[0].exit = 'a'; }],
  ['route actor unsupported by edge', n => { n.routes[0].allowed = ['bus']; }],
];
it.each(networkMutations)('rejects network %s', (_, mutate) => {
  const value = structuredClone(network); mutate(value);
  expect(() => parseNetwork(value)).toThrow();
});

it.each([
  [], [[]], [[[0, 0], [1, 0], [0, 0]]],
  [[[0, 0], [1, 0], [1, 1], [0, 1]]],
  [[[0, 0], [1, 0], [2, 0], [0, 0]]],
  [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]],
  [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[4, 4], [5, 4], [5, 5], [4, 4]]],
  [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[0, 1], [1, 1], [1, 2], [0, 1]]],
  [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]], [[2, 2], [2.5, 2], [2.5, 2.5], [2, 2]]],
].map(polygon => ({ polygon })))('rejects invalid polygons in all polygon-bearing fields (%j)', ({ polygon }) => {
  for (const field of ['buildings', 'water', 'corridor', 'zone']) {
    const value: any = structuredClone(network);
    if (field === 'corridor') value.edges[0].corridor = [polygon];
    else if (field === 'zone') value.zones[0].polygon = polygon;
    else value[field as 'buildings' | 'water'] = [polygon];
    expect(() => parseNetwork(value)).toThrow();
  }
});

describe('explicit district preparation cache', () => {
  let cacheDir: string;
  const bounds: [number, number, number, number] = [120.671, 31.308, 120.691, 31.330];
  const response = () => new Response(JSON.stringify(overpass));
  beforeEach(async () => { cacheDir = await mkdtemp(join(process.cwd(), '.district-test-')); });
  afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(cacheDir, { recursive: true, force: true }); });
  const prepare = (refresh = false) => fetchDistrict({ bounds, cacheDir, refresh });

  it('writes complete source and metadata, reuses valid cache without network, and refreshes explicitly', async () => {
    vi.stubEnv('OVERPASS_ENDPOINT', 'https://example.org/api/interpreter');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(String(init.body)).toContain('highway');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return response();
    }));
    await prepare();
    const cached = JSON.parse(await readFile(join(cacheDir, 'district.json'), 'utf8'));
    expect(cached.response).toEqual(overpass);
    expect(cached.metadata).toMatchObject({
      bounds, endpoint: 'example.org', osmSnapshot: '2026-10-14T00:00:00Z',
    });
    expect(cached.metadata.query).toContain('(._;>>;);out body;');
    expect(Number.isFinite(Date.parse(cached.metadata.fetchedAt))).toBe(true);
    vi.stubGlobal('fetch', () => { throw new Error('unexpected network'); });
    await prepare();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...overpass, generator: 'refreshed' })));
    await prepare(true);
    expect(JSON.parse(await readFile(join(cacheDir, 'district.json'), 'utf8')).response.generator).toBe('refreshed');
  });

    const box = (x0: number, y0: number, x1: number, y1: number): Polygon2 =>
      [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];

    describe('full-body metre geometry', () => {
      it('projects metres and restores WGS84', () => {
        expect(project([0.001, 0.001], [0, 0])[0]).toBeCloseTo(111.3194908, 5);
        expect(unproject(project([120.68, 31.32], [120.675, 31.315]), [120.675, 31.315]))
          .toEqual([120.68, 31.32]);
      });
      it('rejects an obstacle enclosed by the body and an obstacle crossing clear body vertices', () => {
        const body = box(-5, -1, 5, 1), road = box(-10, -4, 10, 4);
        expect(() => validateEnvelope([body], [road], [box(-1, -0.5, 1, 0.5)], [])).toThrow();
        expect(() => validateEnvelope([body], [road], [box(-1, -3, 1, 3)], [])).toThrow();
      });
      it('preserves holes and concavity in both obstacles and the corridor union', () => {
        const donut = [...box(-10, -10, 10, 10), ...box(-3, -3, 3, 3)];
        expect(() => validateEnvelope([box(-1, -1, 1, 1)], [box(-20, -20, 20, 20)], [donut], [])).not.toThrow();
        expect(() => validateEnvelope([box(-4, -4, 4, 4)], [donut], [], [])).toThrow();
        const concave: Polygon2 = [[[-5,-5],[5,-5],[5,5],[2,5],[2,-2],[-2,-2],[-2,5],[-5,5],[-5,-5]]];
        expect(() => validateEnvelope([box(-4, 0, 4, 1)], [concave], [], [])).toThrow();
        expect(() => validateEnvelope([box(-4, 0, 4, 1)], [box(-10,-10,10,10)], [concave], [])).toThrow();
        expect(() => validateEnvelope([box(-2,-1,2,1)], [box(-3,-2,0.1,2), box(-0.1,-2,3,2)], [], [])).not.toThrow();
      });
      it('checks between samples and inflates the body conservatively by one millimetre', () => {
        const sweep = sweptEnvelope([[-5,0],[5,0]], 4.4, 1.8);
        expect(() => validateEnvelope(sweep, [box(-10,-2,10,2)], [], [box(-0.1,-0.1,0.1,0.1)])).toThrow();
        expect(() => validateEnvelope(sweep, [box(-10,-0.9005,10,0.9005)], [], [])).toThrow();
        expect(() => validateEnvelope(sweptEnvelope([[-5,0],[5,0]], 0.6, 0.6),
          [box(-10,-0.4,10,0.4)], [], [])).not.toThrow();
      });
      it('checks rotation swept between bends, not merely endpoint poses', () => {
        expect(() => validateEnvelope(sweptEnvelope([[-5,0],[0,0],[0,5]], 10, 2.5),
          [box(-11,-1.5,1.5,1.5), box(-1.5,-1.5,1.5,11)], [], [])).toThrow();
      });
    });

    describe('sourced route compilation', () => {
      it('compiles directed right-hand lanes, curved shared-node turns and separate footways', () => {
        const { source, selection } = routeFixture();
        const { network: n } = compileNetwork(source, selection, [], []);
        expect(parseNetwork(n)).toEqual(n);
        expect(n.edges.some(e => e.mode === 'drive' && e.points[0][1] < 0)).toBe(true);
        const turns = n.edges.filter(e => e.id.startsWith('turn/'));
        expect(turns.length).toBeGreaterThan(0);
        expect(turns.some(e => e.sourceIds.includes('way/101') && e.sourceIds.includes('way/102'))).toBe(true);
        for (const e of turns) for (let i = 1; i < e.points.length; i++) {
          expect(Math.hypot(e.points[i][0]-e.points[i-1][0], e.points[i][1]-e.points[i-1][1])).toBeLessThanOrEqual(0.250001);
        }
        expect(n.zones.some(z => z.edges.filter(id => n.edges.find(e => e.id === id)?.mode === 'drive').length >= 2)).toBe(true);
        expect(n.routes.some(r => r.mode === 'walk')).toBe(true);
      });
      it('does not join mere XY intersections with different source node IDs', () => {
        const { source, selection } = routeFixture();
        source.elements.push({ ...source.elements[1], id: 8 });
        source.elements.find(e => e.id === 102).nodes = [4,8,5];
        selection.driveWays[1].nodeIds = [4,8,5];
        const { network: n } = compileNetwork(source, selection, [], []);
        expect(n.edges.some(e => e.id.startsWith('turn/') && e.sourceIds.includes('way/101') && e.sourceIds.includes('way/102'))).toBe(false);
      });
      it('excludes a walking path crossing driving geometry without sourced crossing evidence', () => {
        const { source, selection } = routeFixture();
        for (const id of [6, 7]) source.elements.find(e => e.id === id).lat = 100 / 111319.49079327358;
        const result = compileNetwork(source, selection, [], []);
        expect(result.network.routes.every(r => r.mode === 'drive')).toBe(true);
        expect(result.diagnostics.some(d => d.code === 'UNSOURCED_CROSSING')).toBe(true);
      });
      it('joins an explicitly sourced crossing and gives pedestrian and vehicle bodies the same physical zone', () => {
        const { source, selection } = crossingFixture();
        const n = compileNetwork(source, selection, [], []).network;
        expect(n.routes.some(r => r.mode === 'walk' && r.edges.some(id => id.includes('way/104')))).toBe(true);
        const shared = n.zones.filter(z => z.edges.some(id => n.edges.find(e => e.id === id)?.mode === 'walk'));
        expect(shared.length).toBeGreaterThan(0);
        expect(shared.every(z => z.edges.some(id => n.edges.find(e => e.id === id)?.mode === 'drive'))).toBe(true);
        expect(shared.every(z => z.edges.every(id => n.edges.find(e => e.id === id)!.conflicts.some(c => c.zone === z.id)))).toBe(true);
      });
      it('rejects a disconnected crossing even if its endpoints have nearby coordinates', () => {
        const { source, selection } = crossingFixture();
        selection.crossings[0].to.node = 'node/7';
        expect(() => compileNetwork(source, selection, [], [])).toThrow(/Disconnected crossing/);
      });
      it('excludes prohibited foot access and permits a legal narrow footway but not a bus', () => {
        const { source, selection } = routeFixture();
        source.elements.find(e => e.id === 103).tags.width = '0.8';
        selection.walkWays[0].tags.width = '0.8';
        const n = compileNetwork(source, selection, [], []).network;
        expect(n.routes.some(r => r.mode === 'walk')).toBe(true);
        expect(n.edges.filter(e => e.mode === 'walk').every(e => !e.allowed.includes('bus'))).toBe(true);
        source.elements.find(e => e.id === 103).tags.foot = 'no';
        Object.assign(selection.walkWays[0].tags,{foot:'no'});
        expect(compileNetwork(source, selection, [], []).network.routes.every(r => r.mode === 'drive')).toBe(true);
      });
      it('excludes buses from narrow curved turns and rejects turns whose intermediate sweep enters water', () => {
        const { source, selection } = routeFixture();
        const n = compileNetwork(source, selection, [], []).network;
        const turn = n.edges.find(e => e.id.startsWith('turn/') && e.sourceIds.includes('way/101')
          && e.sourceIds.includes('way/102') && e.allowed.includes('car-a'))!;
        expect(turn).toBeDefined();
        expect(turn.allowed).not.toContain('bus');
        const middle = turn.points[Math.floor(turn.points.length / 2)];
        const water: Polygon2 = [[[middle[0]-.01,middle[1]-.01],[middle[0]+.01,middle[1]-.01],
          [middle[0]+.01,middle[1]+.01],[middle[0]-.01,middle[1]+.01],[middle[0]-.01,middle[1]-.01]]];
        expect(compileNetwork(source, selection, [], [water]).network.edges.some(e => e.id === turn.id)).toBe(false);
      });
      it('retains approach storage outside local swept-body conflict extents', () => {
        const {source,selection}=routeFixture();
        const n=compileNetwork(source,selection,[],[]).network;
        expect(capacity(n).vehicles).toBeGreaterThanOrEqual(20);
        expect(capacity(n).pedestrians).toBeGreaterThanOrEqual(30);
        expect(n.zones.every(z=>Math.max(...z.polygon[0].map(p=>Math.abs(p[0])))<50)).toBe(true);
      });
      it('counts contiguous storage without losing endpoint margins at every source node', () => {
        const {source,selection}=routeFixture();
        const n=compileNetwork(source,selection,[],[]).network;
        const edge=n.edges.find(e=>e.mode==='drive' && !e.id.startsWith('turn/'))!;
        const a={...edge,id:'storage-a',points:[[0,0],[40,0]] as XY[],length:40,conflicts:[],next:['storage-b']};
        const b={...a,id:'storage-b',points:[[40,0],[80,0]] as XY[],next:[]};
        const route={...n.routes.find(r=>r.mode==='drive')!,edges:[a.id,b.id],entry:a.id,exit:b.id};
        expect(capacity({...n,edges:[a,b],routes:[route],zones:[]}).vehicles).toBe(5);
      });
      it.each([{bridge:'yes'}, {tunnel:'yes'}, {layer:'1'}, {access:'no'}, {motor_vehicle:'no'},
        {access:'destination'}, {motorcar:'no'}, {bus:'no'},
        {'turn:lanes:forward':'left|left|through|through'},
        {'turn:lanes:backward':'invalid'}, {oneway:'-1','turn:lanes':'left|left|through|through'},
        {oneway:'no','turn:lanes':'left|left|through|through'}, {width:'4wat'}, {maxspeed:'fast'}])(
        'excludes unsupported or invalid drive tags %j with diagnostics', tags => {
          const { source, selection } = routeFixture();
          Object.assign(source.elements.find(e => e.id === 101).tags, tags);
          Object.assign(selection.driveWays[0].tags, tags);
          const result = compileNetwork(source, selection, [], []);
          expect(result.network.edges.some(e => e.sourceIds.includes('way/101'))).toBe(false);
          expect(result.diagnostics.some(d => d.sourceIds.includes('way/101'))).toBe(true);
        });
        it.each([{'oneway:foot':'yes'}, {foot:'destination'}])('excludes unsupported walking permissions %j', tags => {
          const { source, selection } = routeFixture();
          Object.assign(source.elements.find(e => e.id === 103).tags,tags);
          Object.assign(selection.walkWays[0].tags,tags);
          const result = compileNetwork(source,selection,[],[]);
          expect(result.network.edges.some(e => e.sourceIds.includes('way/103'))).toBe(false);
          expect(result.diagnostics.some(d => d.sourceIds.includes('way/103'))).toBe(true);
        });
      it('honours reverse oneway, parses mph, and never infers a missing sidewalk', () => {
        const { source, selection } = routeFixture();
        Object.assign(source.elements.find(e => e.id === 101).tags, {oneway:'-1', maxspeed:'10 mph'});
        Object.assign(selection.driveWays[0].tags, {oneway:'-1', maxspeed:'10 mph'});
        const n = compileNetwork(source, selection, [], []).network;
        const edges = n.edges.filter(e => e.sourceIds.includes('way/101') && !e.id.startsWith('turn/'));
        expect(edges.every(e => e.points[0][0] > e.points.at(-1)![0])).toBe(true);
        expect(edges[0].speed).toBeCloseTo(4.4704);
        expect(n.edges.filter(e => e.mode === 'walk').every(e => e.sourceIds.includes('way/103'))).toBe(true);
      });
      it.each(['no_right_turn', 'only_straight_on'])('honours via-node %s restrictions', restriction => {
        const { source, selection } = routeFixture();
        source.elements.push({type:'relation', id:201, tags:{type:'restriction',restriction},
          members:[{type:'way',ref:101,role:'from'}, {type:'node',ref:2,role:'via'},
            {type:'way',ref:restriction.startsWith('only') ? 101 : 102,role:'to'}]});
        const n = compileNetwork(source, selection, [], []).network;
        expect(n.edges.some(e => e.id.startsWith('turn/') && e.sourceIds.includes('way/101') && e.sourceIds.includes('way/102')
          && e.from.includes('way/101'))).toBe(false);
      });
      it('does not turn left onto the named to-way of an only-right restriction', () => {
        const { source, selection } = routeFixture();
        source.elements.push({type:'relation', id:201, tags:{type:'restriction',restriction:'only_right_turn'},
          members:[{type:'way',ref:101,role:'from'}, {type:'node',ref:2,role:'via'}, {type:'way',ref:102,role:'to'}]});
        const n = compileNetwork(source, selection, [], []).network;
        expect(n.edges.some(e => e.id.startsWith('turn/') && e.from.includes('way/101')
          && e.sourceIds.includes('way/102'))).toBe(false);
      });
      it('never uses an untagged connector to evade a through-only approach lane', () => {
        const { source, selection } = routeFixture();
        const apply = (id: number, tags: Record<string,string>) => {
          Object.assign(source.elements.find(e => e.id === id).tags,tags);
          Object.assign(selection.driveWays.find(e => e.id === `way/${id}`)!.tags,tags);
        };
        apply(101,{name:'Through Street','turn:lanes':'left|left|through|through'});
        apply(102,{name:'Cross Street'});
        // A short, shallow-angle continuation can pass the immediate through test.
        source.elements.push({type:'node',id:8,lon:10/111319.49079327358,lat:0},
          {type:'way',id:104,nodes:[2,8],tags:{highway:'residential',oneway:'yes',lanes:'4',name:'Through Street'}});
        selection.driveWays.push({id:'way/104',nodeIds:[2,8],tags:{highway:'residential',oneway:'yes',lanes:'4',name:'Through Street'}});
        source.elements.find(e=>e.id===102).nodes=[4,8,5];
        selection.driveWays[1].nodeIds=[4,8,5];
        const n = compileNetwork(source, selection, [], []).network;
        expect(n.routes.filter(r=>r.entry.includes('way/101')).every(r=>
          r.edges.every(id=>!id.includes('way/102')))).toBe(true);
      });
      it('excludes all member ways of an unsupported via-way restriction', () => {
        const { source, selection } = routeFixture();
        source.elements.push({type:'relation', id:201, tags:{type:'restriction',restriction:'no_right_turn'},
          members:[{type:'way',ref:101,role:'from'}, {type:'way',ref:102,role:'via'}, {type:'way',ref:101,role:'to'}]});
        const result = compileNetwork(source, selection, [], []);
        expect(result.network.edges.every(e => e.mode === 'walk')).toBe(true);
        expect(result.diagnostics.some(d => d.code === 'UNSUPPORTED_RESTRICTION')).toBe(true);
      });
      it('rejects forged source tags, noncontiguous selections and incomplete source references', () => {
        for (const mutate of [
          (s: any, v: any) => { v.driveWays[0].tags.width = '99'; },
          (s: any, v: any) => { v.driveWays[0].nodeIds = [1,3]; },
          (s: any) => { s.elements = s.elements.filter((e: any) => e.id !== 2); },
        ]) {
          const { source, selection } = routeFixture(); mutate(source, selection);
          expect(() => compileNetwork(source, selection, [], [])).toThrow();
        }
      });
    });
  it.each([
    ['HTTP 503', () => new Response('unavailable', { status: 503 })],
    ['remark', () => new Response(JSON.stringify({ ...overpass, remark: 'runtime error: timeout' }))],
    ['truncated way', () => new Response(JSON.stringify({ ...overpass, elements: overpass.elements.slice(1) }))],
    ['truncated relation', () => new Response(JSON.stringify({ ...overpass,
      elements: [...overpass.elements, { type: 'relation', id: 202, members: [{ type: 'way', ref: 999, role: 'via' }] }] }))],
    ['empty response', () => new Response('{"elements":[]}')],
    ['malformed JSON', () => new Response('{')],
    ['no snapshot', () => new Response(JSON.stringify({ elements: overpass.elements }))],
    ['invalid coordinate', () => new Response(JSON.stringify({ ...overpass,
      elements: [{ type: 'node', id: 99, lat: 91, lon: 120 }, ...overpass.elements] }))],
    ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
  ])('retains valid cache bytes after failed %s refresh and stops after bounded retries', async (_, failure) => {
    vi.stubGlobal('fetch', response); await prepare();
    const before = await readFile(join(cacheDir, 'district.json'));
    const fetch = vi.fn(failure); vi.stubGlobal('fetch', fetch);
    await expect(prepare(true)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readFile(join(cacheDir, 'district.json'))).toEqual(before);
    expect(await readdir(cacheDir)).toEqual(['district.json']);
  });

  it('does not reuse a cache for a different bbox', async () => {
    vi.stubGlobal('fetch', response); await prepare();
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
    await expect(fetchDistrict({ bounds: [120.67, 31.31, 120.68, 31.32], cacheDir, refresh: false })).rejects.toThrow();
  });

  it('replaces corrupt cache only with a complete valid response', async () => {
    await writeFile(join(cacheDir, 'district.json'), '{"broken":true}');
    vi.stubGlobal('fetch', response); await prepare();
    expect(JSON.parse(await readFile(join(cacheDir, 'district.json'), 'utf8')).response).toEqual(overpass);
  });

  it('rejects unbounded or invalid bbox before network', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('network must not run'); });
    for (const box of [[-180, -90, 180, 90], [121, 32, 120, 31], [NaN, 31, 121, 32]]) {
      await expect(fetchDistrict({ bounds: box as typeof bounds, cacheDir, refresh: false })).rejects.toThrow(/bounds/i);
    }
  });
});
