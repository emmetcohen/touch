/* =====================================================================
 * TOP FX – a tiny TouchDesigner-style TOP (texture operator) chain in WebGL2
 *
 * Layout of this file
 *   1. Helpers
 *   2. WebGL core: shader prelude, programs, render targets, env.run()
 *   3. EFFECT LIBRARY  <-- add / tweak effects here (one entry per effect)
 *   4. Pipeline: source -> effect 1 -> effect 2 -> ... -> canvas
 *   5. Source loading (image / video), audio graph
 *   6. UI: effect cards, controls, gradient editor
 *   7. Presets (built-in + JSON save/load)
 *   8. Export (PNG / WebM)
 *   9. Main loop + wiring
 *
 * HOW AN EFFECT IS DEFINED
 *   EFFECTS.myfx = {
 *     label:  'My Effect',
 *     params: [ {key:'amount', label:'Amount', type:'range', min:0, max:1, step:.01, def:.5}, ... ],
 *     frag:   `uniform float u_amount;                 // every param 'key' becomes uniform 'u_<key>'
 *              vec4 effect(vec2 uv){ return texture(u_tex, uv) * u_amount; }`,
 *   };
 *   • 'frag' is a single-pass shader. `effect(uv)` returns the new colour for a pixel.
 *     Available for free: u_tex (input image), u_res (size in px), u_time (seconds),
 *     u_px (1.0 at 1080p height – multiply pixel sizes by it so preview == export),
 *     plus the helper functions in PRELUDE (luma, rgb2hsv, hsv2rgb, hash13, vnoise, mirrorUV).
 *   • Effects that need several passes or memory (blur, bloom, feedback, cache) instead
 *     supply `render(env, inst, input, output)` and call env.run(...) themselves.
 *   Param types: range | toggle | select | color | gradient | button | note
 * ===================================================================== */
(() => {
'use strict';

/* ---------------------------------------------------------------------
 * 1. HELPERS
 * ------------------------------------------------------------------- */
const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clone = o => JSON.parse(JSON.stringify(o));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function fmtNum(v, step) {
  const d = step >= 1 ? 0 : Math.min(4, (String(step).split('.')[1] || '').length);
  return Number(v).toFixed(d);
}
function fmtTime(t) {
  if (!isFinite(t)) return '–:––';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function toast(msg, kind = 'info', ms = 4500) {
  const t = el('div', 'toast' + (kind === 'error' ? ' error' : ''), msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function download(blob, name) {
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------------------------------------------------------------------
 * 2. WEBGL CORE
 * ------------------------------------------------------------------- */
const canvas = $('#glcanvas');
const gl = canvas.getContext('webgl2', {
  alpha: true, premultipliedAlpha: false,   // straight alpha so exported PNGs keep transparency
  preserveDrawingBuffer: true,              // lets toBlob() read the canvas after rendering
  antialias: false, depth: false, stencil: false,
});
if (!gl) {
  document.body.innerHTML = '<div style="padding:40px;font:16px system-ui;color:#eee">' +
    'This tool needs WebGL2, which your browser or GPU does not seem to support. ' +
    'Try a recent Chrome, Edge, Firefox or Safari.</div>';
  throw new Error('WebGL2 unavailable');
}
// Half-float render targets keep precision through long effect chains / feedback loops.
gl.getExtension('EXT_color_buffer_float');
gl.getExtension('EXT_color_buffer_half_float');
gl.getExtension('OES_texture_float_linear');
const MAX_TEX = gl.getParameter(gl.MAX_TEXTURE_SIZE);
const EXPORT_CAP = Math.min(MAX_TEX, 8192);   // longest side allowed for full-size PNG export

const VERT = `#version 300 es
out vec2 v_uv;
void main(){
  // one oversized triangle that covers the screen (no vertex buffers needed)
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Everything prepended to every effect's fragment shader.
const PRELUDE = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;   // the input image (previous effect's output)
uniform vec2  u_res;       // output size in pixels
uniform float u_time;      // seconds
uniform float u_px;        // 1.0 at 1080p height. Multiply pixel-based sliders by this.
uniform float u_frame;     // frame counter

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
// cheap hash + smooth 3D value noise (z is usually time)
float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
// mirrored repeat: sampling outside 0..1 reflects instead of smearing the edge pixels
vec2 mirrorUV(vec2 uv){ return 1.0 - abs(1.0 - mod(uv, 2.0)); }
`;
const MAIN = '\nvoid main(){ outColor = effect(v_uv); }\n';

const programs = new Map();   // fragment source -> {p, locs}
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile error:\n' + log);
  }
  return s;
}
function getProgram(frag) {
  let prog = programs.get(frag);
  if (prog) { if (prog.error) throw new Error(prog.error); return prog; }
  try {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, PRELUDE + frag + MAIN));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link error:\n' + gl.getProgramInfoLog(p));
    prog = { p, locs: new Map() };
  } catch (e) {
    programs.set(frag, { error: e.message });   // remember failures so we don't recompile every frame
    throw e;
  }
  programs.set(frag, prog);
  return prog;
}
function loc(prog, name) {
  if (!prog.locs.has(name)) prog.locs.set(name, gl.getUniformLocation(prog.p, name));
  return prog.locs.get(name);
}
function setUniform(prog, name, v) {
  const l = loc(prog, name);
  if (l == null) return;   // uniform not used by this shader – fine
  if (typeof v === 'number') gl.uniform1f(l, v);
  else if (typeof v === 'boolean') gl.uniform1f(l, v ? 1 : 0);
  else if (Array.isArray(v)) {
    if (v.length === 2) gl.uniform2fv(l, v);
    else if (v.length === 3) gl.uniform3fv(l, v);
    else if (v.length === 4) gl.uniform4fv(l, v);
  } else if (v && v.f) gl.uniform1fv(l, v.f);        // float array
  else if (v && v.v3) gl.uniform3fv(l, v.v3);        // vec3 array
}

/* --- render targets --------------------------------------------------- */
function halfFloatWorks() {
  const t = createTarget(4, 4, true);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  deleteTarget(t);
  return ok;
}
function createTarget(w, h, half) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}
function deleteTarget(t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}
const HALF_OK = halfFloatWorks();

/* --- env: what effects use to draw ------------------------------------ */
const CANVAS_TARGET = { fbo: null, w: 0, h: 0 };
const env = {
  w: 0, h: 0, px: 1, time: 0, frame: 0, half: HALF_OK,
  ping: [null, null],   // the two main ping-pong buffers
  temps: [],            // scratch buffers for multi-pass effects (allocated on demand)
  pickT: null,

  /** i-th scratch render target, same size as the pipeline. */
  temp(i) { return this.temps[i] || (this.temps[i] = createTarget(this.w, this.h, this.half)); },

  /**
   * Run one fragment shader into `target`.
   *   texs:     { samplerName: Target | WebGLTexture | {tex, array:true} }
   *   uniforms: { name: number | boolean | [x,y(,z,w)] | {f: Float32Array} | {v3: Float32Array} }
   */
  run(frag, target, texs = {}, uniforms = {}) {
    const prog = getProgram(frag);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const name in texs) {
      const t = texs[name];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(t.array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, t.tex || t);
      gl.uniform1i(loc(prog, name), unit++);
    }
    setUniform(prog, 'u_res', [target.w, target.h]);
    setUniform(prog, 'u_time', this.time);
    setUniform(prog, 'u_px', this.px);
    setUniform(prog, 'u_frame', this.frame);
    for (const name in uniforms) setUniform(prog, name, uniforms[name]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },

  copy(src, dst) { this.run(COPY_FRAG, dst, { u_tex: src }); },

  /** Read one pixel (uv 0..1, origin bottom-left) of `src` as [r,g,b] 0..255. */
  pickPixel(src, u, v) {
    if (!this.pickT) this.pickT = createTarget(1, 1, false);
    this.run(`uniform vec2 u_pt; vec4 effect(vec2 uv){ return texture(u_tex, u_pt); }`,
      this.pickT, { u_tex: src }, { u_pt: [u, v] });
    const buf = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2]];
  },

  /** Turn an effect's params into u_<key> uniforms. */
  paramUniforms(def, params) {
    const u = {};
    for (const p of def.params) {
      const v = params[p.key];
      if (p.type === 'range' || p.type === 'toggle' || p.type === 'select') u['u_' + p.key] = +v;
      else if (p.type === 'color') u['u_' + p.key] = hexToRgb(v);
    }
    return def.extra ? Object.assign(u, def.extra(params, this)) : u;
  },
};
const COPY_FRAG = `vec4 effect(vec2 uv){ return texture(u_tex, uv); }`;

/* ---------------------------------------------------------------------
 * 3. EFFECT LIBRARY
 * ------------------------------------------------------------------- */
