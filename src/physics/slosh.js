import { CUP, GRAVITY } from '../config.js';
import { surfaceTension, waterDensity, kinematicViscosity } from './water.js';

// Linear potential-flow sloshing of a liquid in an upright circular cylinder.
// The free surface of the first antisymmetric modes is
//   eta(r, theta) = sum_n  J1(xi_n r / R) / J1(xi_n) * (A_nx cos(theta) + A_nz sin(theta))
// with xi_n the zeros of J1'. Each modal amplitude (measured at the wall) obeys
//   A'' + 2 zeta w A' + w^2 A = - w^2 (2R / (xi^2 - 1)) a_cup / g
// whose static solution reproduces the projection of the tilted free surface
// eta = -(a/g) x onto the Bessel basis. w_n follows the capillary-gravity dispersion relation.

export const XI = [1.841184, 5.331443];

export function besselJ1(x) {
  // power series, accurate on [0, 6]
  let term = x / 2, sum = term;
  const q = -(x * x) / 4;
  for (let m = 1; m < 16; m++) {
    term *= q / (m * (m + 1));
    sum += term;
  }
  return sum;
}

const J1XI = XI.map(besselJ1);

export class Slosh {
  constructor() {
    this.A = XI.map(() => [0, 0]);     // modal wall amplitudes (m) for x and z
    this.V = XI.map(() => [0, 0]);
    this.omega = XI.map(() => 1);
    this.zeta = XI.map(() => 0.01);
    this.lock = 0;
    this.enabled = true;
    this.updateProperties(20, 0);
  }

  updateProperties(T, iceTop) {
    const R = CUP.rIn, D = CUP.fill;
    const sigma = surfaceTension(T), rho = waterDensity(T), nu = kinematicViscosity(T);
    for (let n = 0; n < XI.length; n++) {
      const k = XI[n] / R;
      this.omega[n] = Math.sqrt((GRAVITY * k + sigma / rho * k ** 3) * Math.tanh(k * D));
      // viscous boundary-layer damping (Case & Parkinson / Miles) + contact-line damping
      const visc = 0.83 * Math.sqrt(nu / Math.sqrt(GRAVITY * R ** 3)) * (1 + 0.318 / Math.sinh(1.84 * D / R));
      this.zeta[n] = visc * (n + 1) + 0.006 + 2.5 * iceTop * iceTop;
    }
    this.lock = iceTop > 0.93 ? 1 : 0;
  }

  step(dt, ax, az) {
    const R = CUP.rIn;
    const amax = 0.62 * (CUP.height - CUP.level);
    for (let n = 0; n < XI.length; n++) {
      const w = this.omega[n], z = this.zeta[n];
      const gain = 2 * R / (XI[n] * XI[n] - 1) / GRAVITY;
      const a = [ax, az];
      // semi-implicit (symplectic) integration with sub-stepping for the higher mode
      const sub = Math.max(1, Math.ceil(w * dt / 0.15));
      const h = dt / sub;
      for (let s = 0; s < sub; s++) {
        for (let c = 0; c < 2; c++) {
          const f = this.enabled ? -w * w * gain * a[c] : 0;
          const acc = f - 2 * z * w * this.V[n][c] - w * w * this.A[n][c];
          this.V[n][c] += acc * h;
          this.A[n][c] += this.V[n][c] * h;
        }
      }
      if (this.lock) {
        const k = Math.exp(-25 * dt);
        this.V[n][0] *= k; this.V[n][1] *= k; this.A[n][0] *= k; this.A[n][1] *= k;
      }
      // soft saturation keeps the crest inside the glass (a crude stand-in for wave breaking)
      const mag = Math.hypot(this.A[n][0], this.A[n][1]);
      const lim = amax / (n + 1);
      const V = this.V[n];
      if (mag > lim * 0.7) {
        const target = lim * Math.tanh(mag / lim);
        const s = target / mag;
        this.A[n][0] *= s; this.A[n][1] *= s;
        // a breaking crest cannot keep rising: drop the part of its velocity that would
        this.V[n][0] *= 0.97; this.V[n][1] *= 0.97;
        const vr = (this.A[n][0] * V[0] + this.A[n][1] * V[1]) / target;
        if (vr > 0) { V[0] -= vr * this.A[n][0] / target; V[1] -= vr * this.A[n][1] / target; }
      }
      // nor can the flow outrun an oscillation of the largest crest the glass holds; without this
      // a violent jerk (several g) pumps the modal velocity to m/s while the amplitude is capped
      const vmag = Math.hypot(V[0], V[1]), vmax = w * lim;
      if (vmag > vmax) { V[0] *= vmax / vmag; V[1] *= vmax / vmag; }
    }
  }

  shape(n, r) {
    return besselJ1(XI[n] * r / CUP.rIn) / J1XI[n];
  }

  // surface elevation (m) and vertical velocity at cup-local (x, z)
  height(x, z) {
    const r = Math.hypot(x, z);
    if (r < 1e-6) return 0;
    let e = 0;
    for (let n = 0; n < XI.length; n++) {
      e += this.shape(n, r) * (this.A[n][0] * x + this.A[n][1] * z) / r;
    }
    return e;
  }

  verticalVelocity(x, z) {
    const r = Math.hypot(x, z);
    if (r < 1e-6) return 0;
    let e = 0;
    for (let n = 0; n < XI.length; n++) {
      e += this.shape(n, r) * (this.V[n][0] * x + this.V[n][1] * z) / r;
    }
    return e;
  }

  // horizontal fluid velocity at the surface, u = grad(phi), phi = eta_t / (k tanh kD)
  horizontalVelocity(x, z, out) {
    const eps = 1e-4;
    let ux = 0, uz = 0;
    for (let n = 0; n < XI.length; n++) {
      const k = XI[n] / CUP.rIn;
      const s = 1 / (k * Math.tanh(k * CUP.fill));
      const f = (px, pz) => {
        const r = Math.max(1e-6, Math.hypot(px, pz));
        return this.shape(n, r) * (this.V[n][0] * px + this.V[n][1] * pz) / r;
      };
      ux += s * (f(x + eps, z) - f(x - eps, z)) / (2 * eps);
      uz += s * (f(x, z + eps) - f(x, z - eps)) / (2 * eps);
    }
    out[0] = ux; out[1] = uz;
    return out;
  }

  energy() {
    let e = 0;
    for (let n = 0; n < XI.length; n++) e += this.A[n][0] ** 2 + this.A[n][1] ** 2;
    return Math.sqrt(e);
  }
}
