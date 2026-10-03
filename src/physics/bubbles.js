import * as THREE from 'three';
import { CUP, LIMITS, GRAVITY } from '../config.js';
import { surfaceTension, waterDensity, waterViscosity, T_SAT, P_ATM } from './water.js';

// Vapour and air bubbles.
//  * Nucleation: fixed cavities on the base and lower wall, each with its own activation
//    wall superheat (3-12 K); ebullition frequency grows with the excess superheat.
//  * Departure size: Fritz correlation  D_d = 0.0208 theta sqrt(sigma / (g d_rho)).
//  * Rise: terminal velocity blends Stokes drag (small bubbles) with Mendelson's wave
//    analogy (mm-size bubbles); bubbles above ~1.3 mm follow zig-zag / helical paths
//    (path instability, Strouhal ~0.12) and flatten into oblate spheroids (Moore's
//    aspect ratio 1 + 9 We / 64) whose short axis follows the velocity.
//  * Heat exchange: radius changes with the local liquid superheat / subcooling, so in
//    sub-cooled water vapour bubbles collapse on the way up, while at saturation they
//    survive and grow; hydrostatic decompression adds the (small) pressure growth.
//  * Bursting at the free surface injects a crater into the height field and pushes on
//    floating bodies, closing the loop temperature -> bubbles -> waves -> objects.

const _tmp = [0, 0, 0, 0];
const _sv = [0, 0];

export class Bubbles {
  constructor() {
    this.list = [];
    this.sites = [];
    const rng = mulberry(7);
    for (let i = 0; i < 64; i++) {
      const r = Math.sqrt(rng()) * (CUP.rIn - 0.002);
      const a = rng() * Math.PI * 2;
      this.sites.push({ kind: 0, x: Math.cos(a) * r, z: Math.sin(a) * r, y: CUP.base, act: 2.5 + rng() * 9, size: 0.7 + rng() * 0.6, timer: rng(), bubble: null });
    }
    for (let i = 0; i < 30; i++) {
      const a = rng() * Math.PI * 2;
      const y = CUP.base + 0.002 + Math.pow(rng(), 1.6) * 0.035;
      this.sites.push({ kind: 1, x: Math.cos(a) * (CUP.rIn - 0.0004), z: Math.sin(a) * (CUP.rIn - 0.0004), y, act: 4 + rng() * 9, size: 0.6 + rng() * 0.5, timer: rng(), bubble: null });
    }
    // rows 0-1: bubbles sorted by height; row 2: first index of each height bucket, so a ray
    // segment only tests the bubbles in the slab of heights it crosses
    this.data = new Float32Array(LIMITS.maxBubbles * 3 * 4);
    this.texture = new THREE.DataTexture(this.data, LIMITS.maxBubbles, 3, THREE.RGBAFormat, THREE.FloatType);
    this._order = [];
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    this.count = 0;
    this.time = 0;
    this.coupling = { surface: true, bodies: true };
    this.enabled = true;
    this.gasTimer = 0;
    this.bursts = 0;
    this.rng = mulberry(99);
  }

  clear() {
    this.list.length = 0;
    for (const s of this.sites) s.bubble = null;
  }

  _spawn(x, y, z, R, gas, site) {
    if (this.list.length >= LIMITS.maxBubbles) return null;
    const rng = this.rng;
    const b = {
      x, y, z, R, vx: 0, vy: 0, vz: 0, attached: !!site, site, gas,
      phase: rng() * 6.28, plane: rng() * 6.28, helix: rng(), wob: 0.2, wobPhase: rng() * 6.28,
      axis: [0, 1, 0], chi: 1, age: 0, surfacing: -1, growT: 0, growDur: 0.05, Rd: R, frozen: 0,
    };
    this.list.push(b);
    return b;
  }