const R = (key, label, min, max, step, def, extra) => Object.assign({ key, label, type: 'range', min, max, step, def }, extra);
const T = (key, label, def, extra) => Object.assign({ key, label, type: 'toggle', def }, extra);
const S = (key, label, options, def, extra) => Object.assign({ key, label, type: 'select', options, def }, extra);
const C = (key, label, def, extra) => Object.assign({ key, label, type: 'color', def }, extra);

/* --- shared 2-pass separable gaussian ---------------------------------
 * Run once horizontally (u_dir=(1,0)) then once vertically (u_dir=(0,1)).
 * 33 taps; tap spacing grows with the radius so big radii stay cheap.
 * Colours are premultiplied by alpha while averaging so transparent
 * (chroma-keyed) areas don't bleed dark fringes. */
const BLUR_FRAG = `
uniform vec2 u_dir;
uniform float u_radius;   // in output pixels
vec4 effect(vec2 uv){
  if (u_radius < 0.05) return texture(u_tex, uv);
  const int N = 16;
  float sigma  = u_radius * 0.5;            // radius ~ 2 sigma
  float stepPx = max(1.0, sigma * 3.0 / float(N));   // taps reach ~3 sigma
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -N; i <= N; i++) {
    float d = float(i) * stepPx;
    float w = exp(-0.5 * d * d / (sigma * sigma));
    vec4 s = texture(u_tex, uv + u_dir * d / u_res);
    acc += vec4(s.rgb * s.a, s.a) * w;
    wsum += w;
  }
  acc /= wsum;
  return acc.a > 1e-4 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;
function blur2(env, src, dst, tmp, radius) {
  env.run(BLUR_FRAG, tmp, { u_tex: src }, { u_dir: [1, 0], u_radius: radius });
  env.run(BLUR_FRAG, dst, { u_tex: tmp }, { u_dir: [0, 1], u_radius: radius });
}

/* --- Lookup presets (max 4 stops each) --------------------------------- */
const LOOKUP_PRESETS = [
  { name: 'Thermal', stops: [{ p: 0, c: '#050035' }, { p: .33, c: '#a4127c' }, { p: .66, c: '#ff7a00' }, { p: 1, c: '#fff7b0' }] },
  { name: 'Duotone', stops: [{ p: 0, c: '#1a0b5c' }, { p: 1, c: '#ff5c93' }] },
  { name: 'Sunset',  stops: [{ p: 0, c: '#1a0b3b' }, { p: .4, c: '#c0392b' }, { p: .75, c: '#ff8c42' }, { p: 1, c: '#ffe9a8' }] },
  { name: 'Neon',    stops: [{ p: 0, c: '#05001a' }, { p: .35, c: '#ff00c8' }, { p: .7, c: '#00e5ff' }, { p: 1, c: '#ffffff' }] },
  { name: 'Ice',     stops: [{ p: 0, c: '#001a33' }, { p: .4, c: '#1e6fb8' }, { p: .75, c: '#8fd8ff' }, { p: 1, c: '#ffffff' }] },
  { name: 'Sepia',   stops: [{ p: 0, c: '#140b04' }, { p: .55, c: '#8c6239' }, { p: 1, c: '#f6e7c8' }] },
];
const LOOKUP_CUSTOM = LOOKUP_PRESETS.length;   // index of the "Custom" option

const EFFECTS = {

  /* 1 ─ LEVEL ───────────────────────────────────────────────────────── */
  level: {
    label: 'Level',
    params: [
      R('brightness', 'Brightness', -1, 1, .01, 0),
      R('contrast', 'Contrast', 0, 3, .01, 1),
      R('gamma', 'Gamma', .2, 3, .01, 1),
      R('exposure', 'Exposure (stops)', -3, 3, .01, 0),
    ],
    frag: `
uniform float u_brightness, u_contrast, u_gamma, u_exposure;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  vec3 rgb = c.rgb * exp2(u_exposure);              // exposure: multiply by 2^stops
  rgb += u_brightness;                              // brightness: add
  rgb = (rgb - 0.5) * u_contrast + 0.5;             // contrast: scale around mid-grey
  rgb = pow(max(rgb, 0.0), vec3(1.0 / max(u_gamma, 0.01)));   // gamma
  return vec4(rgb, c.a);
}`,
  },

  /* 2 ─ HSV ADJUST ──────────────────────────────────────────────────── */
  hsv: {
    label: 'HSV Adjust',
    params: [
      R('hue', 'Hue shift (°)', -180, 180, 1, 0),
      R('sat', 'Saturation', 0, 3, .01, 1),
      R('value', 'Value', 0, 3, .01, 1),
    ],
    frag: `
uniform float u_hue, u_sat, u_value;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  vec3 hsv = rgb2hsv(max(c.rgb, 0.0));
  hsv.x = fract(hsv.x + u_hue / 360.0);
  hsv.y = clamp(hsv.y * u_sat, 0.0, 1.0);
  hsv.z *= u_value;
  return vec4(hsv2rgb(hsv), c.a);
}`,
  },

  /* 3 ─ MONOCHROME ──────────────────────────────────────────────────── */
  mono: {
    label: 'Monochrome',
    params: [R('mix', 'Mix', 0, 1, .01, 1)],
    frag: `
uniform float u_mix;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  return vec4(mix(c.rgb, vec3(luma(c.rgb)), u_mix), c.a);
}`,
  },

  /* 4 ─ BLUR (two-pass gaussian) ────────────────────────────────────── */
  blur: {
    label: 'Blur',
    params: [R('radius', 'Radius (px)', 0, 100, .5, 8)],
    render(env, inst, inp, out) {
      blur2(env, inp, out, env.temp(0), inst.params.radius * env.px);
    },
  },

  /* 5 ─ LUMA BLUR ───────────────────────────────────────────────────── */
  // Blur amount is driven by the image's own brightness. We make a half-radius blur and a
  // full-radius blur, then pick between original -> half -> full according to a luma mask.
  lumablur: {
    label: 'Luma Blur',
    params: [
      R('radius', 'Max radius (px)', 0, 100, .5, 24),
      R('threshold', 'Threshold', 0, .95, .01, 0),
      T('invert', 'Invert (blur the darks)', false),
    ],
    render(env, inst, inp, out) {
      const p = inst.params, t0 = env.temp(0), half = env.temp(1), full = env.temp(2);
      blur2(env, inp, half, t0, p.radius * .5 * env.px);
      blur2(env, inp, full, t0, p.radius * env.px);
      env.run(`
uniform sampler2D u_half; uniform sampler2D u_full;
uniform float u_invert, u_threshold;
vec4 effect(vec2 uv){
  vec4 o = texture(u_tex, uv);
  float m = luma(o.rgb);
  if (u_invert > 0.5) m = 1.0 - m;
  m = clamp((m - u_threshold) / max(1.0 - u_threshold, 1e-3), 0.0, 1.0);   // below threshold => stays sharp
  vec4 h = texture(u_half, uv), f = texture(u_full, uv);
  return m < 0.5 ? mix(o, h, m * 2.0) : mix(h, f, (m - 0.5) * 2.0);
}`, out, { u_tex: inp, u_half: half, u_full: full }, { u_invert: p.invert, u_threshold: p.threshold });
    },
  },

  /* 6 ─ EDGE (Sobel) ────────────────────────────────────────────────── */
  edge: {
    label: 'Edge',
    params: [
      R('strength', 'Strength', 0, 10, .05, 1.5),
      R('threshold', 'Threshold', 0, 1, .01, .1),
      R('width', 'Line width', .5, 4, .1, 1),
      S('mode', 'Output', ['Lines only', 'Lines over original'], 0),
      C('color', 'Line color', '#ffffff'),
    ],
    frag: `
uniform float u_strength, u_threshold, u_width, u_mode;
uniform vec3 u_color;
vec4 effect(vec2 uv){
  vec2 t = u_width * max(u_px, 1.0) / u_res;        // one texel step
  float tl = luma(texture(u_tex, uv + vec2(-t.x,  t.y)).rgb);
  float  l = luma(texture(u_tex, uv + vec2(-t.x,  0.0)).rgb);
  float bl = luma(texture(u_tex, uv + vec2(-t.x, -t.y)).rgb);
  float  tt= luma(texture(u_tex, uv + vec2( 0.0,  t.y)).rgb);
  float  b = luma(texture(u_tex, uv + vec2( 0.0, -t.y)).rgb);
  float tr = luma(texture(u_tex, uv + vec2( t.x,  t.y)).rgb);
  float  r = luma(texture(u_tex, uv + vec2( t.x,  0.0)).rgb);
  float br = luma(texture(u_tex, uv + vec2( t.x, -t.y)).rgb);
  // Sobel kernels
  float gx = -tl - 2.0*l - bl + tr + 2.0*r + br;
  float gy = -tl - 2.0*tt - tr + bl + 2.0*b + br;
  float m = length(vec2(gx, gy)) * u_strength;
  float e = smoothstep(u_threshold, u_threshold + 0.1, m);
  vec4 c = texture(u_tex, uv);
  vec3 base = u_mode < 0.5 ? vec3(0.0) : c.rgb;
  return vec4(mix(base, u_color, e), c.a);
}`,
  },

  /* 7 ─ CONVOLVE ────────────────────────────────────────────────────── */
  convolve: {
    label: 'Convolve',
    params: [
      S('preset', 'Kernel', ['Sharpen', 'Emboss', 'Edge Enhance'], 0),
      R('amount', 'Amount', 0, 3, .05, 1),
    ],
    frag: `
