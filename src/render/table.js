import * as THREE from 'three';
import { CUP } from '../config.js';
import COMMON from './glsl/common.glsl?raw';
import { GLSL_HEADER } from './glsl/header.js';

// Walnut tabletop with a satin clear-coat. The direct (key) light is multiplied by the
// caustics map, which carries the complete light transport through the glass: the glass'
// shadow, the bright focus line of the water cylinder lens and the shimmering ripple caustics.

export const tableUniforms = {
  uCaustics: { value: null },
  uCausticRect: { value: new THREE.Vector4(0, 0, 1, 1) },   // xz min, size
  uLightPlane: { value: new THREE.Vector4() },               // cup centre xz, half extent, enable
  uLightU: { value: new THREE.Vector3(1, 0, 0) },
  uLightV: { value: new THREE.Vector3(0, 0, 1) },
  uLightOrigin: { value: new THREE.Vector3() },
  uCupPos: { value: new THREE.Vector3() },
  uWetness: { value: 0 },
};

// Quarter-sawn walnut planks. Every feature fades out with its screen-space frequency
// (fwidth) so nothing aliases, which matters because the glass magnifies the background.
const WOOD = /* glsl */`
vec3 woodColor(vec2 p, out float rough) {
  const float PLANK = 0.13;
  float plank = floor(p.y / PLANK + 0.5);
  float ph = hash12(vec2(plank, 3.7));
  vec2 q = vec2(p.x + ph * 13.0, p.y + ph * 0.37);
  // growth rings: long flowing lines along the plank, gently warped
  float w1 = fbm2(vec2(q.x * 2.1, q.y * 16.0 + ph * 5.0));
  float ringCoord = q.y * 190.0 * (0.75 + 0.5 * fbm2(vec2(q.x * 0.7, q.y * 2.0 + ph * 9.0))) + w1 * 7.0 + sin(q.x * 2.7 + ph * 6.0) * 1.8;
  float fwR = fwidth(ringCoord);
  float ring = fract(ringCoord);
  float late = smoothstep(0.0, 0.1, ring) * (1.0 - smoothstep(0.2, 0.62, ring));
  late *= 0.45 + 0.75 * vnoise(vec2(floor(ringCoord) * 1.7, ph * 11.0));
  late = mix(late, 0.3, smoothstep(0.2, 0.7, fwR));
  // fibres and open pores, also band-limited
  vec2 fq = vec2(q.x * 22.0, q.y * 1500.0);
  float fib = vnoise(fq + w1 * 3.0);
  fib = mix(fib, 0.5, smoothstep(0.3, 1.0, fwidth(fq.y)));
  vec2 pq = vec2(q.x * 140.0, q.y * 2200.0);
  float pores = smoothstep(0.72, 0.95, vnoise(pq));
  pores *= 1.0 - smoothstep(0.3, 1.0, fwidth(pq.y));
  float figure = fbm2(vec2(q.x * 0.9, q.y * 5.0 + ph * 3.0));
  vec3 early = vec3(0.23, 0.125, 0.062);
  vec3 lateC = vec3(0.095, 0.048, 0.022);
  vec3 c = mix(early, lateC, late * 0.7);
  c *= 0.86 + 0.28 * fib;
  c *= 1.0 - pores * 0.3;
  c *= mix(0.78, 1.12, ph) * (0.9 + 0.2 * figure);
  // plank joint: a soft, eased groove
  float sd = abs(fract(p.y / PLANK + 0.5) - 0.5) * PLANK;
  float fwS = fwidth(p.y);
  float seam = 1.0 - smoothstep(0.0, 0.0009 + 1.5 * fwS, sd);
  seam *= 1.0 - smoothstep(0.0006, 0.004, fwS);
  c *= 1.0 - seam * 0.55;
  rough = 0.38 + 0.1 * late + 0.06 * fib + seam * 0.25;
  return c;
}
`;

export function createTable() {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.28,
    envMapIntensity: 0.4,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, tableUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replaceAll(
      'RE_Direct( directLight,',
      'directLight.color *= causticFactor(vWPos);\n\t\tRE_Direct( directLight,',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform sampler2D uCaustics;
uniform vec4 uCausticRect;
uniform vec4 uLightPlane;
uniform vec3 uLightU, uLightV, uLightOrigin, uCupPos;
${GLSL_HEADER}
${COMMON}
${WOOD}
vec3 causticFactor(vec3 wp) {
  if (uLightPlane.w < 0.5) return vec3(1.0);
  // light-space coordinates of the light ray that lands here
  vec3 d = wp - uLightOrigin;
  float u = dot(d, uLightU), v = dot(d, uLightV);
  float e = uLightPlane.z;
  vec2 uv = (wp.xz - uCausticRect.xy) / uCausticRect.zw;
  if (abs(u) > e * 0.985 || abs(v) > e * 0.985 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(1.0);
  vec3 c = texture2D(uCaustics, uv).rgb;
  float edge = smoothstep(e * 0.985, e * 0.9, max(abs(u), abs(v)));
  return mix(vec3(1.0), c, edge);
}`)
      .replace('#include <map_fragment>', `
float woodRough;
diffuseColor.rgb = woodColor(vWPos.xz, woodRough);`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = woodRough;')
      .replace('#include <lights_fragment_begin>', lightsBegin)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
{
  // studio pool of light and contact occlusion around the glass foot
  float d0 = length(vWPos.xz);
  gl_FragColor.rgb *= mix(0.06, 1.0, exp(-pow(d0 / 0.62, 2.0)));
  float dc = length(vWPos.xz - uCupPos.xz) - R_OUT;
  if (dc > 0.0) gl_FragColor.rgb *= 1.0 - 0.55 * exp(-dc / 0.0022) - 0.18 * exp(-dc / 0.012);
  gl_FragColor.a = 0.0;
}`);
  };
  const geo = new THREE.PlaneGeometry(8, 8, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

export function createBackdrop() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 c = mix(vec3(0.0045, 0.0042, 0.0042), vec3(0.0012, 0.0013, 0.0016), smoothstep(0.0, 0.5, y));
        gl_FragColor = vec4(c, 0.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(9, 32, 16), mat);
  m.renderOrder = -10;
  return m;
}

export { WOOD };
export const CUP_FOOT = CUP.rOut;
