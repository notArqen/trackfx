// ptfx shader sources. the game renders with outputColorSpace = srgb-linear and no tone mapping,
// i.e. its materials write display-referred (sRGB-ish) values straight out. the scene target therefore
// holds display values: passes decode with srgb2lin, do their maths in linear HDR, and the final
// pass re-encodes. with every effect off the round trip is an identity, so vanilla look is preserved.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const SH = (PT.SH = {});

  SH.VERT = `
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

  SH.COMMON = `
varying vec2 vUv;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 srgb2lin(vec3 c){ c = max(c, 0.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 lin2srgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

  // tonemap: khronos pbr neutral, blended against plain clamp so tone=0 matches vanilla. chosen over
  // aces because aces' toe crushes everything near black: at night tyres and asphalt merged into one void
  SH.FINAL = `
uniform sampler2D tColor;
uniform float uTime, uExposure, uTone, uContrast, uSat, uVignette, uLinearIn, uTemp, uSharp;
uniform vec2 uSrcTexel;
vec3 neutral(vec3 c){
  const float start = 0.76, desat = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  const float d = 1.0 - start;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  // upscale sharpening (contrast-adaptive, in the spirit of fidelityfx cas): the effects render below
  // native resolution; sharpen more where local contrast is low, less on edges, so no halos
  if (uSharp > 0.0) {
    vec3 b = texture2D(tColor, vUv + vec2(0.0, -uSrcTexel.y)).rgb, d = texture2D(tColor, vUv + vec2(-uSrcTexel.x, 0.0)).rgb;
    vec3 f = texture2D(tColor, vUv + vec2(uSrcTexel.x, 0.0)).rgb, h = texture2D(tColor, vUv + vec2(0.0, uSrcTexel.y)).rgb;
    vec3 e = clamp(c, 0.0, 1.0), mn = min(e, min(min(clamp(b, 0.0, 1.0), clamp(d, 0.0, 1.0)), min(clamp(f, 0.0, 1.0), clamp(h, 0.0, 1.0))));
    vec3 mx = max(e, max(max(clamp(b, 0.0, 1.0), clamp(d, 0.0, 1.0)), max(clamp(f, 0.0, 1.0), clamp(h, 0.0, 1.0))));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
    vec3 w = -amp * mix(0.125, 0.2, uSharp);
    c = max((b + d + f + h) * w + c, 0.0) / (1.0 + 4.0 * w);
  }
  c = (uLinearIn > 0.5 ? c : srgb2lin(c)) * uExposure;
  c = mix(min(c, 1.0), clamp(neutral(c), 0.0, 1.0), uTone);
  c *= vec3(1.0 + 0.06 * uTemp, 1.0, 1.0 - 0.1 * uTemp);   // weather colour temperature (neg = cold)
  float l = luma(c);
  c = mix(vec3(l), c, uSat);
  // contrast around mid-grey, faded out in the shadows so it never crushes the darks
  vec3 cc = (c - 0.18) * uContrast + 0.18;
  c = clamp(mix(c, cc, smoothstep(0.0, 0.12, c)), 0.0, 1.0);
  vec2 d = vUv - 0.5; c *= 1.0 - uVignette * dot(d, d) * 2.0;
  c = lin2srgb(c);
  c += (hash12(gl_FragCoord.xy + fract(uTime) * 97.0) - 0.5) / 255.0; // dither off the banding
  gl_FragColor = vec4(c, 1.0);
}
`;
  SH.finalUniforms = () => ({
    tColor: { value: null }, uTime: { value: 0 }, uExposure: { value: 1 }, uTone: { value: 0 },
    uContrast: { value: 1 }, uSat: { value: 1 }, uVignette: { value: 0 }, uLinearIn: { value: 0 }, uTemp: { value: 0 }, uSharp: { value: 0 }, uSrcTexel: { value: { x: 0, y: 0, isVector2: true, set(a, b) { this.x = a; this.y = b; return this; } } },
  });
  SH.updateFinal = (u, ctx) => {
    const c = ctx.cfg;
    u.uExposure.value = (c.exposure ?? 1) * (ctx.exposureMul ?? 1); u.uTone.value = c.tone ?? 0;
    u.uContrast.value = c.contrast ?? 1; u.uSat.value = (c.saturation ?? 1) * (ctx.satMul ?? 1); u.uTemp.value = ctx.temp ?? 0;
    // more sharpening the further below native we render
    const sc = c.renderScale ?? 1; u.uSharp.value = (c.sharpen ?? 0.6) * (sc < 0.99 ? 1 : 0.35); u.uSrcTexel.value.set(1 / ctx.w, 1 / ctx.h); u.uVignette.value = c.vignette ?? 0;
    u.uLinearIn.value = ctx.linear ? 1 : 0;
  };
})();
// ptfx settings persistence. loaded before every module, so saved values win over module defaults
// (modules only fill keys that are still undefined).
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const KEY = "ptfx.settings.v1";
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
  PT.cfg = Object.assign(PT.cfg || {}, saved);
  let t = 0;
  PT.save = () => {
    clearTimeout(t);
    t = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(PT.cfg)); } catch {} }, 200);
  };
  // modules register their defaults here; saved values win, and reset copies defaults back in place
  // (a page reload is blocked by electron's will-navigate guard, so reset can't just reload)
  PT.def = {};
  PT.defaults = (o) => { for (const [k, v] of Object.entries(o)) { PT.def[k] = v; if (PT.cfg[k] === undefined) PT.cfg[k] = v; } };
  // quality presets: one click sets the expensive knobs
  PT.QUALITY = {
    low:    { renderScale: 0.6,  ssrSteps: 12, bloomMips: 4, rainDensity: 0.5 },
    medium: { renderScale: 0.75, ssrSteps: 18, bloomMips: 5, rainDensity: 0.75 },
    high:   { renderScale: 0.9,  ssrSteps: 24, bloomMips: 6, rainDensity: 1 },
    ultra:  { renderScale: 1,    ssrSteps: 32, bloomMips: 6, rainDensity: 1 },
  };
  PT.applyQuality = (q) => { Object.assign(PT.cfg, PT.QUALITY[q] || {}); PT.cfg.quality = q; PT.save(); PT.onReset?.(); };
  PT.resetSettings = () => {
    for (const [k, v] of Object.entries(PT.def)) PT.cfg[k] = v;
    try { localStorage.removeItem(KEY); } catch {}
    PT.onReset?.();
  };
})();
// ptfx core: three.js class discovery, scene render target, pass chain.
// the game calls PTFX.render(THREE, renderer, scene, camera) instead of renderer.render(scene, camera).
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const log = (window.__ptlog = []);
  const err = (m) => { log.push(String(m).slice(0, 500)); if (log.length > 100) log.shift(); };
  // three reports shader compile errors via console.error; keep them inspectable
  for (const lvl of ["error", "warn"]) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => { try { err(lvl + ": " + a.map(String).join(" ")); } catch {} orig(...a); };
  }

  // minified three exports -> real names. every three class sets its own `isFoo` flag, either
  // in the constructor (`this.isMesh=!0`) or as a prototype flag; subclasses only set theirs.
  let T = null;
  const WANT = ["WebGLRenderTarget", "DepthTexture", "ShaderMaterial", "Mesh", "BufferGeometry", "BufferAttribute",
    "OrthographicCamera", "Vector2", "Vector3", "Vector4", "Color", "Matrix4", "SpotLight", "PointLight", "Object3D", "MeshBasicMaterial"];
  function discover(ns) {
    const out = {};
    for (const k of Object.keys(ns)) {
      const v = ns[k];
      if (typeof v !== "function" || !v.prototype) continue;
      let src = "";
      try { src = Function.prototype.toString.call(v); } catch {}
      for (const name of WANT) {
        if (out[name]) continue;
        const own = new RegExp("\\.is" + name + "=!0").test(src);
        const proto = Object.prototype.hasOwnProperty.call(v.prototype, "is" + name);
        if (own || proto) out[name] = v;
      }
    }
    for (const k of Object.keys(ns)) {
      const v = ns[k];
      if (!out.Raycaster && typeof v === "function" && v.prototype?.intersectObjects && v.prototype?.setFromCamera) out.Raycaster = v;
    }
    // geometries carry no isFoo flag, only a type string
    for (const k of Object.keys(ns)) {
      const v = ns[k];
      if (!out.BoxGeometry && typeof v === "function" && /type="BoxGeometry"/.test(Function.prototype.toString.call(v))) out.BoxGeometry = v;
    }
    for (const name of WANT.concat("BoxGeometry")) if (!out[name]) err("ptfx: three class not found: " + name);
    return out;
  }

  // ---------------------------------------------------------------- fullscreen pass helper
  let quadScene = null, quadCam = null, quadMesh = null;
  function initQuad() {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    quadMesh = new T.Mesh(g, null);
    quadMesh.frustumCulled = false;
    quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadScene = { isScene: false };
  }
  function pass(renderer, mat, target) {
    quadMesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadMesh, quadCam);
  }
  function material(frag, uniforms, defines) {
    return new T.ShaderMaterial({
      vertexShader: PT.SH.VERT, fragmentShader: PT.SH.COMMON + frag,
      uniforms, defines: defines || {}, depthTest: false, depthWrite: false,
    });
  }

  // ---------------------------------------------------------------- render targets
  const rts = {};
  function rt(name, w, h, opts) {
    let t = rts[name];
    if (t && t.width === w && t.height === h) return t;
    if (t) { t.depthTexture?.dispose(); t.dispose(); }
    t = new T.WebGLRenderTarget(w, h, Object.assign({ type: 1016 /* HalfFloatType */, depthBuffer: false }, opts));
    rts[name] = t;
    return t;
  }

  // ---------------------------------------------------------------- state shared with other modules
  PT.state = { T: null, time: 0, frame: 0, dt: 0.016, failed: false };
  PT.passes = [];   // modules push { name, init(ctx), run(ctx) } in order
  PT.cfg = PT.cfg || {};

  let mats = null, last = performance.now();

  // dev: gpu profiler. PT.profile = true, then PT.profileReport() -> avg ms per pass (timer queries)
  const prof = { pending: [], stats: {}, ext: null, gl: null };
  function pBegin(renderer, name) {
    if (PT.profileSync) { const gl = renderer.getContext(); gl.finish(); return { name, t0: performance.now(), gl, sync: true }; }
    if (!PT.profile) return null;
    if (!prof.gl) { prof.gl = renderer.getContext(); prof.ext = prof.gl.getExtension("EXT_disjoint_timer_query_webgl2"); }
    if (!prof.ext) return null;
    const q = prof.gl.createQuery(); prof.gl.beginQuery(prof.ext.TIME_ELAPSED_EXT, q);
    return { name, q };
  }
  function pEnd(t) {
    if (t && t.sync) { t.gl.finish(); const st = (prof.stats[t.name] ??= { sum: 0, n: 0 }); st.sum += performance.now() - t.t0; st.n++; return; }
    if (!t) return; prof.gl.endQuery(prof.ext.TIME_ELAPSED_EXT); prof.pending.push(t); }
  function pPoll() {
    if (!prof.gl) return;
    const gl = prof.gl, disjoint = gl.getParameter(prof.ext.GPU_DISJOINT_EXT);
    prof.pending = prof.pending.filter((t) => {
      if (!gl.getQueryParameter(t.q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) { const ms = gl.getQueryParameter(t.q, gl.QUERY_RESULT) / 1e6; const st = (prof.stats[t.name] ??= { sum: 0, n: 0 }); st.sum += ms; st.n++; }
      gl.deleteQuery(t.q); return false;
    });
  }
  PT.profileReport = () => {
    const out = {}; let total = 0;
    for (const [k, v] of Object.entries(prof.stats)) { out[k] = +(v.sum / v.n).toFixed(3); total += v.sum / v.n; }
    out.TOTAL = +total.toFixed(3); prof.stats = {}; return out;
  };

  // photo = { w, h, target }: an extra off-screen render at photo resolution. it gets its own render
  // targets (prefixed, disposed after) and dt = 0, so no simulation state advances for it
  function frame(three, renderer, scene, camera, photo) {
    if (!T) {
      T = discover(three); PT.state.T = T; initQuad();
      mats = { final: material(PT.SH.FINAL, PT.SH.finalUniforms(T)) };
      for (const p of PT.passes) p.init?.({ T, material, renderer });
    }
    PT.state.renderer = renderer;
    if (photo) PT.state.dt = 0;
    else {
      const now = performance.now();
      PT.state.dt = Math.min(0.1, (now - last) / 1000); last = now;
      PT.state.time += PT.state.dt; PT.state.frame++;
    }

    const size = renderer.getDrawingBufferSize(new T.Vector2());
    // internal resolution: scene + all effect passes run at renderScale, the final pass upsamples to the canvas
    let sc = photo ? 1 : Math.min(1, Math.max(0.4, PT.cfg.renderScale ?? 1));
    // gopro fisheye magnifies the middle of the frame ~2x: render those cams supersampled so it isn't a
    // blow-up of chunky pixels (the final pass filters it back down to the canvas)
    if (!photo && PT.camBolted && PT.cfg.goproLens && PT.cfg.goproFisheye > 0.05) sc = Math.min(1.6, Math.max(sc, PT.cfg.goproRes ?? 1.15));
    const w = photo ? photo.w : Math.max(1, Math.round(size.x * sc)), h = photo ? photo.h : Math.max(1, Math.round(size.y * sc));
    const prt = photo ? (n, a, b, o) => rt("photo:" + n, a, b, o) : rt;
    const scn = prt("scene", w, h, { depthBuffer: true, samples: 0 });
    if (!scn.depthTexture) { scn.depthTexture = new T.DepthTexture(w, h); scn.depthTexture.type = 1014 /* FloatType */; }

    const ctx = { T, renderer, scene, camera, w, h, scene_rt: scn, color: scn.texture, depth: scn.depthTexture, rt: prt, pass, material, quadCam, cfg: PT.cfg, state: PT.state, photo: !!photo };

    for (const p of PT.passes) p.beforeScene?.(ctx);
    pPoll();
    let t = pBegin(renderer, "scene");
    renderer.setRenderTarget(scn);
    renderer.render(scene, camera);
    pEnd(t);
    for (const p of PT.passes) p.afterScene?.(ctx);

    for (const p of PT.passes) if (p.run) { t = pBegin(renderer, p.name); ctx.color = p.run(ctx) || ctx.color; pEnd(t); }

    const u = mats.final.uniforms;
    u.tColor.value = ctx.color; u.uTime.value = PT.state.time;
    PT.SH.updateFinal?.(u, ctx);
    t = pBegin(renderer, "final");
    pass(renderer, mats.final, photo ? photo.target : null);
    pEnd(t);
    for (const p of PT.passes) p.afterFrame?.(ctx);
  }

  // dev: render the same frame vanilla and through ptfx, read back both, report mean abs diff (0-255)
  function abtest(three, renderer, scene, camera) {
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = () => { const b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
    renderer.setRenderTarget(null); renderer.render(scene, camera); const a = grab();
    frame(three, renderer, scene, camera); const b = grab();
    let sum = 0, max = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); sum += d; if (d > max) max = d; n++; }
    PT.abtest(sum / n, max); PT.abtest = null;
  }

  // dev: read back a render target and summarise it (half-float -> float). PT.probe("rain")
  const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    return e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024); };
  PT.probe = (name) => {
    const t = rts[name]; if (!t) return "no target " + name;
    const w = t.width, h = t.height, buf = new Uint16Array(w * h * 4);
    PT.state.renderer.readRenderTargetPixels(t, 0, 0, w, h, buf);
    let max = 0, sum = 0, nz = 0;
    for (let i = 0; i < buf.length; i += 4) { const v = Math.max(h2f(buf[i]), h2f(buf[i + 1]), h2f(buf[i + 2])); if (v > max) max = v; sum += v; if (v > 1e-4) nz++; }
    return { w, h, max, mean: sum / (w * h), nonzeroPct: (100 * nz) / (w * h) };
  };

  // dev bench: PT.bench(n) renders the same frame n times, then a 1px readback forces the gpu to
  // really finish (timer queries are inflated on ANGLE/Metal and finish() is a flush in Chrome).
  // works with effects off too (times a plain game render)
  function runBench(three, renderer, scene, camera, off) {
    const { n, resolve } = PT.benchReq; PT.benchReq = null;
    const gl = renderer.getContext(), px = new Uint8Array(4);
    const once = () => { if (off) { renderer.setRenderTarget(null); renderer.render(scene, camera); } else frame(three, renderer, scene, camera); };
    once(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) once();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    resolve((performance.now() - t0) / n);
  }
  // photo: re-render the current frame off-screen at photo resolution (max or current settings),
  // read it back and hand the pixels to the photo module. gameplay settings are restored right after
  PT.requestPhoto = () => { PT.photoReq = true; };
  function takePhoto(three, renderer, scene, camera) {
    const c = PT.cfg, size = renderer.getDrawingBufferSize(new T.Vector2());
    const long = { "1080p": 1920, "1440p": 2560, "4k": 3840, "5k": 5120 }[c.photoRes] || 3840;
    const k = long / Math.max(size.x, size.y), w = Math.round(size.x * k), h = Math.round(size.y * k);
    const saved = {};
    if (c.photoMax) {
      const max = Object.assign({}, PT.QUALITY?.ultra, { ao: true, godRays: true, bloom: true, reflections: true, occlusion: true, ssrSteps: 32, bloomMips: 6 });
      for (const [key, v] of Object.entries(max)) { saved[key] = c[key]; c[key] = v; }
    }
    const target = new T.WebGLRenderTarget(w, h, { type: 1009 /* UnsignedByte */, depthBuffer: false });
    try {
      frame(three, renderer, scene, camera, { w, h, target });
      const buf = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
      PT.onPhoto?.(buf, w, h);
    } finally {
      Object.assign(c, saved);
      target.dispose();
      for (const [n, t] of Object.entries(rts)) if (n.startsWith("photo:")) { t.depthTexture?.dispose(); t.dispose(); delete rts[n]; }
      renderer.setRenderTarget(null);
    }
  }

  PT.bench = (n = 30) => new Promise((resolve) => { PT.benchReq = { n, resolve }; });

  window.PTFX = {
    render(three, renderer, scene, camera) {
      const off = PT.state.failed || PT.cfg.enabled === false;
      // on switching off, let modules undo what they did to the game's scene (lights etc.)
      if (off && !PT.wasOff) for (const p of PT.passes) p.disable?.(scene);
      PT.wasOff = off;
      if (PT.benchReq) return runBench(three, renderer, scene, camera, off);
      if (off) return renderer.render(scene, camera);
      // optional fps cap: skipping a draw leaves the last frame on screen (physics runs in its own worker)
      const cap = PT.cfg.fpsCap | 0, now = performance.now();
      if (cap > 0 && now - (PT.lastDraw ?? 0) < 1000 / cap - 1.5) return;
      PT.lastDraw = now;
      if (PT.abtest) return abtest(three, renderer, scene, camera);
      try {
        PT.gameCamera = camera;
        const cam = (T && PT.cameraHook?.(camera, T)) || camera;   // cinematic replay camera, if active
        frame(three, renderer, scene, cam);
        if (PT.photoReq) { PT.photoReq = false; takePhoto(three, renderer, scene, cam); }
      }
      catch (e) {
        // never take the game down with us: fall back to vanilla rendering for the session
        PT.state.failed = true; err("ptfx disabled: " + (e && e.stack || e));
        renderer.setRenderTarget(null); renderer.render(scene, camera);
      }
    },
    sun(v) { return PT.sunHook ? PT.sunHook(v) : v; },
    get state() { return PT.state; },
    log,
  };
})();
// ptfx atmosphere: time of day. drives the game's two lights (hemisphere + directional) and replaces
// the sky in post. the game's sky sphere doesn't write depth, so sky pixels are exactly depth == 1.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  PT.defaults({ sunTurn: 0, sharpen: 0.6, quality: "medium", renderScale: 0.75, ssrSteps: 18, bloomMips: 5, fpsCap: 0, enabled: true, timeOfDay: 15, dayCycle: false, dayMinutes: 6, tone: 1, exposure: 1, contrast: 1.05, saturation: 1.08, vignette: 0.22 });
  const cfg = PT.cfg;

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  PT.SH.SKY = `
uniform sampler2D tColor, tDepth;
uniform mat4 uInvVP; uniform vec3 uCamPos, uSunDir, uMoonDir;
uniform float uDay, uDusk, uTime, uOv, uGroundLight;
vec3 skyCol(vec3 d){
  float h = max(d.y, 0.0);
  vec3 zenD = vec3(0.16, 0.36, 0.78), horD = vec3(0.62, 0.76, 0.92);
  vec3 zenN = vec3(0.004, 0.007, 0.02), horN = vec3(0.02, 0.03, 0.06);
  vec3 horK = vec3(1.0, 0.42, 0.16);
  vec3 zen = mix(zenN, zenD, uDay), hor = mix(horN, horD, uDay);
  float sunSide = pow(max(dot(normalize(d.xz + 1e-4), normalize(uSunDir.xz + 1e-4)), 0.0), 3.0);
  hor = mix(hor, horK * (0.25 + 0.75 * uDay), uDusk * (0.35 + 0.65 * sunSide));
  vec3 c = mix(hor, zen, pow(h, 0.45));
  float sd = dot(d, uSunDir);
  c += vec3(1.0, 0.85, 0.6) * (pow(max(sd, 0.0), 64.0) * 0.6 + pow(max(sd, 0.0), 8.0) * 0.15) * (uDay + uDusk);
  c += vec3(30.0, 26.0, 20.0) * smoothstep(0.9994, 0.9997, sd) * step(-0.02, uSunDir.y);
  // night: stars + moon
  float night = 1.0 - smoothstep(0.0, 0.35, uDay);
  vec3 sp = d * 220.0; vec3 cell = floor(sp); float r = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float star = step(0.985, r) * smoothstep(0.55, 0.0, length(fract(sp) - 0.5)) * (0.6 + 0.4 * sin(uTime * (1.0 + r * 3.0) + r * 40.0));
  c += vec3(0.8, 0.85, 1.0) * star * night * smoothstep(0.0, 0.15, d.y) * 1.5;
  float md = dot(d, uMoonDir);
  c += vec3(0.75, 0.8, 0.9) * (smoothstep(0.9990, 0.9993, md) * 3.0 + pow(max(md, 0.0), 40.0) * 0.05) * night;
  if (d.y < 0.0) c = mix(c, hor * 0.6, smoothstep(0.0, -0.2, d.y));
  // overcast: a flat grey lid that hides sun, moon and stars, slightly lighter toward the horizon
  vec3 g = mix(vec3(0.012, 0.014, 0.02), vec3(0.42, 0.45, 0.5), uDay) * (0.85 + 0.25 * (1.0 - h)) + horK * uDusk * 0.06;
  return mix(c, g, uOv);
}
void main(){
  vec3 src = srgb2lin(texture2D(tColor, vUv).rgb);
  float z = texture2D(tDepth, vUv).r;
  if (z < 0.99999) { gl_FragColor = vec4(src, 1.0); return; }
  vec4 p = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w - uCamPos);
  // keep the game's clouds by day (their brightness above the sky base), dimmed with the light
  vec3 mine = skyCol(d);
  float cloud = clamp(luma(src) - 0.55, 0.0, 1.0) * 1.6;
  vec3 sky = mine + cloud * mix(vec3(0.02, 0.025, 0.04), vec3(1.0), uDay) * (1.0 - uOv * 0.7);
  // below the horizon the game's sky dome IS the ground (there's no ground mesh): keep its colour, lit
  // like everything else (day/night, overcast), fading into the horizon haze. replacing it with sky
  // made the ground vanish
  vec3 ground = src * uGroundLight;
  float below = smoothstep(0.0, -0.06, d.y);
  gl_FragColor = vec4(mix(sky, mix(skyCol(vec3(d.x, 0.001, d.z)), ground, smoothstep(0.0, -0.25, d.y)), below), 1.0);
}
`;

  let mat = null, lights = null, lightScene = null, sunDir = [0, 1, 0], moonDir = [0, 1, 0], day = 1, dusk = 0, baseSun = null;

  // the game's sun gives us a track-specific azimuth; we keep that and drive elevation from the clock
  PT.sunHook = (v) => {
    if (cfg.enabled === false) return v;
    if (!baseSun) baseSun = [v.x, v.y, v.z];
    let az = Math.atan2(baseSun[2], baseSun[0]) + (cfg.sunTurn || 0) * Math.PI / 180;   // 0 = the track's own sun
    const a = ((cfg.timeOfDay - 6) / 24) * Math.PI * 2;           // 6h sunrise, 18h sunset
    const el = Math.asin(clamp(Math.sin(a), -1, 1)) * 0.95;
    az += Math.cos(a) * 1.2;                                        // sun swings across the sky
    sunDir = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
    moonDir = [-sunDir[0] * 0.7, Math.max(0.35, -sunDir[1]), -sunDir[2] * 0.7];
    const n = Math.hypot(...moonDir); moonDir = moonDir.map((x) => x / n);
    day = sstep(-0.08, 0.25, sunDir[1]); PT.day = day;
    dusk = sstep(-0.18, 0.02, sunDir[1]) * (1 - sstep(0.05, 0.3, sunDir[1]));
    const light = sunDir[1] > -0.05 ? sunDir : moonDir;             // shadows come from whichever is up
    PT.lightDir = [light[0], Math.max(light[1], 0.06), light[2]];
    const out = v.clone(); out.set(light[0], Math.max(light[1], 0.06), light[2]); return out;
  };

  function findLights(scene) {
    lights = { hemi: [], dir: [] }; lightScene = scene;
    scene.traverse((o) => {
      if (!o.isLight) return;
      o.userData.ptBase ??= { i: o.intensity, c: o.color.clone(), g: o.groundColor?.clone() };
      if (o.isHemisphereLight) lights.hemi.push(o); else if (o.isDirectionalLight) lights.dir.push(o);
    });
  }

  PT.passes.push({
    name: "atmos",
    // effects switched off: give the game back its own light intensities and colours
    disable(scene) {
      scene.traverse((o) => { const b = o.userData?.ptBase; if (o.isLight && b) { o.intensity = b.i; o.color.copy(b.c); } });
    },
    beforeScene(ctx) {
      if (cfg.dayCycle) cfg.timeOfDay = (cfg.timeOfDay + (ctx.state.dt / (cfg.dayMinutes * 60)) * 24) % 24;
      if (lightScene !== ctx.scene || ctx.state.frame % 60 === 0) findLights(ctx.scene);
      const sunUp = sunDir[1] > -0.05;
      // sun: warm and weak near the horizon, moon: dim and blue
      const sunCol = mix3([1.0, 0.45, 0.2], [1.0, 0.97, 0.92], sstep(0.0, 0.35, sunDir[1]));
      const dirCol = sunUp ? sunCol : [0.45, 0.55, 0.85];
      const W = PT.weather || { dim: 1, ov: 0, flash: 0, temp: 0, sat: 1 };
      // weather: clouds eat direct light first, then flatten and cool the ambient
      const dirI = (sunUp ? sstep(-0.05, 0.12, sunDir[1]) : 0.32) * W.dim + W.flash * 3;
      for (const l of lights.dir) { const b = l.userData.ptBase; l.intensity = b.i * dirI; l.color.setRGB(b.c.r * dirCol[0], b.c.g * dirCol[1], b.c.b * dirCol[2]); }
      const amb = (0.26 + 0.74 * day) * (1 - 0.3 * W.ov) + W.flash * 1.5;
      const ambCol = mix3(mix3([0.4, 0.5, 0.85], [1, 1, 1], day), [0.82, 0.86, 0.92], W.ov * 0.7);
      // eye adaptation stand-in: open up exposure as light drops
      ctx.exposureMul = 1 + 1.1 * (1 - day) + 0.35 * (1 - W.dim) * day;
      ctx.satMul = W.sat; ctx.temp = W.temp;
      // sky colours for reflections and fog (cpu mirror of the shader's gradient + overcast)
      const zen = mix3([0.004, 0.007, 0.02], [0.16, 0.36, 0.78], day), hor = mix3([0.02, 0.03, 0.06], [0.62, 0.76, 0.92], day);
      const grey = mix3([0.012, 0.014, 0.02], [0.42, 0.45, 0.5], day);
      PT.skyCols = { top: mix3(zen, grey, W.ov), hor: mix3(hor, grey.map((x) => x * 1.1), W.ov), fog: mix3(mix3(hor, grey, W.ov), [0.55, 0.58, 0.62].map((x) => x * (0.08 + 0.92 * day)), 0.4).map((x) => x * 0.72) };   // a touch below the horizon so distant ground goes grey, not white
      PT.ambient = { col: ambCol, i: amb };
      PT.lightLevels = { dirI, amb, col: dirCol, sunUp };   // headlight pass divides this back out to recover albedo
      for (const l of lights.hemi) { const b = l.userData.ptBase; l.intensity = b.i * amb; l.color.setRGB(b.c.r * ambCol[0], b.c.g * ambCol[1], b.c.b * ambCol[2]); }
    },
    run(ctx) {
      const { T } = ctx;
      if (!mat) mat = ctx.material(PT.SH.SKY, {
        tColor: { value: null }, tDepth: { value: null }, uInvVP: { value: new T.Matrix4() }, uCamPos: { value: new T.Vector3() },
        uSunDir: { value: new T.Vector3() }, uMoonDir: { value: new T.Vector3() }, uDay: { value: 1 }, uDusk: { value: 0 }, uTime: { value: 0 }, uOv: { value: 0 }, uGroundLight: { value: 1 },
      });
      const u = mat.uniforms, cam = ctx.camera;
      u.tColor.value = ctx.color; u.tDepth.value = ctx.depth;
      u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
      u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      u.uSunDir.value.set(...sunDir); u.uMoonDir.value.set(...moonDir);
      u.uDay.value = day; u.uDusk.value = dusk; u.uTime.value = ctx.state.time; u.uOv.value = (PT.weather?.ov ?? 0);
      const lv = PT.lightLevels; u.uGroundLight.value = lv ? Math.min(1.2, (lv.dirI * 0.6 + lv.amb * 0.5)) : 1;
      const out = ctx.rt("atmos", ctx.w, ctx.h);
      ctx.pass(ctx.renderer, mat, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx ray grid: fast raycasts against the static track, on any track. three's Raycaster has no
// acceleration structure and polytrack draws track pieces as InstancedMesh (one geometry stamped at
// tens of thousands of transforms, ~4M triangles in world space on big maps), so five rays could cost
// ~35 ms of cpu. two levels instead:
//  - a uniform grid of INSTANCES bucketed by world-space bounding box (cheap: one entry per instance)
//  - per instance: the ray goes into the piece's local space, gets a local bbox test, and only then is
//    tested against that piece's triangles (stored once per unique geometry)
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  let G = null, stamp = 0;

  PT.buildRayGrid = (meshes, T) => {
    const geos = new Map();            // geometry -> { tri: Float32Array (local), box: [6] }
    const instGeo = [], instInv = [], instBox = [];
    const local = new T.Matrix4(), world = new T.Matrix4(), inv = new T.Matrix4(), v = new T.Vector3();
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      let ge = geos.get(m.geometry);
      if (!ge) {
        const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
        const tri = new Float32Array(Math.floor(n / 3) * 9), box = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
        for (let i = 0; i + 2 < n; i += 3) for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k);
          const o = (i + k) * 3;
          tri[o] = v.x; tri[o + 1] = v.y; tri[o + 2] = v.z;
          box[0] = Math.min(box[0], v.x); box[1] = Math.min(box[1], v.y); box[2] = Math.min(box[2], v.z);
          box[3] = Math.max(box[3], v.x); box[4] = Math.max(box[4], v.y); box[5] = Math.max(box[5], v.z);
        }
        ge = { tri, box, id: geos.size };
        geos.set(m.geometry, ge);
      }
      const copies = m.isInstancedMesh ? m.count : 1;
      for (let c = 0; c < copies; c++) {
        if (m.isInstancedMesh) { m.getMatrixAt(c, local); world.multiplyMatrices(m.matrixWorld, local); } else world.copy(m.matrixWorld);
        inv.copy(world).invert();
        const e = inv.elements;   // column-major; keep the affine 3x4
        instGeo.push(ge.id);
        instInv.push(e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]);
        // world bbox of the local bbox's 8 corners
        const b = ge.box, wb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
        for (let q = 0; q < 8; q++) {
          v.set(q & 1 ? b[3] : b[0], q & 2 ? b[4] : b[1], q & 4 ? b[5] : b[2]).applyMatrix4(world);
          wb[0] = Math.min(wb[0], v.x); wb[1] = Math.min(wb[1], v.y); wb[2] = Math.min(wb[2], v.z);
          wb[3] = Math.max(wb[3], v.x); wb[4] = Math.max(wb[4], v.y); wb[5] = Math.max(wb[5], v.z);
        }
        instBox.push(...wb);
      }
    }
    const count = instGeo.length;
    if (!count) { G = null; return; }
    const geoList = [...geos.values()].sort((a, b) => a.id - b.id);
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], instBox[i * 6 + a]); mx[a] = Math.max(mx[a], instBox[i * 6 + 3 + a]); }
    const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    const cs = Math.max(4, ext / 160);
    const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((mx[a] - mn[a]) / cs) + 1));
    const cells = new Map();
    for (let i = 0; i < count; i++) {
      const c0 = [0, 1, 2].map((a) => Math.floor((instBox[i * 6 + a] - mn[a]) / cs));
      const c1 = [0, 1, 2].map((a) => Math.floor((instBox[i * 6 + 3 + a] - mn[a]) / cs));
      for (let x = c0[0]; x <= c1[0]; x++) for (let y = c0[1]; y <= c1[1]; y++) for (let z = c0[2]; z <= c1[2]; z++) {
        const key = (x * dims[1] + y) * dims[2] + z;
        let arr = cells.get(key); if (!arr) cells.set(key, (arr = [])); arr.push(i);
      }
    }
    G = { geoList, instGeo: Uint32Array.from(instGeo), instInv: Float32Array.from(instInv), mn, cs, dims, cells, mark: new Uint32Array(count) };
  };

  // nearest hit of one instance's triangles, ray in local space; returns t (same parameter as world) or best
  function hitInstance(i, ox, oy, oz, dx, dy, dz, near, best) {
    const M = G.instInv, q = i * 12;
    const lox = M[q] * ox + M[q + 3] * oy + M[q + 6] * oz + M[q + 9], loy = M[q + 1] * ox + M[q + 4] * oy + M[q + 7] * oz + M[q + 10], loz = M[q + 2] * ox + M[q + 5] * oy + M[q + 8] * oz + M[q + 11];
    const ldx = M[q] * dx + M[q + 3] * dy + M[q + 6] * dz, ldy = M[q + 1] * dx + M[q + 4] * dy + M[q + 7] * dz, ldz = M[q + 2] * dx + M[q + 5] * dy + M[q + 8] * dz;
    const ge = G.geoList[G.instGeo[i]], b = ge.box;
    // local bbox slab test (cheap rejection before touching triangles)
    let t0 = near, t1 = best;
    const os = [lox, loy, loz], ds = [ldx, ldy, ldz];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(ds[a]) < 1e-12) { if (os[a] < b[a] || os[a] > b[a + 3]) return best; continue; }
      let ta = (b[a] - os[a]) / ds[a], tb = (b[a + 3] - os[a]) / ds[a]; if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return best;
    }
    const tri = ge.tri;
    for (let o = 0; o < tri.length; o += 9) {
      const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
      const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
      const px = ldy * e2z - ldz * e2y, py = ldz * e2x - ldx * e2z, pz = ldx * e2y - ldy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const iv = 1 / det, sx = lox - tri[o], sy = loy - tri[o + 1], sz = loz - tri[o + 2];
      const uu = (sx * px + sy * py + sz * pz) * iv; if (uu < 0 || uu > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const vv = (ldx * qx + ldy * qy + ldz * qz) * iv; if (vv < 0 || uu + vv > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * iv;
      if (tt > near && tt < best) best = tt;
    }
    return best;
  }

  // distance to the first track hit along o + d*t (near < t < far), Infinity if none, null if no grid yet.
  // d must be normalised
  PT.rayHit = (o, d, far, near = 0) => {
    if (!G) return null;
    const { mn, cs, dims, cells, mark } = G;
    stamp++;
    const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
    let t0 = near, t1 = far;
    for (let a = 0; a < 3; a++) {
      const lo = mn[a], hi = mn[a] + dims[a] * cs;
      if (Math.abs(D[a]) < 1e-9) { if (O[a] < lo || O[a] > hi) return Infinity; continue; }
      let ta = (lo - O[a]) / D[a], tb = (hi - O[a]) / D[a]; if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return Infinity;
    }
    const c = [0, 1, 2].map((a) => Math.min(dims[a] - 1, Math.max(0, Math.floor((O[a] + D[a] * (t0 + 1e-4) - mn[a]) / cs))));
    const step = D.map((x) => (x >= 0 ? 1 : -1));
    const tMax = [0, 1, 2].map((a) => (Math.abs(D[a]) < 1e-9 ? Infinity : (mn[a] + (c[a] + (step[a] > 0 ? 1 : 0)) * cs - O[a]) / D[a]));
    const tDelta = D.map((x) => (Math.abs(x) < 1e-9 ? Infinity : cs / Math.abs(x)));
    let best = far;
    for (let iter = 0; iter < 4096; iter++) {
      const arr = cells.get((c[0] * dims[1] + c[1]) * dims[2] + c[2]);
      if (arr) for (const i of arr) { if (mark[i] === stamp) continue; mark[i] = stamp; best = hitInstance(i, O[0], O[1], O[2], D[0], D[1], D[2], near, best); }
      const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (best <= tMax[a] || tMax[a] > t1) break;   // nothing in later cells can beat a hit inside this one
      c[a] += step[a]; if (c[a] < 0 || c[a] >= dims[a]) break;
      tMax[a] += tDelta[a];
    }
    return best < far ? best : Infinity;
  };
})();
// ptfx occlusion: baked whole-track sun shadows + sky visibility, minecraft-shader style.
//  - sun map: one orthographic depth render of the track from the light direction (sun, or moon at
//    night). long shadows everywhere at low sun, light patches through holes in roofs. re-baked only
//    when the light moves more than ~1 degree.
//  - sky maps: five ortho renders (straight down + four tilted) approximate how much open sky a point
//    sees; covered areas lose ambient light, tunnel mouths fade.
// track geometry is static, so everything bakes once per track. cars, sky and our own meshes are
// hidden while baking. the post pass rebalances each pixel's light: sun share x sun visibility,
// ambient share x sky visibility. the sky visibility also rides along in the alpha channel for later
// passes (weather keeps puddles out from under roofs), and the car's coverage drives headlights and
// eye adaptation.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ occlusion: true, sunShadows: 1, skyOcclusion: 1, eyeAdapt: 1 });

  const SUN_RES = 2048, SKY_RES = 768;
  // map stores (far - distance) so a cleared (0) texel means "nothing there"
  const DEPTH_V = `
varying float vD;
void main(){
  #include <begin_vertex>
  #include <project_vertex>
  vD = -mvPosition.z;
}`;
  const DEPTH_F = `
uniform float uFar;
varying float vD;
void main(){ gl_FragColor = vec4(uFar - vD, 0.0, 0.0, 1.0); }`;

  PT.SH.OCCL = `
uniform sampler2D tColor, tDepth, tSun, tS0, tS1, tS2, tS3, tS4;
uniform mat4 uInvVP, uSunM, uM0, uM1, uM2, uM3, uM4;
uniform vec3 uCamPos, uSunDir, uSunPos, uP0, uP1, uP2, uP3, uP4, uD0, uD1, uD2, uD3, uD4;
uniform float uFar, uSunRes, uSkyRes, uSunI, uAmbI, uSunAmt, uSkyAmt, uHasSun, uHasSky, uCamNear, uCamFar;
float camDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uCamNear * uCamFar / (uCamFar + uCamNear - z * (uCamFar - uCamNear)); }
// 1 = lit/visible, 0 = blocked. pcf over a small kernel; bias grows with the texel footprint
float visSky(sampler2D t, mat4 M, vec3 camP, vec3 dir, vec3 P, float res, float bias, float spread){
  vec4 q = M * vec4(P, 1.0);
  vec2 uv = q.xy / q.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float d = dot(P - camP, dir), s = 0.0;
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) {
    float h = texture2D(t, uv + (vec2(float(i), float(j)) - 0.5) * spread / res).r;
    s += (h > 0.0 && uFar - h < d - bias) ? 0.0 : 1.0;
  }
  return s * 0.25;
}
float vis(sampler2D t, mat4 M, vec3 camP, vec3 dir, vec3 P, float res, float bias, float spread){
  vec4 q = M * vec4(P, 1.0);
  vec2 uv = q.xy / q.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float d = dot(P - camP, dir);
  float s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float h = texture2D(t, uv + vec2(float(i), float(j)) * spread / res).r;
    float occ = uFar - h;                       // distance of the first surface along the map ray
    s += (h > 0.0 && occ < d - bias) ? 0.0 : 1.0;
  }
  return s / 9.0;
}
void main(){
  float z = texture2D(tDepth, vUv).r;
  if (z >= 0.99999) { gl_FragColor = vec4(1.0, 1.0, 1e6, 1.0); return; }
  vec4 p4 = uInvVP * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = p4.xyz / p4.w;
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  if (dot(N, uCamPos - P) < 0.0) N = -N;
  vec3 Pb = P + N * 0.15;                       // nudge off the surface against acne
  float sunV = 1.0, skyV = 1.0;
  if (uHasSun > 0.5) sunV = vis(tSun, uSunM, uSunPos, uSunDir, Pb, uSunRes, 0.6, 1.5);
  if (uHasSky > 0.5) {
    skyV = (visSky(tS0, uM0, uP0, uD0, Pb, uSkyRes, 1.2, 3.0) * 2.0 + visSky(tS1, uM1, uP1, uD1, Pb, uSkyRes, 1.2, 3.0)
          + visSky(tS2, uM2, uP2, uD2, Pb, uSkyRes, 1.2, 3.0) + visSky(tS3, uM3, uP3, uD3, Pb, uSkyRes, 1.2, 3.0)
          + visSky(tS4, uM4, uP4, uD4, Pb, uSkyRes, 1.2, 3.0)) / 6.0;
    skyV *= 0.75 + 0.25 * clamp(N.y * 0.5 + 0.5, 0.0, 1.0); // downward faces see less sky anyway
  }
  // rebalance light: direct sun share follows sun visibility, ambient share follows sky visibility,
  // with a bounce floor so covered areas are dark but never a void
  float ndl = max(dot(N, -uSunDir), 0.0);
  float s = uSunI * ndl, a = uAmbI;
  float k = (s * mix(1.0, sunV, uSunAmt) + a * mix(1.0, mix(0.22, 1.0, skyV), uSkyAmt)) / max(s + a, 1e-4);
  // factors only (half res); the lighting-apply pass (27-ssao) multiplies them in with ambient occlusion
  gl_FragColor = vec4(k, skyV, camDepth(z), 1.0);
}`;

  let maps = null, bakedKey = null, sunKey = null, depthMat = null, mat = null, sunCam = null, skyCams = [], center = null, R = 0;
  let coveredS = 0, coverRead = 0, adapt = 1;

  function trackMeshes(scene) {
    const out = [];
    scene.traverse((o) => { if (o.isMesh && !o.userData.ptfx && [].concat(o.material).every((m) => m.type === "MeshLambertMaterial")) out.push(o); });
    return out;
  }

  function bounds(T, meshes) {
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const m of meshes) {
      m.geometry.boundingBox || m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new T.Vector3(x, y, z).applyMatrix4(m.matrixWorld);
        for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], v.getComponent(i)); mx[i] = Math.max(mx[i], v.getComponent(i)); }
      }
    }
    return { mn, mx };
  }

  function makeRT(T, res) {
    return new T.WebGLRenderTarget(res, res, { type: 1015 /* Float */, minFilter: 1003, magFilter: 1003 /* Nearest */, depthBuffer: true });
  }

  function orthoCam(T, dir) {
    const cam = new T.OrthographicCamera(-R, R, R, -R, 0.1, R * 4);
    const pos = center.clone().addScaledVector(dir, -R * 2);   // dir = direction the map looks along
    cam.position.copy(pos);
    if (Math.abs(dir.y) > 0.99) cam.up.set(0, 0, 1);
    cam.lookAt(center);
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    cam.userData.dir = dir.clone();
    return cam;
  }

  function renderMap(ctx, cam, rt, meshes) {
    const { renderer, scene } = ctx;
    const hidden = [];
    scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine) && o.visible && !meshes.has(o)) { hidden.push(o); o.visible = false; } });
    const prevOverride = scene.overrideMaterial, prevBg = scene.background, cc = renderer.getClearColor(new ctx.T.Color()), ca = renderer.getClearAlpha();
    scene.overrideMaterial = depthMat; scene.background = null;
    depthMat.uniforms.uFar.value = R * 4;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam);
    scene.overrideMaterial = prevOverride; scene.background = prevBg; renderer.setClearColor(cc, ca);
    for (const o of hidden) o.visible = true;
    renderer.setRenderTarget(null);
  }

  function bake(ctx, sunOnly) {
    const { T } = ctx;
    const meshes = trackMeshes(ctx.scene);
    if (!meshes.length) return false;
    PT.trackMeshes = meshes;
    if (!sunOnly) PT.buildRayGrid?.(meshes, T);   // fast cpu raycasts (24-raygrid.js)
    const set = new Set(meshes);
    if (!sunOnly) {
      const b = bounds(T, meshes);
      center = new T.Vector3((b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2);
      R = Math.max(30, Math.hypot(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) / 2 * 1.05);
      // straight down (weighted 2x in the shader) + four tilted ~40 degrees off zenith
      const dirs = [new T.Vector3(0, -1, 0)];
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; dirs.push(new T.Vector3(Math.cos(a) * 0.64, -0.77, Math.sin(a) * 0.64).normalize()); }
      skyCams = dirs.map((d) => orthoCam(T, d));
      skyCams.forEach((cam, i) => renderMap(ctx, cam, maps.sky[i], set));
    }
    const L = PT.lightDir || [0.3, 0.8, 0.3];
    sunCam = orthoCam(T, new T.Vector3(-L[0], -L[1], -L[2]).normalize());
    renderMap(ctx, sunCam, maps.sun, set);
    return true;
  }

  function trackKey(scene) {
    let n = 0, v = 0;
    scene.traverse((o) => { if (o.isMesh && !o.userData.ptfx && [].concat(o.material).every((m) => m.type === "MeshLambertMaterial")) { n++; v += o.geometry.attributes.position.count; } });
    return scene.uuid + ":" + n + ":" + v;
  }

  // how much of the sky the car sees: five short raycasts up and out from the car against the track.
  // (this used to read the sky maps back from the gpu; every readback stalled the whole pipeline)
  let coverRay = null;
  const COVER_DIRS = [[0, 1, 0], [0.5, 0.85, 0], [-0.5, 0.85, 0], [0, 0.85, 0.5], [0, 0.85, -0.5]];
  // one ray per frame in rotation (5 at once made a periodic spike); coverage = weighted share of hits
  const coverHits = [0, 0, 0, 0, 0];
  let coverIdx = 0;
  function readCovered(ctx) {
    const car = PT.playerBeam?.pos, meshes = PT.trackMeshes;
    if (!car || !meshes?.length || !ctx.T.Raycaster) return null;
    const { T } = ctx;
    const P = new T.Vector3(...car).add(new T.Vector3(0, 0.6, 0));
    const i = coverIdx = (coverIdx + 1) % COVER_DIRS.length;
    const dir = new T.Vector3(...COVER_DIRS[i]).normalize();
    let g = PT.rayHit?.(P, dir, 120, 0.5);
    if (g === null || g === undefined) {   // grid not built yet: three's raycaster (slow) as a fallback
      coverRay ??= new T.Raycaster(); coverRay.set(P, dir); coverRay.near = 0.5; coverRay.far = 120;
      g = coverRay.intersectObjects(meshes, false).length ? 1 : Infinity;
    }
    coverHits[i] = g < Infinity ? 1 : 0;
    return (coverHits[0] * 2 + coverHits[1] + coverHits[2] + coverHits[3] + coverHits[4]) / 6;
  }

  PT.passes.push({
    name: "occlusion",
    beforeScene(ctx) {
      const { T } = ctx;
      if (!cfg.occlusion) { PT.covered = 0; PT.occl = null; return; }
      if (!maps) {
        maps = { sun: makeRT(T, SUN_RES), sky: [0, 1, 2, 3, 4].map(() => makeRT(T, SKY_RES)) };
        depthMat = new T.ShaderMaterial({ vertexShader: DEPTH_V, fragmentShader: DEPTH_F, uniforms: { uFar: { value: 1000 } }, side: 2 });
      }
      // full bake when the track changes (checked every ~2s), sun-only when the light moved > ~1 degree
      if (ctx.state.frame % 120 === 1 || !bakedKey) {
        const key = trackKey(ctx.scene);
        if (key !== bakedKey && bake(ctx, false)) { bakedKey = key; sunKey = (PT.lightDir || []).join(); }
      }
      if (bakedKey && PT.lightDir && sunCam) {
        const L = new T.Vector3(...PT.lightDir).normalize();
        if (L.dot(sunCam.userData.dir.clone().negate()) < Math.cos(Math.PI / 180)) bake(ctx, true);
      }
      // car coverage, read back every 8 frames, smoothed (headlights + eye adaptation use it)
      if (bakedKey && ctx.state.frame - coverRead >= 1) {
        coverRead = ctx.state.frame;
        const c = readCovered(ctx);
        if (c !== null) PT.coveredRaw = c;
      }
      const dt = Math.min(ctx.state.dt, 0.1), raw = PT.coveredRaw ?? 0;
      coveredS += (raw - coveredS) * (1 - Math.exp(-dt / (raw > coveredS ? 0.4 : 0.8)));
      PT.covered = Math.min(1, Math.max(0, (coveredS - 0.35) / 0.4));   // mostly-covered counts as covered
      // eye adaptation: open up slowly in the dark, close faster in the light (that brief overexposure
      // stepping out of a tunnel)
      const target = 1 + 1.3 * PT.covered * (PT.day ?? 1) * cfg.eyeAdapt;
      adapt += (target - adapt) * (1 - Math.exp(-dt / (target > adapt ? 1.4 : 0.5)));
      ctx.exposureMul = (ctx.exposureMul ?? 1) * adapt;
    },
    run(ctx) {
      PT.occlFactors = null;
      if (!cfg.occlusion || !bakedKey || !sunCam) return;
      const { T } = ctx;
      if (!mat) {
        const u = {
          tColor: { value: null }, tDepth: { value: null }, tSun: { value: null }, uInvVP: { value: new T.Matrix4() }, uSunM: { value: new T.Matrix4() },
          uCamPos: { value: new T.Vector3() }, uSunDir: { value: new T.Vector3() }, uSunPos: { value: new T.Vector3() },
          uFar: { value: 1 }, uSunRes: { value: SUN_RES }, uSkyRes: { value: SKY_RES }, uSunI: { value: 1 }, uAmbI: { value: 0.5 },
          uSunAmt: { value: 1 }, uSkyAmt: { value: 1 }, uHasSun: { value: 1 }, uHasSky: { value: 1 }, uCamNear: { value: 0.5 }, uCamFar: { value: 1e4 },
        };
        for (let i = 0; i < 5; i++) { u["tS" + i] = { value: null }; u["uM" + i] = { value: new T.Matrix4() }; u["uP" + i] = { value: new T.Vector3() }; u["uD" + i] = { value: new T.Vector3() }; }
        mat = ctx.material(PT.SH.OCCL, u);
      }
      const u = mat.uniforms, cam = ctx.camera;
      const vpOf = (c) => new T.Matrix4().copy(c.projectionMatrix).multiply(c.matrixWorldInverse);
      u.tColor.value = ctx.color; u.tDepth.value = ctx.depth; u.tSun.value = maps.sun.texture;
      u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
      u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      u.uSunM.value.copy(vpOf(sunCam)); u.uSunDir.value.copy(sunCam.userData.dir); u.uSunPos.value.copy(sunCam.position);
      skyCams.forEach((c, i) => { u["tS" + i].value = maps.sky[i].texture; u["uM" + i].value.copy(vpOf(c)); u["uP" + i].value.copy(c.position); u["uD" + i].value.copy(c.userData.dir); });
      u.uFar.value = R * 4;
      const lv = PT.lightLevels || { dirI: 1, amb: 1 };
      u.uSunI.value = lv.dirI; u.uAmbI.value = lv.amb * 0.45;
      u.uSunAmt.value = cfg.sunShadows; u.uSkyAmt.value = cfg.skyOcclusion;
      const out = ctx.rt("occlF", Math.max(1, ctx.w >> 1), Math.max(1, ctx.h >> 1));
      u.uCamNear.value = cam.near; u.uCamFar.value = cam.far;
      ctx.pass(ctx.renderer, mat, out);
      PT.occlFactors = out.texture;
      PT.occl = { up: maps.sky[0].texture, upM: vpOf(skyCams[0]), upPos: skyCams[0].position, upDir: skyCams[0].userData.dir, far: R * 4,
        sun: maps.sun.texture, sunM: vpOf(sunCam), sunPos: sunCam.position, sunDir: sunCam.userData.dir };
    },
  });
})();
// ptfx ambient occlusion: soft contact darkening in corners, under the car, where walls meet the road.
// half-res, normal-oriented hemisphere samples in world space (position + face normal from depth),
// then a depth-aware blur and a composite that darkens mostly the ambient part of the light.
// sky visibility in the alpha channel is passed through untouched.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ ao: true, aoStrength: 0.8, aoRadius: 1.4 });

  PT.SH.AO = `
uniform sampler2D tDepth;
uniform mat4 uInvVP, uVP; uniform vec3 uCamPos;
uniform float uNear, uFar, uRadius;
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main(){
  float z = texture2D(tDepth, vUv).r;
  if (z >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec4 p4 = uInvVP * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = p4.xyz / p4.w;
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  if (dot(N, uCamPos - P) < 0.0) N = -N;
  float vz = viewDepth(z);
  // tangent frame with a per-pixel random rotation
  float a = hash12(gl_FragCoord.xy) * 6.2831;
  vec3 up = abs(N.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  vec3 T = normalize(cross(up, N)), B = cross(N, T);
  vec3 Tr = T * cos(a) + B * sin(a), Br = cross(N, Tr);
  float r = uRadius * (0.6 + 0.4 * smoothstep(5.0, 60.0, vz));   // a bit wider far away
  float occ = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float h = hash12(vec2(fi * 7.1, fi * 3.3) + 0.5);
    float phi = fi * 2.39996, ct = sqrt(1.0 - (fi + 0.5) / 8.0), st = sqrt(1.0 - ct * ct);
    vec3 dir = Tr * cos(phi) * st + Br * sin(phi) * st + N * ct;
    float len = r * mix(0.15, 1.0, (fi + h) / 8.0);
    vec3 S = P + dir * len;
    vec4 q = uVP * vec4(S, 1.0);
    vec2 uv = q.xy / q.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float sz = viewDepth(texture2D(tDepth, uv).r);
    float dz = q.w - sz;                                          // >0: something is in front of the sample
    occ += step(0.03, dz) * smoothstep(r * 2.0, r * 0.5, dz);     // ignore occluders far behind
  }
  float ao = 1.0 - occ / 8.0;
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;
  PT.SH.AO_BLUR = `