uniform float u_preset, u_amount;
vec4 effect(vec2 uv){
  vec2 t = max(u_px, 1.0) / u_res;
  float k[9];
  if (u_preset < 0.5)      k = float[9]( 0.,-1., 0.,  -1., 5.,-1.,   0.,-1., 0.);   // sharpen
  else if (u_preset < 1.5) k = float[9](-2.,-1., 0.,  -1., 1., 1.,   0., 1., 2.);   // emboss
  else                     k = float[9](-1.,-1.,-1.,  -1., 9.,-1.,  -1.,-1.,-1.);   // edge enhance
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 3; j++)
    for (int i = 0; i < 3; i++)
      acc += texture(u_tex, uv + vec2(float(i - 1), float(1 - j)) * t).rgb * k[j * 3 + i];
  vec4 c = texture(u_tex, uv);
  if (u_preset > 0.5 && u_preset < 1.5) acc = vec3(luma(acc) + 0.5);   // emboss: grey relief
  return vec4(mix(c.rgb, acc, u_amount), c.a);
}`,
  },

  /* 8 ─ THRESHOLD / POSTERIZE ───────────────────────────────────────── */
  threshold: {
    label: 'Threshold',
    params: [
      S('mode', 'Mode', ['Black / White', 'Posterize'], 0),
      R('level', 'Level', 0, 1, .005, .5, { showIf: p => p.mode === 0 }),
      R('softness', 'Softness', 0, .25, .005, 0, { showIf: p => p.mode === 0 }),
      R('levels', 'Levels', 2, 8, 1, 4, { showIf: p => p.mode === 1 }),
    ],
    frag: `
uniform float u_mode, u_level, u_softness, u_levels;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  if (u_mode < 0.5) {
    float t = smoothstep(u_level - u_softness, u_level + u_softness + 1e-4, luma(c.rgb));
    return vec4(vec3(t), c.a);
  }
  // posterize each channel to N steps
  vec3 q = floor(clamp(c.rgb, 0.0, 0.9999) * u_levels) / (u_levels - 1.0);
  return vec4(q, c.a);
}`,
  },

  /* 9 ─ PIXELATE ────────────────────────────────────────────────────── */
  pixelate: {
    label: 'Pixelate',
    params: [R('size', 'Block size (px)', 1, 128, 1, 12)],
    frag: `
uniform float u_size;
vec4 effect(vec2 uv){
  float b = max(u_size * u_px, 1.0);
  vec2 cell = floor(uv * u_res / b) + 0.5;          // centre of the block this pixel belongs to
  return texture(u_tex, cell * b / u_res);
}`,
  },

  /* 10 ─ DISPLACE ───────────────────────────────────────────────────── */
  // Two animated noise fields (one for X, one for Y) push the sample position around.
  displace: {
    label: 'Displace',
    params: [
      R('amount', 'Amount', 0, .3, .001, .04),
      R('scale', 'Noise scale', .2, 20, .1, 3),
      R('speed', 'Noise speed', 0, 4, .01, .5),
      S('direction', 'Direction', ['X', 'Y', 'Both'], 2),
    ],
    frag: `
uniform float u_amount, u_scale, u_speed, u_direction;
float fbm(vec3 p){                                  // 3 octaves of value noise
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s / 0.875;
}
vec4 effect(vec2 uv){
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * u_scale;   // aspect-correct so noise isn't stretched
  float t = u_time * u_speed;
  vec2 n = vec2(fbm(vec3(p, t)), fbm(vec3(p + 37.7, t + 11.3))) - 0.5;   // -0.5..0.5
  vec2 d = n * 2.0 * u_amount;
  if (u_direction < 0.5) d.y = 0.0; else if (u_direction < 1.5) d.x = 0.0;
  return texture(u_tex, mirrorUV(uv + d));
}`,
  },

  /* 11 ─ RGB SPLIT / CHROMATIC ABERRATION ───────────────────────────── */
  rgbsplit: {
    label: 'RGB Split',
    params: [
      R('r', 'Red offset (px)', -60, 60, .5, 12),
      R('g', 'Green offset (px)', -60, 60, .5, 0),
      R('b', 'Blue offset (px)', -60, 60, .5, -12),
      R('angle', 'Angle (°)', 0, 360, 1, 0, { showIf: p => !p.radial }),
      T('radial', 'Radial (grows toward edges)', false),
    ],
    frag: `
uniform float u_r, u_g, u_b, u_angle, u_radial;
vec4 effect(vec2 uv){
  vec2 dir;
  if (u_radial > 0.5) dir = (uv - 0.5) * 2.0;       // vector from centre: 0 in the middle, ~1 at the edges
  else { float a = radians(u_angle); dir = vec2(cos(a), sin(a)); }
  vec2 o = dir * u_px / u_res;                      // 1 "px" in uv units, along dir
  vec4 cg = texture(u_tex, uv + o * u_g);
  float r = texture(u_tex, uv + o * u_r).r;
  float b = texture(u_tex, uv + o * u_b).b;
  return vec4(r, cg.g, b, cg.a);
}`,
  },

  /* 12 ─ LOOKUP (gradient map) ──────────────────────────────────────── */
  lookup: {
    label: 'Lookup (Color Map)',
    params: [
      S('preset', 'Preset', LOOKUP_PRESETS.map(p => p.name).concat('Custom'), 0, {
        onChange: p => { if (p.preset < LOOKUP_CUSTOM) p.stops = clone(LOOKUP_PRESETS[p.preset].stops); },
      }),
      { key: 'stops', label: 'Gradient', type: 'gradient', def: clone(LOOKUP_PRESETS[0].stops),
        linkKey: 'preset', linkValue: LOOKUP_CUSTOM },
      R('mix', 'Mix', 0, 1, .01, 1),
      T('invert', 'Invert brightness', false),
    ],
    afterLoad(params, incoming) {
      if (!Array.isArray(incoming.stops) && params.preset < LOOKUP_CUSTOM) params.stops = clone(LOOKUP_PRESETS[params.preset].stops);
    },
    // gradient stops -> sorted, padded uniform arrays
    extra(p) {
      const s = p.stops.slice().sort((a, b) => a.p - b.p).slice(0, 4);
      const pos = new Float32Array(4), col = new Float32Array(12);
      for (let i = 0; i < 4; i++) {
        const st = s[Math.min(i, s.length - 1)];
        pos[i] = st.p; col.set(hexToRgb(st.c), i * 3);
      }
      return { u_n: s.length, u_pos: { f: pos }, u_col: { v3: col } };
    },
    frag: `
uniform float u_n, u_mix, u_invert;
uniform float u_pos[4];
uniform vec3  u_col[4];
vec3 ramp(float t){
  int n = int(u_n + 0.5);
  if (t <= u_pos[0]) return u_col[0];
  vec3 c = u_col[n - 1];                            // past the last stop
  for (int i = 1; i < 4; i++) {
    if (i < n && t <= u_pos[i]) {
      float k = clamp((t - u_pos[i-1]) / max(u_pos[i] - u_pos[i-1], 1e-4), 0.0, 1.0);
      c = mix(u_col[i-1], u_col[i], k);
      break;
    }
  }
  return c;
}
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  float l = clamp(luma(c.rgb), 0.0, 1.0);
  if (u_invert > 0.5) l = 1.0 - l;
  return vec4(mix(c.rgb, ramp(l), u_mix), c.a);
}`,
  },

  /* 13 ─ CHROMA KEY ─────────────────────────────────────────────────── */
  // Compares chroma (Cb/Cr) only, so shadows on the green screen are still keyed out.
  // Background settings are read by the final display step (see bgSettings()).
  chroma: {
    label: 'Chroma Key',
    params: [
      C('key', 'Key color', '#00ff00'),
      { key: 'eye', type: 'button', label: '⌖ Pick color from preview', action: inst => startEyedrop(inst) },
      R('tolerance', 'Tolerance', 0, 1, .005, .25),
      R('softness', 'Softness', 0, .5, .005, .1),
      S('bg', 'Background', ['Checkerboard', 'Black', 'White', 'Green', 'Custom'], 0),
      C('bgColor', 'Background color', '#ff00ff', { showIf: p => p.bg === 4 }),
    ],
    render(env, inst, inp, out) {
      const st = inst.state;
      if (st.pick) {                                 // eyedropper request from the preview click
        const [r, g, b] = env.pickPixel(inp, st.pick.u, st.pick.v);
        st.pick = null;
        inst.params.key = rgbToHex(r, g, b);
        syncControls(inst);
      }
      env.run(this.shader, out, { u_tex: inp }, env.paramUniforms(this, inst.params));
    },
    shader: `
