import * as THREE from 'three';
import { CUP, LIMITS, GRAVITY } from '../config.js';
import { waterDensity, waterViscosity } from './water.js';
import { BALL_TYPES } from './materials.js';

// Rigid spheres interacting with the water, the glass, the ice and each other.
// Forces on a (partially) submerged sphere follow a reduced Maxey-Riley model:
//   (m + C_a rho V) dv/dt = m g + rho V (-g + a_f) + C_a rho V a_f + F_drag + F_contact
// where V is the submerged spherical-cap volume under the local free surface and a_f is the
// fluid acceleration (the cup's acceleration). In the cup frame this makes light objects
// lean *into* an acceleration and heavy ones fall behind, as they do in a real glass.

const TABLE_HALF = 0.42;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0],
  [0.707, -0.707, 0], [-0.707, -0.707, 0], [0, -0.707, 0.707], [0, -0.707, -0.707]];

function capVolume(d, r) {
  d = Math.max(0, Math.min(2 * r, d));
  return Math.PI * d * d * (3 * r - d) / 3;
}

export class Ball {
  constructor(type, pos) {
    this.type = type;
    this.r = type.radius;
    this.volume = 4 / 3 * Math.PI * this.r ** 3;
    this.mass = type.density * this.volume;
    this.inertia = 0.4 * this.mass * this.r * this.r;
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.omega = new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4);
    this.quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    this.vSub = 0;
    this.prevSurfPos = null;
    this.grabbed = false;
    this.grabTarget = new THREE.Vector3();
    this.locked = false;
    this.lockLocal = new THREE.Vector3();
    this.lockQuat = new THREE.Quaternion();
    this.kick = new THREE.Vector3();
    this.inWater = false;
    this.submergedFrac = 0;
    this.id = Ball.nextId++;
    this.jetTimer = -1;
    this.entrySpeed = 0;
  }
}
Ball.nextId = 1;

export class Bodies {
  constructor() {
    this.balls = [];
    this.substeps = 6;
    this.coupling = { waves: true, ice: true, bubbles: true };
    this._f = [0, 0];
    this._s = [0, 0];
  }

  add(typeIndex, pos) {
    if (this.balls.length >= LIMITS.maxBalls) this.balls.shift();
    const b = new Ball(BALL_TYPES[typeIndex], pos);
    this.balls.push(b);
    return b;
  }

  clear() { this.balls.length = 0; }