uniform sampler2D tAO, tDepth; uniform vec2 uDir; uniform float uNear, uFar;
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main(){
  float d0 = viewDepth(texture2D(tDepth, vUv).r);
  float s = 0.0, w = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * float(i);
    float d = viewDepth(texture2D(tDepth, uv).r);
    float wi = exp(-abs(d - d0) / max(d0 * 0.03, 0.05)) * (1.0 - abs(float(i)) / 4.0);
    s += texture2D(tAO, uv).r * wi; w += wi;
  }
  gl_FragColor = vec4(vec3(s / max(w, 1e-4)), 1.0);
}`;
  PT.SH.AO_MIX = `
uniform sampler2D tColor, tAO, tOcc, tDepth; uniform float uStrength, uLinearIn, uHasAO, uHasOcc, uNear, uFar; uniform vec2 uHalfTexel;
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main(){
  vec4 c = texture2D(tColor, vUv);
  vec3 col = uLinearIn > 0.5 ? c.rgb : srgb2lin(c.rgb);
  float ao = uHasAO > 0.5 ? mix(1.0, texture2D(tAO, vUv).r, uStrength) : 1.0;
  vec2 f = vec2(1.0);
  if (uHasOcc > 0.5) {
    // depth-aware upsample of the half-res light factors: prefer neighbours at the same depth so lighting
    // doesn't bleed across silhouettes
    float d0 = viewDepth(texture2D(tDepth, vUv).r);
    vec2 acc = vec2(0.0); float wsum = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 o = vec2(i == 1 || i == 3 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0) * 0.5 * uHalfTexel;
      vec3 t = texture2D(tOcc, vUv + o).rgb;
      float w = 1.0 / (1e-3 + abs(t.b - d0) / max(d0, 1.0));
      acc += t.rg * w; wsum += w;
    }
    f = acc / wsum;
  }
  gl_FragColor = vec4(col * f.x * ao, uHasOcc > 0.5 ? f.y : c.a);
}`;
  let aoMat = null, blurMat = null, mixMat = null;
  PT.passes.push({
    name: "ssao",
    run(ctx) {
      const doAO = cfg.ao && cfg.aoStrength > 0, occ = PT.occlFactors;
      if (!doAO && !occ) return;
      const { T, renderer } = ctx, cam = ctx.camera;
      if (!aoMat) {
        aoMat = ctx.material(PT.SH.AO, { tDepth: { value: null }, uInvVP: { value: new T.Matrix4() }, uVP: { value: new T.Matrix4() },
          uCamPos: { value: new T.Vector3() }, uNear: { value: 0.5 }, uFar: { value: 1e4 }, uRadius: { value: 1.4 } });
        blurMat = ctx.material(PT.SH.AO_BLUR, { tAO: { value: null }, tDepth: { value: null }, uDir: { value: new T.Vector2() }, uNear: { value: 0.5 }, uFar: { value: 1e4 } });
        mixMat = ctx.material(PT.SH.AO_MIX, { tColor: { value: null }, tAO: { value: null }, tOcc: { value: null }, tDepth: { value: null }, uStrength: { value: 1 }, uLinearIn: { value: 0 },
          uHasAO: { value: 1 }, uHasOcc: { value: 0 }, uNear: { value: 0.5 }, uFar: { value: 1e4 }, uHalfTexel: { value: new T.Vector2() } });
      }
      const hw = Math.max(1, ctx.w >> 1), hh = Math.max(1, ctx.h >> 1);
      const a = ctx.rt("aoA", hw, hh), b = ctx.rt("aoB", hw, hh);
      if (doAO) {
        const u = aoMat.uniforms;
        u.tDepth.value = ctx.depth;
        u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
        u.uVP.value.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
        u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
        u.uNear.value = cam.near; u.uFar.value = cam.far; u.uRadius.value = cfg.aoRadius;
        ctx.pass(renderer, aoMat, a);
        const bu = blurMat.uniforms; bu.tDepth.value = ctx.depth; bu.uNear.value = cam.near; bu.uFar.value = cam.far;
        bu.tAO.value = a.texture; bu.uDir.value.set(1 / hw, 0); ctx.pass(renderer, blurMat, b);
        bu.tAO.value = b.texture; bu.uDir.value.set(0, 1 / hh); ctx.pass(renderer, blurMat, a);
      }
      const out = ctx.rt("aoOut", ctx.w, ctx.h);
      const mu = mixMat.uniforms;
      mu.tColor.value = ctx.color; mu.tAO.value = a.texture; mu.uHasAO.value = doAO ? 1 : 0;
      mu.tOcc.value = occ; mu.uHasOcc.value = occ ? 1 : 0; mu.tDepth.value = ctx.depth;
      mu.uNear.value = cam.near; mu.uFar.value = cam.far; mu.uHalfTexel.value.set(1 / hw, 1 / hh);
      mu.uStrength.value = cfg.aoStrength; mu.uLinearIn.value = ctx.linear ? 1 : 0;
      ctx.pass(renderer, mixMat, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx headlights: screen-space beams, a front LED strip and the model's own brake light, for every
// car in the scene. the player car is the one the camera keeps centred (smoothed, with hysteresis);
// ghosts get the same lights at reduced power behind their own toggle. per-car state means nothing
// ever jumps between cars.
// real three.js spotlights barely lit flat road (the beam grazes it, N·L ~ 0.05) and recompiled every
// material, so the beams are drawn in post instead: world position comes from depth, the face normal
// from its derivatives (exact on low-poly faces), and the beam is an authored pattern rather than a cone.
//
// car axes: the body's longest local bbox axis is the nose-tail line, fixed per model. motion only
// decides which end is the front, and that answer locks once confident, so spins and slides can't
// drag the beams around. up is locked at the same moment.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ headlights: true, hlAuto: true, hlManual: false, hlPower: 1, hlRange: 320, hlLift: 0.4, hlDip: 0.012, hlLeds: true, brakeLights: true, ledPower: 1, brakePower: 1, tailPool: 1, hlWarmth: 0.5, ghostLights: true, ghostPower: 0.35 });

  PT.SH.HEADLIGHTS = `
