import * as THREE from 'three';
import { CUP } from './config.js';

// Pointer interaction:
//   drag a body          -> pick it up, move it (spring), release to drop/throw
//   drag on the water    -> finger in the water (moving depression + wake)
//   drag on the glass    -> slide the glass on the table (wipe tool / Shift: wipe moisture)
//   drag elsewhere       -> orbit the camera (OrbitControls)

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _ndc = new THREE.Vector2();

export class CupController {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.dragging = false;
    this.shake = 0;
    this.shakeT = 0;
  }

  update(dt) {
    const w = 24, z = 0.92;
    const t = this.target.clone();
    if (this.shake > 0) {
      // a scripted horizontal shake near the sloshing resonance (~3.6 Hz)
      this.shakeT += dt;
      t.x += Math.sin(this.shakeT * 2 * Math.PI * 3.4) * 0.006 * Math.min(1, this.shake);
      this.shake -= dt;
    }
    const ax = w * w * (t.x - this.pos.x) - 2 * z * w * this.vel.x;
    const az = w * w * (t.z - this.pos.z) - 2 * z * w * this.vel.z;
    const amax = 40;
    const m = Math.hypot(ax, az);
    const s = m > amax ? amax / m : 1;
    this.acc.set(ax * s, 0, az * s);
    this.vel.addScaledVector(this.acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    const lim = 0.28;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -lim, lim);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -lim, lim);
  }
}

function raySphere(ray, c, r) {
  const oc = _v.copy(ray.origin).sub(c);
  const b = oc.dot(ray.direction);
  const cc = oc.dot(oc) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : -1;
}

// first hit with the glass' bounding cylinder (side or rim); returns {t, point, kind}
function rayCup(ray, cupPos) {
  const o = ray.origin.clone().sub(cupPos), d = ray.direction;
  const a = d.x * d.x + d.z * d.z;
  const b = o.x * d.x + o.z * d.z;
  const c = o.x * o.x + o.z * o.z - CUP.rOut * CUP.rOut;
  const disc = b * b - a * c;
  let best = null;
  if (disc >= 0 && a > 1e-12) {
    const t = (-b - Math.sqrt(disc)) / a;
    const y = o.y + d.y * t;
    if (t > 0 && y >= 0 && y <= CUP.height) best = { t, kind: 'side' };
  }
  if (Math.abs(d.y) > 1e-6) {
    const t = (CUP.height - o.y) / d.y;
    const p = o.clone().addScaledVector(d, t);
    const r = Math.hypot(p.x, p.z);
    if (t > 0 && r < CUP.rOut && (!best || t < best.t)) best = { t, kind: r > CUP.rIn ? 'rim' : 'opening' };
  }
  if (best) best.point = ray.origin.clone().addScaledVector(d, best.t);
  return best;
}

export class Interaction {
  constructor({ canvas, camera, controls, app }) {
    this.canvas = canvas;
    this.camera = camera;
    this.controls = controls;
    this.app = app;
    this.mode = null;
    this.tool = 'hand';
    this.finger = null;
    this.prevFinger = null;
    this.ball = null;
    this.grabPlane = new THREE.Plane();
    this.grabOffset = new THREE.Vector3();
    this.cupGrabY = 0;
    this.cupOffset = new THREE.Vector3();
    this.shiftDown = false;
    this.pointer = new THREE.Vector2();
    canvas.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('keydown', (e) => { if (e.key === 'Shift') this.shiftDown = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.shiftDown = false; });
  }

  _ray(e) {
    const r = this.canvas.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(_ndc, this.camera);
    return rc.ray.clone();
  }

  _pick(ray) {
    const app = this.app;
    const cup = app.cup;
    let best = { t: Infinity, kind: null };
    for (const b of app.bodies.balls) {
      const t = raySphere(ray, b.pos, b.r * 1.15);
      if (t > 0 && t < best.t) best = { t, kind: 'ball', ball: b };
    }
    const ch = rayCup(ray, cup.pos);
    if (ch && ch.kind === 'opening') {
      // looking into the glass through the opening: the water surface or a body inside
      const yS = app.surfaceLevel();
      const t = (yS - ray.origin.y) / ray.direction.y;
      const p = ray.origin.clone().addScaledVector(ray.direction, t);
      const r = Math.hypot(p.x - cup.pos.x, p.z - cup.pos.z);
      if (t > 0 && r < CUP.rIn && t < best.t) best = { t, kind: 'water', point: p };
      else if (best.kind !== 'ball' && ch.t < best.t) best = { t: ch.t, kind: 'rim', point: ch.point };
    } else if (ch && ch.t < best.t) {
      // through the dry upper wall the user is pointing at what is inside: a body or the water
      const yS = app.surfaceLevel();
      const dry = ch.kind === 'side' && ch.point.y > yS + 0.002;
      if (!(dry && best.kind === 'ball')) {
        best = { t: ch.t, kind: 'glass', point: ch.point, sub: ch.kind };
        if (dry && ray.direction.y < 0) {
          const t = (yS - ray.origin.y) / ray.direction.y;
          const p = ray.origin.clone().addScaledVector(ray.direction, t);
          if (Math.hypot(p.x - cup.pos.x, p.z - cup.pos.z) < CUP.rIn * 0.97) best = { t, kind: 'water', point: p };
        }
      }
    }
    return best;
  }

