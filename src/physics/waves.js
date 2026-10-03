import * as THREE from 'three';
import { CUP, GRID, GRAVITY } from '../config.js';
import { surfaceTension, waterDensity, kinematicViscosity, capillaryLength } from './water.js';
import { FullscreenPass, shaderMaterial, makeTarget } from '../render/fsquad.js';
import { GLSL_HEADER } from '../render/glsl/header.js';
import COMMON from '../render/glsl/common.glsl?raw';

const MAX_IMPULSES = 48;

// GPU height field for ripples (millimetres, cup-local).
//
// The exact linear dispersion relation of capillary-gravity waves on depth D is
//     w^2(k) = (g k + sigma/rho k^3) tanh(k D).
// A local PDE cannot reproduce it exactly, so we least-squares fit
//     w^2(k) ~ c2 k^2 + beta k^4
// over the band of wavelengths the grid resolves (3 mm .. 40 mm), which yields the PDE
//     h_tt = c2 lap(h) - beta lap^2(h) + 2 nu lap(h_t) - gamma h_t
// The 2 nu k^2 term is the exact viscous decay rate of linear surface waves, so ripples
// die faster in cold (viscous) water than in hot water. sigma, rho and nu all follow T.

const STEP_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uSurfacePrev;
uniform float uDt, uDx, uC2, uBeta, uNu, uGamma, uGammaWall, uIceCoupling;
uniform vec4 uImp[${MAX_IMPULSES}];
uniform int uImpCount;
uniform float uMeanShift;
in vec2 vUv;
out vec4 fragColor;

