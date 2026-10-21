import * as THREE from 'three';
import { CUP, THERMAL, ROOM } from '../config.js';
import {
  ICE, GLASS, LATENT_FUSION, CP_WATER, K_WATER, T_SAT,
  waterDensity, vaporPressure, airSolubility,
} from './water.js';

// Axisymmetric (r, y) enthalpy solver for the glass + water/ice column.
//
// Every water cell stores a specific enthalpy h (J/kg) measured from ice at 0 °C:
//   h < 0            solid ice,      T = h / c_ice
//   0 <= h <= L_f    mushy (0 °C),  solid fraction = 1 - h / L_f
//   h > L_f          liquid,         T = (h - L_f) / c_water
// so latent heat automatically produces the 0 °C plateau during freezing and melting.
// Liquid water additionally mixes through buoyancy-driven convection whose strength is
// derived from the local density inversion (Kell density, with its 4 °C maximum), which is
// what makes real glasses freeze from the top and the walls inward.

const WATER = 0, GLASSCELL = 1, AIR = 2;
const RHO_W = 1000;                // nominal mass density for cell masses
const MIX_D0 = 1.43e-7;            // molecular thermal diffusivity of water
const MIX_D1 = 2.0e-5;             // max eddy diffusivity from natural convection
const BOIL_MIX = 1.5;              // extra agitation while boiling
const DRHO_REF = 0.08;             // kg/m^3 density inversion that saturates mixing
const ROHSENOW_K = 45;             // W/(m^2 K^3), nucleate boiling flux ~ K * dT^3
const EVAP_K = 0.012;              // W/(m^2 Pa) surface evaporation coefficient
const GAS_THRESHOLD = 2.6;        // supersaturation at which the freezing front nucleates bubbles

export class HeatingSim {
  // Heating-only demonstration. The upstream phase-change solver is retained for
  // shared data compatibility, but cold stages and frozen initial states are unavailable.
  set envTemp(v) { this._envTemp = Math.max(ROOM.temperature, Math.min(250, Number.isFinite(v) ? v : ROOM.temperature)); }
  get envTemp() { return this._envTemp; }