  // env: { cup, surface(x,z,out) -> [etaAbs, w, sx, sz], sloshVel(x,z,out), thermal, T, waves, splash, boil }
  step(dt, env) {
    const n = this.substeps;
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (const b of this.balls) this._integrate(b, h, env, s === 0, dt);
      this._ballContacts();
    }
    for (const b of this.balls) {
      if (!Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.vel.x + b.vel.y + b.vel.z)) {
        b.pos.set(env.cup.pos.x, CUP.height + 0.05, env.cup.pos.z);
        b.vel.set(0, 0, 0); b.vSub = 0; b.locked = false;
      }
      this._couple(b, dt, env);
    }
  }

  _integrate(b, dt, env, first, frameDt) {
    const cup = env.cup;
    const lx = b.pos.x - cup.pos.x, lz = b.pos.z - cup.pos.z, ly = b.pos.y;
    const rLocal = Math.hypot(lx, lz);

    if (b.locked) {
      // frozen into the ice: move rigidly with the glass
      b.pos.set(cup.pos.x + b.lockLocal.x, b.lockLocal.y, cup.pos.z + b.lockLocal.z);
      b.vel.copy(cup.vel);
      b.omega.multiplyScalar(0.8);
      return;
    }

    const rho = waterDensity(env.T);
    const F = _v.set(0, -b.mass * GRAVITY, 0);
    let addedMass = 0;
    b.inWater = false;
    b.submergedFrac = 0;

    const insideCup = rLocal < CUP.rIn && ly - b.r < CUP.level + 0.03 && ly > CUP.base - 0.01;
    if (insideCup) {
      const surf = env.surface(lx, lz, this._s);
      const eta = surf[0];
      const depth = eta - (ly - b.r);
      const V = capVolume(depth, b.r);
      if (V > 0) {
        b.inWater = true;
        const frac = V / b.volume;
        b.submergedFrac = frac;
        const iceHere = this.coupling.ice ? env.thermal.solidAt(rLocal, Math.min(ly, CUP.level - 0.001)) : 0;
        // generalised buoyancy in the accelerating cup: rho V (g_up + a_cup)
        F.x += rho * V * cup.acc.x;
        F.y += rho * V * GRAVITY;
        F.z += rho * V * cup.acc.z;
        addedMass = 0.5 * rho * V;
        F.x += addedMass * cup.acc.x;
        F.z += addedMass * cup.acc.z;
        // fluid velocity: cup translation + sloshing orbital flow + ripple vertical motion
        const sv = env.sloshVel(lx, lz, this._f);
        const decay = Math.exp(-Math.max(0, eta - ly) / 0.012);
        const ux = cup.vel.x + sv[0] * decay;
        const uz = cup.vel.z + sv[1] * decay;
        const uy = surf[1] * decay;
        const rx = b.vel.x - ux, ry = b.vel.y - uy, rz = b.vel.z - uz;
        const speed = Math.hypot(rx, ry, rz);
        const area = Math.PI * b.r * b.r * Math.min(1, frac * 1.3 + 0.05);
        const iceDrag = 1 + 40 * iceHere * iceHere;
        const quad = 0.5 * rho * 0.47 * area * speed * iceDrag;
        const lin = 6 * Math.PI * waterViscosity(env.T) * b.r * frac * iceDrag;
        F.x -= (quad + lin) * rx; F.y -= (quad + lin) * ry; F.z -= (quad + lin) * rz;
        // heave radiation damping of a surface-piercing body (Havelock): the waves it radiates
        // carry energy away at a damping ratio of ~0.15 of the hydrostatic heave mode
        if (frac > 0.02 && frac < 0.98) {
          const wl = Math.min(depth, 2 * b.r - depth);
          const aw2 = wl * (2 * b.r - wl);
          const mT = b.mass + 0.5 * rho * V;
          const om = Math.sqrt(rho * GRAVITY * Math.PI * aw2 / mT);
          F.y -= 2 * 0.15 * om * mT * ry;
        }
        // wave-slope (Froude-Krylov) force on floating bodies
        if (frac < 0.98 && this.coupling.waves) {
          F.x -= rho * V * GRAVITY * surf[2] * 0.8;
          F.z -= rho * V * GRAVITY * surf[3] * 0.8;
        }
        // rotational drag
        b.omega.multiplyScalar(Math.exp(-dt * 6 * frac));
      }
    }
    if (b.grabbed) {
      const w = 32;
      const mEff = b.mass + addedMass;
      F.x += mEff * (w * w * (b.grabTarget.x - b.pos.x) - 2 * w * b.vel.x);
      F.y += mEff * (w * w * (b.grabTarget.y - b.pos.y) - 2 * w * b.vel.y) + b.mass * GRAVITY;
      F.z += mEff * (w * w * (b.grabTarget.z - b.pos.z) - 2 * w * b.vel.z);
    }
    if (first) { F.addScaledVector(b.kick, 1 / frameDt); }
    const mTot = b.mass + addedMass;
    b.vel.addScaledVector(F, dt / mTot);
    if (first) b.kick.set(0, 0, 0);
    b.pos.addScaledVector(b.vel, dt);

    this._contacts(b, env, dt);

    // orientation
    const w = b.omega.length();
    if (w > 1e-5) {
      _q.setFromAxisAngle(_v.copy(b.omega).divideScalar(w), w * dt);
      b.quat.premultiply(_q).normalize();
    }
  }

  _contacts(b, env, dt) {
    const cup = env.cup;
    const e = b.type.restitution * (b.inWater ? 0.55 : 1);
    const lx = b.pos.x - cup.pos.x, lz = b.pos.z - cup.pos.z;
    const r = Math.hypot(lx, lz);
    const rimR = 0.5 * (CUP.rIn + CUP.rOut), tube = 0.5 * (CUP.rOut - CUP.rIn) + 0.0006;

    const collide = (nx, ny, nz, pen, wallVel) => {
      // positional projection + restitution on the relative normal velocity
      b.pos.x += nx * pen; b.pos.y += ny * pen; b.pos.z += nz * pen;
      const wvx = wallVel ? wallVel.x : 0, wvz = wallVel ? wallVel.z : 0;
      const rvx = b.vel.x - wvx, rvy = b.vel.y, rvz = b.vel.z - wvz;
      const vn = rvx * nx + rvy * ny + rvz * nz;
      if (vn < 0) {
        const j = -(1 + (Math.abs(vn) > 0.08 ? e : 0)) * vn;
        b.vel.x += j * nx; b.vel.y += j * ny; b.vel.z += j * nz;
        // Coulomb friction drives rolling
        const tx = rvx - vn * nx, ty = rvy - vn * ny, tz = rvz - vn * nz;
        const tl = Math.hypot(tx, ty, tz);
        if (tl > 1e-6) {
          const mu = b.type.friction;
          const dv = Math.min(tl, mu * j) * 0.6;
          b.vel.x -= tx / tl * dv; b.vel.y -= ty / tl * dv; b.vel.z -= tz / tl * dv;
          // spin: omega = n x v / r for rolling without slipping
          const ox = (ny * tz - nz * ty) / b.r, oy = (nz * tx - nx * tz) / b.r, oz = (nx * ty - ny * tx) / b.r;
          b.omega.lerp(_v.set(ox, oy, oz), 0.25);
        }
        if (Math.abs(vn) > 0.3) this.onImpact?.(b, Math.abs(vn), b.inWater);
      }
    };

    const below = b.pos.y < CUP.height + b.r;
    if (below && r < rimR) {
      // inside the glass
      if (r + b.r > CUP.rIn && b.pos.y < CUP.height) {
        const nx = -lx / r, nz = -lz / r;
        collide(nx, 0, nz, r + b.r - CUP.rIn, cup.vel);
      }
      if (b.pos.y - b.r < CUP.base) collide(0, 1, 0, CUP.base - (b.pos.y - b.r), cup.vel);
    } else if (below) {
      if (r - b.r < CUP.rOut && b.pos.y < CUP.height) {
        collide(lx / r, 0, lz / r, CUP.rOut + b.r - r, cup.vel);
      }
    }
    // rim torus
    {
      const lx2 = b.pos.x - cup.pos.x, lz2 = b.pos.z - cup.pos.z;
      const r2 = Math.max(1e-6, Math.hypot(lx2, lz2));
      const cx = lx2 / r2 * rimR, cz = lz2 / r2 * rimR;
      const dx = lx2 - cx, dy = b.pos.y - CUP.height, dz = lz2 - cz;
      const d = Math.hypot(dx, dy, dz);
      if (d < b.r + tube && d > 1e-6) collide(dx / d, dy / d, dz / d, b.r + tube - d, cup.vel);
    }
    // table
    if (b.pos.y - b.r < 0) collide(0, 1, 0, -(b.pos.y - b.r), null);
    // keep on the table
    b.pos.x = THREE.MathUtils.clamp(b.pos.x, -TABLE_HALF, TABLE_HALF);
    b.pos.z = THREE.MathUtils.clamp(b.pos.z, -TABLE_HALF, TABLE_HALF);

    // ice: solid regions of the thermal field act as obstacles and finally trap the body
    if (this.coupling.ice && r < CUP.rIn && b.pos.y < CUP.level + 0.006 && env.thermal.stats.iceFraction > 0.001) {
      let iceDirs = 0, nx = 0, ny = 0, nz = 0;
      const lx3 = b.pos.x - cup.pos.x, lz3 = b.pos.z - cup.pos.z;
      for (const a of AXES) {
        const px = lx3 + a[0] * b.r, py = b.pos.y + a[1] * b.r, pz = lz3 + a[2] * b.r;
        if (py > CUP.level + 0.0015) continue;
        const fs = env.thermal.solidAt(Math.hypot(px, pz), py);
        if (fs > 0.55) { iceDirs++; nx -= a[0]; ny -= a[1]; nz -= a[2]; }
      }
      const centre = env.thermal.solidAt(r, Math.min(b.pos.y, CUP.level - 0.0012));
      if (centre > 0.6 || iceDirs >= 5) {
        b.locked = true;
        b.lockLocal.set(lx3, b.pos.y, lz3);
        b.vel.set(0, 0, 0);
        this.onLock?.(b);
      } else if (iceDirs > 0) {
        const l = Math.hypot(nx, ny, nz);
        if (l > 1e-6) collide(nx / l, ny / l, nz / l, 0.0004, cup.vel);
      }
    }
  }

  _ballContacts() {
    const bs = this.balls;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], c = bs[j];
        const dx = c.pos.x - a.pos.x, dy = c.pos.y - a.pos.y, dz = c.pos.z - a.pos.z;
        const d = Math.hypot(dx, dy, dz);
        const minD = a.r + c.r;
        if (d < minD && d > 1e-7) {
          const nx = dx / d, ny = dy / d, nz = dz / d;
          const pen = minD - d;
          const ia = a.locked ? 0 : 1 / a.mass, ic = c.locked ? 0 : 1 / c.mass;
          const sum = ia + ic;
          if (sum === 0) continue;
          a.pos.x -= nx * pen * ia / sum; a.pos.y -= ny * pen * ia / sum; a.pos.z -= nz * pen * ia / sum;
          c.pos.x += nx * pen * ic / sum; c.pos.y += ny * pen * ic / sum; c.pos.z += nz * pen * ic / sum;
          const vn = (c.vel.x - a.vel.x) * nx + (c.vel.y - a.vel.y) * ny + (c.vel.z - a.vel.z) * nz;
          if (vn < 0) {
            const e = 0.5 * (a.type.restitution + c.type.restitution) * ((a.inWater || c.inWater) ? 0.5 : 1);
            const j = -(1 + e) * vn / sum;
            a.vel.x -= j * nx * ia; a.vel.y -= j * ny * ia; a.vel.z -= j * nz * ia;
            c.vel.x += j * nx * ic; c.vel.y += j * ny * ic; c.vel.z += j * nz * ic;
            if (-vn > 0.3) this.onImpact?.(a, -vn, a.inWater || c.inWater, true);
          }
        }
      }
    }
  }

  // Two-way coupling with the height field: the change of displaced volume is injected
  // as a zero-mean depression/crown pair, horizontal motion as a bow/stern pair.
  _couple(b, dt, env) {
    const cup = env.cup;
    const lx = b.pos.x - cup.pos.x, lz = b.pos.z - cup.pos.z;
    const r = Math.hypot(lx, lz);
    const insideCup = r < CUP.rIn && b.pos.y > CUP.base - 0.01;
    let V = 0, depth = 0;
    if (insideCup) {
      const eta = env.surfaceRef ? env.surfaceRef(lx, lz) : env.surface(lx, lz, this._s)[0];
      depth = eta - (b.pos.y - b.r);
      V = capVolume(depth, b.r);
    }
    const dV = V - b.vSub;
    const partial = depth > 0 && depth < 2 * b.r;
    if (insideCup && this.coupling.waves && !b.locked) {
      const a = Math.sqrt(Math.max(0, Math.min(depth, 2 * b.r - depth) * (2 * b.r - Math.min(depth, 2 * b.r - depth))));
      const rf = Math.max(0.0022, (partial ? a : b.r * 0.6) * 1.05);
      const weight = partial ? 1 : Math.exp(-Math.max(0, depth - 2 * b.r) / 0.006) * 0.6;
      if (Math.abs(dV) > 1e-10 && weight > 0.01) {
        const amp = dV / (Math.PI * rf * rf) * weight;
        env.waves.addImpulse(lx, lz, rf, -amp);
        env.waves.addImpulse(lx, lz, 2 * rf, amp / 4);
      }
      // bow wave from horizontal motion through the surface
      if (partial) {
        const vx = b.vel.x - cup.vel.x, vz = b.vel.z - cup.vel.z;
        const vh = Math.hypot(vx, vz);
        if (vh > 0.01) {
          const vol = 2 * a * Math.min(depth, b.r) * vh * dt * 0.5;
          const ux = vx / vh, uz = vz / vh;
          const amp = vol / (Math.PI * rf * rf * 0.5);
          env.waves.addImpulse(lx + ux * a, lz + uz * a, rf * 0.7, amp);
          env.waves.addImpulse(lx - ux * a, lz - uz * a, rf * 0.7, -amp);
        }
      }
      // splash on fast entry: crown droplets now, Worthington jet a moment later
      if (b.vSub < 0.15 * b.volume && V > b.vSub && b.vel.y < -0.55) {
        const speed = -b.vel.y + 0;
        env.splash?.crown(b.pos.x, CUP.level, b.pos.z, b.r, speed);
        b.jetTimer = 0.07 + b.r * 2;
        b.entrySpeed = speed;
        this.onSplash?.(b, speed);
      }
    }
    if (b.jetTimer > 0) {
      b.jetTimer -= dt;
      if (b.jetTimer <= 0) {
        const eta = env.surface(lx, lz, this._s)[0];
        if (r < CUP.rIn) env.splash?.jet(cup.pos.x + lx, eta, cup.pos.z + lz, b.r, b.entrySpeed);
        if (r < CUP.rIn) env.waves.addImpulse(lx, lz, b.r * 0.9, b.r * 0.35 * Math.min(1, b.entrySpeed));
      }
    }
    b.vSub = V;
  }

  // melt-release check, called once per frame
  updateLocks(env) {
    for (const b of this.balls) {
      if (!b.locked) continue;
      const lx = b.lockLocal.x, lz = b.lockLocal.z;
      const r = Math.hypot(lx, lz);
      const fs = env.thermal.solidAt(r, Math.min(b.lockLocal.y, CUP.level - 0.0012));
      let free = fs < 0.3;
      if (!this.coupling.ice) free = true;
      if (free) { b.locked = false; b.vel.copy(env.cup.vel); }
    }
  }

  displacedVolume(cupPos) {
    let v = 0;
    for (const b of this.balls) {
      const lx = b.pos.x - cupPos.x, lz = b.pos.z - cupPos.z;
      if (Math.hypot(lx, lz) < CUP.rIn) v += b.vSub;
    }
    return v;
  }
}