const int N = int(WAVE_N);
vec2 posOf(ivec2 c) { return ((vec2(c) + 0.5) / WAVE_N * 2.0 - 1.0) * R_IN; }
ivec2 cellOf(vec2 p) { return ivec2(floor((p / R_IN * 0.5 + 0.5) * WAVE_N)); }
vec2 S(ivec2 c) { return texelFetch(uState, clamp(c, ivec2(0), ivec2(N - 1)), 0).rg; }

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 p = posOf(c);
  float r = length(p);
  if (r >= R_IN) {
    // ghost cell: mirror across the wall (Neumann / no-flux boundary)
    vec2 q = p * (2.0 * R_IN - r) / r;
    fragColor = vec4(S(cellOf(q)), 0.0, 1.0);
    return;
  }
  vec2 s0 = S(c);
  float h = s0.x, hp = s0.y;
  vec2 sE = S(c + ivec2(1, 0)), sW = S(c - ivec2(1, 0)), sN = S(c + ivec2(0, 1)), sS = S(c - ivec2(0, 1));
  float hNE = S(c + ivec2(1, 1)).x, hNW = S(c + ivec2(-1, 1)).x, hSE = S(c + ivec2(1, -1)).x, hSW = S(c + ivec2(-1, -1)).x;
  float hEE = S(c + ivec2(2, 0)).x, hWW = S(c - ivec2(2, 0)).x, hNN = S(c + ivec2(0, 2)).x, hSS = S(c - ivec2(0, 2)).x;
  float ring = sE.x + sW.x + sN.x + sS.x;
  float dx2 = uDx * uDx;
  float lap = (ring - 4.0 * h) / dx2;
  float bilap = (20.0 * h - 8.0 * ring + 2.0 * (hNE + hNW + hSE + hSW) + (hEE + hWW + hNN + hSS)) / (dx2 * dx2);
  float v = h - hp;
  float lapv = ((sE.x - sE.y) + (sW.x - sW.y) + (sN.x - sN.y) + (sS.x - sS.y) - 4.0 * v) / dx2;

  float wall = smoothstep(R_IN - 4.0 * uDx, R_IN, r);
  float damp = (uGamma + uGammaWall * wall) * uDt;
  float hn = h + v * (1.0 - damp) + uDt * uDt * (uC2 * lap - uBeta * bilap) + uDt * 2.0 * uNu * lapv;

  // a frozen surface is rigid: no displacement change, no velocity
  float ice = texture(uSurfacePrev, vUv).a * uIceCoupling;
  float rigid = smoothstep(0.15, 0.85, ice);
  hn = mix(hn, h, rigid);

  float add = -uMeanShift;
  for (int i = 0; i < ${MAX_IMPULSES}; i++) {
    if (i >= uImpCount) break;
    vec4 im = uImp[i];
    vec2 d = p - im.xy;
    add += im.w * exp(-dot(d, d) / (im.z * im.z));
  }
  add *= 1.0 - rigid;
  hn += add; h += add;
  // safety: the linear model is meaningless beyond a few cm; never let a NaN persist
  hn = clamp(hn, h - 0.004, h + 0.004);
  hn = clamp(hn, -0.02, 0.02); h = clamp(h, -0.02, 0.02);
  if (isnan(hn) || isnan(h)) { hn = 0.0; h = 0.0; }
  fragColor = vec4(hn, h, 0.0, 1.0);
}
`;

const COMPOSE_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uThermal;
uniform vec4 uSlosh;           // wall amplitudes (mm): mode1 x,z, mode2 x,z
uniform float uMenH0, uMenLc;  // meniscus height (mm), capillary length (m)
uniform float uOffset;         // global level offset (mm)
uniform float uBulge;          // ice expansion bump (mm)
uniform float uDx;
in vec2 vUv;
out vec4 fragColor;

float J1(float x) {
  float t = x * 0.5, s = t, q = -x * x * 0.25;
  for (int m = 1; m < 12; m++) { t *= q / float(m * (m + 1)); s += t; }
  return s;
}

float hField(vec2 p) {
  vec2 uv = p / R_IN * 0.5 + 0.5;
  return texture(uState, uv).r;
}

float eta(vec2 p) {
  float r = length(p);
  vec2 pc = r > R_IN ? p * (R_IN / r) : p;
  float rc = min(r, R_IN);
  float e = hField(pc);
  if (rc > 1e-6) {
    vec2 dir = pc / rc;
    e += J1(1.841184 * rc / R_IN) / 0.581865 * dot(uSlosh.xy, dir);
    e += J1(5.331443 * rc / R_IN) / -0.346321 * dot(uSlosh.zw, dir);
  }
  e += uMenH0 * exp(-(R_IN - rc) / uMenLc);
  float q = rc / R_IN;
  e += uBulge * (0.35 + 1.3 * pow(max(0.0, 1.0 - q * q), 1.6));
  return e + uOffset;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * R_IN;
  float e = eta(p);
  float ex = (eta(p + vec2(uDx, 0.0)) - eta(p - vec2(uDx, 0.0))) / (2.0 * uDx) * 1e-3;
  float ez = (eta(p + vec2(0.0, uDx)) - eta(p - vec2(0.0, uDx))) / (2.0 * uDx) * 1e-3;
  float ice = iceSurfaceMask(uThermal, p * min(1.0, R_IN / max(length(p), 1e-6)));
  fragColor = vec4(e, ex, ez, ice);
}
`;

