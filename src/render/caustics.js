import * as THREE from 'three';
import { CUP, GRID } from '../config.js';
import { GLSL_HEADER } from './glsl/header.js';
import COMMON from './glsl/common.glsl?raw';
import { makeTarget, FullscreenPass, shaderMaterial } from './fsquad.js';

// Light transport onto the table. A regular grid of parallel light rays covering the glass
// is traced through glass, water surface (height field), water, ice and the thick base in
// the vertex shader; each triangle is rasterised where its rays land. The ratio of the
// triangle's undeflected to its deflected area is the irradiance gain (energy conservation),
// so additive blending yields the shadow of the glass, the bright focal line of the water
// cylinder and the moving ripple caustics in a single map.

const VERT = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uSurface;
uniform sampler2D uThermal;
uniform sampler2D uCond;
uniform vec3 uCupPos;
uniform vec3 uLightDir, uLightU, uLightV, uLightOrigin;
uniform float uExtent;
uniform vec4 uRect;
uniform float uIorWater;
uniform float uEtaMin, uEtaMax;
uniform float uIce;
out vec3 vOld;
out vec3 vNew;
out vec3 vThr;
out float vCode;

const float N_GLASS = 1.5;
const vec3 SIGMA_GLASS = vec3(1.6, 0.42, 1.05);
const vec3 SIGMA_WATER = vec3(1.4, 0.32, 0.17);

vec2 cylHit(vec3 o, vec3 d, float R) {
  float a = dot(d.xz, d.xz);
  if (a < 1e-12) return vec2(1e9, -1e9);
  float b = dot(o.xz, d.xz), c = dot(o.xz, o.xz) - R * R;
  float disc = b * b - a * c;
  if (disc < 0.0) return vec2(1e9, -1e9);
  float s = sqrt(disc);
  return vec2((-b - s) / a, (-b + s) / a);
}
vec4 surfSample(vec2 xz) { return texture(uSurface, xz / R_IN * 0.5 + 0.5); }
float surfY(vec2 xz) { return LEVEL0 + surfSample(xz).r * 1e-3; }

float marchSurface(vec3 o, vec3 d, float t0, float t1, float sgn) {
  float ylo = LEVEL0 + uEtaMin - 0.0005, yhi = LEVEL0 + uEtaMax + 0.0005;
  if (abs(d.y) > 1e-7) {
    float ta = (ylo - o.y) / d.y, tb = (yhi - o.y) / d.y;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  }
  if (t1 <= t0) return -1.0;
  float dt = (t1 - t0) / 10.0, tp = t0;
  for (int i = 1; i <= 10; i++) {
    float t = t0 + dt * float(i);
    vec3 q = o + d * t;
    if (sgn * (q.y - surfY(q.xz)) < 0.0) {
      for (int k = 0; k < 5; k++) {
        float tm = 0.5 * (tp + t); vec3 qm = o + d * tm;
        if (sgn * (qm.y - surfY(qm.xz)) < 0.0) t = tm; else tp = tm;
      }
      return t;
    }
    tp = t;
  }
  return -1.0;
}

float fres(float cosi, float n1, float n2) {
  cosi = clamp(cosi, 0.0, 1.0);
  float eta = n1 / n2, s2 = eta * eta * (1.0 - cosi * cosi);
  if (s2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - s2);
  float rs = (n1 * cosi - n2 * ct) / (n1 * cosi + n2 * ct);
  float rp = (n1 * ct - n2 * cosi) / (n1 * ct + n2 * cosi);
  return 0.5 * (rs * rs + rp * rp);
}

bool passIface(inout vec3 d, vec3 n, float n1, float n2, inout vec3 thr) {
  float F = fres(-dot(d, n), n1, n2);
  if (F >= 1.0) { d = reflect(d, n); return false; }
  thr *= 1.0 - F;
  d = refract(d, n, n1 / n2);
  return true;
}

