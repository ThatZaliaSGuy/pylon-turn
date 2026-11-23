// Vehicle and soldier models (see assets/CREDITS.md).
// Vehicles: each GLB is baked into one geometry per material, normalised to sit on y = 0 with its
// nose along +z and `length` metres long. The models keep their own textures for the daylight
// camera; their heat picture is a base level plus a hot engine area (see `hot`).
// Soldier: a skinned mesh driven by the Quaternius animation library, retargeted at load time.
import * as THREE from 'three/webgpu';
import { mrt, vec3, vec4, float, positionLocal, materialOpacity, materialColor, uniform, pow, clamp, max, mix, smoothstep, abs } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// yaw: extra rotation (radians) that turns the model's nose to +z after its long axis is put on z.
// shade: base heat 0..1. hot: engine area [centre x, centre z, width, depth] as fractions of the
// model's size; it glows through the full height (deck, grilles, exhaust).
const A = import.meta.env.BASE_URL + 'assets/'; // '/' in dev, '/pylon-turn/' on GitHub Pages
const SOURCES = {
  t72: { url: A + 'models/t80u.glb', length: 10.5, yaw: 0, shade: 0.62, hot: [0, -0.3, 0.7, 0.26] },
  bmp: { url: A + 'models/bmp2.glb', length: 7.6, yaw: 0, shade: 0.5, hot: [-0.18, 0.3, 0.4, 0.22] },
  btr: { url: A + 'models/btr80.glb', length: 8.8, yaw: 0, shade: 0.46, hot: [0, -0.33, 0.7, 0.24] },
  ural: { url: A + 'models/ural.glb', length: 8.6, yaw: 0, shade: 0.45, hot: [0, 0.4, 0.6, 0.16] },
  uaz: { url: A + 'models/uaz469.glb', length: 4.9, yaw: 0, shade: 0.52, hot: [0, 0.34, 0.6, 0.22] },
};
const SOLDIER = { url: A + 'models/soldier.glb', anims: A + 'models/ual.glb', height: 2.2, heat: 0.95 };

const loader = new GLTFLoader();
export const MODELS = {}; // type -> { parts: [{ geometry, material }], size, shade, hot }
let soldierProto = null; // { scene, clips: { idle, jog, sprint, death } }

const toLinear = (t) => vec3(pow(clamp(t, 0, 1), 2.2));
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap'];

/** A node material copying a loaded glTF material's look (textures on uv 0 only). */
function nodeMaterial(src) {
  const m = new THREE.MeshStandardNodeMaterial({
    color: src.color ?? 0xffffff, roughness: src.roughness ?? 1, metalness: src.metalness ?? 0,
    emissive: src.emissive ?? 0x000000, emissiveIntensity: src.emissiveIntensity ?? 1,
    side: src.side ?? THREE.FrontSide, alphaTest: src.alphaTest || 0, transparent: true,
  });
  for (const k of MAPS) if (src[k] && (src[k].channel ?? 0) === 0) m[k] = src[k];
  if (src.normalScale) m.normalScale.copy(src.normalScale);
  return m;
}

/**
 * Materials are shared by every unit of a type (building a material is slow), so the per-unit
 * state lives on each mesh as `userData.unit` = { heat, engine, burnt, opacity } and is read per draw.
 */
const perUnit = (key, fallback) => uniform(fallback).onObjectUpdate(({ object }) => object.userData.unit?.[key] ?? fallback);

