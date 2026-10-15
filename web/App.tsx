import { useEffect, useRef, useState } from 'react';
import {
  Building2, Layers3, MapPin, Scan, SlidersHorizontal, Sun, Moon, ChevronDown,
  ArrowUpRight, Download, Camera, RotateCcw, Plus, Minus, Compass, Leaf,
  Waves, Route, SquareDashed, Tag, X, Check, CircleHelp, Database, Upload,
  LoaderCircle, Navigation, PanelRightClose, PanelRightOpen, AlertTriangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FeatureCollection } from 'geojson';
import { CityScene, fetchJSON, PLACES } from './scene/CityScene';
import { defaultSettings, encodeSettings, parseSettings, SETTINGS_KEY } from './core/settings';
import type { BuildingProperties, CityManifest, SceneSettings, SceneStats } from './core/types';

const number = new Intl.NumberFormat('zh-CN');
const initialStats: SceneStats = {
  loadedTiles: 0, loadedBuildings: 0, loading: false, overview: true,
  height: 160000, longitude: 120.65, latitude: 31.4,
};
const layerControls: { key: keyof Pick<SceneSettings, 'buildings' | 'water' | 'roads' | 'green' | 'boundary' | 'labels'>; name: string; icon: LucideIcon; color: string }[] = [
  { key: 'buildings', name: '三维建筑', icon: Building2, color: 'gold' },
  { key: 'water', name: '湖泊与河流', icon: Waves, color: 'blue' },
  { key: 'roads', name: '道路网络', icon: Route, color: 'gold' },
  { key: 'green', name: '公园与绿地', icon: Leaf, color: 'mint' },
  { key: 'boundary', name: '行政边界', icon: SquareDashed, color: 'mint' },
  { key: 'labels', name: '地名标注', icon: Tag, color: 'muted' },
];

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MapInset({ manifest, stats, onHome, onError }: {
  manifest: CityManifest; stats: SceneStats; onHome: () => void; onError: (message: string) => void;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [west, south, east, north] = manifest.bounds;
  const project = ([x, y]: number[]) => [
    12 + (x - west) / (east - west) * 146, 120 - (y - south) / (north - south) * 108,
  ];
  useEffect(() => {
    const abort = new AbortController();
    fetchJSON<FeatureCollection>(`/data/${manifest.dataset}/boundary.json`, abort.signal)
      .then((data) => {
        const rings = data.features.flatMap((feature) => feature.geometry.type === 'Polygon'
          ? feature.geometry.coordinates : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates.flat() : []);
        setPaths(rings.map((ring) => ring.map((point, i) => `${i ? 'L' : 'M'}${project(point).join(',')}`).join(' ') + 'Z'));
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) onError(`全市概览图加载失败：${String(error)}`);
      });
    return () => abort.abort();
  }, [manifest.dataset]);
  const [cx, cy] = project([stats.longitude, stats.latitude]);
  return <button className="map-inset" onClick={onHome} aria-label="返回苏州市全域">
    <div className="inset-heading"><span>全域导航</span><ArrowUpRight size={13} /></div>
    <svg viewBox="0 0 170 132" aria-label="苏州市行政边界概览">
      <defs><pattern id="mapGrid" width="17" height="17" patternUnits="userSpaceOnUse"><path d="M17 0H0V17" fill="none" stroke="#23404a" strokeWidth=".4" /></pattern></defs>
      <rect width="170" height="132" fill="url(#mapGrid)" />
      {paths.map((path, i) => <path key={i} d={path} fill="#244d47" fillOpacity=".7" stroke="#7ab7a2" strokeWidth="1" />)}
      {cx >= 0 && cx <= 170 && cy >= 0 && cy <= 132 && <><circle cx={cx} cy={cy} r="8" fill="#addec4" opacity=".15" /><circle cx={cx} cy={cy} r="2.5" fill="#c6efd4" /></>}
    </svg>
    <span className="inset-caption">SUZHOU MUNICIPALITY</span>
  </button>;
}

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<CityScene | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [settings, setSettings] = useState<SceneSettings>({ ...defaultSettings });
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const [manifest, setManifest] = useState<CityManifest | null>(null);
  const [stats, setStats] = useState(initialStats);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<BuildingProperties | null>(null);
  const [place, setPlace] = useState('苏州市全域');
  const [tab, setTab] = useState<'scene' | 'data'>('scene');
  const [help, setHelp] = useState(false);
  const [panel, setPanel] = useState(true);

  function notify(message: string) {
    clearTimeout(toastTimer.current);
    setNotice(message);
    toastTimer.current = setTimeout(() => setNotice(''), 3600);
  }

  useEffect(() => {
    const abort = new AbortController();
    let instance: CityScene | undefined;
    let saved = { ...defaultSettings };
    try {
      const text = localStorage.getItem(SETTINGS_KEY);
      if (text) saved = parseSettings(text);
      latestSettings.current = saved;
      setSettings(saved);
    } catch (error) {
      setError(`无法读取已保存的配置，已使用默认显示设置：${error instanceof Error ? error.message : String(error)}`);
    }
    fetchJSON<CityManifest>('/data/manifest.json', abort.signal)
      .then(async (data) => {
        if (abort.signal.aborted || !container.current) return;
        if (data.version !== 1 || !/^[a-f0-9]{16}$/.test(data.dataset) || data.boundaryId !== 4430941) {
          throw new Error('数据清单版本或城市标识不匹配。');
        }
        setManifest(data);
        instance = new CityScene(container.current, data, latestSettings.current, {
          onStats: setStats, onSelect: setSelected, onError: setError,
        });
        scene.current = instance;
        await instance.initialize();
        if (!abort.signal.aborted) setReady(true);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setError(`场景数据加载失败：${error instanceof Error ? error.message : String(error)}。请运行 npm run data:fetch && npm run data:build 后刷新。`);
      });
    return () => {
      abort.abort();
      instance?.destroy();
      scene.current = null;
      clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => { scene.current?.updateSettings(settings); }, [settings]);

  function update<K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) {
    setSettings((previous) => ({ ...previous, [key]: value }));
  }
  function locate(name: string) {
    scene.current?.flyTo(name);
    setPlace(name);
    setSelected(null);
  }
  function home() {
    scene.current?.home();
    setPlace('苏州市全域');
    setSelected(null);
  }
  function save() {
    try {
      localStorage.setItem(SETTINGS_KEY, encodeSettings(settings));
      notify('场景配置已保存在本机');
    } catch (error) { setError(`配置保存失败：${String(error)}`); }
  }
  async function screenshot() {
    try {
      if (!scene.current) throw new Error('请等待场景加载完成。');
      download(await scene.current.screenshot(), `suzhou-${settings.night ? 'night' : 'day'}-${Date.now()}.png`);
      notify('三维视图已导出（不含控制面板）');
    } catch (error) { setError(`截图失败：${String(error)}`); }
  }
  async function importConfig(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 64000) throw new Error('配置文件超过 64 KB 限制。');
      setSettings(parseSettings(await file.text()));
      notify('配置已导入；点击保存可在下次打开时恢复');
    } catch (error) { setError(`配置导入失败：${error instanceof Error ? error.message : String(error)}`); }
    if (input.current) input.current.value = '';
  }

  const counts = manifest?.counts;
  const estimated = counts ? counts.levels + counts.fallback : 0;
  return <div className={`app ${panel ? '' : 'panel-hidden'}`}>
    <header className="topbar">
      <a className="brand" href="/" aria-label="苏州城市实验室首页">
        <span className="brand-mark"><Building2 size={25} strokeWidth={1.3} /></span>
        <span><strong>城市实验室<span className="brand-slash"> / </span><span className="brand-en">CITY LAB</span></strong><small>REAL GEOGRAPHY. NEW PERSPECTIVES.</small></span>
      </a>
      <div className="project-crumb"><span>中国 · 江苏</span><span>/</span><b>苏州</b><ChevronDown size={13} /></div>
      <div className="top-actions"><span className="local-badge"><i /> 本地运行</span>
        <button className="button subdued" onClick={save}><Download size={14} />保存配置</button>
        <button className="button primary" onClick={screenshot} disabled={!ready}><Camera size={15} />导出截图</button>
      </div>
    </header>

    <nav className="rail" aria-label="工作台导航">
      <button className={tab === 'scene' ? 'rail-button active' : 'rail-button'} title="场景设置" aria-label="场景设置" onClick={() => { setTab('scene'); setPanel(true); }}><Layers3 size={20} /><span>场景</span></button>
      <button className={tab === 'data' ? 'rail-button active' : 'rail-button'} title="数据来源" aria-label="数据来源" onClick={() => { setTab('data'); setPanel(true); }}><Database size={20} /><span>数据</span></button>
      <button className="rail-button" title="苏州市全域" aria-label="苏州市全域" onClick={home}><Scan size={20} /><span>全域</span></button>
      <div className="rail-bottom"><button className="rail-button" aria-label="操作指南" onClick={() => setHelp(true)}><CircleHelp size={20} /></button><span className="rail-version">v0.1</span></div>
    </nav>

    <main className="viewport">
      <div ref={container} className="cesium-container" aria-label="苏州市三维地理场景" />
      <div className="viewport-vignette" />
      <div className="scene-title">
        <div className="eyebrow"><span className="mint-line" /> DIGITAL CITY COLLECTION — 001</div>
        <h1>苏州<span>SUZHOU</span></h1>
        <p>一座城，两千年的水岸。</p>
        <div className="scope-chip"><SquareDashed size={12} /> 全行政区域 <span>·</span> WGS84</div>
      </div>
      <button className="panel-toggle icon-button" aria-label={panel ? '收起控制面板' : '展开控制面板'} onClick={() => setPanel(!panel)}>{panel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>

      {!ready && !error && <div className="loading-card"><LoaderCircle className="spin" size={25} /><strong>正在构建你的城市视野</strong><span>读取本地地理数据与三维资源</span></div>}

      <div className="scene-tools">
        <div className="camera-controls">
          <button aria-label="视角朝北" title="朝北" onClick={() => scene.current?.north()}><Compass size={19} /><span>N</span></button>
          <i />
          <button aria-label="放大" title="放大" onClick={() => scene.current?.zoom(true)}><Plus size={19} /></button>
          <button aria-label="缩小" title="缩小" onClick={() => scene.current?.zoom(false)}><Minus size={19} /></button>
          <i />
          <button aria-label="重置全市视角" title="全市总览" onClick={home}><Scan size={18} /></button>
        </div>
      </div>
      <div className="bottom-map">{manifest && <MapInset manifest={manifest} stats={stats} onHome={home} onError={setError} />}</div>
      <div className="view-caption">
        <span className="caption-line" />
        <div><span className="eyebrow">CURRENT VIEW</span><strong>{place}</strong></div>
        <span className="view-mode">{stats.overview ? '全域概览 · 放大查看建筑' : '真实轮廓 · 三维建筑'}</span>
      </div>
      <div className="mouse-hint">左键拖动平移 <span>·</span> 滚轮缩放 <span>·</span> 右键拖动缩放 <span>·</span> 中键拖动环绕</div>
      {selected && <section className="selection-card">
        <div className="section-title"><span><Building2 size={16} /> 建筑信息</span><button className="icon-button" aria-label="关闭建筑信息" onClick={() => setSelected(null)}><X size={16} /></button></div>
        <h3>{selected.name || '未命名建筑'}</h3>
        <dl><div><dt>高度</dt><dd>{selected.height.toFixed(1)} m</dd></div>
          <div><dt>高度依据</dt><dd>{selected.basis === 'height' ? 'OSM 标注高度' : selected.basis === 'levels' ? '楼层数推算 · 估算' : '类型默认值 · 估算'}</dd></div>
          <div><dt>源标识</dt><dd>{selected.id}</dd></div></dl>
        <a href={`https://www.openstreetmap.org/${selected.id}`} target="_blank" rel="noreferrer">查看 OpenStreetMap 原始记录 <ArrowUpRight size={12} /></a>
      </section>}
    </main>

    <aside className="sidebar" aria-label="城市控制面板">
      <div className="panel-title"><div><span className="eyebrow">YOUR CITY, YOUR VIEW</span><h2>{tab === 'scene' ? '场景控制' : '数据档案'}</h2></div><SlidersHorizontal size={19} /></div>
      <div className="panel-tabs"><button className={tab === 'scene' ? 'active' : ''} onClick={() => setTab('scene')}>场景设置</button><button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>数据与来源</button></div>
      <div className="panel-scroll">
        {tab === 'scene' ? <>
          <section className="panel-section">
            <div className="section-title"><span><Sun size={15} /> 光影氛围</span><span className="tiny-label">ATMOSPHERE</span></div>
            <div className="day-night">
              <button aria-label="日景" className={!settings.night ? 'active' : ''} aria-pressed={!settings.night} onClick={() => update('night', false)}><Sun size={17} />日景<span>DAYLIGHT</span></button>
              <button aria-label="夜景" className={settings.night ? 'active' : ''} aria-pressed={settings.night} onClick={() => update('night', true)}><Moon size={17} />夜景<span>NIGHTFALL</span></button>
            </div>
            <label className="slider-label" htmlFor="glow">窗光亮度 <span>{Math.round(settings.glow * 100)}<small>%</small></span></label>
            <input id="glow" type="range" min="0" max="1" step=".05" value={settings.glow} onChange={(event) => update('glow', Number(event.target.value))} disabled={!settings.night} style={{ '--range-progress': `${settings.glow * 100}%` } as React.CSSProperties} />
            <div className="range-hints"><span>静谧</span><span>璀璨</span></div>
          </section>
          <section className="panel-section">
            <div className="section-title"><span><MapPin size={15} /> 城市漫游</span><span className="tiny-label">EXPLORE</span></div>
            <button className={`city-wide ${place === '苏州市全域' ? 'selected' : ''}`} onClick={home}><span><Scan size={18} /><span>苏州市全域<small>完整行政范围 · 非局部示意</small></span></span><ArrowUpRight size={16} /></button>
            <div className="place-grid">{PLACES.map((item, index) => <button key={item.name} aria-label={item.name} className={`place-card ${place === item.name ? 'selected' : ''}`} onClick={() => locate(item.name)}>
              <span className="place-index">{String(index + 1).padStart(2, '0')}</span><strong>{item.name}</strong><small>{item.sub}</small>{place === item.name && <i />}
            </button>)}</div>
          </section>
          <section className="panel-section">
            <div className="section-title"><span><Layers3 size={15} /> 地理图层</span><span className="tiny-label">LAYERS</span></div>
            <div className="layer-list">{layerControls.map(({ key, name, icon: Icon, color }) => <div className="layer-row" key={key}>
              <span><Icon size={16} className={`color-${color}`} />{name}</span>
              <button className={`switch ${settings[key] ? 'on' : ''}`} role="switch" aria-label={name} aria-checked={settings[key]} onClick={() => update(key, !settings[key])}><span /></button>
            </div>)}</div>
          </section>
          <section className="panel-section">
            <div className="section-title"><span><SlidersHorizontal size={15} /> 渲染质量</span><span className="tiny-label">QUALITY</span></div>
            <div className="segmented">{([['low', '流畅'], ['medium', '均衡'], ['high', '精细']] as const).map(([value, text]) => <button key={value} className={settings.quality === value ? 'active' : ''} aria-pressed={settings.quality === value} onClick={() => update('quality', value)}>{text}</button>)}</div>
            <p className="section-note">均衡适配高分屏，精细增加采样，流畅降低分辨率。建筑按视角分块加载，远景仅显示地表与路网。</p>
          </section>
        </> : <>
          <section className="panel-section">
            <div className="data-label"><i /> OPENSTREETMAP · 本地快照</div>
            <h3 className="data-heading">真实坐标，<br />诚实呈现。</h3>
            <p className="section-note">采集范围覆盖苏州市行政区域，但源数据不等于现实中的全部建筑。空缺不代表空地；本版本不包含真实地形高程。</p>
            <dl className="data-facts">
              <div><dt>建筑轮廓</dt><dd>{number.format(counts?.buildings ?? 0)}</dd></div>
              <div><dt>源标注高度</dt><dd>{number.format(counts?.measured ?? 0)}</dd></div>
              <div><dt>楼层推算高度</dt><dd>{number.format(counts?.levels ?? 0)}</dd></div>
              <div><dt>类型估算高度</dt><dd>{number.format(counts?.fallback ?? 0)}</dd></div>
              <div><dt>建筑分块</dt><dd>{manifest?.tiles.length ?? 0}</dd></div>
              <div><dt>数据快照</dt><dd>{manifest?.osmTimestamp.slice(0, 10) ?? '读取中'}</dd></div>
              <div><dt>坐标系统</dt><dd>WGS84</dd></div>
            </dl>
            <p className="section-note">估算高度 {number.format(estimated)} 栋。夜景窗光是艺术化表达，不代表实际楼宇照明。</p>
          </section>
          <section className="panel-section">
            <div className="section-title"><span><Download size={15} /> 配置管理</span></div>
            <div className="config-actions">
              <button className="button subdued" onClick={() => download(new Blob([encodeSettings(settings)], { type: 'application/json' }), 'suzhou-scene.json')}><Download size={15} />导出配置</button>
              <button className="button subdued" onClick={() => input.current?.click()}><Upload size={15} />导入配置</button>
              <button className="button subdued" onClick={() => { setSettings({ ...defaultSettings }); notify('已恢复默认显示设置，保存后将在下次启动生效'); }}><RotateCcw size={15} />恢复默认</button>
            </div>
            <p className="section-note">配置只改变显示效果，不修改真实道路、水系或建筑位置。</p>
          </section>
          <section className="panel-section">
            <div className="section-title"><span><Database size={15} /> 本地数据更新</span></div>
            <code className="command">npm run data:fetch -- --refresh<br />npm run data:build</code>
            <p className="section-note">更新需要网络；当前已下载数据可离线浏览。下载失败保留已有数据，更新完成后刷新页面。</p>
            <a className="source-link" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap · ODbL 许可 <ArrowUpRight size={13} /></a>
          </section>
        </>}
        <div className="integrity-note"><SquareDashed size={16} /><p>位置来自真实地图<br /><span>缺失高度已标记为估算高度</span></p><span className="integrity-dot" /></div>
      </div>
      <div className="panel-bottom"><span><i /> LOCAL WORKSPACE</span><b>SUZHOU / 001</b></div>
    </aside>

    <footer className="statusbar">
      <span className="scene-status"><i className={ready ? 'ready' : ''} /><span data-testid="scene-state">{ready ? '场景就绪' : '等待数据'}</span></span>
      <span className="status-data">当前建筑 <b data-testid="loaded-buildings">{number.format(stats.loadedBuildings)}</b><span className="status-sep">/</span>源数据 <b>{number.format(counts?.buildings ?? 0)}</b></span>
      <span className="tile-status">{stats.loading && <LoaderCircle size={11} className="spin" />} {stats.loadedTiles} 个分块</span>
      <span className="coordinates">{stats.longitude.toFixed(4)}° E &nbsp; {stats.latitude.toFixed(4)}° N</span>
      <span className="attribution">© OpenStreetMap contributors · ODbL</span>
    </footer>
    <input ref={input} data-testid="import-config" type="file" accept=".json,application/json" hidden onChange={(event) => void importConfig(event.target.files?.[0])} />
    {error && <div className="error-banner" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => { setError(''); if (ready) scene.current?.retry(); else window.location.reload(); }}>重试加载</button><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-heading" onClick={(event) => event.stopPropagation()}>
      <button className="icon-button close-dialog" aria-label="关闭操作指南" onClick={() => setHelp(false)}><X size={18} /></button>
      <Navigation size={24} className="color-mint" /><h2 id="help-heading">从全域，到一条水巷。</h2>
      <p>点击“城市漫游”中的地点，进入倾斜三维视角。用鼠标滚轮靠近城市，中键拖动环绕，单击建筑查看来源和高度依据。接近水平时保留安全俯角，向上拖动可回到俯视。</p>
      <p>建筑仅按当前视角加载有限分块。远景隐藏建筑，不代表该区域没有数据。此版本基于 OSM 轮廓拉伸，不是照片级苏州实景。</p>
      <button className="button primary" onClick={() => setHelp(false)}>开始探索 <ArrowUpRight size={15} /></button>
    </section></div>}
  </div>;
}