uniform sampler2D tColor, tDepth;
uniform mat4 uInvVP; uniform vec3 uCamPos;
// up to 3 cars in ONE pass (it used to be a full-screen pass per car)
uniform vec3 uL0[3], uL1[3], uFwdA[3], uUpA[3], uRightA[3], uT0[3], uT1[3];
uniform float uIA[3], uTailA[3];
uniform int uN;
uniform vec3 uCol, uAlbGain;
uniform float uRange, uLift, uDip, uR0;
vec3 uFwd, uUp, uRight;   // the car being shaded (set per loop iteration)
float beam(vec3 P, vec3 N, vec3 L){
  vec3 v = P - L; float dist = length(v); vec3 dir = v / dist;
  float f = dot(dir, uFwd);
  if (f <= 0.0) return 0.0;
  float h = atan(dot(dir, uRight), f);                       // horizontal angle off the nose
  float e = asin(clamp(dot(dir, uUp), -1.0, 1.0)) + uDip;    // elevation above the cutoff line
  float spill = 1.0 - smoothstep(0.35, 0.8, abs(h));         // wide fan, ~±45 degrees
  float hot = exp(-h * h / 0.045);                           // bright middle for the long throw
  float below = 1.0 - smoothstep(0.4, 1.0, -e);
  float cut = 1.0 - smoothstep(-0.03, 0.04, e);              // soft flat top...
  float reach = 1.0 - smoothstep(0.04, 0.22, e);             // ...that still climbs ~12 degrees, dimmer
  float pattern = below * (spill * mix(0.22 * reach, 0.5, cut) + hot * cut * 1.3);
  float fall = pow(1.0 + dist / uR0, -1.6) * (1.0 - smoothstep(uRange * 0.6, uRange, dist));
  float ndl = dot(N, -dir);
  float lit = smoothstep(0.0, 0.03, ndl) * mix(max(ndl, 0.0), 1.0, uLift);  // grazing road still reads
  return pattern * fall * lit;
}
// tail/brake light: a short, wide red pool behind the car
float tail(vec3 P, vec3 N, vec3 L){
  vec3 v = P - L; float dist = length(v); vec3 dir = v / dist;
  float back = smoothstep(-0.3, 0.5, dot(dir, -uFwd));
  // starts ~0.6m out so it pools on the road instead of washing the car's own tail
  float fall = smoothstep(0.4, 1.2, dist) / (1.0 + dist * dist / 9.0) * (1.0 - smoothstep(12.0, 22.0, dist));
  float ndl = dot(N, -dir);
  return back * fall * smoothstep(0.0, 0.05, ndl) * mix(max(ndl, 0.0), 1.0, 0.5);
}
void main(){
  vec4 s4 = texture2D(tColor, vUv); vec3 src = s4.rgb;   // alpha = sky visibility, passed through
  float z = texture2D(tDepth, vUv).r;
  if (z >= 0.99999 || uN == 0) { gl_FragColor = s4; return; }
  vec4 p = uInvVP * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = p.xyz / p.w;
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  if (dot(N, uCamPos - P) < 0.0) N = -N;
  vec3 alb = clamp(src * uAlbGain, 0.0, 1.0);
  vec3 add = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    if (i >= uN) break;
    uFwd = uFwdA[i]; uUp = uUpA[i]; uRight = uRightA[i];
    float b = uIA[i] > 0.0 ? beam(P, N, uL0[i]) + beam(P, N, uL1[i]) : 0.0;
    float t = uTailA[i] > 0.0 ? tail(P, N, uT0[i]) + tail(P, N, uT1[i]) : 0.0;
    add += uCol * uIA[i] * b + vec3(1.0, 0.06, 0.03) * uTailA[i] * t;
  }
  gl_FragColor = vec4(src + alb * add, s4.a);
}
`;

  const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const cars = new Map();          // Body mesh -> per-car state
  let player = null, scanAt = 0, mat = null;
  let lastInput = -1e9;
  const keys = new Set();
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
  window.addEventListener("keydown", (e) => {
    if (typing(e)) return;
    keys.add(e.code);
    if (/^(Arrow|Key[WASD]$)/.test(e.code)) lastInput = performance.now();
    // manual headlight toggle on E or ?/ ; the first press takes over from auto
    if (!e.repeat && (e.code === "KeyE" || e.code === "Slash") && player) {   // no car = editor/menus (E rotates the editor view)
      const lit = player && cars.get(player)?.on > 0.02;
      cfg.hlManual = cfg.hlAuto ? !lit : !cfg.hlManual;
      cfg.hlAuto = false; PT.save?.(); PT.onReset?.();
    }
  }, true);
  window.addEventListener("keyup", (e) => keys.delete(e.code), true);
  window.addEventListener("blur", () => keys.clear());

  function newCar(body) {
    return { body, lock: null, vote: 0, upVote: 0, lastPos: null, lastCtr: null, fwdSpeed: 0, accelEma: 0, brake: 0,
      leds: [], ledKey: null, anchors: {}, follow: 0, on: 0, tailI: 0, L0: [0, 0, 0], L1: [0, 0, 0], T0: [0, 0, 0], T1: [0, 0, 0],
      F: [0, 0, 1], U: [0, 1, 0], R: [1, 0, 0] };
  }

  // car groups: scene children whose meshes are all standard materials; the part named Body has sane axes
  function scan(ctx) {
    const seen = new Set();
    for (const g of ctx.scene.children) {
      if (g.isMesh || g.isLight || g.isCamera) continue;
      const meshes = [];
      g.traverse((x) => { if (x.isMesh && !x.userData.ptfx) meshes.push(x); });
      if (meshes.length < 3 || !meshes.every((m) => [].concat(m.material).every((k) => k.isMeshStandardMaterial))) continue;
      let body = meshes.find((m) => m.name === "Body") || null;
      if (!body) { let r = -1; for (const m of meshes) { if (/wheel/i.test(m.name)) continue; const n = m.geometry.attributes.position.count; if (n > r) { r = n; body = m; } } }
      if (!body) continue;
      seen.add(body);
      if (!cars.has(body)) cars.set(body, newCar(body));
    }
    for (const [b, c] of cars) if (!seen.has(b)) { for (const l of c.leds) l.parent?.remove(l); cars.delete(b); if (player === b) player = null; }
  }

  // which car the camera is following: how centred and close it stays, smoothed over ~1s.
  // the player only changes when another car beats it clearly, so an overlapping ghost can't steal it
  function pickPlayer(ctx) {
    const { T } = ctx, dt = ctx.state.dt, camera = PT.gameCamera || ctx.camera;   // never our cinematic cam
    const cam = new T.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const look = new T.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    let best = null, bestS = -1;
    for (const [b, c] of cars) {
      b.updateWorldMatrix(true, false);
      const p = new T.Vector3().setFromMatrixPosition(b.matrixWorld), d = p.clone().sub(cam), dist = d.length();
      const centred = Math.max(0, d.normalize().dot(look));
      const score = b.parent?.visible === false ? 0 : Math.pow(centred, 8) / (1 + dist / 20);
      c.follow += (score - c.follow) * (1 - Math.exp(-dt / 1.0));
      if (c.follow > bestS) { bestS = c.follow; best = b; }
    }
    if (!player || !cars.has(player)) player = best;
    else if (best !== player && bestS > cars.get(player).follow * 1.6 + 0.02) player = best;
  }

  // local axes from the body's bbox: longest = nose-tail, shortest = height (true for any race car),
  // the middle one = width. motion picks which end is the nose; world-up averaged over the learning
  // period picks which side is the roof. both lock together once the car has driven a few lengths.
  // camera hooks run BEFORE this module's beforeScene, so a stored pose is one frame old: a cam bolted to
  // it shakes against the car. re-project the pose through the body's current world matrix instead
  PT.livePose = (p, T) => {
    if (!p?.body || !p.mw) return p;
    p.body.updateWorldMatrix(true, false);
    const D = p.body.matrixWorld.clone().multiply(p.mw.clone().invert());
    return { ...p, pos: p.pos.clone().applyMatrix4(D), fwd: p.fwd.clone().transformDirection(D), up: p.up.clone().transformDirection(D), right: p.right.clone().transformDirection(D) };
  };

  function axes(ctx, c) {
    const { T } = ctx, body = c.body;
    const m = body.matrixWorld;
    body.geometry.boundingBox || body.geometry.computeBoundingBox();
    const bb = body.geometry.boundingBox, size = bb.getSize(new T.Vector3()).toArray();
    const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
    const ai = order[0], wi = order[1], ui = order[2];
    const world = (i, s) => new T.Vector3(...AX[i]).multiplyScalar(s).transformDirection(m);
    const ctr = bb.getCenter(new T.Vector3()).applyMatrix4(m);
    let sign, us;
    // the stock model's part named "Body" is z-forward, y-up: no learning needed (learning from motion
    // locked backwards if you reversed first). only unknown models fall back to learning
    if (!c.lock && body.name === "Body" && ai === 2 && ui === 1) c.lock = { sign: 1, us: 1 };
    if (c.lock) ({ sign, us } = c.lock);
    else {
      const cam = new T.Vector3().setFromMatrixPosition(ctx.camera.matrixWorld);
      const axisW = world(ai, 1);
      if (c.lastPos) { const v = ctr.clone().sub(c.lastPos); if (v.length() > 0.01 && v.length() < 5) c.vote += v.dot(axisW); }
      c.upVote += world(ui, 1).y;
      sign = Math.abs(c.vote) > 0.5 ? Math.sign(c.vote) : Math.sign(axisW.dot(ctr.clone().sub(cam)) || 1);
      us = Math.sign(c.upVote) || 1;
      if (Math.abs(c.vote) > size[ai] * 4) c.lock = { sign, us };
    }
    c.lastPos = ctr;
    const fwd = world(ai, sign), up = world(ui, us), right = new T.Vector3().crossVectors(fwd, up).normalize();
    return { bb, size, ai, ui, wi, sign, us, ctr, fwd, up, right };
  }

  // where the nose (or tail) actually is: vertices in the end 12% of the body, their mean height
  function endAnchor(c, a, rear) {
    const key = c.body.geometry.uuid + a.sign + a.us + (rear ? "r" : "f");
    if (c.anchors[key]) return c.anchors[key];
    const pos = c.body.geometry.attributes.position, n = pos.count, s = rear ? -a.sign : a.sign;
    let front = -1e9;
    for (let i = 0; i < n; i++) front = Math.max(front, s * pos.getComponent(i, a.ai));
    const cw = a.bb.getCenter(a.ctr.clone()).toArray()[a.wi];
    let h = 0, k = 0, wmax = 0;
    for (let i = 0; i < n; i++) {
      if (s * pos.getComponent(i, a.ai) < front - a.size[a.ai] * 0.12) continue;
      h += pos.getComponent(i, a.ui); k++; wmax = Math.max(wmax, Math.abs(pos.getComponent(i, a.wi) - cw));
    }
    return (c.anchors[key] = { front: s * front, h: h / Math.max(k, 1), half: Math.max(wmax, a.size[a.wi] * 0.15) });
  }

  function ensureLeds(ctx, c, a) {
    const key = c.body.uuid + a.sign + a.us;
    if (c.ledKey === key && c.leds.length) return;
    for (const l of c.leds) l.parent?.remove(l);
    c.leds = []; c.ledKey = key;
    const { T } = ctx;
    // one full-width strip across the nose; colour set per frame (>1: HDR, bloom picks it up)
    const m = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial({ color: 0xffffff }));
    m.userData.ptfx = true;
    const nz = endAnchor(c, a, false), pos = a.bb.getCenter(new T.Vector3()).toArray(), sc = [1, 1, 1];
    pos[a.ai] = nz.front - a.sign * a.size[a.ai] * 0.015;   // sunk slightly into the nose so it reads as part of it
    pos[a.ui] = nz.h;
    sc[a.ai] = a.size[a.ai] * 0.03; sc[a.wi] = nz.half * 1.7; sc[a.ui] = a.size[a.ui] * 0.07;
    m.position.set(...pos); m.scale.set(...sc);
    c.body.add(m); c.leds.push(m);
  }

  function update(ctx, c, isPlayer) {
    const { T } = ctx, body = c.body;
    const night = 1 - (PT.day ?? 1);
    const auto = Math.max(night, PT.covered ?? 0, (PT.weather?.rain ?? 0) * 0.8, (1 - (PT.weather?.dim ?? 1)) * 0.6);
    let want;
    if (isPlayer) want = cfg.hlAuto ? auto : cfg.hlManual ? Math.max(night, 0.6) : 0;
    else {
      // ghosts far from the camera aren't worth a full-screen pass
      const near = new T.Vector3().setFromMatrixPosition(body.matrixWorld).distanceTo(new T.Vector3().setFromMatrixPosition(ctx.camera.matrixWorld)) < 90;
      want = cfg.ghostLights && near ? auto : 0;
    }
    let power = isPlayer ? 1 : cfg.ghostPower;
    // a ghost sitting on top of you (race start, or matching your line) would just double your beam
    if (!isPlayer && player) {
      const gp = new T.Vector3().setFromMatrixPosition(body.matrixWorld), pp = new T.Vector3().setFromMatrixPosition(player.matrixWorld);
      const d = gp.distanceTo(pp);
      power *= Math.min(1, Math.max(0, (d - 1.5) / 4));
    }
    c.on = cfg.headlights ? want : 0;
    const a = axes(ctx, c);
    for (const [L, side] of [[c.L0, -1], [c.L1, 1]]) {
      const nz = endAnchor(c, a, false), lp = a.bb.getCenter(new T.Vector3()).toArray();
      lp[a.ai] = nz.front; lp[a.ui] = nz.h; lp[a.wi] += side * nz.half * 0.55;
      const p = new T.Vector3(...lp).applyMatrix4(body.matrixWorld).addScaledVector(a.fwd, 0.05);
      L[0] = p.x; L[1] = p.y; L[2] = p.z;
    }
    c.F = a.fwd.toArray(); c.U = a.up.toArray(); c.R = a.right.toArray();
    c.pose = { at: performance.now(), body, mw: body.matrixWorld.clone(), pos: a.ctr.clone(), fwd: a.fwd.clone(), up: a.up.clone(), right: a.right.clone(), isPlayer };

    // brake detection. player: the brake key while rolling forward. replays/ghosts: sustained
    // deceleration from a smoothed speed (physics ticks and render frames don't line up, so raw
    // frame-to-frame speed jitters enough to fake braking constantly)
    const dt = Math.max(ctx.state.dt, 1e-3);
    if (c.lastCtr && !ctx.photo) {
      const v = a.ctr.clone().sub(c.lastCtr).dot(a.fwd) / dt;
      const prev = c.fwdSpeed;
      c.fwdSpeed += (v - c.fwdSpeed) * (1 - Math.exp(-dt / 0.15));
      c.accelEma += ((c.fwdSpeed - prev) / dt - c.accelEma) * (1 - Math.exp(-dt / 0.2));
      const pressing = isPlayer && (keys.has("ArrowDown") || keys.has("KeyS"));
      const byMotion = (!isPlayer || performance.now() - lastInput > 3000) && c.accelEma < -30 && c.fwdSpeed > 2;
      const target = cfg.brakeLights && ((pressing && c.fwdSpeed > 0.5) || byMotion) ? 1 : 0;
      c.brake += (target - c.brake) * (target > c.brake ? 0.6 : 0.2);
    }
    if (isPlayer && !ctx.photo) {
      const vel = c.lastCtr ? a.ctr.clone().sub(c.lastCtr).divideScalar(dt) : new T.Vector3();
      PT.playerCar = { at: performance.now(), body, mw: body.matrixWorld.clone(), pos: a.ctr.clone(), fwd: a.fwd.clone(), up: a.up.clone(), right: a.right.clone(), vel: vel.length() < 400 ? vel : new T.Vector3(), speed: Math.abs(c.fwdSpeed) };
    }
    if (!ctx.photo) c.lastCtr = a.ctr.clone();
    c.tailI = cfg.brakeLights ? (c.on * 0.25 + c.brake * (0.4 + 1.1 * Math.max(night, 0.15))) * power : 0;
    for (const [L, side] of [[c.T0, -1], [c.T1, 1]]) {
      const nz = endAnchor(c, a, true), lp = a.bb.getCenter(new T.Vector3()).toArray();
      lp[a.ai] = nz.front; lp[a.ui] = nz.h; lp[a.wi] += side * nz.half * 0.2;
      const p = new T.Vector3(...lp).applyMatrix4(body.matrixWorld).addScaledVector(a.fwd, -0.05);
      L[0] = p.x; L[1] = p.y; L[2] = p.z;
    }
    ensureLeds(ctx, c, a);
    const tailGlow = (0.6 * c.on + c.brake * 1.7) * cfg.brakePower * power, lp = 2.3 * cfg.ledPower * (isPlayer ? 1 : 0.6);
    // the car's own BrakeLight material, cloned per car so other cars don't light with this one
    if (Array.isArray(body.material)) {
      const i = body.material.findIndex((m) => m.name === "BrakeLight");
      if (i >= 0) {
        if (!body.material[i].userData.ptfx) { const cl = body.material[i].clone(); cl.userData.ptfx = true; body.material = body.material.slice(); body.material[i] = cl; }
        const bm = body.material[i];
        bm.emissive.setRGB(1, 0.02, 0.01); bm.emissiveIntensity = cfg.brakeLights ? tailGlow * 1.6 : 0;
      }
    }
    for (const l of c.leds) { l.visible = !!cfg.hlLeds && c.on > 0.02; l.material.color.setRGB(lp * 0.96, lp, lp * 1.13); }
    c.power = power;
  }

  PT.passes.push({
    name: "headlights",
    beforeScene(ctx) {
      if (ctx.state.frame >= scanAt) { scan(ctx); scanAt = ctx.state.frame + 30; }
      if (!cars.size) return;
      if (!ctx.photo) pickPlayer(ctx);
      for (const [b, c] of cars) update(ctx, c, b === player);
      PT.ghostPoses = [...cars.values()].filter((c) => c.pose && !c.pose.isPlayer).map((c) => c.pose);
      const p = player && cars.get(player);
      if (p) {
        PT.hlDebug = { on: p.on, lock: p.lock, F: p.F, U: p.U, cars: cars.size, tailI: p.tailI, brake: p.brake, speed: p.fwdSpeed };
        PT.playerBeam = { pos: p.L0.map((x, i) => (x + p.L1[i]) / 2), fwd: p.F, on: p.on * cfg.hlPower };
      } else PT.playerBeam = null;
    },
    run(ctx) {
      const { T } = ctx;
      // gather the lit cars (player first), max 3, into one pass
      const lit = [];
      for (const [b, c] of cars) {
        const beam = c.on > 0.02 ? 7 * c.on * cfg.hlPower * c.power : 0, tail = c.tailI > 0.02 ? c.tailI * 2.6 * cfg.tailPool : 0;
        if (beam > 0 || tail > 0) (b === player ? lit.unshift : lit.push).call(lit, { c, beam, tail });
      }
      if (!lit.length) return;
      if (!mat) {
        const v3 = () => ({ value: [0, 1, 2].map(() => new T.Vector3()) });
        mat = ctx.material(PT.SH.HEADLIGHTS, {
          tColor: { value: null }, tDepth: { value: null }, uInvVP: { value: new T.Matrix4() }, uCamPos: { value: new T.Vector3() },
          uL0: v3(), uL1: v3(), uFwdA: v3(), uUpA: v3(), uRightA: v3(), uT0: v3(), uT1: v3(),
          uIA: { value: [0, 0, 0] }, uTailA: { value: [0, 0, 0] }, uN: { value: 0 },
          uCol: { value: new T.Vector3(1.0, 0.95, 0.86) }, uAlbGain: { value: new T.Vector3(1, 1, 1) },
          uRange: { value: 260 }, uLift: { value: 0.4 }, uDip: { value: 0.012 }, uR0: { value: 8 },
        });
      }
      const u = mat.uniforms, cam = ctx.camera;
      u.tColor.value = ctx.color; u.tDepth.value = ctx.depth;
      u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
      u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      const n = Math.min(3, lit.length);
      for (let i = 0; i < 3; i++) {
        const e = lit[i];
        u.uIA.value[i] = e ? e.beam : 0; u.uTailA.value[i] = e ? e.tail : 0;
        if (!e) continue;
        const c = e.c;
        u.uL0.value[i].set(...c.L0); u.uL1.value[i].set(...c.L1); u.uFwdA.value[i].set(...c.F); u.uUpA.value[i].set(...c.U); u.uRightA.value[i].set(...c.R);
        u.uT0.value[i].set(...c.T0); u.uT1.value[i].set(...c.T1);
      }
      u.uN.value = n;
      // the scene colour is albedo x ambient; divide the (tinted, dimmed) ambient back out
      const amb = PT.ambient || { col: [1, 1, 1], i: 1 };
      u.uAlbGain.value.set(...amb.col.map((x) => 1 / Math.max(0.02, x * amb.i * 0.55)));
      u.uRange.value = cfg.hlRange; u.uLift.value = cfg.hlLift; u.uDip.value = cfg.hlDip;
      const w = cfg.hlWarmth; u.uCol.value.set(1, 0.9 + 0.1 * (1 - w), 0.72 + 0.4 * (1 - w));
      const out = ctx.rt("headlights", ctx.w, ctx.h);
      ctx.pass(ctx.renderer, mat, out);
      return out.texture;
    },
  });
})();
// ptfx track glow: at night kerbs (red/white), arrows and signs (amber) light themselves. track pieces are vertex-coloured
// Lambert materials with an exact palette (kerb red = 0.8,0,0, kerb white = 1,1,1), so the material
// is patched once to emit where vColor matches (plus the tan that sign chevrons use); strength is a shared uniform, no further recompiles.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ edgeGlow: true, edgeGlowAlways: false, edgeGlowPower: 1, glowSpill: 0.6 });

  // on between 18:00 and 06:00, fading over half an hour at each end
  const hoursGlow = (h) => { const s = (x) => Math.min(1, Math.max(0, x)); return Math.max(s((h - 17.75) / 0.5), s((6.25 - h) / 0.5)); };
  PT.edgeGlowLevel = () => (!cfg.edgeGlow ? 0 : cfg.edgeGlowAlways ? 1 : hoursGlow(cfg.timeOfDay));

  const U = { uEdgeGlow: { value: 0 }, uTanOK: { value: 0 } };
  const patched = new WeakSet();

  function patch(m) {
    patched.add(m);
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = function (sh, r) {
      prev?.call(this, sh, r);
      sh.uniforms.uEdgeGlow = U.uEdgeGlow; sh.uniforms.uTanOK = U.uTanOK;
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uEdgeGlow, uTanOK;")
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
#ifdef USE_COLOR
{
  vec3 vc = vColor.rgb;
  float red = step(0.7, vc.r) * step(vc.g, 0.08) * step(vc.b, 0.08);
  float white = step(0.95, min(vc.r, min(vc.g, vc.b)));
  // arrows, signs, checkpoint trim: the amber family (0.8, 0.4..0.6, 0)
  float amber = step(0.7, vc.r) * step(0.3, vc.g) * step(vc.g, 0.7) * step(vc.b, 0.08);
  // sign chevrons: tan (0.600, ~0.445, ~0.245) on maroon. desert sand uses the same tan, so it only glows
  // on meshes that also contain the maroon sign background (uTanOK, set per mesh before drawing)
  float tan_ = step(abs(vc.r - 0.6), 0.006) * step(abs(vc.g - 0.445), 0.008) * step(abs(vc.b - 0.245), 0.01);
  totalEmissiveRadiance += vc * (red * 1.15 + white * 0.55 + amber * 1.05 + tan_ * 1.4 * uTanOK) * uEdgeGlow;
}
#endif`);
    };
    const prevKey = m.customProgramCacheKey?.bind(m);
    m.customProgramCacheKey = () => (prevKey ? prevKey() : "") + "|ptfx-edge4";
    m.needsUpdate = true;
  }

  let scanAt = 0;
  PT.passes.push({
    name: "trackglow",
    beforeScene(ctx) {
      if (ctx.state.frame >= scanAt) {
        scanAt = ctx.state.frame + 120;   // new track pieces appear on load / in the editor
        ctx.scene.traverse((o) => {
          if (!o.isMesh) return;
          for (const m of [].concat(o.material))
            if (m.type === "MeshLambertMaterial" && m.vertexColors && !patched.has(m)) patch(m);
          if (o.userData.ptTan === undefined && o.geometry?.attributes?.color) {
            const ca = o.geometry.attributes.color; let sign = false;
            for (let i = 0; i < ca.count && !sign; i++) sign = Math.abs(ca.getX(i) - 0.314) < 0.01 && Math.abs(ca.getY(i) - 0.106) < 0.01 && Math.abs(ca.getZ(i) - 0.106) < 0.01;
            o.userData.ptTan = sign;
            const prev = o.onBeforeRender;
            o.onBeforeRender = function (r, sc, cam, g, mat, grp) {
              prev?.call(this, r, sc, cam, g, mat, grp);
              const v = this.userData.ptTan ? 1 : 0;
              if (U.uTanOK.value !== v) { U.uTanOK.value = v; mat.uniformsNeedUpdate = true; }
            };
          }
        });
      }
      U.uEdgeGlow.value = PT.edgeGlowLevel() * cfg.edgeGlowPower;
    },
  });
})();
// ptfx weather: states blend smoothly into a shared PT.weather that the atmosphere reads (light dimming,
// overcast sky, colour temperature). this pass draws the surface side: wet darkening, noise-placed
// puddles with screen-space reflections, ripples and splashes, distance fog and lightning.
// the falling rain itself is real geometry (46-rain.js).
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ trackSheen: 0.35, weather: "clear", weatherIntensity: 1, wind: 0.35, lightning: true, fogAmount: 1, puddles: 1, reflections: true });

  // dim: direct sun, ov: overcast sky, fog: density, wet: target wetness, rain, bolt: lightning,
  // temp: colour temperature shift (-1 cold .. +1 warm), sat: saturation
  const STATES = {
    clear:    { dim: 1.0,  ov: 0.0,  fog: 0.0003, wet: 0,    rain: 0,   bolt: 0, temp: 0,     sat: 1.0, hail: 0 },
    cloudy:   { dim: 0.8,  ov: 0.4,  fog: 0.0007, wet: 0,    rain: 0,   bolt: 0, temp: -0.1,  sat: 0.95 },
    overcast: { dim: 0.45, ov: 0.85, fog: 0.0012, wet: 0.1,  rain: 0,   bolt: 0, temp: -0.25, sat: 0.82 },
    rain:     { dim: 0.3,  ov: 0.95, fog: 0.0022,  wet: 0.85, rain: 0.7, bolt: 0, temp: -0.35, sat: 0.75 },
    storm:    { dim: 0.15, ov: 1.0,  fog: 0.0035,  wet: 1.0,  rain: 1.0, bolt: 1, temp: -0.5,  sat: 0.65 },
    hail:     { dim: 0.3,  ov: 0.95, fog: 0.002,  wet: 0.45, rain: 0.9, bolt: 0, temp: -0.45, sat: 0.7, hail: 1 },
    fog:      { dim: 0.55, ov: 0.6,  fog: 0.015,  wet: 0.2,  rain: 0,   bolt: 0, temp: -0.15, sat: 0.8 },
  };
  PT.WEATHER_NAMES = Object.keys(STATES);
  const W = (PT.weather = Object.assign({}, STATES.clear, { flash: 0, boltAz: 0, boltSeed: 0, wetNow: 0 }));
  let nextBolt = 5;

  function step(dt) {
    const s = STATES[cfg.weather] || STATES.clear, k = cfg.weatherIntensity;
    const target = {};
    for (const key of Object.keys(STATES.clear)) target[key] = STATES.clear[key] + ((s[key] ?? 0) - STATES.clear[key]) * k;
    const a = 1 - Math.exp(-dt / 3);              // ~3s blend between states
    for (const key of Object.keys(target)) W[key] += ((target[key] ?? 0) - W[key]) * a;
    // the track gets wet over ~10s and dries over ~40s
    const wt = target.wet * cfg.puddles;
    W.wetNow += (wt - W.wetNow) * (1 - Math.exp(-dt / (wt > W.wetNow ? 10 : 40)));
    // lightning: random strikes, a double flicker, then decay
    W.flash *= Math.exp(-dt / 0.12);
    if (cfg.lightning && W.bolt > 0.5) {
      nextBolt -= dt;
      if (nextBolt <= 0) {
        W.flash = 1; W.boltAz = Math.random() * Math.PI * 2; W.boltSeed = Math.random() * 100; W.boltAge = 0;
        setTimeout(() => (W.flash = Math.max(W.flash, 0.7)), 110 + Math.random() * 120);
        nextBolt = 4 + Math.random() * 12;
      }
    }
    W.boltAge = (W.boltAge ?? 9) + dt;
  }

  PT.SH.WEATHER_SSR = `
uniform sampler2D tColor, tDepth;
uniform mat4 uInvVP, uVP; uniform vec3 uCamPos;
uniform float uSheen, uSteps;
uniform float uNear, uFar, uTime, uWet, uRain, uFog, uFlash, uWind, uBoltAz, uBoltSeed, uBoltAge, uRefl;
uniform vec3 uFogCol, uSkyTop, uSkyHor, uAlbGain;
uniform vec2 uRes;
uniform sampler2D tSSR;
uniform float uHasOccl;

float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ return vnoise(p) * 0.55 + vnoise(p * 2.1 + 7.3) * 0.3 + vnoise(p * 4.3 + 1.7) * 0.15; }
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
vec3 skyAt(vec3 d){ return mix(uSkyHor, uSkyTop, pow(max(d.y, 0.0), 0.5)); }

// rain ripples: expanding rings on a jittered grid, returns a normal tilt in xz
vec2 ripples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int l = 0; l < 2; l++) {
    vec2 q = p * (l == 0 ? 2.2 : 3.7) + float(l) * 13.1;
    vec2 cell = floor(q), f = fract(q) - 0.5;
    float h = hash12(cell + float(l) * 31.0);
    vec2 c = vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5;
    float ph = fract(t * (0.9 + 0.5 * h) + h);
    vec2 d = f - c * 0.6; float r = length(d);
    float ring = sin((r - ph * 0.45) * 60.0) * smoothstep(0.08, 0.0, abs(r - ph * 0.45)) * (1.0 - ph);
    acc += normalize(d + 1e-4) * ring;
  }
  return acc * 0.35;
}

vec3 ssr(vec3 P, vec3 R, float rough, out float hit){
  hit = 0.0;
  // per-pixel jitter (interleaved gradient noise) turns step banding into fine noise the blur removes
  float ign = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 61.0);
  float t = 0.2 + 0.5 * ign; vec3 col = vec3(0.0);
  vec2 prevUv; float prevT = 0.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= uSteps) break;
    vec3 q = P + R * t;
    vec4 cp = uVP * vec4(q, 1.0);
    if (cp.w <= 0.0) break;
    vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) break;
    float sd = texture2D(tDepth, suv).r;
    float sz = viewDepth(sd);
    float dz = cp.w - sz;
    if (dz > 0.02 && dz < max(0.5, (t - prevT) * 1.6 + 0.25) && sd < 0.99999) {
      // refine between the last miss and this hit
      float a = prevT, b = t;
      for (int j = 0; j < 5; j++) {
        float m = 0.5 * (a + b); vec4 mp = uVP * vec4(P + R * m, 1.0); vec2 mu = mp.xy / mp.w * 0.5 + 0.5;
        if (mp.w - viewDepth(texture2D(tDepth, mu).r) > 0.0) { b = m; suv = mu; } else a = m;
      }
      vec2 e = smoothstep(0.0, 0.08, suv) * smoothstep(1.0, 0.92, suv);
      // fade with distance travelled so the reflection dissolves instead of stopping at a seam
      hit = e.x * e.y * (1.0 - smoothstep(18.0, 70.0, t));
      vec3 r = texture2D(tColor, suv).rgb;
      return r / (1.0 + luma(r) * 0.2);   // keep reflected emissives from clipping into flat bars
    }
    prevT = t; t = t * (1.0 + 4.2 / uSteps * (0.75 + 0.5 * ign)) + 0.1;
  }
  return col;
}


// half-res reflection pass: premultiplied (reflection * hit, hit), blurred afterwards
void main(){
  float z = texture2D(tDepth, vUv).r;
  if (z >= 0.99999 || uRefl < 0.5) { gl_FragColor = vec4(0.0); return; }
  vec4 p4 = uInvVP * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = p4.xyz / p4.w, V = normalize(P - uCamPos);
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  if (dot(N, -V) < 0.0) N = -N;
  float flat_ = smoothstep(0.55, 0.9, N.y);
  float wet = uWet * mix(0.35, 1.0, flat_);
  float pud = flat_ * smoothstep(0.62, 0.7, fbm(P.xz * 0.07) + uWet * 0.3 - 0.12) * smoothstep(0.2, 0.6, uWet);
  if (pud < 0.02 && wet < 0.2) { gl_FragColor = vec4(0.0); return; }
  float h; vec3 r = ssr(P + N * 0.03, reflect(V, N), 1.0, h);
  gl_FragColor = vec4(r * h, h);
}
`;

  // separable gaussian on the premultiplied reflection buffer; the vertical pass reaches further,
  // which gives wet asphalt its streaky look
  PT.SH.SSR_BLUR = `
uniform sampler2D tSrc; uniform vec2 uDir;
void main(){
  vec4 c = texture2D(tSrc, vUv) * 0.227;
  c += (texture2D(tSrc, vUv + uDir * 1.38) + texture2D(tSrc, vUv - uDir * 1.38)) * 0.316;
  c += (texture2D(tSrc, vUv + uDir * 3.23) + texture2D(tSrc, vUv - uDir * 3.23)) * 0.070;
  gl_FragColor = c;
}`;
  PT.SH.WEATHER = `
uniform sampler2D tColor, tDepth;
uniform mat4 uInvVP, uVP; uniform vec3 uCamPos;
uniform float uSheen, uSteps;
uniform float uNear, uFar, uTime, uWet, uRain, uFog, uFlash, uWind, uBoltAz, uBoltSeed, uBoltAge, uRefl;
uniform vec3 uFogCol, uSkyTop, uSkyHor, uAlbGain;
uniform vec2 uRes;
uniform sampler2D tSSR;
uniform float uHasOccl;

float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ return vnoise(p) * 0.55 + vnoise(p * 2.1 + 7.3) * 0.3 + vnoise(p * 4.3 + 1.7) * 0.15; }
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
vec3 skyAt(vec3 d){ return mix(uSkyHor, uSkyTop, pow(max(d.y, 0.0), 0.5)); }

// rain ripples: expanding rings on a jittered grid, returns a normal tilt in xz
vec2 ripples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int l = 0; l < 2; l++) {
    vec2 q = p * (l == 0 ? 2.2 : 3.7) + float(l) * 13.1;
    vec2 cell = floor(q), f = fract(q) - 0.5;
    float h = hash12(cell + float(l) * 31.0);
    vec2 c = vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5;
    float ph = fract(t * (0.9 + 0.5 * h) + h);
    vec2 d = f - c * 0.6; float r = length(d);
    float ring = sin((r - ph * 0.45) * 60.0) * smoothstep(0.08, 0.0, abs(r - ph * 0.45)) * (1.0 - ph);
    acc += normalize(d + 1e-4) * ring;
  }
  return acc * 0.35;
}

vec3 ssr(vec3 P, vec3 R, float rough, out float hit){
  hit = 0.0;
  // per-pixel jitter (interleaved gradient noise) turns step banding into fine noise the blur removes
  float ign = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 61.0);
  float t = 0.2 + 0.5 * ign; vec3 col = vec3(0.0);
  vec2 prevUv; float prevT = 0.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= uSteps) break;
    vec3 q = P + R * t;
    vec4 cp = uVP * vec4(q, 1.0);
    if (cp.w <= 0.0) break;
    vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) break;
    float sd = texture2D(tDepth, suv).r;
    float sz = viewDepth(sd);
    float dz = cp.w - sz;
    if (dz > 0.02 && dz < max(0.5, (t - prevT) * 1.6 + 0.25) && sd < 0.99999) {
      // refine between the last miss and this hit
      float a = prevT, b = t;
      for (int j = 0; j < 5; j++) {
        float m = 0.5 * (a + b); vec4 mp = uVP * vec4(P + R * m, 1.0); vec2 mu = mp.xy / mp.w * 0.5 + 0.5;
        if (mp.w - viewDepth(texture2D(tDepth, mu).r) > 0.0) { b = m; suv = mu; } else a = m;
      }
      vec2 e = smoothstep(0.0, 0.08, suv) * smoothstep(1.0, 0.92, suv);
      // fade with distance travelled so the reflection dissolves instead of stopping at a seam
      hit = e.x * e.y * (1.0 - smoothstep(18.0, 70.0, t));
      vec3 r = texture2D(tColor, suv).rgb;
      return r / (1.0 + luma(r) * 0.2);   // keep reflected emissives from clipping into flat bars
    }
    prevT = t; t = t * (1.0 + 4.2 / uSteps * (0.75 + 0.5 * ign)) + 0.1;
  }
  return col;
}

void main(){
  vec4 s4 = texture2D(tColor, vUv); vec3 src = s4.rgb;
  float skyVis = uHasOccl > 0.5 ? s4.a : 1.0;          // from the occlusion pass: no rain under roofs
  float z = texture2D(tDepth, vUv).r;
  vec4 p4 = uInvVP * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = p4.xyz / p4.w;
  vec3 V = normalize(P - uCamPos);
  vec3 c = src;
  bool sky = z >= 0.99999;

  if (!sky && (uWet > 0.01 || uSheen > 0.0)) {
    vec3 N = normalize(cross(dFdx(P), dFdy(P)));
    if (dot(N, -V) < 0.0) N = -N;
    // depth discontinuity: derivative normals are garbage at silhouettes -> no wet/reflection there
    float edge = 1.0 - smoothstep(0.02, 0.08, fwidth(viewDepth(z)) / max(viewDepth(z), 1.0));
    float flat_ = smoothstep(0.55, 0.9, N.y) * edge;
    float wetHere = uWet * smoothstep(0.15, 0.6, skyVis);
    float wet = wetHere * mix(0.35, 1.0, flat_);
    float pud = flat_ * smoothstep(0.62, 0.7, fbm(P.xz * 0.07) + wetHere * 0.3 - 0.12);
    pud *= smoothstep(0.2, 0.6, wetHere);
    // wet surfaces darken (water fills the micro-roughness)
    c *= mix(1.0, 0.62, wet * (1.0 - pud));
    vec3 Nr = N;
    float rainHere = uRain * smoothstep(0.15, 0.6, skyVis);
    if (rainHere > 0.01 && flat_ > 0.5) { vec2 rp = ripples(P.xz, uTime) * rainHere; Nr = normalize(N + vec3(rp.x, 0.0, rp.y) * (0.35 + 0.65 * pud)); }
    // splashes: tiny short-lived rings on any wet flat surface while it rains
    if (rainHere > 0.01 && flat_ > 0.5) {
      vec2 q = P.xz * 1.6; vec2 cell = floor(q), f = fract(q) - 0.5;
      float h = hash12(cell), ph = fract(uTime * 2.2 + h * 7.0);
      float r = length(f - (vec2(hash12(cell + 5.3), hash12(cell + 9.1)) - 0.5) * 0.6);
      float ring = smoothstep(0.03, 0.0, abs(r - ph * 0.22)) * (1.0 - ph) * step(0.55, h);
      c += ring * rainHere * 0.06 * (0.3 + 0.7 * luma(uSkyHor) * 4.0);
    }
    vec3 R = reflect(V, Nr);
    float ndv = max(dot(-V, Nr), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    // dry track still has a faint glancing sheen (smooth asphalt / painted surfaces at grazing angles).
    // it fades out with distance: toward the horizon every flat surface is grazing, and the whole terrain
    // turned into a mirror of the sky ("the ground is invisible")
    float dCam = length(P - uCamPos);
    float far_ = 1.0 - smoothstep(25.0, 110.0, dCam);
    float strength = max(max(pud, wet * flat_ * 0.45) * mix(0.35, 1.0, 1.0 - smoothstep(120.0, 400.0, dCam)), uSheen * flat_ * 0.5 * far_);
    if (strength > 0.01) {
      vec3 refl = skyAt(R);
      // ray-march only where there's actual water; the dry sheen just picks up the sky
      if (uRefl > 0.5 && (pud > 0.02 || wet > 0.2)) {
        // puddles: full-res trace, sharp mirror. wet asphalt: the soft half-res buffer, kept faint
        float kk = mix(fres * 0.8, mix(0.35, 1.0, fres), pud) * strength;
        if (pud > 0.05 && kk > 0.08 && dCam < 150.0) { float h; vec3 m = ssr(P + N * 0.03, R, 1.0, h); refl = mix(refl, m, h); }   // only trace where it can show
        else { vec4 sr = texture2D(tSSR, vUv); refl = mix(refl, sr.rgb / max(sr.a, 1e-3), clamp(sr.a, 0.0, 1.0) * 0.6); }
      }
      float k = mix(min(fres * 0.8, 0.55), mix(0.35, 1.0, fres), pud) * strength;   // non-puddle reflections capped
      c = mix(c, refl, clamp(k, 0.0, 1.0));
    }
  }

  // distance fog (sky gets a thin horizon veil so it blends)
  // the game's ground is the lower half of the sky dome (no mesh, no depth): give it a real distance from
  // the camera height and view angle instead of "infinitely far", or it fogs out to white
  float groundDist = max(20.0, max(uCamPos.y, 2.0) / max(-V.y, 0.004));
  float dist = sky ? (V.y < 0.0 ? min(groundDist, 4000.0) : 4000.0) : length(P - uCamPos);
  float fogK = 1.0 - exp(-uFog * dist);
  if (sky && V.y >= 0.0) fogK *= smoothstep(0.5, 0.0, V.y) * 0.85;
  c = mix(c, uFogCol, fogK);

  // lightning bolt in the sky: a jagged line at a random azimuth, visible for ~0.2s
  if (sky && uBoltAge < 0.25) {
    float az = atan(V.z, V.x);
    float da = mod(az - uBoltAz + 3.14159, 6.28318) - 3.14159;
    float el = V.y;
    float off = (vnoise(vec2(el * 18.0, uBoltSeed)) - 0.5) * 0.08 + (vnoise(vec2(el * 60.0, uBoltSeed + 4.0)) - 0.5) * 0.02;
    float w = smoothstep(0.004, 0.0, abs(da - off)) * step(0.02, el) * step(el, 0.55);
    c += vec3(0.8, 0.85, 1.0) * w * 25.0 * (1.0 - uBoltAge / 0.25);
  }
  c *= 1.0 + uFlash * 2.5;

  gl_FragColor = vec4(c, 1.0);
}
`;

  let mat = null, ssrMat = null, blurMat = null;
  PT.passes.push({
    name: "weather",
    beforeScene(ctx) { step(ctx.state.dt); },
    run(ctx) {
      const busy = cfg.trackSheen > 0 || W.wetNow > 0.01 || W.rain > 0.01 || W.fog > 0.0001 || W.flash > 0.01 || W.boltAge < 0.3;
      if (!busy) return;
      const { T } = ctx;
      if (!mat) mat = ctx.material(PT.SH.WEATHER, {
        tColor: { value: null }, tDepth: { value: null }, uInvVP: { value: new T.Matrix4() }, uVP: { value: new T.Matrix4() },
        uCamPos: { value: new T.Vector3() }, uNear: { value: 0.5 }, uFar: { value: 10000 }, uTime: { value: 0 },
        uWet: { value: 0 }, uRain: { value: 0 }, uFog: { value: 0 }, uFlash: { value: 0 }, uWind: { value: 0 },
        uBoltAz: { value: 0 }, uBoltSeed: { value: 0 }, uBoltAge: { value: 9 }, uRefl: { value: 1 }, uSheen: { value: 0 }, uSteps: { value: 18 },
        uFogCol: { value: new T.Vector3() }, uSkyTop: { value: new T.Vector3() }, uSkyHor: { value: new T.Vector3() },
        uAlbGain: { value: new T.Vector3(1, 1, 1) }, uRes: { value: new T.Vector2() }, tSSR: { value: null }, uHasOccl: { value: 0 },
      });
      const u = mat.uniforms, cam = ctx.camera;
      u.tColor.value = ctx.color; u.tDepth.value = ctx.depth;
      u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
      u.uVP.value.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      u.uNear.value = cam.near; u.uFar.value = cam.far; u.uTime.value = ctx.state.time;
      u.uWet.value = W.wetNow; u.uRain.value = W.rain; u.uFog.value = W.fog * cfg.fogAmount; u.uFlash.value = W.flash;
      u.uWind.value = cfg.wind; u.uBoltAz.value = W.boltAz; u.uBoltSeed.value = W.boltSeed; u.uBoltAge.value = W.boltAge;
      u.uRefl.value = cfg.reflections ? 1 : 0; u.uSheen.value = cfg.trackSheen; u.uSteps.value = cfg.ssrSteps; u.uRes.value.set(ctx.w, ctx.h);
      const sky = PT.skyCols || { top: [0.2, 0.35, 0.7], hor: [0.6, 0.7, 0.85] };
      u.uSkyTop.value.set(...sky.top); u.uSkyHor.value.set(...sky.hor);
      const f = sky.fog || sky.hor; u.uFogCol.value.set(...f);
      // reflections: half-res trace, then H + V blur (V wider)
      const wantSSR = cfg.reflections && W.wetNow > 0.05;
      if (wantSSR) {
        if (!ssrMat) {
          ssrMat = ctx.material(PT.SH.WEATHER_SSR, mat.uniforms);   // shares every uniform with the main pass
          blurMat = ctx.material(PT.SH.SSR_BLUR, { tSrc: { value: null }, uDir: { value: new T.Vector2() } });
        }
        const hw = Math.max(1, ctx.w >> 1), hh = Math.max(1, ctx.h >> 1);
        const a = ctx.rt("ssrA", hw, hh), b = ctx.rt("ssrB", hw, hh);
        ctx.pass(ctx.renderer, ssrMat, a);
        blurMat.uniforms.tSrc.value = a.texture; blurMat.uniforms.uDir.value.set(1.5 / hw, 0); ctx.pass(ctx.renderer, blurMat, b);
        // vertical stretch = two gap-free passes (wide sparse taps stamped ghost rows across the road)
        blurMat.uniforms.tSrc.value = b.texture; blurMat.uniforms.uDir.value.set(0, 1.6 / hh); ctx.pass(ctx.renderer, blurMat, a);
        blurMat.uniforms.tSrc.value = a.texture; blurMat.uniforms.uDir.value.set(0, 2.4 / hh); ctx.pass(ctx.renderer, blurMat, b);
        u.tSSR.value = b.texture;
      }
      u.uRefl.value = wantSSR ? 1 : 0;
      u.uHasOccl.value = PT.occl ? 1 : 0;
      const out = ctx.rt("weather", ctx.w, ctx.h);
      ctx.pass(ctx.renderer, mat, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx rain: real 3D drops. one static buffer of quads; the vertex shader wraps every drop inside a box
// that follows the camera and draws it as a streak along its velocity *relative to the camera*, so at
// racing speed the rain comes at you instead of falling past. widths are clamped to ~1px with alpha
// scaled by coverage (far rain becomes haze, not aliased lines), and drops inside the player's
// headlight beams light up. rendered after the sky pass into its own half-res target (linear HDR) with
// a manual test against the scene depth, so walls and cars still occlude it, then added on top.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ rainDensity: 1, rainBrightness: 1 });

  const MAX = 12000, BOX = 40;   // 48k verts: fits a 16-bit index buffer

  const VERT = `
attribute vec4 seed;      // xyz: position in box, w: per-drop variation
attribute vec2 corner;    // x: -1..1 across, y: 0..1 along the streak
uniform float uTime, uSpeed, uBox, uShutter, uPix;
uniform vec3 uWind, uCamVel, uHL, uHLF;
uniform float uHLI, uHail;
uniform sampler2D tUp; uniform mat4 uUpM; uniform vec3 uUpPos, uUpDir; uniform float uUpFar, uHasUp;
varying float vAlong, vA, vLit, vViewZ;
void main(){
  float var = seed.w;
  vec3 vel = vec3(uWind.x, -uSpeed * (0.8 + 0.4 * var), uWind.z);
  vec3 p = seed.xyz * uBox + vel * uTime;
  p = mod(p - cameraPosition + uBox * 0.5, uBox) - uBox * 0.5 + cameraPosition;
  // streak = where the drop was during the "shutter", seen from the moving camera
  vec3 app = vel - uCamVel;
  // hail: short, fat, bright pellets instead of thin streaks
  float len = mix(clamp(length(app) * uShutter, 0.25, 2.4), clamp(length(app) * 0.008, 0.06, 0.8), uHail);
  vec3 dir = normalize(app);
  vec3 toCam = cameraPosition - p; float d = length(toCam); toCam /= d;
  vec3 side = normalize(cross(dir, toCam) + 1e-5);
  float w = max(0.004, uPix * d * 0.8) * (1.0 + 2.5 * uHail);   // never thinner than ~1px
  vec3 wp = p - dir * len * corner.y + side * w * corner.x;
  vAlong = corner.y;
  vA = clamp(0.006 / w, 0.08, 1.0)                     // coverage: far streaks fade instead of aliasing
     * smoothstep(0.5, 2.5, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d)) * (0.55 + 0.45 * var);
  // roofs: look the drop up in the baked straight-down sky map; under cover it doesn't exist
  if (uHasUp > 0.5) {
    vec4 q = uUpM * vec4(p, 1.0); vec2 uv = q.xy / q.w * 0.5 + 0.5;
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
      float h = texture2D(tUp, uv).r;
      if (h > 0.0 && uUpFar - h < dot(p - uUpPos, uUpDir) - 0.5) vA = 0.0;
    }
  }
  // headlight catch: inside the player's beam fan, close enough to be lit
  vec3 hv = p - uHL; float hd = length(hv);
  float inBeam = smoothstep(0.55, 0.85, dot(hv / max(hd, 1e-3), uHLF)) * (1.0 - smoothstep(6.0, 30.0, hd));
  vLit = inBeam * uHLI;
  vec4 vp = viewMatrix * vec4(wp, 1.0); vViewZ = -vp.z;
  gl_Position = projectionMatrix * vp;
  // cull: drops behind the camera or too faint to matter collapse to a degenerate point off-screen,
  // so the rasteriser never touches them (most of the box is outside the view at any time)
  if ((viewMatrix * vec4(p, 1.0)).z > -0.2 || vA < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
  const FRAG = `
uniform vec3 uCol;
uniform sampler2D tDepth; uniform vec2 uRes; uniform float uNear, uFar;
varying float vAlong, vA, vLit, vViewZ;
void main(){
  float sd = texture2D(tDepth, gl_FragCoord.xy / uRes).r;
  float z = sd * 2.0 - 1.0, sceneZ = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
  if (sd < 0.99999 && vViewZ > sceneZ + 0.05) discard;   // behind a wall/car
  float a = smoothstep(0.0, 0.3, vAlong) * smoothstep(1.0, 0.45, vAlong) * vA;
  vec3 c = uCol + vec3(1.0, 0.92, 0.8) * vLit * 0.5;
  gl_FragColor = vec4(c * a, 1.0);
}`;

  let mesh = null, lastCam = null;
  const camVel = [0, 0, 0];
  function build(T) {
    const g = new T.BufferGeometry();
    const pos = new Float32Array(MAX * 4 * 3), seed = new Float32Array(MAX * 4 * 4), corner = new Float32Array(MAX * 4 * 2);
    const idx = new Uint16Array(MAX * 6);
    const cs = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    for (let i = 0; i < MAX; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let k = 0; k < 4; k++) { seed.set(s, (i * 4 + k) * 4); corner.set(cs[k], (i * 4 + k) * 2); }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("seed", new T.BufferAttribute(seed, 4));
    g.setAttribute("corner", new T.BufferAttribute(corner, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    const m = new T.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: 2 /* additive */,
      side: 2 /* double: the streak quad's winding flips depending on view, so back-face culling ate every drop */,
      uniforms: {
        uTime: { value: 0 }, uSpeed: { value: 24 }, uBox: { value: BOX }, uShutter: { value: 0.03 }, uPix: { value: 0.001 },
        uWind: { value: new T.Vector3() }, uCamVel: { value: new T.Vector3() }, uCol: { value: new T.Vector3() },
        uHL: { value: new T.Vector3() }, uHLF: { value: new T.Vector3(0, 0, 1) }, uHLI: { value: 0 },
        uHail: { value: 0 }, tDepth: { value: null }, tUp: { value: null }, uUpM: { value: new T.Matrix4() }, uUpPos: { value: new T.Vector3() }, uUpDir: { value: new T.Vector3() }, uUpFar: { value: 1 }, uHasUp: { value: 0 }, uRes: { value: new T.Vector2() }, uNear: { value: 0.5 }, uFar: { value: 10000 },
      },
    });
    mesh = new T.Mesh(g, m);
    mesh.frustumCulled = false; mesh.userData.ptfx = true;
    PT.rainMesh = mesh;
  }
  PT.SH.ADD = `uniform sampler2D tColor, tAdd; uniform float uLinearIn;
void main(){ vec3 c = texture2D(tColor, vUv).rgb; if (uLinearIn < 0.5) c = srgb2lin(c); gl_FragColor = vec4(c + texture2D(tAdd, vUv).rgb, 1.0); }`;
  PT.SH.CLEAR0 = PT.SH.CLEAR0 || `void main(){ gl_FragColor = vec4(0.0); }`;
  let addMat = null, clearMat = null, rainOn = false;

  PT.passes.push({
    name: "rain",
    beforeScene(ctx) {
      const W = PT.weather, rain = (W?.rain ?? 0) * cfg.rainDensity;
      const cam = ctx.camera, cp = new ctx.T.Vector3().setFromMatrixPosition(cam.matrixWorld);
      // smoothed camera velocity (teleports on respawn are ignored)
      if (lastCam && !ctx.photo) {
        const dt = Math.max(ctx.state.dt, 1e-3), k = 1 - Math.exp(-dt / 0.1);
        const v = cp.clone().sub(lastCam).divideScalar(dt);
        // camera cuts (cinematic / C cycle) would read as a teleport-speed camera: skip those frames
        if (v.length() < 150 && !PT.cineCut && !PT.camCut) for (let i = 0; i < 3; i++) camVel[i] += (v.getComponent(i) - camVel[i]) * k;
      }
      if (!ctx.photo) lastCam = cp;
      PT.camVel = camVel;
      if (!mesh) { if (rain < 0.01) return; build(ctx.T); }
      rainOn = rain > 0.01;
      if (!rainOn) return;
      mesh.geometry.setDrawRange(0, Math.floor(Math.min(1, rain) * MAX) * 6);
      const u = mesh.material.uniforms;
      u.uTime.value = ctx.state.time;
      u.uWind.value.set(cfg.wind * 9, 0, cfg.wind * 3);
      // only part of the camera's own motion goes into the streaks: full-strength read as warp speed
      u.uCamVel.value.set(camVel[0] * 0.5, camVel[1] * 0.5, camVel[2] * 0.5);
      u.uPix.value = (2 * Math.tan(((cam.fov || 70) * Math.PI) / 360)) / ctx.h;
      const day = PT.day ?? 1;
      // lit by the sky (linear HDR), white on a lightning flash. rain is water: faint and a little
      // blue-grey. hail is ice: much brighter and white
      const hail = W.hail ?? 0;
      const k = ((0.03 + 0.17 * day) * (0.7 + 0.3 * Math.min(1, rain)) + (W.flash ?? 0) * 0.8) * cfg.rainBrightness;
      const kh = (0.12 + 0.6 * day) * cfg.rainBrightness;
      u.uCol.value.set(k * 0.78 + (kh - k * 0.78) * hail, k * 0.85 + (kh - k * 0.85) * hail, k * 0.97 + (kh - k * 0.97) * hail);
      u.uHail.value = hail;
      const oc = PT.occl;
      u.uHasUp.value = oc ? 1 : 0;
      if (oc) { u.tUp.value = oc.up; u.uUpM.value.copy(oc.upM); u.uUpPos.value.copy(oc.upPos); u.uUpDir.value.copy(oc.upDir); u.uUpFar.value = oc.far; }
      const hl = PT.playerBeam;
      if (hl) { u.uHL.value.set(...hl.pos); u.uHLF.value.set(...hl.fwd); u.uHLI.value = hl.on; } else u.uHLI.value = 0;
    },
    run(ctx) {
      if (!rainOn || !mesh) return;
      const { renderer, camera } = ctx;
      if (!addMat) { addMat = ctx.material(PT.SH.ADD, { tColor: { value: null }, tAdd: { value: null }, uLinearIn: { value: 0 } }); clearMat = ctx.material(PT.SH.CLEAR0, {}); }
      const hw = Math.max(1, ctx.w >> 1), hh = Math.max(1, ctx.h >> 1);
      const rt = ctx.rt("rain", hw, hh);
      const u = mesh.material.uniforms;
      u.tDepth.value = ctx.depth; u.uRes.value.set(hw, hh); u.uNear.value = camera.near; u.uFar.value = camera.far;
      ctx.pass(renderer, clearMat, rt);
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.setRenderTarget(rt); renderer.render(mesh, camera);
      renderer.autoClear = ac;
      // no add pass of its own: the volumetric pass composites the rain layer in the same full-res pass
      PT.rainTex = rt.texture;
    },
  });
})();
// ptfx volumetric light: god rays from the baked sun map. each pixel marches its view ray (half res,
// jittered) and checks sun visibility at every step, so shafts come through holes in roofs, between
// pillars and past buildings, and low sun gives long beams. forward-scattering phase makes them
// strongest looking toward the light. haze density follows the weather fog. moonlight gets faint shafts.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ godRays: true, godRayStrength: 1 });

  PT.SH.VOL = `
uniform sampler2D tDepth, tSun;
uniform mat4 uInvVP, uSunM; uniform vec3 uCamPos, uSunPos, uSunDir;
uniform float uFar, uMaxDist, uNear, uCamFar;
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uCamFar / (uCamFar + uNear - z * (uCamFar - uNear)); }
float sunVis(vec3 X){
  vec4 q = uSunM * vec4(X, 1.0); vec2 uv = q.xy / q.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float h = texture2D(tSun, uv).r;
  return (h > 0.0 && uFar - h < dot(X - uSunPos, uSunDir) - 0.3) ? 0.0 : 1.0;
}
void main(){
  float z = texture2D(tDepth, vUv).r;
  vec4 p4 = uInvVP * vec4(vUv * 2.0 - 1.0, min(z, 0.99999) * 2.0 - 1.0, 1.0);
  vec3 P = p4.xyz / p4.w;
  vec3 ray = P - uCamPos; float L = min(length(ray), uMaxDist); vec3 V = normalize(ray);
  float j = hash12(gl_FragCoord.xy);
  float acc = 0.0;
  const int STEPS = 20;
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + j) / float(STEPS);
    acc += sunVis(uCamPos + V * (t * t * L));      // quadratic spacing: more samples near the camera
  }
  float lit = acc / float(STEPS);
  // henyey-greenstein forward scattering (g = 0.6) toward the light
  float g = 0.6, c = dot(V, -uSunDir);
  float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5) * 0.25;
  gl_FragColor = vec4(lit * phase * (L / uMaxDist), lit, 0.0, 1.0);
}`;
  PT.SH.VOL_BLUR = `
