// Procedural surfaces in TSL. Every material renders twice in one pass (MRT):
//   output  — lit, full-colour picture for the daylight TV camera
//   thermal — heat picture for the infrared camera
// Thermal brightness is authored in "display" space and stored linear; post.js applies the transfer.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uniformArray, texture, mrt, positionWorld, normalWorld, cameraPosition, materialOpacity, float, vec2, vec3, vec4,
  fract, floor, sin, cos, min, max, pow, mix, step, smoothstep, clamp, exp, length, normalize, reflect,
} from 'three/tsl';

export const uTime = uniform(0); // shared clock, advanced by world.update()
export const SUN = new THREE.Vector3(200, 260, 80).normalize();
const sunDir = vec3(SUN.x, SUN.y, SUN.z);

// ---------------------------------------------------------------- helpers
const toLinear = (t) => vec3(pow(clamp(t, 0, 1), 2.2));
const srgb = (r, g, b) => vec3(r ** 2.2, g ** 2.2, b ** 2.2); // author colours as they should look on screen

/**
 * Give any material a heat signature for the thermal camera.
 * `heat` is display-space brightness 0..1; change it later through material.userData.heat.value.
 */
export function thermalize(mat, heat, alphaNode = materialOpacity) {
  const u = uniform(heat);
  mat.userData.heat = u;
  mat.mrtNode = mrt({ thermal: vec4(toLinear(u), alphaNode) });
  return mat;
}

// ---------------------------------------------------------------- noise
const hash = Fn(([p]) => {
  const q = fract(p.mul(vec2(0.1731, 0.2137))).toVar();
  q.addAssign(q.dot(q.yx.add(31.73)));
  return fract(q.x.add(q.y).mul(q.x).mul(q.y).mul(3.1));
});
const noise = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(hash(i), hash(i.add(vec2(1, 0))), u.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x), u.y);
});
const fbm = Fn(([p0]) => {
  const p = vec2(p0).toVar(), s = float(0).toVar();
  let a = 0.5;
  for (let i = 0; i < 5; i++, a *= 0.5) {
    s.addAssign(noise(p).mul(a));
    p.assign(p.mul(2.03).add(17.3));
  }
  return s.div(0.96875);
});

// ---------------------------------------------------------------- terrain
export const HOT_SLOTS = 12;

/**
 * mapTex: R = vehicle tracks, G = burn scars.
 * hot: array of Vector4(x, z, radius, startTime) — recent impacts and fires that still glow.
 */
