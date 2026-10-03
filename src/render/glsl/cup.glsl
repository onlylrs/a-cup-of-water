// ---------------------------------------------------------------------------
// Ray tracer for everything inside the glass' bounding cylinder.
// Media: outside air, glass (wall + thick base), liquid water / ice, air inside the cup.
// At every interface we evaluate the exact dielectric Fresnel term, add the reflected
// environment radiance and continue along the refracted ray (or the reflected one on total
// internal reflection). Water and glass absorb with Beer-Lambert; ice scatters volumetrically
// according to the thermal solver's solid fraction and trapped-gas (cloud) fields.
// ---------------------------------------------------------------------------

uniform vec3 uCupPos;
uniform sampler2D uSurface;   // eta (mm), slope x, slope z, ice mask
uniform sampler2D uThermal;
uniform sampler2D uBubbles;
uniform int uBubbleCount;
uniform vec4 uBallPos[MAX_BALLS];
uniform vec4 uBallInfo[MAX_BALLS];   // material, ...
uniform mat3 uBallRot[MAX_BALLS];
uniform int uBallCount;
uniform sampler2D uBg;
uniform mat4 uViewProj;
uniform sampler2D uCaustics;
uniform vec4 uCausticRect;
uniform vec4 uLightPlane;
uniform vec3 uLightU, uLightV, uLightOrigin;
uniform sampler2D uCond;
uniform sampler3D uNoise3;
uniform float uEtaMin, uEtaMax;   // surface bounds relative to LEVEL0 (m)
uniform float uIorWater;
uniform float uTime;
uniform float uIce;               // global solid fraction
uniform float uWallBubbles;
uniform float uShimmer;
uniform float uTopT;              // temperature of the top layer
uniform float uAbsorb;            // water absorption scale

const int M_OUT = 0, M_GLASS = 1, M_WATER = 2, M_AIR = 3;
const vec3 SIGMA_WATER = vec3(1.4, 0.32, 0.17);
const vec3 SIGMA_GLASS = vec3(1.6, 0.42, 1.05);
const float N_GLASS = 1.5;

vec2 cylHit(vec3 o, vec3 d, float R) {
  float a = dot(d.xz, d.xz);
  if (a < 1e-12) return vec2(1e9, -1e9);
  float b = dot(o.xz, d.xz);
  float c = dot(o.xz, o.xz) - R * R;
  float disc = b * b - a * c;
  if (disc < 0.0) return vec2(1e9, -1e9);
  float s = sqrt(disc);
  return vec2((-b - s) / a, (-b + s) / a);
}

vec4 surfSample(vec2 xz) { return texture(uSurface, xz / R_IN * 0.5 + 0.5); }
float surfY(vec2 xz) { return LEVEL0 + surfSample(xz).r * 1e-3; }

vec3 surfNormal(vec2 xz, out float ice) {
  vec4 s = surfSample(xz);
  ice = s.a;
  return normalize(vec3(-s.g, 1.0, -s.b));
}

// first crossing of the height field on (t0, t1). sgn = +1 when starting above it.
float marchSurface(vec3 o, vec3 d, float t0, float t1, float sgn) {
  float ylo = LEVEL0 + uEtaMin - 0.0005, yhi = LEVEL0 + uEtaMax + 0.0005;
  if (abs(d.y) > 1e-7) {
    float ta = (ylo - o.y) / d.y, tb = (yhi - o.y) / d.y;
    t0 = max(t0, min(ta, tb));
    t1 = min(t1, max(ta, tb));
  } else if (o.y < ylo || o.y > yhi) return -1.0;
  if (t1 <= t0) return -1.0;
  const int STEPS = 30;
  float dt = (t1 - t0) / float(STEPS);
  float tp = t0;
  vec3 q = o + d * t0;
  float fp = sgn * (q.y - surfY(q.xz));
  if (fp < 0.0) return t0;
  for (int i = 1; i <= STEPS; i++) {
    float t = t0 + dt * float(i);
    q = o + d * t;
    float f = sgn * (q.y - surfY(q.xz));
    if (f < 0.0) {
      for (int k = 0; k < 6; k++) {
        float tm = 0.5 * (tp + t);
        vec3 qm = o + d * tm;
        if (sgn * (qm.y - surfY(qm.xz)) < 0.0) t = tm; else tp = tm;
      }
      return t;
    }
    tp = t;
  }
  return -1.0;
}

