// Sensor post-process (TSL). The scene renders once into two targets — a lit colour
// picture and a heat picture — and this presents one of them as a camera would:
//   TV: daylight colour camera (tone-mapped, slightly sharpened, sensor noise)
//   IR: thermal camera (softness, blooming around hot sources, auto-gain, polarity)
// Both share blast shockwaves, read-out tear, rain on the optics, gain dips and vignette.
import * as THREE from 'three/webgpu';
import {
  Fn, pass, mrt, output, screenUV, uniform, uniformArray, exp, length, float, vec2, vec3, vec4,
  fract, floor, sin, abs, max, pow, mix, step, smoothstep, clamp, acesFilmicToneMapping,
} from 'three/tsl';

const hash2 = Fn(([p]) => {
  const q = fract(p.mul(vec2(123.34, 456.21))).toVar();
  q.addAssign(q.dot(q.add(45.32)));
  return fract(q.x.mul(q.y));
});
const LUMA = vec3(0.2126, 0.7152, 0.0722);

export function createPost(renderer, scene, camera, fireScene) {
  const uRes = uniform(new THREE.Vector2(1, 1)); // CSS pixels
  const uTime = uniform(0), uInvert = uniform(0), uRain = uniform(0), uFlash = uniform(0);
  const uGain = uniform(1), uDefocus = uniform(0), uTear = uniform(0), uExposure = uniform(1), uHaze = uniform(0);
  // blast shockwaves in screen space: (centre u, centre v, ring radius, strength); radius in screen heights
  const shocks = Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, 0));
  const uShock = uniformArray(shocks);

  const scenePass = pass(scene, camera);
  // Anything without its own heat signature (e.g. the fire volume) shows by how bright it is.
  scenePass.setMRT(mrt({ output, thermal: vec4(vec3(output.rgb.dot(LUMA)), output.a) }));
  const colorTex = scenePass.getTextureNode('output');
  const heatTex = scenePass.getTextureNode('thermal');
  // The fire volume writes a single output, so it gets its own pass (transparent background)
  // and is composited over the picture: flame adds light, smoke blocks what is behind it.
  const fireTex = pass(fireScene, camera).getTextureNode('output');
  const lit = (at) => { const f = fireTex.sample(at); return colorTex.sample(at).rgb.mul(float(1).sub(smoothstep(0.04, 0.7, f.a))).add(f.rgb); };

  // ---- shared: where to sample, after shockwaves / tear / defocus
  const warp = () => {
    const aspect = vec2(uRes.x.div(uRes.y), 1);
    const uv = vec2(screenUV).toVar();
    for (let i = 0; i < 4; i++) { // pressure waves refract the picture as they pass
      const sh = uShock.element(i);
      const d = uv.sub(sh.xy).mul(aspect);
      const dist = length(d).add(1e-5);
      const k = dist.sub(sh.z).div(0.022);
      uv.addAssign(d.div(dist).div(aspect).mul(exp(k.mul(k).negate())).mul(sh.w));
    }
    const band = step(0.82, hash2(vec2(floor(uv.y.mul(36)), floor(uTime.mul(40))))); // read-out tear on the 105
    uv.addAssign(vec2(band.mul(uTear).mul(0.035), 0));
    return { uv, px: vec2(1).div(uRes).mul(uDefocus.mul(5).add(1)) };
  };

  // ---- shared: rain streaks on the optics, returned as (streak, haze amount)
  const rain = (uv) => {
    const rx = uv.x.mul(uRes.x.div(uRes.y)).add(uv.y.mul(0.22)).mul(110);
    const col = floor(rx);
    const gy = uv.y.mul(5).sub(uTime.mul(11)).add(hash2(vec2(col, 1)).mul(7));
    const fy = fract(gy);
    return step(0.9, hash2(vec2(col, floor(gy))))
      .mul(float(1).sub(smoothstep(0.1, 0.5, abs(fract(rx).sub(0.5)))))
      .mul(smoothstep(0, 0.2, fy)).mul(float(1).sub(smoothstep(0.5, 1, fy)));
  };
  const vignette = () => { const v = screenUV.sub(0.5); return float(1).sub(v.dot(v).mul(1.25)); };

  // ---- infrared
  const infrared = Fn(() => {
    const { uv, px } = warp();
    const heat = (at) => { // ground heat, dimmed by cold smoke, plus the flame itself
      const f = fireTex.sample(at);
      return heatTex.sample(at).r.mul(float(1).sub(smoothstep(0.08, 0.8, f.a).mul(0.7))).add(f.rgb.dot(LUMA).mul(0.9));
    };

    let c = heat(uv).mul(0.44).add( // sensor softness
      heat(uv.add(px.mul(vec2(1.1, 0)))).add(heat(uv.sub(px.mul(vec2(1.1, 0)))))
        .add(heat(uv.add(px.mul(vec2(0, 1.1))))).add(heat(uv.sub(px.mul(vec2(0, 1.1))))).mul(0.14));
    let b = float(0); // blooming around hot sources
    for (let i = 0; i < 8; i++) {
      const a = i * 0.7854, dx = Math.cos(a), dy = Math.sin(a);
      b = b.add(max(heatTex.sample(uv.add(px.mul(vec2(dx * 5, dy * 5)))).r.sub(0.55), 0))
        .add(max(heatTex.sample(uv.add(px.mul(vec2(dx * 11, dy * 11)))).r.sub(0.55), 0).mul(0.6));
    }
    c = c.add(b.mul(0.11));

    c = pow(max(c, 0), 0.4545).mul(uGain);                 // display transfer + auto-gain
    c = smoothstep(0.03, 0.97, c).add(uFlash.mul(0.25));
    c = mix(c, 0.36, uHaze);                                // atmosphere washes out contrast
    c = mix(c, mix(c, 0.4, 0.1).add(rain(uv).mul(0.16)), uRain);

    c = c.add(hash2(uv.mul(uRes).add(fract(uTime).mul(731))).sub(0.5).mul(0.085));   // temporal noise
    c = c.add(hash2(vec2(floor(uv.x.mul(uRes.x)), 3)).sub(0.5).mul(0.018));          // fixed-pattern columns
    c = c.mul(sin(uv.y.mul(uRes.y).mul(2.0944)).mul(0.1).add(0.9));                  // scanlines
    c = mix(c, float(1).sub(c), uInvert);                                            // white-hot / black-hot
    return vec4(vec3(clamp(c.mul(vignette()), 0, 1)), 1);
  });

  // ---- daylight TV
  const daylight = Fn(() => {
    const { uv, px } = warp();
    const tap = (at) => lit(at);
    const centre = tap(uv);
    const blur = tap(uv.add(px.mul(vec2(1.2, 0)))).add(tap(uv.sub(px.mul(vec2(1.2, 0)))))
      .add(tap(uv.add(px.mul(vec2(0, 1.2))))).add(tap(uv.sub(px.mul(vec2(0, 1.2))))).mul(0.25);
    // unsharp mask when in focus, plain blur while the lens hunts
    let col = mix(centre.add(centre.sub(blur).mul(0.45)), blur, clamp(uDefocus.mul(2), 0, 1));
    col = max(col, vec3(0)).mul(uExposure).mul(uGain).add(uFlash.mul(0.35));
    col = acesFilmicToneMapping(col, float(1));
    col = pow(clamp(col, 0, 1), vec3(0.4545));
    col = mix(vec3(col.dot(LUMA)), col, 0.9);                                         // long-lens haze takes a little colour out
    col = mix(col, mix(col, vec3(0.55), 0.12).add(rain(uv).mul(0.10)), uRain);
    col = col.add(hash2(uv.mul(uRes).add(fract(uTime).mul(731))).sub(0.5).mul(0.035)); // sensor noise
    return vec4(clamp(col.mul(vignette().mul(0.6).add(0.4)), 0, 1), 1);
  });

  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // each camera does its own display transfer
  const nodes = { ir: infrared(), tv: daylight() };
  let mode = 'ir';
  pipeline.outputNode = nodes[mode];

  return {
    uniforms: { uTime, uInvert, uRain, uFlash, uGain, uDefocus, uTear, uExposure, uHaze },
    shocks,
    get mode() { return mode; },
    setMode(m) { mode = m; pipeline.outputNode = nodes[m]; pipeline.needsUpdate = true; },
    resize(w, h) { uRes.value.set(w, h); },
    render() { pipeline.render(); },
  };
}
