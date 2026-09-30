/* =====================================================================
 * TOP FX – a node-based, TouchDesigner-style TOP (texture operator) editor in WebGL2
 *
 * Layout of this file
 *   1. Helpers
 *   2. WebGL core: shader prelude, programs, render targets, env.run()
 *   3. EFFECT LIBRARY  <-- add / tweak nodes here (one entry per node type)
 *   4. Graph model + pipeline: walks the node graph backwards from Output each frame
 *   5. Source loading (image / video), audio graph
 *   6. UI: node editor (drag / connect / menu), inspector, controls, gradient editor
 *   7. Presets (built-in example graphs + JSON save/load)
 *   8. Export (PNG / WebM)
 *   9. Main loop + wiring
 *
 * HOW A NODE TYPE IS DEFINED
 *   EFFECTS.myfx = {
 *     label:  'My Effect',
 *     inputs: 1,          // number of input ports (default 1; generators use 0; Composite uses 2)
 *     params: [ {key:'amount', label:'Amount', type:'range', min:0, max:1, step:.01, def:.5}, ... ],
 *     frag:   `uniform float u_amount;                 // every param 'key' becomes uniform 'u_<key>'
 *              vec4 effect(vec2 uv){ return texture(u_tex, uv) * u_amount; }`,
 *   };
 *   then add a META entry (category + description) and list it in EFFECT_ORDER (section 4).
 *   • 'frag' is a single-pass shader. `effect(uv)` returns the new colour for a pixel.
 *     Available for free: u_tex (input 1), u_tex2 / u_tex3 (inputs 2 and 3), u_res (size in px),
 *     u_time (seconds – use it to animate!), u_px (1.0 at 1080p height; multiply pixel sizes by it
 *     so preview == export), and the helpers in PRELUDE (luma, rgb2hsv, hsv2rgb, hash13, vnoise, mirrorUV).
 *   • Nodes that need several passes or memory (blur, bloom, feedback, cache) instead supply
 *     `render(env, node, input, output, allInputs)` and call env.run(...) themselves.
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

  /* 3 ─ MONOCHROME (any colour) ─────────────────────────────────────── */
  // Greyscale value is remapped between a shadow colour and a tint colour.
  // Defaults (black -> white) give plain grey.
  mono: {
    label: 'Monochrome',
    params: [
      R('mix', 'Mix', 0, 1, .01, 1),
      C('color', 'Tint (highlights)', '#ffffff'),
      C('shadow', 'Shadows', '#000000'),
    ],
    frag: `
uniform float u_mix;
uniform vec3 u_color, u_shadow;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  vec3 tinted = mix(u_shadow, u_color, clamp(luma(c.rgb), 0.0, 1.0));
  return vec4(mix(c.rgb, tinted, u_mix), c.a);
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
  // The background behind the transparency is set on the Output node.
  chroma: {
    label: 'Chroma Key',
    params: [
      C('key', 'Key color', '#00ff00'),
      { key: 'eye', type: 'button', label: '⌖ Pick color from preview', action: inst => startEyedrop(inst) },
      R('tolerance', 'Tolerance', 0, 1, .005, .25),
      R('softness', 'Softness', 0, .5, .005, .1),
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

  /* ════════════════════════ GENERATORS (no input) ════════════════════════ */

  /* ─ NOISE: animated fractal noise field ─ */
  noise: {
    label: 'Noise', inputs: 0,
    params: [
      S('type', 'Type', ['Fractal', 'Ridged', 'Turbulence'], 0),
      R('scale', 'Scale', .2, 30, .05, 4),
      R('speed', 'Speed', 0, 4, .01, .4),
      R('octaves', 'Detail (octaves)', 1, 6, 1, 4),
      R('contrast', 'Contrast', .2, 4, .01, 1.4),
      C('colorA', 'Color A', '#0b0f2a'),
      C('colorB', 'Color B', '#7dd3fc'),
    ],
    frag: `
uniform float u_type, u_scale, u_speed, u_octaves, u_contrast;
uniform vec3 u_colorA, u_colorB;
vec4 effect(vec2 uv){
  vec2 p = uv * vec2(u_res.x / u_res.y, 1.0) * u_scale;
  float t = u_time * u_speed;               // 3rd noise axis = time, so the field evolves smoothly
  float amp = 0.5, sum = 0.0, wsum = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= u_octaves) break;
    float n = vnoise(vec3(p, t));
    if (u_type > 0.5 && u_type < 1.5) n = 1.0 - abs(2.0 * n - 1.0);   // ridged
    else if (u_type > 1.5)            n = abs(2.0 * n - 1.0);         // turbulence
    sum += amp * n; wsum += amp;
    p = p * 2.03 + vec2(7.1, 3.7); t *= 1.15; amp *= 0.5;            // next octave
  }
  float s = clamp((sum / wsum - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  return vec4(mix(u_colorA, u_colorB, s), 1.0);
}`,
  },

  /* ─ GRADIENT: linear / radial / angular / diamond, can spin and flow ─ */
  gradient: {
    label: 'Gradient', inputs: 0,
    params: [
      S('shape', 'Shape', ['Linear', 'Radial', 'Angular', 'Diamond'], 0),
      R('angle', 'Angle (°)', 0, 360, 1, 0),
      R('spin', 'Spin (turns/sec)', -2, 2, .01, 0),
      R('flow', 'Flow (cycles/sec)', -2, 2, .01, 0),
      R('scale', 'Scale', .2, 4, .01, 1),
      T('loop', 'Loop (ping-pong)', false),
      C('colorA', 'Color A', '#12002e'),
      C('colorB', 'Color B', '#ff6ec7'),
    ],
    frag: `
uniform float u_shape, u_angle, u_spin, u_flow, u_scale, u_loop;
uniform vec3 u_colorA, u_colorB;
vec4 effect(vec2 uv){
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float a = radians(u_angle) + u_time * u_spin * 6.28318;
  float t;
  if (u_shape < 0.5)      t = dot(p, vec2(cos(a), sin(a))) * u_scale + 0.5;
  else if (u_shape < 1.5) t = length(p) * 2.0 * u_scale;
  else if (u_shape < 2.5) t = fract((atan(p.y, p.x) - a) / 6.28318);
  else                    t = (abs(p.x) + abs(p.y)) * 2.0 * u_scale;
  t += u_time * u_flow;
  t = u_loop > 0.5 ? 1.0 - abs(mod(t, 2.0) - 1.0) : clamp(t, 0.0, 1.0);
  return vec4(mix(u_colorA, u_colorB, t), 1.0);
}`,
  },

  /* ─ SOLID: constant colour ─ */
  solid: {
    label: 'Solid Color', inputs: 0,
    params: [C('color', 'Color', '#ff3366'), R('alpha', 'Opacity', 0, 1, .01, 1)],
    frag: `
uniform vec3 u_color; uniform float u_alpha;
vec4 effect(vec2 uv){ return vec4(u_color, u_alpha); }`,
  },

  /* ══════════════════════ ANIMATED / DISTORT FILTERS ══════════════════════ */

  /* ─ TRANSFORM: move / rotate / scale, with continuous spin ─ */
  transform: {
    label: 'Transform',
    params: [
      R('tx', 'Translate X', -1, 1, .001, 0),
      R('ty', 'Translate Y', -1, 1, .001, 0),
      R('rotate', 'Rotate (°)', -180, 180, .1, 0),
      R('spin', 'Spin (°/sec)', -180, 180, .5, 0),
      R('scale', 'Scale', .1, 4, .01, 1),
      S('edge', 'Edges', ['Mirror', 'Clamp', 'Repeat', 'Transparent'], 0),
    ],
    frag: `
uniform float u_tx, u_ty, u_rotate, u_spin, u_scale, u_edge;
vec4 effect(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0) - vec2(u_tx * asp, u_ty);
  float a = radians(u_rotate + u_spin * u_time), s = sin(a), c = cos(a);
  p = mat2(c, -s, s, c) * p / u_scale;              // inverse transform: where does this pixel come from?
  vec2 q = p / vec2(asp, 1.0) + 0.5;
  if (u_edge < 0.5)      q = mirrorUV(q);
  else if (u_edge > 1.5 && u_edge < 2.5) q = fract(q);
  else if (u_edge > 2.5 && (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0)) return vec4(0.0);
  return texture(u_tex, q);
}`,
  },

  /* ─ KALEIDOSCOPE ─ */
  kaleido: {
    label: 'Kaleidoscope',
    params: [
      R('segments', 'Segments', 2, 24, 1, 6),
      R('rotate', 'Rotate (°)', 0, 360, 1, 0),
      R('spin', 'Spin (°/sec)', -180, 180, .5, 20),
      R('zoom', 'Zoom', .3, 4, .01, 1),
      R('cx', 'Center X', 0, 1, .005, .5),
      R('cy', 'Center Y', 0, 1, .005, .5),
    ],
    frag: `
uniform float u_segments, u_rotate, u_spin, u_zoom, u_cx, u_cy;
vec4 effect(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 c = vec2(u_cx, u_cy);
  vec2 p = (uv - c) * vec2(asp, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) + radians(u_rotate + u_spin * u_time);
  float seg = 6.28318 / u_segments;
  a = mod(a, seg);                                   // wrap the angle into one wedge...
  a = abs(a - seg * 0.5);                            // ...and mirror it, so wedges reflect each other
  vec2 q = vec2(cos(a), sin(a)) * r / u_zoom;
  return texture(u_tex, mirrorUV(vec2(q.x / asp, q.y) + c));
}`,
  },

  /* ─ RIPPLE: concentric waves from a point ─ */
  ripple: {
    label: 'Ripple',
    params: [
      R('amount', 'Amount', 0, .1, .001, .02),
      R('freq', 'Frequency', 1, 80, .5, 20),
      R('speed', 'Speed', -10, 10, .1, 3),
      R('falloff', 'Falloff', 0, 4, .05, 1.5),
      R('cx', 'Center X', 0, 1, .005, .5),
      R('cy', 'Center Y', 0, 1, .005, .5),
    ],
    frag: `