uniform sampler2D tSrc; uniform vec2 uDir;
void main(){
  vec4 c = texture2D(tSrc, vUv) * 0.227;
  c += (texture2D(tSrc, vUv + uDir * 1.38) + texture2D(tSrc, vUv - uDir * 1.38)) * 0.316;
  c += (texture2D(tSrc, vUv + uDir * 3.23) + texture2D(tSrc, vUv - uDir * 3.23)) * 0.070;
  gl_FragColor = c;
}`;
  PT.SH.VOL_MIX = `
uniform sampler2D tColor, tVol, tRain; uniform vec3 uCol; uniform float uI, uLinearIn, uHasRain;
void main(){
  vec4 c = texture2D(tColor, vUv);
  vec3 col = uLinearIn > 0.5 ? c.rgb : srgb2lin(c.rgb);
  float s = uI > 0.0 ? texture2D(tVol, vUv).r : 0.0;
  vec3 rain = uHasRain > 0.5 ? texture2D(tRain, vUv).rgb : vec3(0.0);   // rain layer joins this add pass
  gl_FragColor = vec4(col + uCol * s * uI + rain, c.a);
}`;

  let vol = null, blur = null, mix = null;
  PT.passes.push({
    name: "volumetric",
    run(ctx) {
      const oc = PT.occl, lv = PT.lightLevels, rain = PT.rainTex; PT.rainTex = null;
      const W = PT.weather || { fog: 0, ov: 0 };
      let I = 0;
      if (cfg.godRays && oc && oc.sun && lv) {
      // haze: a little always, more with fog/rain, more at low sun; clouds kill direct shafts
      const day = PT.day ?? 1;
      const haze = (0.35 + W.fog * 120) * (lv.sunUp ? 1 + 0.5 * (1 - Math.min(1, (PT.lightDir?.[1] ?? 1) / 0.4)) : 0.25);
      // clamped: at low sun the forward-scatter peak washed the bottom of the frame in cream
      I = Math.min(0.5, cfg.godRayStrength * lv.dirI * (1 - 0.85 * W.ov) * haze * (0.3 + 0.7 * day));
      }
      if (I < 0.005) I = 0;
      if (!I && !rain) return;
      const { T, renderer } = ctx, cam = ctx.camera;
      if (!vol) {
        vol = ctx.material(PT.SH.VOL, { tDepth: { value: null }, tSun: { value: null }, uInvVP: { value: new T.Matrix4() }, uSunM: { value: new T.Matrix4() },
          uCamPos: { value: new T.Vector3() }, uSunPos: { value: new T.Vector3() }, uSunDir: { value: new T.Vector3() },
          uFar: { value: 1 }, uMaxDist: { value: 160 }, uNear: { value: 0.5 }, uCamFar: { value: 1e4 } });
        blur = ctx.material(PT.SH.VOL_BLUR, { tSrc: { value: null }, uDir: { value: new T.Vector2() } });
        mix = ctx.material(PT.SH.VOL_MIX, { tColor: { value: null }, tVol: { value: null }, tRain: { value: null }, uHasRain: { value: 0 }, uCol: { value: new T.Vector3() }, uI: { value: 0 }, uLinearIn: { value: 0 } });
      }
      const hw = Math.max(1, ctx.w >> 1), hh = Math.max(1, ctx.h >> 1);
      const a = ctx.rt("volA", hw, hh), b = ctx.rt("volB", hw, hh);
      if (I > 0) {
      const u = vol.uniforms;
      u.tDepth.value = ctx.depth; u.tSun.value = oc.sun; u.uSunM.value.copy(oc.sunM); u.uSunPos.value.copy(oc.sunPos); u.uSunDir.value.copy(oc.sunDir);
      u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
      u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      u.uFar.value = oc.far; u.uNear.value = cam.near; u.uCamFar.value = cam.far;
      ctx.pass(renderer, vol, a);
      blur.uniforms.tSrc.value = a.texture; blur.uniforms.uDir.value.set(1 / hw, 0); ctx.pass(renderer, blur, b);
      blur.uniforms.tSrc.value = b.texture; blur.uniforms.uDir.value.set(0, 1 / hh); ctx.pass(renderer, blur, a);
      }
      const col = lv?.col || [1, 0.95, 0.85];
      mix.uniforms.tColor.value = ctx.color; mix.uniforms.tVol.value = a.texture;
      mix.uniforms.uCol.value.set(...col); mix.uniforms.uI.value = I; mix.uniforms.uLinearIn.value = ctx.linear ? 1 : 0;
      mix.uniforms.tRain.value = rain; mix.uniforms.uHasRain.value = rain ? 1 : 0;
      const out = ctx.rt("volOut", ctx.w, ctx.h);
      ctx.pass(renderer, mix, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx motion blur: camera-motion blur by reprojection. each pixel's world position (from depth) is
// projected with last frame's view-projection; the screen-space difference is its motion, sampled along
// a line. lower frame rates mean bigger per-frame motion, so the blur grows exactly when it's needed
// (fps caps). things close to the camera (the chased car) are kept sharp, since the camera moves with
// them and camera-only reprojection would smear them wrongly.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ motionBlur: 0.5 });

  PT.SH.MBLUR = `