// ---------- lighting inside the glass ----------
vec3 causticAt(vec3 pl) {
  if (uLightPlane.w < 0.5) return vec3(1.0);
  vec3 wp = pl + uCupPos;
  // follow the refracted light ray down to the table to look up the light transport
  vec3 Lw = refract(-uLightDir, vec3(0.0, 1.0, 0.0), 1.0 / uIorWater);
  if (pl.y < LEVEL0) wp += Lw * (wp.y / max(1e-3, -Lw.y));
  else wp += -uLightDir * (wp.y / max(1e-3, uLightDir.y));
  vec2 uv = (wp.xz - uCausticRect.xy) / uCausticRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(1.0);
  return texture(uCaustics, uv).rgb;
}

vec3 background(vec3 pl, vec3 d) {
  vec3 pw = pl + uCupPos;
  vec3 target = d.y < -0.002 ? pw + d * (-pw.y / d.y) : pw + d * 2.5;
  vec4 clip = uViewProj * vec4(target, 1.0);
  if (clip.w > 0.0) {
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (all(greaterThan(uv, vec2(0.001))) && all(lessThan(uv, vec2(0.999)))) return texture(uBg, uv).rgb;
  }
  return envLod(d, 1.0) * 0.08;
}

// The final background lookup of a path is deferred until after the (divergent) tracing
// loop, so screen-space derivatives of its uv are valid and select the right mip level:
// strongly minifying refraction then filters instead of aliasing.
// Table points that are off-screen (or hidden) in the camera view come from a top-down
// render of the table around the glass instead.
uniform sampler2D uTableTop;
uniform vec4 uTableRect;      // world xz min, size

vec3 gBgW = vec3(0.0), gTopW = vec3(0.0);
vec2 gBgUv = vec2(0.5), gTopUv = vec2(0.5);
vec3 deferBackground(vec3 pl, vec3 d, vec3 w) {
  vec3 pw = pl + uCupPos;
  bool table = d.y < -0.002;
  vec3 target = table ? pw + d * (-pw.y / d.y) : pw + d * 2.5;
  vec4 clip = uViewProj * vec4(target, 1.0);
  float onScreen = 0.0;
  vec2 uv = vec2(0.5);
  if (clip.w > 0.0) {
    uv = clip.xy / clip.w * 0.5 + 0.5;
    vec2 e = min(uv, 1.0 - uv);
    onScreen = smoothstep(0.0, 0.05, min(e.x, e.y));
  }
  float top = 0.0;
  vec2 tuv = (target.xz - uTableRect.xy) / uTableRect.zw;
  if (table && all(greaterThan(tuv, vec2(0.0))) && all(lessThan(tuv, vec2(1.0)))) top = 1.0;
  // near the screen border, cross-fade to the top-down table view
  float wScreen = top > 0.5 ? onScreen : step(0.001, onScreen);
  float wTop = top * (1.0 - wScreen);
  gBgUv = uv; gBgW = w * wScreen;
  gTopUv = tuv; gTopW = w * wTop;
  return w * (1.0 - wScreen - wTop) * envLod(d, 1.0) * 0.08;
}

vec2 clampGrad(vec2 g, float lim) { return g * min(1.0, lim / max(length(g), 1e-9)); }

vec3 resolveBackground() {
  // neighbours that took a different path give meaningless gradients: clamp the footprint
  float lim = 12.0 / float(textureSize(uBg, 0).x);
  vec2 gx = clampGrad(dFdx(gBgUv), lim), gy = clampGrad(dFdy(gBgUv), lim);
  vec2 tx = clampGrad(dFdx(gTopUv), 0.015), ty = clampGrad(dFdy(gTopUv), 0.015);
  vec3 c = vec3(0.0);
  if (max(gBgW.r, max(gBgW.g, gBgW.b)) > 0.0) c += gBgW * textureGrad(uBg, gBgUv, gx, gy).rgb;
  if (max(gTopW.r, max(gTopW.g, gTopW.b)) > 0.0) c += gTopW * textureGrad(uTableTop, gTopUv, tx, ty).rgb;
  return c;
}