uniform float u_amount, u_freq, u_speed, u_falloff, u_cx, u_cy;
vec4 effect(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 p = (uv - vec2(u_cx, u_cy)) * vec2(asp, 1.0);
  float r = length(p);
  vec2 dir = p / (r + 1e-5);
  float w = sin(r * u_freq - u_time * u_speed) * u_amount * exp(-r * u_falloff);   // travelling wave
  return texture(u_tex, mirrorUV(uv + vec2(dir.x / asp, dir.y) * w));
}`,
  },

  /* ─ WAVE: rows / columns sway like a flag ─ */
  wave: {
    label: 'Wave',
    params: [
      R('amount', 'Amount', 0, .1, .001, .02),
      R('freq', 'Frequency', .5, 40, .1, 6),
      R('speed', 'Speed', -8, 8, .05, 2),
      S('dir', 'Direction', ['Horizontal sway', 'Vertical sway'], 0),
    ],
    frag: `
uniform float u_amount, u_freq, u_speed, u_dir;
vec4 effect(vec2 uv){
  vec2 q = uv;
  if (u_dir < 0.5) q.x += sin(uv.y * u_freq * 6.28318 + u_time * u_speed) * u_amount;
  else             q.y += sin(uv.x * u_freq * 6.28318 + u_time * u_speed) * u_amount;
  return texture(u_tex, mirrorUV(q));
}`,
  },

  /* ─ TWIRL: swirl around a centre, optionally swaying back and forth ─ */
  twirl: {
    label: 'Twirl',
    params: [
      R('angle', 'Angle (°)', -720, 720, 1, 180),
      R('radius', 'Radius', .05, 1.5, .01, .6),
      R('sway', 'Sway speed', 0, 4, .01, .5),
      R('cx', 'Center X', 0, 1, .005, .5),
      R('cy', 'Center Y', 0, 1, .005, .5),
    ],
    frag: `
uniform float u_angle, u_radius, u_sway, u_cx, u_cy;
vec4 effect(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 p = (uv - vec2(u_cx, u_cy)) * vec2(asp, 1.0);
  float k = 1.0 - smoothstep(0.0, u_radius, length(p));            // 1 at the centre, 0 at the radius
  float a = radians(u_angle) * k * k * (u_sway > 0.0 ? sin(u_time * u_sway * 6.28318) : 1.0);
  float s = sin(a), c = cos(a);
  p = mat2(c, -s, s, c) * p;
  return texture(u_tex, mirrorUV(p / vec2(asp, 1.0) + vec2(u_cx, u_cy)));
}`,
  },

  /* ─ MIRROR ─ */
  mirror: {
    label: 'Mirror',
    params: [
      S('mode', 'Mode', ['Left → Right', 'Right → Left', 'Top → Bottom', 'Bottom → Top', 'Quad'], 0),
      R('center', 'Center', .1, .9, .005, .5),
    ],
    frag: `
uniform float u_mode, u_center;
vec4 effect(vec2 uv){
  vec2 q = uv; float c = u_center;
  if (u_mode < 0.5)      { if (q.x > c) q.x = 2.0 * c - q.x; }
  else if (u_mode < 1.5) { if (q.x < c) q.x = 2.0 * c - q.x; }
  else if (u_mode < 2.5) { if (q.y < c) q.y = 2.0 * c - q.y; }     // GL y=0 is the bottom
  else if (u_mode < 3.5) { if (q.y > c) q.y = 2.0 * c - q.y; }
  else { if (q.x > c) q.x = 2.0 * c - q.x; if (q.y > c) q.y = 2.0 * c - q.y; }
  return texture(u_tex, mirrorUV(q));
}`,
  },

  /* ─ TILE: repeat the image and scroll it ─ */
  tile: {
    label: 'Tile',
    params: [
      R('rx', 'Repeat X', 1, 12, .01, 2),
      R('ry', 'Repeat Y', 1, 12, .01, 2),
      R('sx', 'Scroll X (cycles/sec)', -2, 2, .01, .1),
      R('sy', 'Scroll Y (cycles/sec)', -2, 2, .01, 0),
      T('mirror', 'Mirror tiles', false),
    ],
    frag: `
uniform float u_rx, u_ry, u_sx, u_sy, u_mirror;
vec4 effect(vec2 uv){
  vec2 t = uv * vec2(u_rx, u_ry) + vec2(u_sx, u_sy) * u_time;
  return texture(u_tex, u_mirror > 0.5 ? mirrorUV(t) : fract(t));
}`,
  },

  /* ─ GLITCH: random horizontal bands jump sideways + colour split ─ */
  glitch: {
    label: 'Glitch',
    params: [
      R('intensity', 'Intensity', 0, 1, .01, .4),
      R('rate', 'Rate (steps/sec)', 0, 30, .5, 8),
      R('bands', 'Bands', 4, 80, 1, 24),
      R('split', 'Color split (px)', 0, 30, .5, 6),
    ],
    frag: `
uniform float u_intensity, u_rate, u_bands, u_split;
vec4 effect(vec2 uv){
  float step_ = floor(u_time * u_rate);               // the pattern re-rolls this many times per second
  float band = floor(uv.y * u_bands);
  float on = step(1.0 - u_intensity, hash13(vec3(band, step_, 1.0)));       // is this band glitching now?
  float shift = (hash13(vec3(band, step_, 7.0)) - 0.5) * 0.3 * on;
  vec2 g = vec2(uv.x + shift, uv.y);
  float sp = on * u_split * u_px / u_res.x;
  float r = texture(u_tex, mirrorUV(g + vec2(sp, 0.0))).r;
  vec4 m = texture(u_tex, mirrorUV(g));
  float b = texture(u_tex, mirrorUV(g - vec2(sp, 0.0))).b;
  return vec4(r, m.g, b, m.a);
}`,
  },

  /* ─ CRT: scanlines, curvature, phosphor mask, flicker, rolling bar ─ */
  crt: {
    label: 'CRT Monitor',
    params: [
      R('scan', 'Scanlines', 0, 1, .01, .45),
      R('lineSize', 'Line size (px)', 1, 8, .5, 3),
      R('curve', 'Curvature', 0, 1, .01, .3),
      R('mask', 'Phosphor mask', 0, 1, .01, .25),
      R('flicker', 'Flicker', 0, 1, .01, .2),
      R('roll', 'Rolling bar', 0, 1, .01, .3),
      R('vig', 'Vignette', 0, 1, .01, .4),
    ],
    frag: `
uniform float u_scan, u_lineSize, u_curve, u_mask, u_flicker, u_roll, u_vig;
vec4 effect(vec2 uv){
  vec2 cc = uv * 2.0 - 1.0;
  cc *= 1.0 + dot(cc, cc) * u_curve * 0.15;           // barrel distortion
  vec2 s = cc * 0.5 + 0.5;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec4 c = texture(u_tex, s);
  float y = s.y * u_res.y / max(u_lineSize * u_px, 1.0);
  c.rgb *= 1.0 - u_scan * (0.5 - 0.5 * sin(y * 6.28318));          // dark gaps between scanlines
  float m = mod(floor(gl_FragCoord.x), 3.0);
  vec3 mk = vec3(m < 1.0 ? 1.0 : 0.55, (m >= 1.0 && m < 2.0) ? 1.0 : 0.55, m >= 2.0 ? 1.0 : 0.55);
  c.rgb = mix(c.rgb, c.rgb * mk * 1.25, u_mask);       // RGB phosphor triads
  c.rgb *= 1.0 + u_flicker * (hash13(vec3(0.0, floor(u_time * 30.0), 3.0)) - 0.5) * 0.25;
  c.rgb *= 1.0 + u_roll * 0.35 * smoothstep(0.85, 1.0, fract(s.y + u_time * 0.12));   // slow bright bar
  c.rgb *= 1.0 - u_vig * dot(cc, cc) * 0.3;
  return c;
}`,
  },

  /* ─ PULSE: an LFO drives brightness / saturation / zoom / invert ─ */
  pulse: {
    label: 'Pulse / Strobe',
    params: [
      S('target', 'Drives', ['Brightness', 'Saturation', 'Zoom', 'Invert flash'], 0),
      R('rate', 'Rate (Hz)', 0, 10, .01, 1),
      R('depth', 'Depth', 0, 1, .01, .5),
      S('shape', 'Shape', ['Sine', 'Square', 'Saw', 'Bounce'], 0),
    ],
    frag: `
uniform float u_target, u_rate, u_depth, u_shape;
vec4 effect(vec2 uv){
  float x = u_time * u_rate;
  float w;                                            // LFO value 0..1
  if (u_shape < 0.5)      w = 0.5 + 0.5 * sin(x * 6.28318);
  else if (u_shape < 1.5) w = step(0.5, fract(x));
  else if (u_shape < 2.5) w = fract(x);
  else                    w = abs(sin(x * 3.14159));
  float k = (w * 2.0 - 1.0) * u_depth;               // -depth..+depth
  if (u_target > 2.5) { vec4 c = texture(u_tex, uv); return vec4(mix(c.rgb, 1.0 - c.rgb, w * u_depth), c.a); }
  if (u_target > 1.5) { vec2 q = (uv - 0.5) / (1.0 + k * 0.4) + 0.5; return texture(u_tex, mirrorUV(q)); }
  vec4 c = texture(u_tex, uv);
  if (u_target > 0.5) return vec4(mix(vec3(luma(c.rgb)), c.rgb, 1.0 + k * 2.0), c.a);
  return vec4(c.rgb * (1.0 + k), c.a);
}`,
  },

  /* ─ COLOR CYCLE: hue rotates continuously; can vary across the frame ─ */
  colorcycle: {
    label: 'Color Cycle',
    params: [
      R('speed', 'Speed (°/sec)', -360, 360, 1, 60),
      R('spread', 'Spread', 0, 2, .01, .3),
      S('by', 'Spread by', ['Position', 'Brightness', 'Distance from center'], 0),
      R('sat', 'Saturation boost', 0, 3, .01, 1.2),
    ],
    frag: `
