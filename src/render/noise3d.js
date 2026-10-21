import * as THREE from 'three';
import { mulberry } from '../stage/random.js';

// Tileable 3D value noise (3 independent channels, two octaves) for ice structure,
// schlieren and surface roughness.
export function createNoise3D(size = 64) {
  const rng = mulberry(4242);
  const lattice = (n) => {
    const a = new Float32Array(n * n * n);
    for (let i = 0; i < a.length; i++) a[i] = rng();
    return a;
  };
  const sample = (lat, n, x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const s = (t) => t * t * (3 - 2 * t);
    const ux = s(fx), uy = s(fy), uz = s(fz);
    const g = (i, j, k) => lat[((k % n + n) % n) * n * n + ((j % n + n) % n) * n + ((i % n + n) % n)];
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(g(xi, yi, zi), g(xi + 1, yi, zi), ux), l(g(xi, yi + 1, zi), g(xi + 1, yi + 1, zi), ux), uy),
      l(l(g(xi, yi, zi + 1), g(xi + 1, yi, zi + 1), ux), l(g(xi, yi + 1, zi + 1), g(xi + 1, yi + 1, zi + 1), ux), uy),
      uz,
    );
  };
  const chans = [0, 1, 2].map(() => [lattice(8), lattice(16)]);
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = ((z * size + y) * size + x) * 4;
    for (let c = 0; c < 3; c++) {
      const [a, b] = chans[c];
      const v = 0.65 * sample(a, 8, x / size * 8, y / size * 8, z / size * 8) +
        0.35 * sample(b, 16, x / size * 16, y / size * 16, z / size * 16);
      data[o + c] = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255);
    }
    data[o + 3] = 255;
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
