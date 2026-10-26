/* GO/VOID — GLSL ES 3.00 shader sources. */

const NOISE = `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2(17.7, -9.2);
    amp *= 0.5;
  }
  return sum;
}
`;

export const BACKGROUND_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const BACKGROUND_FS = `#version 300 es
precision highp float;
${NOISE}
in vec2 vUv;
out vec4 fragColor;
uniform float uTime;
uniform float uAspect;
uniform float uImpact;
uniform vec3 uImpactColor;
uniform float uGame;
uniform float uReduced;

void main() {
  vec2 uv = vUv;
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
  float t = uTime * 0.02;

  vec2 p = q * vec2(1.2, 1.0);
  vec2 warp = vec2(
    fbm(p * 1.35 + vec2(t * 2.2, -t)),
    fbm(p * 1.35 + vec2(4.7 + t, 2.3 - t))
  );
  float n = fbm(p * 2.15 + warp * 1.55 + vec2(-t, t * 0.7));
  float fil = fbm(p * 4.2 + warp * 2.2 + vec2(t * 1.8, 0.0));
  float edge = smoothstep(0.18, 0.92, length(q * vec2(0.72, 0.88)));
  float cloud = smoothstep(0.34, 0.94, n) * 0.55 + smoothstep(0.52, 0.98, fil) * 0.22;
  cloud *= mix(0.18, 1.0, edge);

  vec3 col = vec3(0.0016, 0.0015, 0.0045);
  vec3 violet = vec3(0.062, 0.011, 0.145);
  vec3 teal = vec3(0.004, 0.045, 0.07);
  col += violet * cloud;
  col += teal * smoothstep(0.42, 0.95, fil) * (0.4 + 0.3 * sin(p.x * 2.0 + n * 5.0 + t * 2.0));

  // A distant event horizon behind the board.
  float r = length(q * vec2(0.94, 1.16));
  float halo = exp(-pow((r - 0.18) / 0.30, 2.0));
  col += vec3(0.055, 0.008, 0.11) * halo * (0.32 + 0.12 * sin(t * 3.0));
  // A couple of faint aurora ribbons, kept away from the centre.
  float ribbon = pow(max(0.0, sin(q.x * 3.1 + q.y * 2.2 + fbm(p * 2.2) * 4.2 + t * 2.0)), 9.0);
  ribbon *= smoothstep(0.08, 0.55, abs(q.x));
  col += vec3(0.022, 0.085, 0.13) * ribbon * 0.5;

  // Stars, two layers with a slow twinkle.
  vec2 sp = uv * vec2(uAspect, 1.0);
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 92.0 : 182.0;
    vec2 g = sp * scale;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(id + float(layer) * 17.3);
    float star = step(0.9905, h) * smoothstep(0.055, 0.0, length(f));
    float flare = step(0.9975, h) * smoothstep(0.20, 0.0, length(f)) * 0.28;
    float tw = 0.55 + 0.45 * sin(uTime * (1.0 + h * 2.4) + h * 40.0);
    vec3 tint = mix(vec3(0.55, 0.72, 1.0), vec3(1.0, 0.72, 0.9), hash21(id + 4.1));
    col += tint * (star * tw * 1.55 + flare) * (layer == 0 ? 1.0 : 0.45) * (1.0 - uReduced * 0.35);
  }

  float vig = smoothstep(1.5, 0.18, length(q * vec2(0.92, 1.0)));
  col *= 0.16 + 0.84 * vig;
  col += uImpactColor * uImpact * 0.045 * exp(-r * 1.8);

  // Keep the middle of the screen dark so the board and interface read cleanly.
  float centerMask = exp(-dot(q * vec2(1.0, 1.25), q * vec2(1.0, 1.25)) * 3.6);
  col *= 1.0 - centerMask * (uGame > 0.5 ? 0.38 : 0.24);

  fragColor = vec4(col, 1.0);
}
`;