  constructor() {
    const { nr, nz, dr, dz } = THERMAL;
    this.nr = nr; this.nz = nz;
    const n = nr * nz;
    this.type = new Uint8Array(n);
    this.h = new Float64Array(n);       // specific enthalpy (J/kg) for water, c*T for glass
    this.T = new Float64Array(n);
    this.fs = new Float64Array(n);      // solid fraction
    this.cloud = new Float64Array(n);   // trapped bubble density in ice
    this.mass = new Float64Array(n);
    this.cap = new Float64Array(n);     // reference heat capacity (for stability)
    this.vol = new Float64Array(n);
    this.dh = new Float64Array(n);
    this.kc = new Float64Array(n);
    this.rho = new Float64Array(n);
    this.boilFlux = new Float64Array(n); // W/m^2 of vapour generation at heated cells

    // geometry: radial faces area and vertical faces area per cell
    this.areaR = new Float64Array(nr + 1);  // outward radial face at r = i*dr
    for (let i = 0; i <= nr; i++) this.areaR[i] = 2 * Math.PI * i * dr * dz;
    this.areaZ = new Float64Array(nr);
    for (let i = 0; i < nr; i++) this.areaZ[i] = Math.PI * (((i + 1) * dr) ** 2 - (i * dr) ** 2);

    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nr; i++) {
        const c = j * nr + i;
        let t = AIR;
        if (i >= THERMAL.waterCols || j < THERMAL.baseRows) t = GLASSCELL;
        else if (j <= THERMAL.topRow) t = WATER;
        this.type[c] = t;
        this.vol[c] = this.areaZ[i] * dz;
        if (t === WATER) { this.mass[c] = RHO_W * this.vol[c]; }
        if (t === GLASSCELL) { this.mass[c] = GLASS.density * this.vol[c]; }
      }
    }
    this.waterVolume = 0;
    for (let c = 0; c < n; c++) if (this.type[c] === WATER) this.waterVolume += this.vol[c];

    this.envTemp = ROOM.temperature;
    this.timeScale = 120;
    this.simTime = 0;
    this.gas = this.waterVolume * 1.0;  // dissolved air, relative to saturation at 20 °C
    this.gasConc = 1.0;
    this.stats = {
      meanT: 20, iceFraction: 0, topIce: 0, vaporPower: 0, evapPower: 0, bottomSuperheat: 0,
      wallBubbles: 0, boiling: 0, maxT: 20, minT: 20, coreLiquid: 1,
    };
    this.reset(ROOM.temperature);

    // upload texture (half float so it can be bilinearly filtered everywhere)
    this.texData = new Uint16Array(n * 4);
    this.texture = new THREE.DataTexture(this.texData, nr, nz, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this._computeStableDt();
  }

  reset(T0 = ROOM.temperature) {
    T0 = Math.max(ROOM.temperature, Math.min(99, Number.isFinite(T0) ? T0 : ROOM.temperature));
    this.simTime = 0;
    const n = this.nr * this.nz;
    for (let c = 0; c < n; c++) {
      if (this.type[c] === WATER) this.h[c] = this._hFromT(T0);
      else if (this.type[c] === GLASSCELL) this.h[c] = GLASS.cp * T0;
      this.cloud[c] = 0;
    }
    this.gas = this.waterVolume * 1.0;
    this._decode();
  }

  _hFromT(T) {
    return T < 0 ? ICE.cp * T : LATENT_FUSION + CP_WATER * T;
  }

  _computeStableDt() {
    // Conduction is explicit (limited by ice, the best conductor per heat capacity); convective
    // mixing uses pairwise exponential relaxation, which is unconditionally stable.
    const { dr, dz } = THERMAL;
    const lap = 2 / (dr * dr) + 2 / (dz * dz);
    const limIce = 1 / ((ICE.k / (ICE.density * ICE.cp)) * lap);
    const limGlass = 1 / ((GLASS.k / (GLASS.density * GLASS.cp)) * lap);
    const limWater = 1 / ((K_WATER / (RHO_W * CP_WATER)) * lap);
    this.dtStable = 0.8 * Math.min(limIce, limGlass, limWater);
  }

  _decode() {
    const n = this.nr * this.nz;
    for (let c = 0; c < n; c++) {
      const t = this.type[c];
      if (t === WATER) {
        const h = this.h[c];
        if (h < 0) { this.T[c] = h / ICE.cp; this.fs[c] = 1; }
        else if (h <= LATENT_FUSION) { this.T[c] = 0; this.fs[c] = 1 - h / LATENT_FUSION; }
        else { this.T[c] = (h - LATENT_FUSION) / CP_WATER; this.fs[c] = 0; }
        this.cap[c] = this.mass[c] * (this.fs[c] > 0.5 ? ICE.cp : CP_WATER);
        this.kc[c] = this.fs[c] * ICE.k + (1 - this.fs[c]) * K_WATER;
        this.rho[c] = waterDensity(this.T[c]);
      } else if (t === GLASSCELL) {
        this.T[c] = this.h[c] / GLASS.cp; this.fs[c] = 0;
        this.cap[c] = this.mass[c] * GLASS.cp;
        this.kc[c] = GLASS.k;
      }
    }
  }

  // boundary coefficients from the controller temperature (heater below, cold air around)
  _boundary() {
    const Ts = this.envTemp;
    const heat = THREE.MathUtils.smoothstep(Ts, ROOM.temperature, ROOM.temperature + 8);
    return {
      heat,
      // bottom: hot plate contact vs. cold shelf
      hB: THREE.MathUtils.lerp(40, 450, heat), TB: Ts,
      // side and top: cold air jacket vs. room air
      hS: THREE.MathUtils.lerp(50, 9, heat), TS: THREE.MathUtils.lerp(Ts, ROOM.temperature, heat),
      hT: THREE.MathUtils.lerp(60, 8, heat), TT: THREE.MathUtils.lerp(Ts, ROOM.temperature, heat),
      pVapRoom: vaporPressure(ROOM.dewPoint),
    };
  }

  // Convective eddy diffusivity between two liquid cells (a below b when vertical).
  _mixD(a, b, vertical, boiling) {
    if (this.fs[a] > 0.02 || this.fs[b] > 0.02) return 0;
    const ra = this.rho[a], rb = this.rho[b];
    // vertical: unstable only when the upper parcel is denser (Rayleigh-Benard);
    // horizontal: a lateral density contrast drives a wall boundary-layer circulation
    const drive = vertical ? Math.max(0, rb - ra) : 0.45 * Math.abs(ra - rb);
    const s = Math.min(1, Math.cbrt(drive / DRHO_REF));
    return MIX_D1 * s * (boiling ? BOIL_MIX : 1);
  }

  // Pairwise exponential relaxation of two liquid cells towards their common temperature.
  _relax(a, b, G, dt) {
    const ca = this.mass[a] * CP_WATER, cb = this.mass[b] * CP_WATER;
    const inv = 1 / ca + 1 / cb;
    const Q = (this.T[b] - this.T[a]) * (1 - Math.exp(-G * inv * dt)) / inv;
    this.h[a] += Q / this.mass[a]; this.h[b] -= Q / this.mass[b];
    this.T[a] += Q / ca; this.T[b] -= Q / cb;
  }

  _mixPass(dt, boiling) {
    const { nr } = this;
    const { dr, dz } = THERMAL;
    const r0 = THERMAL.baseRows, r1 = THERMAL.topRow;
    const flip = (this._mixFlip = !this._mixFlip);
    for (let jj = r0; jj <= r1; jj++) {
      const j = flip ? jj : r1 - (jj - r0);
      for (let i = 0; i < THERMAL.waterCols; i++) {
        const c = j * nr + i;
        if (this.fs[c] > 0.02) continue;
        if (i + 1 < THERMAL.waterCols) {
          const D = this._mixD(c, c + 1, false, boiling);
          if (D > 0) this._relax(c, c + 1, RHO_W * CP_WATER * D * this.areaR[i + 1] / dr, dt);
        }
        if (j + 1 <= r1) {
          const u = c + nr;
          this.rho[c] = waterDensity(this.T[c]);
          this.rho[u] = waterDensity(this.T[u]);
          const D = this._mixD(c, u, true, boiling);
          if (D > 0) this._relax(c, u, RHO_W * CP_WATER * D * this.areaZ[i] / dz, dt);
        }
      }
    }
  }

  step(dtReal) {
    const dtSim = Math.min(dtReal, 1 / 20) * this.timeScale;
    let steps = Math.ceil(dtSim / this.dtStable);
    steps = Math.min(steps, 240);
    const dt = dtSim / steps;
    const bc = this._boundary();
    this._vapAcc = 0; this._evapAcc = 0;
    for (let s = 0; s < steps; s++) this._substep(dt, bc);
    this.simTime += dtSim;
    this._vapAcc /= Math.max(1e-6, dtSim);
    this._evapAcc /= Math.max(1e-6, dtSim);
    this._gasStep(dtSim);
    this._stats(bc);
    this._upload();
  }

  _substep(dt, bc) {
    const { nr, nz } = this;
    const { dr, dz } = THERMAL;
    const dh = this.dh;
    dh.fill(0);
    const boiling = this.stats.boiling > 0.2;
    const fsOld = this._fsOld || (this._fsOld = new Float64Array(nr * nz));
    fsOld.set(this.fs);

    // molecular conduction (explicit)
    const kc = this.kc, T = this.T, type = this.type;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nr; i++) {
        const c = j * nr + i;
        if (type[c] === AIR) continue;
        if (i + 1 < nr && type[c + 1] !== AIR) {
          const k = 2 * kc[c] * kc[c + 1] / (kc[c] + kc[c + 1]);
          const q = k * this.areaR[i + 1] / dr * (T[c + 1] - T[c]) * dt;
          dh[c] += q; dh[c + 1] -= q;
        }
        if (j + 1 < nz && type[c + nr] !== AIR) {
          const u = c + nr;
          const k = 2 * kc[c] * kc[u] / (kc[c] + kc[u]);
          const q = k * this.areaZ[i] / dz * (T[u] - T[c]) * dt;
          dh[c] += q; dh[u] -= q;
        }
      }
    }

    // boundaries
    for (let i = 0; i < nr; i++) {
      // bottom of the glass base
      const c = i;
      dh[c] += bc.hB * this.areaZ[i] * (bc.TB - this.T[c]) * dt;
      // top: water surface or glass rim
      const top = THERMAL.topRow * nr + i;
      if (this.type[top] === WATER) {
        const T = this.T[top];
        let q = bc.hT * (bc.TT - T);
        if (this.fs[top] < 0.5) {
          const evap = EVAP_K * Math.max(0, vaporPressure(T) - bc.pVapRoom);
          q -= evap;
          this._evapAcc += evap * this.areaZ[i] * dt;
        }
        dh[top] += q * this.areaZ[i] * dt;
      }
      const rim = (nz - 1) * nr + i;
      if (this.type[rim] === GLASSCELL) dh[rim] += bc.hS * this.areaZ[i] * (bc.TS - this.T[rim]) * dt;
    }
    for (let j = 0; j < nz; j++) {
      // outer wall
      const c = j * nr + nr - 1;
      dh[c] += bc.hS * this.areaR[nr] * (bc.TS - this.T[c]) * dt;
      // inner face of the wall above the water touches air inside the cup
      if (j > THERMAL.topRow) {
        const w = j * nr + THERMAL.waterCols;
        const tAir = 0.5 * (bc.TT + this.T[THERMAL.topRow * nr]);
        dh[w] += 6 * this.areaR[THERMAL.waterCols] * (tAir - this.T[w]) * dt;
      }
    }

    // apply and handle boiling
    let vap = 0;
    for (let c = 0; c < nr * nz; c++) {
      const t = this.type[c];
      if (t === AIR) continue;
      this.h[c] += dh[c] / this.mass[c];
      if (t === WATER) {
        const hSat = LATENT_FUSION + CP_WATER * T_SAT;
        if (this.h[c] > hSat) {
          const i = c % nr, j = (c / nr) | 0;
          const heated = (j === THERMAL.baseRows) || (i === THERMAL.waterCols - 1);
          const dT = (this.h[c] - hSat) / CP_WATER;
          let E;
          if (heated) {
            // nucleate boiling (Rohsenow-like dT^3), the cell may stay superheated
            const area = j === THERMAL.baseRows ? this.areaZ[i] : this.areaR[THERMAL.waterCols];
            const flux = ROHSENOW_K * dT * dT * dT;
            E = Math.min(flux * area * dt, (this.h[c] - hSat) * this.mass[c]);
            this.boilFlux[c] = flux;
          } else {
            // bulk liquid cannot exceed saturation: flashes into existing bubbles
            E = (this.h[c] - hSat) * this.mass[c] * 0.8;
          }
          this.h[c] -= E / this.mass[c];
          vap += E;
        } else {
          this.boilFlux[c] *= 0.9;
        }
      }
    }
    this._vapAcc += vap;
    this._decode();
    this._mixPass(dt, boiling);
    this._decode();

    // dissolved gas rejection / entrapment at the freezing front
    let liquidVol = 0;
    for (let c = 0; c < nr * nz; c++) {
      if (this.type[c] !== WATER) continue;
      const dfs = this.fs[c] - fsOld[c];
      if (dfs > 1e-7) {
        const excess = Math.max(0, this.gasConc - GAS_THRESHOLD);
        this.cloud[c] = Math.min(4, this.cloud[c] + dfs * (0.05 * this.gasConc + excess * 2.4));
        this.gas -= dfs * this.vol[c] * (0.05 * this.gasConc + excess * 0.85);
      } else if (dfs < -1e-7 && fsOld[c] > 0) {
        const keep = this.fs[c] / fsOld[c];
        const released = this.cloud[c] * (1 - keep);
        this.cloud[c] *= keep;
        this.gas += released * this.vol[c] * 0.4;
      }
      liquidVol += this.vol[c] * (1 - this.fs[c]);
    }
    this.gas = Math.max(0, this.gas);
    this.gasConc = liquidVol > 1e-9 ? Math.min(8, this.gas / liquidVol) : this.gasConc;
  }

  _gasStep(dtSim) {
    // degassing of supersaturated warm water and slow re-absorption at room temperature
    const s = airSolubility(this.stats.meanT);
    const liquid = 1 - this.stats.iceFraction;
    if (liquid < 0.05) return;
    let c = this.gasConc;
    if (c > s * 1.12) c -= 0.012 * (c - s * 1.12) * dtSim * (this.stats.boiling > 0.1 ? 6 : 1);
    else if (c < s && this.stats.topIce < 0.5) c += 0.00025 * (s - c) * dtSim;
    this.gas += (c - this.gasConc) * this.waterVolume * liquid;
    this.gasConc = c;
  }

  _stats(bc) {
    const { nr } = this;
    let sumT = 0, sumV = 0, ice = 0, maxT = -1e9, minT = 1e9;
    for (let c = 0; c < nr * this.nz; c++) {
      if (this.type[c] !== WATER) continue;
      const v = this.vol[c];
      sumT += this.T[c] * v; sumV += v; ice += this.fs[c] * v;
      maxT = Math.max(maxT, this.T[c]); minT = Math.min(minT, this.T[c]);
    }
    let top = 0, topA = 0;
    for (let i = 0; i < THERMAL.waterCols; i++) {
      const c = THERMAL.topRow * nr + i;
      top += this.fs[c] * this.areaZ[i]; topA += this.areaZ[i];
    }
    let sh = 0, shA = 0;
    for (let i = 0; i < THERMAL.waterCols; i++) {
      const c = THERMAL.baseRows * nr + i;
      sh += (this.T[c] - T_SAT) * this.areaZ[i]; shA += this.areaZ[i];
    }
    const st = this.stats;
    st.meanT = sumT / sumV;
    st.iceFraction = ice / sumV;
    st.topIce = top / topA;
    st.maxT = maxT; st.minT = minT;
    st.vaporPower = this._vapAcc;
    st.evapPower = this._evapAcc;
    st.bottomSuperheat = sh / shA;
    st.heatMode = bc.heat;
    st.boiling = THREE.MathUtils.clamp((this._vapAcc - 0.3) / 18, 0, 1);
    const sol = airSolubility(maxT);
    st.wallBubbles = THREE.MathUtils.clamp((this.gasConc - sol) / 0.45, 0, 1) *
      THREE.MathUtils.smoothstep(maxT, 32, 55) * (1 - st.iceFraction);
    st.gas = this.gasConc;
    st.gasContent = this.gas / this.waterVolume;   // air still in solution, rel. to saturated water
  }

  _upload() {
    const { nr, nz } = this;
    const d = this.texData;
    const toHalf = THREE.DataUtils.toHalfFloat;
    const meanT = this.stats.meanT;
    for (let c = 0; c < nr * nz; c++) {
      const t = this.type[c];
      const T = t === AIR ? this.T[THERMAL.topRow * nr + (c % nr)] : this.T[c];
      d[c * 4 + 0] = toHalf(t === WATER ? this.fs[c] : 0);
      d[c * 4 + 1] = toHalf(T);
      d[c * 4 + 2] = toHalf(t === WATER ? this.cloud[c] : 0);
      d[c * 4 + 3] = toHalf(t === WATER ? Math.min(4, Math.abs(T - meanT) * 0.25) : 0);
    }
    this.texture.needsUpdate = true;
  }

  // ---------- sampling helpers (cup-local coordinates) ----------
  _cellCoord(r, y) {
    const fi = Math.max(0, Math.min(this.nr - 1.001, r / THERMAL.dr - 0.5));
    const fj = Math.max(0, Math.min(this.nz - 1.001, y / THERMAL.dz - 0.5));
    return [fi, fj];
  }

  sample(arr, r, y) {
    const [fi, fj] = this._cellCoord(r, y);
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    const tx = fi - i0, ty = fj - j0;
    const i1 = Math.min(this.nr - 1, i0 + 1), j1 = Math.min(this.nz - 1, j0 + 1);
    const nr = this.nr;
    const a = arr[j0 * nr + i0], b = arr[j0 * nr + i1], c = arr[j1 * nr + i0], e = arr[j1 * nr + i1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }

  temperatureAt(r, y) {
    y = Math.min(y, CUP.level - THERMAL.dz * 0.5);
    r = Math.min(r, CUP.rIn - THERMAL.dr * 0.5);
    return this.sample(this.T, r, y);
  }

  solidAt(r, y) {
    y = Math.min(y, CUP.level - THERMAL.dz * 0.5);
    r = Math.min(r, CUP.rIn - THERMAL.dr * 0.5);
    return this.sample(this.fs, r, Math.max(CUP.base + THERMAL.dz * 0.5, y));
  }

  // temperature of the glass surface wetted by the water (what nucleation sites feel)
  bottomWallTemp(r) {
    const i = Math.min(THERMAL.waterCols - 1, Math.floor(r / THERMAL.dr));
    const nr = this.nr;
    return 0.5 * (this.T[(THERMAL.baseRows - 1) * nr + i] + this.T[THERMAL.baseRows * nr + i]);
  }

  sideWallTemp(y) {
    const j = Math.max(THERMAL.baseRows, Math.min(THERMAL.topRow, Math.floor(y / THERMAL.dz)));
    const nr = this.nr;
    return 0.5 * (this.T[j * nr + THERMAL.waterCols - 1] + this.T[j * nr + THERMAL.waterCols]);
  }

  outerGlassTemp(y) {
    const j = Math.max(0, Math.min(this.nz - 1, Math.floor(y / THERMAL.dz)));
    return this.T[j * this.nr + this.nr - 1];
  }
}