uniform float u_speed, u_spread, u_by, u_sat;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  float f = u_by < 0.5 ? (uv.x + uv.y) * 0.5 : (u_by < 1.5 ? luma(c.rgb) : length(uv - 0.5) * 1.4);
  vec3 hsv = rgb2hsv(max(c.rgb, 0.0));
  hsv.x = fract(hsv.x + u_speed * u_time / 360.0 + u_spread * f);
  hsv.y = clamp(hsv.y * u_sat, 0.0, 1.0);             // note: pure greys have no hue to rotate
  return vec4(hsv2rgb(hsv), c.a);
}`,
  },

  /* ─ VIGNETTE ─ */
  vignette: {
    label: 'Vignette',
    params: [
      R('amount', 'Amount', 0, 1, .01, .6),
      R('size', 'Size', .1, 1.5, .01, .75),
      R('soft', 'Softness', .01, 1, .01, .5),
      R('breathe', 'Breathe (Hz)', 0, 2, .01, 0),
      C('color', 'Color', '#000000'),
    ],
    frag: `
uniform float u_amount, u_size, u_soft, u_breathe;
uniform vec3 u_color;
vec4 effect(vec2 uv){
  vec4 c = texture(u_tex, uv);
  float d = length((uv - 0.5) * vec2(u_res.x / u_res.y, 1.0)) ;
  float sz = u_size * (1.0 + 0.08 * sin(u_time * u_breathe * 6.28318));
  float v = 1.0 - smoothstep(sz - u_soft, sz, d);
  return vec4(mix(u_color, c.rgb, mix(1.0, v, u_amount)), c.a);
}`,
  },

  /* ─ HALFTONE: dot screen, optionally rotating ─ */
  halftone: {
    label: 'Halftone',
    params: [
      R('size', 'Dot spacing (px)', 3, 40, .5, 10),
      R('angle', 'Angle (°)', 0, 90, 1, 45),
      R('spin', 'Spin (°/sec)', -90, 90, .5, 0),
      R('soft', 'Softness', 0, 1, .01, .2),
      S('mode', 'Style', ['Black on white', 'White on black', 'Color dots'], 2),
    ],
    frag: `
uniform float u_size, u_angle, u_spin, u_soft, u_mode;
vec4 effect(vec2 uv){
  float cell = max(u_size * u_px, 2.0);
  float a = radians(u_angle + u_spin * u_time), s = sin(a), c = cos(a);
  mat2 R = mat2(c, -s, s, c);
  vec2 q = R * (uv * u_res) / cell;                   // rotated grid coordinates
  vec2 g = fract(q) - 0.5;                            // position inside the cell
  vec2 centerPx = transpose(R) * ((floor(q) + 0.5) * cell);   // cell centre back in screen pixels
  vec4 src = texture(u_tex, clamp(centerPx / u_res, 0.0, 1.0));
  float l = clamp(luma(src.rgb), 0.0, 1.0);
  float rad = sqrt(u_mode < 0.5 ? 1.0 - l : l) * 0.72;   // dot radius grows with ink amount
  float m = 1.0 - smoothstep(rad - u_soft * 0.2 - 0.01, rad + u_soft * 0.2 + 0.01, length(g));
  vec3 outc = u_mode < 0.5 ? vec3(1.0 - m) : (u_mode < 1.5 ? vec3(m) : src.rgb * m);
  return vec4(outc, src.a);
}`,
  },

  /* ─ RADIAL BLUR: zoom or spin blur from a centre point ─ */
  radialblur: {
    label: 'Radial Blur',
    params: [
      S('mode', 'Mode', ['Zoom', 'Spin'], 0),
      R('strength', 'Strength', 0, 1, .01, .3),
      R('cx', 'Center X', 0, 1, .005, .5),
      R('cy', 'Center Y', 0, 1, .005, .5),
    ],
    frag: `
uniform float u_mode, u_strength, u_cx, u_cy;
vec4 effect(vec2 uv){
  float asp = u_res.x / u_res.y;
  vec2 c = vec2(u_cx, u_cy);
  vec2 p = (uv - c) * vec2(asp, 1.0);
  vec4 acc = vec4(0.0);
  const int N = 24;
  for (int i = 0; i < N; i++) {
    float f = float(i) / float(N - 1);
    vec2 q;
    if (u_mode < 0.5) q = p * (1.0 - u_strength * 0.5 * f);           // step toward the centre
    else { float a = u_strength * 0.5 * (f - 0.5), s = sin(a), co = cos(a); q = mat2(co, -s, s, co) * p; }
    acc += texture(u_tex, mirrorUV(q / vec2(asp, 1.0) + c));
  }
  return acc / float(N);
}`,
  },

  /* ═════════════════════ MULTI-INPUT (COMPOSITING) NODES ═════════════════════ */

  /* ─ COMPOSITE: A underneath, B on top ─ */
  composite: {
    label: 'Composite', inputs: 2, inputNames: ['A · base', 'B · top'],
    params: [
      S('blend', 'Blend', ['Over', 'Add', 'Screen', 'Multiply', 'Overlay', 'Difference', 'Lighten', 'Darken'], 0),
      R('opacity', 'Opacity', 0, 1, .01, 1),
    ],
    frag: `
uniform sampler2D u_tex2;
uniform float u_blend, u_opacity;
vec4 effect(vec2 uv){
  vec4 a = texture(u_tex, uv), b = texture(u_tex2, uv);
  vec3 x = a.rgb, y = b.rgb, bl;
  if (u_blend < 0.5)      bl = y;
  else if (u_blend < 1.5) bl = x + y;
  else if (u_blend < 2.5) bl = 1.0 - (1.0 - x) * (1.0 - y);
  else if (u_blend < 3.5) bl = x * y;
  else if (u_blend < 4.5) bl = mix(2.0 * x * y, 1.0 - 2.0 * (1.0 - x) * (1.0 - y), step(0.5, x));
  else if (u_blend < 5.5) bl = abs(x - y);
  else if (u_blend < 6.5) bl = max(x, y);
  else                    bl = min(x, y);
  float k = b.a * u_opacity;                           // B's alpha (e.g. from a chroma key) controls coverage
  return vec4(mix(x, bl, k), k + a.a * (1.0 - k));
}`,
  },

  /* ─ MASK MIX: blend A and B using the brightness of a third image ─ */
  maskmix: {
    label: 'Mask Mix', inputs: 3, inputNames: ['A', 'B', 'Mask'],
    params: [
      R('low', 'Mask low', 0, 1, .01, 0),
      R('high', 'Mask high', 0, 1, .01, 1),
      T('invert', 'Invert mask', false),
    ],
    frag: `
uniform sampler2D u_tex2, u_tex3;
uniform float u_low, u_high, u_invert;
vec4 effect(vec2 uv){
  float m = luma(texture(u_tex3, uv).rgb);
  if (u_invert > 0.5) m = 1.0 - m;
  m = smoothstep(u_low, max(u_high, u_low + 1e-3), m);
  return mix(texture(u_tex, uv), texture(u_tex2, uv), m);
}`,
  },

  /* ─ DISPLACE MAP: push pixels around using another image as the vector field ─ */
  displacemap: {
    label: 'Displace Map', inputs: 2, inputNames: ['Image', 'Map'],
    params: [
      R('amount', 'Amount', 0, .3, .001, .05),
      S('mode', 'Map channels', ['Red → X, Green → Y', 'Brightness → X + Y', 'Brightness → X', 'Brightness → Y'], 0),
    ],
    frag: `
