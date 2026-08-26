// Post-processing: bloom, tone mapping and the grade.
//
// Written out rather than assembled from the three.js example passes, because
// the whole chain here is four shaders and going through EffectComposer would
// mean vendoring six more files to get the same four.
//
// The order matters and is the usual one. The scene renders into a half-float
// target with NO tone mapping, so what comes out is linear light with values
// well above one in it — a lit window is not "white", it is eight times
// brighter than the road. Bloom is extracted and blurred in that linear space,
// because bloom is a lens effect and lenses see light, not pixels. Only at the
// very end is the sum tone-mapped down into something a monitor can show,
// graded, and encoded to sRGB. Do it in any other order and the bright things
// have already been clipped to white before you go looking for them, which is
// why bloom bolted onto an LDR image always looks like a blur filter.

import * as THREE from 'three';

const QUAD = new THREE.PlaneGeometry(2, 2);
const CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Everything brighter than the threshold, with a soft knee so a surface that
// drifts across the line fades in instead of switching on.
const BRIGHT = `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform float threshold;
  uniform float knee;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-5);
    float w = max(soft, l - threshold) / max(l, 1e-5);
    gl_FragColor = vec4(c * w, 1.0);
  }
`;

// Separable Gaussian. Nine taps, run once across and once down, which is the
// same result as an 81-tap 2D kernel for eighteen samples instead of 81.
const BLUR = `
  varying vec2 vUv;
  uniform sampler2D tSrc;
  uniform vec2 dir;
  void main() {
    vec3 sum = texture2D(tSrc, vUv).rgb * 0.2270270270;
    sum += texture2D(tSrc, vUv + dir * 1.3846153846).rgb * 0.3162162162;
    sum += texture2D(tSrc, vUv - dir * 1.3846153846).rgb * 0.3162162162;
    sum += texture2D(tSrc, vUv + dir * 3.2307692308).rgb * 0.0702702703;
    sum += texture2D(tSrc, vUv - dir * 3.2307692308).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

// Scene + bloom, tone-mapped, graded, vignetted, grained, encoded.
const COMPOSITE = `
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tBloomA;
  uniform sampler2D tBloomB;
  uniform float bloomStrength;
  uniform float exposure;
  uniform float grade;
  uniform float grain;
  uniform float vignette;
  uniform float time;

  // ACES, the fitted curve rather than the full transform. It is what stops a
  // night scene turning into white blobs: highlights roll off instead of
  // clipping, so a lit window keeps its colour at the centre.
  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    // Two bloom scales: the tight one is the glow right at a light source, the
    // wide one is the haze it puts across the whole street. One alone reads as
    // either a smudge or a halo; the pair reads as light in air.
    vec3 bloom = texture2D(tBloomA, vUv).rgb * 0.62
               + texture2D(tBloomB, vUv).rgb * 0.38;
    c += bloom * bloomStrength;

    c = aces(c * exposure);

    // --- the grade.
    //
    // The look every other game had for about six years: pull the whole image
    // toward warm yellow-green, take some of the saturation out of what is
    // left, and lift the blacks so nothing is ever properly black. It is not
    // subtle and it is not meant to be.
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 g = mix(c, vec3(luma), 0.22);              // desaturate
    g *= vec3(1.10, 1.045, 0.70);                   // and go yellow
    g += vec3(0.055, 0.050, 0.014) * (1.0 - luma);  // lifted, olive shadows
    c = mix(c, g, grade);

    // Corners darker than the middle, the way a lens does it.
    vec2 p = vUv - 0.5;
    c *= 1.0 - vignette * dot(p, p) * 1.9;

    // A little noise, which also breaks up the banding a dark gradient shows.
    float n = fract(sin(dot(vUv * (1.0 + time), vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * grain;

    c = clamp(c, 0.0, 1.0);
    // Encode by hand: this is a ShaderMaterial drawn straight to the canvas,
    // so nothing else is going to do it.
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    gl_FragColor = vec4(mix(hi, lo, step(c, vec3(0.0031308))), 1.0);
  }
`;

const target = (w, h) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
  type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
  stencilBuffer: false,
});

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.time = 0;

    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(QUAD, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.bright = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, threshold: { value: 0.62 }, knee: { value: 0.35 } },
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, dir: { value: new THREE.Vector2() } },
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tBloomA: { value: null }, tBloomB: { value: null },
        bloomStrength: { value: 1.15 },
        exposure: { value: 1.30 },
        grade: { value: 0.55 },
        grain: { value: 0.011 },
        vignette: { value: 0.34 },
        time: { value: 0 },
      },
    });

    // The scene target needs a depth buffer; the rest do not.
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.halfA = target(1, 1);
    this.halfB = target(1, 1);
    this.quarterA = target(1, 1);
    this.quarterB = target(1, 1);
    this.size = new THREE.Vector2(1, 1);
  }

  setSize(w, h) {
    const dpr = this.renderer.getPixelRatio();
    const W = Math.max(1, Math.floor(w * dpr)), H = Math.max(1, Math.floor(h * dpr));
    if (this.size.x === W && this.size.y === H) return;
    this.size.set(W, H);
    this.sceneRT.setSize(W, H);
    this.halfA.setSize(W >> 1, H >> 1);
    this.halfB.setSize(W >> 1, H >> 1);
    this.quarterA.setSize(W >> 2, H >> 2);
    this.quarterB.setSize(W >> 2, H >> 2);
  }

  _pass(material, to) {
    this.quad.material = material;
    this.renderer.setRenderTarget(to);
    this.renderer.clear();
    this.renderer.render(this.scene, CAM);
  }

  // One horizontal and one vertical pass, from `src` into `b`, using `a` as
  // the scratch in between.
  _blur(src, a, b, w, h) {
    this.blur.uniforms.tSrc.value = src;
    this.blur.uniforms.dir.value.set(1 / w, 0);
    this._pass(this.blur, a);
    this.blur.uniforms.tSrc.value = a.texture;
    this.blur.uniforms.dir.value.set(0, 1 / h);
    this._pass(this.blur, b);
  }

  render(scene, camera, dt = 0) {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    this.time = (this.time + dt) % 1000;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    const W = this.size.x, H = this.size.y;
    this.bright.uniforms.tSrc.value = this.sceneRT.texture;
    this._pass(this.bright, this.halfA);
    this._blur(this.halfA.texture, this.halfB, this.halfA, W >> 1, H >> 1);
    // The wide scale is the tight one blurred again at half the resolution,
    // which is four times the reach for a quarter of the samples.
    this._blur(this.halfA.texture, this.quarterA, this.quarterB, W >> 2, H >> 2);

    this.composite.uniforms.tScene.value = this.sceneRT.texture;
    this.composite.uniforms.tBloomA.value = this.halfA.texture;
    this.composite.uniforms.tBloomB.value = this.quarterB.texture;
    this.composite.uniforms.time.value = this.time;
    this._pass(this.composite, null);
  }
}