  step(dt, env) {
    this.time += dt;
    const thermal = env.thermal;
    const Tm = thermal.stats.meanT;
    const sigma = surfaceTension(Tm), rho = waterDensity(Tm), mu = waterViscosity(Tm);
    const rng = this.rng;
    const fritz = 0.5 * 0.0208 * 40 * Math.sqrt(sigma / (GRAVITY * (rho - 0.6)));
    this.bursts = 0;
    const ice = thermal.stats.iceFraction;

    // ---- nucleation at cavities
    if (this.enabled && ice < 0.5) {
      for (const s of this.sites) {
        const Tw = s.kind === 0 ? thermal.bottomWallTemp(Math.hypot(s.x, s.z)) : thermal.sideWallTemp(s.y);
        const excess = Tw - T_SAT - s.act;
        if (s.bubble) continue;
        if (excess <= 0) { s.timer = Math.min(s.timer, 1); continue; }
        const freq = Math.min(45, 5 * Math.pow(excess / 3, 1.5));
        s.timer -= dt * freq;
        if (s.timer <= 0) {
          const Rd = fritz * s.size * (s.kind === 1 ? 0.8 : 1);
          const b = this._spawn(s.x, s.y + 0.0001, s.z, 0.00012, 0, s);
          if (b) {
            b.Rd = Rd;
            b.growDur = THREE.MathUtils.clamp(0.5 / freq, 0.012, 0.25);
            s.bubble = b;
          }
          s.timer = 0.6 + rng() * 0.8;
        }
      }
      // dissolved air coming out of solution on the warm glass
      const gasRate = thermal.stats.wallBubbles * 6;
      this.gasTimer -= dt * gasRate;
      if (this.gasTimer <= 0 && gasRate > 0) {
        this.gasTimer = 1;
        const wall = rng() < 0.55;
        let x, y, z;
        if (wall) {
          const a = rng() * 6.283;
          y = CUP.base + 0.002 + rng() * (CUP.fill - 0.01);
          x = Math.cos(a) * (CUP.rIn - 0.0004); z = Math.sin(a) * (CUP.rIn - 0.0004);
        } else {
          const a = rng() * 6.283, r = Math.sqrt(rng()) * (CUP.rIn - 0.001);
          x = Math.cos(a) * r; z = Math.sin(a) * r; y = CUP.base;
        }
        const b = this._spawn(x, y, z, 0.00015, 1, { kind: wall ? 1 : 0, x, y, z, bubble: null, gasSite: true });
        if (b) { b.Rd = 0.00045 + rng() * 0.0004; b.growDur = 1.5 + rng() * 3; b.site.bubble = b; }
      }
    }

    // ---- dynamics
    const cup = env.cup;
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.age += dt;
      const r = Math.hypot(b.x, b.z);
      const fsHere = thermal.solidAt(r, b.y);
      if (fsHere > 0.5) {
        // engulfed by the ice front: the gas becomes part of the cloudy ice
        b.frozen += dt;
        b.vx = b.vy = b.vz = 0;
        if (b.frozen > 1.5) { this._remove(i); }
        continue;
      }
      const Tl = thermal.temperatureAt(r, b.y);
      if (b.attached) {
        b.growT += dt;
        b.R = Math.max(b.R, b.Rd * Math.sqrt(Math.min(1, b.growT / b.growDur)));
        if (!b.gas) b.R += 0.0003 * Math.max(0, Tl - T_SAT) * dt;
        if (b.site.kind === 0) { b.y = CUP.base + b.R * 0.82; }
        else { const k = (CUP.rIn - b.R * 0.82) / Math.max(1e-6, r); b.x *= k; b.z *= k; }
        b.axis[0] = 0; b.axis[1] = 1; b.axis[2] = 0; b.chi = b.site.kind === 0 ? 1.12 : 1.0;
        if (b.R >= b.Rd * 0.999 || (!b.gas && Tl < T_SAT - 6)) {
          b.attached = false;
          b.site.bubble = null;
          b.wob = 0.35;
          b.vy = 0.02;
          if (!b.gas && Tl < T_SAT - 6 && b.R < b.Rd * 0.7) { this._remove(i); continue; }
        }
        continue;
      }

      // phase change: grow in superheated, shrink in sub-cooled liquid
      if (!b.gas) {
        const dT = Tl - T_SAT;
        b.R += (dT > 0 ? 0.0009 : 0.00042) * dT * dt;
        if (b.R < 0.00007) { this._remove(i); continue; }
      }
      // hydrostatic decompression on the way up (Boyle)
      const depth = Math.max(0, CUP.level - b.y);
      const p = P_ATM + rho * GRAVITY * depth;
      if (b.pPrev) b.R *= Math.cbrt(b.pPrev / p);
      b.pPrev = p;

      const d = 2 * b.R;
      const vs = GRAVITY * d * d * rho / (18 * mu);
      const vm = Math.sqrt(2.14 * sigma / (rho * d) + 0.505 * GRAVITY * d);
      const vt = 1 / Math.sqrt(1 / (vs * vs) + 1 / (vm * vm));
      // path instability
      const zig = THREE.MathUtils.smoothstep(d, 0.0011, 0.0024) * 0.38;
      const f = 0.12 * vt / d;
      b.phase += 6.2832 * Math.min(f, 18) * dt;
      const c = Math.cos(b.phase), s = Math.sin(b.phase) * b.helix;
      const pc = Math.cos(b.plane), ps = Math.sin(b.plane);
      let lx = (c * pc - s * ps) * zig * vt;
      let lz = (c * ps + s * pc) * zig * vt;
      // boiling turbulence and sloshing flow
      const boil = thermal.stats.boiling;
      const sv = env.sloshVel(b.x, b.z, _sv);
      const decay = Math.exp(-depth / 0.015);
      lx += sv[0] * decay + (rng() - 0.5) * 0.09 * boil;
      lz += sv[1] * decay + (rng() - 0.5) * 0.09 * boil;
      // light bubbles drift towards the cup acceleration (inverse of a pendulum)
      lx += cup.acc.x / GRAVITY * vt * 0.8;
      lz += cup.acc.z / GRAVITY * vt * 0.8;
      const vyT = vt * (1 + 0.2 * boil);
      const k = 1 - Math.exp(-dt / 0.012);
      b.vx += (lx - b.vx) * k; b.vy += (vyT - b.vy) * k; b.vz += (lz - b.vz) * k;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;

      // walls
      const rr = Math.hypot(b.x, b.z);
      const rmax = CUP.rIn - b.R * 1.05;
      if (rr > rmax) { b.x *= rmax / rr; b.z *= rmax / rr; }

      // bodies: bubbles slide around spheres and push them upward
      for (const ball of env.balls) {
        if (ball.locked) continue;
        const bx = ball.pos.x - cup.pos.x, by = ball.pos.y, bz = ball.pos.z - cup.pos.z;
        const dx = b.x - bx, dy = b.y - by, dz = b.z - bz;
        const dist = Math.hypot(dx, dy, dz);
        const minD = ball.r + b.R;
        if (dist < minD && dist > 1e-7) {
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          b.x = bx + nx * minD; b.y = by + ny * minD; b.z = bz + nz * minD;
          const vn = b.vx * nx + b.vy * ny + b.vz * nz;
          if (vn < 0) { b.vx -= vn * nx; b.vy -= vn * ny; b.vz -= vn * nz; }
          if (this.coupling.bodies) {
            const Vb = 4 / 3 * Math.PI * b.R ** 3;
            const J = rho * Vb * GRAVITY * dt * 6 + rho * Vb * 3 * vt;
            ball.kick.x -= nx * J * 0.5; ball.kick.y += Math.max(0, -ny) * J + J * 0.2; ball.kick.z -= nz * J * 0.5;
          }
        }
      }

      // shape: oblate spheroid aligned with the velocity, wobbling after detachment/merging
      const sp = Math.hypot(b.vx, b.vy, b.vz) + 1e-6;
      b.axis[0] = b.vx / sp; b.axis[1] = b.vy / sp; b.axis[2] = b.vz / sp;
      const We = rho * sp * sp * d / sigma;
      b.wob *= Math.exp(-dt * 5);
      b.wobPhase += dt * 6.2832 * 16;
      b.chi = Math.min(2.3, 1 + 9 / 64 * We) * (1 + (b.wob + 0.05 * zig) * Math.sin(b.wobPhase));

      // free surface
      const surf = env.surface(b.x, b.z, _tmp);
      const eta = surf[0];
      if (b.surfacing < 0 && b.y + b.R * 0.6 > eta) {
        b.surfacing = 0.015 + rng() * 0.08 * Math.min(1, b.R / 0.001);
      }
      if (b.surfacing >= 0) {
        b.y = eta - b.R * 0.35;
        b.vy = 0;
        b.surfacing -= dt;
        if (b.surfacing < 0) {
          this._burst(b, env);
          this._remove(i);
          continue;
        }
      }
    }