export function terrainMaterial(mapTex, seed, water, world, hot) {
  const uSeed = uniform(seed), uHot = uniformArray(hot);

  // everything both cameras need, computed once
  const surface = () => {
    const p = positionWorld.xz, h = positionWorld.y;
    const gn = normalize(normalWorld);
    const slope = float(1).sub(gn.y);
    const big = fbm(p.div(60).add(uSeed));
    const mid = fbm(p.div(11).add(uSeed.mul(1.7)).add(5));
    const fine = noise(p.mul(1.1).add(uSeed));
    const fp = p.div(55).add(big.sub(0.5).mul(1.5));
    const fid = hash(floor(fp).add(uSeed));
    const ff = fract(fp);
    const flatness = float(1).sub(smoothstep(0.03, 0.10, slope));
    const border = float(1).sub(smoothstep(0, 0.04, min(min(ff.x, ff.y), min(float(1).sub(ff.x), float(1).sub(ff.y)))));
    const ang = fid.mul(6.283);
    const furrow = sin(p.dot(vec2(cos(ang), sin(ang))).mul(1.6)).mul(0.5).add(0.5);
    const rock = smoothstep(0.10, 0.30, slope);
    const shore = smoothstep(water, water + 5, h);
    const m = texture(mapTex, vec2(p.x.div(world).add(0.5), float(0.5).sub(p.y.div(world))));
    const glow = float(0).toVar();
    for (let i = 0; i < HOT_SLOTS; i++) {
      const hs = uHot.element(i);
      const d = length(p.sub(hs.xy)).div(hs.z);
      const age = max(uTime.sub(hs.w), 0);
      glow.addAssign(float(1).sub(smoothstep(0.15, 1, d)).mul(exp(age.mul(-0.45))).mul(fine.mul(0.5).add(0.75)));
    }
    return { p, h, gn, slope, big, mid, fine, fid, flatness, border, furrow, rock, shore, m, glow: min(glow, 1) };
  };

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });

  // ---- daylight colour
  mat.colorNode = Fn(() => {
    const s = surface();
    const detail = noise(s.p.mul(3.7)).mul(0.5).add(noise(s.p.mul(0.37)).mul(0.5)); // breaks up flat colour

    // meadow: lush to dry
    const col = mix(srgb(0.20, 0.27, 0.11), srgb(0.36, 0.37, 0.17), s.big).toVar();
    col.assign(mix(col, srgb(0.50, 0.45, 0.27), smoothstep(0.55, 0.8, s.mid).mul(0.6)));

    // farmland: each plot is a crop, stubble or ploughed soil
    const crop = mix(srgb(0.24, 0.35, 0.12), srgb(0.62, 0.54, 0.30), step(0.4, s.fid));
    const plot = mix(crop, srgb(0.33, 0.25, 0.18).mul(s.furrow.mul(0.35).add(0.75)), step(0.72, s.fid));
    col.assign(mix(col, plot, s.flatness.mul(0.85)));
    col.assign(mix(col, srgb(0.13, 0.19, 0.09), s.border.mul(s.flatness).mul(0.8)));   // hedgerows

    col.assign(mix(col, mix(srgb(0.36, 0.34, 0.31), srgb(0.5, 0.47, 0.42), s.mid), s.rock));      // rock on steep ground
    col.assign(mix(srgb(0.30, 0.26, 0.19), col, s.shore));                                     // mud at the waterline
    col.assign(mix(col, srgb(0.47, 0.40, 0.29), s.m.r.mul(0.8)));                              // dirt tracks
    col.assign(mix(col, srgb(0.30, 0.24, 0.17), smoothstep(0.12, 0.5, s.m.g)));                // thrown soil
    col.assign(mix(col, srgb(0.05, 0.05, 0.05), smoothstep(0.5, 0.9, s.m.g)));                 // scorched centre
    return col.mul(detail.mul(0.5).add(0.75)).mul(s.fine.mul(0.2).add(0.9));
  })();
  mat.emissiveNode = Fn(() => surface().glow.mul(vec3(3.0, 1.1, 0.25)))(); // ground still glowing from fire

  // ---- thermal
  const thermal = Fn(() => {
    const s = surface();
    const e = 0.6; // micro-relief so the sun rakes across the ground
    const bx = noise(s.p.add(vec2(e, 0)).div(3.5)).sub(noise(s.p.sub(vec2(e, 0)).div(3.5)));
    const bz = noise(s.p.add(vec2(0, e)).div(3.5)).sub(noise(s.p.sub(vec2(0, e)).div(3.5)));
    const sun = max(normalize(s.gn.add(vec3(bx.negate(), 0, bz.negate()).mul(0.55))).dot(sunDir), 0);

    const t = float(0.30).add(s.h.mul(0.0016)).add(s.big.sub(0.5).mul(0.20)).add(s.mid.sub(0.5).mul(0.12)).add(s.fine.sub(0.5).mul(0.05)).toVar();
    t.addAssign(s.flatness.mul(s.fid.sub(0.5).mul(0.10).add(s.furrow.sub(0.5).mul(0.035).mul(step(0.5, s.fid))).sub(s.border.mul(0.045))));
    t.addAssign(s.rock.mul(s.mid.sub(0.5).mul(0.16).add(0.05)));     // bare rock holds heat
    t.mulAssign(sun.mul(0.55).add(0.62));                             // sun-warmed faces
    t.mulAssign(s.shore.mul(0.55).add(0.45));                         // cold wet shoreline
    t.addAssign(s.m.r.mul(0.13).mul(s.fine.mul(0.6).add(0.7)));       // churned tracks are warmer
    t.assign(mix(t, s.mid.mul(0.10).add(0.06), s.m.g.mul(0.85)));     // burn scars cool to dark ash
    t.addAssign(s.glow.mul(0.8));
    return vec4(toLinear(t), 1);
  })();
  mat.mrtNode = mrt({ thermal });
  return mat;
}