/** Heat for the thermal camera (base level, plus the engine area while it runs), burn-out and fade. */
function heatUp(mat, model) {
  const u = model.fixed ? uniform(model.shade) : perUnit('heat', model.shade), eng = perUnit('engine', 1), burnt = perUnit('burnt', 0), fade = perUnit('opacity', 1);
  let heat = u;
  if (model.hot) {
    const [hx, hz, hw, hd] = model.hot, s = model.size;
    const p = positionLocal, cx = hx * s.x, cz = hz * s.z, ax = (hw * s.x) / 2, az = (hd * s.z) / 2;
    const mask = float(1).sub(smoothstep(ax * 0.55, ax, abs(p.x.sub(cx)))).mul(float(1).sub(smoothstep(az * 0.55, az, abs(p.z.sub(cz)))));
    heat = max(u, mask.mul(eng));
  }
  mat.colorNode = mix(materialColor, vec3(0.0075, 0.007, 0.0065), burnt); // burnt-out wrecks go near black
  const alpha = materialOpacity.mul(fade);
  mat.opacityNode = alpha;
  mat.mrtNode = mrt({ thermal: vec4(toLinear(heat), alpha) });
  return mat;
}

/** Per-unit state shared by all meshes of one unit. */
function attachUnit(g, shade) {
  const unit = { heat: shade, engine: 1, burnt: 0, opacity: 1 };
  g.traverse((o) => { if (o.isMesh) o.userData.unit = unit; });
  g.userData.unit = unit;
  return unit;
}

function bake(root, src) {
  root.updateMatrixWorld(true);
  const groups = new Map(); // source material -> geometries in model space
  root.traverse((o) => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.morphAttributes = {};
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const key = mats[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  });
  const parts = [...groups].map(([mat, geos]) => ({ geometry: mergeGeometries(geos, false), source: mat }));
  // overall bounds -> centre on x/z, ground on y = 0, long axis on z, scale to length
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const xf = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z);
  if (size.x > size.z) { xf.premultiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)); [size.x, size.z] = [size.z, size.x]; }
  if (src.yaw) xf.premultiply(new THREE.Matrix4().makeRotationY(src.yaw));
  const k = src.length / size.z;
  xf.premultiply(new THREE.Matrix4().makeScale(k, k, k));
  size.multiplyScalar(k);
  for (const p of parts) { p.geometry.applyMatrix4(xf); p.geometry.computeBoundingSphere(); }
  const model = { parts, size, shade: src.shade, hot: src.hot };
  for (const p of parts) p.material = heatUp(nodeMaterial(p.source), model);
  return model;
}

// ---------------------------------------------------------------- soldier weapons (procedural)
/** Merge [geometry, x, y, z, rotX] parts into one geometry. */
function parts(list) {
  return mergeGeometries(list.map(([g, x, y, z, rx = 0]) => {
    const c = g.index ? g.toNonIndexed() : g;
    return c.rotateX(rx).translate(x, y, z);
  }), false);
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const tube = (r, len) => new THREE.CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2); // along z

// AK-style rifle, metres, pistol grip at the origin, muzzle along +z
const rifleGeo = () => parts([
  [box(0.055, 0.09, 0.42), 0, 0.06, 0.12], // receiver
  [tube(0.013, 0.42), 0, 0.075, 0.53], // barrel
  [box(0.05, 0.05, 0.22), 0, 0.05, 0.42], // handguard
  [box(0.045, 0.09, 0.26), 0, 0.03, -0.24], // stock
  [box(0.03, 0.17, 0.065), 0, -0.07, 0.2, 0.35], // curved magazine (tilted)
  [box(0.035, 0.1, 0.04), 0, -0.03, 0, -0.25], // grip
]);
// shoulder-fired SAM: long tube resting on the shoulder, grip near the front third
const launcherGeo = () => parts([
  [tube(0.042, 1.6), 0, 0.09, -0.35], // launch tube
  [tube(0.05, 0.12), 0, 0.09, 0.42], // seeker cover
  [box(0.05, 0.12, 0.07), 0, 0.12, -0.12], // gripstock / battery
  [box(0.035, 0.1, 0.04), 0, -0.02, 0, -0.2], // grip
]);

/**
 * Put a rifle and a launcher in the right hand, both hidden; soldierMesh() shows one.
 * The hold is worked out in the bind (T) pose — barrel along the forearm, grip in the palm — then
 * expressed in the hand bone's space so it follows the animation (aimed when the arm is raised).
 */
