import * as THREE from 'three';
import { CUP, LIMITS, GRAVITY } from '../config.js';
import { mulberry } from './bubbles.js';

// Ballistic droplets thrown out by impacts (crown splash + Worthington jet) and by bursting
// bubbles (jet drops). Drops falling back into the glass become small surface impulses.
export class Splash {
  constructor() {
    this.drops = [];
    this.rng = mulberry(1234);
    this.enabled = true;
  }

  _add(x, y, z, vx, vy, vz, r) {
    if (!this.enabled) return;
    if (this.drops.length >= LIMITS.maxSplash) this.drops.shift();
    this.drops.push({ p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(vx, vy, vz), r, age: 0 });
  }

  crown(x, y, z, ballR, speed) {
    const rng = this.rng;
    const n = Math.min(46, Math.round(10 + 34 * (speed - 0.5)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.3;
      const out = (0.18 + rng() * 0.3) * speed;
      const up = (0.35 + rng() * 0.55) * speed;
      const rr = ballR * (0.9 + rng() * 0.3);
      this._add(x + Math.cos(a) * rr, y + 0.001, z + Math.sin(a) * rr, Math.cos(a) * out, up, Math.sin(a) * out, 0.00035 + rng() * 0.0007);
    }
  }

  jet(x, y, z, ballR, speed) {
    const rng = this.rng;
    const n = 1 + Math.floor(rng() * 3 + speed);
    for (let i = 0; i < n; i++) {
      const up = (0.45 + 0.35 * rng()) * speed * (1 - i * 0.18);
      this._add(x + (rng() - 0.5) * 0.001, y + 0.002 + i * 0.003, z + (rng() - 0.5) * 0.001,
        (rng() - 0.5) * 0.05, up, (rng() - 0.5) * 0.05, 0.0009 + rng() * 0.0012);
    }
  }

  burstDrops(xw, y, zw, R) {
    const rng = this.rng;
    if (R < 0.0007 || rng() > 0.6) return;
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      this._add(xw, y + 0.0008, zw, (rng() - 0.5) * 0.15, 0.4 + rng() * 0.9 * Math.min(1.5, R / 0.001), (rng() - 0.5) * 0.15, R * (0.12 + rng() * 0.12));
    }
  }

  step(dt, env) {
    const cup = env.cup;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.v.y -= GRAVITY * dt;
      d.v.multiplyScalar(1 - 0.4 * dt);
      d.p.addScaledVector(d.v, dt);
      const lx = d.p.x - cup.pos.x, lz = d.p.z - cup.pos.z;
      const r = Math.hypot(lx, lz);
      let dead = d.age > 3;
      if (r < CUP.rIn && d.p.y < CUP.height) {
        const eta = env.surface(lx, lz, [0, 0, 0, 0])[0];
        if (d.p.y < eta) {
          dead = true;
          if (env.ice(r) < 0.5) env.waves.addImpulse(lx, lz, Math.max(0.0012, d.r * 2), -d.r * Math.min(1.2, -d.v.y) * 0.8);
        }
      } else if (r < CUP.rOut + d.r && d.p.y < CUP.height) {
        dead = true;
      } else if (d.p.y < d.r) {
        dead = true;
      }
      if (dead) this.drops.splice(i, 1);
    }
  }
}