// ---------------------------------------------------------------- water
export function waterMaterial(skyColor) {
  const mat = new THREE.MeshBasicNodeMaterial();
  const sky = uniform(skyColor);
  const waves = () => {
    const p = positionWorld.xz;
    const swell = fbm(p.div(18).add(vec2(0.05, 0.03).mul(uTime)));
    const ra = noise(p.mul(0.9).add(vec2(0.6, 0.4).mul(uTime))), rb = noise(p.mul(0.5).sub(vec2(0.3, 0.5).mul(uTime)));
    return { p, swell, ra, rb };
  };
  mat.colorNode = Fn(() => {
    const w = waves();
    // ripple normal from two moving noise fields
    const fineA = noise(w.p.mul(3.3).add(vec2(1.1, 0.7).mul(uTime))), fineB = noise(w.p.mul(2.7).sub(vec2(0.6, 0.9).mul(uTime)));
    const n = normalize(vec3(w.ra.sub(0.5).mul(0.12).add(fineA.sub(0.5).mul(0.1)), 1, w.rb.sub(0.5).mul(0.12).add(fineB.sub(0.5).mul(0.1))));
    const view = normalize(cameraPosition.sub(positionWorld));
    const fres = pow(float(1).sub(max(n.dot(view), 0)), 4).mul(0.9).add(0.06);
    const deep = mix(srgb(0.05, 0.10, 0.10), srgb(0.10, 0.16, 0.13), w.swell);
    const glint = pow(max(reflect(sunDir.negate(), n).dot(view), 0), 320).mul(2.5);
    return mix(deep, sky, fres).add(vec3(glint));
  })();
  mat.mrtNode = mrt({
    thermal: Fn(() => {
      const w = waves();
      return vec4(toLinear(w.swell.mul(0.07).add(0.10).add(smoothstep(0.40, 0.65, w.ra.mul(w.rb)).mul(0.07))), 1); // cold, faint glints
    })(),
  });
  return mat;
}

// ---------------------------------------------------------------- clouds
export function cloudMaterial(cover, wind, scale, dark) {
  const off = vec2(Math.random() * 50, Math.random() * 50), drift = vec2(wind.x / scale, wind.z / scale);
  const th = 0.74 + (0.40 - 0.74) * cover;
  const density = Fn(() => {
    const p = positionWorld.xz.div(scale).add(off).add(drift.mul(uTime));
    return fbm(p).add(fbm(p.mul(3.7).add(uTime.mul(0.01))).sub(0.5).mul(0.35));
  });
  const alpha = smoothstep(th, th + 0.2, density())
    .mul(float(1).sub(smoothstep(800, 1400, length(positionWorld.xz)))) // hide the deck's edge
    .mul(0.96);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  // lit tops, grey bellies; rain cloud is darker
  mat.colorNode = mix(vec3(dark ? 0.55 : 1.1), vec3(dark ? 0.2 : 0.55), smoothstep(th, th + 0.45, density()));
  mat.opacityNode = alpha;
  mat.mrtNode = mrt({ thermal: vec4(toLinear(mix(0.27, 0.13, smoothstep(th, th + 0.5, density()))), alpha) }); // thicker reads colder
  return mat;
}

// ---------------------------------------------------------------- particles
/** Colour for a debris particle from its heat: cold spray -> earth -> glowing fragment. */
export function particleMaterial(heatNode) {
  const mat = new THREE.MeshBasicNodeMaterial();
  const col = mix(srgb(0.75, 0.8, 0.85), srgb(0.27, 0.21, 0.15), smoothstep(0.03, 0.12, heatNode));
  mat.colorNode = mix(col, vec3(4.0, 1.6, 0.4), smoothstep(0.55, 0.9, heatNode));
  mat.mrtNode = mrt({ thermal: vec4(toLinear(heatNode), 1) });
  return mat;
}