uniform sampler2D tColor, tDepth;
uniform mat4 uInvVP, uPrevVP; uniform vec3 uCamPos;
uniform float uScale, uLinearIn, uNear, uFar;
float viewDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
vec3 col(vec2 uv){ vec3 c = texture2D(tColor, uv).rgb; return uLinearIn > 0.5 ? c : srgb2lin(c); }
void main(){
  float z = texture2D(tDepth, vUv).r;
  vec4 p4 = uInvVP * vec4(vUv * 2.0 - 1.0, min(z, 0.9999) * 2.0 - 1.0, 1.0);
  vec3 P = p4.xyz / p4.w;
  vec4 pp = uPrevVP * vec4(P, 1.0);
  vec2 prev = pp.xy / pp.w * 0.5 + 0.5;
  vec2 v = (vUv - prev) * uScale;
  float near = smoothstep(5.0, 14.0, length(P - uCamPos));   // keep the chased car sharp
  v *= near;
  float L = length(v);
  if (L > 0.08) v *= 0.08 / L;                                  // cap the smear
  vec3 c = col(vUv);
  if (L * 1000.0 < 0.5) { gl_FragColor = vec4(c, 1.0); return; }
  // 8 taps centred on the pixel, jittered per pixel to hide stepping
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  // depth-aware: a sample that sits clearly in front of this pixel (an edge, the chased car) is skipped,
  // otherwise foreground colour smears outward into a hazy outline around every silhouette
  float d0 = viewDepth(z);
  vec3 acc = c; float w = 1.0;
  for (int i = 0; i < 8; i++) {
    float t = (float(i) + j) / 8.0 - 0.5;
    vec2 uv = clamp(vUv + v * t, 0.0, 1.0);
    float ds = viewDepth(texture2D(tDepth, uv).r);
    float keep = ds > 14.0 ? smoothstep(d0 * 0.75, d0 * 0.9, ds) : 0.0;   // near-camera stuff never bleeds out
    acc += col(uv) * keep; w += keep;
  }
  gl_FragColor = vec4(acc / w, 1.0);
}`;

  let mat = null, prevVP = null, prevPos = null;
  PT.passes.push({
    name: "motionblur",
    run(ctx) {
      if (ctx.photo) return;   // a still photo, and don't disturb last frame's matrices
      const { T } = ctx, cam = ctx.camera;
      const vp = new T.Matrix4().copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      const pos = new T.Vector3().setFromMatrixPosition(cam.matrixWorld);
      const had = prevVP, jumped = PT.cineCut || (prevPos && pos.distanceTo(prevPos) > 25);   // respawn / camera cut
      const last = prevVP; prevVP = vp; prevPos = pos;
      if (!had || jumped || cfg.motionBlur <= 0) return;
      if (!mat) mat = ctx.material(PT.SH.MBLUR, {
        tColor: { value: null }, tDepth: { value: null }, uInvVP: { value: new T.Matrix4() }, uPrevVP: { value: new T.Matrix4() },
        uCamPos: { value: new T.Vector3() }, uScale: { value: 0.5 }, uLinearIn: { value: 0 }, uNear: { value: 0.5 }, uFar: { value: 1e4 },
      });
      const u = mat.uniforms;
      u.tColor.value = ctx.color; u.tDepth.value = ctx.depth;
      u.uInvVP.value.copy(cam.matrixWorld).multiply(cam.projectionMatrixInverse);
      u.uPrevVP.value.copy(last); u.uCamPos.value.copy(pos);
      u.uScale.value = cfg.motionBlur; u.uLinearIn.value = ctx.linear ? 1 : 0; u.uNear.value = cam.near; u.uFar.value = cam.far;
      const out = ctx.rt("mblur", ctx.w, ctx.h);
      ctx.pass(ctx.renderer, mat, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx bloom: soft-knee threshold, then a dual-filter mip chain (downsample, tent upsample).
// runs on the linear HDR image, so emissives above 1 (LEDs, brake lights, kerbs) carry the glow.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ bloom: true, bloomIntensity: 0.35, bloomThreshold: 0.9, bloomRadius: 0.8 });

  PT.SH.BLOOM_DOWN = `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uPrefilter, uThreshold, uLinearIn;