function attachWeapons(holder, hand, scale) {
  holder.updateMatrixWorld(true);
  const handPos = hand.getWorldPosition(new THREE.Vector3());
  // in the T-pose the right hand points out along -x; the palm sits a little past the wrist
  const grip = handPos.clone().add(new THREE.Vector3(-0.085 * scale, -0.035 * scale, 0));
  const inv = hand.matrixWorld.clone().invert();
  // barrel along the forearm (out along -x in the T-pose), top of the weapon on the thumb side (+z)
  const hold = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
  const make = (name, geo, color, heat) => {
    const mat = heatUp(new THREE.MeshStandardNodeMaterial({ color, roughness: 0.7, metalness: 0.3, transparent: true }), { shade: heat, fixed: true });
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.userData.prop = true;
    m.castShadow = true;
    const world = new THREE.Matrix4().compose(grip, hold, new THREE.Vector3().setScalar(scale));
    inv.clone().multiply(world).decompose(m.position, m.quaternion, m.scale);
    m.visible = false;
    hand.add(m);
  };
  make('rifle', rifleGeo(), 0x1e1d1b, 0.3);
  make('launcher', launcherGeo(), 0x3a4428, 0.3);
}

// ---------------------------------------------------------------- soldier animation retargeting
// Quaternius UAL (UE-mannequin names) -> Mixamo-style names on the soldier
const BONES = {
  pelvis: 'Hips', spine_01: 'Spine', spine_02: 'Spine1', spine_03: 'Spine2', neck_01: 'Neck', Head: 'Head',
  clavicle_l: 'LeftShoulder', upperarm_l: 'LeftArm', lowerarm_l: 'LeftForeArm', hand_l: 'LeftHand',
  clavicle_r: 'RightShoulder', upperarm_r: 'RightArm', lowerarm_r: 'RightForeArm', hand_r: 'RightHand',
  thigh_l: 'LeftUpLeg', calf_l: 'LeftLeg', foot_l: 'LeftFoot', ball_l: 'LeftToeBase',
  thigh_r: 'RightUpLeg', calf_r: 'RightLeg', foot_r: 'RightFoot', ball_r: 'RightToeBase',
};
const CLIPS = { idle: 'Pistol_Idle_Loop', jog: 'Jog_Fwd_Loop', sprint: 'Sprint_Loop', death: 'Death01', aim: 'Pistol_Aim_Up' };
const mixamoName = (n) => n.replace(/^mixamorig:?/, '').replace(/_\d+$/, '');

function bonesByName(root, rename = (n) => n) {
  const out = {};
  root.traverse((o) => { if (o.isBone) out[rename(o.name)] = o; });
  return out;
}

/**
 * Bake `clip` from the source rig onto the target rig. Both rigs are first put in a matching
 * T-pose (the source's A_TPose clip, the target's bind pose); every frame, each target bone gets the
 * source bone's world-space rotation change from that pose. Hip height is scaled, travel dropped.
 */