uniform vec3 u_key;
uniform float u_tolerance, u_softness;
vec2 cbcr(vec3 c){ return vec2(-0.169*c.r - 0.331*c.g + 0.5*c.b, 0.5*c.r - 0.419*c.g - 0.081*c.b); }
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  float d = distance(cbcr(c.rgb), cbcr(u_key));       // chroma distance to the key colour
  float a = smoothstep(u_tolerance, u_tolerance + max(u_softness, 1e-3), d);
  return vec4(c.rgb, c.a * a);
}`,
  },

  /* 14 ─ FEEDBACK ───────────────────────────────────────────────────── */
  // Each frame we blend the input with the *previous output of this effect*, transformed
  // (zoom / rotate / offset / hue-shift). Repeating that every frame makes tunnels and trails.
  feedback: {
    label: 'Feedback',
    stateful: true,
    params: [
      R('decay', 'Decay (trail amount)', 0, 1, .005, .85),
      R('zoom', 'Zoom', .9, 1.1, .001, 1.01),
      R('rot', 'Rotation (°/frame)', -15, 15, .1, 1),
      R('ox', 'Offset X', -.05, .05, .001, 0),
      R('oy', 'Offset Y', -.05, .05, .001, 0),
      R('hue', 'Hue shift per loop (°)', -30, 30, .5, 4),
      S('blend', 'Blend', ['Mix', 'Lighten', 'Add'], 0),
      { key: 'clear', type: 'button', label: 'Clear trails', action: inst => { inst.state.fresh = true; } },
    ],
    render(env, inst, inp, out) {
      const st = inst.state;
      if (!st.prev || st.prev.w !== env.w || st.prev.h !== env.h) {
        deleteTarget(st.prev);
        st.prev = createTarget(env.w, env.h, env.half);
        st.fresh = true;
      }
      if (st.lastFrame !== env.frame - 1) st.fresh = true;   // effect was off / skipped: restart the loop
      st.lastFrame = env.frame;
      env.run(this.shader, out, { u_tex: inp, u_prev: st.prev },
        Object.assign(env.paramUniforms(this, inst.params), { u_first: st.fresh ? 1 : 0 }));
      st.fresh = false;
      env.copy(out, st.prev);                       // remember this output for next frame
    },
    dispose(st) { deleteTarget(st.prev); },
    shader: `
uniform sampler2D u_prev;
uniform float u_decay, u_zoom, u_rot, u_ox, u_oy, u_hue, u_blend, u_first;
vec4 effect(vec2 uv){
  vec4 cur = texture(u_tex, uv);
  if (u_first > 0.5) return cur;
  // where in the previous frame does this pixel come from?
  float asp = u_res.x / u_res.y;
  vec2 p = uv - 0.5;
  p.x *= asp;
  float a = radians(u_rot), s = sin(a), c = cos(a);
  p = mat2(c, -s, s, c) * p;
  p.x /= asp;
  p = p / u_zoom + 0.5 - vec2(u_ox, u_oy);
  vec4 pv = texture(u_prev, p);
  float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
  vec3 hsv = rgb2hsv(max(pv.rgb, 0.0));             // rotate the hue each trip around the loop
  hsv.x = fract(hsv.x + u_hue / 360.0);
  pv.rgb = hsv2rgb(hsv);
  pv *= inside;
  if (u_blend < 0.5)       return mix(cur, pv, u_decay * inside);                         // mix
  else if (u_blend < 1.5)  return vec4(max(cur.rgb, pv.rgb * u_decay), max(cur.a, pv.a * u_decay)); // lighten
  else                     return vec4(clamp(cur.rgb + pv.rgb * u_decay, 0.0, 1.0), max(cur.a, pv.a * u_decay)); // add
}`,
  },

  /* 15 ─ CACHE / FRAME ECHO ─────────────────────────────────────────── */
  // Keeps the last frames in a texture array (a ring buffer, 96 layers at <=640px) and blends
  // N of them, `spacing` frames apart, with weight decay^k.
  cache: {
    label: 'Cache / Frame Echo',
    stateful: true,
    params: [
      R('count', 'Echoes (frames)', 2, 30, 1, 8),
      R('spacing', 'Spacing (frames)', 1, 8, 1, 2),
      R('decay', 'Decay', 0, 1, .01, .85),
      S('blend', 'Blend', ['Lighten', 'Average', 'Add'], 0),
      { type: 'note', text: 'History holds 96 frames, so with many echoes the spacing is limited automatically (30 echoes → 3 frames).' },
    ],
    LAYERS: 96, MAXDIM: 640,
    render(env, inst, inp, out) {
      const st = inst.state, p = inst.params, L = this.LAYERS;
      const s = Math.min(1, this.MAXDIM / Math.max(env.w, env.h));
      const cw = Math.max(2, Math.round(env.w * s)), ch = Math.max(2, Math.round(env.h * s));
      if (!st.tex || st.cw !== cw || st.ch !== ch) {
        this.dispose(st);
        st.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, st.tex);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, cw, ch, L);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        st.layers = [];
        for (let i = 0; i < L; i++) {               // one framebuffer per layer so we can render into it
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, st.tex, 0, i);
          st.layers.push({ fbo, w: cw, h: ch });
        }
        st.cw = cw; st.ch = ch; st.head = 0; st.filled = 0;
      }
      if (st.fresh || st.lastFrame !== env.frame - 1) { st.filled = 0; st.fresh = false; }
      st.lastFrame = env.frame;

      // 1. store the current input in the ring buffer
      env.run(COPY_FRAG, st.layers[st.head], { u_tex: inp });
      const last = st.head;
      st.head = (st.head + 1) % L;
      st.filled = Math.min(st.filled + 1, L);

      // 2. blend current frame with older ones
      const n = p.count;
      const spacing = Math.max(1, Math.min(p.spacing, Math.floor((L - 1) / (n - 1))));
      env.run(this.shader, out, { u_tex: inp, u_hist: { tex: st.tex, array: true } }, {
        u_n: n, u_spacing: spacing, u_decay: p.decay, u_blend: p.blend,
        u_last: last, u_filled: st.filled, u_layers: L,
      });
    },
    dispose(st) {
      if (st.tex) gl.deleteTexture(st.tex);
      (st.layers || []).forEach(l => gl.deleteFramebuffer(l.fbo));
      st.tex = null; st.layers = null;
    },
    shader: `
uniform sampler2DArray u_hist;
uniform float u_n, u_spacing, u_decay, u_blend, u_last, u_filled, u_layers;
vec4 effect(vec2 uv){
  vec4 cur = texture(u_tex, uv);                    // the live frame at full resolution
  vec4 acc = cur; float wsum = 1.0;
  for (int k = 1; k < 30; k++) {
    if (float(k) >= u_n) break;
    float age = float(k) * u_spacing;               // how many frames back this echo is
    if (age >= u_filled) break;                     // not recorded yet
    float w = pow(u_decay, float(k));
    float layer = mod(u_last - age, u_layers);      // ring-buffer slot
    vec4 e = texture(u_hist, vec3(uv, layer));
    if (u_blend < 0.5)      acc = max(acc, e * w);  // lighten: ghosts trail behind bright things
    else                  { acc += e * w; wsum += w; }
  }
  if (u_blend > 0.5 && u_blend < 1.5) acc /= wsum;  // average
  return clamp(acc, 0.0, 1.0);
}`,
  },

  /* 16 ─ BLOOM / GLOW ───────────────────────────────────────────────── */
  bloom: {
    label: 'Bloom / Glow',
    params: [
      R('threshold', 'Threshold', 0, 1, .01, .6),
      R('intensity', 'Intensity', 0, 3, .01, 1),
      R('radius', 'Radius (px)', 1, 120, .5, 30),
    ],
    // pass 1: keep only bright pixels; pass 2+3: blur them; pass 4: screen-blend back on the original
    render(env, inst, inp, out) {
      const p = inst.params, t0 = env.temp(0), t1 = env.temp(1);
      env.run(`
uniform float u_threshold;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  float m = max(c.r, max(c.g, c.b));
  float k = clamp((m - u_threshold) / max(1.0 - u_threshold, 1e-3), 0.0, 1.0);
  return vec4(c.rgb * k, c.a);
}`, t0, { u_tex: inp }, { u_threshold: p.threshold });
      blur2(env, t0, t1, out, p.radius * env.px);   // 'out' is used as scratch here, it's overwritten below
      env.run(`