// ---------- objects ----------
bool traceBalls(vec3 o, vec3 d, float tmax, out float tHit, out int idx) {
  tHit = tmax; idx = -1;
  for (int i = 0; i < MAX_BALLS; i++) {
    if (i >= uBallCount) break;
    vec4 b = uBallPos[i];
    vec3 oc = o - b.xyz;
    float bb = dot(oc, d);
    float cc = dot(oc, oc) - b.w * b.w;
    float disc = bb * bb - cc;
    if (disc < 0.0) continue;
    float t = -bb - sqrt(disc);
    if (t > 1e-6 && t < tHit) { tHit = t; idx = i; }
  }
  return idx >= 0;
}

vec3 ballColor(int i, vec3 p, vec3 d, float underwater) {
  vec4 b = uBallPos[i];
  vec3 n = normalize(p - b.xyz);
  vec3 lp = uBallRot[i] * n;
  vec3 vis = underwater > 0.5 ? causticAt(p) : vec3(1.0);
  // soft self-occlusion against the glass base and walls
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.006, p.y - BASE_H)) * mix(0.7, 1.0, smoothstep(0.0, 0.005, R_IN - length(p.xz)));
  return shadeBall(int(uBallInfo[i].x), lp, n, -d, vis, underwater) * ao;
}

// oblate spheroid bubbles: semi-axis A along 'axis', B perpendicular, volume-preserving
bool traceBubbles(vec3 o, vec3 d, float tmax, out float tHit, out float tOut, out vec3 nHit) {
  tHit = tmax; tOut = tmax;
  bool hit = false;
  for (int i = 0; i < MAX_BUBBLES; i++) {
    if (i >= uBubbleCount) break;
    vec4 b = texelFetch(uBubbles, ivec2(i, 0), 0);
    vec3 oc = o - b.xyz;
    float br = b.w * 1.5;
    float bb = dot(oc, d);
    float cc = dot(oc, oc) - br * br;
    if (cc > 0.0 && bb > 0.0) continue;
    if (bb * bb - cc < 0.0) continue;
    if (-bb - br > tHit) continue;
    vec4 s = texelFetch(uBubbles, ivec2(i, 1), 0);
    float chi = max(0.6, s.w);
    float A = b.w * pow(chi, -0.6667), B = b.w * pow(chi, 0.3333);
    vec3 ax = s.xyz;
    float oa = dot(oc, ax), da = dot(d, ax);
    vec3 op = oc - oa * ax, dp = d - da * ax;
    float iA2 = 1.0 / (A * A), iB2 = 1.0 / (B * B);
    float qa = dot(dp, dp) * iB2 + da * da * iA2;
    float qb = dot(op, dp) * iB2 + oa * da * iA2;
    float qc = dot(op, op) * iB2 + oa * oa * iA2 - 1.0;
    float disc = qb * qb - qa * qc;
    if (disc < 0.0) continue;
    float sq = sqrt(disc);
    float t0 = (-qb - sq) / qa, t1 = (-qb + sq) / qa;
    if (t0 > 1e-6 && t0 < tHit) {
      tHit = t0; tOut = t1;
      vec3 ph = oc + d * t0;
      float pa = dot(ph, ax);
      nHit = normalize((ph - pa * ax) * iB2 + pa * ax * iA2);
      hit = true;
    }
  }
  return hit;
}

