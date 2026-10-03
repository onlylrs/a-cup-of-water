import * as THREE from 'three';
import { CUP, LIMITS } from '../config.js';
import { GLSL_HEADER } from './glsl/header.js';
import COMMON from './glsl/common.glsl?raw';

// Visible vapour above hot water: a ray-marched, buoyant, turbulent plume whose density
// follows the evaporation rate from the thermal solver, plus short-lived puffs released by
// bursting bubbles. The plume leans against the cup's motion (it is left behind in the air).

const VERT = /* glsl */`
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D uNoise3;
uniform vec3 uCupPos;
uniform vec3 uBoxMin, uBoxMax;
uniform float uDensity, uTime, uLevel;
uniform vec2 uLean;
uniform vec3 uLightDir, uLightColor;
uniform vec3 uAmbient;
uniform vec4 uPuffs[${LIMITS.maxPuffs}];
uniform int uPuffCount;
in vec3 vWorld;
out vec4 fragColor;
${COMMON}

float n3(vec3 p) { return texture(uNoise3, p).r; }

float density(vec3 p) {
  vec3 q = p - vec3(uCupPos.x, uLevel, uCupPos.z);
  float h = q.y;
  if (h < -0.002) return 0.0;
  q.xz -= uLean * h * 4.0;
  float t = uTime;
  // domain-warped turbulence advected upward
  vec3 w = vec3(n3(q * 7.0 + vec3(0.0, -t * 0.22, 0.0)), n3(q * 7.0 + vec3(5.2, -t * 0.22, 1.3)), n3(q * 7.0 + vec3(2.1, -t * 0.22, 7.7))) - 0.5;
  vec3 qq = q + w * (0.015 + h * 0.18);
  float f = n3(qq * vec3(16.0, 9.0, 16.0) + vec3(0.0, -t * 0.55, 0.0)) * 0.6
          + n3(qq * vec3(38.0, 22.0, 38.0) + vec3(0.0, -t * 1.1, 0.0)) * 0.3
          + n3(qq * vec3(80.0, 50.0, 80.0) + vec3(0.0, -t * 1.9, 0.0)) * 0.1;
  float rad = R_IN * 0.85 + h * 0.42;
  float r = length(qq.xz);
  float plume = exp(-pow(r / rad, 2.0) * 2.2);
  float hfade = smoothstep(-0.002, 0.012, h) * exp(-h / 0.085);
  float d = smoothstep(0.42, 0.78, f) * plume * hfade * uDensity;
  for (int i = 0; i < ${LIMITS.maxPuffs}; i++) {
    if (i >= uPuffCount) break;
    vec4 pf = uPuffs[i];
    vec3 dp = p - pf.xyz;
    float pr = 0.006 + (1.0 - min(1.0, pf.w)) * 0.012;
    d += pf.w * exp(-dot(dp, dp) / (pr * pr)) * smoothstep(0.35, 0.7, f) * 1.4;
  }
  return d;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float ta = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tb = min(min(tmax.x, tmax.y), tmax.z);
  if (rd.y < 0.0) tb = min(tb, (uLevel - 0.003 - ro.y) / rd.y);
  if (tb <= ta) discard;
  const int STEPS = 44;
  float dt = (tb - ta) / float(STEPS);
  float jit = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0);
  float T = 1.0;
  vec3 L = vec3(0.0);
  float cosT = dot(rd, uLightDir);
  float g = 0.55;
  float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5) / (4.0 * PI);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (ta + (float(i) + jit) * dt);
    float dens = density(p);
    if (dens < 0.002) continue;
    float sig = dens * 220.0;
    float a = 1.0 - exp(-sig * dt);
    // cheap self-shadowing towards the light
    float sh = exp(-density(p + uLightDir * 0.008) * 1.6);
    vec3 Ls = uLightColor * (phase * 7.0 + 0.08) * sh + uAmbient * 1.2;
    L += T * a * Ls;
    T *= 1.0 - a;
    if (T < 0.02) break;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002) discard;
  fragColor = vec4(L, alpha);
}
`;

export class Steam {
  constructor(shared, noise) {
    this.puffs = [];
    const puffU = Array.from({ length: LIMITS.maxPuffs }, () => new THREE.Vector4());
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: GLSL_HEADER + FRAG,
      uniforms: {
        uLightDir: shared.uLightDir, uLightColor: shared.uLightColor,
        uNoise3: { value: noise },
        uCupPos: { value: new THREE.Vector3() },
        uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
        uDensity: { value: 0 }, uTime: { value: 0 }, uLevel: { value: CUP.level },
        uLean: { value: new THREE.Vector2() },
        uAmbient: { value: new THREE.Vector3(0.05, 0.052, 0.058) },
        uPuffs: { value: puffU }, uPuffCount: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.lean = new THREE.Vector2();
    this.enabled = true;
  }

  addPuff(x, y, z, strength) {
    if (this.puffs.length >= LIMITS.maxPuffs) this.puffs.shift();
    this.puffs.push({ x, y, z, s: strength, age: 0 });
  }

  update(dt, time, cupPos, cupVel, density) {
    const u = this.material.uniforms;
    const half = 0.11, h = 0.34;
    const y0 = CUP.level - 0.01;
    u.uBoxMin.value.set(cupPos.x - half, y0, cupPos.z - half);
    u.uBoxMax.value.set(cupPos.x + half, y0 + h, cupPos.z + half);
    this.mesh.position.set(cupPos.x, y0 + h / 2, cupPos.z);
    this.mesh.scale.set(half * 2, h, half * 2);
    u.uCupPos.value.copy(cupPos);
    u.uTime.value = time;
    // the plume lags behind a moving glass
    this.lean.x += (-cupVel.x * 0.35 - this.lean.x) * Math.min(1, dt * 2.5);
    this.lean.y += (-cupVel.z * 0.35 - this.lean.y) * Math.min(1, dt * 2.5);
    u.uLean.value.copy(this.lean);
    u.uDensity.value = this.enabled ? density : 0;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      p.y += dt * 0.09;
      p.x += this.lean.x * dt * 0.5; p.z += this.lean.y * dt * 0.5;
      if (p.age > 1.6) this.puffs.splice(i, 1);
    }
    const n = Math.min(this.puffs.length, LIMITS.maxPuffs);
    for (let i = 0; i < n; i++) {
      const p = this.puffs[i];
      u.uPuffs.value[i].set(p.x, p.y, p.z, p.s * Math.max(0, 1 - p.age / 1.6));
    }
    u.uPuffCount.value = this.enabled ? n : 0;
    this.mesh.visible = this.enabled && (density > 0.003 || n > 0);
  }
}