uniform sampler2D u_glow; uniform float u_intensity;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  vec3 g = texture(u_glow, uv).rgb * u_intensity;
  return vec4(1.0 - (1.0 - clamp(c.rgb, 0.0, 1.0)) * (1.0 - clamp(g, 0.0, 1.0)), c.a);   // screen
}`, out, { u_tex: inp, u_glow: t1 }, { u_intensity: p.intensity });
    },
  },

  /* 17 ─ NOISE / GRAIN ──────────────────────────────────────────────── */
  grain: {
    label: 'Noise / Grain',
    params: [
      R('amount', 'Amount', 0, 1, .01, .25),
      R('size', 'Grain size (px)', 1, 6, .5, 1.5),
      T('animated', 'Animated', true),
      T('mono', 'Monochrome grain', true),
    ],
    frag: `
uniform float u_amount, u_size, u_animated, u_mono;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  vec2 g = floor(uv * u_res / max(u_size * u_px, 1.0));       // grain cell
  float t = u_animated > 0.5 ? floor(u_time * 24.0) : 0.0;    // new pattern 24x per second
  float n = hash13(vec3(g, t));
  vec3 nn = u_mono > 0.5 ? vec3(n) : vec3(n, hash13(vec3(g + 17.0, t)), hash13(vec3(g + 91.0, t)));
  return vec4(c.rgb + (nn - 0.5) * u_amount, c.a);
}`,
  },
};

// display order in the "Add effect" menu
const EFFECT_ORDER = ['level', 'hsv', 'mono', 'blur', 'lumablur', 'edge', 'convolve', 'threshold', 'pixelate',
  'displace', 'rgbsplit', 'lookup', 'chroma', 'feedback', 'cache', 'bloom', 'grain'];

/* ---------------------------------------------------------------------
 * 4. PIPELINE
 * ------------------------------------------------------------------- */
const app = {
  source: null,          // {kind, el, w, h, name, tex, url}
  stack: [],             // effect instances
  nextId: 1,
  compare: false,        // Before/After held
  eyedrop: null,         // chroma instance waiting for a preview click
  exporting: false,
  busy: false,           // renderer paused (full-size PNG export)
  muted: true,
  audio: null,
  t0: performance.now(),
};

const DISPLAY_FRAG = `
uniform float u_bgMode;       // 0 checkerboard, 1 solid colour, 2 keep transparency
uniform vec3 u_bgColor;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  if (u_bgMode > 1.5) return c;
  vec3 bg = u_bgColor;
  if (u_bgMode < 0.5) {
    float cell = max(8.0, u_res.y / 36.0);
    vec2 g = floor(gl_FragCoord.xy / cell);
    bg = vec3(mix(0.16, 0.27, mod(g.x + g.y, 2.0)));
  }
  return vec4(mix(bg, clamp(c.rgb, 0.0, 1.0), c.a), 1.0);
}`;

/** Background behind transparency comes from the first enabled Chroma Key card. */
function bgSettings() {
  const inst = app.stack.find(i => i.type === 'chroma' && i.enabled);
  if (!inst) return { mode: 0, color: [0, 0, 0] };
  const p = inst.params;
  return [
    { mode: 0, color: [0, 0, 0] }, { mode: 1, color: [0, 0, 0] }, { mode: 1, color: [1, 1, 1] },
    { mode: 1, color: [0, 1, 0] }, { mode: 1, color: hexToRgb(p.bgColor) },
  ][p.bg];
}

function freePipeline() {
  env.ping.forEach(deleteTarget); env.ping = [null, null];
  env.temps.forEach(deleteTarget); env.temps = [];
  app.stack.forEach(disposeState);
}
function disposeState(inst) {
  const def = EFFECTS[inst.type];
  if (def.dispose) def.dispose(inst.state);
  inst.state = {};
}
function setWorkSize(w, h) {
  freePipeline();
  env.w = w; env.h = h; env.px = h / 1080;
  env.half = HALF_OK && w * h <= 8e6;               // huge exports fall back to 8-bit to save memory
  canvas.width = w; canvas.height = h;
  CANVAS_TARGET.w = w; CANVAS_TARGET.h = h;
  env.ping = [createTarget(w, h, env.half), createTarget(w, h, env.half)];
  layout();
}
function resetStates() {                           // feedback / cache restart (used on seek)
  app.stack.forEach(i => { i.state.fresh = true; });
}

/** Upload the newest video frame (images are uploaded once at load). */
function uploadSource() {
  const s = app.source;
  if (s.kind !== 'video') return;
  const v = s.el;
  if (v.readyState < 2) return;
  if (v.currentTime === s.lastT && s.uploaded) return;   // same frame as before
  s.lastT = v.currentTime; s.uploaded = true;
  gl.bindTexture(gl.TEXTURE_2D, s.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
  if (s.mip) gl.generateMipmap(gl.TEXTURE_2D);
}

/**
 * Render one frame: source -> [effect 1 -> effect 2 ...] -> canvas.
 * `cur` is the buffer holding the latest result, `other` receives the next effect's output,
 * then they swap: that is the ping-pong.
 */
function render(time, displayMode) {
  const s = app.source;
  if (!s) return;
  env.time = time; env.frame++;
  uploadSource();
  if (s.kind === 'video' && !s.uploaded) return;

  let cur = env.ping[0], other = env.ping[1];
  env.run(COPY_FRAG, cur, { u_tex: s.tex });         // source -> first buffer

  if (!app.compare) {
    for (const inst of app.stack) {
      if (!inst.enabled || inst.broken) continue;
      const def = EFFECTS[inst.type];
      try {
        if (def.render) def.render(env, inst, cur, other);
        else env.run(def.frag, other, { u_tex: cur }, env.paramUniforms(def, inst.params));
      } catch (e) {
        inst.broken = true;
        console.error(e);
        showEffectError(inst, e.message);
        continue;                                    // skip this effect, keep the chain running
      }
      [cur, other] = [other, cur];
    }
  }

  // final: composite over checkerboard / background colour and draw to the canvas
  const bg = bgSettings();
  let mode = bg.mode;                                // 0 checker, 1 solid
  if (mode === 0 && displayMode === 'transparent') mode = 2;   // PNG export keeps the alpha channel
  if (mode === 0 && displayMode === 'solid') mode = 1;         // video can't hold a checkerboard: use black
  env.run(DISPLAY_FRAG, CANVAS_TARGET, { u_tex: cur }, { u_bgMode: mode, u_bgColor: bg.color });
}

/* ---------------------------------------------------------------------
 * 5. SOURCE LOADING
 * ------------------------------------------------------------------- */
const CAP_IMAGE = 1600, CAP_VIDEO = 1280;   // preview resolution caps (longest side)
function workSize(w, h, kind) {
  const s = Math.min(1, (kind === 'video' ? CAP_VIDEO : CAP_IMAGE) / Math.max(w, h));
  return { w: Math.max(2, Math.round(w * s)), h: Math.max(2, Math.round(h * s)) };
}

function loadMedia(kind, url) {
  return new Promise((resolve, reject) => {
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode'));
      img.src = url;
    } else {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = async () => {
        // MediaRecorder WebM files (including this tool's own exports) report duration = Infinity.
        // Seeking far past the end forces the browser to work out the real length.
        if (v.duration === Infinity) {
          await new Promise(res => { v.ontimeupdate = () => { v.ontimeupdate = null; res(); }; v.currentTime = 1e7; setTimeout(res, 3000); });
          await new Promise(res => { v.onseeked = () => { v.onseeked = null; res(); }; v.currentTime = 0; setTimeout(res, 3000); });
        }
        v.onloadeddata = null;
        resolve(v);
      };
      v.onerror = () => reject(new Error('decode'));
      v.src = url;
    }
  });
}

async function loadFile(file) {
  if (app.exporting) { toast('Please wait for the export to finish (or cancel it) first.'); return; }
  if (/\.json$/i.test(file.name) || file.type === 'application/json') { loadPresetFile(file); return; }
  const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|mkv)$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name);
  if (!isVideo && !isImage) {
    toast(`"${file.name}" isn't an image or video I can open. Try a PNG, JPG, WebP, GIF, MP4 or WebM file.`, 'error');
    return;
  }
  const kind = isVideo ? 'video' : 'image';
  const url = URL.createObjectURL(file);
  let media;
  try {
    media = await loadMedia(kind, url);
  } catch (e) {
    URL.revokeObjectURL(url);
    toast(kind === 'video'
      ? `Your browser couldn't play "${file.name}". The video codec may be unsupported – try an MP4 (H.264) or WebM file.`
      : `Couldn't read "${file.name}" as an image. The file may be corrupt or in a format this browser can't decode (e.g. HEIC).`, 'error');
    return;
  }
  setSource(kind, media, url, file.name);
}

