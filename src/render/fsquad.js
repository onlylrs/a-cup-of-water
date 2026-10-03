import * as THREE from 'three';

// Minimal fullscreen-triangle pass used by the GPU solvers and the post chain.
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

export const FS_VERTEX = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class FullscreenPass {
  constructor(material) {
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  get material() { return this.mesh.material; }
  set material(m) { this.mesh.material = m; }

  render(renderer, target) {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, camera);
  }
}

export function shaderMaterial(params) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    vertexShader: FS_VERTEX,
    ...params,
  });
}

export function makeTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: opts.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: opts.filter ?? THREE.LinearFilter,
    magFilter: opts.filter ?? THREE.LinearFilter,
    wrapS: opts.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: opts.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: opts.depth ?? false,
    stencilBuffer: false,
    samples: opts.samples ?? 0,
    generateMipmaps: opts.mipmaps ?? false,
  });
  if (opts.mipmaps) rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
  return rt;
}
