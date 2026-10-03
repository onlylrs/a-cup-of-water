import * as THREE from 'three';
import { LIMITS } from '../config.js';
import { GLSL_HEADER } from './glsl/header.js';
import COMMON from './glsl/common.glsl?raw';
import SHADING from './glsl/shading.glsl?raw';

// Rasterised versions of the bodies (used whenever a body is outside the glass, and for
// parts poking above the rim) share the exact BRDF of the ray tracer.

const BALL_VERT = /* glsl */`
out vec3 vN;
out vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const BALL_FRAG = /* glsl */`
precision highp float;
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform vec3 uLightDir, uLightColor;
uniform mat3 uRot;
uniform int uMat;
uniform float uWet;
in vec3 vN;
in vec3 vW;
out vec4 fragColor;
${COMMON}
${SHADING}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  vec3 c = shadeBall(uMat, uRot * n, n, v, vec3(1.0), 0.0);
  float ao = mix(0.35, 1.0, smoothstep(0.0, 0.01, vW.y));
  fragColor = vec4(c * ao, 0.0);
}
`;

const DROP_VERT = /* glsl */`
out vec3 vN;
out vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const DROP_FRAG = /* glsl */`
precision highp float;
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform vec3 uLightDir, uLightColor;
in vec3 vN;
in vec3 vW;
out vec4 fragColor;
${COMMON}
${SHADING}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float F = fresnelDielectric(dot(n, v), 1.0, 1.333);
  vec3 refl = envLod(reflect(-v, n), 0.0);
  vec3 refr = envLod(refract(-v, n, 0.75), 1.0) * 0.6;
  float spec = pow(max(0.0, dot(reflect(-uLightDir, n), v)), 200.0);
  fragColor = vec4(refl * F + refr * (1.0 - F) + uLightColor * spec * 3.0, 0.0);
}
`;

export function createBallMeshFactory(shared) {
  const geo = new THREE.SphereGeometry(1, 48, 32);
  return (matIndex) => {
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BALL_VERT,
      fragmentShader: GLSL_HEADER + BALL_FRAG,
      uniforms: {
        uEnv: shared.uEnv, uEnvMaxLod: shared.uEnvMaxLod,
        uLightDir: shared.uLightDir, uLightColor: shared.uLightColor,
        uRot: { value: new THREE.Matrix3() }, uMat: { value: matIndex }, uWet: { value: 0 },
      },
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.renderOrder = 1;
    return m;
  };
}

export function createSplashMesh(shared) {
  const geo = new THREE.SphereGeometry(1, 10, 8);
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: DROP_VERT,
    fragmentShader: GLSL_HEADER + DROP_FRAG,
    uniforms: {
      uEnv: shared.uEnv, uEnvMaxLod: shared.uEnvMaxLod,
      uLightDir: shared.uLightDir, uLightColor: shared.uLightColor,
    },
  });
  const mesh = new THREE.InstancedMesh(geo, mat, LIMITS.maxSplash);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}