    // coalescence
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.attached) continue;
      for (let j = i + 1; j < list.length; j++) {
        const c = list[j];
        if (c.attached) continue;
        const dx = a.x - c.x, dy = a.y - c.y, dz = a.z - c.z;
        const lim = (a.R + c.R) * 0.92;
        if (dx * dx + dy * dy + dz * dz < lim * lim) {
          const va = a.R ** 3, vc = c.R ** 3, v = va + vc;
          a.x = (a.x * va + c.x * vc) / v; a.y = (a.y * va + c.y * vc) / v; a.z = (a.z * va + c.z * vc) / v;
          a.vx = (a.vx * va + c.vx * vc) / v; a.vy = (a.vy * va + c.vy * vc) / v; a.vz = (a.vz * va + c.vz * vc) / v;
          a.R = Math.cbrt(v); a.wob = 0.45; a.gas = Math.max(a.gas, c.gas);
          if (c.site) c.site.bubble = null;
          list.splice(j, 1); j--;
        }
      }
    }

    // strong boiling: the many unresolved bubbles also heave the surface
    const boil = thermal.stats.boiling;
    if (this.coupling.surface && boil > 0.05) {
      const n = Math.floor(boil * boil * 240 * dt + rng());
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283, r = Math.sqrt(rng()) * CUP.rIn * 0.95;
        env.waves.addImpulse(Math.cos(a) * r, Math.sin(a) * r, 0.0015 + rng() * 0.002, -(0.00015 + rng() * 0.0003) * boil);
      }
    }
    this._upload();
  }

  _burst(b, env) {
    this.bursts++;
    const amp = Math.min(0.0018, b.R * 0.7);
    if (this.coupling.surface) {
      env.waves.addImpulse(b.x, b.z, Math.max(0.0012, b.R * 1.4), -amp);
      env.waves.addImpulse(b.x, b.z, Math.max(0.0024, b.R * 2.8), amp * 0.22);
    }
    if (this.coupling.bodies) {
      for (const ball of env.balls) {
        if (ball.locked || !ball.inWater) continue;
        const dx = ball.pos.x - env.cup.pos.x - b.x, dz = ball.pos.z - env.cup.pos.z - b.z;
        const dist = Math.hypot(dx, dz);
        if (dist < ball.r + b.R * 3) {
          const V = 4 / 3 * Math.PI * b.R ** 3;
          const J = 1000 * V * 0.9;
          ball.kick.y += J * 0.6;
          ball.kick.x += dx / (dist + 1e-6) * J * 0.4;
          ball.kick.z += dz / (dist + 1e-6) * J * 0.4;
        }
      }
    }
    this.onBurst?.(b);
  }

  _remove(i) {
    const b = this.list[i];
    if (b.site) b.site.bubble = null;
    this.list.splice(i, 1);
  }

  _upload() {
    const n = Math.min(this.list.length, LIMITS.maxBubbles);
    const d = this.data;
    const W = LIMITS.maxBubbles;
    const order = this._order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = this.list[i];
    order.sort((a, b) => a.y - b.y);
    for (let i = 0; i < n; i++) {
      const b = order[i];
      d[i * 4 + 0] = b.x; d[i * 4 + 1] = b.y; d[i * 4 + 2] = b.z; d[i * 4 + 3] = b.R;
      const o = (W + i) * 4;
      d[o + 0] = b.axis[0]; d[o + 1] = b.axis[1]; d[o + 2] = b.axis[2]; d[o + 3] = b.chi;
    }
    const NB = BUBBLE_BUCKETS;
    let j = 0;
    for (let k = 0; k <= NB; k++) {
      const yk = k / NB * CUP.height;
      while (j < n && order[j].y < yk) j++;
      d[(2 * W + k) * 4] = k === NB ? n : j;
    }
    this.count = n;
    this.texture.needsUpdate = true;
  }
}

export const BUBBLE_BUCKETS = 32;

export function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