export const SLAB_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vLocal;
out vec2 vUv;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vLocal = aPos;
  vUv = aUv;
  gl_Position = uViewProj * world;
}
`;

export const SLAB_FS = `#version 300 es
precision highp float;
${NOISE}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vLocal;
in vec2 vUv;
out vec4 fragColor;
uniform float uTime;
uniform vec3 uCameraPos;
uniform vec3 uAccent;
uniform float uHalf;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorld);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.2);
  float top = smoothstep(0.5, 0.95, N.y);
  float side = 1.0 - top;

  vec3 base = mix(vec3(0.006, 0.006, 0.016), vec3(0.016, 0.015, 0.035), top);
  float grain = fbm(vLocal.xz * 8.0 + 3.0) * 0.018;
  base += grain * (0.4 + top);

  // Top edge of the slab catches the rim lights.
  float topEdge = smoothstep(0.24, 0.0, abs(vLocal.y + 0.015));
  float edgeWave = 0.55 + 0.45 * sin(vLocal.x * 2.4 + vLocal.z * 1.7 + uTime * 0.5);
  vec3 edgeCol = mix(uAccent, vec3(1.0, 0.22, 0.62), 0.38 + 0.3 * sin(vLocal.x * 0.5 - vLocal.z * 0.3));
  base += edgeCol * topEdge * (0.35 + 0.3 * edgeWave) * side;

  // Faint circuitry etched into the sides.
  float lineX = smoothstep(0.02, 0.0, abs(fract(vLocal.x * 2.0 + 0.5) - 0.5) - 0.46);
  float lineZ = smoothstep(0.02, 0.0, abs(fract(vLocal.z * 2.0 + 0.5) - 0.5) - 0.46);
  float circuit = max(lineX, lineZ) * smoothstep(0.08, -0.28, vLocal.y) * side;
  base += uAccent * circuit * 0.035;

  vec3 key = normalize(vec3(-0.35, 0.9, 0.4));
  float diff = max(dot(N, key), 0.0);
  base += vec3(0.05, 0.045, 0.10) * diff * (0.25 + top * 0.4);
  base += uAccent * fres * 0.16 + vec3(1.0, 0.2, 0.6) * fres * 0.05;
  base *= 1.0 - side * 0.28;

  fragColor = vec4(base, 1.0);
}
`;

export const BOARD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vLocal;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vLocal = aPos.xz;
  gl_Position = uViewProj * world;
}
`;

export const BOARD_FS = `#version 300 es
precision highp float;
${NOISE}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vLocal;
out vec4 fragColor;
uniform float uTime;
uniform float uHalf;
uniform vec3 uCameraPos;
uniform vec2 uHover;
uniform float uHoverStrength;
uniform vec2 uLast;
uniform vec3 uHoverColor;
uniform float uScoring;
uniform vec2 uStars[9];
uniform int uStarCount;
uniform vec3 uAccent;

float gridMask(vec2 g, float width) {
  vec2 f = abs(fract(g + 0.5) - 0.5);
  vec2 w = fwidth(g);
  vec2 a = 1.0 - smoothstep(vec2(width), vec2(width) + w * 1.35, f);
  return max(a.x, a.y);
}

void main() {
  vec3 V = normalize(uCameraPos - vWorld);
  vec2 g = vLocal + uHalf;
  float r = length(vLocal / max(uHalf, 0.001));
  float grain = fbm(vLocal * 5.4 + 11.0);

  vec3 base = mix(vec3(0.020, 0.018, 0.040), vec3(0.0045, 0.005, 0.014), smoothstep(0.05, 1.1, r));
  base += vec3(0.028, 0.008, 0.05) * pow(grain, 2.0) * 0.55;
  float sheen = pow(max(dot(reflect(-V, normalize(vNormal)), normalize(vec3(-0.3, 0.9, 0.4))), 0.0), 14.0);
  base += vec3(0.06, 0.06, 0.11) * sheen * 0.18;

  vec3 lineCol = mix(vec3(0.26, 0.42, 0.55), vec3(0.48, 0.76, 0.92), 0.55);
  float lines = gridMask(g, 0.026);
  // Grid fades out where it runs past the edge of the playing surface.
  float inner = smoothstep(0.0, 0.08, min(g.x, g.y)) * smoothstep(0.0, 0.08, min(float(uHalf) * 2.0 - g.x, float(uHalf) * 2.0 - g.y));
  inner = smoothstep(0.0, 0.03, min(min(g.x, g.y), min(float(uHalf) * 2.0 - g.x, float(uHalf) * 2.0 - g.y)) + 0.02);
  vec3 col = base + lineCol * lines * 0.38 * max(inner, 0.35);

  // Star points glow softly, with a hot core.
  for (int i = 0; i < 9; i++) {
    if (i >= uStarCount) break;
    float d = length(g - uStars[i]);
    float core = smoothstep(0.10, 0.015, d);
    float glow = exp(-d * d * 36.0);
    col += mix(uAccent, vec3(1.0), 0.7) * (core * 0.95 + glow * 0.65);
  }

  // Outer frame etched into the slab.
  float frameDist = abs(max(abs(vLocal.x), abs(vLocal.y)) - (uHalf + 0.42));
  float frame = smoothstep(0.024, 0.0, frameDist);
  col += lineCol * frame * 0.18;
  float frameGlow = exp(-frameDist * 18.0) * 0.06;
  col += uAccent * frameGlow;

  // Last move: a slow ember beneath the stone.
  vec2 lastDelta = g - uLast;
  float lastGlow = exp(-dot(lastDelta, lastDelta) * 3.2);
  col += uHoverColor * lastGlow * 0.11;

  // Hover intersection reticle.
  float hoverD = length(g - uHover);
  float reticle = smoothstep(0.035, 0.0, abs(hoverD - 0.31)) * 0.5;
  reticle += smoothstep(0.12, 0.0, hoverD) * 0.12;
  col += uHoverColor * reticle * uHoverStrength;

  // In scoring, tint the whole surface a little colder.
  col = mix(col, col * vec3(0.8, 0.9, 1.15), uScoring * 0.5);

  fragColor = vec4(col, 1.0);
}
`;

