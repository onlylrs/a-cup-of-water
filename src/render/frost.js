import * as THREE from 'three';
import { CUP } from '../config.js';
import { GLSL_HEADER } from './glsl/header.js';
import COMMON from './glsl/common.glsl?raw';
import SHADING from './glsl/shading.glsl?raw';

// Second pass over the front of the glass. It reads the fully rendered frame (with mips) and
// composites what moisture on the outer wall does to it: micro-droplet fog blurs and
// veils, frost is an opaque, sparkling crystalline layer, and visible droplets are tiny
// lenses that show an inverted, magnified view framed by dark rims and specular glints.

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
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform vec3 uLightDir, uLightColor;
uniform sampler2D uScene;
uniform sampler2D uCond;
uniform vec2 uRes;
uniform vec3 uCupPos;
uniform float uTime;
in vec3 vWorld;
out vec4 fragColor;
${COMMON}
${SHADING}

vec3 blurScene(vec2 uv, float lod) {
  if (lod < 0.05) return textureLod(uScene, uv, 0.0).rgb;
  vec2 px = exp2(lod) / uRes;
  vec3 s = vec3(0.0);
  const vec2 K[8] = vec2[8](vec2(0.7, 0.1), vec2(-0.4, 0.62), vec2(-0.66, -0.3), vec2(0.18, -0.74),
                            vec2(1.0, 0.75), vec2(-1.05, 0.55), vec2(-0.5, -1.1), vec2(0.9, -0.8));
  for (int i = 0; i < 8; i++) s += textureLod(uScene, uv + K[i] * px * 1.2, lod).rgb;
  return s / 8.0 * 0.75 + textureLod(uScene, uv, lod).rgb * 0.25;
}