float iceOptical(vec3 o, vec3 d, float len) {
  if (uIce < 0.002) return 0.0;
  float tau = 0.0, ds = len / 6.0;
  for (int i = 0; i < 6; i++) {
    vec3 x = o + d * (float(i) + 0.5) * ds;
    vec4 th = thermalAt(uThermal, length(x.xz), x.y);
    tau += th.x * (1.2 + 85.0 * th.z * th.z * 0.85 + 160.0 * (1.0 - th.x) * 0.8) * ds;
  }
  return tau;
}

void main() {
  vec2 g = position.xy;               // [-1, 1]^2
  vec3 o = uLightOrigin - uCupPos + (uLightU * g.x + uLightV * g.y) * uExtent + uLightDir * 0.25;
  vec3 d = -uLightDir;
  vOld = o + d * (-o.y / d.y);
  vThr = vec3(1.0);
  vCode = 0.0;

  vec2 cs = cylHit(o, d, R_OUT);
  float ySide = o.y + d.y * cs.x;
  float tTop = (CUP_H - o.y) / d.y;
  vec3 pt = o + d * tTop;
  vec3 p; int med = -1;
  vec3 thr = vec3(1.0);
  float code = 0.0;
  if (cs.x > 0.0 && ySide >= 0.0 && ySide <= CUP_H && (dot(pt.xz, pt.xz) > R_OUT * R_OUT || cs.x < tTop)) {
    p = o + d * cs.x;
    vec3 n = vec3(p.x, 0.0, p.z) / R_OUT;
    vec4 cond = texture(uCond, vec2(atan(p.z, p.x) / TAU, p.y / CUP_H));
    thr *= 1.0 - 0.85 * clamp(max(cond.g, cond.r * 0.6), 0.0, 1.0);
    passIface(d, n, 1.0, N_GLASS, thr);
    med = 1; code = 1.0;
  } else if (dot(pt.xz, pt.xz) < R_OUT * R_OUT && tTop > 0.0) {
    p = pt;
    if (dot(p.xz, p.xz) < R_IN * R_IN) { med = 3; code = 2.0; }
    else { passIface(d, vec3(0.0, 1.0, 0.0), 1.0, N_GLASS, thr); med = 1; code = 3.0; }
  }

  vec3 land = vOld;
  if (med >= 0) {
    for (int it = 0; it < 10; it++) {
      float w = float(it + 2);
      if (med == 1) {
        vec2 co = cylHit(p, d, R_OUT);
        float tOut = co.y > 1e-6 ? co.y : 1e9;
        vec2 ci = cylHit(p, d, R_IN);
        float tIn = 1e9;
        if (ci.x > 1e-6 && dot(p.xz, p.xz) > R_IN * R_IN * 0.9999) {
          float yy = p.y + d.y * ci.x;
          if (yy > BASE_H && yy < CUP_H) tIn = ci.x;
        }
        float tBaseTop = 1e9;
        if (d.y > 0.0 && p.y < BASE_H) { float t = (BASE_H - p.y) / d.y; vec3 q = p + d * t; if (dot(q.xz, q.xz) < R_IN * R_IN) tBaseTop = t; }
        float tBottom = d.y < 0.0 ? -p.y / d.y : 1e9;
        float t = min(min(tOut, tIn), min(tBaseTop, tBottom));
        if (t > 1e8) break;
        thr *= exp(-SIGMA_GLASS * t);
        p += d * t;
        if (t == tBottom) { land = p; code += 4.0 * w; med = -1; break; }
        if (t == tOut) {
          vec3 no = vec3(p.x, 0.0, p.z) / R_OUT;
          if (passIface(d, -no, N_GLASS, 1.0, thr)) { med = 0; code += 5.0 * w; break; }
          code += 6.0 * w;
        } else if (t == tIn) {
          vec3 ni = vec3(p.x, 0.0, p.z) / R_IN;
          bool wet = p.y < surfY(p.xz * 0.999);
          if (passIface(d, ni, N_GLASS, wet ? uIorWater : 1.0, thr)) { med = wet ? 2 : 3; code += (wet ? 7.0 : 8.0) * w; }
        } else {
          if (passIface(d, vec3(0.0, -1.0, 0.0), N_GLASS, uIorWater, thr)) { med = 2; code += 9.0 * w; }
        }
      } else if (med == 2) {
        vec2 cw = cylHit(p, d, R_IN);
        float tWall = cw.y > 1e-6 ? cw.y : 1e9;
        float tBase = d.y < 0.0 ? (BASE_H - p.y) / d.y : 1e9;
        float tEnd = min(tWall, tBase);
        float tS = marchSurface(p, d, 1e-6, tEnd, -1.0);
        int ev = tWall < tBase ? 0 : 1;
        if (tS > 0.0 && tS < tEnd) { tEnd = tS; ev = 2; }
        thr *= exp(-SIGMA_WATER * tEnd - iceOptical(p, d, tEnd));
        p += d * tEnd;
        if (ev == 2) {
          vec4 s = surfSample(p.xz);
          vec3 ns = normalize(vec3(-s.g, 1.0, -s.b));
          if (passIface(d, -ns, uIorWater, 1.0, thr)) { med = 3; code += 10.0 * w; }
          p += d * 1e-5;
        } else if (ev == 0) {
          passIface(d, -vec3(p.x, 0.0, p.z) / R_IN, uIorWater, N_GLASS, thr); med = 1; code += 11.0 * w;
        } else {
          passIface(d, vec3(0.0, 1.0, 0.0), uIorWater, N_GLASS, thr); med = 1; code += 12.0 * w;
        }
      } else if (med == 3) {
        vec2 ci = cylHit(p, d, R_IN);
        float tWall = ci.y > 1e-6 ? ci.y : 1e9;
        float tS = marchSurface(p, d, 1e-6, tWall, 1.0);
        if (tS > 0.0 && tS < tWall) {
          p += d * tS;
          vec4 s = surfSample(p.xz);
          vec3 ns = normalize(vec3(-s.g, 1.0, -s.b));
          float ice = s.a;
          thr *= 1.0 - 0.75 * ice * 0.6;
          passIface(d, ns, 1.0, mix(uIorWater, 1.309, ice), thr);
          p += d * 1e-5;
          med = 2; code += 13.0 * w;
        } else {
          p += d * tWall;
          passIface(d, -vec3(p.x, 0.0, p.z) / R_IN, 1.0, N_GLASS, thr);
          med = 1; code += 14.0 * w;
        }
      } else break;
    }
    if (med == 0) {
      land = d.y < -1e-4 ? p + d * (-p.y / d.y) : vec3(1e3);
    } else if (med != -1) {
      land = vec3(1e3);
      thr = vec3(0.0);
    }
  }
  vNew = land;
  vThr = thr;
  vCode = code;
  vec3 wl = land + uCupPos;
  vec2 c = (wl.xz - uRect.xy) / uRect.zw * 2.0 - 1.0;
  gl_Position = vec4(c, 0.0, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
in vec3 vOld;
in vec3 vNew;
in vec3 vThr;
in float vCode;
out vec4 fragColor;
void main() {
  if (abs(vCode - floor(vCode + 0.5)) > 0.02) discard;
  float a0 = abs(dFdx(vOld.x) * dFdy(vOld.z) - dFdx(vOld.z) * dFdy(vOld.x));
  float a1 = abs(dFdx(vNew.x) * dFdy(vNew.z) - dFdx(vNew.z) * dFdy(vNew.x));
  float gain = min(a0 / max(a1, 1e-14), 30.0);
  fragColor = vec4(vThr * gain, 1.0);
}
`;

// Penumbra: the key light subtends a finite solid angle, so the irradiance pattern is the
// sharp map convolved with a kernel whose width grows with the occluder-receiver distance
// (approximated by the distance from the glass foot). It also hides the ray-grid scale.
const BLUR_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform vec4 uRect;
uniform vec2 uCup;
uniform float uBase, uSlope;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 wp = uRect.xy + vUv * uRect.zw;
  float dist = max(0.0, length(wp - uCup) - R_OUT);
  float sigma = uBase + uSlope * dist;
  vec2 st = uDir * (0.5 * sigma / uRect.z);
  vec3 s = vec3(0.0);
  float ws = 0.0;
  for (int i = -4; i <= 4; i++) {
    float x = float(i) * 0.5;
    float w = exp(-0.5 * x * x);
    s += texture(uSrc, vUv + st * float(i)).rgb * w;
    ws += w;
  }
  fragColor = vec4(s / ws, 1.0);
}
`;

export class Caustics {
  constructor(renderer, { surface, thermal, cond }) {
    this.renderer = renderer;
    const N = GRID.causticN;
    this.raw = makeTarget(N, N, { type: THREE.HalfFloatType });
    this.tmp = makeTarget(N, N, { type: THREE.HalfFloatType });
    this.target = makeTarget(N, N, { type: THREE.HalfFloatType });
    this.blur = new FullscreenPass(shaderMaterial({
      fragmentShader: GLSL_HEADER + BLUR_FRAG,
      uniforms: {
        uSrc: { value: null }, uDir: { value: new THREE.Vector2() }, uRect: { value: new THREE.Vector4() },
        uCup: { value: new THREE.Vector2() }, uBase: { value: 0.0007 }, uSlope: { value: 0.014 },
      },
    }));
    const n = GRID.causticGrid;
    const geo = new THREE.PlaneGeometry(2, 2, n, n);
    this.extent = 0.13;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GLSL_HEADER + COMMON + VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSurface: { value: surface }, uThermal: { value: thermal }, uCond: { value: cond },
        uCupPos: { value: new THREE.Vector3() },
        uLightDir: { value: new THREE.Vector3() }, uLightU: { value: new THREE.Vector3() },
        uLightV: { value: new THREE.Vector3() }, uLightOrigin: { value: new THREE.Vector3() },
        uExtent: { value: this.extent }, uRect: { value: new THREE.Vector4() },
        uIorWater: { value: 1.333 }, uEtaMin: { value: -0.004 }, uEtaMax: { value: 0.004 }, uIce: { value: 0 },
      },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.rect = new THREE.Vector4();
    this.lightU = new THREE.Vector3();
    this.lightV = new THREE.Vector3();
    this.lightOrigin = new THREE.Vector3();
    this.enabled = true;
  }

  update(cupPos, lightDir, extra) {
    const L = lightDir;
    const U = this.lightU.set(0, 1, 0).cross(L).normalize();
    if (U.lengthSq() < 1e-6) U.set(1, 0, 0);
    const V = this.lightV.copy(L).cross(U).normalize();
    const O = this.lightOrigin.set(cupPos.x, CUP.height * 0.5, cupPos.z);
    // bounding rectangle of the straight landing footprint of the ray grid
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const p = O.clone().addScaledVector(U, a * this.extent).addScaledVector(V, b * this.extent);
      const t = p.y / L.y;
      const x = p.x - L.x * t, z = p.z - L.z * t;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const size = Math.max(maxX - minX, maxZ - minZ);
    const cx = 0.5 * (minX + maxX), cz = 0.5 * (minZ + maxZ);
    this.rect.set(cx - size / 2, cz - size / 2, size, size);
    const u = this.material.uniforms;
    u.uCupPos.value.copy(cupPos);
    u.uLightDir.value.copy(L);
    u.uLightU.value.copy(U);
    u.uLightV.value.copy(V);
    u.uLightOrigin.value.copy(O);
    u.uRect.value.copy(this.rect);
    u.uIorWater.value = extra.ior;
    u.uEtaMin.value = extra.etaMin;
    u.uEtaMax.value = extra.etaMax;
    u.uIce.value = extra.ice;
    u.uSurface.value = extra.surface;
    u.uCond.value = extra.cond;

    const r = this.renderer;
    r.setRenderTarget(this.raw);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    if (!this.enabled) return;
    r.render(this.scene, this.camera);
    const bu = this.blur.material.uniforms;
    bu.uRect.value.copy(this.rect);
    bu.uCup.value.set(cupPos.x, cupPos.z);
    bu.uSrc.value = this.raw.texture;
    bu.uDir.value.set(1, 0);
    this.blur.render(r, this.tmp);
    bu.uSrc.value = this.tmp.texture;
    bu.uDir.value.set(0, 1);
    this.blur.render(r, this.target);
  }
}
