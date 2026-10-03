import * as THREE from 'three';
import { LIGHT } from '../config.js';

// A procedural photo-studio: dark walls, a warm floor bounce, a key softbox aligned with the
// directional light (so reflections, shadows and caustics agree), two tall strip boxes that
// draw the long vertical highlights on the cylinder, a soft overhead panel and a warm rim.
// It is rendered once into a mip-mapped cube map (sampled by the custom ray tracer) and
// pre-filtered with PMREM for the standard three.js materials.

// softbox: bright diffuser with a soft roll-off towards the frame, like a real light box
function panel(w, h, color, intensity, pos, lookAt) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(intensity) }, uAspect: { value: w / h } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uAspect;
        varying vec2 vUv;
        void main() {
          vec2 q = abs(vUv - 0.5) * 2.0;
          float e = (1.0 - smoothstep(0.55, 1.0, q.x)) * (1.0 - smoothstep(0.55, 1.0, q.y));
          float hot = 0.75 + 0.25 * (1.0 - dot(q, q) * 0.5);
          gl_FragColor = vec4(uColor * e * hot, 1.0);
        }`,
    }),
  );
  m.position.copy(pos);
  m.lookAt(lookAt);
  return m;
}

export function buildStudio() {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(6, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          float y = vDir.y;
          vec3 floorC = vec3(0.075, 0.042, 0.024);
          vec3 horizon = vec3(0.05, 0.048, 0.05);
          vec3 top = vec3(0.012, 0.013, 0.016);
          vec3 c = y < 0.0 ? mix(horizon, floorC, smoothstep(0.0, -0.25, y)) : mix(horizon, top, smoothstep(0.0, 0.6, y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(room);
  const o = new THREE.Vector3(0, 0.06, 0);
  const L = new THREE.Vector3(...LIGHT.dir).normalize();
  scene.add(panel(1.5, 1.5, 0xfff4e6, 9.0, L.clone().multiplyScalar(3.2).add(o), o));
  scene.add(panel(0.28, 2.6, 0xffffff, 4.2, new THREE.Vector3(2.6, 1.1, 1.3), o));
  scene.add(panel(0.28, 2.6, 0xf2f6ff, 3.0, new THREE.Vector3(-2.7, 1.0, 1.6), o));
  scene.add(panel(2.6, 1.6, 0xffffff, 0.9, new THREE.Vector3(0.2, 3.2, 0.6), o));
  scene.add(panel(1.8, 0.35, 0xffc890, 2.4, new THREE.Vector3(0.6, 0.9, -3.0), o));
  return scene;
}

export function createEnvironment(renderer) {
  const scene = buildStudio();
  const cubeRT = new THREE.WebGLCubeRenderTarget(512, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(0.05, 20, cubeRT);
  cubeCam.position.set(0, 0.06, 0);
  cubeCam.update(renderer, scene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const pm = pmrem.fromScene(scene, 0.0, 0.05, 20);
  pmrem.dispose();
  return { cube: cubeRT.texture, pmrem: pm.texture, maxLod: Math.log2(512) };
}
