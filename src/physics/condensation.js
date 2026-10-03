import * as THREE from 'three';
import { CUP, GRID, ROOM, LIMITS } from '../config.js';
import { FullscreenPass, shaderMaterial, makeTarget } from '../render/fsquad.js';
import { GLSL_HEADER } from '../render/glsl/header.js';
import COMMON from '../render/glsl/common.glsl?raw';
import { mulberry } from './bubbles.js';

// Moisture on the glass, stored in a (theta, y) map wrapped around the outer wall:
//   R  fog    - film of micro-droplets (condensation below the dew point, T > 0)
//   G  frost  - deposited ice crystals (glass below 0 °C), grows dendritically from seeds
//   B  water  - volume in visible droplets (frost melts into it, it evaporates when warm)
//   A  inner  - fog on the inside wall above hot water (vapour from the liquid condensing)
// Rates depend on the dew-point depression of the outer glass temperature that the thermal
// solver provides; the user can wipe fog/frost off and it re-forms physically.

const UPDATE_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uPrev;
uniform sampler2D uThermal;
uniform float uDt, uDew, uLevel, uTime, uWaterT;
uniform vec4 uWipe;        // u, v of current point, radius (m), active
uniform vec4 uWipePrev;
uniform vec4 uDrips[${LIMITS.maxDrips}];   // u, v head, half-width (m), v previous
uniform int uDripCount;
uniform float uReset;
in vec2 vUv;
out vec4 fragColor;

const float CIRC = TAU * R_OUT;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
  return length(pa - ba * h);
}
// physical position on the unrolled wall, with seam-aware offset towards a reference u
vec2 phys(vec2 uv, float refU) {
  float du = uv.x - refU;
  du -= floor(du + 0.5);
  return vec2((refU + du) * CIRC, uv.y * CUP_H);
}

