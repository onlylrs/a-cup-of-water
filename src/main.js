import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import { CUP, LIGHT, LIMITS, ROOM } from './config.js';
import { HeatingSim } from './physics/thermal.js';
import { Bubbles } from './physics/bubbles.js';
import { Caustics } from './render/caustics.js';
import { Steam } from './render/steam.js';
import { Slosh } from './physics/slosh.js';
import { Waves } from './physics/waves.js';
import { Bodies } from './physics/bodies.js';
import { waterIor } from './physics/water.js';
import { BALL_TYPES } from './physics/materials.js';
import { createEnvironment } from './render/environment.js';
import { createTable, createBackdrop, tableUniforms } from './render/table.js';
import { createCupMaterial, createCupProxy } from './render/cup.js';
import { createNoise3D } from './render/noise3d.js';
import { createBallMeshFactory } from './render/objects.js';
import { Post } from './render/post.js';
import { FullscreenPass, shaderMaterial, makeTarget } from './render/fsquad.js';
import { CupController, Interaction } from './interaction.js';
import { UI } from './ui.js';

const COPY_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = vec4(texture(uSrc, vUv).rgb, 1.0); }
`;
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _tmp4 = [0, 0, 0, 0];
const _tmp2 = [0, 0];
const _w = [0, 0];

class App {
  constructor() {
    const canvas = document.getElementById('view');
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    this.renderer = renderer;
    this.quality = 0.8;

    // ---------------- simulation
    this.thermal = new HeatingSim();
    this.slosh = new Slosh();
    this.waves = new Waves(renderer, this.thermal.texture);
    this.bodies = new Bodies();
    this.bubbles = new Bubbles();
    this.emptyTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    this.emptyTexture.needsUpdate = true;
    this.bodies.coupling.ice = false;
    this.bodies.coupling.bubbles = true;
    this.cup = new CupController();
    this.levelOffset = 0;
    this.bulge = 0;
    this.topT = ROOM.temperature;
    this.lastWaveT = -100;
    this.time = 0;
    this.paused = false;

    // ---------------- look
    const env = createEnvironment(renderer);
    const L = new THREE.Vector3(...LIGHT.dir).normalize();
    this.lightDir = L;
    this.shared = {
      uEnv: { value: env.cube },
      uEnvMaxLod: { value: env.maxLod },
      uLightDir: { value: L },
      uLightColor: { value: new THREE.Vector3(...LIGHT.color).multiplyScalar(LIGHT.intensity) },
      uCaustics: tableUniforms.uCaustics,
      uCausticRect: tableUniforms.uCausticRect,
      uLightPlane: tableUniforms.uLightPlane,
      uLightU: tableUniforms.uLightU,
      uLightV: tableUniforms.uLightV,
      uLightOrigin: tableUniforms.uLightOrigin,
    };
    this.noise3 = createNoise3D(64);

    const scene = new THREE.Scene();
    scene.environment = env.pmrem;
    scene.environmentIntensity = 1.0;
    this.scene = scene;
    this.table = createTable();
    scene.add(this.table);
    scene.add(createBackdrop());

    const sun = new THREE.DirectionalLight(new THREE.Color(...LIGHT.color), LIGHT.intensity * Math.PI);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -0.3; sc.right = 0.3; sc.top = 0.3; sc.bottom = -0.3; sc.near = 0.05; sc.far = 3;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.002;
    sun.shadow.radius = 4;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    this.cupMaterial = createCupMaterial(this.shared);
    this.cupMaterial.depthWrite = false;
    const cu = this.cupMaterial.uniforms;
    cu.uThermal.value = this.thermal.texture;
    cu.uBubbles.value = this.bubbles.texture;
    cu.uCond.value = this.emptyTexture;
    cu.uNoise3.value = this.noise3;
    this.cupMesh = createCupProxy(this.cupMaterial);
    this.cupMesh.renderOrder = 2;
    scene.add(this.cupMesh);

    this.makeBallMesh = createBallMeshFactory(this.shared);
    this.ballMeshes = new Map();
    this.caustics = new Caustics(renderer, { surface: this.waves.surfaceTexture, thermal: this.thermal.texture, cond: this.emptyTexture });
    this.caustics.material.uniforms.uBallPos = cu.uBallPos;
    this.caustics.material.uniforms.uBallCount = cu.uBallCount;
    tableUniforms.uCaustics.value = this.caustics.target.texture;
    this.steam = new Steam(this.shared, this.noise3);
    this.steamScene = new THREE.Scene();
    this.steamScene.add(this.steam.mesh);
    this.steamComposite = new FullscreenPass(shaderMaterial({
      fragmentShader: 'precision highp float; uniform sampler2D uSrc; in vec2 vUv; out vec4 fragColor; void main(){ fragColor=texture(uSrc,vUv); }',
      uniforms: { uSrc: { value: null } }, transparent: true, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.bubbles.onBurst = b => {
      if (!b.gas && this.topT > 90 && b.R > 0.0008) this.steam.addPuff(this.cup.pos.x+b.x, this.surfaceAt(b.x,b.z,_tmp4)[0]+.004, this.cup.pos.z+b.z, Math.min(1,b.R/.002)*.6);
    };

    // top-down view of the table around the glass (fallback for refracted rays that land off-screen)
    this.topSize = 0.42;
    this.topTarget = makeTarget(768, 768, { type: THREE.HalfFloatType, depth: true, mipmaps: true });
    this.topCam = new THREE.OrthographicCamera(-this.topSize / 2, this.topSize / 2, this.topSize / 2, -this.topSize / 2, 0.05, 2);
    this.topCam.up.set(0, 0, -1);
    cu.uTableTop.value = this.topTarget.texture;

    this.copyPass = new FullscreenPass(shaderMaterial({ fragmentShader: COPY_FRAG, uniforms: { uSrc: { value: null } } }));
    this.post = new Post(renderer);
    this.debugMode = 0;

    // ---------------- camera
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 30);
    this.camera.position.set(0.2, 0.17, 0.31);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.055, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.13;
    this.controls.maxDistance = 0.9;
    this.controls.maxPolarAngle = 1.5;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.7;
    this.controls.update();

    this.follow = true;
    this.interaction = new Interaction({ canvas, camera: this.camera, controls: this.controls, app: this });

    // ---------------- render targets
    this.targets = null;
    this.panelShift = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.ui = new UI(this);
    this.fps = 60;
    this.frameMs = 16;
    this._last = performance.now();
    renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- helpers
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = dpr * this.quality;
    const W = Math.max(2, Math.round(w * s)), H = Math.max(2, Math.round(h * s));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // keep the glass centred in the area left free by the control panel
    const shift = !this.panelShift ? 0 : w > 900 ? 160 : w > 600 ? 135 : 0;
    if (shift) this.camera.setViewOffset(w, h, shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.targets) for (const t of Object.values(this.targets)) t.dispose();
    this.targets = {
      bg: makeTarget(W, H, { type: THREE.HalfFloatType, depth: true, samples: 4, mipmaps: true }),
      main: makeTarget(W, H, { type: THREE.HalfFloatType, depth: true, samples: 4, mipmaps: true }),
      final: makeTarget(W, H, { type: THREE.HalfFloatType }),
      steam: makeTarget(Math.ceil(W/2), Math.ceil(H/2), { type: THREE.HalfFloatType }),
    };
    this.rw = W; this.rh = H;
    this.post.resize(W, H);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.final.material.uniforms.uRes.value.copy(buf);
  }

  setQuality(q) {
    this.quality = [1, 0.8, 0.6, 0.45].includes(q) ? q : 0.8;
    if (this.ui?.qualitySelect) this.ui.qualitySelect.value = String(this.quality);
    this.resize();
  }

  surfaceLevel() { return CUP.level + this.levelOffset; }

  iceAt(r) { return this.thermal.solidAt(Math.min(r, CUP.rIn), CUP.level); }

  _bulgeShape(r) {
    const q = Math.min(1, r / CUP.rIn);
    return this.bulge * (0.35 + 1.3 * Math.pow(Math.max(0, 1 - q * q), 1.6));
  }

  // free surface at cup-local (x, z): [height (cup-local y), vertical velocity, slope x, slope z]
  surfaceAt(x, z, out) {
    const wv = this.waves, sl = this.slosh;
    const e = 0.0015;
    const h = (px, pz) => wv.sample(px, pz, _w)[0] + sl.height(px, pz);
    wv.sample(x, z, _w);
    const h0 = _w[0], v0 = _w[1];
    out[0] = CUP.level + this.levelOffset + h0 + sl.height(x, z) + this._bulgeShape(Math.hypot(x, z));
    out[1] = v0 + sl.verticalVelocity(x, z);
    out[2] = (h(x + e, z) - h(x - e, z)) / (2 * e);
    out[3] = (h(x, z + e) - h(x, z - e)) / (2 * e);
    return out;
  }

  // the surface without the ripple field: the reference a body's displacement is measured
  // against when it radiates waves (measuring against the ripples it creates is a feedback loop)
  surfaceRefAt(x, z) {
    return CUP.level + this.levelOffset + this.slosh.height(x, z) + this._bulgeShape(Math.hypot(x, z));
  }

  dropBall(typeIndex, local) {
    if (![0, 1, 3, 4].includes(typeIndex)) return null;
    const t = BALL_TYPES[typeIndex];
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * (CUP.rIn - t.radius - 0.004);
    const lx = local ? local.x : Math.cos(a) * rr, lz = local ? local.z : Math.sin(a) * rr;
    const pos = new THREE.Vector3(this.cup.pos.x + lx, (local ? CUP.height + 0.065 : CUP.height + 0.05 + Math.random() * 0.03), this.cup.pos.z + lz);
    const b = this.bodies.add(typeIndex, pos);
    b.vel.copy(this.cup.vel);
    return b;
  }

  clearBalls() { this.bodies.clear(); }

  resetWater() {
    this.thermal.reset();
    this.bubbles.clear();
    this.bubbles.count = 0;
    this.steam.puffs.length = 0;
    this.waves.clear();
    for (const b of this.bodies.balls) b.locked = false;
    this.slosh.A.forEach((a) => { a[0] = a[1] = 0; });
    this.slosh.V.forEach((a) => { a[0] = a[1] = 0; });
  }

  // ---------------------------------------------------------------- frame
  frame() {
    const t0 = performance.now();
    const fd = (t0 - this._last) / 1000;
    this._last = t0;
    if (fd > 0) this.fps += (1 / fd - this.fps) * 0.05;
    let dt = Math.min(fd, 1 / 30);
    if (this.paused) dt = 0;
    this.time += dt;
    if (dt > 0) this.simulate(dt);
    this.render();
    const ms = performance.now() - t0;
    this.frameMs += (ms - this.frameMs) * 0.05;
    this.ui.update();
  }

  simulate(dt) {
    const th = this.thermal, st = th.stats;
    this.cup.update(dt);
    th.step(dt);

    // free-surface physical properties follow the top layer of water
    const topT = 0.5 * (th.temperatureAt(0.0, CUP.level) + th.temperatureAt(CUP.rIn * 0.6, CUP.level));
    this.topT = topT;
    const Tw = THREE.MathUtils.clamp(topT, 0, 100);
    if (Math.abs(Tw - this.lastWaveT) > 1) { this.waves.setTemperature(Tw); this.lastWaveT = Tw; }
    this.waves.stepPass.material.uniforms.uIceCoupling.value = this.bodies.coupling.ice ? 1 : 0;
    this.slosh.updateProperties(Tw, this.bodies.coupling.ice ? st.topIce : 0);
    this.slosh.step(dt, this.cup.acc.x, this.cup.acc.z);

    // global level: displaced volume of the bodies + expansion of water on freezing (rho_ice < rho_w)
    const iceExp = CUP.fill * st.iceFraction * (1000 / 917 - 1);
    this.bulge = iceExp / 0.85;
    this.levelOffset = this.bodies.displacedVolume(this.cup.pos) / CUP.area;

    const env = {
      cup: this.cup,
      surface: (x, z, out) => this.surfaceAt(x, z, out),
      surfaceRef: (x, z) => this.surfaceRefAt(x, z),
      sloshVel: (x, z, out) => this.slosh.horizontalVelocity(x, z, out),
      thermal: th,
      T: THREE.MathUtils.clamp(st.meanT, 0, 100),
      waves: this.waves,
      balls: this.bodies.balls,
      ice: (r) => (this.bodies.coupling.ice ? this.iceAt(r) : 0),
    };
    this.bodies.step(dt, env);
    this.bodies.updateLocks(env);
    this.bubbles.step(dt, env);
    this.interaction.update(dt);

    this.waves.step(dt);
    const sA = this.slosh.A;
    this.waves.compose([sA[0][0] * 1e3, sA[0][1] * 1e3, sA[1][0] * 1e3, sA[1][1] * 1e3], this.levelOffset * 1e3, this.bulge * 1e3);
    this.waves.readback(this.bodies.frame);
    const steamD = THREE.MathUtils.smoothstep(topT,55,99)*.55 + st.boiling*.9;
    this.steam.update(dt,this.time,this.cup.pos,this.cup.vel,steamD);

  }

  _rippleBound() {
    const f = this.waves.cpuField;
    let m = 0;
    for (let i = 0; i < f.length; i += 12) m = Math.max(m, Math.abs(f[i]));
    return m * 1e-3;
  }

  _syncBallMeshes(inCup) {
    const alive = new Set();
    for (const b of this.bodies.balls) {
      alive.add(b.id);
      let m = this.ballMeshes.get(b.id);
      if (!m) {
        m = this.makeBallMesh(b.type.mat);
        this.ballMeshes.set(b.id, m);
        this.scene.add(m);
      }
      m.position.copy(b.pos);
      m.scale.setScalar(b.r);
      _q.copy(b.quat).invert();
      m.material.uniforms.uRot.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_q));
      m.userData.inCup = inCup.has(b);
      // Internal spheres occlude refracted light in the caustics pass. Their
      // raster proxies must not cast a second, unrefracted opaque table shadow.
      m.castShadow = !m.userData.inCup;
    }
    for (const [id, m] of this.ballMeshes) {
      if (!alive.has(id)) { this.scene.remove(m); m.material.dispose(); this.ballMeshes.delete(id); }
    }
  }

  render() {
    const r = this.renderer;
    const cam = this.camera;
    const cupPos = this.cup.pos;
    const st = this.thermal.stats;
    this.cupMesh.position.copy(cupPos);

    // camera follows the glass
    if (this.follow) {
      const want = new THREE.Vector3(cupPos.x, 0.055, cupPos.z);
      const d = want.sub(this.controls.target).multiplyScalar(0.06);
      this.controls.target.add(d);
      cam.position.add(d);
    }
    this.controls.update();
    cam.updateMatrixWorld();

    // bodies that intersect the glass' volume are ray traced, the rest rasterised
    const inCup = new Set();
    const cu = this.cupMaterial.uniforms;
    let n = 0;
    for (const b of this.bodies.balls) {
      const lx = b.pos.x - cupPos.x, lz = b.pos.z - cupPos.z;
      if (Math.hypot(lx, lz) < CUP.rOut + b.r && b.pos.y - b.r < CUP.height && n < LIMITS.maxBalls) {
        inCup.add(b);
        cu.uBallPos.value[n].set(lx, b.pos.y, lz, b.r);
        cu.uBallInfo.value[n].set(b.type.mat, 0, 0, 0);
        _q.copy(b.quat).invert();
        cu.uBallRot.value[n].setFromMatrix4(_m4.makeRotationFromQuaternion(_q));
        n++;
      }
    }
    cu.uBallCount.value = n;
    this._syncBallMeshes(inCup);

    // ---- uniforms
    const ripple = this._rippleBound();
    const sl = this.slosh.energy() * 1.6;
    const bulgeMax = this.bulge * 1.65;
    const menH = this.waves.composePass.material.uniforms.uMenH0.value * 1e-3;
    const etaMin = this.levelOffset - sl - ripple - 0.0008;
    const etaMax = this.levelOffset + sl + ripple + menH + bulgeMax + 0.0008;
    const ior = waterIor(THREE.MathUtils.clamp(this.topT, 0, 100));
    const ice = this.bodies.coupling.ice ? st.iceFraction : 0;

    cu.uCupPos.value.copy(cupPos);
    cu.uSurface.value = this.waves.surfaceTexture;
    cu.uBubbleCount.value = this.bubbles.count;
    cu.uCond.value = this.emptyTexture;
    cu.uEtaMin.value = etaMin; cu.uEtaMax.value = etaMax;
    cu.uIorWater.value = ior;
    cu.uTime.value = this.time;
    cu.uIce.value = st.iceFraction;
    cu.uWallBubbles.value = st.wallBubbles;
    cu.uShimmer.value = THREE.MathUtils.clamp(Math.abs(this.thermal.envTemp - st.meanT) / 40, 0, 1) * (1 - st.iceFraction);
    cu.uTopT.value = this.topT;

    tableUniforms.uCupPos.value.copy(cupPos);
    this.caustics.update(cupPos,this.lightDir,{ior,etaMin,etaMax,ice:0,surface:this.waves.surfaceTexture,cond:this.emptyTexture});
    tableUniforms.uCausticRect.value.copy(this.caustics.rect);
    tableUniforms.uLightPlane.value.set(cupPos.x,cupPos.z,this.caustics.extent,this.caustics.enabled?1:0);
    tableUniforms.uLightU.value.copy(this.caustics.lightU);
    tableUniforms.uLightV.value.copy(this.caustics.lightV);
    tableUniforms.uLightOrigin.value.copy(this.caustics.lightOrigin);

    this.sun.position.copy(cupPos).addScaledVector(this.lightDir, 1.2);
    this.sun.target.position.copy(cupPos);
    this.sun.target.updateMatrixWorld();

    // ---- pass 1: background (what the glass refracts) — no glass, no droplets, no traced bodies
    r.shadowMap.needsUpdate = true;
    this.cupMesh.visible = false;
    for (const m of this.ballMeshes.values()) {
      if (m.userData.inCup) { m.material.colorWrite = false; m.material.depthWrite = false; }
    }
    r.setRenderTarget(this.targets.bg);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    for (const m of this.ballMeshes.values()) { m.material.colorWrite = true; m.material.depthWrite = true; }

    // table only, seen from straight above
    const hidden = [];
    for (const o of this.scene.children) if (o !== this.table && o.visible && !o.isLight) { hidden.push(o); o.visible = false; }
    this.topCam.position.set(cupPos.x, 1.0, cupPos.z);
    this.topCam.lookAt(cupPos.x, 0, cupPos.z);
    this.topCam.updateMatrixWorld();
    r.setRenderTarget(this.topTarget);
    r.clear(true, true, false);
    r.render(this.scene, this.topCam);
    for (const o of hidden) o.visible = true;
    const s = this.topSize;
    cu.uTableRect.value.set(cupPos.x - s / 2, cupPos.z + s / 2, s, -s);
    this.cupMesh.visible = true;

    // ---- pass 2: full scene with the ray-traced glass
    cu.uBg.value = this.targets.bg.texture;
    cu.uViewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    r.setRenderTarget(this.targets.main);
    r.clear(true, true, false);
    r.render(this.scene, cam);

    // Heating build: composite steam over the traced liquid scene.
    this.copyPass.material.uniforms.uSrc.value = this.targets.main.texture;
    this.copyPass.render(r, this.targets.final);
    if (this.steam.mesh.visible) {
      r.setRenderTarget(this.targets.steam); r.setClearColor(0x000000,0); r.clear(true,false,false);
      r.render(this.steamScene,cam);
      this.steamComposite.material.uniforms.uSrc.value=this.targets.steam.texture;
      this.steamComposite.render(r,this.targets.final);
    }

    // ---- pass 4: post
    const dbg = [null, this.waves.surfaceTexture, this.thermal.texture][this.debugMode] || null;
    this.post.render(this.targets.final.texture, this.rw, this.rh, this.time, dbg, this.debugMode, this.camera.aspect);
  }
}

// console helper for reproducible views: app.view([x, y, z], [tx, ty, tz])
App.prototype.view = function (pos, target = [this.cup.pos.x, 0.055, this.cup.pos.z]) {
  this.follow = false;
  this.controls.minDistance = 0.02;
  this.camera.position.set(...pos);
  this.controls.target.set(...target);
  this.controls.update();
};

const app = new App();
window.app = app;

// URL parameters for reproducible figures, e.g.
//   ?cam=0,0.16,0.20,0,0.06,0&ui=0&balls=0,4&debug=1
{
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) ? q.get(k).split(',').map(Number) : null);
  const cam = num('cam');
  if (cam) app.view(cam.slice(0, 3), cam.length >= 6 ? cam.slice(3, 6) : undefined);
  if (q.get('ui') === '0') app.ui.setHidden(true);
  if (q.has('debug')) app.ui.setDebug(+q.get('debug'));
  if (q.has('temp')) app.ui.setSource(+q.get('temp'));
  if (q.has('ts')) app.thermal.timeScale = Math.max(1,Math.min(600,+q.get('ts')||120));
  if (q.has('quality')) app.setQuality(+q.get('quality'));
  const balls = num('balls');
  if (balls) balls.forEach((b, i) => setTimeout(() => app.dropBall(b), 300 + i * 400));
}