vec3 tap(vec2 uv){
  vec3 c = texture2D(tSrc, uv).rgb;
  if (uPrefilter > 0.5) {
    if (uLinearIn < 0.5) c = srgb2lin(c);
    float br = max(c.r, max(c.g, c.b)), knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee); soft = soft * soft / (4.0 * knee + 1e-4);
    c *= max(soft, br - uThreshold) / max(br, 1e-4);
    c /= 1.0 + luma(c) * 0.25;   // tame fireflies before they smear
  }
  return c;
}
void main(){
  vec2 o = uTexel;
  vec3 c = tap(vUv) * 4.0 + tap(vUv + vec2(-o.x, -o.y)) + tap(vUv + vec2(o.x, -o.y)) + tap(vUv + vec2(-o.x, o.y)) + tap(vUv + vec2(o.x, o.y));
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;
  PT.SH.BLOOM_UP = `
uniform sampler2D tSrc, tBase; uniform vec2 uTexel; uniform float uRadius;
void main(){
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb
         + texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb
         + (texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb
         + texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb) * 2.0;
  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c / 12.0 * uRadius, 1.0);
}
`;
  PT.SH.BLOOM_MIX = `
uniform sampler2D tColor, tBloom; uniform float uI, uLinearIn, uSpill; uniform vec3 uAlbGain;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uLinearIn < 0.5) c = srgb2lin(c);
  vec3 b = texture2D(tBloom, vUv).rgb;
  // light spill: the blurred emissive field is roughly the light glowing things throw on their
  // surroundings, so tint it by the surface's recovered albedo and add it as illumination
  vec3 alb = clamp(c * uAlbGain, 0.0, 1.0);
  gl_FragColor = vec4(c + b * uI + alb * b * uSpill, 1.0);
}
`;

  const MIPS = 6;
  let down = null, up = null, mix = null;

  PT.passes.push({
    name: "bloom",
    run(ctx) {
      if (!cfg.bloom || cfg.bloomIntensity <= 0) return;
      const { T } = ctx;
      if (!down) {
        down = ctx.material(PT.SH.BLOOM_DOWN, { tSrc: { value: null }, uTexel: { value: new T.Vector2() }, uPrefilter: { value: 0 }, uThreshold: { value: 1 }, uLinearIn: { value: 0 } });
        up = ctx.material(PT.SH.BLOOM_UP, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new T.Vector2() }, uRadius: { value: 1 } });
        mix = ctx.material(PT.SH.BLOOM_MIX, { tColor: { value: null }, tBloom: { value: null }, uI: { value: 0 }, uLinearIn: { value: 0 }, uSpill: { value: 0 }, uAlbGain: { value: new T.Vector3(1, 1, 1) } });
      }
      // down chain: 1/2 ... 1/64
      const chain = [];
      let src = ctx.color, sw = ctx.w, sh = ctx.h;
      const mips = Math.min(MIPS, cfg.bloomMips ?? MIPS);
      for (let i = 0; i < mips; i++) {
        const w = Math.max(1, sw >> 1), h = Math.max(1, sh >> 1);
        const t = ctx.rt("bloomD" + i, w, h);
        const u = down.uniforms;
        u.tSrc.value = src; u.uTexel.value.set(1 / sw, 1 / sh);
        u.uPrefilter.value = i === 0 ? 1 : 0; u.uThreshold.value = cfg.bloomThreshold; u.uLinearIn.value = ctx.linear ? 1 : 0;
        ctx.pass(ctx.renderer, down, t);
        chain.push(t); src = t.texture; sw = w; sh = h;
      }
      // up chain: each level adds the blurred smaller level onto itself
      for (let i = mips - 2; i >= 0; i--) {
        const t = ctx.rt("bloomU" + i, chain[i].width, chain[i].height);
        const u = up.uniforms;
        u.tSrc.value = src; u.tBase.value = chain[i].texture;
        u.uTexel.value.set(1 / chain[i + 1].width, 1 / chain[i + 1].height); u.uRadius.value = cfg.bloomRadius;
        ctx.pass(ctx.renderer, up, t);
        src = t.texture;
      }
      const out = ctx.rt("bloomOut", ctx.w, ctx.h);
      mix.uniforms.tColor.value = ctx.color; mix.uniforms.tBloom.value = src;
      mix.uniforms.uI.value = cfg.bloomIntensity; mix.uniforms.uLinearIn.value = ctx.linear ? 1 : 0;
      const amb = PT.ambient || { col: [1, 1, 1], i: 1 };
      mix.uniforms.uAlbGain.value.set(...amb.col.map((c) => 1 / Math.max(0.02, c * amb.i * 0.55)));
      mix.uniforms.uSpill.value = (cfg.glowSpill ?? 0) * 6 * (PT.edgeGlowLevel?.() ?? 0);
      ctx.pass(ctx.renderer, mix, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx lens droplets: water on the "lens" while it rains, simulated as particles.
// spawning scales with speed (none while stopped); most drops are small. drops run outward to the
// sides faster the faster you go and the further out they are, stretching as they move. each drop is a
// soft sprite drawn into a half-res water map (normal xy + coverage), which a composite pass uses to
// refract a blurred copy of the scene. sprites, not grid cells, so nothing clips at cell edges.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ lensDrops: true, lensAmount: 1 });

  const MAX = 700;
  const drops = [];   // { x, y (ndc-ish: x in [-aspect,aspect], y in [-1,1]), r, vx, vy, age, life }

  PT.SH.LENS_SPRITE_V = `
attribute vec2 local;
varying vec2 vL;
void main(){ vL = local; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  PT.SH.LENS_SPRITE_F = `
varying vec2 vL;
uniform float uFade, uSoft;
void main(){
  float r = length(vL);
  if (r >= 1.0) discard;
  float a = smoothstep(1.0, uSoft, r) * uFade;      // soft edge: the lens is out of focus (softer on gopros)
  gl_FragColor = vec4(vL.x, vL.y, 1.0, a);         // normal blending -> rgb = (n.xy * a, coverage)
}`;
  PT.SH.LENS = `
uniform sampler2D tColor, tBlur, tDrops;
uniform float uLinearIn;
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  if (uLinearIn < 0.5) c = srgb2lin(c);
  vec3 d = texture2D(tDrops, vUv).rgb;
  float cov = clamp(d.b, 0.0, 1.0);
  if (cov > 0.002) {
    vec2 n = d.xy / max(cov, 1e-3);
    vec3 refr = texture2D(tBlur, clamp(vUv - n * 0.035, 0.0, 1.0)).rgb;      // the bead flips/magnifies (1/8 res = blurry)
    float spec = smoothstep(0.6, 0.0, length(n - vec2(-0.3, 0.4))) * 0.35;
    vec3 drop = refr * (1.05 - 0.15 * dot(n, n)) + spec * luma(refr + 0.02);
    c = mix(c, drop, cov * 0.85);
  }
  gl_FragColor = vec4(c, 1.0);
}`;
  PT.SH.DOWN4 = `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uLinearIn;
void main(){
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb
         + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
  c *= 0.25;
  if (uLinearIn < 0.5) c = srgb2lin(c);
  gl_FragColor = vec4(c, 1.0);
}`;
  PT.SH.CLEAR0 = `void main(){ gl_FragColor = vec4(0.0); }`;

  let lens = null, down = null, clear = null, sprites = null, spawnAcc = 0;

  function buildSprites(T) {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(new Float32Array(MAX * 4 * 3), 3));
    const local = new Float32Array(MAX * 4 * 2), idx = new Uint16Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      local.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    g.setAttribute("local", new T.BufferAttribute(local, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    const m = new T.ShaderMaterial({ vertexShader: PT.SH.LENS_SPRITE_V, fragmentShader: PT.SH.LENS_SPRITE_F,
      uniforms: { uFade: { value: 1 }, uSoft: { value: 0.3 } }, transparent: true, depthTest: false, depthWrite: false });
    sprites = new T.Mesh(g, m);
    sprites.frustumCulled = false;
  }

  function simulate(dt, rain, speed, flow, aspect) {
    // spawn: only while moving; most drops small (r is a fraction of screen height)
    spawnAcc += rain * speed * 260 * dt;
    while (spawnAcc >= 1 && drops.length < MAX) {
      spawnAcc -= 1;
      const r = 0.004 + 0.022 * Math.pow(Math.random(), 4);
      const x = (Math.random() * 2 - 1) * aspect * 0.95, y = Math.random() * 2 - 1;
      // keep the middle of the screen (where you're looking) mostly clear
      const c = Math.hypot(x / aspect, y * 0.8);
      if (Math.random() > Math.min(1, Math.max(0.08, (c - 0.12) / 0.5))) continue;
      drops.push({ x, y, r, age: 0, life: 1.5 + Math.random() * 3, vx: 0, vy: 0 });
    }
    if (drops.length >= MAX) spawnAcc = 0;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      // airflow: outward from the centre, mostly sideways, faster further out and at higher speed;
      // bigger drops get pushed harder. stopped -> they just sit and evaporate
      // radial: straight out from the centre (a drop in the upper right heads up-right)
      const dist = Math.hypot(d.x / aspect, d.y) + 1e-3;
      const ox = d.x / aspect / dist, oy = d.y / dist;
      const push = flow * (0.25 + 1.8 * dist) * (0.6 + d.r * 40);
      const tvx = ox * push, tvy = oy * push;
      const k = 1 - Math.exp(-dt / 0.15);
      d.vx += (tvx - d.vx) * k; d.vy += (tvy - d.vy) * k;
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.age > d.life || Math.abs(d.x) > aspect + 0.1 || Math.abs(d.y) > 1.1) drops.splice(i, 1);
    }
  }

  function writeSprites(aspect, gopro) {
    const pos = sprites.geometry.attributes.position.array;
    let n = 0;
    for (const d of drops) {
      const sp = Math.hypot(d.vx, d.vy);
      const ux = sp > 1e-4 ? d.vx / sp : 1, uy = sp > 1e-4 ? d.vy / sp : 0;
      const stretch = 1 + Math.min(5, sp * 0.18 / d.r * 0.02 * 10);
      // fade in quickly, evaporate at the end of life
      const fade = Math.min(1, d.age / 0.08) * Math.min(1, (d.life - d.age) / 0.6);
      // out-of-focus drops look bigger towards the edges; a gopro sits right behind its lens, so its
      // drops are bigger still (and get a softer sprite + coarser water map below)
      const dist = Math.hypot(d.x / aspect, d.y);
      const R = d.r * (0.75 + 0.9 * dist) * (gopro ? 1.8 : 1);
      const a = R * stretch * fade, b = R * Math.max(fade, 0.3);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let k = 0; k < 4; k++) {
        const [cx, cy] = corners[k];
        // trailing streak: stretch backwards along the motion
        const along = cx < 0 ? -a : R;
        const px = d.x + ux * along + -uy * cy * b, py = d.y + uy * along + ux * cy * b;
        pos[(n * 4 + k) * 3] = px / aspect; pos[(n * 4 + k) * 3 + 1] = py; pos[(n * 4 + k) * 3 + 2] = 0;
      }
      n++;
    }
    sprites.geometry.attributes.position.needsUpdate = true;
    sprites.geometry.setDrawRange(0, n * 6);
    return n;
  }

  PT.passes.push({
    name: "lens",
    run(ctx) {
      const W = PT.weather;
      const rain = cfg.lensDrops ? (W?.rain ?? 0) * (1 - (W?.hail ?? 0)) * cfg.lensAmount : 0;
      // km/h (1 unit = 1 m). spawning grows with speed; drift is quadratic so 100 km/h is gentle
      // and only ~300 km/h gets the full rush
      const kmh = Math.hypot(...(PT.camVel || [0, 0, 0])) * 3.6;
      const speed = Math.min(1.2, kmh / 180), flow = Math.pow(Math.min(1.3, kmh / 300), 2);
      const aspect = ctx.w / ctx.h;
      simulate(Math.min(ctx.state.dt, 0.05), rain, speed, flow, aspect);
      if (!drops.length) return;
      const { T, renderer } = ctx;
      if (!lens) {
        lens = ctx.material(PT.SH.LENS, { tColor: { value: null }, tBlur: { value: null }, tDrops: { value: null }, uLinearIn: { value: 0 } });
        down = ctx.material(PT.SH.DOWN4, { tSrc: { value: null }, uTexel: { value: new T.Vector2() }, uLinearIn: { value: 0 } });
        clear = ctx.material(PT.SH.CLEAR0, {});
        buildSprites(T);
      }
      // water map at half res (the soft sprite edges + bilinear upsampling are the blur)
      const gopro = !!PT.camBolted, sh = gopro ? 2 : 1;   // coarser water map on gopros = blurrier drops
      const dm = ctx.rt("lensDrops" + sh, Math.max(1, ctx.w >> sh), Math.max(1, ctx.h >> sh));
      const n = writeSprites(aspect, gopro);
      sprites.material.uniforms.uSoft.value = gopro ? -0.1 : 0.2;
      ctx.pass(renderer, clear, dm);
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.setRenderTarget(dm); renderer.render(sprites, ctx.quadCam);
      renderer.autoClear = ac;
      // blurred scene at 1/8 res
      let src = ctx.color, w = ctx.w, h = ctx.h; const lin = ctx.linear ? 1 : 0;
      for (let i = 0; i < 3; i++) {
        const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), t = ctx.rt("lensD" + i, nw, nh);
        down.uniforms.tSrc.value = src; down.uniforms.uTexel.value.set(1 / w, 1 / h); down.uniforms.uLinearIn.value = i === 0 ? lin : 1;
        ctx.pass(renderer, down, t); src = t.texture; w = nw; h = nh;
      }
      const u = lens.uniforms;
      u.tColor.value = ctx.color; u.tBlur.value = src; u.tDrops.value = dm.texture; u.uLinearIn.value = lin;
      const out = ctx.rt("lens", ctx.w, ctx.h);
      ctx.pass(renderer, lens, out);
      ctx.linear = true;
      PT.lensDebug = n;
      return out.texture;
    },
  });
})();
// ptfx gopro lens (experimental): action-cam fisheye + edge blur + chromatic aberration, only while a
// car-mounted cam is active (C cycle mounts, cinematic mount/ghost shots). the camera renders wider
// (PT.goproFovBoost) and the fisheye squeezes the edges back in, like raw gopro footage. runs after the lens drops, so
// drops on the lens bend too.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ goproLens: true, goproFisheye: 0.8, goproRes: 1.15, goproFov: 0, goproEdgeBlur: 0.35, goproAberration: 1 });

  PT.SH.GOPRO = `
uniform sampler2D tColor; uniform float uAspect, uK, uTan, uLinearIn, uBlur, uCA;
vec3 col(vec2 uv){ vec3 c = texture2D(tColor, clamp(uv, 0.0, 1.0)).rgb; return uLinearIn > 0.5 ? c : srgb2lin(c); }
// fisheye: the scene is rendered rectilinear (wider than usual); each output pixel is treated as an
// equidistant-fisheye ray (angle grows linearly with radius, like an action cam) and looked up where that ray
// landed in the rectilinear render. corners map to corners, so nothing is cropped or left black.
vec2 warp(vec2 uv, float amt){
  vec2 p = uv * 2.0 - 1.0;
  vec2 ext = vec2(uTan * uAspect, uTan);       // tangent-space half extents of the render
  vec2 t = p * ext;
  float Dt = length(ext), thc = atan(Dt), r = length(t);
  if (r < 1e-5) return mix(uv, 0.5 + (uv - 0.5) * (thc / Dt), amt);
  float s = tan(r / Dt * thc) / r;               // < 1 in the middle (magnified), 1 at the corners
  return 0.5 + (uv - 0.5) * mix(1.0, s, amt);
}
void main(){
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float edge = dot(p, p);
  vec2 g = warp(vUv, uK);
  // chromatic aberration: red pushed out, blue pulled in, growing towards the edges
  float ca = 0.006 * uCA * smoothstep(0.0, 0.9, edge);
  vec2 rr = 0.5 + (g - 0.5) * (1.0 + ca), bb = 0.5 + (g - 0.5) * (1.0 - ca);
  vec3 c = vec3(col(rr).r, col(g).g, col(bb).b);
  // edge blur: a small disc of taps whose radius grows towards the corners
  float rad = 0.007 * uBlur * smoothstep(0.12, 0.95, edge);
  if (rad > 0.0002) {
    vec3 acc = c;
    float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2832;
    for (int i = 0; i < 8; i++) {
      float a = j + float(i) * 0.7854, r = rad * (i < 4 ? 0.5 : 1.0);
      vec2 o = vec2(cos(a), sin(a)) * r * vec2(1.0 / uAspect, 1.0);
      acc += vec3(col(rr + o).r, col(g + o).g, col(bb + o).b);
    }
    c = acc / 9.0;
  }
  c *= 1.0 - 0.18 * smoothstep(0.15, 0.9, edge);           // lens falloff
  gl_FragColor = vec4(c, 1.0);
}`;

  // extra render fov the fisheye needs to look like a real action cam (it squeezes the edges back in)
  PT.goproFovBoost = () => (cfg.goproLens ? cfg.goproFisheye * 22 : 0);
  let mat = null;
  PT.passes.push({
    name: "goprolens",
    run(ctx) {
      if (!cfg.goproLens || !PT.camBolted || ctx.photo) return;
      if (!mat) mat = ctx.material(PT.SH.GOPRO, { tColor: { value: null }, uAspect: { value: 1 }, uK: { value: 0.8 }, uTan: { value: 1 }, uLinearIn: { value: 0 }, uBlur: { value: 0 }, uCA: { value: 1 } });
      const u = mat.uniforms;
      u.tColor.value = ctx.color; u.uAspect.value = ctx.w / ctx.h; u.uLinearIn.value = ctx.linear ? 1 : 0;
      u.uK.value = cfg.goproFisheye; u.uTan.value = Math.tan((ctx.camera.fov || 90) * Math.PI / 360); u.uBlur.value = cfg.goproEdgeBlur; u.uCA.value = cfg.goproAberration;
      const out = ctx.rt("gopro", ctx.w, ctx.h);
      ctx.pass(ctx.renderer, mat, out);
      ctx.linear = true;
      return out.texture;
    },
  });
})();
// ptfx speed feel: a little extra field of view and a gentle camera sway that grow with speed.
// applied to the camera only for the duration of our frame and restored afterwards, so the game's own
// camera logic never sees them. speed is heavily smoothed: raw camera speed jitters frame to frame
// (physics ticks vs render frames), and feeding that straight into fov read as lag spikes.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ speedFov: 1, speedShake: 1, impactShake: 1 });

  let saved = null, kmhS = 0, fovS = 0;
  // impacts (landings, wall hits): velocity change between two short windows of car positions. the
  // game's interpolated positions ripple ~10% frame to frame and repeat a frame now and then, so single
  // frame deltas are useless; repeated frames are dropped and each window spans ~7 frames
  const hist = [];          // [t, x, y, z]
  const WIN = 0.06;
  let trauma = 0, cool = 0, aEma = null, airT = 0, airV = null;
  const rec = { o: null, w: null };   // recoil spring: camera offset + its velocity (world space)
  const hf = (t) => Math.sin(t * 61) * 0.5 + Math.sin(t * 97 + 1.7) * 0.3 + Math.sin(t * 43 + 0.4) * 0.2;
  function velAt(T, t1) {   // mean velocity over [t1 - WIN, t1] from the history
    let a = null, b = null;
    for (let i = hist.length - 1; i >= 0; i--) { const h = hist[i]; if (!b && h[0] <= t1) b = h; if (h[0] <= t1 - WIN) { a = h; break; } }
    if (!a || !b || b[0] - a[0] < WIN * 0.7) return null;
    const d = b[0] - a[0];
    return new T.Vector3((b[1] - a[1]) / d, (b[2] - a[2]) / d, (b[3] - a[3]) / d);
  }
  // the game's collision impulses, the same numbers its crash sound uses (plays above 25). only the car the
  // camera follows; a hit knocks the camera opposite to the car's travel and adds rattle
  let pendingHit = 0;
  PT.impact = (car, imp) => {
    if (car !== window.__ptfxCar) return;
    if (imp <= 25) return;
    // log scale: scrapes ~300 (nudge), hard knocks ~1000, a 260 km/h wall ~11000 (full whack)
    pendingHit = Math.max(pendingHit, Math.min(1, Math.log10(imp / 25) / Math.log10(8000 / 25)));
  };
  function impacts(ctx, dt) {
    const T = ctx.T, car = PT.playerCar, now = performance.now() / 1000;
    if (!car || performance.now() - car.at > 300) { hist.length = 0; return; }
    const p = car.pos, last = hist[hist.length - 1];
    if (last) {
      const step = Math.hypot(p.x - last[1], p.y - last[2], p.z - last[3]);
      if (step > 15) { hist.length = 0; aEma = null; airT = 0; airV = null; }   // respawn / restart teleport
      else if (step < 1e-4 && car.speed > 2) return;                     // repeated frame: skip it
    }
    hist.push([now, p.x, p.y, p.z]);
    while (hist.length && hist[0][0] < now - 0.5) hist.shift();
    cool -= dt;
    if (pendingHit > 0) {
      const h = pendingHit; pendingHit = 0;
      trauma = Math.min(1, trauma + h * 0.9);
      rec.o ??= new T.Vector3(); rec.w ??= new T.Vector3();
      const back = car.vel.lengthSq() > 4 ? car.vel.clone().normalize() : car.fwd.clone();
      rec.w.addScaledVector(back, -h * 2.2);
    }
    // landings: the game's own wheel contacts say when the car is airborne and when it touches down; the
    // hit is how fast it was moving INTO its floor just before (so dropping onto a matching slope is soft)
    const st = window.__ptfxCarState, wc = st?.wheelContact;
    if (!wc || window.__ptfxCar == null) return;
    const grounded = wc.some((w) => w != null);
    const v = velAt(T, now);
    if (!grounded) { airT += dt; if (v) airV = v; return; }
    if (airT > 0.12 && airV) {
      // m/s into the floor at touchdown; straight-down speed counts too (a car pitched in the air hides it)
      const into = Math.max(0, -airV.dot(car.up), -airV.y * 0.8);
      const h = Math.min(1, Math.max(0, (into - 1) / 7) * Math.min(1, airT / 0.3 + 0.5));
      if (h > 0) {
        trauma = Math.min(1, trauma + h * 0.95);
        rec.o ??= new T.Vector3(); rec.w ??= new T.Vector3();
        rec.w.addScaledVector(car.up, -h * 3.2);   // camera slams down, springs back
        PT.lastLanding = { into: +into.toFixed(1), air: +airT.toFixed(2), h: +h.toFixed(2) };
      }
    }
    airT = 0; airV = null;
  }
  // low-frequency sway (a few Hz), not high-frequency jitter: jitter reads as stutter
  const n1 = (t) => Math.sin(t * 3.1) * 0.5 + Math.sin(t * 5.3 + 1.3) * 0.3 + Math.sin(t * 8.7 + 2.1) * 0.2;
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  PT.passes.push({
    name: "speedfx",
    beforeScene(ctx) {
      const cam = ctx.camera, dt = Math.min(ctx.state.dt, 0.1);
      // photos: nothing. cinematics: only the car-mounted gopro shots shake, and never get a fov kick
      const cine = PT.cineActive, bolted = !!PT.camBolted;
      if (!cam.isPerspectiveCamera || ctx.photo || (cine && !bolted)) return;
      impacts(ctx, dt);
      const raw = Math.hypot(...(PT.camVel || [0, 0, 0])) * 3.6;
      if (raw < 700) kmhS += (raw - kmhS) * (1 - Math.exp(-dt / 0.6));   // ignore respawn teleports
      const s = sstep(80, 420, kmhS), sLow = sstep(40, 300, kmhS);
      // fov eases toward its target on top of the smoothed speed: no steps, ever
      fovS += ((cine ? 0 : 7 * s * cfg.speedFov) - fovS) * (1 - Math.exp(-dt / 0.35));
      // speed shake: sway + a fine vibration, noticeable from ~60 km/h. amplitudes are ANGLES: a few cm of
      // position on a camera 5 m behind the car was invisible
      // only car-mounted gopro cams shake (C cycle mounts + cinematic mount/ghost shots); game + chase cams stay steady
      const k = bolted ? (0.6 * sLow + 0.4 * s) * cfg.speedShake : 0;
      trauma = Math.max(0, trauma - dt * 1.3);
      PT.trauma = trauma;   // the holo hud gets knocked by the same impacts
      let springing = false;
      if (rec.o) {   // stiff, slightly underdamped: one kick and a small bounce
        rec.w.addScaledVector(rec.o, -220 * dt).multiplyScalar(Math.exp(-dt * 14));
        rec.o.addScaledVector(rec.w, dt);
        springing = rec.o.lengthSq() > 1e-6 || rec.w.lengthSq() > 1e-4;
      }
      const tr = bolted ? Math.pow(trauma, 1.5) * cfg.impactShake : 0;
      if (!bolted) springing = false;
      if (fovS < 0.01 && k < 0.001 && tr < 0.001 && !springing) return;
      saved = { fov: cam.fov, pos: cam.position.clone(), quat: cam.quaternion.clone() };
      cam.fov += fovS;
      const t = ctx.state.time, pm = 0.25;   // gopros: rattle by rotation, barely translate
      cam.position.y += n1(t) * 0.07 * k * pm;
      cam.position.x += n1(t + 17.3) * 0.04 * k * pm;
      cam.rotateZ(n1(t + 5.1) * 0.012 * k);
      cam.rotateX(hf(t * 0.25 + 2.2) * 0.004 * k); cam.rotateY(hf(t * 0.25 + 7.7) * 0.0025 * k);
      if (tr > 0.001) {   // impact rattle: fast, short
        cam.position.y += hf(t) * 0.18 * tr * pm;
        cam.position.x += hf(t + 9.1) * 0.12 * tr * pm;
        cam.rotateX(hf(t + 3.3) * 0.05 * tr); cam.rotateY(hf(t + 4.4) * 0.03 * tr); cam.rotateZ(hf(t + 6.6) * 0.045 * tr);
      }
      if (springing) {   // recoil: the knock, as a nod/turn of the camera plus a bit of travel
        const o = rec.o.clone().multiplyScalar(cfg.impactShake);
        const right = new ctx.T.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new ctx.T.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
        cam.rotateX(o.dot(up) * 0.3); cam.rotateY(-o.dot(right) * 0.2);
        cam.position.addScaledVector(o, pm * 1.5);
      }
      PT.shakeDbg = { kmh: Math.round(kmhS), k: +k.toFixed(2), trauma: +trauma.toFixed(2), rec: rec.o ? +rec.o.length().toFixed(3) : 0 };
      cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    },
    afterFrame(ctx) {
      if (!saved) return;
      const cam = ctx.camera;
      cam.fov = saved.fov; cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat);
      cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      saved = null;
    },
  });
})();
// ptfx cinematic cameras. our own camera replaces the game's for rendering only.
//  - auto (watch/replay, or 3 s after crossing the finish line): full shot mix, car-mounted
//    gopro angles, trackside tripods, drone/flyby/orbit.
//  - K (while driving): mostly behind the car so you can drive; a brief frontal/side shot only when
//    you've been going straight a while.
// the tracked car is whatever the *game* camera follows (headlights module), so replays work.
// every free-standing shot needs line of sight to the car (raycast against the track): candidates
// that can't see it are rejected at placement, and a shot that loses sight for a moment is cut.
// a teleport (R/T/respawn) cuts straight to a fresh chase shot.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ cinematic: "auto", cineShotLen: 6 });

  let cam = null, shot = null, lastT = performance.now(), lastInput = -1e9, forced = false, look = null, lastCarPos = null;
  let finishedAt = null, outFor = 0, ray = null, losFrame = 0, blockedFor = 0, heading = [], frontCooldown = 0;
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
  window.addEventListener("keydown", (e) => {
    if (typing(e)) return;
    if (e.code === "KeyK" && !e.repeat) { forced = !forced; shot = null; return; }
    if (/^(Arrow|Key[WASD]$)/.test(e.code)) lastInput = performance.now();
  }, true);

  // car-mounted cams: [name, offset (right, up, fwd) in car lengths-ish metres, look offset, fov]
  const MOUNTS = {
    roof:  { o: [0, 0.95, -0.3], l: [0, 0.6, 12], fov: 92 },
    side:  { o: [1.05, 0.3, -0.6], l: [0.4, 0.2, 10], fov: 96 },
    wheel: { o: [1.15, 0.12, 1.45], l: [0.75, 0.25, -6], fov: 100 },     // low by the front wheel, looking back
    wing:  { o: [0, 1.0, -2.2], l: [0, 0.3, 6], fov: 102 },            // behind/above the rear wing, car in frame
    nose:  { o: [0, 0.35, 2.1], l: [0, -0.4, 20], fov: 78 },
  };

  function clearLine(T, from, to) {
    const meshes = PT.trackMeshes;
    if (!meshes?.length || !T.Raycaster) return true;
    ray ??= new T.Raycaster();
    const d = to.clone().sub(from), len = d.length();
    if (len < 0.5) return true;
    d.divideScalar(len);
    const g = PT.rayHit?.(from, d, Math.max(0.3, len - 1.8), 0.3);   // stop short of the car itself
    if (g !== null && g !== undefined) return g === Infinity;
    ray.set(from, d); ray.near = 0.3; ray.far = Math.max(0.3, len - 1.8);
    return ray.intersectObjects(meshes, false).length === 0;
  }

  function mounted(T, car, m) {
    const at = (v) => car.pos.clone().addScaledVector(car.right, v[0]).addScaledVector(car.up, v[1]).addScaledVector(car.fwd, v[2]);
    return { pos: at(m.o), target: at(m.l), up: car.up.clone(), fov: m.fov };
  }

  function chasePose(T, car, kind) {
    const p = { chase: [-5.5, 1.1, 6], chaseLow: [-4.2, 0.55, 8], chaseHigh: [-7, 3.2, 5], chaseWide: [-3.6, 0.9, 10] }[kind];
    return { pos: car.pos.clone().addScaledVector(car.fwd, p[0]).addScaledVector(car.up, p[1]), target: car.pos.clone().addScaledVector(car.fwd, p[2]), fov: kind === "chaseWide" ? 88 : 64 };
  }

  function newShot(T, car, driving, why) {
    const v = car.vel.length() > 2 ? car.vel.clone().normalize() : car.fwd.clone();
    const s = { t: 0, side: Math.random() < 0.5 ? -1 : 1, seed: Math.random(), why };
    if (driving || why === "teleport") {
      // K mode: behind the car. a frontal/side glance only after a long straight, and not too often
      const straight = heading.length > 20 && heading.every((h) => h.dot(car.fwd) > 0.995);
      if (driving && straight && frontCooldown <= 0 && why !== "teleport" && Math.random() < 0.5) {
        s.kind = Math.random() < 0.5 ? "front" : "sideTrack"; s.len = 2.5; frontCooldown = 15;
      } else { s.kind = ["chase", "chase", "chaseLow", "chaseHigh", "chaseWide"][Math.floor(Math.random() * 5)]; s.len = 8; }
      return s;
    }
    const pool = ["mount", "mount", "trackside", "trackside", "drone", "flyby", "orbit", "chaseLow", "ghost"];
    for (let attempt = 0; attempt < 6; attempt++) {
      s.kind = pool[Math.floor(Math.random() * pool.length)];
      if (car.speed < 3 && (s.kind === "trackside" || s.kind === "flyby")) continue;
      if (s.kind === "mount") { const names = Object.keys(MOUNTS); s.mount = names[Math.floor(Math.random() * names.length)]; s.len = 4; return s; }
      if (s.kind === "ghost") { if (!(PT.ghostPoses || []).length) continue; s.rear = Math.random() < 0.5; s.len = 4; return s; }
      if (s.kind === "trackside") {
        // a tripod where the car is about to be, off to one side, low: must already see the car
        s.pos = car.pos.clone().addScaledVector(v, Math.min(70, 10 + car.speed * 1.4)).addScaledVector(car.right, s.side * (5 + 5 * s.seed)).addScaledVector(car.up, 1.0 + 1.5 * s.seed);
        s.fov = 36; s.len = 6;
      } else if (s.kind === "flyby") {
        // starts well ahead and drifts at 80% of the car's speed: the car reels it in, passes, pulls away in shot
        s.pos = car.pos.clone().addScaledVector(car.right, s.side * 7).addScaledVector(v, 10 + car.speed * 0.35).addScaledVector(car.up, 1.6);
        s.drift = v.clone().multiplyScalar(car.speed * 0.8); s.fov = 50; s.len = 4;
      } else if (s.kind === "drone") { s.fov = 55; s.len = 7; s.height = 6 + 6 * s.seed; s.back = 10 + 8 * s.seed; }
      else if (s.kind === "orbit") { s.fov = 48; s.len = 6; }
      else { s.len = 5; return s; }
      if (!s.pos || clearLine(T, s.pos, car.pos)) return s;   // moving shots are checked live
    }
    s.kind = "chase"; s.len = 6;   // nothing could see the car: fall back to a safe chase
    return s;
  }

  PT.cameraHook = (gameCam, T) => {
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    let car = PT.playerCar;
    if (car && now - car.at > 500) car = null;   // stale (menus, car despawned)
    if (car) car = PT.livePose?.(car, T) ?? car;   // this frame's pose, not last frame's
    const driving = forced && now - lastInput < 4000;
    // auto: replays/watch mode, and 3 s after crossing the finish line. never mid-race (the old "no input
    // for 4 s" rule kicked in on long straights while you were holding throttle)
    const gc = window.__ptfxCar;
    let fin = false;
    try { fin = !!gc?.hasFinished?.(); } catch { /* game internals changed: treat as racing */ }
    if (!fin) finishedAt = null; else finishedAt ??= now;
    const replay = now - (window.__ptfxWatchT ?? -1e9) < 500;
    const watching = cfg.cinematic === "on" || (cfg.cinematic === "auto" && !!car && (replay || (finishedAt !== null && now - finishedAt > 3000)));
    PT.cineActive = !!car && cfg.cinematic !== "off" && (forced || watching);
    if (!PT.cineActive) { shot = null; lastCarPos = null; return null; }
    if (!cam) cam = gameCam.clone();
    cam.aspect = gameCam.aspect; cam.near = gameCam.near; cam.far = gameCam.far;

    // teleport (restart, checkpoint, respawn): cut to a fresh chase
    const jumped = lastCarPos && lastCarPos.distanceTo(car.pos) > 10;
    lastCarPos = car.pos.clone();
    heading.push(car.fwd.clone()); if (heading.length > 90) heading.shift();
    frontCooldown -= dt;

    PT.cineCut = false;
    if (!shot || jumped || shot.t > shot.len) {
      shot = newShot(T, car, driving, jumped ? "teleport" : "time"); look = null; blockedFor = 0; PT.cineCut = true;
      if (jumped) heading = [];
    }
    shot.t += dt;
    const k = (tau) => 1 - Math.exp(-dt / tau);
    let pos, target = car.pos.clone(), up = new T.Vector3(0, 1, 0), free = true;
    switch (shot.kind) {
      case "mount": { const m = mounted(T, car, MOUNTS[shot.mount]); pos = m.pos; target = m.target; up = m.up; shot.fov = m.fov; free = false; break; }
      case "ghost": {
        // angled bumper cam on the nearest ghost: front looks ahead, rear looks back at the chaser
        const gs = (PT.ghostPoses || []).filter((g) => now - g.at < 500);
        const g0 = gs.sort((a, b) => a.pos.distanceTo(car.pos) - b.pos.distanceTo(car.pos))[0], g = g0 && (PT.livePose?.(g0, T) ?? g0);
        if (!g) { shot.t = shot.len + 1; pos = car.pos.clone().addScaledVector(car.fwd, -6).addScaledVector(car.up, 1.2); free = false; break; }
        const gat = (o) => g.pos.clone().addScaledVector(g.right, o[0]).addScaledVector(g.up, o[1]).addScaledVector(g.fwd, o[2]);
        pos = gat(shot.rear ? [-0.55, 0.22, -2.0] : [0.55, 0.18, 2.0]); target = gat(shot.rear ? [-2, 0.1, -22] : [2.5, 0, 22]);
        up = g.up.clone(); shot.fov = 86; free = false; break;
      }
      case "chase": case "chaseLow": case "chaseHigh": case "chaseWide": {
        const c = chasePose(T, car, shot.kind);
        shot.cur = shot.cur && !PT.cineCut ? shot.cur.lerp(c.pos, k(0.12)) : c.pos;
        pos = shot.cur.clone(); target = c.target; shot.fov = c.fov; free = false;   // hugging the car: no los test
        break;
      }
      case "front": { pos = car.pos.clone().addScaledVector(car.fwd, 7).addScaledVector(car.up, 1.0); shot.fov = 55; break; }
      case "sideTrack": { pos = car.pos.clone().addScaledVector(car.right, 6).addScaledVector(car.up, 1.2).addScaledVector(car.fwd, 1.5); shot.fov = 60; break; }
      case "trackside": { pos = shot.pos.clone(); if (pos.distanceTo(car.pos) > 90 && shot.t > 1.5) shot.t = shot.len + 1; break; }
      case "flyby": pos = shot.pos.addScaledVector(shot.drift, dt).clone(); break;
      case "drone": {
        const want = car.pos.clone().addScaledVector(car.fwd, -shot.back).add(new T.Vector3(0, shot.height, 0)).addScaledVector(car.right, shot.side * 5);
        // carried along with the car first, then eased: the smoothing used to cost ~v*0.7 s of lag (50 m at
        // 250 km/h), so the drone fell behind and lost the car
        if (shot.cur && shot.lastCar) shot.cur.add(car.pos.clone().sub(shot.lastCar));
        shot.lastCar = car.pos.clone();
        shot.cur = shot.cur ? shot.cur.lerp(want, k(0.7)) : want; pos = shot.cur.clone(); break;
      }
      case "orbit": { const a = shot.seed * 6.28 + shot.t * 0.35 * shot.side; pos = car.pos.clone().add(new T.Vector3(Math.cos(a) * 7.5, 2.2, Math.sin(a) * 7.5)); break; }
    }
    // free-standing shots must keep sight of the car: test every 5th frame, cut after ~0.25s blocked
    if (free && ++losFrame % 5 === 0) {
      blockedFor = clearLine(T, pos, car.pos) ? 0 : blockedFor + dt * 5;
      if (blockedFor > 0.25) shot.t = shot.len + 1;
    }
    // free shots aim slightly ahead of the car so a fast car doesn't outrun the smoothing
    if (free) target.addScaledVector(car.vel, 0.08);
    const tau = shot.kind === "trackside" ? 0.04 : 0.06;
    look = !look || !free ? target.clone() : look.lerp(target, k(tau));
    // car-mounted shots sit centimetres from a car: the game's 0.5 m near plane sliced it open
    const bolted = shot.kind === "mount" || shot.kind === "ghost";
    PT.camBolted = bolted;   // speedfx shakes gopro shots (and only those) during cinematics
    cam.near = bolted ? 0.05 : gameCam.near; cam.far = bolted ? Math.min(gameCam.far, 4000) : gameCam.far;
    cam.fov = Math.min(150, Math.max(20, (shot.fov ?? 60) + (bolted ? (cfg.goproFov || 0) + (PT.goproFovBoost?.() || 0) : 0))); cam.up.copy(up);
    cam.position.copy(pos); cam.lookAt(look);
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    PT.cineShot = shot.kind;
    // safety net: a free shot that has lost the car out of frame for ~0.4 s cuts to the next shot
    if (free) {
      const q = car.pos.clone().project(cam);
      outFor = Math.abs(q.x) > 1.05 || Math.abs(q.y) > 1.05 || q.z > 1 ? outFor + dt : 0;
      if (outFor > 0.4) { shot.t = shot.len + 1; outFor = 0; }
    }
    return cam;
  };
})();
// ptfx camera cycle: C steps through extra views (shift+C goes back): the game's own camera first, then
// chase styles and gopro-style mounts. the game's cockpit view stays on M. rendering-only, like the
// cinematic cams: the game's camera logic never sees ours. chase cams never sit inside the track: if
// the view to the car is blocked they pull in toward it.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});

  // right, up, fwd offsets in metres from the body centre; look = point to aim at (same frame)
  const MOUNT = (o, l, fov) => ({ kind: "mount", o, l, fov });
  const VIEWS = [
    { name: "game camera" },
    { name: "chase · locked", kind: "locked" },
    { name: "chase · loose", kind: "loose" },
    { name: "chase · drift", kind: "drift" },
    { name: "chase · high", kind: "high" },
    { name: "chase · low", kind: "low" },
    { name: "chase · speed", kind: "speed" },
    { name: "roof", ...MOUNT([0, 0.95, -0.3], [0, 0.6, 12], 92) },
    { name: "side pod · left", ...MOUNT([-1.05, 0.3, -0.6], [-0.4, 0.2, 10], 96) },
    { name: "side pod · right", ...MOUNT([1.05, 0.3, -0.6], [0.4, 0.2, 10], 96) },
    { name: "front wheel", ...MOUNT([1.15, 0.12, 1.45], [0.75, 0.25, -6], 100) },
    { name: "rear wheel", ...MOUNT([1.2, 0.12, -1.45], [0.8, 0.2, 8], 100) },
    { name: "rear wing", ...MOUNT([0, 1.0, -2.2], [0, 0.3, 6], 102) },
    { name: "nose", ...MOUNT([0, 0.35, 2.1], [0, -0.4, 20], 78) },
    { name: "low bumper", ...MOUNT([0, 0.12, 2.0], [0, 0.05, 25], 88) },
    // mounted on the nearest ghost: angled front bumper looking ahead, rear bumper looking back at you
    { name: "ghost · front bumper", kind: "ghost", o: [0.55, 0.18, 2.0], l: [2.5, 0.0, 22], fov: 86 },
    { name: "ghost · rear bumper", kind: "ghost", o: [-0.55, 0.22, -2.0], l: [-2.0, 0.1, -22], fov: 86 },
  ];
  const ghostNear = (car) => {
    const gs = (PT.ghostPoses || []).filter((g) => performance.now() - g.at < 500);
    let best = null, d = 1e9;
    for (const g of gs) { const dd = g.pos.distanceTo(car.pos); if (dd < d) { d = dd; best = g; } }
    return best;
  };

  let lastBody = null;
  let idx = 0, cam = null, cur = null, look = null, lastPos = null, lastT = performance.now(), ray = null, toast = null, toastT = 0;
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;

  function say(msg) {
    if (!toast) {
      toast = document.createElement("div");
      toast.style.cssText = "position:fixed;left:50%;top:22px;transform:translateX(-50%);z-index:2147483647;padding:7px 14px;" +
        "font:13px ForcedSquare,Arial,sans-serif;color:#fff;background:rgba(7,9,16,.9);border:1px solid rgba(120,150,255,.35);pointer-events:none;transition:opacity 200ms ease-out";
      document.body.appendChild(toast);
    }
    toast.textContent = msg; toast.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => (toast.style.opacity = "0"), 1200);
  }

  for (const type of ["keydown", "keyup"]) {
    window.addEventListener(type, (e) => {
      if (e.code !== "KeyC" || typing(e) || !PT.playerCar) return;   // no car (menus/editor): leave C alone
      e.stopImmediatePropagation(); e.preventDefault();
      if (type !== "keydown" || e.repeat) return;
      const step = e.shiftKey ? -1 : 1;
      do idx = (idx + step + VIEWS.length) % VIEWS.length;
      while (VIEWS[idx].kind === "ghost" && !ghostNear(PT.playerCar));   // no ghost: skip its views
      cur = null; look = null;
      say(`camera · ${VIEWS[idx].name}  (${idx + 1}/${VIEWS.length})`);
    }, true);
  }

  // pull the camera in toward the car when the track is between them
  function unblock(T, carPos, pos) {
    const meshes = PT.trackMeshes;
    if (!meshes?.length || !T.Raycaster) return pos;
    ray ??= new T.Raycaster();
    const d = pos.clone().sub(carPos), len = d.length();
    if (len < 0.5) return pos;
    d.divideScalar(len);
    const g = PT.rayHit?.(carPos, d, len, 1.2);
    let dist;
    if (g !== null && g !== undefined) dist = g;
    else { ray.set(carPos, d); ray.near = 1.2; ray.far = len; dist = ray.intersectObjects(meshes, false)[0]?.distance ?? Infinity; }
    return dist < Infinity ? carPos.clone().addScaledVector(d, Math.max(1.4, dist - 0.4)) : pos;
  }

  const prevHook = PT.cameraHook;
  PT.cameraHook = (gameCam, T) => {
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    let car = PT.playerCar;
    if (car && now - car.at > 500) car = null;
    if (car) car = PT.livePose?.(car, T) ?? car;
    const v = VIEWS[idx];
    PT.camCut = false; PT.camBolted = false;
    // cinematic (replay auto or K) outranks the C cycle; it used to be the other way round, so any C view
    // silently disabled cinema mode
    const cine = prevHook ? prevHook(gameCam, T) : null;
    if (cine) { PT.camCycleActive = false; return cine; }
    PT.camCycleActive = !!car && idx > 0;
    if (!PT.camCycleActive) return null;
    // new race (new car object) while one of our views is selected: say so, it isn't the game's camera
    if (car.body !== lastBody) { lastBody = car.body; say(`camera · ${v.name}  (C to change)`); }
    if (!cam) cam = gameCam.clone();
    cam.aspect = gameCam.aspect;
    // cams bolted onto a car sit centimetres from it: the game's 0.5 m near plane sliced the car open
    const bolted = v.kind === "mount" || v.kind === "ghost";
    PT.camBolted = bolted;
    cam.near = bolted ? 0.05 : gameCam.near; cam.far = bolted ? Math.min(gameCam.far, 4000) : gameCam.far;

    // respawn / restart: snap instead of swooping across the map
    if (lastPos && lastPos.distanceTo(car.pos) > 10) { cur = null; look = null; PT.camCut = true; }
    lastPos = car.pos.clone();
    const k = (tau) => 1 - Math.exp(-dt / tau);
    const W = new T.Vector3(0, 1, 0);
    const at = (o) => car.pos.clone().addScaledVector(car.right, o[0]).addScaledVector(car.up, o[1]).addScaledVector(car.fwd, o[2]);
    let pos, target, up = W.clone(), fov = 65, smooth = 0, chase = true;
    switch (v.kind) {
      case "locked": pos = at([0, 1.3, -5.5]); target = at([0, 0.4, 4]); up = car.up.clone(); break;   // bolted on: rolls with the car
      case "loose": pos = car.pos.clone().addScaledVector(car.fwd, -6.5).addScaledVector(W, 1.8); target = car.pos.clone().addScaledVector(car.fwd, 3); smooth = 0.45; break;
      case "drift": {
        const dir = car.vel.length() > 3 ? car.vel.clone().normalize() : car.fwd.clone();   // where it's going, not where it points
        pos = car.pos.clone().addScaledVector(dir, -6).addScaledVector(W, 1.6); target = car.pos.clone().addScaledVector(dir, 4); smooth = 0.15; break;
      }
      case "high": pos = car.pos.clone().addScaledVector(car.fwd, -11).addScaledVector(W, 5.5); target = car.pos.clone().addScaledVector(car.fwd, 6); fov = 58; smooth = 0.15; break;
      case "low": pos = at([0, 0.45, -3.3]); target = at([0, 0.3, 6]); fov = 80; smooth = 0.06; break;
      case "speed": {
        const s = Math.min(1, car.speed / 110);
        pos = car.pos.clone().addScaledVector(car.fwd, -(4.8 + 4 * s)).addScaledVector(W, 1.3 + 0.6 * s);
        target = car.pos.clone().addScaledVector(car.fwd, 5); fov = 60 + 26 * s; smooth = 0.12; break;
      }
      case "mount": pos = at(v.o); target = at(v.l); up = car.up.clone(); fov = Math.min(150, v.fov + (PT.cfg.goproFov || 0) + (PT.goproFovBoost?.() || 0)); chase = false; break;
      case "ghost": {
        const g0 = ghostNear(car), g = g0 && (PT.livePose?.(g0, T) ?? g0);
        if (!g) { idx = 0; return prevHook ? prevHook(gameCam, T) : null; }
        const gat = (o) => g.pos.clone().addScaledVector(g.right, o[0]).addScaledVector(g.up, o[1]).addScaledVector(g.fwd, o[2]);
        pos = gat(v.o); target = gat(v.l); up = g.up.clone(); fov = Math.min(150, v.fov + (PT.cfg.goproFov || 0) + (PT.goproFovBoost?.() || 0)); chase = false; break;
      }
    }
    if (chase) pos = unblock(T, car.pos, pos);
    cur = !cur || smooth === 0 ? pos : cur.lerp(pos, k(smooth));
    look = !look || smooth === 0 ? target : look.lerp(target, k(Math.max(0.05, smooth * 0.6)));
    if (!cur || PT.camCut) PT.camCut = true;
    cam.fov = fov; cam.up.copy(up); cam.position.copy(cur); cam.lookAt(look);
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    return cam;
  };
})();
// ptfx holo hud: replaces the game's flat racing bar (checkpoints, timers, speed) with a whitish holographic
// visor (bare glowing type, no boxes). the side groups angle in towards you and sit higher than the centre (a curved visor, not a flat
// strip), and the whole rig floats on a spring driven by the car: it swings against cornering force, dips
// under braking, leans back on throttle and gets knocked by impacts (Asphalt-ish, but subtle).
// the game's own hud stays in the dom (just invisible) so the game keeps updating it; values are read from it.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;
  PT.defaults({ holoHud: true, hudMotion: 1, hudScale: 1 });

  const CSS = `
body.ptfx-holo .game-ui .checkpoint-ui, body.ptfx-holo .game-ui .speedometer-ui, body.ptfx-holo .game-ui .timer-ui { opacity: 0 !important; pointer-events: none !important; }
/* the game's other in-race bits, restyled to match: dark tinted glass + glowing white type */
body.ptfx-holo .game-ui .game-toolbar-ui .button-container, body.ptfx-holo .game-ui .game-toolbar-ui .info-container {
  background: rgba(8, 16, 30, .4) !important; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
body.ptfx-holo .game-ui .game-toolbar-ui .content { background: rgba(205, 232, 255, .06) !important; }
body.ptfx-holo .game-ui .game-toolbar-ui .button { background: rgba(205, 232, 255, .08) !important; color: #eef8ff !important;
  text-shadow: 0 0 6px rgba(150, 215, 255, .55); transition: background-color 150ms ease-out; }
body.ptfx-holo .game-ui .game-toolbar-ui .button:hover { background: rgba(205, 232, 255, .18) !important; }
body.ptfx-holo .game-ui .game-toolbar-ui .button img { filter: drop-shadow(0 0 4px rgba(150, 215, 255, .6)); }
body.ptfx-holo .game-ui .game-toolbar-ui .content > div { color: #eef8ff !important; text-shadow: 0 0 6px rgba(150, 215, 255, .45); }
body.ptfx-holo .game-ui .game-toolbar-ui .record { opacity: .6; }
body.ptfx-holo .game-ui .hint-ui { background: rgba(8, 16, 30, .45) !important; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  border: 1px solid rgba(215, 238, 255, .18); text-shadow: 0 0 8px rgba(150, 215, 255, .5); }
body.ptfx-holo .game-ui .hint-ui .key-binding { background: rgba(205, 232, 255, .12) !important; border: 1px solid rgba(215, 238, 255, .3); }
/* menus: a touch darker and less saturated, closer to the mod's night vibe */
body.ptfx-holo #ui > :not(.game-ui) { filter: brightness(.8) saturate(.85) contrast(1.08); }
#ptfx-hud { position: fixed; inset: 0; pointer-events: none; z-index: 5; perspective: 70vmin; perspective-origin: 50% 40%;
  --u: calc(min(0.78vw, 1.35vh) * var(--hs, 1)); --ink: #eef8ff; --glow: rgba(150, 215, 255, .55); --line: rgba(215, 238, 255, .32);
  font-family: ForcedSquare, Arial, sans-serif; color: var(--ink); opacity: 0; transition: opacity 220ms ease-out; }
#ptfx-hud.on { opacity: 1; }
#ptfx-hud .rig { position: absolute; inset: 0; transform-style: preserve-3d; will-change: transform; }
#ptfx-hud .pan { position: absolute; bottom: calc(var(--u) * 1.4); transform-style: preserve-3d; }
#ptfx-hud .glow { text-shadow: 0 0 calc(var(--u) * .5) var(--glow), 0 0 calc(var(--u) * 1.6) rgba(120, 200, 255, .25), 0 calc(var(--u) * .1) calc(var(--u) * .5) rgba(0, 8, 20, .55); }
#ptfx-hud .lbl { text-shadow: 0 0 calc(var(--u) * .4) rgba(0, 8, 20, .7); }
#ptfx-hud .lbl { font-size: calc(var(--u) * .78); letter-spacing: .22em; text-transform: uppercase; opacity: .62; }
#ptfx-hud .it { display: inline-block; transform: skewX(-8deg); }
/* centre: timer plate, leaning back like a dash read-out */
#ptfx-hud .mid { left: 50%; transform: translateX(-50%) rotateX(16deg); transform-origin: 50% 100%; text-align: center; min-width: calc(var(--u) * 30); }
#ptfx-hud .cur { font-size: calc(var(--u) * 3.6); line-height: 1; letter-spacing: .04em; font-variant-numeric: tabular-nums; }
#ptfx-hud .row { display: flex; justify-content: space-between; gap: calc(var(--u) * 2.4); margin-top: calc(var(--u) * .55); }
#ptfx-hud .row > div { display: flex; flex-direction: column; gap: calc(var(--u) * .15); }
#ptfx-hud .row > div:last-child { align-items: flex-end; }
#ptfx-hud .sm { font-size: calc(var(--u) * 1.35); font-variant-numeric: tabular-nums; }
#ptfx-hud .diff.green { color: #b9ffd9; --glow: rgba(110, 255, 180, .6); }
#ptfx-hud .diff.red { color: #ffc4cf; --glow: rgba(255, 110, 140, .6); }
#ptfx-hud .split { position: absolute; left: 50%; bottom: calc(100% + var(--u) * .8); transform: translateX(-50%); font-size: calc(var(--u) * 1.6);
  opacity: 0; transition: opacity 180ms ease-out, transform 180ms ease-out; white-space: nowrap; }
#ptfx-hud .split.show { opacity: 1; transform: translateX(-50%) translateY(calc(var(--u) * -.3)); }
#ptfx-hud .split.green { color: #b9ffd9; } #ptfx-hud .split.red { color: #ffc4cf; }
/* sides: higher than the centre and angled in, so the visor curves up towards the edges */
#ptfx-hud .lft { left: calc(var(--u) * 3); bottom: calc(var(--u) * 2.6); transform: rotateY(24deg) rotateZ(-3deg); transform-origin: 0% 100%; }
#ptfx-hud .rgt { right: calc(var(--u) * 3); bottom: calc(var(--u) * 2.6); transform: rotateY(-24deg) rotateZ(3deg); transform-origin: 100% 100%; text-align: right; }
#ptfx-hud .cp { font-size: calc(var(--u) * 2.6); line-height: 1; }
#ptfx-hud .pips { display: flex; gap: calc(var(--u) * .3); margin-top: calc(var(--u) * .6); }
#ptfx-hud .pip { width: calc(var(--u) * 1.1); height: calc(var(--u) * .35); border: 1px solid var(--line); transform: skewX(-20deg); transition: background-color 200ms ease-out, box-shadow 200ms ease-out; }
#ptfx-hud .pip.on { background: var(--ink); box-shadow: 0 0 calc(var(--u) * .6) var(--glow); }
#ptfx-hud .spd { font-size: calc(var(--u) * 4.4); line-height: .95; font-variant-numeric: tabular-nums; }
#ptfx-hud .unit { font-size: calc(var(--u) * .95); letter-spacing: .2em; opacity: .65; margin-left: calc(var(--u) * .4); }
`;

  let root = null, el = {}, last = {}, splitT = 0;

  function build() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement("div"); root.id = "ptfx-hud";
    root.innerHTML = `<div class="rig">
      <div class="pan lft"><div class="lbl">checkpoint</div><div class="cp glow it" data-k="cp">0/0</div><div class="pips" data-k="pips"></div></div>
      <div class="pan mid">
        <div class="split glow it" data-k="split"></div>
        <div class="lbl">current</div><div class="cur glow it" data-k="cur">00:00.000</div>
        <div class="row"><div><span class="lbl">record</span><span class="sm glow it" data-k="rec">---</span></div>
          <div><span class="lbl">difference</span><span class="sm glow it diff" data-k="diff">---</span></div></div>
      </div>
      <div class="pan rgt">
        <div><span class="spd glow it" data-k="spd">0</span><span class="unit">km/h</span></div>
      </div></div>`;
    document.body.appendChild(root);
    for (const n of root.querySelectorAll("[data-k]")) el[n.dataset.k] = n;
    el.rig = root.querySelector(".rig");
  }

  const txt = (q) => document.querySelector(q)?.textContent.trim() ?? "";
  function set(k, v) { if (last[k] !== v) { last[k] = v; el[k].textContent = v; } }

  // spring state for the floating rig
  const sp = { x: 0, y: 0, ry: 0, rx: 0, rz: 0, vx: 0, vy: 0, vry: 0, vrx: 0, vrz: 0 };
  let prevVel = null, aS = [0, 0, 0], lastT = performance.now();

  function motion(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    const car = PT.playerCar, m = cfg.hudMotion;
    let ax = 0, ay = 0, af = 0;
    if (car && performance.now() - car.at < 300 && prevVel && dt > 0) {
      const a = car.vel.clone().sub(prevVel).divideScalar(dt);
      if (a.length() < 400) { ax = a.dot(car.right); ay = a.dot(car.up); af = a.dot(car.fwd); }
    }
    prevVel = car ? car.vel.clone() : null;
    // velocity is noisy frame to frame (physics ticks vs frames): smooth the acceleration before using it
    const k = 1 - Math.exp(-dt / 0.12);
    aS[0] += (ax - aS[0]) * k; aS[1] += (ay - aS[1]) * k; aS[2] += (af - aS[2]) * k;
    const cl = (v, l) => Math.max(-l, Math.min(l, v));
    // targets: lags against the push (cornering right → hud swings left), dips + tilts forward on braking
    const tgt = { x: cl(-aS[0] * 0.22, 3.2) * m, y: cl(aS[2] * 0.06 - aS[1] * 0.05, 1.6) * m,
                  ry: cl(-aS[0] * 0.18, 4) * m, rx: cl(-aS[2] * 0.09, 3) * m, rz: cl(aS[0] * 0.07, 1.8) * m };
    // impacts (speedfx trauma) knock it
    const tr = (PT.trauma || 0) * m;
    for (const key of ["x", "y", "ry", "rx", "rz"]) {
      const v = "v" + key;
      sp[v] += ((tgt[key] - sp[key]) * 90 - sp[v] * 11) * dt;   // stiff, a touch underdamped
      sp[key] += sp[v] * dt;
    }
    const jit = tr > 0.01 ? Math.sin(now * 0.061) * tr * 0.9 : 0;
    // x/y in hud units (vmin-ish), rotations in degrees
    el.rig.style.transform = `translate3d(${(sp.x + jit).toFixed(3)}vmin, ${(sp.y - jit * 0.6).toFixed(3)}vmin, 0) ` +
      `rotateX(${sp.rx.toFixed(3)}deg) rotateY(${sp.ry.toFixed(3)}deg) rotateZ(${(sp.rz + jit * 0.8).toFixed(3)}deg)`;
  }

  function tick(now) {
    requestAnimationFrame(tick);
    const want = cfg.enabled !== false && cfg.holoHud;
    document.body.classList.toggle("ptfx-holo", !!want);
    const timer = document.querySelector(".game-ui .timer-ui");
    // visible only while racing (game hud present), not in photo mode or cinematic shots
    const show = want && timer && timer.offsetParent !== null && !document.body.classList.contains("ptfx-photo") && !PT.cineActive;
    if (!root) { if (!show) return; build(); }
    root.classList.toggle("on", !!show);
    if (!show) return;
    root.style.setProperty("--hs", cfg.hudScale);

    // checkpoints "2/6" + pips
    const cp = txt(".game-ui .checkpoint-ui span");
    set("cp", cp || "0/0");
    if (last.pipsFor !== cp) {
      last.pipsFor = cp;
      const [a, b] = cp.split("/").map((x) => parseInt(x, 10) || 0);
      el.pips.innerHTML = Array.from({ length: Math.min(b, 24) }, (_, i) => `<div class="pip${i < a ? " on" : ""}"></div>`).join("");
    }
    set("spd", txt(".game-ui .speedometer-ui .container > span:first-child") || "0");
    set("cur", txt(".game-ui .timer-ui .center .time p") || "--:--.---");
    set("rec", txt(".game-ui .timer-ui .left .time p") || "---");
    const dp = document.querySelector(".game-ui .timer-ui .right .time p");
    set("diff", dp?.textContent.trim() || "---");
    const dc = dp?.classList.contains("green") ? "green" : dp?.classList.contains("red") ? "red" : "";
    if (last.dc !== dc) { last.dc = dc; el.diff.className = "sm glow it diff " + dc; }
    // checkpoint split: the game fills .checkpoint-time briefly when you cross one
    const split = txt(".game-ui .timer-ui .center .checkpoint-time") || txt(".game-ui .timer-ui .right .checkpoint-time");
    if (split && split !== last.split) { set("split", split); splitT = now + 2200; const c = /^-/.test(split) ? "green" : /^\+/.test(split) ? "red" : ""; el.split.className = "split glow it show " + c; }
    if (!split) last.split = "";
    if (splitT && now > splitT) { splitT = 0; el.split.classList.remove("show"); }
    motion(now);
  }
  requestAnimationFrame(tick);
})();
// ptfx settings panel. F9 toggles it. keyboard-opened and used constantly, so it appears instantly:
// no open/close animation. styled after polytrack's own ui (navy panels, ForcedSquare, square corners).
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const cfg = PT.cfg;

  const fmtTime = (h) => { const m = Math.round(h * 60) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  const pct = (v) => Math.round(v * 100) + "%";
  const fix = (n) => (v) => (+v).toFixed(n);

  // [category, [key, label, kind, min, max, step, format]]; ["", "heading", "sub"] starts a sub-group
  const LAYOUT = [
    ["time & sky", [
      ["timeOfDay", "time of day", "range", 0, 24, 0.05, fmtTime],
      ["sunTurn", "sun direction", "range", -180, 180, 1, (v) => (+v === 0 ? "track" : (v > 0 ? "+" : "") + v + "°")],
      ["dayCycle", "day cycle", "toggle"],
      ["dayMinutes", "cycle length", "range", 1, 60, 1, (v) => v + " min"],
    ]],
    ["weather", [
      ["weather", "", "choice", ["clear", "cloudy", "overcast", "rain", "storm", "hail", "fog"]],
      ["weatherIntensity", "intensity", "range", 0, 1.5, 0.05, pct],
      ["wind", "wind", "range", -1.5, 1.5, 0.05, fix(2)],
      ["fogAmount", "fog", "range", 0, 3, 0.05, pct],
      ["lightning", "lightning (storm)", "toggle"],
      ["", "rain", "sub"],
      ["rainDensity", "density", "range", 0, 1, 0.05, pct],
      ["rainBrightness", "brightness", "range", 0, 3, 0.05, pct],
      ["lensDrops", "drops on lens", "toggle"],
      ["lensAmount", "lens drop amount", "range", 0, 2, 0.05, pct],
      ["", "wet track", "sub"],
      ["puddles", "wetness / puddles", "range", 0, 1.5, 0.05, pct],
      ["reflections", "reflections", "toggle"],
      ["trackSheen", "dry track sheen", "range", 0, 1, 0.05, pct],
    ]],
    ["car lights", [
      ["headlights", "headlights", "toggle"],
      ["hlAuto", "auto (night, rain, tunnels)", "toggle"],
      ["hlManual", "manual on  ·  E / ?", "toggle"],
      ["hlPower", "power", "range", 0, 3, 0.05, pct],
      ["hlRange", "reach", "range", 40, 600, 10, (v) => v + " m"],
      ["hlLift", "flat-road fill", "range", 0, 1, 0.05, pct],
      ["hlWarmth", "beam warmth", "range", 0, 1, 0.05, pct],
      ["", "led + brake", "sub"],
      ["hlLeds", "led strip", "toggle"],
      ["ledPower", "led brightness", "range", 0, 3, 0.05, pct],
      ["brakeLights", "tail + brake lights", "toggle"],
      ["brakePower", "brake strip brightness", "range", 0, 3, 0.05, pct],
      ["tailPool", "red glow on ground", "range", 0, 3, 0.05, pct],
      ["", "ghosts", "sub"],
      ["ghostLights", "ghost car lights", "toggle"],
      ["ghostPower", "ghost light power", "range", 0, 1, 0.05, pct],
    ]],
    ["light & shadow", [
      ["occlusion", "baked track lighting", "toggle"],
      ["sunShadows", "whole-track sun shadows", "range", 0, 1, 0.05, pct],
      ["skyOcclusion", "dark tunnels / covered areas", "range", 0, 1, 0.05, pct],
      ["eyeAdapt", "eye adaptation", "range", 0, 2, 0.05, pct],
      ["", "god rays", "sub"],
      ["godRays", "volumetric light", "toggle"],
      ["godRayStrength", "strength", "range", 0, 3, 0.05, pct],
      ["", "ambient occlusion", "sub"],
      ["ao", "ambient occlusion", "toggle"],
      ["aoStrength", "strength", "range", 0, 1.5, 0.05, pct],
      ["aoRadius", "radius", "range", 0.3, 4, 0.1, (v) => (+v).toFixed(1) + " m"],
    ]],
    ["night glow", [
      ["edgeGlow", "glowing kerbs, arrows, signs", "toggle"],
      ["edgeGlowAlways", "glow all day (default 18-06)", "toggle"],
      ["edgeGlowPower", "glow", "range", 0, 3, 0.05, pct],
      ["glowSpill", "glow onto track", "range", 0, 2, 0.05, pct],
    ]],
    ["camera", [
      ["motionBlur", "motion blur", "range", 0, 1.5, 0.05, pct],
      ["speedFov", "fov kick at speed", "range", 0, 2, 0.05, pct],
      ["", "gopro cams", "sub"],
      ["speedShake", "shake at speed", "range", 0, 3, 0.05, pct],
      ["impactShake", "impact shake (landings, hits)", "range", 0, 3, 0.05, pct],
      ["goproLens", "lens effects (experimental)", "toggle"],
      ["goproFisheye", "fisheye", "range", 0, 1, 0.01, pct],
      ["goproRes", "fisheye sharpness (render res)", "range", 1, 1.6, 0.05, (v) => Math.round(v * 100) + "%"],
      ["goproFov", "field of view", "range", -30, 30, 1, (v) => (v > 0 ? "+" : "") + v + "°"],
      ["goproEdgeBlur", "edge blur", "range", 0, 2, 0.05, pct],
      ["goproAberration", "chromatic aberration", "range", 0, 3, 0.05, pct],
    ]],
    ["hud", [
      ["holoHud", "holo racing hud", "toggle"],
      ["hudMotion", "reacts to car movement", "range", 0, 2, 0.05, pct],
      ["hudScale", "size", "range", 0.7, 1.4, 0.05, pct],
    ]],
    ["image", [
      ["tone", "filmic tonemap", "range", 0, 1, 0.05, pct],
      ["exposure", "exposure", "range", 0.3, 3, 0.05, fix(2)],
      ["contrast", "contrast", "range", 0.7, 1.5, 0.01, fix(2)],
      ["saturation", "saturation", "range", 0, 2, 0.01, fix(2)],
      ["vignette", "vignette", "range", 0, 1, 0.01, pct],
      ["", "bloom", "sub"],
      ["bloom", "bloom", "toggle"],
      ["bloomIntensity", "intensity", "range", 0, 1.5, 0.01, pct],
      ["bloomThreshold", "threshold", "range", 0.2, 3, 0.05, fix(2)],
      ["bloomRadius", "radius", "range", 0.2, 1.5, 0.05, fix(2)],
    ]],
    ["cinematic  ·  K", [
      ["cinematic", "", "choice", ["off", "auto", "on"]],
      ["cineShotLen", "shot length", "range", 3, 15, 0.5, (v) => (+v).toFixed(1) + " s"],
    ]],
    ["photo  ·  P", [
      ["photoRes", "", "choice", ["1080p", "1440p", "4k", "5k"]],
      ["photoMax", "max settings for photos", "toggle"],
    ]],
    ["performance", [
      ["quality", "", "choice", ["low", "medium", "high", "ultra"]],
      ["renderScale", "render scale", "range", 0.4, 1, 0.05, pct],
      ["sharpen", "upscale sharpening", "range", 0, 1, 0.05, pct],
      ["fpsCap", "fps cap (0 = off)", "range", 0, 120, 10, (v) => (v ? v + " fps" : "off")],
      ["ssrSteps", "reflection quality", "range", 8, 32, 1, (v) => v + " steps"],
    ]],
  ];

  // which categories are expanded: a per-viewer convenience, so plain localStorage
  const OPEN_KEY = "ptfx.panel.open";
  let openSet;
  try { openSet = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "null") || ["time & sky", "weather"]); } catch { openSet = new Set(["time & sky", "weather"]); }
  const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...openSet])); } catch {} };

  const CSS = `
#ptfx-panel{--bg:rgba(7,9,16,.9);--line:rgba(130,150,255,.16);--acc:#7c8cff;--acc2:#3fd6ff;--txt:#d5dbf2;--dim:#6f7aa6;
  position:fixed;top:12px;right:12px;width:304px;max-height:calc(100vh - 24px);overflow-y:auto;z-index:2147483647;scrollbar-width:thin;scrollbar-color:#2a3260 transparent;
  font-family:ForcedSquare,Arial,sans-serif;color:var(--txt);background:var(--bg);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);
  border:1px solid var(--line);box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 18px 50px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.5);padding:0 0 10px;user-select:none;cursor:default;display:none}
