// ---------------------------------------------------------------------------
// Shared helpers: hashing, noise, thermal-field lookup and the ice-front mask.
// ---------------------------------------------------------------------------

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0));
  float c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// thermal field (r, y) in cup-local metres -> (solid fraction, T, cloud, shimmer)
vec4 thermalAt(sampler2D tex, float r, float y) {
  vec2 uv = vec2(clamp(r, 0.0, R_OUT) / R_OUT, clamp(y, 0.0, CUP_H) / CUP_H);
  return texture(tex, uv);
}

// Ice coverage of the free surface: thermal top-row solid fraction, broken up by noise so
// the freezing front grows as an irregular, crystalline rim instead of a perfect circle.
float iceSurfaceMask(sampler2D thermal, vec2 p) {
  float r = length(p);
  float fs = thermalAt(thermal, min(r, R_IN - 0.0006), TH_TOPY).x;
  float ang = atan(p.y, p.x);
  float n = fbm2(p * 260.0) * 0.6 + 0.4 * vnoise(vec2(ang * 9.0, r * 400.0));
  float front = fs + (n - 0.5) * 0.55 * (1.0 - abs(2.0 * fs - 1.0));
  return smoothstep(0.42, 0.58, front);
}
