// ---------------------------------------------------------------------------
// Lighting helpers shared by the ray tracer and the rasterised objects.
// Requires: uniform samplerCube uEnv; uniform float uEnvMaxLod; uniform vec3 uLightDir, uLightColor;
// ---------------------------------------------------------------------------

vec3 envLod(vec3 dir, float lod) { return textureLod(uEnv, dir, lod).rgb; }

// diffuse irradiance approximation from a heavily filtered mip
vec3 envDiffuse(vec3 n) { return textureLod(uEnv, n, uEnvMaxLod - 1.5).rgb * 0.9; }

// radiance seen from under water: light arrives through the surface (Snell's window)
vec3 envUnderwater(vec3 dir, float lod) {
  return envLod(dir, lod) * mix(0.18, 1.0, smoothstep(-0.25, 0.55, dir.y)) * vec3(0.82, 0.95, 1.0);
}

float fresnelDielectric(float cosi, float n1, float n2) {
  cosi = clamp(cosi, 0.0, 1.0);
  float eta = n1 / n2;
  float sint2 = eta * eta * (1.0 - cosi * cosi);
  if (sint2 >= 1.0) return 1.0;
  float cost = sqrt(1.0 - sint2);
  float rs = (n1 * cosi - n2 * cost) / (n1 * cosi + n2 * cost);
  float rp = (n1 * cost - n2 * cosi) / (n1 * cost + n2 * cosi);
  return 0.5 * (rs * rs + rp * rp);
}

vec3 fresnelSchlick(vec3 f0, float c) { return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }

float ggx(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}

// ---------------------------------------------------------------------------
// Materials of the dropped objects. lp: point on the unit sphere in the body frame.
//   0 maple wood   1 polypropylene   2 thermo bead (amber, translucent)
//   3 glazed ceramic   4 polished steel
// ---------------------------------------------------------------------------
void ballMaterial(int mat, vec3 lp, out vec3 albedo, out float rough, out float metal, out vec3 f0, out float translucency) {
  translucency = 0.0;
  metal = 0.0;
  f0 = vec3(0.04);
  if (mat == 0) {
    float rr = length(lp.xz + vec2(0.9, 0.4));
    float w = fbm2(lp.xy * 3.0 + 4.0) * 1.6;
    float rings = 0.5 + 0.5 * sin(rr * 46.0 + w * 5.0);
    rings = pow(rings, 3.0);
    float grain = fbm2(vec2(lp.y * 3.0, rr * 80.0));
    albedo = mix(vec3(0.52, 0.33, 0.17), vec3(0.30, 0.16, 0.075), rings * 0.7 + grain * 0.3);
    rough = 0.55;
  } else if (mat == 1) {
    float band = smoothstep(0.13, 0.11, abs(lp.y));
    albedo = mix(vec3(0.72, 0.075, 0.045), vec3(0.85, 0.84, 0.8), band);
    rough = 0.3;
  } else if (mat == 2) {
    float swirl = fbm2(lp.xz * 2.5 + lp.y * 1.7);
    albedo = mix(vec3(0.85, 0.36, 0.035), vec3(0.95, 0.6, 0.12), swirl);
    rough = 0.1;
    translucency = 0.75;
  } else if (mat == 3) {
    float b1 = smoothstep(0.05, 0.035, abs(abs(lp.y) - 0.42));
    float b2 = smoothstep(0.02, 0.01, abs(lp.y));
    albedo = mix(vec3(0.78, 0.77, 0.72), vec3(0.03, 0.09, 0.42), max(b1, b2));
    rough = 0.14;
  } else {
    albedo = vec3(0.0);
    metal = 1.0;
    f0 = vec3(0.6, 0.6, 0.59);
    rough = 0.09 + 0.05 * fbm2(lp.xy * 20.0);
  }
}

// n, v in world/cup-local space (directions only), lightVis = direct light visibility
vec3 shadeBall(int mat, vec3 lp, vec3 n, vec3 v, vec3 lightVis, float underwater) {
  vec3 albedo, f0; float rough, metal, transl;
  ballMaterial(mat, lp, albedo, rough, metal, f0, transl);
  vec3 L = uLightDir;
  float NdotL = dot(n, L);
  float NdotV = max(dot(n, v), 1e-3);
  vec3 h = normalize(L + v);
  vec3 F = fresnelSchlick(f0, NdotV);
  vec3 r = reflect(-v, n);
  float lod = rough * (uEnvMaxLod - 2.0) + 0.5;
  vec3 envR = underwater > 0.5 ? envUnderwater(r, lod) : envLod(r, lod);
  vec3 envD = underwater > 0.5 ? envUnderwater(n, uEnvMaxLod - 1.5) * 0.9 : envDiffuse(n);
  vec3 diffuse = albedo * (1.0 - metal) * (envD + uLightColor * max(NdotL, 0.0) * lightVis);
  // wrap lighting through the translucent bead
  diffuse += albedo * transl * uLightColor * lightVis * (0.25 * pow(max(0.0, -NdotL * 0.5 + 0.5), 2.0) + 0.12);
  vec3 spec = envR * F;
  float a = max(0.03, rough * rough);
  spec += uLightColor * lightVis * ggx(max(dot(n, h), 0.0), a) * fresnelSchlick(f0, dot(h, v)) * max(NdotL, 0.0) * 0.25;
  return diffuse + spec;
}