function setSource(kind, media, url, name) {
  // tear down the previous source
  const old = app.source;
  if (old) {
    if (old.kind === 'video') old.el.pause();
    gl.deleteTexture(old.tex);
    URL.revokeObjectURL(old.url);
  }
  closeAudio();

  let w = kind === 'video' ? media.videoWidth : media.naturalWidth;
  let h = kind === 'video' ? media.videoHeight : media.naturalHeight;
  if (!w || !h) { w = w || 512; h = h || 512; }
  let el = media;
  // Textures can't exceed the GPU limit: downscale enormous images once with a 2D canvas.
  const lim = Math.min(MAX_TEX, EXPORT_CAP);
  if (kind === 'image' && Math.max(w, h) > lim) {
    const s = lim / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(media, 0, 0, c.width, c.height);
    toast(`Image is larger than this GPU allows (${lim}px) – it was scaled down to ${c.width}×${c.height}.`);
    el = c; w = c.width; h = c.height;
  }

  const tex = gl.createTexture();
  const ws = workSize(w, h, kind);
  const mip = ws.w * 1.5 < w;                        // downscaling a lot -> use mipmaps to avoid aliasing
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  const src = { kind, el, w, h, name, tex, url, mip, lastT: -1, uploaded: false };
  if (kind === 'image') {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    src.uploaded = true;
  }
  app.source = src;
  app.stack.forEach(i => { i.broken = false; });
  setWorkSize(ws.w, ws.h);

  // UI state
  canvas.classList.remove('empty');
  $('#dropHint').hidden = true;
  $('#btnExport').disabled = false;
  $('#btnCompare').disabled = false;
  $('#btnExport').textContent = kind === 'video' ? 'Export video' : 'Export PNG';
  $('#videobar').hidden = kind !== 'video';
  $('#srcInfo').textContent = `${name} · ${w}×${h}` + (ws.w !== w ? ` · preview ${ws.w}×${ws.h}` : '');
  if (kind === 'video') {
    el.muted = app.muted;
    $('#scrub').disabled = !isFinite(el.duration);
    el.play().catch(() => toast('Press the play button to start the video.'));
    updateMuteButton();
  }
  layout();
}

/* --- audio: route the <video> through WebAudio so export can capture sound
 *     even while the preview is muted (mute just sets the speaker gain). --- */
function ensureAudio() {
  const s = app.source;
  if (app.audio || !s || s.kind !== 'video') return app.audio;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const node = ctx.createMediaElementSource(s.el);
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  node.connect(gain); gain.connect(ctx.destination);   // to speakers (through the mute gain)
  node.connect(dest);                                   // to the recorder (always full volume)
  app.audio = { ctx, gain, dest };
  applyMute();
  return app.audio;
}
function closeAudio() {
  if (app.audio) { try { app.audio.ctx.close(); } catch (e) {} app.audio = null; }
}
function applyMute() {
  const s = app.source;
  if (!s || s.kind !== 'video') return;
  if (app.audio) { s.el.muted = false; app.audio.gain.gain.value = app.muted ? 0 : 1; }
  else s.el.muted = app.muted;
  updateMuteButton();
}
function updateMuteButton() { $('#btnMute').textContent = app.muted ? '🔇' : '🔊'; }

/* ---------------------------------------------------------------------
 * 6. UI – effect cards and controls
 * ------------------------------------------------------------------- */