function retarget(clip, src, srcRest, tgtScene, tgtBones) {
  const fps = 30, frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const mixer = new THREE.AnimationMixer(src.scene);
  const pairs = Object.entries(BONES).map(([s, t]) => ({ s: src.bones[s], t: tgtBones[t], name: tgtBones[t]?.name })).filter((p) => p.s && p.t);
  const q = new THREE.Quaternion(), pw = new THREE.Quaternion(), times = new Float32Array(frames);
  const values = pairs.map(() => new Float32Array(frames * 4));
  const hipsY = new Float32Array(frames * 3);
  const hipT = tgtBones.Hips, hipS = src.bones.pelvis;
  const hipScale = srcRest.hipWorldY > 0 ? tgtScene.userData.hipWorldY / srcRest.hipWorldY : 1;
  const action = mixer.clipAction(clip).play();
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    action.time = t; mixer.update(0);
    src.scene.updateMatrixWorld(true);
    pairs.forEach((p, i) => {
      // target world rotation = source world rotation * (source rest world)^-1 * target rest world
      p.s.getWorldQuaternion(q).multiply(srcRest.inv.get(p.s)).multiply(tgtScene.userData.rest.get(p.t));
      // local = parent world^-1 * world, with parents solved earlier in this frame (pairs run root-first)
      const parentWorld = p.t.parent.userData.solved ?? p.t.parent.getWorldQuaternion(pw);
      const local = parentWorld.clone().invert().multiply(q);
      p.t.userData.solved = q.clone();
      local.toArray(values[i], f * 4);
    });
    for (const p of pairs) delete p.t.userData.solved;
    // hip bob: source hip height change, scaled, applied in the target hip's parent space
    const dy = (hipS.getWorldPosition(new THREE.Vector3()).y - srcRest.hipWorldY) * hipScale;
    const local = hipT.parent.worldToLocal(tgtScene.userData.hipWorld.clone().setY(tgtScene.userData.hipWorld.y + dy));
    local.toArray(hipsY, f * 3);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(src.scene);
  const tracks = pairs.map((p, i) => new THREE.QuaternionKeyframeTrack(`${p.name}.quaternion`, times, values[i]));
  if (hipT) tracks.push(new THREE.VectorKeyframeTrack(`${hipT.name}.position`, times, hipsY));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

async function loadSoldier() {
  const [body, anim] = await Promise.all([loader.loadAsync(SOLDIER.url), loader.loadAsync(SOLDIER.anims)]);
  const scene = body.scene;
  // scale to height, stand on y = 0, centred
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const s = SOLDIER.height / (box.max.y - box.min.y);
  const holder = new THREE.Group();
  holder.add(scene);
  scene.scale.multiplyScalar(s);
  scene.updateMatrixWorld(true);
  box.setFromObject(scene);
  scene.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  holder.updateMatrixWorld(true);
  // target rest (bind) pose in world space
  const tgtBones = bonesByName(holder, mixamoName);
  const rest = new Map();
  for (const b of Object.values(tgtBones)) { rest.set(b, b.getWorldQuaternion(new THREE.Quaternion())); }
  holder.userData.rest = rest;
  holder.userData.hipWorld = tgtBones.Hips.getWorldPosition(new THREE.Vector3());
  holder.userData.hipWorldY = holder.userData.hipWorld.y;
  // source rig in its T-pose
  const src = { scene: anim.scene, bones: bonesByName(anim.scene) };
  const byName = Object.fromEntries(anim.animations.map((c) => [c.name, c]));
  const tpose = new THREE.AnimationMixer(src.scene);
  tpose.clipAction(byName.A_TPose).play(); tpose.update(0);
  src.scene.updateMatrixWorld(true);
  const srcRest = { inv: new Map(), hipWorldY: src.bones.pelvis.getWorldPosition(new THREE.Vector3()).y };
  for (const b of Object.values(src.bones)) srcRest.inv.set(b, b.getWorldQuaternion(new THREE.Quaternion()).invert());
  tpose.stopAllAction();
  const clips = {};
  for (const [key, name] of Object.entries(CLIPS)) clips[key] = retarget(byName[name], src, srcRest, holder, tgtBones);
  attachWeapons(holder, tgtBones.RightHand, SOLDIER.height / 1.8); // props scale with the (enlarged) soldier
  // materials: textured, uniformly warm in thermal
  const mats = new Map();
  holder.traverse((o) => {
    if (!o.isMesh || o.userData.prop) return;
    o.frustumCulled = false; // skinned bounds don't follow the animation
    if (!mats.has(o.material)) mats.set(o.material, heatUp(nodeMaterial(o.material), { shade: SOLDIER.heat }));
    o.material = mats.get(o.material);
  });
  soldierProto = { scene: holder, clips };
}

export async function loadModels() {
  const jobs = Object.entries(SOURCES).map(async ([type, src]) => {
    try {
      MODELS[type] = bake((await loader.loadAsync(src.url)).scene, src);
    } catch (err) {
      console.warn(`Model for ${type} unavailable, using the procedural one:`, err);
    }
  });
  jobs.push(loadSoldier().catch((err) => console.warn('Soldier model unavailable, using capsules:', err)));
  await Promise.all(jobs);
  return MODELS;
}

/** A thermal-shaded instance of a loaded vehicle, or null if that type has none. */
export function modelMesh(type) {
  const m = MODELS[type];
  if (!m) return null;
  const g = new THREE.Group();
  for (const p of m.parts) g.add(new THREE.Mesh(p.geometry, p.material));
  attachUnit(g, m.shade);
  return g;
}

// ---------------------------------------------------------------- soldiers
const soldiers = new Set();

/** An animated soldier, or null if the model failed to load. */
export function soldierMesh(kind = 'rifle') {
  if (!soldierProto) return null;
  const g = cloneSkinned(soldierProto.scene);
  g.getObjectByName(kind === 'aa' ? 'launcher' : 'rifle').visible = true;
  g.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  attachUnit(g, SOLDIER.heat);
  const mixer = new THREE.AnimationMixer(g);
  const acts = Object.fromEntries(Object.entries(soldierProto.clips).map(([k, c]) => [k, mixer.clipAction(c)]));
  acts.death.setLoop(THREE.LoopOnce, 1); acts.death.clampWhenFinished = true;
  acts.aim.setLoop(THREE.LoopOnce, 1); acts.aim.clampWhenFinished = true;
  const s = { g, mixer, acts, cur: acts.idle, last: null, dead: false };
  acts.idle.play();
  acts.idle.time = Math.random() * acts.idle.getClip().duration;
  g.userData.soldier = s;
  g.userData.aim = (on) => { // raise the weapon at the sky and hold it there
    if (s.dead || s.aiming === on) return;
    s.aiming = on;
    const want = on ? acts.aim : acts.idle;
    want.reset().play();
    s.cur.crossFadeTo(want, 0.3, false);
    s.cur = want;
  };
  g.userData.die = () => {
    s.dead = true;
    acts.death.reset().play();
    s.cur.crossFadeTo(acts.death, 0.15, false);
    s.cur = acts.death;
  };
  soldiers.add(s);
  return g;
}

/** Advance soldier animations; picks idle / jog / sprint from how fast each one moved. */
export function updateSoldiers(dt) {
  if (dt <= 0) return;
  for (const s of soldiers) {
    if (!s.g.parent) { soldiers.delete(s); s.mixer.stopAllAction(); continue; }
    const p = s.g.position;
    if (!s.dead && !s.aiming) {
      const v = s.last ? Math.hypot(p.x - s.last.x, p.z - s.last.z) / dt : 0;
      s.speed = s.speed === undefined ? v : s.speed + (v - s.speed) * Math.min(1, dt * 6);
      const want = s.speed > 4.8 ? s.acts.sprint : s.speed > 0.6 ? s.acts.jog : s.acts.idle;
      if (want !== s.cur) {
        want.reset().play();
        s.cur.crossFadeTo(want, 0.25, false);
        s.cur = want;
      }
      // keep feet roughly matched to ground speed (the clips cover ~3.2 and ~5.5 m/s)
      if (want === s.acts.jog) want.timeScale = THREE.MathUtils.clamp(s.speed / 3.2, 0.7, 1.4);
      if (want === s.acts.sprint) want.timeScale = THREE.MathUtils.clamp(s.speed / 5.5, 0.8, 1.3);
    }
    s.last = { x: p.x, z: p.z };
    s.mixer.update(dt);
  }
}