export const GLOW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const GLOW_FS = `#version 300 es
precision highp float;
${NOISE}
in vec2 vUv;
out vec4 fragColor;
uniform float uTime;
uniform vec3 uAccent;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float glow = exp(-r * r * 4.6);
  float n = fbm(p * 2.6 + vec2(uTime * 0.03, -uTime * 0.02));
  float ribbon = pow(max(0.0, sin(atan(p.y, p.x) * 3.0 + r * 7.0 - uTime * 0.35)), 10.0);
  vec3 col = mix(uAccent, vec3(1.0, 0.2, 0.55), 0.42) * glow * (0.08 + ribbon * 0.035);
  col += vec3(0.03, 0.07, 0.14) * glow * n * 0.10;
  float alpha = smoothstep(1.0, 0.1, r) * 0.55;
  fragColor = vec4(col, alpha);
}
`;

export const STONE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 3) in vec3 aInstPos;
layout(location = 4) in float aInstScale;
layout(location = 5) in vec3 aInstColor;
layout(location = 6) in vec4 aInstParams;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out vec4 vParams;
void main() {
  vec3 local = aPos * vec3(0.46, 0.18, 0.46) * aInstScale;
  vec3 world = local + aInstPos;
  vNormal = normalize(aNormal / vec3(0.46, 0.18, 0.46));
  vWorld = world;
  vColor = aInstColor;
  vParams = aInstParams;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const STONE_FS = `#version 300 es
precision highp float;
${NOISE}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in vec4 vParams;
out vec4 fragColor;
uniform vec3 uCameraPos;
uniform float uTime;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorld);
  vec3 L1 = normalize(vec3(-0.42, 0.92, 0.44));
  vec3 L2 = normalize(vec3(0.62, 0.38, -0.5));
  vec3 L3 = normalize(vec3(-0.15, 0.5, -0.85));

  float alpha = vParams.x;
  float flash = vParams.y;
  float seed = vParams.z;
  float danger = vParams.w;

  float lum = dot(vColor, vec3(0.299, 0.587, 0.114));
  float white = smoothstep(0.28, 0.66, lum);

  float ndl = max(dot(N, L1), 0.0);
  float fill = max(dot(N, L2), 0.0);
  float back = max(dot(N, L3), 0.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.4);
  vec3 H = normalize(L1 + V);
  float spec = pow(max(dot(N, H), 0.0), mix(110.0, 64.0, white));
  vec3 H2 = normalize(L2 + V);
  float spec2 = pow(max(dot(N, H2), 0.0), 38.0);

  // Layered glass/marble veins.
  float ang = atan(vWorld.z - 0.0001, vWorld.x);
  float swirl = fbm(vec2(ang * 2.4 + seed * 9.0, vWorld.y * 11.0 + seed * 3.0) + uTime * 0.015);
  float veins = smoothstep(0.53, 0.78, swirl);

  vec3 blackStone = vec3(0.0045, 0.0045, 0.009);
  blackStone += vec3(0.026, 0.022, 0.07) * ndl * 0.6;
  blackStone += vec3(0.10, 0.035, 0.26) * veins * 0.18;
  blackStone += vec3(0.30, 0.50, 0.85) * fres * 0.42;
  blackStone += vec3(0.95, 0.94, 1.0) * spec * 0.95;
  blackStone += vec3(0.72, 0.32, 1.0) * spec2 * 0.22;
  blackStone += vec3(0.035, 0.055, 0.12) * back * 0.32;

  vec3 whiteStone = vec3(0.46, 0.54, 0.65);
  whiteStone += vec3(0.17, 0.19, 0.25) * ndl;
  whiteStone += vec3(0.12, 0.32, 0.38) * fill * 0.20;
  whiteStone += vec3(0.12, 0.45, 0.52) * veins * 0.12;
  whiteStone += vec3(0.55, 0.88, 0.98) * fres * 0.30;
  whiteStone += vec3(1.0) * spec * 0.95;
  whiteStone += vec3(0.35, 0.8, 1.0) * spec2 * 0.24;
  whiteStone += vec3(0.40, 0.55, 0.78) * back * 0.14;

  vec3 col = mix(blackStone, whiteStone, white);
  // Directional shading keeps the flattened sphere reading as a volume.
  float shade = mix(0.62 + 0.5 * ndl, 0.58 + 0.58 * ndl, white);
  col *= shade;
  // Ambient occlusion towards the board and a touch of contact shading.
  col *= 0.68 + 0.32 * smoothstep(-0.75, 0.5, N.y);

  // Placement flash, atari pulse and dead-stone tint.
  col += mix(vec3(0.55, 0.95, 1.0), vec3(1.0, 0.85, 0.6), white) * flash * 1.5;
  float pulse = 0.5 + 0.5 * sin(uTime * 7.5 + seed * 24.0);
  col += vec3(1.0, 0.06, 0.18) * danger * fres * (0.7 + pulse * 0.8);
  col = mix(col, col * vec3(0.45, 0.28, 0.34), clamp(danger * 0.28, 0.0, 0.4));

  fragColor = vec4(col, alpha);
}
`;

export const SHADOW_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 3) in vec3 aInstPos;
layout(location = 4) in float aInstScale;
uniform mat4 uViewProj;
out vec2 vUv;
out float vScale;
void main() {
  vUv = aPos;
  vScale = aInstScale;
  vec3 p = vec3(aInstPos.x + aPos.x * 0.58 * aInstScale, 0.004, aInstPos.z + aPos.y * 0.58 * aInstScale);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float r = length(vUv);
  float a = smoothstep(1.0, 0.1, r);
  a = pow(a, 1.8) * 0.5;
  fragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

export const MARKER_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 3) in vec3 aInstPos;
layout(location = 4) in vec3 aInstColor;
layout(location = 5) in vec4 aInstParams;
uniform mat4 uViewProj;
out vec2 vUv;
out vec3 vColor;
out vec4 vParams;
void main() {
  vUv = aPos;
  vColor = aInstColor;
  vParams = aInstParams;
  vec3 p = vec3(aInstPos.x + aPos.x * aInstParams.x, aInstPos.y, aInstPos.z + aPos.y * aInstParams.x);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const MARKER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
in vec4 vParams;
out vec4 fragColor;
uniform float uTime;
void main() {
  float alpha = vParams.y;
  float style = vParams.z;
  float seed = vParams.w;
  float r = length(vUv);
  float a = 0.0;
  float glow = 0.0;
  if (style < 0.5) {
    // Last-move ring with rotating corner ticks.
    float band = smoothstep(0.045, 0.0, abs(r - 0.7));
    float ang = atan(vUv.y, vUv.x);
    float ticks = pow(max(0.0, cos(ang * 4.0 + uTime * 1.6 + seed)), 18.0);
    a = band * 0.8 + ticks * smoothstep(0.9, 0.45, r) * 0.18;
    glow = exp(-pow((r - 0.7) * 11.0, 2.0)) * 0.6;
  } else if (style < 1.5) {
    // Expanding shockwave.
    float ringR = mix(0.2, 1.0, clamp(alpha, 0.0, 1.0));
    float band = smoothstep(0.09, 0.0, abs(r - 0.88));
    a = band * (1.0 - alpha) * 0.9;
    glow = exp(-r * 2.4) * (1.0 - alpha) * 0.25;
  } else if (style < 2.5) {
    // Atari / danger halo.
    float band = smoothstep(0.08, 0.0, abs(r - 0.76));
    a = band * (0.55 + 0.35 * sin(uTime * 8.0 + seed * 12.0));
  } else {
    // Soft point marker for scoring.
    a = smoothstep(0.55, 0.0, r) * 0.5;
    glow = exp(-r * r * 8.0) * 0.6;
  }
  vec3 col = vColor * (a + glow);
  fragColor = vec4(col, a);
}
`;

export const PARTICLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aSize;
layout(location = 2) in vec3 aColor;
layout(location = 3) in float aAlpha;
uniform mat4 uViewProj;
uniform float uPixelScale;
out vec3 vColor;
out float vAlpha;
void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  gl_PointSize = clamp(aSize * uPixelScale / max(clip.w, 0.15), 1.0, 72.0);
  vColor = aColor;
  vAlpha = aAlpha;
}
`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p) * 2.0;
  float core = smoothstep(0.34, 0.0, d);
  float halo = exp(-d * d * 4.0) * (1.0 - d);
  vec3 col = vColor * (core + halo * 0.65);
  float a = (core * 0.9 + halo * 0.5) * vAlpha;
  fragColor = vec4(col, a);
}
`;

export const BRIGHT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold;

void main() {
  vec3 c = texture(uScene, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture(uScene, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture(uScene, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture(uScene, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float lum = max(c.r, max(c.g, c.b));
  float knee = max(0.0, lum - uThreshold);
  vec3 result = c * (knee / max(lum, 0.0001));
  fragColor = vec4(result, 1.0);
}
`;

