import { BALL_TYPES } from './physics/materials.js';
import { GRID, ROOM } from './config.js';

const TYPES = [0, 1, 3, 4];
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
};
function section(title, ...body) {
  return h('section', { class: 'section' }, h('h2', {}, title), ...body);
}
function toggle(label, get, set) {
  const input = h('input', { type: 'checkbox' });
  input.checked = get();
  input.addEventListener('change', () => set(input.checked));
  return h('label', { class: 'toggle' }, h('span', {}, label), input, h('i'));
}

export class UI {
  constructor(app) {
    this.app = app;
    this.frame = 0;
    this.root = document.getElementById('ui');
    this.build();
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '4') app.dropBall(TYPES[+k - 1]);
      else if (k === 'b') this.setSource(230);
      else if (k === 'r' && e.altKey) this.setSource(22);
      else if (k === 's') this.shake();
      else if (k === 'r') this.ripple();
      else if (k === 'c') app.clearBalls();
      else if (k === 'd') this.setDebug(app.debugMode ? 0 : 1);
      else if (k === 'p' || k === ' ') { this.togglePause(); e.preventDefault(); }
      else if (k === 'h') this.setHidden(!this.root.classList.contains('hidden'));
      else if (k === '0') this.resetScene();
    });
  }
  build() {
    const app = this.app;
    this.root.append(h('div', { class: 'title' }, h('h1', {}, 'A Cup of Water'),
      h('p', {}, 'Liquid + boiling demo · COMP5411 · Group 8')));
    // Always visible provenance survives H / ?ui=0, so clean captures retain context.
    this.root.append(h('div', { class: 'stage-label' }, 'Scoped liquid + heating build · derived from the full implementation'));
    const panel = h('div', { class: 'panel' });
    this.root.append(panel);
    panel.append(section('Demonstration scope',
      h('p', { class: 'scope-copy' }, 'Liquid interaction, heating and boiling'),
      h('p', { class: 'note' }, 'Freezing, frost and condensation are outside this build.')));
    this.waterReadout = h('strong', { class: 'water-readout' }, 'Water 22.0 °C');
    this.sourceReadout = h('span', { class: 'note' }, 'Stage 22 °C');
    this.sourceButtons = [22,85,230].map((T,i)=>h('button',{onclick:()=>this.setSource(T)},['Room','Warm','Boil'][i]));
    this.timeScaleSelect = h('select', { 'aria-label':'Heat transfer time scale', onchange:e=>{app.thermal.timeScale=+e.target.value;} },
      ...[120,300,600].map(v=>h('option',{value:String(v)},'×'+v)));
    this.timeScaleSelect.value=String(app.thermal.timeScale);
    panel.append(section('Heating stage',
      h('div',{class:'row'},this.waterReadout,this.sourceReadout),
      h('div',{class:'chips'},...this.sourceButtons),
      h('div',{class:'row'},h('span',{},'Heat transfer only'),this.timeScaleSelect),
      h('p',{class:'note'},'Boil sets the hot plate to 230 °C. Water temperature is solved separately. Waves, bodies and bubbles run in real time.')));
    panel.append(section('Drop an object · density kg/m³',
      h('div', { class: 'balls' }, ...TYPES.map((index, key) => {
        const t = BALL_TYPES[index];
        return h('button', { onclick: () => app.dropBall(index), title: `Key ${key + 1}: ${t.name}` },
          h('span', { class: 'dot', style: `background:${t.swatch}` }), t.name.split(' ')[0],
          h('span', { class: 'rho' }, `${t.density}`));
      })),
      h('div', { class: 'chips' },
        h('button', { onclick: () => app.clearBalls() }, 'Clear objects'),
        h('button', { onclick: () => this.floatSink() }, 'Float / sink'))));
    panel.append(section('Interaction',
      h('div', { class: 'chips' }, h('button', { onclick: () => this.ripple() }, 'Ripple'),
        h('button', { onclick: () => this.shake() }, 'Shake glass')),
      h('p', { class: 'note' }, 'Drag glass to slide, open water to stir, background to orbit.')));
    this.sloshToggle = toggle('Cup acceleration → sloshing', () => app.slosh.enabled, v => { app.slosh.enabled = v; });
    this.bodyToggle = toggle('Bodies ↔ waves', () => app.bodies.coupling.waves, v => { app.bodies.coupling.waves = v; });
    this.bubbleToggle = toggle('Bubbles → waves & bodies',()=>app.bubbles.coupling.surface,v=>{app.bubbles.coupling.surface=v;app.bubbles.coupling.bodies=v;});
    panel.append(section('Coupling comparison', this.sloshToggle, this.bodyToggle, this.bubbleToggle,
      h('p', { class: 'note' }, 'Disable Bodies ↔ waves, then repeat the same object drop. Buoyancy remains active.')));
    this.debugSelect = h('select', { onchange: e => this.setDebug(+e.target.value), 'aria-label': 'Debug inset' },
      h('option', { value: '0' }, 'None'), h('option', { value: '1' }, 'Height field'), h('option', { value: '2' }, 'Thermal field'));
    const quality = h('select', { onchange: e => app.setQuality(+e.target.value), 'aria-label': 'Resolution' },
      ...[[1, 'Full'], [0.8, 'Balanced'], [0.6, 'Fast'], [0.45, 'Very fast']].map(([v,l]) => h('option', { value: String(v) }, l)));
    quality.value = String(app.quality);
    this.qualitySelect = quality;
    panel.append(section('Rendering', h('div', { class: 'row' }, h('span', {}, 'Debug inset'), this.debugSelect),
      h('div', { class: 'row' }, h('span', {}, 'Resolution'), quality)));
    this.stats = h('div', { class: 'stats' });
    this.pauseButton = h('button', { onclick: () => this.togglePause() }, 'Pause');
    panel.append(section('Simulation', this.stats,
      h('div', { class: 'chips' }, this.pauseButton, h('button', { onclick: () => this.resetScene() }, 'Reset scene')),
      h('p', { class: 'note' }, '1–4 objects · R ripple · S shake · D field · P pause · 0 reset · H controls')));
  }
  shake() { this.app.cup.shake = 1.6; this.app.cup.shakeT = 0; }
  ripple() { this.app.waves.addImpulse(-0.008, 0.006, 0.004, -0.0012); }
  floatSink() {
    this.resetScene();
    this.app.dropBall(0, { x: -0.014, z: 0 });
    this.app.dropBall(4, { x: 0.014, z: 0 });
  }
  setDebug(mode) { this.app.debugMode = [0,1,2].includes(mode) ? mode : 0; this.debugSelect.value = String(this.app.debugMode); }
  resetScene() {
    const app = this.app;
    app.interaction.up();
    app.thermal.envTemp=ROOM.temperature; app.thermal.timeScale=120;
    app.clearBalls(); app.resetWater();
    this.timeScaleSelect.value='120';
    app.cup.pos.set(0, 0, 0); app.cup.vel.set(0, 0, 0); app.cup.acc.set(0, 0, 0);
    app.cup.target.set(0, 0, 0); app.cup.shake = 0;
    app.bodies._cupPrev = null;
    app.levelOffset = 0; app.bulge = 0;
    app.paused = false; this.pauseButton.textContent = 'Pause';
    app.follow = true;
    app.camera.position.set(0.2, 0.17, 0.31); app.controls.target.set(0, 0.055, 0); app.controls.update();
  }
  setSource(T) { this.app.thermal.envTemp=T; }
  togglePause() { this.app.paused = !this.app.paused; this.pauseButton.textContent = this.app.paused ? 'Resume' : 'Pause'; }
  setHidden(hidden) { this.root.classList.toggle('hidden', hidden); this.app.panelShift = !hidden; this.app.resize(); }
  update() {
    if (this.frame++ % 6) return;
    const app = this.app;
    const rows = [['fps', app.fps.toFixed(0)], ['CPU submit', `${app.frameMs.toFixed(1)} ms`],
      ['wave grid', `${GRID.waveN}×${GRID.waveN}`], ['substeps', app.waves.lastSubsteps ?? 0],
      ['objects', app.bodies.balls.length], ['water', `${app.thermal.stats.meanT.toFixed(1)} °C`], ['bubbles', app.bubbles.count], ['render', `${app.rw}×${app.rh}`]];
    this.waterReadout.textContent='Water '+app.thermal.stats.meanT.toFixed(1)+' °C';
    this.sourceReadout.textContent='Stage '+app.thermal.envTemp+' °C';
    this.sourceButtons.forEach((b,i)=>b.classList.toggle('active',app.thermal.envTemp===[22,85,230][i]));
    this.stats.replaceChildren(...rows.map(([k,v]) => h('span', {}, `${k} `, h('b', {}, String(v)))));
  }
}
