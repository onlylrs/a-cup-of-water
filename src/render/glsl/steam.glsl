// Shared volumetric density and lighting for steam inside and above the cup.
uniform float uSteamDensity, uSteamLevel;
uniform vec2 uSteamLean;
uniform vec3 uSteamAmbient;
uniform vec4 uSteamPuffs[STEAM_MAX_PUFFS];
uniform int uSteamPuffCount;
float steamNoise(vec3 p) { return texture(uNoise3, p).r; }

float steamDensity(vec3 p) {
  vec3 q = p - vec3(uCupPos.x, uSteamLevel, uCupPos.z);
  float h = q.y;
  if (h < -0.002) return 0.0;
  q.xz -= uSteamLean * h * 4.0;
  float t = uTime;
  // domain-warped turbulence advected upward
  vec3 w = vec3(steamNoise(q * 7.0 + vec3(0.0, -t * 0.22, 0.0)), steamNoise(q * 7.0 + vec3(5.2, -t * 0.22, 1.3)), steamNoise(q * 7.0 + vec3(2.1, -t * 0.22, 7.7))) - 0.5;
  vec3 qq = q + w * (0.015 + h * 0.18);
  float f = steamNoise(qq * vec3(16.0, 9.0, 16.0) + vec3(0.0, -t * 0.55, 0.0)) * 0.6
          + steamNoise(qq * vec3(38.0, 22.0, 38.0) + vec3(0.0, -t * 1.1, 0.0)) * 0.3
          + steamNoise(qq * vec3(80.0, 50.0, 80.0) + vec3(0.0, -t * 1.9, 0.0)) * 0.1;
  float rad = R_IN * 0.8 + h * 0.35;
  float r = length(qq.xz);
  float plume = exp(-pow(r / rad, 2.0) * 2.2);
  // vapour is invisible at the surface; it becomes fog only after mixing with cooler air
  float hfade = smoothstep(0.006, 0.05, h) * exp(-h / 0.075);
  // wisps: thin sheets of the turbulent field rather than a uniform cloud
  float wisp = smoothstep(0.5, 0.86, f) * (0.35 + 0.65 * smoothstep(0.35, 0.65, steamNoise(qq * vec3(9.0, 3.0, 9.0) + vec3(0.0, -t * 0.3, 0.0))));
  float d = wisp * plume * hfade * uSteamDensity;
  for (int i = 0; i < STEAM_MAX_PUFFS; i++) {
    if (i >= uSteamPuffCount) break;
    vec4 pf = uSteamPuffs[i];
    vec3 dp = p - pf.xyz;
    float pr = 0.006 + (1.0 - min(1.0, pf.w)) * 0.012;
    d += pf.w * exp(-dot(dp, dp) / (pr * pr)) * smoothstep(0.35, 0.7, f) * 1.4;
  }
  // below the rim the vapour is confined by the glass; above it the plume leaves the rim and
  // spreads as it entrains air
  float above = max(0.0, p.y - CUP_H);
  float wallR = R_IN - 0.001 + above * 0.6;
  d *= 1.0 - smoothstep(wallR - 0.006 - above * 0.3, wallR, length(p.xz - uCupPos.xz));
  return d;
}

vec3 steamLighting(vec3 p, vec3 rd) {
  float g = 0.55;
  float phase = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*dot(rd,uLightDir), 1.5) / (4.0*PI);
  float sh = exp(-steamDensity(p + uLightDir * 0.01) * 0.6);
  return uLightColor * (phase * 7.0 + 0.08) * sh + uSteamAmbient * 1.2;
}

// Integrate only up to the next traced surface or solid body. The incoming
// throughput already includes glass transmission and Fresnel reflection.
void steamInterior(vec3 ro, vec3 rd, float len, inout vec3 col, inout vec3 thr) {
  if ((uSteamDensity < 0.003 && uSteamPuffCount == 0) || len <= 0.0) return;
  const int STEPS = 12;
  float dt = len / float(STEPS);
  float jit = hash12(gl_FragCoord.xy + fract(uTime * 7.0) * 61.0);
  for (int i=0; i<STEPS; i++) {
    vec3 p = ro + rd * ((float(i) + jit) * dt);
    float dens = steamDensity(p);
    if (dens < 0.002) continue;
    float a = 1.0 - exp(-dens * 32.0 * dt);
    col += thr * a * steamLighting(p, rd);
    thr *= 1.0 - a;
  }
}