export const BLUR_VS = BRIGHT_VS;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform vec2 uDirection;

void main() {
  vec2 step = uTexel * uDirection;
  vec3 c = texture(uImage, vUv).rgb * 0.227027;
  c += texture(uImage, vUv + step * 1.384615).rgb * 0.316216;
  c += texture(uImage, vUv - step * 1.384615).rgb * 0.316216;
  c += texture(uImage, vUv + step * 3.230769).rgb * 0.070270;
  c += texture(uImage, vUv - step * 3.230769).rgb * 0.070270;
  fragColor = vec4(c, 1.0);
}
`;

export const COMPOSITE_VS = BRIGHT_VS;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uTime;
uniform float uBloomStrength;
uniform float uImpact;
uniform vec2 uImpactCenter;
uniform float uFlash;
uniform float uMotion;
uniform int uScoring;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  vec2 centerDelta = uv - uImpactCenter;
  float centerDist = length(centerDelta);

  // Shockwave toward/away from the impact point.
  float wave = sin(centerDist * 75.0 - uTime * 14.0) * exp(-centerDist * 9.0) * uImpact;
  uv += normalize(centerDelta + vec2(0.00001)) * wave * 0.0045;

  vec2 chroma = centerDelta * (0.0012 + uImpact * 0.0035) * (0.35 + dot(centerDelta, centerDelta) * 2.4);
  vec3 col;
  col.r = texture(uScene, uv + chroma).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - chroma).b;

  vec3 bloom = texture(uBloom, uv).rgb;
  col += bloom * uBloomStrength;

  // Slight cold lift and warm highlights.
  col += vec3(0.004, 0.003, 0.012);
  col = pow(max(col, 0.0), vec3(0.94));
  col = aces(col);

  float vignette = smoothstep(1.35, 0.34, length((vUv - 0.5) * vec2(1.05, 1.0)));
  col *= 0.32 + 0.68 * vignette;

  if (uMotion == 1.0) {
    float grain = (hash(vUv * uResolution + fract(uTime) * 131.7) - 0.5) * 0.022;
    col += grain;
    float scan = 0.988 + 0.012 * sin(vUv.y * uResolution.y * 1.35);
    col *= scan;
  }

  // Impact frames: a hot ring and a kiss of inversion at the epicenter.
  float shockRing = smoothstep(0.02, 0.0, abs(centerDist - 0.18 - (1.0 - uImpact) * 0.2)) * uImpact;
  col += vec3(0.4, 0.95, 1.0) * shockRing * 0.22;
  col = mix(col, vec3(1.0) - col, uImpact * 0.045 * exp(-centerDist * 5.0));

  col += vec3(0.7, 0.95, 1.0) * uFlash;
  col = mix(col, col * vec3(0.9, 0.95, 1.12), uScoring == 1 ? 0.3 : 0.0);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const STONE_MESH = { rings: 22, segments: 28 };