// tiny dissolved-air bubbles clinging to the wetted glass (procedural, cellular)
float clingBubbles(vec2 st, float amount, out float ring) {
  ring = 0.0;
  if (amount < 0.01) return 0.0;
  vec2 g = st / 0.0016;
  vec2 cell = floor(g);
  float cov = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(i, j);
    vec2 h = hash22(c);
    if (hash12(c + 7.7) > amount * 0.9) continue;
    vec2 ctr = c + 0.2 + 0.6 * h;
    float rad = (0.12 + 0.3 * hash12(c + 3.1)) * (0.5 + 0.5 * amount);
    float dd = length(g - ctr) / rad;
    if (dd < 1.0) {
      cov = max(cov, 1.0);
      ring = max(ring, smoothstep(0.55, 0.95, dd) * (1.0 - smoothstep(0.95, 1.0, dd)) + 0.25 * smoothstep(0.35, 0.0, length(g - ctr - rad * vec2(-0.3, 0.35)) / rad));
    }
  }
  return cov;
}

// ---------- ice volume ----------
void iceVolume(vec3 o, vec3 d, float len, inout vec3 col, inout vec3 thr) {
  if (uIce < 0.002 || len <= 0.0) return;
  const int N = 18;
  float ds = len / float(N);
  float jit = hash12(gl_FragCoord.xy);
  vec3 amb = envDiffuse(vec3(0.0, 1.0, 0.0)) * vec3(0.86, 0.93, 1.0);
  vec3 sun = uLightColor * 0.55;
  for (int i = 0; i < N; i++) {
    vec3 x = o + d * ((float(i) + jit) * ds);
    vec4 th = thermalAt(uThermal, length(x.xz), x.y);
    float fs = th.x;
    if (fs < 0.03) continue;
    float n1 = texture(uNoise3, x * vec3(38.0, 14.0, 38.0)).r;
    float n2 = texture(uNoise3, x * vec3(150.0, 60.0, 150.0) + 0.37).r;
    float cloud = th.z;
    // trapped bubbles: cloudy core plus radial streaks of bubbles, thin crack sheets
    float streak = smoothstep(0.55, 0.85, texture(uNoise3, vec3(atan(x.z, x.x) * 0.9, x.y * 30.0, length(x.xz) * 8.0)).r);
    float crack = smoothstep(0.035, 0.0, abs(n1 - 0.5)) * 0.6;
    float dens = fs * (1.2 + 85.0 * cloud * cloud * (0.35 + n2) + 30.0 * cloud * streak + crack * 25.0);
    // the freezing front itself is a slushy, crystalline band
    dens += 160.0 * fs * (1.0 - fs) * (0.4 + n2);
    float a = 1.0 - exp(-dens * ds);
    vec3 Ls = amb * 0.95 + sun * (0.35 + 0.65 * pow(max(0.0, dot(d, uLightDir)), 4.0));
    col += thr * Ls * a * vec3(0.93, 0.97, 1.0);
    thr *= 1.0 - a;
  }
}