  down(e) {
    if (e.button !== 0) return;
    const ray = this._ray(e);
    const hit = this._pick(ray);
    const app = this.app;
    const wipe = this.tool === 'wipe' || e.shiftKey;
    if (hit.kind === 'ball') {
      this.mode = 'ball';
      this.ball = hit.ball;
      this.ball.grabbed = true;
      this.ball.locked = false;
      const n = new THREE.Vector3();
      this.camera.getWorldDirection(n);
      n.y = 0; n.normalize();
      const p = ray.origin.clone().addScaledVector(ray.direction, hit.t);
      this.grabPlane.setFromNormalAndCoplanarPoint(n, p);
      this.grabOffset.copy(this.ball.pos).sub(p);
      this.ball.grabTarget.copy(this.ball.pos);
    } else if (hit.kind === 'water' && !wipe) {
      this.mode = 'water';
      this.finger = hit.point.clone();
      this.prevFinger = hit.point.clone();
    } else if (hit.kind === 'glass' || hit.kind === 'rim') {
      if (wipe && hit.kind === 'glass') {
        this.mode = 'wipe';
        this._wipeAt(hit.point);
      } else {
        this.mode = 'cup';
        this.cupGrabY = hit.point.y;
        this.grabPlane.set(new THREE.Vector3(0, 1, 0), -hit.point.y);
        this.cupOffset.copy(app.cup.pos).sub(hit.point);
        this.cupOffset.y = 0;
        app.cup.dragging = true;
      }
    } else if (hit.kind === 'water' && wipe) {
      this.mode = null;
    }
    if (this.mode) {
      this.controls.enabled = false;
      this.canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  _wipeAt(p) {
    const app = this.app;
    const l = p.clone().sub(app.cup.pos);
    let u = Math.atan2(l.z, l.x) / (Math.PI * 2);
    if (u < 0) u += 1;
    app.condensation.setWipe(u, l.y / CUP.height, true);
  }

  move(e) {
    const ray = this._ray(e);
    if (!this.mode) {
      const hit = this._pick(ray);
      const wipe = this.tool === 'wipe' || e.shiftKey;
      let cur = 'default';
      if (hit.kind === 'ball') cur = 'grab';
      else if (hit.kind === 'water') cur = wipe ? 'default' : 'crosshair';
      else if (hit.kind === 'glass') cur = wipe ? 'cell' : 'grab';
      else if (hit.kind === 'rim') cur = 'grab';
      this.canvas.style.cursor = cur;
      return;
    }
    const app = this.app;
    if (this.mode === 'ball') {
      const p = new THREE.Vector3();
      if (ray.intersectPlane(this.grabPlane, p)) {
        p.add(this.grabOffset);
        p.y = Math.max(this.ball.r, p.y);
        this.ball.grabTarget.copy(p);
      }
      this.canvas.style.cursor = 'grabbing';
    } else if (this.mode === 'water') {
      const yS = app.surfaceLevel();
      const t = (yS - ray.origin.y) / ray.direction.y;
      if (t > 0) {
        const p = ray.origin.clone().addScaledVector(ray.direction, t);
        const l = p.clone().sub(app.cup.pos);
        const r = Math.hypot(l.x, l.z);
        if (r > CUP.rIn - 0.002) { l.multiplyScalar((CUP.rIn - 0.002) / r); p.copy(app.cup.pos).add(l); }
        this.finger = p;
      }
    } else if (this.mode === 'cup') {
      const p = new THREE.Vector3();
      if (ray.intersectPlane(this.grabPlane, p)) {
        app.cup.target.set(p.x + this.cupOffset.x, 0, p.z + this.cupOffset.z);
      }
      this.canvas.style.cursor = 'grabbing';
    } else if (this.mode === 'wipe') {
      const ch = rayCup(ray, app.cup.pos);
      if (ch && ch.kind === 'side') this._wipeAt(ch.point);
    }
  }

  up() {
    if (!this.mode) return;
    if (this.mode === 'ball' && this.ball) this.ball.grabbed = false;
    if (this.mode === 'cup') this.app.cup.dragging = false;
    if (this.mode === 'wipe') this.app.condensation.setWipe(0, 0, false);
    this.mode = null;
    this.ball = null;
    this.finger = null;
    this.prevFinger = null;
    this.touched = false;
    this.controls.enabled = true;
  }

  // per-frame: the finger keeps pushing the water while held
  update(dt) {
    const app = this.app;
    if (this.mode !== 'water' || !this.finger) return;
    const cup = app.cup.pos;
    const cur = this.finger.clone().sub(cup);
    const prev = (this.prevFinger || this.finger).clone().sub(cup);
    if (app.iceAt(Math.hypot(cur.x, cur.z)) > 0.5) { this.prevFinger = this.finger.clone(); return; }
    if (!this.touched) {
      app.waves.addImpulse(cur.x, cur.z, 0.0035, -0.0016);
      this.touched = true;
    }
    // a moving finger pushes a bow wave ahead and leaves a trough behind (V-shaped wake)
    const dist = Math.hypot(cur.x - prev.x, cur.z - prev.z);
    if (dist > 1e-5) {
      const dx = (cur.x - prev.x) / dist, dz = (cur.z - prev.z) / dist;
      const n = Math.min(12, 1 + Math.floor(dist / 0.0015));
      const a = Math.min(0.0025, 0.3 * dist) / n;
      for (let i = 0; i < n; i++) {
        const s = (i + 1) / n;
        const x = prev.x + (cur.x - prev.x) * s, z = prev.z + (cur.z - prev.z) * s;
        app.waves.addImpulse(x + dx * 0.0028, z + dz * 0.0028, 0.0026, a);
        app.waves.addImpulse(x - dx * 0.0028, z - dz * 0.0028, 0.0026, -a);
      }
    }
    this.prevFinger = this.finger.clone();
  }
}

export { rayCup };