// cellular droplets; returns coverage and the droplet's tangent-space normal (xy) and height
float drops(vec2 s, float cellSize, float water, float seedOff, out vec3 nT) {
  nT = vec3(0.0, 0.0, 1.0);
  if (water < 0.02) return 0.0;
  vec2 g = s / cellSize;
  vec2 cell = floor(g);
  float best = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(i, j);
    float h = hash12(c + seedOff);
    float need = hash12(c + seedOff + 11.3);
    float exist = smoothstep(need, need + 0.15, water * 0.75);
    if (exist <= 0.0) continue;
    vec2 ctr = c + 0.15 + 0.7 * hash22(c + seedOff);
    float rad = (0.18 + 0.32 * h) * mix(0.55, 1.15, clamp(water - need, 0.0, 1.0)) * exist;
    vec2 dv = (g - ctr) / vec2(rad, rad * 1.08);
    dv.y += 0.12;                      // gravity sag: drops are fuller at the bottom
    float dd = dot(dv, dv);
    if (dd < 1.0 && rad > best) {
      best = rad;
      float hgt = sqrt(1.0 - dd);
      nT = normalize(vec3(dv * 0.9, hgt + 0.08));
    }
  }
  return best > 0.0 ? 1.0 : 0.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 base = textureLod(uScene, uv, 0.0);
  float mask = clamp(base.a, 0.0, 1.0);
  if (mask < 0.01) { fragColor = vec4(base.rgb, 1.0); return; }
  vec3 pl = vWorld - uCupPos;
  float ang = atan(pl.z, pl.x);
  vec2 cuv = vec2(ang / TAU, pl.y / CUP_H);
  vec4 c = texture(uCond, cuv);
  float fog = c.r, frost = c.g, water = c.b;
  vec3 N = normalize(vec3(pl.x, 0.0, pl.z));
  vec3 T = vec3(-sin(ang), 0.0, cos(ang));
  vec3 B = vec3(0.0, 1.0, 0.0);
  vec3 V = normalize(cameraPosition - vWorld);
  vec2 s = vec2(ang * R_OUT, pl.y);

  // droplets: big and small populations
  vec3 nT1, nT2;
  float d1 = drops(s, 0.0026, water - 0.25, 1.0, nT1);
  float d2 = drops(s, 0.0011, water * 1.4, 7.0, nT2);
  float dc = max(d1, d2);
  vec3 nT = d1 > 0.0 ? nT1 : nT2;
  vec3 nd = normalize(T * nT.x + B * nT.y + N * nT.z);

  vec3 col = base.rgb;
  float haze = clamp(fog * 0.9 + frost * 0.8, 0.0, 1.0) * (1.0 - dc);
  float lod = haze * 4.2;
  vec3 blurred = blurScene(uv, lod);
  col = mix(col, blurred, smoothstep(0.0, 0.5, haze));
  // fog veil: micro-droplets scatter ambient light back towards the viewer
  vec3 amb = envDiffuse(N);
  col = col * (1.0 - 0.32 * fog * (1.0 - dc)) + fog * (1.0 - dc) * (amb * 0.35 + uLightColor * max(0.0, dot(N, uLightDir)) * 0.05);

  // frost: dendritic crystal layer with view-dependent glints
  if (frost > 0.01) {
    // hoar frost is a porous scattering layer: optical depth ~ thickness, never fully opaque at
    // the ~0.1-0.5 mm a glass collects. Crystals first appear along branching veins and fill in
    // between them as the deposit thickens: the frost amount thresholds a domain-warped ridge
    // pattern, and the grain keeps even a thick layer textured
    float cr = fbm2(s * 1400.0);
    float grain = fbm2(s * 3500.0);
    float patchy = fbm2(s * 220.0 + 3.7);
    vec2 w = vec2(fbm2(s * 500.0), fbm2(s * 500.0 + 5.2));
    float vein = pow(1.0 - abs(2.0 * fbm2(s * 1100.0 + w * 2.5) - 1.0), 5.0);
    float pat = 1.0 - (0.55 * vein + 0.45 * grain);
    float f = frost * mix(0.8, 1.2, patchy);
    float cov = smoothstep(pat - 0.18, pat + 0.18, f);
    float grazing = 1.0 - abs(dot(N, V));
    float a = max(cov * mix(0.55, 0.82, grain), (1.0 - exp(-f * 1.5)) * 0.3) * (0.8 + 0.3 * grazing);
    a = clamp(a, 0.0, 0.9);
    // sparse facets catch the key light as point glints
    vec2 gc = s * 2600.0;
    vec2 gi = floor(gc);
    float facet = step(0.93, hash12(gi)) * smoothstep(0.3, 0.05, length(fract(gc) - 0.5)) * cov;
    vec3 fN = normalize(N + (vec3(hash12(gi + 1.7), hash12(gi + 3.1), hash12(gi + 5.3)) - 0.5) * 1.6);
    float glint = pow(max(0.0, dot(reflect(-V, fN), uLightDir)), 60.0) * facet;
    // a near-white diffuser: it back-scatters the light in front of it and diffusely transmits
    // the (heavily blurred) scene behind it, so it is never darker than what it covers; the key
    // light behind the glass shines through it by forward scattering
    float fwd = pow(max(0.0, dot(-V, uLightDir)), 3.0);
    float wrap = 0.3 + 0.4 * max(0.0, dot(N, uLightDir)) + 0.6 * fwd;
    vec3 behind = blurScene(uv, 5.5);
    vec3 frostCol = vec3(0.92, 0.95, 1.0) * (amb * 1.2 + uLightColor * wrap * 0.35 + behind * 0.85) * mix(0.82, 1.12, cr * 0.5 + grain * 0.5);
    frostCol += uLightColor * glint * 5.0;
    col = mix(col, frostCol, a * (1.0 - dc * 0.8));
  }

  // droplets act as plano-convex lenses: refracted (inverted) view + reflection + dark rim
  if (dc > 0.0) {
    vec3 ndv = (viewMatrix * vec4(nd, 0.0)).xyz;
    vec2 off = -ndv.xy * 0.035;
    vec3 refr = textureLod(uScene, uv + off, 0.6).rgb;
    float cosv = max(dot(nd, V), 0.0);
    float F = fresnelDielectric(cosv, 1.0, 1.333);
    vec3 refl = envLod(reflect(-V, nd), 0.0);
    float rim = smoothstep(0.15, 0.55, nT.z);
    vec3 dcol = refr * (1.0 - F) * mix(0.25, 1.0, rim) + refl * F * 1.3;
    float spec = pow(max(0.0, dot(reflect(-uLightDir, nd), V)), 300.0);
    dcol += uLightColor * spec * 4.0;
    col = mix(col, dcol, dc);
  }
  fragColor = vec4(mix(base.rgb, col, mask), 1.0);
}
`;

export function createFrostShell(shared) {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: GLSL_HEADER + FRAG,
    uniforms: {
      ...shared,
      uScene: { value: null },
      uCond: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uCupPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const geo = new THREE.CylinderGeometry(CUP.rOut + 0.0003, CUP.rOut + 0.0003, CUP.height, 128, 1, true);
  geo.translate(0, CUP.height / 2, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