#ptfx-panel.open{display:block}
#ptfx-panel *{box-sizing:border-box}
#ptfx-panel header{display:flex;align-items:center;gap:8px;padding:13px 14px 11px;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1;
  background:radial-gradient(rgba(130,150,255,.13) 1px,transparent 1.4px) 0 0/9px 9px,rgba(5,7,13,.97)}
#ptfx-panel header::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,var(--acc),var(--acc2) 55%,transparent)}
#ptfx-panel header>div{flex:1}
#ptfx-panel h1{margin:0;font-size:17px;font-weight:400;letter-spacing:.16em;text-transform:uppercase;color:#fff}
#ptfx-panel h1 b{font-weight:400;color:var(--acc2);text-shadow:0 0 12px rgba(63,214,255,.55)}
#ptfx-panel .hint{font-size:11px;color:var(--dim);letter-spacing:.04em}
#ptfx-panel .help{width:22px;height:22px;font:inherit;font-size:13px;color:var(--acc2);background:rgba(63,214,255,.07);border:1px solid rgba(63,214,255,.35);cursor:pointer;padding:0;
  transition:transform 140ms cubic-bezier(.23,1,.32,1),background-color 140ms ease}
#ptfx-panel .help:active{transform:scale(.94)}
@media (hover:hover) and (pointer:fine){#ptfx-panel .help:hover{background:rgba(63,214,255,.16)}}
#ptfx-panel section{border-bottom:1px solid rgba(130,150,255,.09)}
#ptfx-panel .cat{display:flex;align-items:center;justify-content:space-between;width:100%;padding:11px 14px;font:inherit;font-size:12px;letter-spacing:.14em;
  text-transform:uppercase;color:#8e9bd6;background:none;border:0;cursor:pointer;text-align:left;transition:color 140ms ease,background-color 140ms ease}
@media (hover:hover) and (pointer:fine){#ptfx-panel .cat:hover{background:rgba(124,140,255,.07);color:#c3cdff}}
#ptfx-panel section.open .cat{color:#fff;box-shadow:2px 0 0 var(--acc2) inset}
#ptfx-panel .cat i{width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);
  transition:transform 200ms cubic-bezier(.23,1,.32,1)}
#ptfx-panel section.open .cat i{transform:rotate(45deg)}
#ptfx-panel .body{display:grid;grid-template-rows:0fr;transition:grid-template-rows 200ms cubic-bezier(.23,1,.32,1)}
#ptfx-panel section.open .body{grid-template-rows:1fr}
#ptfx-panel .inner{overflow:hidden;padding:0 14px}
#ptfx-panel section.open .inner{padding-bottom:8px}
#ptfx-panel h3{margin:10px 0 2px;font-size:10px;font-weight:400;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
@media (prefers-reduced-motion:reduce){#ptfx-panel .body,#ptfx-panel .cat i{transition:none}}
#ptfx-panel .row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px 10px;padding:5px 0}
#ptfx-panel .row label{font-size:13px;color:var(--txt)}
#ptfx-panel .val{font-size:12px;color:var(--acc2);font-variant-numeric:tabular-nums;min-width:52px;text-align:right}
#ptfx-panel input[type=range]{grid-column:1/-1;-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent;margin:0;cursor:pointer}
#ptfx-panel input[type=range]::-webkit-slider-runnable-track{height:3px;background:linear-gradient(90deg,var(--acc),var(--acc2) var(--p),rgba(255,255,255,.09) var(--p))}
#ptfx-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:16px;margin-top:-6.5px;background:#eaf6ff;border:0;
  box-shadow:0 0 0 1px rgba(0,0,0,.5),0 0 10px rgba(63,214,255,.45);transition:transform 120ms cubic-bezier(.23,1,.32,1)}
#ptfx-panel input[type=range]:active::-webkit-slider-thumb{transform:scaleX(.8)}
#ptfx-panel input[type=range]:focus{outline:none}
#ptfx-panel input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px var(--acc2)}
#ptfx-panel .tog{width:38px;height:20px;padding:2px;border:1px solid rgba(130,150,255,.3);background:rgba(255,255,255,.04);cursor:pointer;
  transition:background-color 160ms ease,border-color 160ms ease,box-shadow 160ms ease}