void main() {
  vec4 s = texture(uPrev, vUv);
  if (uReset > 0.5) s = vec4(0.0);
  vec2 texel = 1.0 / vec2(textureSize(uPrev, 0));
  float y = vUv.y * CUP_H;
  float Tg = thermalAt(uThermal, R_OUT - 0.0006, y).y;
  float Tin = thermalAt(uThermal, R_IN + 0.0006, y).y;
  vec2 cell = vUv * vec2(${GRID.condW}.0, ${GRID.condH}.0);
  float var = 0.45 + 1.1 * fbm2(cell * 0.11) ;
  float seed = step(0.992, hash12(floor(cell * 0.5)));

  float dew = uDew - Tg;
  if (dew > 0.0) {
    float rate = 0.05 * dew * uDt * var;
    if (Tg < -0.3) {
      // vapour deposits as frost; crystals grow preferentially from existing crystals
      float nb = max(max(texture(uPrev, vUv + vec2(texel.x, 0.0)).g, texture(uPrev, vUv - vec2(texel.x, 0.0)).g),
                     max(texture(uPrev, vUv + vec2(0.0, texel.y)).g, texture(uPrev, vUv - vec2(0.0, texel.y)).g));
      s.g += rate * (0.06 + 2.2 * nb + 3.0 * seed) * 0.6;
      float fz = min(s.r, uDt * 1.5);
      s.r -= fz; s.g += fz * 0.7;
      // standing droplets freeze in place
      float wf = min(s.b, uDt * 0.8);
      s.b -= wf; s.g += wf * 0.5;
    } else {
      s.r += rate * 1.4;
      s.b += rate * 0.35 * smoothstep(0.3, 1.0, s.r) * var;
      if (s.r > 1.0) { s.b += (s.r - 1.0) * 0.5; s.r = 1.0; }
    }
  } else {
    float ev = 0.03 * (-dew) * uDt;
    s.r -= ev * 2.5;
    s.b -= ev * 0.35 * (0.6 + 0.8 * var);
    if (Tg < 0.0) s.g -= ev * 0.04;
  }
  if (Tg > 0.3 && s.g > 0.0) {
    // frost melts into water droplets
    float m = min(s.g, uDt * 0.05 * Tg * (0.6 + var));
    s.g -= m;
    s.b += m * 1.3;
  }

  // inner wall above the free surface: vapour from warm water condenses on cooler glass
  float above = y - uLevel;
  if (above > 0.0015) {
    float dewIn = uWaterT - 7.0 - above * 140.0;
    float d2 = dewIn - Tin;
    if (d2 > 0.0 && uWaterT > 35.0) s.a += 0.03 * d2 * uDt * var * exp(-above / 0.03);
    else s.a -= 0.05 * uDt * (1.0 + max(0.0, -d2) * 0.1);
  } else {
    s.a -= uDt * 0.5;
  }

  // wiping with the pointer
  if (uWipe.w > 0.5) {
    vec2 p = phys(vUv, uWipe.x);
    vec2 a = phys(vec2(uWipePrev.x, uWipePrev.y), uWipe.x);
    vec2 b = vec2(uWipe.x * CIRC, uWipe.y * CUP_H);
    float d = segDist(p, a, b);
    float k = 1.0 - smoothstep(uWipe.z * 0.6, uWipe.z, d);
    if (k > 0.0) {
      float removed = s.g * k * 0.85;
      s.r *= 1.0 - k;
      s.g -= removed;
      s.b = mix(s.b, min(s.b, 0.35) * 0.4 + (Tg > 0.0 ? removed * 0.25 : 0.0), k);
    }
  }

  // running drips: clear a trail and carry a large drop at the head
  for (int i = 0; i < ${LIMITS.maxDrips}; i++) {
    if (i >= uDripCount) break;
    vec4 dr = uDrips[i];
    vec2 p = phys(vUv, dr.x);
    vec2 head = vec2(dr.x * CIRC, dr.y * CUP_H);
    vec2 tail = vec2(dr.x * CIRC, dr.w * CUP_H);
    float d = segDist(p, head, tail);
    float wob = (vnoise(vec2(p.y * 900.0, float(i) * 7.0)) - 0.5) * dr.z * 0.6;
    float tr = 1.0 - smoothstep(dr.z * 0.55, dr.z * 0.9, abs(d + wob));
    if (tr > 0.0) {
      s.r *= 1.0 - tr;
      s.b = mix(s.b, 0.1, tr);
    }
    float hd = length(p - head);
    float hk = 1.0 - smoothstep(dr.z * 0.7, dr.z * 1.15, hd);
    s.b = max(s.b, hk * 1.9);
  }

  s = clamp(s, vec4(0.0), vec4(1.0, 1.4, 2.0, 1.0));
  fragColor = s;
}
`;

export class Condensation {
  constructor(renderer, thermal) {
    this.renderer = renderer;
    this.thermal = thermal;
    const opt = { type: THREE.HalfFloatType, wrap: THREE.ClampToEdgeWrapping };
    this.targets = [makeTarget(GRID.condW, GRID.condH, opt), makeTarget(GRID.condW, GRID.condH, opt)];
    for (const t of this.targets) t.texture.wrapS = THREE.RepeatWrapping;
    this.cur = 0;
    const drips = Array.from({ length: LIMITS.maxDrips }, () => new THREE.Vector4());
    this.pass = new FullscreenPass(shaderMaterial({
      fragmentShader: GLSL_HEADER + COMMON + UPDATE_FRAG,
      uniforms: {
        uPrev: { value: null }, uThermal: { value: thermal.texture },
        uDt: { value: 0 }, uDew: { value: ROOM.dewPoint }, uLevel: { value: CUP.level }, uTime: { value: 0 },
        uWaterT: { value: 20 },
        uWipe: { value: new THREE.Vector4() }, uWipePrev: { value: new THREE.Vector4() },
        uDrips: { value: drips }, uDripCount: { value: 0 }, uReset: { value: 1 },
      },
    }));
    this.wipe = null;      // {u, v, pu, pv}
    this.drips = [];
    // coarse CPU twin of the water channel per height band, to decide where drops run
    this.bands = new Float32Array(24);
    this.fogBands = new Float32Array(24);
    this.rng = mulberry(5);
    this.enabled = true;
    this.speed = 1;
  }

  reset() { this.pass.material.uniforms.uReset.value = 1; this.bands.fill(0); this.fogBands.fill(0); this.drips.length = 0; }

  setWipe(u, v, active) {
    if (!active) { this.wipe = null; return; }
    if (!this.wipe) this.wipe = { u, v, pu: u, pv: v };
    else { this.wipe.pu = this.wipe.u; this.wipe.pv = this.wipe.v; this.wipe.u = u; this.wipe.v = v; }
  }

  _cpuBands(dt) {
    const nb = this.bands.length;
    for (let i = 0; i < nb; i++) {
      const y = (i + 0.5) / nb * CUP.height;
      const Tg = this.thermal.outerGlassTemp(y);
      const dew = ROOM.dewPoint - Tg;
      let fog = this.fogBands[i], w = this.bands[i];
      if (dew > 0 && Tg > -0.3) {
        const rate = 0.05 * dew * dt;
        fog += rate * 1.4;
        w += rate * 0.35 * THREE.MathUtils.smoothstep(fog, 0.3, 1.0);
        if (fog > 1) { w += (fog - 1) * 0.5; fog = 1; }
      } else if (dew <= 0) {
        const ev = 0.03 * -dew * dt;
        fog -= ev * 2.5; w -= ev * 0.35;
      } else {
        w -= dt * 0.8;
      }
      if (Tg > 0.3 && this._frostMemory?.[i] > 0) {
        const m = Math.min(this._frostMemory[i], dt * 0.05 * Tg);
        this._frostMemory[i] -= m; w += m * 1.3;
      }
      if (Tg < -0.3 && dew > 0) {
        this._frostMemory ??= new Float32Array(nb);
        this._frostMemory[i] = Math.min(1.4, this._frostMemory[i] + 0.05 * dew * dt * 0.8);
      }
      this.fogBands[i] = THREE.MathUtils.clamp(fog, 0, 1);
      this.bands[i] = THREE.MathUtils.clamp(w, 0, 2);
    }
  }

  _updateDrips(dt) {
    const rng = this.rng;
    const nb = this.bands.length;
    for (let i = 2; i < nb; i++) {
      const excess = this.bands[i] - 0.9;
      if (excess > 0 && this.drips.length < LIMITS.maxDrips && rng() < excess * dt * 6) {
        const y = (i + rng()) / nb * CUP.height;
        if (this.thermal.outerGlassTemp(y) < 0.2) continue;
        this.drips.push({ u: rng(), v: y / CUP.height, pv: y / CUP.height, w: 0.0011 + rng() * 0.0009, speed: 0.012 + rng() * 0.02, pause: 0 });
        this.bands[i] -= 0.12;
      }
    }
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i];
      const y = d.v * CUP.height;
      const band = Math.min(nb - 1, Math.floor(d.v * nb));
      // drops pick up water as they run and stall on dry glass
      const wet = this.bands[band];
      if (d.pause > 0) d.pause -= dt;
      else {
        const sp = d.speed * (0.4 + Math.min(1.2, wet));
        d.v -= sp * dt / CUP.height;
        if (rng() < dt * 0.6) d.pause = rng() * 0.6;
      }
      if (this.thermal.outerGlassTemp(y) < -0.2 || d.v < 0.004 || (wet < 0.05 && rng() < dt * 0.4)) {
        this.drips.splice(i, 1);
      }
    }
  }

  update(dt, levelLocal, waterSurfaceT) {
    const dtc = dt * this.speed * (this.enabled ? 1 : 0);
    this._cpuBands(dtc);
    if (this.enabled) this._updateDrips(dt * this.speed);
    const u = this.pass.material.uniforms;
    u.uPrev.value = this.targets[this.cur].texture;
    u.uDt.value = dtc;
    u.uLevel.value = levelLocal;
    u.uWaterT.value = waterSurfaceT;
    u.uTime.value += dt;
    if (this.wipe) {
      u.uWipe.value.set(this.wipe.u, this.wipe.v, 0.0065, 1);
      u.uWipePrev.value.set(this.wipe.pu, this.wipe.pv, 0, 0);
      this.wipe.pu = this.wipe.u; this.wipe.pv = this.wipe.v;
    } else u.uWipe.value.w = 0;
    const n = Math.min(this.drips.length, LIMITS.maxDrips);
    for (let i = 0; i < n; i++) {
      const d = this.drips[i];
      u.uDrips.value[i].set(d.u, d.v, d.w, Math.min(d.pv, d.v + 0.02));
      d.pv = Math.max(d.pv, d.v);
    }
    u.uDripCount.value = n;
    this.cur = 1 - this.cur;
    this.pass.render(this.renderer, this.targets[this.cur]);
    u.uReset.value = 0;
  }

  get texture() { return this.targets[this.cur].texture; }
}