// ---------- the integrator ----------
vec3 traceCup(vec3 camLocal, vec3 rd) {
  vec3 col = vec3(0.0);
  vec3 thr = vec3(1.0);

  // entry into the closed bounding cylinder r < R_OUT, 0 < y < CUP_H
  vec2 cs = cylHit(camLocal, rd, R_OUT);
  float tSide = cs.x;
  float ySide = camLocal.y + rd.y * tSide;
  float tTop = (CUP_H - camLocal.y) / rd.y;
  vec3 pt = camLocal + rd * tTop;
  vec3 p, n;
  int med;
  if (tSide > 0.0 && ySide >= 0.0 && ySide <= CUP_H) {
    p = camLocal + rd * tSide;
    n = vec3(p.x, 0.0, p.z) / R_OUT;
    med = M_GLASS;
  } else if (rd.y < 0.0 && tTop > 0.0 && dot(pt.xz, pt.xz) < R_OUT * R_OUT) {
    p = pt;
    float r = length(p.xz);
    if (r < R_IN) {
      med = M_AIR;
    } else {
      // rounded rim: tilt the normal across the lip
      float s = (r - 0.5 * (R_IN + R_OUT)) / (0.5 * (R_OUT - R_IN));
      n = normalize(vec3(p.x / r * s * 0.9, 1.0, p.z / r * s * 0.9));
      med = M_GLASS;
    }
  } else {
    return background(camLocal, rd);
  }
  vec3 d = rd;
  if (med == M_GLASS) {
    float F = fresnelDielectric(-dot(d, n), 1.0, N_GLASS);
    col += F * envLod(reflect(d, n), 0.0);
    thr *= 1.0 - F;
    d = refract(d, n, 1.0 / N_GLASS);
  }

  for (int it = 0; it < 14; it++) {
    if (max(thr.r, max(thr.g, thr.b)) < 0.004) break;

    if (med == M_GLASS) {
      vec2 co = cylHit(p, d, R_OUT);
      float tOut = co.y > 1e-6 ? co.y : 1e9;
      vec2 ci = cylHit(p, d, R_IN);
      float tIn = 1e9;
      if (ci.x > 1e-6 && dot(p.xz, p.xz) > R_IN * R_IN * 0.9999) {
        float yy = p.y + d.y * ci.x;
        if (yy > BASE_H && yy < CUP_H) tIn = ci.x;
      }
      float tBaseTop = 1e9;
      if (d.y > 0.0 && p.y < BASE_H) {
        float t = (BASE_H - p.y) / d.y;
        vec3 q = p + d * t;
        if (dot(q.xz, q.xz) < R_IN * R_IN) tBaseTop = t;
      }
      float tBottom = d.y < 0.0 ? -p.y / d.y : 1e9;
      float tRim = 1e9;
      if (d.y > 0.0) {
        float t = (CUP_H - p.y) / d.y;
        vec3 q = p + d * t;
        float r2 = dot(q.xz, q.xz);
        if (r2 > R_IN * R_IN && r2 < R_OUT * R_OUT) tRim = t;
      }
      float t = min(min(tOut, tIn), min(min(tBaseTop, tBottom), tRim));
      if (t > 1e8) { col += deferBackground(p, d, thr); break; }
      thr *= exp(-SIGMA_GLASS * t);
      p += d * t;
      if (t == tOut) {
        vec3 no = vec3(p.x, 0.0, p.z) / R_OUT;
        float F = fresnelDielectric(dot(d, no), N_GLASS, 1.0);
        if (F >= 1.0) { d = reflect(d, -no); continue; }
        vec3 dOut = refract(d, -no, N_GLASS);
        col += thr * F * envLod(reflect(d, -no), 0.0) * 0.35;
        thr *= 1.0 - F;
        // frost / fog on the far side of the glass scatters what is seen through it
        float u = atan(p.z, p.x) / TAU;
        vec4 cond = texture(uCond, vec2(u, p.y / CUP_H));
        float haze = clamp(max(cond.g * 1.1, cond.r * 0.55), 0.0, 0.95);
        float hz = smoothstep(0.0, 1.0, haze);
        col += deferBackground(p, dOut, thr * (1.0 - hz));
        col += thr * hz * (envDiffuse(dOut) * 0.75 + vec3(0.02));
        break;
      } else if (t == tIn) {
        vec3 ni = vec3(p.x, 0.0, p.z) / R_IN;
        bool wet = p.y < surfY(p.xz * 0.999);
        float n2 = wet ? uIorWater : 1.0;
        float F = fresnelDielectric(-dot(d, ni), N_GLASS, n2);
        if (F >= 1.0) { d = reflect(d, ni); continue; }
        col += thr * F * envLod(reflect(d, ni), 1.0) * 0.3;
        thr *= 1.0 - F;
        d = refract(d, ni, N_GLASS / n2);
        if (!wet) {
          // condensation on the inner wall above hot water
          float u = atan(p.z, p.x) / TAU;
          float fogIn = texture(uCond, vec2(u, p.y / CUP_H)).a;
          col += thr * fogIn * envDiffuse(-ni) * 0.55;
          thr *= 1.0 - fogIn * 0.65;
        }
        med = wet ? M_WATER : M_AIR;
      } else if (t == tBaseTop) {
        vec3 nb = vec3(0.0, -1.0, 0.0);
        float F = fresnelDielectric(-dot(d, nb), N_GLASS, uIorWater);
        if (F >= 1.0) { d = reflect(d, nb); continue; }
        thr *= 1.0 - F;
        d = refract(d, nb, N_GLASS / uIorWater);
        med = M_WATER;
      } else if (t == tBottom) {
        // resting on the table: what is seen is the table right under the foot
        col += deferBackground(p, d, thr * 0.9);
        break;
      } else {
        vec3 nr = vec3(0.0, -1.0, 0.0);
        float F = fresnelDielectric(-dot(d, nr), N_GLASS, 1.0);
        if (F >= 1.0) { d = reflect(d, nr); continue; }
        thr *= 1.0 - F;
        d = refract(d, nr, N_GLASS);
        med = M_OUT;
      }
    }

    else if (med == M_WATER) {
      // schlieren from temperature gradients while heating
      if (uShimmer > 0.0) {
        vec3 sh = texture(uNoise3, p * 90.0 + vec3(0.0, -uTime * 0.35, 0.0)).rgb - 0.5;
        float g = thermalAt(uThermal, length(p.xz), p.y).w;
        d = normalize(d + sh * 0.012 * uShimmer * g);
      }
      vec2 cw = cylHit(p, d, R_IN);
      float tWall = cw.y > 1e-6 ? cw.y : 1e9;
      float tBase = d.y < 0.0 ? (BASE_H - p.y) / d.y : 1e9;
      float tEnd = min(tWall, tBase);
      float tS = marchSurface(p, d, 1e-6, tEnd, -1.0);
      int ev = tWall < tBase ? 0 : 1;
      if (tS > 0.0 && tS < tEnd) { tEnd = tS; ev = 2; }

      float tb; int bi;
      bool hb = traceBalls(p, d, tEnd, tb, bi);
      float tq, tqo; vec3 qn;
      bool hq = traceBubbles(p, d, hb ? tb : tEnd, tq, tqo, qn);
      float seg = hq ? tq : (hb ? tb : tEnd);
      iceVolume(p, d, seg, col, thr);
      thr *= exp(-SIGMA_WATER * uAbsorb * seg);

      if (hq) {
        vec3 ph = p + d * tq;
        float F = fresnelDielectric(-dot(d, qn), uIorWater, 1.0);
        col += thr * F * envUnderwater(reflect(d, qn), 1.0) * 1.15;
        thr *= (1.0 - F) * vec3(0.97, 0.985, 1.0);
        p = p + d * (tqo + 1e-5);
        continue;
      }
      if (hb) {
        col += thr * ballColor(bi, p + d * tb, d, 1.0);
        thr = vec3(0.0);
        break;
      }
      p += d * tEnd;
      if (ev == 2) {
        float ice;
        vec3 ns = surfNormal(p.xz, ice);
        vec3 nn = -ns;
        if (ice > 0.02) nn = normalize(nn + (texture(uNoise3, p * 120.0).rgb - 0.5) * 0.35 * ice);
        float n2 = 1.0;
        float nw = mix(uIorWater, 1.309, ice);
        float F = fresnelDielectric(-dot(d, nn), nw, n2);
        if (F >= 1.0) { d = reflect(d, nn); p += d * 1e-5; continue; }
        // the underside of the free surface mirrors the interior
        col += thr * F * envUnderwater(reflect(d, nn), 1.0) * 0.6;
        thr *= 1.0 - F;
        d = refract(d, nn, nw / n2);
        // frosty skin on top of the ice sheet
        float frost = ice * (0.12 + 0.55 * smoothstep(-1.0, -12.0, uTopT));
        col += thr * frost * envDiffuse(vec3(0.0, 1.0, 0.0)) * 0.8;
        thr *= 1.0 - frost * 0.85;
        p += d * 1e-5;
        med = M_AIR;
      } else if (ev == 0) {
        vec3 ni = -vec3(p.x, 0.0, p.z) / R_IN;
        if (uWallBubbles > 0.0) {
          float ang = atan(p.z, p.x);
          float ring;
          float cov = clingBubbles(vec2(ang * R_IN, p.y), uWallBubbles * smoothstep(BASE_H, BASE_H + 0.01, p.y), ring);
          col += thr * ring * envUnderwater(vec3(0.0, 1.0, 0.0), 2.0) * 0.9;
          thr *= 1.0 - 0.35 * cov;
        }
        float F = fresnelDielectric(-dot(d, ni), uIorWater, N_GLASS);
        thr *= 1.0 - F;
        d = refract(d, ni, uIorWater / N_GLASS);
        med = M_GLASS;
      } else {
        vec3 nb = vec3(0.0, 1.0, 0.0);
        if (uWallBubbles > 0.0) {
          float ring;
          float cov = clingBubbles(p.xz + 0.37, uWallBubbles, ring);
          col += thr * ring * envUnderwater(vec3(0.0, 1.0, 0.0), 2.0) * 0.9;
          thr *= 1.0 - 0.35 * cov;
        }
        float F = fresnelDielectric(-dot(d, nb), uIorWater, N_GLASS);
        thr *= 1.0 - F;
        d = refract(d, nb, uIorWater / N_GLASS);
        med = M_GLASS;
      }
    }

    else if (med == M_AIR) {
      vec2 ci = cylHit(p, d, R_IN);
      float tWall = ci.y > 1e-6 ? ci.y : 1e9;
      float tTopC = d.y > 0.0 ? (CUP_H - p.y) / d.y : 1e9;
      float tEnd = min(tWall, tTopC);
      float tS = marchSurface(p, d, 1e-6, tEnd, 1.0);
      int ev = tWall < tTopC ? 0 : 1;
      if (tS > 0.0 && tS < tEnd) { tEnd = tS; ev = 2; }
      float tb; int bi;
      if (traceBalls(p, d, tEnd, tb, bi)) {
        col += thr * ballColor(bi, p + d * tb, d, 0.0);
        thr = vec3(0.0);
        break;
      }
      p += d * tEnd;
      if (ev == 2) {
        float ice;
        vec3 ns = surfNormal(p.xz, ice);
        if (ice > 0.02) ns = normalize(ns + (texture(uNoise3, p * 120.0).rgb - 0.5) * 0.35 * ice);
        float nw = mix(uIorWater, 1.309, ice);
        float F = fresnelDielectric(-dot(d, ns), 1.0, nw);
        vec3 rdir = reflect(d, ns);
        col += thr * F * envLod(rdir, ice * 3.0);
        thr *= 1.0 - F;
        // ice sheet: crystalline, frosted skin that grows from the rim inward
        float frost = ice * (0.1 + 0.55 * smoothstep(-1.0, -12.0, uTopT));
        float front = ice * (1.0 - ice) * 4.0;
        float needles = smoothstep(0.6, 0.9, vnoise(vec2(atan(p.z, p.x) * 60.0, length(p.xz) * 900.0)));
        float skin = clamp(frost + front * (0.25 + 0.5 * needles), 0.0, 0.9);
        col += thr * skin * (envDiffuse(vec3(0.0, 1.0, 0.0)) * 0.9 + uLightColor * max(0.0, uLightDir.y) * 0.25 * causticAt(p));
        thr *= 1.0 - skin;
        d = refract(d, ns, 1.0 / nw);
        p += d * 1e-5;
        med = M_WATER;
      } else if (ev == 0) {
        vec3 ni = -vec3(p.x, 0.0, p.z) / R_IN;
        float u = atan(p.z, p.x) / TAU;
        float fogIn = texture(uCond, vec2(u, p.y / CUP_H)).a;
        col += thr * fogIn * envDiffuse(ni) * 0.55;
        thr *= 1.0 - fogIn * 0.65;
        float F = fresnelDielectric(-dot(d, ni), 1.0, N_GLASS);
        col += thr * F * envLod(reflect(d, ni), 0.5) * 0.5;
        thr *= 1.0 - F;
        d = refract(d, ni, 1.0 / N_GLASS);
        med = M_GLASS;
      } else {
        med = M_OUT;
      }
    }

    else {
      float tb; int bi;
      if (traceBalls(p, d, 1e9, tb, bi)) col += thr * ballColor(bi, p + d * tb, d, 0.0);
      else col += deferBackground(p, d, thr);
      break;
    }
    // light trapped in the wall (light-guiding by TIR) eventually leaks out diffusely
    if (it == 13) col += thr * envDiffuse(d) * 0.6;
  }
  return col;
}