#ptfx-panel .tog i{display:block;width:14px;height:14px;background:#5b678f;transition:transform 160ms cubic-bezier(.23,1,.32,1),background-color 160ms ease}
#ptfx-panel .tog[aria-checked=true]{background:linear-gradient(90deg,rgba(124,140,255,.5),rgba(63,214,255,.45));border-color:var(--acc2);box-shadow:0 0 12px rgba(63,214,255,.25)}
#ptfx-panel .tog[aria-checked=true] i{transform:translateX(18px);background:#fff}
#ptfx-panel .tog:active{transform:scale(.96)}
#ptfx-panel .master{margin:0}
#ptfx-panel footer{display:flex;gap:8px;padding:12px 14px 0}
#ptfx-panel button.btn{flex:1;font:inherit;font-size:12px;letter-spacing:.06em;color:var(--txt);background:rgba(124,140,255,.07);border:1px solid rgba(130,150,255,.28);
  padding:7px 0;cursor:pointer;transition:transform 140ms cubic-bezier(.23,1,.32,1),background-color 140ms ease}
#ptfx-panel button.btn:active{transform:scale(.97)}
@media (hover:hover) and (pointer:fine){#ptfx-panel button.btn:hover{background:rgba(124,140,255,.16)}}
#ptfx-panel .row.choice{display:block}
#ptfx-panel .seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
#ptfx-panel .seg button{font:inherit;font-size:12px;color:#aab4dd;background:rgba(255,255,255,.035);border:1px solid rgba(130,150,255,.18);padding:6px 0;cursor:pointer;
  transition:transform 140ms cubic-bezier(.23,1,.32,1),background-color 140ms ease,border-color 140ms ease,color 140ms ease}
#ptfx-panel .seg button:active{transform:scale(.97)}
#ptfx-panel .seg button[aria-pressed=true]{background:linear-gradient(180deg,rgba(124,140,255,.38),rgba(63,214,255,.2));border-color:var(--acc2);color:#fff}
#ptfx-panel.off section{opacity:.35;pointer-events:none}
`;

  function toggle(key, onChange) {
    const b = document.createElement("button");
    b.className = "tog"; b.setAttribute("role", "switch"); b.innerHTML = "<i></i>";
    const sync = () => b.setAttribute("aria-checked", String(!!cfg[key]));
    b.onclick = () => { cfg[key] = !cfg[key]; sync(); PT.save(); onChange?.(); b.blur(); };
    sync(); b._sync = sync;
    return b;
  }

  let panel = null;
  const syncers = [];

  function build() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    panel = document.createElement("div"); panel.id = "ptfx-panel";
    const head = document.createElement("header");
    head.innerHTML = `<div><h1><b>FX</b> mod</h1><div class="hint">unofficial · F9 to close</div></div>`;
    const master = toggle("enabled", () => panel.classList.toggle("off", cfg.enabled === false));
    master.classList.add("master"); master.title = "all effects";
    const hb = document.createElement("button"); hb.className = "help"; hb.textContent = "?"; hb.title = "controls & about  ·  H";
    hb.onclick = () => { PT.intro?.open(); hb.blur(); };
    head.appendChild(hb);
    head.appendChild(master); syncers.push(master._sync);
    panel.appendChild(head);
    panel.classList.toggle("off", cfg.enabled === false);

    for (const [title, rows] of LAYOUT) {
      const sec = document.createElement("section");
      const head = document.createElement("button"); head.className = "cat"; head.innerHTML = `<span>${title}</span><i></i>`;
      const body = document.createElement("div"); body.className = "body";
      const inner = document.createElement("div"); inner.className = "inner";
      body.appendChild(inner); sec.appendChild(head); sec.appendChild(body);
      sec.classList.toggle("open", openSet.has(title));
      head.setAttribute("aria-expanded", String(openSet.has(title)));
      head.onclick = () => {
        const open = !sec.classList.contains("open");
        sec.classList.toggle("open", open); head.setAttribute("aria-expanded", String(open));
        open ? openSet.add(title) : openSet.delete(title); saveOpen(); head.blur();
      };
      for (const [key, label, kind, min, max, step, fmt] of rows) {
        if (kind === "sub") { const h = document.createElement("h3"); h.textContent = label; inner.appendChild(h); continue; }
        const row = document.createElement("div"); row.className = "row";
        const lab = document.createElement("label"); lab.textContent = label; row.appendChild(lab);
        if (kind === "toggle") { const t = toggle(key); row.appendChild(t); syncers.push(t._sync); }
        else if (kind === "choice") {
          row.classList.add("choice"); lab.remove();
          const opts = min, seg = document.createElement("div"); seg.className = "seg";
          const btns = opts.map((o) => {
            const b = document.createElement("button"); b.textContent = o;
            b.onclick = () => { if (key === "quality") PT.applyQuality(o); else { cfg[key] = o; sync(); PT.save(); } b.blur(); };
            seg.appendChild(b); return b;
          });
          const sync = () => btns.forEach((b, i) => b.setAttribute("aria-pressed", String(cfg[key] === opts[i])));
          sync(); syncers.push(sync); row.appendChild(seg);
        }
        else {
          const val = document.createElement("span"); val.className = "val"; row.appendChild(val);
          const r = document.createElement("input");
          Object.assign(r, { type: "range", min, max, step });
          const sync = () => {
            const v = +(cfg[key] ?? min);
            r.value = v; val.textContent = fmt(v);
            r.style.setProperty("--p", ((v - min) / (max - min)) * 100 + "%");
          };
          r.oninput = () => { cfg[key] = +r.value; sync(); PT.save(); };
          r.onchange = () => r.blur();   // arrow keys must go back to driving
          sync(); syncers.push(sync);
          row.appendChild(r);
        }
        inner.appendChild(row);
      }
      panel.appendChild(sec);
    }

    const foot = document.createElement("footer");
    const reset = document.createElement("button"); reset.className = "btn"; reset.textContent = "reset all";
    reset.onclick = () => PT.resetSettings();
    const copy = document.createElement("button"); copy.className = "btn"; copy.textContent = "copy settings";
    copy.onclick = async () => {
      const txt = JSON.stringify(cfg);
      try { await navigator.clipboard.writeText(txt); } catch { const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy settings"), 1200);
    };
    foot.appendChild(copy); foot.appendChild(reset); panel.appendChild(foot);

    // keep the game from reacting to clicks and drags on the panel
    for (const ev of ["mousedown", "mouseup", "click", "pointerdown", "pointerup", "wheel", "contextmenu"])
      panel.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(panel);
  }

  function setOpen(open) {
    if (!panel) build();
    panel.classList.toggle("open", open);
    if (open) for (const s of syncers) s();   // day cycle etc. may have moved values
  }

  window.addEventListener("keydown", (e) => {
    if (e.code !== "F9" || e.repeat) return;
    e.preventDefault(); e.stopPropagation();
    setOpen(!(panel && panel.classList.contains("open")));
  }, true);

  // live readouts while open (time of day moves under the day cycle)
  setInterval(() => { if (panel?.classList.contains("open") && cfg.dayCycle) for (const s of syncers) s(); }, 500);
  PT.onReset = () => { for (const s of syncers) s(); panel?.classList.toggle("off", cfg.enabled === false); };
  PT.panel = { open: () => setOpen(true), close: () => setOpen(false) };
})();
// ptfx photo: shift+P takes an instant photo (P opens photo mode, 96-photomode.js) (the game's own pause stays on Space). the frame is re-rendered off-screen
// at photo resolution with max (or current) settings, saved as a PNG to ~/Pictures/PolyTrack FX, and
// gameplay continues at its own settings. the HUD is html over the canvas, so photos come out clean.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  PT.defaults({ photoMax: true, photoRes: "4k" });

  let toast = null, toastT = 0;
  function say(msg) {
    if (!toast) {
      toast = document.createElement("div");
      toast.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:9px 16px;" +
        "font:13px ForcedSquare,Arial,sans-serif;color:#fff;background:rgba(7,9,16,.9);border:1px solid rgba(120,150,255,.35);" +
        "pointer-events:none;transition:opacity 200ms ease-out";
      document.body.appendChild(toast);
    }
    toast.textContent = msg; toast.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => (toast.style.opacity = "0"), 1800);
  }

  PT.photoSay = (m) => say(m);
  PT.onPhoto = (buf, w, h) => {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d"), img = g.createImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);   // gl rows are bottom-up
    g.putImageData(img, 0, 0);
    cv.toBlob((blob) => {
      const d = new Date(), p = (n) => String(n).padStart(2, "0");
      const name = `polytrack-fx-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      PT.lastPhoto = name;
      // also on the clipboard, ready to paste
      let copied = false;
      try { navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => { copied = true; say(`photo saved + copied · ${w}×${h}`); }).catch(() => {}); } catch {}
      say(`photo saved · ${w}×${h} · Pictures/PolyTrack FX`);
    }, "image/png");
  };

  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
  for (const type of ["keydown", "keyup"]) {
    window.addEventListener(type, (e) => {
      if (e.code !== "KeyP" || typing(e)) return;
      e.stopImmediatePropagation(); e.preventDefault();     // keep the game from pausing on P
      if (type !== "keydown" || e.repeat) return;
      if (e.shiftKey || !PT.photoMode) { if (e.shiftKey) { PT.requestPhoto(); say("taking photo…"); } else PT.photoMode?.toggle(); }
      else PT.photoMode.toggle();
    }, true);
  }
})();
// ptfx photo mode (forza-style, first pass). P pauses the game (a trusted Space press through the
// electron bridge, the game's own pause) and detaches a free camera from wherever the view was.
// WASD move, Q/E down/up, drag to look, wheel = fov, Z/X roll, shift = faster, Enter = capture,
// P or Esc = back to the race. the game's html (hud, pause menu) is hidden while composing.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  let passSpace = 0;   // our own bridge Space presses arrive after `on` flips: let exactly those through
  let orbit = false, oDist = 7, oYaw = 0, oPitch = 0.25, oCenter = null, oLift = 0;
  let on = false, cam = null, yaw = 0, pitch = 0, roll = 0, fov = 60, keys = new Set(), lastT = 0, help = null, style = null;

  function hideUI(hide) {
    if (!style) {
      style = document.createElement("style");
      style.textContent = "body.ptfx-photo > *:not(canvas):not(#ptfx-panel):not(.ptfx-keep){visibility:hidden !important}";
      document.head.appendChild(style);
    }
    document.body.classList.toggle("ptfx-photo", hide);
    if (!help) {
      help = document.createElement("div"); help.className = "ptfx-keep";
      help.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;font:12px ForcedSquare,Arial,sans-serif;" +
        "color:#dfe6ff;background:rgba(7,9,16,.86);border:1px solid rgba(130,150,255,.3);pointer-events:none;white-space:nowrap";
      help.textContent = "photo mode · WASD move · Q/E down/up · drag look · wheel fov · Z/X roll · shift fast · Tab orbit car · Enter capture (+copy) · ⌫ delete last · O folder · P / Esc exit";
      document.body.appendChild(help);
    }
    help.style.display = hide ? "block" : "none";
  }

  function enter() {
    const src = PT.lastRenderCam || PT.gameCamera;
    if (!src || !PT.state.T) return;
    passSpace = 2; window.ptfxNative?.key("Space");  // the game's own pause (keydown + keyup)
    cam = src.clone();
    const e = new PT.state.T.Vector3(); const d = new PT.state.T.Vector3(0, 0, -1).applyQuaternion(src.quaternion);
    yaw = Math.atan2(-d.x, -d.z); pitch = Math.asin(Math.max(-1, Math.min(1, d.y))); roll = 0; fov = src.fov || 60;
    on = true; hideUI(true); lastT = performance.now();
  }
  function exit() {
    on = false; hideUI(false); keys.clear();
    passSpace = 2; window.ptfxNative?.key("Space");  // unpause
  }
  PT.photoMode = { toggle: () => (on ? exit() : enter()), get on() { return on; } };

  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && passSpace > 0) { passSpace--; return; }
    if (!on || typing(e)) return;
    if (e.code === "KeyP") return;                    // handled by 95-photo
    e.stopImmediatePropagation(); e.preventDefault(); // the paused game gets nothing while composing
    if (e.code === "Escape") return exit();
    if (e.code === "Enter" && !e.repeat) { PT.requestPhoto(); return; }
    if (e.code === "Backspace" && !e.repeat && PT.lastPhoto) { window.ptfxNative?.photoOp("delete", PT.lastPhoto); PT.photoSay?.("deleted " + PT.lastPhoto); PT.lastPhoto = null; return; }
    if (e.code === "KeyO" && !e.repeat) { window.ptfxNative?.photoOp("open"); return; }
    if (e.code === "Tab" && !e.repeat) {
      // orbit the car (where it was frozen) <-> free fly
      const car = PT.playerCar;
      orbit = !orbit && !!car;
      if (orbit) { oLift = 0; oCenter = car.pos.clone(); const d = cam.position.clone().sub(oCenter); oDist = Math.max(2, d.length()); oYaw = Math.atan2(d.x, d.z); oPitch = Math.asin(Math.max(-0.9, Math.min(0.9, d.y / oDist))); }
      PT.photoSay?.(orbit ? "photo mode · orbit car" : "photo mode · free camera"); return;
    }
    keys.add(e.code);
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && passSpace > 0) { passSpace--; return; }
    if (on) { keys.delete(e.code); e.stopImmediatePropagation(); } }, true);
  let drag = null;
  window.addEventListener("pointerdown", (e) => { if (on && !e.target.closest?.("#ptfx-panel")) { drag = [e.clientX, e.clientY]; e.stopImmediatePropagation(); } }, true);
  window.addEventListener("pointermove", (e) => {
    if (!on || !drag) return;
    if (orbit) { oYaw -= (e.clientX - drag[0]) * 0.006; oPitch = Math.max(-0.2, Math.min(1.45, oPitch + (e.clientY - drag[1]) * 0.005)); }
    else { yaw -= (e.clientX - drag[0]) * 0.004; pitch -= (e.clientY - drag[1]) * 0.004; }
    pitch = Math.max(-1.5, Math.min(1.5, pitch)); drag = [e.clientX, e.clientY];
  }, true);
  window.addEventListener("pointerup", () => (drag = null), true);
  window.addEventListener("wheel", (e) => { if (on && !e.target.closest?.("#ptfx-panel")) { fov = Math.max(8, Math.min(120, fov + e.deltaY * 0.03)); e.stopImmediatePropagation(); } }, { capture: true, passive: true });

  const prevHook = PT.cameraHook;
  PT.cameraHook = (gameCam, T) => {
    if (!on) { const c = prevHook ? prevHook(gameCam, T) : null; PT.lastRenderCam = c || gameCam; return c; }
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    cam.aspect = gameCam.aspect; cam.near = gameCam.near; cam.far = gameCam.far;
    const q = new T.Vector3(), f = new T.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const r = new T.Vector3().crossVectors(f, new T.Vector3(0, 1, 0)).normalize();
    const sp = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 25 : 6) * dt;
    if (keys.has("KeyW")) q.addScaledVector(f, sp); if (keys.has("KeyS")) q.addScaledVector(f, -sp);
    if (keys.has("KeyD")) q.addScaledVector(r, sp); if (keys.has("KeyA")) q.addScaledVector(r, -sp);
    if (keys.has("KeyE")) q.y += sp; if (keys.has("KeyQ")) q.y -= sp;
    if (keys.has("KeyZ")) roll += dt * 0.8; if (keys.has("KeyX")) roll -= dt * 0.8;
    if (orbit && oCenter) {
      const z = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 12 : 4) * dt;
      if (keys.has("KeyW")) oDist = Math.max(1.5, oDist - z); if (keys.has("KeyS")) oDist += z;
      if (keys.has("KeyE")) oLift += z * 0.5; if (keys.has("KeyQ")) oLift -= z * 0.5;
      // always orbit where the car is now (orbit stays on between photo sessions; the car won't be in the same spot)
      if (PT.playerCar) oCenter = PT.playerCar.pos.clone().add(new T.Vector3(0, oLift, 0));
      cam.position.set(oCenter.x + Math.sin(oYaw) * Math.cos(oPitch) * oDist, oCenter.y + Math.sin(oPitch) * oDist, oCenter.z + Math.cos(oYaw) * Math.cos(oPitch) * oDist);
      const fo = oCenter.clone().sub(cam.position).normalize();
      cam.up.set(0, 1, 0).applyAxisAngle(fo, roll);
      cam.fov = fov; cam.lookAt(oCenter);
      // keep free-fly continuous when switching back
      yaw = Math.atan2(-fo.x, -fo.z); pitch = Math.asin(Math.max(-1, Math.min(1, fo.y)));
    } else {
      cam.position.add(q);
      cam.up.set(0, 1, 0).applyAxisAngle(f, roll);
      cam.fov = fov; cam.lookAt(cam.position.clone().add(f));
    }
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    return cam;
  };
})();
// first-run intro card + keybind cheat sheet. shows once per browser (localStorage), H reopens it, the panel has a ? button.
// keyboard-opened things stay instant (no animation on H); the first-run card gets a short enter since it is rare.
(function () {
  const PT = (window.PTFXNS = window.PTFXNS || {});
  const KEY = "ptfx.intro.seen.v1";
  const native = !!window.ptfxNative;   // electron build: the photo folder keys exist, and photo mode can pause the race
  const KEYS = [
    ["F9", "effects panel: every slider and toggle"],
    ["H", "this screen"],
    ["C", "cycle camera views  (shift+C back)"],
    ["K", "cinematic cameras on / off"],
    ["E  or  /", "headlights on / off"],
    ["P", native ? "photo mode (pauses the race, free camera)" : "photo mode: free camera (Space pauses the race)"],
    ["shift+P", "instant photo" + (native ? "" : " (downloads a PNG)")],
  ];
  const CSS = `
#ptfx-intro{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;padding:16px;
  background:radial-gradient(ellipse at 50% 40%,rgba(10,14,30,.55),rgba(2,3,8,.88));-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);
  font-family:ForcedSquare,Arial,sans-serif;color:#d5dbf2;user-select:none}
#ptfx-intro.open{display:flex}
#ptfx-intro *{box-sizing:border-box}
#ptfx-intro .card{position:relative;width:min(560px,100%);max-height:calc(100vh - 32px);overflow-y:auto;padding:26px 28px 22px;scrollbar-width:thin;scrollbar-color:#2a3260 transparent;
  background:radial-gradient(rgba(130,150,255,.1) 1px,transparent 1.4px) 0 0/10px 10px,rgba(6,8,15,.96);border:1px solid rgba(130,150,255,.2);
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 30px 80px rgba(0,0,0,.7),0 0 60px rgba(90,110,255,.12)}
#ptfx-intro.anim .card{animation:ptfx-in 260ms cubic-bezier(.23,1,.32,1) both}
#ptfx-intro.anim .card>*{animation:ptfx-up 320ms cubic-bezier(.23,1,.32,1) both;animation-delay:calc(var(--i) * 45ms + 60ms)}
@keyframes ptfx-in{from{opacity:0;transform:scale(.97)}}
@keyframes ptfx-up{from{opacity:0;transform:translateY(8px)}}
#ptfx-intro .card::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,#7c8cff,#3fd6ff 60%,transparent)}
#ptfx-intro .tag{display:inline-block;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#3fd6ff;border:1px solid rgba(63,214,255,.4);padding:3px 8px;background:rgba(63,214,255,.07)}
#ptfx-intro h1{margin:12px 0 4px;font-size:30px;font-weight:400;letter-spacing:.14em;text-transform:uppercase;color:#fff;line-height:1.1}
#ptfx-intro h1 b{font-weight:400;color:#3fd6ff;text-shadow:0 0 18px rgba(63,214,255,.6)}
#ptfx-intro p{margin:8px 0 0;font-size:13px;line-height:1.55;color:#aeb8de}
#ptfx-intro p a{color:#8fdcff;text-decoration:underline;text-underline-offset:2px}
#ptfx-intro h2{margin:20px 0 6px;font-size:10px;font-weight:400;letter-spacing:.2em;text-transform:uppercase;color:#6f7aa6}
#ptfx-intro .keys{display:grid;grid-template-columns:auto 1fr;gap:0 16px}
#ptfx-intro .keys>*{padding:6px 0;border-bottom:1px solid rgba(130,150,255,.09);font-size:13px}
#ptfx-intro .keys kbd{margin:5px 0;font:inherit;font-size:12px;color:#fff;background:rgba(124,140,255,.14);border:1px solid rgba(130,150,255,.4);border-bottom-width:2px;padding:1px 7px;white-space:nowrap;align-self:start;justify-self:start}
#ptfx-intro .keys span{color:#aeb8de}
#ptfx-intro .go{margin-top:20px;display:flex;align-items:center;gap:12px}
#ptfx-intro button{font:inherit;font-size:14px;letter-spacing:.1em;text-transform:uppercase;color:#04060c;background:linear-gradient(90deg,#8d9bff,#4fdcff);border:0;padding:10px 22px;cursor:pointer;
  transition:transform 140ms cubic-bezier(.23,1,.32,1),filter 140ms ease}
#ptfx-intro button:active{transform:scale(.97)}
@media (hover:hover) and (pointer:fine){#ptfx-intro button:hover{filter:brightness(1.12)}}
#ptfx-intro .go small{font-size:11px;color:#6f7aa6}
#ptfx-intro .fine{margin-top:16px;font-size:11px;line-height:1.5;color:#5d688f}
@media (max-width:520px){#ptfx-intro .card{padding:20px 18px}#ptfx-intro h1{font-size:24px}}
@media (prefers-reduced-motion:reduce){#ptfx-intro.anim .card,#ptfx-intro.anim .card>*{animation:none}}
`;
  let el = null;
  const seen = () => { try { return !!localStorage.getItem(KEY); } catch { return false; } };
  const remember = () => { try { localStorage.setItem(KEY, "1"); } catch {} };

  function build() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    el = document.createElement("div"); el.id = "ptfx-intro";
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "FX mod: about and controls");
    const rows = KEYS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join("");
    el.innerHTML = `<div class="card">
      <div style="--i:0"><span class="tag">unofficial graphics update</span></div>
      <h1 style="--i:1">PolyTrack <b>FX</b></h1>
      <p style="--i:2">A community-made graphical mod for <b>PolyTrack</b>: day and night, weather and wet roads, headlights, bloom, god rays, ambient occlusion,
        cinematic cameras and photo mode. The game and everything in it belongs to <b>Kodub.com</b>. This mod is
        <b>unofficial and not affiliated with, endorsed by, or sponsored by Kodub.com, CrazyGames, Poki or itch.io</b>.
        Love the game? Play the real one: <a href="https://www.crazygames.com/game/polytrack" target="_blank" rel="noopener">crazygames.com/game/polytrack</a>.</p>
      <h2 style="--i:3">settings &amp; controls</h2>
      <div class="keys" style="--i:4">${rows}</div>
      <p style="--i:4">In photo mode: WASD move · Q/E down/up · drag to look · wheel zoom · Tab orbit the car · Enter capture · Esc exit.</p>
      <p class="fine" style="--i:5">Everything is tunable live from the panel: time of day, weather, lights, camera, image, performance. If it runs slow, open the panel
        → performance and pick a lower quality preset or render scale. Settings are saved in this browser. Leaderboards are not available in this build.</p>
      <div class="go" style="--i:6"><button type="button">let's drive</button><small>Enter or Esc to close · H to reopen</small></div>
    </div>`;
    el.querySelector("button").onclick = close;
    el.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === el) close(); }, true);
    for (const ev of ["mousedown", "mouseup", "click", "wheel", "contextmenu"]) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
  }
  function open(first) {
    if (!el) build();
    el.classList.toggle("anim", !!first);
    el.classList.add("open");
    el.querySelector("button").focus({ preventScroll: true });
  }
  function close() { if (!el) return; el.classList.remove("open"); el.querySelector("button").blur(); remember(); }
  const isOpen = () => !!el && el.classList.contains("open");

  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
  window.addEventListener("keydown", (e) => {
    if (isOpen()) {                                   // modal: the game gets nothing while it is up
      e.stopImmediatePropagation();
      if (e.code === "Escape" || e.code === "Enter" || e.code === "KeyH" || e.code === "Space") { e.preventDefault(); if (!e.repeat) close(); }
      return;
    }
    if (e.code === "KeyH" && !e.repeat && !typing(e) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); open(false); }
  }, true);
  window.addEventListener("keyup", (e) => { if (isOpen()) e.stopImmediatePropagation(); }, true);

  PT.intro = { open: () => open(false), close };
  const start = () => { if (!seen()) setTimeout(() => open(true), 400); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
