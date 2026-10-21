import * as THREE from 'three';
import { CUP, LIMITS } from '../config.js';
import { GLSL_HEADER } from './glsl/header.js';
import COMMON from './glsl/common.glsl?raw';
import STEAM_GLSL from './glsl/steam.glsl?raw';

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
uniform float uTime;
uniform vec3 uLightDir, uLightColor;
uniform sampler2D uSceneDepth;
uniform mat4 uInvViewProj;
uniform vec2 uViewport;
uniform vec4 uBallPos[MAX_BALLS];
uniform int uBallCount;
in vec3 vWorld;
out vec4 fragColor;
${COMMON}

${STEAM_GLSL}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float ta = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tb = min(min(tmax.x, tmax.y), tmax.z);
  if (rd.y < 0.0) tb = min(tb, (uSteamLevel - 0.003 - ro.y) / rd.y);
  // Stop the exterior volume at opaque raster geometry (table/external bodies).
  vec2 uv = gl_FragCoord.xy / uViewport;
  float z = texture(uSceneDepth, uv).r;
  if (z < 1.0) {
    vec4 h = uInvViewProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
    tb = min(tb, dot(h.xyz / h.w - ro, rd));
  }
  // Bodies traced by the cup shader have no raster depth, including portions
  // protruding above the rim. Clip against those analytic spheres as well.
  for (int i=0; i<MAX_BALLS; i++) {
    if (i >= uBallCount) break;
    vec4 b = uBallPos[i];
    vec3 oc = ro - (b.xyz + uCupPos);
    float qb = dot(oc,rd), qc = dot(oc,oc) - b.w*b.w;
    float disc = qb*qb - qc;
    if (disc >= 0.0) {
      float t = -qb - sqrt(disc);
      if (t > 0.0) tb = min(tb,t);
    }
  }
  if (tb <= ta) discard;
  const int STEPS = 40;
  float dt = (tb - ta) / float(STEPS);
  float jit = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0);
  float T = 1.0;
  vec3 L = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (ta + (float(i) + jit) * dt);
    // Below-rim steam is integrated along the cup's refracted ray, never
    // composited over the already shaded glass, rim or liquid surface.
    if (p.y < CUP_H) continue;
    float dens = steamDensity(p);
    if (dens < 0.002) continue;
    float sig = dens * 32.0;
    float a = 1.0 - exp(-sig * dt);
    vec3 Ls = steamLighting(p, rd);
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
        uSceneDepth: { value: null }, uInvViewProj: { value: new THREE.Matrix4() },
        uViewport: { value: new THREE.Vector2(1,1) },
        uBallPos: { value: [] }, uBallCount: { value: 0 },
        uCupPos: { value: new THREE.Vector3() },
        uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
        uSteamDensity: { value: 0 }, uTime: { value: 0 }, uSteamLevel: { value: CUP.level },
        uSteamLean: { value: new THREE.Vector2() },
        uSteamAmbient: { value: new THREE.Vector3(0.05, 0.052, 0.058) },
        uSteamPuffs: { value: puffU }, uSteamPuffCount: { value: 0 },
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
    u.uSteamLean.value.copy(this.lean);
    u.uSteamDensity.value = this.enabled ? density : 0;
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
      u.uSteamPuffs.value[i].set(p.x, p.y, p.z, p.s * Math.max(0, 1 - p.age / 1.6));
    }
    u.uSteamPuffCount.value = this.enabled ? n : 0;
    this.mesh.visible = this.enabled && (density > 0.003 || n > 0);
  }
}
