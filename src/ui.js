import { BALL_TYPES } from './physics/materials.js';
import { ROOM } from './config.js';

const PRESETS = [
  { id: 'freeze', label: 'Freeze', T: -25 },
  { id: 'chill', label: 'Chill', T: 2 },
  { id: 'room', label: 'Room', T: ROOM.temperature },
  { id: 'warm', label: 'Warm', T: 85 },
  { id: 'boil', label: 'Boil', T: 230 },
];

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
};

function toggle(label, get, set) {
  const input = h('input', { type: 'checkbox' });
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  return h('label', { class: 'toggle' }, h('span', {}, label), input, h('i'));
}

function section(title, body, { collapsible = false, closed = false } = {}) {
  const s = h('div', { class: 'section' + (collapsible ? ' collapsible' : '') + (closed ? ' closed' : '') });
  const head = h('h2', {}, title);
  if (collapsible) head.addEventListener('click', () => s.classList.toggle('closed'));
  s.append(head, h('div', { class: 'body' }, ...body));
  return s;
}

// slider position <-> time scale (log)
const TS_MIN = 1, TS_MAX = 600;
const ts2s = (t) => Math.log(t / TS_MIN) / Math.log(TS_MAX / TS_MIN);
const s2ts = (s) => TS_MIN * Math.pow(TS_MAX / TS_MIN, s);