function defaultParams(def) {
  const p = {};
  def.params.forEach(d => { if (d.key && d.def !== undefined) p[d.key] = clone(d.def); });   // buttons/notes have no value
  return p;
}
/** Validate values coming from a preset file so bad JSON can't break the app. */
function sanitizeParams(def, incoming) {
  const p = defaultParams(def);
  if (!incoming || typeof incoming !== 'object') return p;
  for (const d of def.params) {
    if (!d.key || !(d.key in incoming)) continue;
    const v = incoming[d.key];
    if (d.type === 'range' && typeof v === 'number' && isFinite(v)) p[d.key] = clamp(v, d.min, d.max);
    else if (d.type === 'toggle') p[d.key] = !!v;
    else if (d.type === 'select' && Number.isInteger(v)) p[d.key] = clamp(v, 0, d.options.length - 1);
    else if (d.type === 'color' && /^#[0-9a-f]{6}$/i.test(v)) p[d.key] = v;
    else if (d.type === 'gradient' && Array.isArray(v) && v.length >= 2 && v.length <= 4 &&
      v.every(s => s && typeof s.p === 'number' && /^#[0-9a-f]{6}$/i.test(s.c)))
      p[d.key] = v.map(s => ({ p: clamp(s.p, 0, 1), c: s.c }));
  }
  if (def.afterLoad) def.afterLoad(p, incoming);
  return p;
}
function makeInstance(type, incoming, enabled = true) {
  const def = EFFECTS[type];
  return {
    uid: app.nextId++, type, enabled,
    params: incoming ? sanitizeParams(def, incoming) : defaultParams(def),
    state: {}, collapsed: false, broken: false, ui: null,
  };
}
function addEffect(type) {
  const inst = makeInstance(type);
  app.stack.push(inst);
  renderStack();
  inst.ui.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function removeEffect(inst) {
  disposeState(inst);
  app.stack.splice(app.stack.indexOf(inst), 1);
  if (app.eyedrop === inst) stopEyedrop();
  renderStack();
}
function moveEffect(inst, dir) {
  const i = app.stack.indexOf(inst), j = i + dir;
  if (j < 0 || j >= app.stack.length) return;
  [app.stack[i], app.stack[j]] = [app.stack[j], app.stack[i]];
  renderStack();
}
function showEffectError(inst, msg) {
  if (inst.ui && inst.ui.errorEl) {
    inst.ui.errorEl.textContent = 'This effect failed and was skipped.\n' + msg;
    inst.ui.errorEl.hidden = false;
  }
}

function renderStack() {
  const box = $('#stack');
  const scroll = $('#sidebar').scrollTop;
  box.innerHTML = '';
  app.stack.forEach((inst, i) => box.appendChild(buildCard(inst, i)));
  $('#emptyStack').hidden = app.stack.length > 0;
  $('#sidebar').scrollTop = scroll;
}

function buildCard(inst, index) {
  const def = EFFECTS[inst.type];
  const card = el('div', 'card');
  const ui = inst.ui = { card, controls: {}, rows: {}, errorEl: null };

  // header: title | up | down | on/off | delete
  const head = el('div', 'card-head');
  const title = el('div', 'card-title');
  title.append(el('span', 'caret', '▼'), el('span', null, def.label), el('span', 'idx', '#' + (index + 1)));
  title.addEventListener('click', () => { inst.collapsed = !inst.collapsed; card.classList.toggle('collapsed', inst.collapsed); });
  const up = el('button', 'mini', '▲'); up.title = 'Move up (runs earlier)'; up.disabled = index === 0;
  const down = el('button', 'mini', '▼'); down.title = 'Move down (runs later)'; down.disabled = index === app.stack.length - 1;
  up.addEventListener('click', () => moveEffect(inst, -1));
  down.addEventListener('click', () => moveEffect(inst, 1));
  const sw = el('label', 'switch'); sw.title = 'Enable / disable';
  const chk = el('input'); chk.type = 'checkbox'; chk.checked = inst.enabled;
  chk.addEventListener('change', () => { inst.enabled = chk.checked; card.classList.toggle('off', !inst.enabled); });
  sw.append(chk, el('span'));
  const del = el('button', 'mini del', '✕'); del.title = 'Delete effect';
  del.addEventListener('click', () => removeEffect(inst));
  head.append(title, up, down, sw, del);

  // body: one control per param
  const body = el('div', 'card-body');
  def.params.forEach(pd => {
    const c = buildControl(inst, pd);
    if (pd.key) { ui.controls[pd.key] = c; ui.rows[pd.key] = c.el; }
    body.appendChild(c.el);
  });
  ui.errorEl = el('div', 'err'); ui.errorEl.hidden = !inst.broken;
  body.appendChild(ui.errorEl);

  card.append(head, body);
  card.classList.toggle('off', !inst.enabled);
  card.classList.toggle('collapsed', inst.collapsed);
  updateVisibility(inst);
  return card;
}

function updateVisibility(inst) {
  if (!inst.ui) return;
  EFFECTS[inst.type].params.forEach(pd => {
    if (pd.showIf && pd.key && inst.ui.rows[pd.key]) inst.ui.rows[pd.key].hidden = !pd.showIf(inst.params);
  });
}
function syncControls(inst) {
  if (!inst.ui) return;
  Object.values(inst.ui.controls).forEach(c => c.sync && c.sync());
  updateVisibility(inst);
}
function changed(inst, pd) {
  if (pd.onChange) { pd.onChange(inst.params); syncControls(inst); }
  updateVisibility(inst);
}

/** Build one control row. Returns {el, sync()} – sync() refreshes the DOM from inst.params. */
function buildControl(inst, pd) {
  const row = el('div', 'ctl');
  const params = inst.params;

  if (pd.type === 'range') {
    const head = el('div', 'ctl-head');
    const lab = el('label', null, pd.label); lab.title = 'Double-click to reset';
    const val = el('span', 'val');
    head.append(lab, val);
    const inp = el('input'); inp.type = 'range';
    inp.min = pd.min; inp.max = pd.max; inp.step = pd.step;
    const sync = () => {
      inp.value = params[pd.key];
      val.textContent = fmtNum(params[pd.key], pd.step);
      inp.style.setProperty('--pct', ((params[pd.key] - pd.min) / (pd.max - pd.min) * 100) + '%');
    };
    inp.addEventListener('input', () => { params[pd.key] = parseFloat(inp.value); sync(); changed(inst, pd); });
    lab.addEventListener('dblclick', () => { params[pd.key] = pd.def; sync(); changed(inst, pd); });
    row.append(head, inp); sync();
    return { el: row, sync };
  }

  if (pd.type === 'toggle') {
    row.classList.add('inline');
    const lab = el('label', null, pd.label);
    const sw = el('label', 'switch');
    const chk = el('input'); chk.type = 'checkbox';
    sw.append(chk, el('span'));
    const sync = () => { chk.checked = !!params[pd.key]; };
    chk.addEventListener('change', () => { params[pd.key] = chk.checked; changed(inst, pd); });
    row.append(lab, sw); sync();
    return { el: row, sync };
  }

  if (pd.type === 'select') {
    row.classList.add('inline');
    const lab = el('label', null, pd.label);
    const sel = el('select');
    pd.options.forEach((o, i) => { const op = el('option', null, o); op.value = i; sel.appendChild(op); });
    const sync = () => { sel.value = params[pd.key]; };
    sel.addEventListener('change', () => { params[pd.key] = parseInt(sel.value, 10); changed(inst, pd); });
    sel.style.width = '58%';
    row.append(lab, sel); sync();
    return { el: row, sync };
  }

  if (pd.type === 'color') {
    row.classList.add('inline');
    const lab = el('label', null, pd.label);
    const inp = el('input'); inp.type = 'color';
    const sync = () => { inp.value = params[pd.key]; };
    inp.addEventListener('input', () => { params[pd.key] = inp.value; changed(inst, pd); });
    row.append(lab, inp); sync();
    return { el: row, sync };
  }

  if (pd.type === 'button') {
    const b = el('button', 'btn small', pd.label);
    b.addEventListener('click', () => pd.action(inst, b));
    row.appendChild(b);
    return { el: row };
  }

  if (pd.type === 'note') {
    row.classList.add('note'); row.textContent = pd.text;
    return { el: row };
  }

  if (pd.type === 'gradient') return gradientControl(inst, pd, row);
  return { el: row };
}

/** Gradient editor: preview bar + 2..4 colour stops (colour, position, remove). */
function gradientControl(inst, pd, row) {
  const params = inst.params;
  const bar = el('div', 'grad-bar');
  const rows = el('div');
  const add = el('button', 'btn small', '+ Add stop');
  const paint = () => {
    const s = params[pd.key].slice().sort((a, b) => a.p - b.p);
    bar.style.background = 'linear-gradient(90deg,' + s.map(x => `${x.c} ${(x.p * 100).toFixed(1)}%`).join(',') + ')';
  };
  // any manual edit flips the linked preset select to "Custom"
  const edited = () => {
    paint();
    if (pd.linkKey && params[pd.linkKey] !== pd.linkValue) {
      params[pd.linkKey] = pd.linkValue;
      inst.ui.controls[pd.linkKey].sync();
    }
  };
  const build = () => {
    rows.innerHTML = '';
    const stops = params[pd.key];
    stops.forEach((s, i) => {
      const r = el('div', 'grad-row');
      const col = el('input'); col.type = 'color'; col.value = s.c;
      col.addEventListener('input', () => { s.c = col.value; edited(); });
      const pos = el('input'); pos.type = 'range'; pos.min = 0; pos.max = 1; pos.step = .01; pos.value = s.p;
      const setPct = () => pos.style.setProperty('--pct', pos.value * 100 + '%');
      setPct();
      pos.addEventListener('input', () => { s.p = parseFloat(pos.value); setPct(); edited(); });
      const rm = el('button', 'mini', '✕'); rm.title = 'Remove stop'; rm.disabled = stops.length <= 2;
      rm.addEventListener('click', () => { stops.splice(i, 1); build(); edited(); });
      r.append(col, pos, rm);
      rows.appendChild(r);
    });
    add.disabled = stops.length >= 4;
    paint();
  };
  add.addEventListener('click', () => {
    const stops = params[pd.key];
    if (stops.length >= 4) return;
    stops.push({ p: .5, c: '#ffffff' });
    build(); edited();
  });
  row.append(bar, rows, add);
  build();
  return { el: row, sync: build };
}

/* --- eyedropper for chroma key ---------------------------------------- */
function startEyedrop(inst) {
  if (!app.source) { toast('Load an image or video first.'); return; }
  if (!inst.enabled) { toast('Enable the Chroma Key effect first.'); return; }
  app.eyedrop = inst;
  canvas.classList.add('picking');
  toast('Click the preview to pick the key color (Esc to cancel).');
}
function stopEyedrop() { app.eyedrop = null; canvas.classList.remove('picking'); }

/* ---------------------------------------------------------------------
 * 7. PRESETS
 * ------------------------------------------------------------------- */
const fx = (type, params, enabled = true) => ({ type, params, enabled });
const BUILTIN_PRESETS = {
  'VHS glitch': [
    fx('level', { contrast: 1.15, brightness: .02 }),
    fx('hsv', { sat: .85 }),
    fx('displace', { amount: .012, scale: 6, speed: 1.6, direction: 0 }),
    fx('rgbsplit', { r: 9, g: 0, b: -9, angle: 0 }),
    fx('blur', { radius: 1.5 }),
    fx('grain', { amount: .35, size: 2 }),
  ],
  'Thermal cam': [
    fx('level', { contrast: 1.25 }),
    fx('blur', { radius: 3 }),
    fx('lookup', { preset: 0 }),
    fx('grain', { amount: .12, size: 2 }),
  ],
  'Neon outline': [
    fx('blur', { radius: 1.5 }),
    fx('edge', { strength: 3, threshold: .15, mode: 0, color: '#19f0ff' }),
    fx('bloom', { threshold: .3, intensity: 1.6, radius: 22 }),
    fx('hsv', { sat: 1.3 }),
  ],
  'Dreamy glow': [
    fx('level', { exposure: .1, contrast: .95 }),
    fx('bloom', { threshold: .45, intensity: 1.1, radius: 45 }),
    fx('blur', { radius: 1.5 }),
    fx('hsv', { sat: 1.15 }),
    fx('grain', { amount: .08 }),
  ],
  'Liquid warp': [
    fx('displace', { amount: .06, scale: 2.2, speed: .35, direction: 2 }),
    fx('rgbsplit', { r: 6, g: 0, b: -6, radial: true }),
    fx('bloom', { threshold: .6, intensity: .6, radius: 20 }),
  ],
  'Psychedelic trails': [
    fx('feedback', { decay: .9, zoom: 1.02, rot: 2, hue: 8, blend: 0 }),
    fx('hsv', { sat: 1.3 }),
  ],
  'Ghost echo': [
    fx('cache', { count: 12, spacing: 3, decay: .82, blend: 0 }),
    fx('bloom', { threshold: .7, intensity: .5, radius: 25 }),
  ],
};

function loadStack(list) {
  app.stack.forEach(disposeState);
  stopEyedrop();
  app.stack = list.filter(s => s && EFFECTS[s.type]).map(s => makeInstance(s.type, s.params, s.enabled !== false));
  renderStack();
}
function savePreset() {
  const data = {
    format: 'top-fx-preset', version: 1,
    stack: app.stack.map(i => ({ type: i.type, enabled: i.enabled, params: i.params })),
  };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'top-fx-preset.json');
}
async function loadPresetFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.stack)) throw new Error('bad');
    const known = data.stack.filter(s => s && EFFECTS[s.type]);
    if (!known.length && data.stack.length) throw new Error('bad');
    loadStack(data.stack);
    const skipped = data.stack.length - known.length;
    toast(`Loaded preset with ${known.length} effect${known.length === 1 ? '' : 's'}` + (skipped ? ` (${skipped} unknown skipped).` : '.'));
  } catch (e) {
    toast("That file isn't a valid TOP FX preset (.json).", 'error');
  }
}

/* ---------------------------------------------------------------------
 * 8. EXPORT
 * ------------------------------------------------------------------- */