const READ_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
uniform float uDt;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 s = texture(uState, vUv).rg;
  fragColor = vec4(s.x, (s.x - s.y) / uDt, 0.0, 1.0);
}
`;

export function fitDispersion(T) {
  const sigma = surfaceTension(T), rho = waterDensity(T), D = CUP.fill;
  // weighted least squares on relative error: minimise sum ((c2 k^2 + b k^4 - w2) / w2)^2
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  const kMin = 2 * Math.PI / 0.04, kMax = 2 * Math.PI / 0.003;
  for (let i = 0; i <= 200; i++) {
    const k = kMin * Math.pow(kMax / kMin, i / 200);
    const w2 = (GRAVITY * k + sigma / rho * k ** 3) * Math.tanh(k * D);
    const x1 = k * k / w2, x2 = k ** 4 / w2;
    a11 += x1 * x1; a12 += x1 * x2; a22 += x2 * x2; b1 += x1; b2 += x2;
  }
  const det = a11 * a22 - a12 * a12;
  const c2 = (b1 * a22 - b2 * a12) / det;
  const beta = (a11 * b2 - a12 * b1) / det;
  return { c2, beta, sigma, rho };
}

export class Waves {
  constructor(renderer, thermalTexture) {
    this.renderer = renderer;
    const N = GRID.waveN;
    this.N = N;
    this.dx = 2 * CUP.rIn / N;
    const opt = { type: THREE.FloatType, filter: THREE.NearestFilter };
    this.state = [makeTarget(N, N, opt), makeTarget(N, N, opt)];
    this.surface = [makeTarget(N, N, { type: THREE.HalfFloatType }), makeTarget(N, N, { type: THREE.HalfFloatType })];
    this.readN = GRID.readN;
    this.readTarget = makeTarget(this.readN, this.readN, { type: THREE.FloatType, filter: THREE.NearestFilter });
    this.readBuffer = new Float32Array(this.readN * this.readN * 4);
    this.cpuField = new Float32Array(this.readN * this.readN * 4);
    this.readPending = false;
    this.cur = 0;
    this.curSurf = 0;

    const prefix = GLSL_HEADER + COMMON;
    this.impulses = [];
    const impUniform = Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4());
    this.stepPass = new FullscreenPass(shaderMaterial({
      fragmentShader: GLSL_HEADER + STEP_FRAG,
      uniforms: {
        uState: { value: null }, uSurfacePrev: { value: null },
        uDt: { value: 0 }, uDx: { value: this.dx }, uC2: { value: 0 }, uBeta: { value: 0 },
        uNu: { value: 1e-6 }, uGamma: { value: 0.8 }, uGammaWall: { value: 9 },
        uIceCoupling: { value: 1 },
        uImp: { value: impUniform }, uImpCount: { value: 0 }, uMeanShift: { value: 0 },
      },
    }));
    this.composePass = new FullscreenPass(shaderMaterial({
      fragmentShader: prefix + COMPOSE_FRAG,
      uniforms: {
        uState: { value: null }, uThermal: { value: thermalTexture },
        uSlosh: { value: new THREE.Vector4() },
        uMenH0: { value: 2.0 }, uMenLc: { value: 0.0027 },
        uOffset: { value: 0 }, uBulge: { value: 0 }, uDx: { value: this.dx },
      },
    }));
    this.readPass = new FullscreenPass(shaderMaterial({
      fragmentShader: READ_FRAG,
      uniforms: { uState: { value: null }, uDt: { value: 1 } },
    }));

    this.params = { c2: 0, beta: 0, nu: 1e-6, dtSub: 4e-4 };
    this.setTemperature(20);
    this.simTime = 0;
    this.carry = 0;
    this.maxSubsteps = 64;
    this.clear();
  }

  clear() {
    const r = this.renderer;
    const old = r.getClearColor(new THREE.Color());
    const oldA = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [...this.state, ...this.surface]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setRenderTarget(null);
    r.setClearColor(old, oldA);
    this.cpuField.fill(0);
  }

  setTemperature(T) {
    const { c2, beta, sigma, rho } = fitDispersion(T);
    const nu = kinematicViscosity(Math.max(0, T));
    const dx = this.dx;
    const wmax = Math.sqrt(c2 * 8 / (dx * dx) + beta * 64 / dx ** 4);
    this.params = { c2, beta, nu, dtSub: 1.55 / wmax, sigma, rho };
    const u = this.stepPass.material.uniforms;
    u.uC2.value = c2; u.uBeta.value = beta; u.uNu.value = nu;
    const lc = capillaryLength(T);
    const cu = this.composePass.material.uniforms;
    cu.uMenLc.value = lc;
    // static meniscus height for a ~35 degree contact angle on clean glass
    cu.uMenH0.value = lc * Math.sqrt(2 * (1 - Math.sin(35 * Math.PI / 180))) * 1000 * 0.75;
  }

  // displacement impulse: Gaussian of radius rad (m) and peak amp (m) at cup-local (x, z)
  addImpulse(x, z, rad, amp) {
    if (!isFinite(amp) || Math.abs(amp) < 1e-7) return;
    rad = Math.max(rad, this.dx * 1.2);
    this.impulses.push([x, z, rad, amp * 1000]);
  }

  step(dt) {
    const r = this.renderer;
    const u = this.stepPass.material.uniforms;
    const dtSub = this.params.dtSub;
    this.carry += Math.min(dt, 1 / 20);
    let n = Math.floor(this.carry / dtSub);
    if (n > this.maxSubsteps) { n = this.maxSubsteps; this.carry = 0; } else this.carry -= n * dtSub;
    u.uDt.value = dtSub;
    u.uSurfacePrev.value = this.surface[this.curSurf].texture;

    // pack impulses (largest first if there are too many)
    let imps = this.impulses;
    if (imps.length > MAX_IMPULSES) {
      imps.sort((a, b) => Math.abs(b[3] * b[2] * b[2]) - Math.abs(a[3] * a[2] * a[2]));
      imps = imps.slice(0, MAX_IMPULSES);
    }
    let mean = 0;
    imps.forEach((im, i) => {
      u.uImp.value[i].set(im[0], im[1], im[2], im[3]);
      mean += im[3] * Math.PI * im[2] * im[2] / CUP.area;
    });
    this.impulses = [];

    for (let s = 0; s < n; s++) {
      const first = s === 0;
      u.uImpCount.value = first ? imps.length : 0;
      u.uMeanShift.value = first ? mean : 0;
      u.uState.value = this.state[this.cur].texture;
      this.stepPass.render(r, this.state[1 - this.cur]);
      this.cur = 1 - this.cur;
    }
    if (n === 0 && imps.length) this.impulses = imps.map((v) => v); // keep for next frame
    this.simTime += n * dtSub;
    this.lastSubsteps = n;
  }

  compose(sloshMm, offsetMm, bulgeMm) {
    const cu = this.composePass.material.uniforms;
    cu.uState.value = this.state[this.cur].texture;
    cu.uSlosh.value.set(sloshMm[0], sloshMm[1], sloshMm[2], sloshMm[3]);
    cu.uOffset.value = offsetMm;
    cu.uBulge.value = bulgeMm;
    this.curSurf = 1 - this.curSurf;
    this.composePass.render(this.renderer, this.surface[this.curSurf]);
  }

  get surfaceTexture() { return this.surface[this.curSurf].texture; }
  get stateTexture() { return this.state[this.cur].texture; }

  readback() {
    if (this.readPending) return;
    const ru = this.readPass.material.uniforms;
    ru.uState.value = this.state[this.cur].texture;
    ru.uDt.value = this.params.dtSub;
    this.readPass.render(this.renderer, this.readTarget);
    this.readPending = true;
    this.renderer.readRenderTargetPixelsAsync(this.readTarget, 0, 0, this.readN, this.readN, this.readBuffer)
      .then(() => { this.cpuField.set(this.readBuffer); this.readPending = false; })
      .catch(() => { this.readPending = false; });
  }

  // ripple height (m) and vertical velocity (m/s) at cup-local (x, z)
  sample(x, z, out) {
    const n = this.readN;
    const fx = THREE.MathUtils.clamp((x / CUP.rIn * 0.5 + 0.5) * n - 0.5, 0, n - 1.001);
    const fz = THREE.MathUtils.clamp((z / CUP.rIn * 0.5 + 0.5) * n - 0.5, 0, n - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const f = this.cpuField;
    const idx = (a, b) => (b * n + a) * 4;
    const i00 = idx(i, j), i10 = idx(i + 1, j), i01 = idx(i, j + 1), i11 = idx(i + 1, j + 1);
    const lerp2 = (o) => (f[i00 + o] * (1 - tx) + f[i10 + o] * tx) * (1 - tz) + (f[i01 + o] * (1 - tx) + f[i11 + o] * tx) * tz;
    out[0] = lerp2(0) * 1e-3;
    out[1] = lerp2(1) * 1e-3;
    return out;
  }
}