export class UI {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('ui');
    this.frame = 0;
    this._build();
    this._keys();
  }

  _build() {
    const app = this.app;
    const root = this.root;

    root.append(h('div', { class: 'title' },
      h('h1', {}, 'A Cup of Water'),
      h('p', {}, 'Interactive multi-state fluid rendering · COMP5411'),
    ));

    // ---- big readout (bottom left)
    this.elTemp = h('div', { class: 'temp' }, '22.0', h('small', {}, '°C'));
    this.elState = h('div', { class: 'state' }, 'Still water');
    const bar = (name) => {
      const fill = h('div', { class: 'fill' });
      const val = h('span', {}, '0%');
      return { el: h('div', { class: 'bar' }, h('label', {}, h('span', {}, name), val), h('div', { class: 'track' }, fill)), fill, val };
    };
    this.barIce = bar('Ice');
    this.barBoil = bar('Boiling');
    this.barGas = bar('Dissolved air');
    this.barIce.fill.style.background = 'var(--cold)';
    this.barBoil.fill.style.background = 'var(--warm)';
    this.barGas.fill.style.background = '#c9c4bb';
    this.readout = h('div', { class: 'readout' }, this.elTemp, this.elState,
      h('div', { class: 'bars' }, this.barIce.el, this.barBoil.el, this.barGas.el));
    root.append(this.readout);

    // ---- panel
    const panel = h('div', { class: 'panel' });
    root.append(panel);

    // thermal stage
    this.elSourceName = h('span', { class: 'name' }, 'Room air');
    this.elSourceVal = h('span', { class: 'val' }, '22 °C');
    this.slider = h('input', { type: 'range', min: '-30', max: '250', step: '1', class: 'thermo' });
    this.slider.value = String(app.thermal.envTemp);
    this.slider.addEventListener('input', () => this.setSource(+this.slider.value));
    this.presetButtons = PRESETS.map((p) => h('button', { onclick: () => this.setSource(p.T) }, p.label));
    this.tsSlider = h('input', { type: 'range', min: '0', max: '1', step: '0.001' });
    this.tsSlider.value = String(ts2s(app.thermal.timeScale));
    this.elTs = h('span', { class: 'value' }, '×120');
    this.tsSlider.addEventListener('input', () => {
      const v = s2ts(+this.tsSlider.value);
      const nice = v < 10 ? Math.round(v) : v < 100 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10;
      app.thermal.timeScale = nice;
    });
    panel.append(section('Thermal stage', [
      h('div', { class: 'source' }, this.elSourceName, this.elSourceVal),
      this.slider,
      h('div', { class: 'chips' }, ...this.presetButtons),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Heat-transfer time scale'), this.elTs),
      this.tsSlider,
      h('p', { class: 'note' }, 'Below room temperature the glass stands in cold air (a freezer); above it, it sits on a hot plate. Waves, bubbles and bodies always run in real time; only heat transfer is accelerated.'),
    ]));

    // objects
    const ballBtns = BALL_TYPES.map((t, i) => h('button', {
      title: `${t.name}: ${t.density} kg/m³ — click to drop, Shift+click to drop three`,
      onclick: (e) => { const n = e.shiftKey ? 3 : 1; for (let k = 0; k < n; k++) app.dropBall(i); },
    }, h('span', { class: 'dot', style: `background:${t.swatch}` }), t.name.split(' ')[0], h('span', { class: 'rho' }, `${t.density}`)));
    panel.append(section('Drop an object  ·  kg/m³', [
      h('div', { class: 'balls' }, ...ballBtns),
      h('div', { class: 'chips' },
        h('button', { onclick: () => app.clearBalls() }, 'Clear objects'),
        h('button', { onclick: () => { app.cup.shake = 1.6; app.cup.shakeT = 0; } }, 'Shake glass'),
      ),
      h('p', { class: 'note' }, 'The thermo bead (975 kg/m³) floats in cold water and sinks once hot water has expanded below its density (≈ 73 °C).'),
    ]));

    // tools
    this.toolBtns = {
      hand: h('button', { class: 'active', onclick: () => this.setTool('hand') }, 'Hand'),
      wipe: h('button', { onclick: () => this.setTool('wipe') }, 'Wipe glass'),
    };
    panel.append(section('Pointer tool', [
      h('div', { class: 'seg' }, this.toolBtns.hand, this.toolBtns.wipe),
      h('p', { class: 'note' }, 'Hand: drag the glass to slide it, drag objects to lift and throw them, drag on the water to stir it. Wipe (or hold Shift): clear fog and frost from the glass.'),
    ]));

    // couplings
    const bo = app.bodies.coupling, bu = app.bubbles.coupling;
    panel.append(section('Physical coupling', [
      toggle('Sloshing (inertial forcing)', () => app.slosh.enabled, (v) => { app.slosh.enabled = v; }),
      toggle('Bodies ↔ waves', () => bo.waves, (v) => { bo.waves = v; }),
      toggle('Ice ↔ waves & bodies', () => bo.ice, (v) => { bo.ice = v; }),
      toggle('Bubbles → surface', () => bu.surface, (v) => { bu.surface = v; }),
      toggle('Bubbles → bodies', () => bu.bodies, (v) => { bu.bodies = v; bo.bubbles = v; }),
      toggle('Bubble nucleation', () => app.bubbles.enabled, (v) => { app.bubbles.enabled = v; }),
      h('p', { class: 'note' }, 'Switch couplings off to compare against uncoupled baselines.'),
    ], { collapsible: true, closed: true }));

    panel.append(section('Rendering', [
      toggle('Caustics', () => app.caustics.enabled, (v) => { app.caustics.enabled = v; }),
      toggle('Condensation & frost', () => app.condensation.enabled, (v) => { app.condensation.enabled = v; app.frostEnabled = v; }),
      toggle('Steam', () => app.steam.enabled, (v) => { app.steam.enabled = v; }),
      toggle('Splash droplets', () => app.splash.enabled, (v) => { app.splash.enabled = v; }),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Debug inset'), this._select(
        [['0', 'None'], ['1', 'Height field'], ['2', 'Thermal field (r, y)'], ['3', 'Moisture map'], ['4', 'Caustics map']],
        String(app.debugMode), (v) => { app.debugMode = +v; this.debugSel = v; })),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Resolution'), this._select(
        [['1', 'Full'], ['0.8', 'Balanced'], ['0.6', 'Fast'], ['0.45', 'Very fast']],
        String(app.quality), (v) => app.setQuality(+v))),
    ], { collapsible: true, closed: true }));

    // stats
    this.elStats = h('div', { class: 'stats' });
    panel.append(section('Simulation', [
      this.elStats,
      h('div', { class: 'chips' },
        this.pauseBtn = h('button', { onclick: () => this.togglePause() }, 'Pause'),
        h('button', { onclick: () => app.resetWater(ROOM.temperature) }, 'Fresh water'),
        h('button', { onclick: () => { app.resetWater(ROOM.temperature); app.thermal.gasConc = 0.3; app.thermal.gas = app.thermal.waterVolume * 0.3; } }, 'Boiled water'),
      ),
    ]));

    // hint
    root.append(h('div', { class: 'hint', html:
      'drag glass <span class="sep">|</span> drag on water to stir <span class="sep">|</span> drag objects to throw <span class="sep">|</span> <kbd>Shift</kbd> wipe <span class="sep">|</span> drag empty space to orbit <span class="sep">|</span> <kbd>1</kbd>–<kbd>5</kbd> drop <span class="sep">|</span> <kbd>H</kbd> hide UI' }));

    this.setSource(app.thermal.envTemp);
  }

  _select(options, value, onChange) {
    const s = h('select');
    for (const [v, l] of options) s.append(h('option', { value: v }, l));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  setSource(T) {
    const app = this.app;
    app.thermal.envTemp = T;
    this.slider.value = String(T);
    const room = ROOM.temperature;
    let name;
    if (T < room - 0.5) name = T <= 0 ? 'Freezer air' : 'Cold air';
    else if (T > room + 0.5) name = 'Hot plate';
    else name = 'Room air';
    this.elSourceName.textContent = name;
    this.elSourceVal.textContent = `${Math.round(T)} °C`;
    PRESETS.forEach((p, i) => this.presetButtons[i].classList.toggle('active', Math.abs(p.T - T) < 0.5));
  }

  setTool(t) {
    this.app.interaction.tool = t;
    for (const [k, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', k === t);
  }

  togglePause() {
    this.app.paused = !this.app.paused;
    this.pauseBtn.textContent = this.app.paused ? 'Resume' : 'Pause';
    this.pauseBtn.classList.toggle('active', this.app.paused);
  }

  setHidden(hidden) {
    this.root.classList.toggle('hidden', hidden);
    this.app.panelShift = !hidden;
    this.app.resize();
  }

  _keys() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '5') this.app.dropBall(+k - 1);
      else if (k === 'f') this.setSource(-25);
      else if (k === 'r') this.setSource(ROOM.temperature);
      else if (k === 'b') this.setSource(230);
      else if (k === 'w') this.setTool(this.app.interaction.tool === 'wipe' ? 'hand' : 'wipe');
      else if (k === 'c') this.app.clearBalls();
      else if (k === 's') { this.app.cup.shake = 1.6; this.app.cup.shakeT = 0; }
      else if (k === 'p' || k === ' ') { this.togglePause(); e.preventDefault(); }
      else if (k === 'h') this.setHidden(!this.root.classList.contains('hidden'));
      else if (k === 'd') { this.app.debugMode = (this.app.debugMode + 1) % 5; }
    });
  }

  _state() {
    const app = this.app, st = app.thermal.stats;
    const T = st.meanT, ice = st.iceFraction, heating = app.thermal.envTemp > ROOM.temperature + 0.5;
    if (ice > 0.985) return T < -8 ? 'Frozen solid' : 'Frozen';
    if (ice > 0.01) return heating ? 'Melting' : (st.topIce > 0.95 ? 'Freezing under an ice lid' : 'Freezing from the rim');
    if (st.boiling > 0.55) return 'Rolling boil';
    if (st.boiling > 0.12) return 'Boiling';
    if (app.bubbles.list.some((b) => !b.gas)) return 'Nucleate boiling at the base';
    if (T > 75 && heating) return 'Simmering';
    if (st.wallBubbles > 0.15) return 'Dissolved air coming out';
    if (T > 45) return 'Hot';
    if (T > 30) return 'Warm';
    if (T < 4.5 && !heating) return 'Near the density maximum (4 °C)';
    if (T < 12) return 'Cold';
    return app.slosh.energy() > 0.002 ? 'Sloshing' : 'Still water';
  }

  update() {
    if (this.frame++ % 6) return;
    const app = this.app, st = app.thermal.stats;
    this.elTemp.firstChild.textContent = st.meanT.toFixed(1);
    this.elState.textContent = this._state();
    this.elState.style.color = st.iceFraction > 0.01 || st.meanT < 4.5 ? 'var(--cold)' : st.meanT > 45 ? 'var(--warm)' : 'var(--accent)';
    const pct = (b, v) => { b.fill.style.width = `${Math.round(v * 100)}%`; b.val.textContent = `${Math.round(v * 100)}%`; };
    pct(this.barIce, st.iceFraction);
    pct(this.barBoil, st.boiling);
    pct(this.barGas, Math.min(1, st.gasContent));
    this.barGas.val.textContent = `${Math.round(Math.min(1, st.gasContent) * 100)}%`;
    this.elTs.textContent = `×${app.thermal.timeScale}`;
    const simMin = app.thermal.simTime / 60;
    this.elStats.innerHTML = [
      ['fps', `${app.fps.toFixed(0)}`], ['cpu', `${app.frameMs.toFixed(1)} ms`],
      ['bubbles', `${app.bubbles.list.length}`], ['drops', `${app.splash.drops.length}`],
      ['T min/max', `${st.minT.toFixed(0)}/${st.maxT.toFixed(0)} °C`], ['surface', `${app.topT.toFixed(1)} °C`],
      ['wave substeps', `${app.waves.lastSubsteps ?? 0}`], ['sim time', `${simMin.toFixed(1)} min`],
      ['render', `${app.rw}×${app.rh}`], ['objects', `${app.bodies.balls.length}`],
    ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  }
}
