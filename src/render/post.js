import * as THREE from 'three';
import { FullscreenPass, shaderMaterial, makeTarget } from './fsquad.js';

// HDR post chain: dual-filter bloom, ACES filmic tone mapping, vignette and film grain.
// An optional inset shows a simulation texture for debugging and for the report.

const DOWN = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  c /= 8.0;
  if (uThreshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(uThreshold, uThreshold * 2.5, l);
  }
  fragColor = vec4(c, 1.0);
}
`;

const UP = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUv + vec2(-2.0, 0.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(2.0, 0.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(0.0, -2.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(0.0, 2.0) * uTexel).rgb;
  c += texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb * 2.0;
  c += texture(uSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb * 2.0;
  fragColor = vec4(c / 12.0 + texture(uBase, vUv).rgb, 1.0);
}
`;

const FINAL = /* glsl */`
precision highp float;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uBloomStrength, uExposure, uTime;
uniform sampler2D uDebug;
uniform int uDebugMode;
uniform vec4 uDebugRect;
uniform vec2 uRes;
in vec2 vUv;
out vec4 fragColor;

vec3 aces(vec3 x) {
  // ACES fitted (Stephen Hill)
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = IN * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(OUT * (a / b), 0.0, 1.0);
}
vec3 srgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 debugColor(vec2 uv) {
  vec4 t = texture(uDebug, uv);
  if (uDebugMode == 1) { float h = t.r; return vec3(max(h, 0.0), abs(h) * 0.15, max(-h, 0.0)) * 0.6 + vec3(t.a * 0.5); }
  if (uDebugMode == 2) { float T = t.g; vec3 c = mix(vec3(0.1, 0.3, 1.0), vec3(1.0, 0.25, 0.05), clamp((T + 20.0) / 130.0, 0.0, 1.0)); return mix(c, vec3(1.0), t.r * 0.7) + vec3(t.b * 0.15); }
  if (uDebugMode == 3) return vec3(t.r * 0.8, t.g, t.b * 0.5) + vec3(0.0, 0.0, t.a);
  if (uDebugMode == 4) return t.rgb * 0.5;
  return t.rgb;
}

void main() {
  vec3 c = texture(uHdr, vUv).rgb + texture(uBloom, vUv).rgb * uBloomStrength;
  c = aces(c * uExposure);
  vec2 q = vUv - 0.5;
  c *= mix(1.0, 0.72, smoothstep(0.25, 0.85, dot(q, q) * 2.2));
  c = srgb(c);
  c += (h12(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.012;
  if (uDebugMode > 0) {
    vec2 p = gl_FragCoord.xy / uRes;
    vec2 d = (p - uDebugRect.xy) / uDebugRect.zw;
    if (all(greaterThan(d, vec2(0.0))) && all(lessThan(d, vec2(1.0)))) {
      c = srgb(clamp(debugColor(d), 0.0, 1.0));
      if (any(lessThan(d, vec2(0.004))) || any(greaterThan(d, vec2(0.996)))) c = vec3(0.8);
    }
  }
  fragColor = vec4(c, 1.0);
}
`;

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.levels = [];
    this.down = new FullscreenPass(shaderMaterial({
      fragmentShader: DOWN,
      uniforms: { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } },
    }));
    this.up = new FullscreenPass(shaderMaterial({
      fragmentShader: UP,
      uniforms: { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() } },
    }));
    this.final = new FullscreenPass(shaderMaterial({
      fragmentShader: FINAL,
      uniforms: {
        uHdr: { value: null }, uBloom: { value: null }, uBloomStrength: { value: 0.22 }, uExposure: { value: 1.0 },
        uTime: { value: 0 }, uDebug: { value: null }, uDebugMode: { value: 0 },
        uDebugRect: { value: new THREE.Vector4(0.015, 0.03, 0.24, 0.24) }, uRes: { value: new THREE.Vector2() },
      },
    }));
    this.bloomStrength = 0.22;
  }

  resize(w, h) {
    for (const l of this.levels) { l.down.dispose(); l.up.dispose(); }
    this.levels = [];
    let lw = w, lh = h;
    for (let i = 0; i < 6; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      this.levels.push({ w: lw, h: lh, down: makeTarget(lw, lh), up: makeTarget(lw, lh) });
    }
    this.final.material.uniforms.uRes.value.set(w, h);
  }

  render(hdrTex, srcW, srcH, time, debugTex, debugMode, aspect) {
    const r = this.renderer;
    const du = this.down.material.uniforms;
    let src = hdrTex, sw = srcW, sh = srcH;
    for (let i = 0; i < this.levels.length; i++) {
      const L = this.levels[i];
      du.uSrc.value = src;
      du.uTexel.value.set(1 / sw, 1 / sh);
      du.uThreshold.value = i === 0 ? 0.9 : 0;
      this.down.render(r, L.down);
      src = L.down.texture; sw = L.w; sh = L.h;
    }
    const uu = this.up.material.uniforms;
    let acc = this.levels[this.levels.length - 1].down.texture;
    for (let i = this.levels.length - 2; i >= 0; i--) {
      const L = this.levels[i], S = this.levels[i + 1];
      uu.uSrc.value = acc;
      uu.uBase.value = L.down.texture;
      uu.uTexel.value.set(1 / S.w, 1 / S.h);
      this.up.render(r, L.up);
      acc = L.up.texture;
    }
    const fu = this.final.material.uniforms;
    fu.uHdr.value = hdrTex;
    fu.uBloom.value = acc;
    fu.uBloomStrength.value = this.bloomStrength;
    fu.uTime.value = time;
    fu.uDebug.value = debugTex;
    fu.uDebugMode.value = debugTex ? debugMode : 0;
    const s = 0.3;
    fu.uDebugRect.value.set(0.015, 0.04, s / aspect, s);
    this.final.render(r, null);
  }
}