async function exportPNG() {
  const s = app.source;
  const name = s.name.replace(/\.[^.]+$/, '') + '-fx.png';
  const full = { w: s.w, h: s.h };
  const prev = { w: env.w, h: env.h };
  const needResize = full.w !== prev.w || full.h !== prev.h;
  app.busy = true;                                   // pause the live loop while we own the GL state
  try {
    if (needResize) setWorkSize(full.w, full.h);     // render at the original resolution
    // stateful effects (feedback / cache) need a few frames to build up, so warm them up
    const warm = app.stack.some(i => i.enabled && EFFECTS[i.type].stateful) ? 24 : 0;
    const t = (performance.now() - app.t0) / 1000;
    for (let i = warm; i >= 0; i--) render(t - i / 30, 'transparent');
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('toBlob failed');
    download(blob, name);
    toast(`Saved ${name} (${full.w}×${full.h})`);
  } catch (e) {
    console.error(e);
    toast('PNG export failed – the image may be too large for this GPU.', 'error');
  } finally {
    if (needResize) setWorkSize(prev.w, prev.h);
    app.busy = false;
  }
}

function pickMime() {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
}
let cancelExportHook = null;
async function exportVideo() {
  const s = app.source, v = s.el;
  const mime = pickMime();
  if (!canvas.captureStream || !mime) {
    toast("This browser can't record canvas video (MediaRecorder / WebM missing). Try Chrome, Edge or Firefox.", 'error');
    return;
  }
  app.exporting = true;
  $('#exportProgress').hidden = false;
  $('#exportLabel').textContent = 'Recording…';
  $('#exportFill').style.width = '0%';
  $('#btnExport').disabled = true;
  layout();

  const wasLoop = v.loop;
  let cancelled = false;
  try {
    v.pause(); v.loop = false;
    await new Promise(res => {                       // rewind to the start
      if (v.currentTime === 0) return res();
      v.addEventListener('seeked', res, { once: true });
      v.currentTime = 0;
    });
    resetStates();

    const stream = canvas.captureStream(30);
    // audio: route the element through WebAudio and add that track to the recording
    let hasAudio = false;
    try {
      const a = ensureAudio();
      await a.ctx.resume();
      a.dest.stream.getAudioTracks().forEach(t => { stream.addTrack(t); hasAudio = true; });
    } catch (e) { console.warn('Audio capture unavailable', e); }

    const bps = Math.round(clamp(env.w * env.h * 30 * 0.15, 2e6, 20e6));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(250);
    app.exportStart = performance.now();
    await v.play();

    await new Promise(res => {                       // wait for the clip to end (or Cancel)
      v.addEventListener('ended', res, { once: true });
      cancelExportHook = () => { cancelled = true; res(); };
    });
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    stream.getTracks().forEach(t => t.stop());

    if (!cancelled && chunks.length) {
      const name = s.name.replace(/\.[^.]+$/, '') + '-fx.webm';
      download(new Blob(chunks, { type: 'video/webm' }), name);
      toast(`Saved ${name}` + (hasAudio ? '' : ' (no audio track)'));
    } else if (cancelled) toast('Export cancelled.');
  } catch (e) {
    console.error(e);
    toast('Video export failed: ' + (e.message || e), 'error');
  } finally {
    cancelExportHook = null;
    v.loop = wasLoop;
    v.currentTime = 0;
    resetStates();
    v.play().catch(() => {});
    app.exporting = false;
    $('#exportProgress').hidden = true;
    $('#btnExport').disabled = false;
    layout();
  }
}

/* ---------------------------------------------------------------------
 * 9. MAIN LOOP + WIRING
 * ------------------------------------------------------------------- */
function layout() {
  const vp = $('#viewport');
  const r = vp.getBoundingClientRect();
  const pad = 24;
  const aw = Math.max(50, r.width - pad * 2), ah = Math.max(50, r.height - pad * 2);
  const s = Math.min(aw / canvas.width, ah / canvas.height);
  canvas.style.width = Math.max(1, Math.floor(canvas.width * s)) + 'px';
  canvas.style.height = Math.max(1, Math.floor(canvas.height * s)) + 'px';
}
new ResizeObserver(layout).observe($('#viewport'));

let scrubbing = false;
function updateVideoUI() {
  const s = app.source;
  if (!s || s.kind !== 'video') return;
  const v = s.el;
  $('#btnPlay').textContent = v.paused ? '▶' : '❚❚';
  if (!scrubbing && isFinite(v.duration)) $('#scrub').value = v.currentTime / v.duration * 1000;
  $('#timeLbl').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  if (app.exporting && isFinite(v.duration)) {
    const pct = clamp(v.currentTime / v.duration * 100, 0, 100);
    $('#exportFill').style.width = pct + '%';
    $('#exportLabel').textContent = `Recording… ${pct.toFixed(0)}%`;
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  updateVideoUI();
  if (!app.source || app.busy) return;
  try {
    // during video export the effects' clock follows the video, so re-exports look identical
    const t = app.exporting && app.source.kind === 'video' ? app.source.el.currentTime : (now - app.t0) / 1000;
    // Video recording needs an opaque canvas; checkerboard would otherwise be baked into the file.
    render(t, app.exporting ? 'solid' : null);
  } catch (e) { console.error(e); }
}

function init() {
  // effect menu + presets menu
  const add = $('#addEffect');
  add.appendChild(Object.assign(el('option', null, '+ Add effect…'), { value: '' }));
  EFFECT_ORDER.forEach(k => add.appendChild(Object.assign(el('option', null, EFFECTS[k].label), { value: k })));
  add.addEventListener('change', () => { if (add.value) addEffect(add.value); add.value = ''; });

  const ps = $('#presetSelect');
  ps.appendChild(Object.assign(el('option', null, 'Built-in presets…'), { value: '' }));
  Object.keys(BUILTIN_PRESETS).forEach(k => ps.appendChild(Object.assign(el('option', null, k), { value: k })));
  ps.addEventListener('change', () => {
    if (ps.value) loadStack(BUILTIN_PRESETS[ps.value]);
    ps.value = '';
  });

  // upload
  const fileInput = $('#fileInput');
  $('#btnUpload').addEventListener('click', () => fileInput.click());
  $('#btnUpload2').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });

  // drag & drop anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // export / reset / compare
  $('#btnExport').addEventListener('click', () => {
    if (!app.source || app.exporting) return;
    if (app.source.kind === 'image') exportPNG(); else exportVideo();
  });
  $('#btnCancelExport').addEventListener('click', () => { if (cancelExportHook) cancelExportHook(); });
  $('#btnReset').addEventListener('click', () => {
    if (app.stack.length && !confirm('Remove all effects?')) return;
    loadStack([]);
  });
  const cmp = $('#btnCompare');
  const setCmp = on => { app.compare = on; cmp.classList.toggle('active', on); };
  cmp.addEventListener('pointerdown', e => { cmp.setPointerCapture(e.pointerId); setCmp(true); });
  cmp.addEventListener('pointerup', () => setCmp(false));
  cmp.addEventListener('pointercancel', () => setCmp(false));
  window.addEventListener('blur', () => setCmp(false));

  // presets save/load
  $('#btnSave').addEventListener('click', savePreset);
  $('#btnLoad').addEventListener('click', () => $('#presetInput').click());
  $('#presetInput').addEventListener('change', e => { if (e.target.files[0]) loadPresetFile(e.target.files[0]); e.target.value = ''; });

  // video transport
  const play = $('#btnPlay'), scrub = $('#scrub');
  play.addEventListener('click', () => {
    const v = app.source && app.source.el;
    if (!v || app.source.kind !== 'video') return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  });
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('input', () => {
    const v = app.source && app.source.el;
    if (!v || !isFinite(v.duration)) return;
    v.currentTime = scrub.value / 1000 * v.duration;
    resetStates();
  });
  $('#btnMute').addEventListener('click', () => { app.muted = !app.muted; applyMute(); });

  // click on the preview: chroma-key eyedropper
  canvas.addEventListener('click', e => {
    if (!app.eyedrop) return;
    const r = canvas.getBoundingClientRect();
    app.eyedrop.state.pick = { u: (e.clientX - r.left) / r.width, v: 1 - (e.clientY - r.top) / r.height };
    stopEyedrop();
  });

  // keyboard: Space = play/pause, Esc = cancel eyedrop, hold \ = before/after
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Escape' && app.eyedrop) stopEyedrop();
    if (e.key === '\\') setCmp(true);
    if (e.code === 'Space' && !['input', 'select', 'textarea', 'button'].includes(tag) && app.source && app.source.kind === 'video') {
      e.preventDefault(); play.click();
    }
  });
  window.addEventListener('keyup', e => { if (e.key === '\\') setCmp(false); });

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); toast('The graphics context was lost. Reload the page to continue.', 'error', 10000); });

  canvas.classList.add('empty');
  renderStack();
  layout();
  requestAnimationFrame(tick);
}

// small hook for debugging in the console
window.TOPFX = { app, EFFECTS, env, BUILTIN_PRESETS, loadStack, addEffect };
init();
})();