uniform sampler2D u_tex2;
uniform float u_amount, u_mode;
vec4 effect(vec2 uv){
  vec4 m = texture(u_tex2, uv);
  float l = luma(m.rgb);
  vec2 d = u_mode < 0.5 ? m.rg - 0.5 : (u_mode < 1.5 ? vec2(l - 0.5) : (u_mode < 2.5 ? vec2(l - 0.5, 0.0) : vec2(0.0, l - 0.5)));
  return texture(u_tex, mirrorUV(uv + d * 2.0 * u_amount));
}`,
  },

  /* ═════════════════════════ GRAPH ENDPOINTS ═════════════════════════════ */
  // 'source' hands the uploaded media to the graph; 'output' is what gets shown and exported.
  source: {
    label: 'Media In', inputs: 0, io: true,
    params: [{ type: 'note', text: 'The image or video you uploaded. Connect its output port to the effects you want to apply. You can add several Media In nodes to use the original in more than one place.' }],
  },
  output: {
    label: 'Output', inputs: 1, io: true,
    params: [
      S('bg', 'Background behind transparency', ['Checkerboard', 'Black', 'White', 'Green', 'Custom'], 0),
      C('bgColor', 'Background color', '#ff00ff', { showIf: p => p.bg === 4 }),
      { type: 'note', text: 'Whatever is connected here is what you see and export. Checkerboard is preview-only: PNGs keep real transparency; videos use black.' },
    ],
  },
};

// Node categories: label + accent colour (used by node headers, wires, the add-menu).
const CATS = {
  io:      { label: 'Input / Output', color: '#94a3b8' },
  gen:     { label: 'Generators',     color: '#a3e635' },
  color:   { label: 'Color',          color: '#fbbf24' },
  blur:    { label: 'Blur & Glow',    color: '#a78bfa' },
  stylize: { label: 'Stylize',        color: '#f472b6' },
  distort: { label: 'Distort',        color: '#fb923c' },
  time:    { label: 'Time & Trails',  color: '#2dd4bf' },
  comp:    { label: 'Composite',      color: '#38bdf8' },
};
// category, one-line description and "animated" flag for every node type
const META = {
  source:     { cat: 'io',      desc: 'The uploaded image or video.' },
  output:     { cat: 'io',      desc: 'What you see and export.' },
  noise:      { cat: 'gen',     desc: 'Animated fractal noise field.', anim: true },
  gradient:   { cat: 'gen',     desc: 'Linear, radial or angular gradient that can spin and flow.', anim: true },
  solid:      { cat: 'gen',     desc: 'A flat colour.' },
  level:      { cat: 'color',   desc: 'Brightness, contrast, gamma, exposure.' },
  hsv:        { cat: 'color',   desc: 'Hue, saturation and value.' },
  mono:       { cat: 'color',   desc: 'Monochrome in any colour.' },
  lookup:     { cat: 'color',   desc: 'Map brightness through a gradient.' },
  threshold:  { cat: 'color',   desc: 'Black & white or posterize.' },
  colorcycle: { cat: 'color',   desc: 'Continuously rotating hues.', anim: true },
  pulse:      { cat: 'color',   desc: 'LFO-driven brightness, saturation, zoom or strobe.', anim: true },
  blur:       { cat: 'blur',    desc: 'Gaussian blur.' },
  lumablur:   { cat: 'blur',    desc: 'Blur driven by brightness.' },
  radialblur: { cat: 'blur',    desc: 'Zoom or spin blur.' },
  bloom:      { cat: 'blur',    desc: 'Glow around bright areas.' },
  edge:       { cat: 'stylize', desc: 'Sobel edge detection.' },
  convolve:   { cat: 'stylize', desc: 'Sharpen, emboss, edge enhance.' },
  pixelate:   { cat: 'stylize', desc: 'Big square pixels.' },
  halftone:   { cat: 'stylize', desc: 'Print-style dot screen.', anim: true },
  crt:        { cat: 'stylize', desc: 'Scanlines, curvature, flicker.', anim: true },
  glitch:     { cat: 'stylize', desc: 'Digital band glitches.', anim: true },
  grain:      { cat: 'stylize', desc: 'Film grain.', anim: true },
  vignette:   { cat: 'stylize', desc: 'Darken (or tint) the corners.', anim: true },
  displace:   { cat: 'distort', desc: 'Warp with animated noise.', anim: true },
  rgbsplit:   { cat: 'distort', desc: 'Chromatic aberration.' },
  ripple:     { cat: 'distort', desc: 'Concentric travelling waves.', anim: true },
  wave:       { cat: 'distort', desc: 'Flag-like sway.', anim: true },
  twirl:      { cat: 'distort', desc: 'Swirl around a point.', anim: true },
  kaleido:    { cat: 'distort', desc: 'Mirrored wedges that spin.', anim: true },
  mirror:     { cat: 'distort', desc: 'Reflect one side onto the other.' },
  tile:       { cat: 'distort', desc: 'Repeat and scroll the image.', anim: true },
  transform:  { cat: 'distort', desc: 'Move, rotate, scale, spin.', anim: true },
  feedback:   { cat: 'time',    desc: 'Recursive trails and tunnels.', anim: true },
  cache:      { cat: 'time',    desc: 'Frame echo / ghosting.', anim: true },
  composite:  { cat: 'comp',    desc: 'Layer B over A with blend modes.' },
  maskmix:    { cat: 'comp',    desc: 'Mix A and B using a mask image.' },
  displacemap:{ cat: 'comp',    desc: 'Warp an image using another image.' },
  chroma:     { cat: 'comp',    desc: 'Key out a colour (green screen).' },
};
Object.keys(META).forEach(k => Object.assign(EFFECTS[k], META[k]));

// order of nodes in the add-menu (grouped by category)
const EFFECT_ORDER = [
  'source', 'noise', 'gradient', 'solid',
  'level', 'hsv', 'mono', 'lookup', 'threshold', 'colorcycle', 'pulse',
  'blur', 'lumablur', 'radialblur', 'bloom',
  'edge', 'convolve', 'pixelate', 'halftone', 'crt', 'glitch', 'grain', 'vignette',
  'displace', 'rgbsplit', 'ripple', 'wave', 'twirl', 'kaleido', 'mirror', 'tile', 'transform',
  'feedback', 'cache',
  'composite', 'maskmix', 'displacemap', 'chroma',
];

/* ---------------------------------------------------------------------
 * 4. GRAPH MODEL + PIPELINE
 *
 * The project is a graph: every node has 0..3 input ports and one output.
 * node.inputs[i] holds the id of the node feeding input i (or null).
 * Each frame we walk backwards from the Output node (or the node you are
 * "viewing"), render every upstream node into an offscreen texture, and pass
 * the textures along the wires.
 * ------------------------------------------------------------------- */
const NODE_W = 190, HEAD_H = 34, ROW_H = 24;
const graph = {
  nodes: new Map(),      // id -> node
  nextId: 1,
  outputId: null,
  viewId: null,          // node shown in the preview instead of the Output (null = Output)
  selected: null,        // selected node id
  view: { x: 40, y: 40, k: 1 },   // pan/zoom of the node editor
};
const app = {
  source: null,          // {kind, el, w, h, name, tex, url}
  compare: false,        // Before/After held
  eyedrop: null,         // chroma node waiting for a preview click
  exporting: false,
  busy: false,           // renderer paused (full-size PNG export)
  muted: true,
  audio: null,
  t0: performance.now(),
};
const inputCount = def => (def.inputs == null ? 1 : def.inputs);
const allNodes = () => Array.from(graph.nodes.values());

/* --- pool of offscreen textures, handed out per frame ----------------- */
const pool = { free: [], all: new Set(), refs: new Map() };
function acquire() {
  let t = pool.free.pop();
  if (!t) { t = createTarget(env.w, env.h, env.half); t.pooled = true; pool.all.add(t); }
  return t;
}
function ref(t) { if (t.pooled) pool.refs.set(t, (pool.refs.get(t) || 0) + 1); }
function unref(t) {
  if (!t || !t.pooled) return;
  const c = (pool.refs.get(t) || 0) - 1;
  if (c <= 0) { pool.refs.delete(t); pool.free.push(t); } else pool.refs.set(t, c);
}
function freePool() {
  pool.all.forEach(deleteTarget); pool.all.clear(); pool.free = []; pool.refs.clear();
  if (env.blank) { deleteTarget(env.blank); env.blank = null; }
  env.temps.forEach(deleteTarget); env.temps = [];
}
/** A transparent black texture used when an input port has nothing connected. */
env.blankTarget = function () {
  if (!this.blank) {
    this.blank = createTarget(this.w, this.h, this.half);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blank.fbo);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  return this.blank;
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

/** Background behind transparency comes from the Output node's settings. */
function bgSettings() {
  const out = graph.nodes.get(graph.outputId);
  const bg = out ? out.params.bg : 0;
  return [
    { mode: 0, color: [0, 0, 0] }, { mode: 1, color: [0, 0, 0] }, { mode: 1, color: [1, 1, 1] },
    { mode: 1, color: [0, 1, 0] }, { mode: 1, color: hexToRgb(out ? out.params.bgColor : '#000000') },
  ][bg];
}

function disposeState(n) {
  const def = EFFECTS[n.type];
  if (def.dispose) def.dispose(n.state);
  n.state = {};
}
function setWorkSize(w, h) {
  freePool();
  allNodes().forEach(disposeState);
  env.w = w; env.h = h; env.px = h / 1080;
  env.half = HALF_OK && w * h <= 8e6;               // huge exports fall back to 8-bit to save memory
  canvas.width = w; canvas.height = h;
  CANVAS_TARGET.w = w; CANVAS_TARGET.h = h;
  layout();
}
function resetStates() {                           // feedback / cache restart (used on seek)
  allNodes().forEach(n => { n.state.fresh = true; });
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
 * Evaluate the graph up to `rootId` and return the root's texture.
 * Textures are recycled as soon as their last consumer has run, so memory use
 * depends on the graph's width, not its size.
 */
function evaluate(rootId, srcT) {
  pool.free = Array.from(pool.all); pool.refs.clear();   // start every frame from a clean pool
  const order = [], seen = new Set();
  (function visit(id) {
    const n = graph.nodes.get(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    n.inputs.forEach(i => { if (i != null) visit(i); });
    order.push(n);
  })(rootId);

  const uses = new Map();                                // how many downstream nodes still need each result
  order.forEach(n => new Set(n.inputs.filter(i => i != null)).forEach(i => uses.set(i, (uses.get(i) || 0) + 1)));
  uses.set(rootId, (uses.get(rootId) || 0) + 1);         // keep the root alive for display

  const results = new Map();
  for (const n of order) {
    const def = EFFECTS[n.type], k = inputCount(def);
    const ins = [];
    for (let i = 0; i < k; i++) ins.push((n.inputs[i] != null && results.get(n.inputs[i])) || env.blankTarget());
    let out;
    if (n.type === 'source') out = srcT;
    else if (n.type === 'output') out = ins[0];
    else if (!n.enabled || n.broken) out = k > 0 ? ins[0] : env.blankTarget();   // bypass
    else {
      out = acquire();
      try {
        if (def.render) def.render(env, n, ins[0], out, ins);
        else {
          const texs = { u_tex: ins[0] || env.blankTarget() };
          if (k > 1) texs.u_tex2 = ins[1];
          if (k > 2) texs.u_tex3 = ins[2];
          env.run(def.frag, out, texs, env.paramUniforms(def, n.params));
        }
      } catch (e) {
        console.error(e);
        n.broken = true; pool.free.push(out);
        showNodeError(n, e.message);
        out = k > 0 ? ins[0] : env.blankTarget();     // skip the failed node, keep the graph running
      }
    }
    results.set(n.id, out); ref(out);
    new Set(n.inputs.filter(i => i != null)).forEach(i => {
      uses.set(i, uses.get(i) - 1);
      if (uses.get(i) === 0) unref(results.get(i));
    });
  }
  return results.get(rootId) || env.blankTarget();
}

/** Render one frame: graph -> canvas. */
function render(time, displayMode) {
  const s = app.source;
  if (!s) return;
  env.time = time; env.frame++;
  uploadSource();
  if (s.kind === 'video' && !s.uploaded) return;
  const srcT = { tex: s.tex, fbo: null, w: env.w, h: env.h };   // read-only view of the uploaded media
  let result;
  if (app.compare) result = srcT;                                // Before/After: skip the graph entirely
  else {
    const view = graph.nodes.has(graph.viewId) ? graph.viewId : graph.outputId;
    result = evaluate(view, srcT);
  }
  const bg = bgSettings();
  let mode = bg.mode;                                // 0 checker, 1 solid
  if (mode === 0 && displayMode === 'transparent') mode = 2;   // PNG export keeps the alpha channel
  if (mode === 0 && displayMode === 'solid') mode = 1;         // video can't hold a checkerboard: use black
  env.run(DISPLAY_FRAG, CANVAS_TARGET, { u_tex: result }, { u_bgMode: mode, u_bgColor: bg.color });
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
  allNodes().forEach(n => { n.broken = false; });
  refreshNodes();
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
 * 6. UI – node editor, inspector, controls
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
/* ---------------------------------------------------------------------
 * 6b. GRAPH OPERATIONS (create / connect / delete nodes)
 * ------------------------------------------------------------------- */
function makeNode(type, x = 0, y = 0, incoming, enabled = true) {
  const def = EFFECTS[type];
  const n = {
    id: graph.nextId++, type, x, y, enabled,
    params: incoming ? sanitizeParams(def, incoming) : defaultParams(def),
    inputs: new Array(inputCount(def)).fill(null),
    state: {}, broken: false, ui: null, el: null, label: def.label,
  };
  // unique, human-friendly names: "Blur", "Blur 2", "Blur 3"…
  const labels = new Set(allNodes().map(o => o.label));
  for (let i = 2; labels.has(n.label); i++) n.label = def.label + ' ' + i;
  graph.nodes.set(n.id, n);
  n.el = createNodeEl(n);
  $('#nodes').appendChild(n.el);
  return n;
}
function dependsOn(aId, bId, seen = new Set()) {   // does node a (transitively) read from node b?
  if (aId === bId) return true;
  if (seen.has(aId)) return false;
  seen.add(aId);
  const a = graph.nodes.get(aId);
  return !!a && a.inputs.some(i => i != null && dependsOn(i, bId, seen));
}
const canConnect = (fromId, toId) => fromId !== toId && !dependsOn(fromId, toId);
function connect(fromId, toId, idx) {
  const from = graph.nodes.get(fromId), to = graph.nodes.get(toId);
  if (!from || !to || from.type === 'output' || idx >= to.inputs.length) return false;
  if (!canConnect(fromId, toId)) { toast("That connection would create a loop, so it was ignored."); return false; }
  to.inputs[idx] = fromId;
  onGraphChanged();
  return true;
}
function disconnect(toId, idx) {
  const to = graph.nodes.get(toId);
  if (!to) return;
  to.inputs[idx] = null;
  onGraphChanged();
}
function removeNode(id) {
  const n = graph.nodes.get(id);
  if (!n || n.type === 'output') return;
  const bridge = n.inputs[0];                       // heal the chain: whatever fed this node now feeds its consumers
  allNodes().forEach(m => m.inputs.forEach((s, i) => {
    if (s === id) m.inputs[i] = bridge != null && canConnect(bridge, m.id) ? bridge : null;
  }));
  disposeState(n);
  n.el.remove();
  graph.nodes.delete(id);
  if (graph.selected === id) graph.selected = null;
  if (graph.viewId === id) graph.viewId = null;
  if (app.eyedrop === n) stopEyedrop();
  onGraphChanged();
}
function duplicateNode(id) {
  const n = graph.nodes.get(id);
  if (!n || n.type === 'output') return;
  const c = makeNode(n.type, n.x + 30, n.y + 40, clone(n.params), n.enabled);
  c.inputs = n.inputs.slice();
  select(c.id);
  onGraphChanged();
}
function clearGraph() {
  allNodes().forEach(n => { disposeState(n); n.el.remove(); });
  graph.nodes.clear();
  graph.selected = null; graph.viewId = null; graph.outputId = null;
  stopEyedrop();
}
function newGraph() {
  clearGraph();
  const s = makeNode('source', 40, 60), o = makeNode('output', 320, 60);
  graph.outputId = o.id; o.inputs[0] = s.id;
  select(null); onGraphChanged(); fitView();
}

/** Place a new node. ctx: {world:{x,y}} (right-click spot) and/or {connectFrom:id} (wire dropped on empty space). */
function addNodeSmart(type, ctx = {}) {
  const def = EFFECTS[type], out = graph.nodes.get(graph.outputId);
  let x, y, anchor = null;
  if (ctx.connectFrom != null) { anchor = graph.nodes.get(ctx.connectFrom); x = ctx.world.x; y = ctx.world.y - HEAD_H / 2; }
  else if (ctx.world) { x = ctx.world.x - NODE_W / 2; y = ctx.world.y - HEAD_H / 2; }
  else {
    // From the toolbar: continue the chain after the selected node, or at the end of the chain feeding Output.
    const sel = graph.nodes.get(graph.selected);
    anchor = sel && sel.type !== 'output' ? sel : (out && graph.nodes.get(out.inputs[0])) || null;
    if (anchor) { x = anchor.x + NODE_W + 56; y = anchor.y; }
    else { const r = gEl.getBoundingClientRect(), c = toWorld(r.left + r.width / 2, r.top + r.height / 2); x = c.x - NODE_W / 2; y = c.y - 30; }
  }
  const h = HEAD_H + ROW_H * Math.max(1, inputCount(def)) + 10;
  while (allNodes().some(o => x < o.x + NODE_W + 12 && x + NODE_W + 12 > o.x && y < o.y + nodeHeight(o) + 12 && y + h + 12 > o.y)) y += 40;   // avoid overlaps
  const n = makeNode(type, Math.round(x), Math.round(y));
  if (anchor && inputCount(def) > 0 && anchor.type !== 'output') {
    n.inputs[0] = anchor.id;
    // if the anchor was feeding the Output, the new node slots in before it
    if (ctx.connectFrom == null && out && out.inputs[0] === anchor.id) {
      out.inputs[0] = n.id;
      if (out.x < n.x + NODE_W + 40) { out.x = n.x + NODE_W + 56; out.y = n.y; positionEl(out); }
    }
  }
  select(n.id);
  onGraphChanged();
  return n;
}
const nodeHeight = n => HEAD_H + ROW_H * Math.max(1, n.inputs.length) + 10;

/** Left-to-right layout by depth; keeps chains straight. */
function autoLayout() {
  const nodes = allNodes(), depth = new Map();
  const d = n => {
    if (depth.has(n.id)) return depth.get(n.id);
    depth.set(n.id, 0);
    let m = 0;
    n.inputs.forEach(i => { if (i != null && graph.nodes.has(i)) m = Math.max(m, d(graph.nodes.get(i)) + 1); });
    depth.set(n.id, m);
    return m;
  };
  nodes.forEach(d);
  const cols = new Map();
  nodes.forEach(n => { const k = depth.get(n.id); if (!cols.has(k)) cols.set(k, []); cols.get(k).push(n); });
  [...cols.keys()].sort((a, b) => a - b).forEach(k => {
    const list = cols.get(k);
    list.forEach(n => {
      const ys = n.inputs.filter(i => i != null && graph.nodes.has(i)).map(i => graph.nodes.get(i).y);
      n._want = ys.length ? ys.reduce((a, b) => a + b) / ys.length : Infinity;
    });
    list.sort((a, b) => a._want - b._want);
    let free = 40;
    list.forEach(n => {
      n.x = 40 + k * (NODE_W + 72);
      n.y = Math.round(Math.max(isFinite(n._want) ? n._want : free, free));
      free = n.y + nodeHeight(n) + 26;
      delete n._want;
    });
  });
  nodes.forEach(positionEl);
  onGraphChanged();
}

/* ---------------------------------------------------------------------
 * 6c. NODE EDITOR (DOM + SVG)
 * ------------------------------------------------------------------- */
const gEl = $('#graph'), world = $('#world'), svg = $('#wires');
const SVGNS = 'http://www.w3.org/2000/svg';

function applyView() {
  const v = graph.view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  gEl.style.backgroundSize = `${24 * v.k}px ${24 * v.k}px`;
  gEl.style.backgroundPosition = `${v.x}px ${v.y}px`;
  $('#zoomLbl').textContent = Math.round(v.k * 100) + '%';
}
function toWorld(cx, cy) {
  const r = gEl.getBoundingClientRect();
  return { x: (cx - r.left - graph.view.x) / graph.view.k, y: (cy - r.top - graph.view.y) / graph.view.k };
}
function fitView() {
  const nodes = allNodes();
  if (!nodes.length) return;
  const r = gEl.getBoundingClientRect();
  if (r.width < 50) return;
  const x0 = Math.min(...nodes.map(n => n.x)), x1 = Math.max(...nodes.map(n => n.x + NODE_W));
  const y0 = Math.min(...nodes.map(n => n.y)), y1 = Math.max(...nodes.map(n => n.y + nodeHeight(n)));
  const k = clamp(Math.min((r.width - 80) / (x1 - x0), (r.height - 80) / (y1 - y0)), .3, 1);
  graph.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
  applyView();
}

function positionEl(n) { n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; }

function createNodeEl(n) {
  const def = EFFECTS[n.type];
  const e = el('div', 'node');
  e.dataset.id = n.id;
  e.style.setProperty('--cat', CATS[def.cat].color);
  e.style.width = NODE_W + 'px';

  const head = el('div', 'node-head');
  n.titleEl = el('span', 'node-title', n.label);
  head.append(el('span', 'node-dot'), n.titleEl);
  if (!def.io) {
    const b = el('button', 'node-btn bypass', '⏻'); b.dataset.act = 'bypass'; b.title = 'Bypass – pass the input straight through';
    head.appendChild(b);
  }
  if (n.type !== 'output') {
    const v = el('button', 'node-btn view', '◉'); v.dataset.act = 'view'; v.title = 'Preview this node';
    head.appendChild(v);
  }
  e.appendChild(head);

  const k = inputCount(def), rows = Math.max(1, k);
  for (let i = 0; i < rows; i++) {
    const row = el('div', 'node-row');
    const left = el('span', 'row-l');
    if (i < k) {
      const p = el('span', 'port in'); p.dataset.node = n.id; p.dataset.kind = 'in'; p.dataset.idx = i;
      row.appendChild(p);
      left.textContent = (def.inputNames && def.inputNames[i]) || (k > 1 ? 'In ' + (i + 1) : 'In');
    }
    row.appendChild(left);
    if (i === 0 && n.type !== 'output') {
      row.appendChild(el('span', 'row-r', 'Out'));
      const p = el('span', 'port out'); p.dataset.node = n.id; p.dataset.kind = 'out'; p.dataset.idx = 0;
      row.appendChild(p);
    }
    e.appendChild(row);
  }
  n.el = e;
  positionEl(n);
  return e;
}

function refreshNodes() {
  const used = new Set();
  allNodes().forEach(n => n.inputs.forEach(i => { if (i != null) used.add(i); }));
  allNodes().forEach(n => {
    const e = n.el;
    e.classList.toggle('sel', graph.selected === n.id);
    e.classList.toggle('off', !n.enabled);
    e.classList.toggle('has-err', !!n.broken);
    e.classList.toggle('viewing', graph.viewId === n.id);
    e.querySelectorAll('.port.in').forEach(p => p.classList.toggle('on', n.inputs[+p.dataset.idx] != null));
    const o = e.querySelector('.port.out');
    if (o) o.classList.toggle('on', used.has(n.id));
  });
}

function portPos(n, kind, idx) {
  return { x: n.x + (kind === 'out' ? NODE_W : 0), y: n.y + HEAD_H + ROW_H * (kind === 'out' ? 0 : idx) + ROW_H / 2 };
}
function wirePath(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) * .5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
function drawWires() {
  svg.querySelectorAll('.wire-g').forEach(g => g.remove());
  const temp = svg.querySelector('#tempWire');
  for (const n of allNodes()) {
    n.inputs.forEach((sid, i) => {
      const s = graph.nodes.get(sid);
      if (!s) return;
      const d = wirePath(portPos(s, 'out', 0), portPos(n, 'in', i));
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'wire-g' + (graph.selected === s.id || graph.selected === n.id ? ' hl' : ''));
      g.style.setProperty('--cat', CATS[EFFECTS[s.type].cat].color);
      const hit = document.createElementNS(SVGNS, 'path'); hit.setAttribute('d', d); hit.setAttribute('class', 'wire-hit');
      const vis = document.createElementNS(SVGNS, 'path'); vis.setAttribute('d', d); vis.setAttribute('class', 'wire');
      g.append(hit, vis);
      g.addEventListener('dblclick', ev => { ev.stopPropagation(); disconnect(n.id, i); });
      g.title = 'Double-click to remove';
      svg.insertBefore(g, temp);
    });
  }
}
function onGraphChanged() {
  refreshNodes();
  drawWires();
  updateChip();
  renderInspector();
  $('#graphEmpty').hidden = allNodes().length > 0;
}

/* --- selection / viewing --------------------------------------------- */
function select(id) {
  graph.selected = id;
  refreshNodes(); drawWires(); renderInspector();
}
function toggleView(id) {
  graph.viewId = graph.viewId === id ? null : id;
  refreshNodes(); updateChip(); renderInspector();
}
function updateChip() {
  const chip = $('#viewChip'), v = graph.nodes.get(graph.viewId);
  chip.hidden = !v;
  if (v) $('#viewChipLbl').textContent = 'Previewing · ' + v.label;
}
function showNodeError(n, msg) {
  if (n.el) n.el.classList.add('has-err');
  if (n.ui && n.ui.errorEl) { n.ui.errorEl.textContent = 'This node failed and was skipped.\n' + msg; n.ui.errorEl.hidden = false; }
}

/* --- pointer interaction ---------------------------------------------- */
let drag = null;
gEl.addEventListener('pointerdown', e => {
  if (e.button === 2) return;
  closeMenu();
  if (e.target.closest('.node-btn') || e.target.closest('.wire-g') || e.target.closest('.graph-ui')) return;
  const port = e.target.closest('.port'), nodeEl = e.target.closest('.node');
  if (port) return startConnect(e, port);
  if (nodeEl) {
    const n = graph.nodes.get(+nodeEl.dataset.id);
    select(n.id);
    const w = toWorld(e.clientX, e.clientY);
    drag = { type: 'node', n, ox: w.x - n.x, oy: w.y - n.y };
    nodeEl.classList.add('dragging');
  } else drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: graph.view.x, vy: graph.view.y, moved: false };
  gEl.setPointerCapture(e.pointerId);
  if (drag.type === 'pan') gEl.classList.add('panning');
});

function startConnect(e, portEl) {
  const n = graph.nodes.get(+portEl.dataset.node), kind = portEl.dataset.kind, idx = +portEl.dataset.idx;
  if (kind === 'out') drag = { type: 'wire', fixed: 'out', id: n.id, fresh: true };
  else if (n.inputs[idx] != null) {                     // pick up an existing wire by its input end
    const src = n.inputs[idx];
    disconnect(n.id, idx);
    drag = { type: 'wire', fixed: 'out', id: src, fresh: false };
  } else drag = { type: 'wire', fixed: 'in', id: n.id, idx, fresh: false };
  gEl.setPointerCapture(e.pointerId);
  gEl.classList.add('wiring');
  drawTempWire(e);
}
function targetPort(e) {
  const p = document.elementFromPoint(e.clientX, e.clientY);
  return p && p.closest ? p.closest('.port') : null;
}
function portCompatible(portEl) {
  if (!portEl || !drag || drag.type !== 'wire') return false;
  const id = +portEl.dataset.node, kind = portEl.dataset.kind;
  if (drag.fixed === 'out') return kind === 'in' && canConnect(drag.id, id);
  return kind === 'out' && canConnect(id, drag.id);
}
function drawTempWire(e) {
  const t = $('#tempWire'), w = toWorld(e.clientX, e.clientY);
  const n = graph.nodes.get(drag.id);
  const a = drag.fixed === 'out' ? portPos(n, 'out', 0) : w, b = drag.fixed === 'out' ? w : portPos(n, 'in', drag.idx);
  t.setAttribute('d', wirePath(a, b));
  t.style.setProperty('--cat', CATS[EFFECTS[n.type].cat].color);
  gEl.querySelectorAll('.port.hot').forEach(p => p.classList.remove('hot'));
  const tp = targetPort(e);
  if (tp && portCompatible(tp)) tp.classList.add('hot');
}
gEl.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.type === 'node') {
    const w = toWorld(e.clientX, e.clientY);
    drag.n.x = Math.round(w.x - drag.ox); drag.n.y = Math.round(w.y - drag.oy);
    positionEl(drag.n); drawWires();
  } else if (drag.type === 'pan') {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    graph.view.x = drag.vx + dx; graph.view.y = drag.vy + dy; applyView();
  } else if (drag.type === 'wire') drawTempWire(e);
});
function endDrag(e, cancel) {
  if (!drag) return;
  const d = drag; drag = null;
  gEl.classList.remove('panning', 'wiring');
  gEl.querySelectorAll('.node.dragging').forEach(x => x.classList.remove('dragging'));
  gEl.querySelectorAll('.port.hot').forEach(p => p.classList.remove('hot'));
  $('#tempWire').setAttribute('d', '');
  if (cancel) { onGraphChanged(); return; }
  if (d.type === 'pan' && !d.moved) select(null);
  if (d.type === 'wire') {
    const tp = targetPort(e);
    if (tp) {
      drag = d;
      const ok = portCompatible(tp);
      drag = null;
      if (ok) {
        if (d.fixed === 'out') connect(d.id, +tp.dataset.node, +tp.dataset.idx);
        else connect(+tp.dataset.node, d.id, d.idx);
      } else onGraphChanged();
    } else if (d.fixed === 'out' && d.fresh && !(document.elementFromPoint(e.clientX, e.clientY) || {}).closest?.('.node')) {
      // dropped on empty canvas: offer to create a node that's already connected
      openMenu({ x: e.clientX, y: e.clientY, world: toWorld(e.clientX, e.clientY), connectFrom: d.id });
    } else onGraphChanged();
  }
}
gEl.addEventListener('pointerup', e => endDrag(e, false));
gEl.addEventListener('pointercancel', e => endDrag(e, true));

// click on the little buttons in a node header
gEl.addEventListener('click', e => {
  const b = e.target.closest('.node-btn');
  if (!b) return;
  const n = graph.nodes.get(+b.closest('.node').dataset.id);
  if (b.dataset.act === 'bypass') { n.enabled = !n.enabled; refreshNodes(); renderInspector(); }
  if (b.dataset.act === 'view') toggleView(n.id);
});
gEl.addEventListener('wheel', e => {
  e.preventDefault();
  const v = graph.view, r = gEl.getBoundingClientRect();
  const k0 = v.k, k1 = clamp(k0 * Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015)), .3, 1.8);
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  v.x = mx - (mx - v.x) * (k1 / k0); v.y = my - (my - v.y) * (k1 / k0); v.k = k1;
  applyView();
}, { passive: false });
gEl.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (e.target.closest('.node')) return;
  openMenu({ x: e.clientX, y: e.clientY, world: toWorld(e.clientX, e.clientY) });
});
gEl.addEventListener('dblclick', e => {
  if (e.target.closest('.node') || e.target.closest('.wire-g') || e.target.closest('.graph-ui')) return;
  openMenu({ x: e.clientX, y: e.clientY, world: toWorld(e.clientX, e.clientY) });
});

/* --- "add node" menu ---------------------------------------------------- */
const menu = $('#addMenu'), menuSearch = $('#menuSearch'), menuList = $('#menuList');
let menuCtx = null, menuItems = [], menuActive = 0;
function openMenu(ctx) {
  menuCtx = ctx;
  menu.hidden = false;
  menuSearch.value = '';
  buildMenu('');
  const r = menu.getBoundingClientRect();
  menu.style.left = clamp(ctx.x, 8, innerWidth - r.width - 8) + 'px';
  menu.style.top = clamp(ctx.y, 8, innerHeight - r.height - 8) + 'px';
  menuSearch.focus();
}
function closeMenu() { menu.hidden = true; menuCtx = null; }
function buildMenu(q) {
  menuList.innerHTML = ''; menuItems = [];
  q = q.trim().toLowerCase();
  Object.keys(CATS).forEach(cat => {
    const keys = EFFECT_ORDER.filter(k => EFFECTS[k].cat === cat &&
      (!q || (EFFECTS[k].label + ' ' + EFFECTS[k].desc + ' ' + CATS[cat].label).toLowerCase().includes(q)));
    if (!keys.length) return;
    menuList.appendChild(el('div', 'menu-cat', CATS[cat].label));
    keys.forEach(k => {
      const d = EFFECTS[k];
      const item = el('div', 'menu-item');
      item.style.setProperty('--cat', CATS[cat].color);
      const txt = el('div', 'menu-txt');
      txt.append(el('div', 'menu-name', d.label), el('div', 'menu-desc', d.desc));
      item.append(el('span', 'node-dot'), txt);
      if (d.anim) { const a = el('span', 'badge', 'animated'); item.appendChild(a); }
      item.addEventListener('pointerenter', () => setActive(menuItems.findIndex(m => m.k === k)));
      item.addEventListener('click', () => pickMenu(k));
      menuList.appendChild(item);
      menuItems.push({ k, item });
    });
  });
  if (!menuItems.length) menuList.appendChild(el('div', 'menu-empty', 'No matching nodes'));
  setActive(0);
}
function setActive(i) {
  menuActive = clamp(i, 0, Math.max(0, menuItems.length - 1));
  menuItems.forEach((m, j) => m.item.classList.toggle('active', j === menuActive));
  if (menuItems[menuActive]) menuItems[menuActive].item.scrollIntoView({ block: 'nearest' });
}
function pickMenu(type) {
  const ctx = menuCtx || {};
  closeMenu();
  addNodeSmart(type, ctx);
}
menuSearch.addEventListener('input', () => buildMenu(menuSearch.value));
menuSearch.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(menuActive + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(menuActive - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (menuItems[menuActive]) pickMenu(menuItems[menuActive].k); }
  else if (e.key === 'Escape') closeMenu();
});
document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'btnAddNode') closeMenu(); }, true);

/* ---------------------------------------------------------------------
 * 6d. INSPECTOR (parameters of the selected node)
 * ------------------------------------------------------------------- */
function renderInspector() {
  const box = $('#inspBody');
  box.innerHTML = '';
  const n = graph.nodes.get(graph.selected);
  allNodes().forEach(o => { if (o !== n) o.ui = null; });
  if (!n) {
    const e = el('div', 'insp-empty');
    e.append(el('div', 'insp-empty-title', 'Nothing selected'),
      el('p', null, 'Click a node to edit its parameters here.'),
      el('p', 'muted', 'Drag from a node’s output port (right) to another node’s input port (left) to connect them. Drop a wire on empty space to create a node already connected.'),
      el('p', 'muted', 'Right-click or double-click the canvas to add nodes. The ◉ button on a node previews it.'));
    box.appendChild(e);
    return;
  }
  const def = EFFECTS[n.type], cat = CATS[def.cat];
  n.ui = { controls: {}, rows: {}, errorEl: null };

  // header
  const head = el('div', 'insp-head');
  head.style.setProperty('--cat', cat.color);
  const titleRow = el('div', 'insp-title-row');
  titleRow.append(el('span', 'node-dot'), el('h2', null, n.label), el('span', 'pill', cat.label));
  head.appendChild(titleRow);
  head.appendChild(el('div', 'insp-desc', def.desc));
  const actions = el('div', 'insp-actions');
  if (!def.io) {
    const lab = el('label', 'byp'); lab.title = 'Turn the node off: its first input passes straight through';
    const sw = el('span', 'switch'); const chk = el('input'); chk.type = 'checkbox'; chk.checked = n.enabled;
    chk.addEventListener('change', () => { n.enabled = chk.checked; refreshNodes(); });
    sw.append(chk, el('span'));
    lab.append(sw, el('span', null, 'Enabled'));
    actions.appendChild(lab);
  }
  actions.appendChild(el('span', 'spacer'));
  if (n.type !== 'output') {
    const v = el('button', 'btn small' + (graph.viewId === n.id ? ' active' : ''), graph.viewId === n.id ? '◉ Previewing' : '◉ Preview');
    v.addEventListener('click', () => toggleView(n.id));
    actions.appendChild(v);
    const dup = el('button', 'btn small', 'Duplicate'); dup.addEventListener('click', () => duplicateNode(n.id));
    const del = el('button', 'btn small danger', 'Delete'); del.addEventListener('click', () => removeNode(n.id));
    actions.append(dup, del);
  }
  head.appendChild(actions);
  box.appendChild(head);

  // connections
  const k = inputCount(def);
  if (k > 0) {
    const sec = el('div', 'insp-sec');
    sec.appendChild(el('div', 'insp-sec-title', 'Inputs'));
    for (let i = 0; i < k; i++) {
      const r = el('div', 'conn-row');
      const src = graph.nodes.get(n.inputs[i]);
      r.appendChild(el('span', 'conn-name', (def.inputNames && def.inputNames[i]) || (k > 1 ? 'In ' + (i + 1) : 'In')));
      const val = el('span', 'conn-val' + (src ? '' : ' empty'), src ? src.label : 'not connected');
      r.appendChild(val);
      if (src) {
        const x = el('button', 'mini', '✕'); x.title = 'Disconnect'; x.addEventListener('click', () => disconnect(n.id, i));
        r.appendChild(x);
      }
      sec.appendChild(r);
    }
    box.appendChild(sec);
  }

  // parameters
  const params = def.params.filter(p => p.type !== 'note' || true);
  if (params.length) {
    const sec = el('div', 'insp-sec');
    if (params.some(p => p.type !== 'note')) sec.appendChild(el('div', 'insp-sec-title', 'Parameters'));
    params.forEach(pd => {
      const c = buildControl(n, pd);
      if (pd.key) { n.ui.controls[pd.key] = c; n.ui.rows[pd.key] = c.el; }
      sec.appendChild(c.el);
    });
    box.appendChild(sec);
  }
  n.ui.errorEl = el('div', 'err'); n.ui.errorEl.hidden = !n.broken;
  if (n.broken) n.ui.errorEl.textContent = 'This node failed and was skipped. Check the browser console for details.';
  box.appendChild(n.ui.errorEl);
  updateVisibility(n);
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
 * 7. PRESETS – built-in graphs and JSON save / load
 * ------------------------------------------------------------------- */
// A graph spec: {nodes:[{k:'key', type, params, in:['otherKey', ...]}], out:'key'}
// chain() turns a simple list of effects into Media In -> fx1 -> fx2 -> ... -> Output.
const fx = (type, params, enabled = true) => ({ type, params, enabled });
function chain(list) {
  const nodes = [{ k: 'src', type: 'source' }];
  list.forEach((s, i) => nodes.push({ k: 'n' + i, type: s.type, params: s.params, enabled: s.enabled, in: [i ? 'n' + (i - 1) : 'src'] }));
  return { nodes, out: list.length ? 'n' + (list.length - 1) : 'src' };
}
const BUILTIN_PRESETS = {
  'VHS glitch': chain([
    fx('level', { contrast: 1.15, brightness: .02 }),
    fx('hsv', { sat: .85 }),
    fx('displace', { amount: .012, scale: 6, speed: 1.6, direction: 0 }),
    fx('rgbsplit', { r: 9, g: 0, b: -9, angle: 0 }),
    fx('blur', { radius: 1.5 }),
    fx('grain', { amount: .35, size: 2 }),
  ]),
  'Thermal cam': chain([
    fx('level', { contrast: 1.25 }),
    fx('blur', { radius: 3 }),
    fx('lookup', { preset: 0 }),
    fx('grain', { amount: .12, size: 2 }),
  ]),
  'Neon outline': chain([
    fx('blur', { radius: 1.5 }),
    fx('edge', { strength: 3, threshold: .15, mode: 0, color: '#19f0ff' }),
    fx('bloom', { threshold: .3, intensity: 1.6, radius: 22 }),
    fx('hsv', { sat: 1.3 }),
  ]),
  'Dreamy glow': chain([
    fx('level', { exposure: .1, contrast: .95 }),
    fx('bloom', { threshold: .45, intensity: 1.1, radius: 45 }),
    fx('blur', { radius: 1.5 }),
    fx('hsv', { sat: 1.15 }),
    fx('grain', { amount: .08 }),
  ]),
  'Liquid warp': chain([
    fx('displace', { amount: .06, scale: 2.2, speed: .35, direction: 2 }),
    fx('rgbsplit', { r: 6, g: 0, b: -6, radial: true }),
    fx('bloom', { threshold: .6, intensity: .6, radius: 20 }),
  ]),
  'Psychedelic trails': chain([
    fx('feedback', { decay: .9, zoom: 1.02, rot: 2, hue: 8, blend: 0 }),
    fx('hsv', { sat: 1.3 }),
  ]),
  'Ghost echo': chain([
    fx('cache', { count: 12, spacing: 3, decay: .82, blend: 0 }),
    fx('bloom', { threshold: .7, intensity: .5, radius: 25 }),
  ]),
  'Kaleido trip': chain([
    fx('kaleido', { segments: 8, spin: 15, zoom: 1.2 }),
    fx('colorcycle', { speed: 40, spread: .4 }),
    fx('bloom', { threshold: .5, intensity: .8, radius: 25 }),
  ]),
  'Retro CRT': chain([
    fx('level', { contrast: 1.1, brightness: .02 }),
    fx('rgbsplit', { r: 3, g: 0, b: -3, radial: true }),
    fx('crt', {}),
    fx('grain', { amount: .1, size: 2 }),
  ]),
  'Halftone pop': chain([
    fx('hsv', { sat: 1.6 }),
    fx('halftone', { size: 9, mode: 2, spin: 8 }),
    fx('level', { contrast: 1.15 }),
  ]),
  'Liquid mirror': chain([
    fx('ripple', { amount: .03, freq: 25, speed: 4 }),
    fx('wave', { amount: .015, freq: 5, speed: 1.5 }),
    fx('mirror', { mode: 0 }),
  ]),
  'Noise melt (2 inputs)': {
    nodes: [
      { k: 'src', type: 'source' },
      { k: 'nz', type: 'noise', params: { scale: 2.5, speed: .25, octaves: 3, colorA: '#000000', colorB: '#ffffff' } },
      { k: 'dm', type: 'displacemap', params: { amount: .09, mode: 1 }, in: ['src', 'nz'] },
      { k: 'hs', type: 'hsv', params: { sat: 1.2 }, in: ['dm'] },
    ], out: 'hs',
  },
  'Glow composite (2 inputs)': {
    nodes: [
      { k: 'src', type: 'source' },
      { k: 'bl', type: 'blur', params: { radius: 30 }, in: ['src'] },
      { k: 'cp', type: 'composite', params: { blend: 2, opacity: 1 }, in: ['src', 'bl'] },
      { k: 'hs', type: 'hsv', params: { sat: 1.15 }, in: ['cp'] },
    ], out: 'hs',
  },
  'Spotlight (mask mix)': {
    nodes: [
      { k: 'src', type: 'source' },
      { k: 'dk', type: 'hsv', params: { sat: .15, value: .45 }, in: ['src'] },
      { k: 'gr', type: 'gradient', params: { shape: 1, scale: 1.1, colorA: '#ffffff', colorB: '#000000' } },
      { k: 'mm', type: 'maskmix', in: ['dk', 'src', 'gr'] },
    ], out: 'mm',
  },
  'Plasma overlay (generator)': {
    nodes: [
      { k: 'src', type: 'source' },
      { k: 'nz', type: 'noise', params: { scale: 3, speed: .3, octaves: 3, colorA: '#000000', colorB: '#ffffff' } },
      { k: 'lk', type: 'lookup', params: { preset: 3 }, in: ['nz'] },
      { k: 'cp', type: 'composite', params: { blend: 4, opacity: .85 }, in: ['src', 'lk'] },
    ], out: 'cp',
  },
};

function buildFromSpec(spec) {
  clearGraph();
  const map = {};
  spec.nodes.forEach(nd => { if (EFFECTS[nd.type]) map[nd.k] = makeNode(nd.type, 0, 0, nd.params, nd.enabled !== false); });
  spec.nodes.forEach(nd => {
    const n = map[nd.k];
    (nd.in || []).forEach((k, i) => { if (n && k != null && map[k] && i < n.inputs.length) n.inputs[i] = map[k].id; });
  });
  const o = makeNode('output');
  graph.outputId = o.id;
  if (spec.out && map[spec.out]) o.inputs[0] = map[spec.out].id;
  autoLayout(); fitView();
}

function serializeGraph() {
  return {
    format: 'top-fx-graph', version: 2, output: graph.outputId,
    nodes: allNodes().map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, enabled: n.enabled, params: n.params, inputs: n.inputs })),
  };
}
function savePreset() {
  download(new Blob([JSON.stringify(serializeGraph(), null, 2)], { type: 'application/json' }), 'top-fx-graph.json');
}
/** Load a graph file (v2) or an old linear stack preset (v1). Throws on invalid data. */
function loadGraphData(data) {
  if (data && data.format === 'top-fx-preset' && Array.isArray(data.stack)) {   // v1: linear stack
    const known = data.stack.filter(s => s && EFFECTS[s.type] && !EFFECTS[s.type].io);
    if (!known.length && data.stack.length) throw new Error('bad');
    buildFromSpec(chain(known));
    return known.length;
  }
  if (!data || data.format !== 'top-fx-graph' || !Array.isArray(data.nodes)) throw new Error('bad');
  clearGraph();
  const idMap = new Map();
  let skipped = 0;
  data.nodes.forEach(nd => {
    if (!nd || !EFFECTS[nd.type] || (nd.type === 'output' && graph.outputId != null)) { skipped++; return; }
    const n = makeNode(nd.type, Number.isFinite(nd.x) ? nd.x : 0, Number.isFinite(nd.y) ? nd.y : 0, nd.params, nd.enabled !== false);
    idMap.set(nd.id, n.id);
    if (nd.type === 'output') graph.outputId = n.id;
  });
  data.nodes.forEach(nd => {
    const id = idMap.get(nd && nd.id);
    if (id == null || !Array.isArray(nd.inputs)) return;
    const n = graph.nodes.get(id);
    nd.inputs.forEach((src, i) => {
      const sid = idMap.get(src);
      if (sid != null && i < n.inputs.length && graph.nodes.get(sid).type !== 'output' && canConnect(sid, id)) n.inputs[i] = sid;
    });
  });
  if (graph.outputId == null) { const o = makeNode('output', 600, 60); graph.outputId = o.id; }
  if (!data.nodes.some(nd => nd && Number.isFinite(nd.x))) autoLayout();
  onGraphChanged(); fitView();
  return graph.nodes.size - skipped;
}
async function loadPresetFile(file) {
  try {
    const n = loadGraphData(JSON.parse(await file.text()));
    toast(`Loaded graph (${n} node${n === 1 ? '' : 's'}).`);
  } catch (e) {
    console.error(e);
    toast("That file isn't a valid TOP FX graph or preset (.json).", 'error');
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
    const warm = allNodes().some(n => n.enabled && EFFECTS[n.type].stateful) ? 24 : 0;
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

const typing = t => ['input', 'select', 'textarea'].includes((t.tagName || '').toLowerCase()) && t.type !== 'range' && t.type !== 'checkbox';

function init() {
  // presets menu
  const ps = $('#presetSelect');
  ps.appendChild(Object.assign(el('option', null, 'Example graphs…'), { value: '' }));
  Object.keys(BUILTIN_PRESETS).forEach(k => ps.appendChild(Object.assign(el('option', null, k), { value: k })));
  ps.addEventListener('change', () => {
    if (ps.value) { buildFromSpec(BUILTIN_PRESETS[ps.value]); toast(`Loaded “${ps.value}”. Click a node to tweak it.`); }
    ps.value = '';
  });

  // upload
  const fileInput = $('#fileInput');
  $('#btnUpload').addEventListener('click', () => fileInput.click());
  $('#btnUpload2').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });

  // drag & drop files anywhere (node dragging uses pointer events, so it doesn't trigger this)
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  // export / reset / compare
  $('#btnExport').addEventListener('click', () => {
    if (!app.source || app.exporting) return;
    if (app.source.kind === 'image') exportPNG(); else exportVideo();
  });
  $('#btnCancelExport').addEventListener('click', () => { if (cancelExportHook) cancelExportHook(); });
  $('#btnReset').addEventListener('click', () => {
    if (graph.nodes.size > 2 && !confirm('Clear the whole node graph?')) return;
    newGraph();
  });
  const cmp = $('#btnCompare');
  const setCmp = on => { app.compare = on; cmp.classList.toggle('active', on); };
  cmp.addEventListener('pointerdown', e => { cmp.setPointerCapture(e.pointerId); setCmp(true); });
  cmp.addEventListener('pointerup', () => setCmp(false));
  cmp.addEventListener('pointercancel', () => setCmp(false));
  window.addEventListener('blur', () => setCmp(false));

  // graph toolbar
  $('#btnAddNode').addEventListener('click', e => {
    if (!menu.hidden) return closeMenu();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({ x: r.left, y: r.bottom + 6 });
  });
  $('#btnFit').addEventListener('click', fitView);
  $('#btnArrange').addEventListener('click', () => { autoLayout(); fitView(); });
  $('#btnSave').addEventListener('click', savePreset);
  $('#btnLoad').addEventListener('click', () => $('#presetInput').click());
  $('#presetInput').addEventListener('change', e => { if (e.target.files[0]) loadPresetFile(e.target.files[0]); e.target.value = ''; });
  $('#viewChipClear').addEventListener('click', () => toggleView(graph.viewId));

  // splitter between preview and node editor
  const sp = $('#splitter'), gp = $('#graphPanel');
  let sdrag = null;
  sp.addEventListener('pointerdown', e => { sdrag = { y: e.clientY, h: gp.getBoundingClientRect().height }; sp.setPointerCapture(e.pointerId); sp.classList.add('active'); });
  sp.addEventListener('pointermove', e => {
    if (!sdrag) return;
    const max = $('#stage').getBoundingClientRect().height - 200;
    gp.style.height = clamp(sdrag.h - (e.clientY - sdrag.y), 170, max) + 'px';
  });
  const sEnd = () => { sdrag = null; sp.classList.remove('active'); };
  sp.addEventListener('pointerup', sEnd); sp.addEventListener('pointercancel', sEnd);

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

  // keyboard
  window.addEventListener('keydown', e => {
    if (typing(e.target)) return;
    if (e.key === 'Escape') { if (app.eyedrop) stopEyedrop(); closeMenu(); }
    else if (e.key === '\\') setCmp(true);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && graph.selected != null) { e.preventDefault(); removeNode(graph.selected); }
    else if (e.key === 'f' && !e.ctrlKey && !e.metaKey) fitView();
    else if (e.key === 'a' && !e.ctrlKey && !e.metaKey && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      const r = gEl.getBoundingClientRect();
      openMenu({ x: r.left + 16, y: r.top + 40 });
    }
    else if (e.code === 'Space' && !['BUTTON'].includes(e.target.tagName) && app.source && app.source.kind === 'video') { e.preventDefault(); play.click(); }
  });
  window.addEventListener('keyup', e => { if (e.key === '\\') setCmp(false); });

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); toast('The graphics context was lost. Reload the page to continue.', 'error', 10000); });

  canvas.classList.add('empty');
  applyView();
  newGraph();
  layout();
  requestAnimationFrame(tick);
}

// small hook for debugging in the console
window.TOPFX = { app, graph, EFFECTS, env, BUILTIN_PRESETS, buildFromSpec, addNodeSmart, connect, makeNode, chain };
init();
})();
