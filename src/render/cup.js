import * as THREE from 'three';
import { CUP, LIMITS } from '../config.js';
import { GLSL_HEADER } from './glsl/header.js';
import COMMON from './glsl/common.glsl?raw';
import SHADING from './glsl/shading.glsl?raw';
import CUP_GLSL from './glsl/cup.glsl?raw';
import STEAM_GLSL from './glsl/steam.glsl?raw';

// The glass is drawn as its bounding cylinder; the fragment shader ray-traces everything
// inside it (see glsl/cup.glsl). It writes alpha = 1 so the frost pass can tell which
// pixels show the glass.

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
precision highp sampler2D;
precision highp sampler3D;
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform vec3 uLightDir, uLightColor;
in vec3 vWorld;
out vec4 fragColor;
` + COMMON + SHADING + CUP_GLSL.replace('// STEAM_VOLUME_SHARED', STEAM_GLSL) + /* glsl */`
void main() {
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 col = traceCup(cameraPosition - uCupPos, rd);
  col += resolveBackground();
  fragColor = vec4(col, 1.0);
}
`;

export function createCupMaterial(shared) {
  const balls = Array.from({ length: LIMITS.maxBalls }, () => new THREE.Vector4());
  const info = Array.from({ length: LIMITS.maxBalls }, () => new THREE.Vector4());
  const rots = Array.from({ length: LIMITS.maxBalls }, () => new THREE.Matrix3());
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: GLSL_HEADER + FRAG,
    uniforms: {
      ...shared,
      uCupPos: { value: new THREE.Vector3() },
      uSurface: { value: null },
      uThermal: { value: null },
      uBubbles: { value: null },
      uBubbleCount: { value: 0 },
      uBallPos: { value: balls },
      uBallInfo: { value: info },
      uBallRot: { value: rots },
      uBallCount: { value: 0 },
      uBg: { value: null },
      uTableTop: { value: null },
      uTableRect: { value: new THREE.Vector4() },
      uViewProj: { value: new THREE.Matrix4() },
      uCond: { value: null },
      uNoise3: { value: null },
      uEtaMin: { value: -0.004 }, uEtaMax: { value: 0.004 },
      uIorWater: { value: 1.333 },
      uTime: { value: 0 },
      uIce: { value: 0 },
      uWallBubbles: { value: 0 },
      uShimmer: { value: 0 },
      uTopT: { value: 20 },
      uAbsorb: { value: 1 },
    },
  });
}

export function createCupProxy(material) {
  const geo = new THREE.CylinderGeometry(CUP.rOut + 0.0003, CUP.rOut + 0.0003, CUP.height + 0.0003, 128, 1, false);
  geo.translate(0, CUP.height / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}
