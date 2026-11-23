import * as THREE from 'three/webgpu';
import { materialOpacity, normalView, uniform } from 'three/tsl';
import { thermalize, SUN } from './shaders.js';
import { Sfx } from './audio.js';
import { createPost } from './post.js';
import { createFire } from './fire.js';
import { loadModels, modelMesh, soldierMesh, updateSoldiers } from './models.js';
import { createParticles } from './particles.js';
import { buildWorld, reseed, groundY, groundNormal, isLand, landPoint, WATER, WEATHER } from './world.js';

// ---------------------------------------------------------------- constants
const ORBIT_R = 290, ALT = 240, ORBIT_SPEED = 0.045;
const AIM_LIMIT = 320, EDGE_R = 380;
const FOV_MIN = 5, FOV_MAX = 36;

const WEAPONS = [
  { name: '25 MM', tag: '25', interval: 0.05, tof: 1.1, radius: 3.2, dmg: 1, spread: 2.6, shell: 0.45, shake: 0.15, fov: 12 },
  { name: '40 MM', tag: '40', interval: 0.45, tof: 1.7, radius: 8.5, dmg: 3, spread: 1.2, shell: 0.8, shake: 0.6, fov: 18 },
  { name: '105 MM', tag: '105', interval: 5.0, tof: 2.6, radius: 26, dmg: 16, spread: 0.4, shell: 1.3, shake: 3.0, fov: 26 },
];

// weapons: which guns a tasking may call for. secs: time allowance per tasked unit.
const TYPES = {
  inf:  { name: 'INFANTRY',  hp: 1,  armor: 0, speed: 3.6, score: 100, weapons: [0],    secs: 5,  group: 5, loop: [25, 60],  from: 1 },
  uaz:  { name: 'UAZ-469',   hp: 2,  armor: 0, speed: 13,  score: 200, weapons: [0, 1], secs: 12, group: 2, loop: [80, 160], from: 1 },
  ural: { name: 'URAL-4320', hp: 4,  armor: 0, speed: 9,   score: 250, weapons: [0, 1], secs: 12, group: 3, loop: [80, 160], from: 1 },
  btr:  { name: 'BTR-80',    hp: 7,  armor: 0, speed: 10,  score: 400, weapons: [1],    secs: 15, group: 3, loop: [70, 150], from: 2 },
  bmp:  { name: 'BMP-2',     hp: 10, armor: 0.4, speed: 8, score: 500, weapons: [1, 2], secs: 17, group: 2, loop: [70, 140], from: 3 },
  t72:  { name: 'T-72B',     hp: 14, armor: 1, speed: 6.5, score: 800, weapons: [2],    secs: 22, group: 2, loop: [60, 130], from: 3 },
};

const KILL_LINES = ['Good effect on target.', 'Target destroyed.', "That's a hit.", 'Splash.', 'Keep it coming.', 'Nice shooting.'];
const MULTI_LINES = ['Good group. Multiple down.', 'Right in the middle of them.', "That'll do it."];

const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

// ---------------------------------------------------------------- renderer / scene
const canvas = $('view');
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
await renderer.init(); // WebGPU where available, WebGL 2 fallback otherwise
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 20, 2500);
const fireScene = new THREE.Scene(); // Fire Pro's volume lives here and is composited in post.js
fireScene.add(new THREE.DirectionalLight(0xfff0dc, 2.5));
renderer.setClearColor(0x000000, 0);
const post = createPost(renderer, scene, camera, fireScene);
// Fire Pro needs real WebGPU; null on the WebGL 2 fallback or if it fails to start.
// Fire Pro needs real WebGPU and takes a while to compile, so it starts in the background;
// `flames` stays null on the WebGL 2 fallback or if it fails.
let flames = null;
const T0 = performance.now();
$('gpu').textContent = renderer.backend?.isWebGPUBackend ? 'WEBGPU' : 'WEBGL2';
createFire(renderer, fireScene).then((f) => {
  flames = f;
  if (f) { $('gpu').textContent = 'WEBGPU · FIRE'; console.info(`Fire Pro ready after ${((performance.now() - T0) / 1000).toFixed(1)} s`); }
}).catch((err) => console.warn('Fire Pro unavailable:', err));
const particles = createParticles(scene);
const worldGroup = new THREE.Group();
scene.add(worldGroup);
// Daylight: sky fill + a shadow-casting sun whose shadow box follows the sensor's aim point.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const skyLight = new THREE.HemisphereLight(0xbcd3ff, 0x4d4638, 1.0);
scene.add(skyLight);
const sun = new THREE.DirectionalLight(0xfff0dc, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -190, right: 190, top: 190, bottom: -190, near: 50, far: 1100 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.6;
scene.add(sun.target);
scene.add(sun);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  post.resize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- shared geometry / materials
const GEO = {
  body: new THREE.CapsuleGeometry(0.85, 1.9, 3, 8).translate(0, 1.8, 0),
  sphere: new THREE.SphereGeometry(1, 28, 18),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  box: new THREE.BoxGeometry(1, 1, 1),
  disc: new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2),
  ring: new THREE.RingGeometry(0.82, 1, 32).rotateX(-Math.PI / 2),
};
// soft-edged volume puff: opacity falls off toward the silhouette so spheres read as smoke
const softMat = (color, heat) => {
  const m = new THREE.MeshBasicNodeMaterial({ color, transparent: true, depthWrite: false });
  const alpha = materialOpacity.mul(normalView.z.abs().pow(2.2));
  m.opacityNode = alpha;
  return thermalize(m, heat, alpha);
};
// unlit glow: colour may be HDR (fire), `heat` is its thermal brightness
const fxMat = (r, g, b, heat = 1) => thermalize(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(r, g, b), transparent: true, depthWrite: false }), heat);
// painted metal / cloth lit by the sun, with a heat signature
const paintMat = (heat, color = 0x2f3a22) => thermalize(new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, metalness: 0.1, transparent: true }), heat);
const shellMat = thermalize(new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(6, 3, 1), fog: false }), 1); // tracer
const UP = new THREE.Vector3(0, 1, 0), tmpN = new THREE.Vector3(), tmpV = new THREE.Vector3();

// ---------------------------------------------------------------- state
const G = {
  state: 'menu', // menu | play | paused | done | over
  time: 0, orbit: Math.PI * 0.5, aim: new THREE.Vector2(0, 40), shake: 0,
  weapon: 1, cool: [0, 0, 0], heat: 0, overheated: false,
  score: 0, kills: 0, level: 0, timeLeft: 0, timeTotal: 0, objectives: [], weather: WEATHER[0],
  firing: false, hadLock: false, lastWrong: -99, lastBeep: 99, reinfT: 0, levelStats: null,
  entities: [], shells: [], fx: [], wrecks: [], world: null,
};
window.__game = G;
const keys = new Set();
const sfx = new Sfx();

// ---------------------------------------------------------------- target models (procedural low-poly, origin at ground)
function makeMesh(type, aa = false) {
  if (type === 'inf') return soldierMesh(aa ? 'aa' : 'rifle') || new THREE.Mesh(GEO.body, paintMat(1, 0x3b4232));
  const model = modelMesh(type); // textured model where we have one
  if (model) return model;
  const g = new THREE.Group();
  // part(width, height, length, y, z, heat 0..1)
  const part = (w, h, d, y, z, shade, x = 0) => {
    const m = new THREE.Mesh(GEO.box, paintMat(shade));
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    g.add(m);
  };
  const round = (x, y, z, sx, sy, sz, shade, rz) => {
    const m = new THREE.Mesh(GEO.cyl, paintMat(shade, shade < 0.4 ? 0x1c1c1a : 0x2f3a22));
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    g.add(m);
  };
  const wheel = (x, y, z, r, w) => round(x, y, z, r, w, r, 0.34, Math.PI / 2);
  const drum = (x, y, z, r, h, shade) => round(x, y, z, r, h, r, shade, 0);
  if (type === 'uaz') {
    part(2.4, 1.2, 5, 1.1, 0, 0.55);
    part(2.2, 1.0, 2.4, 2.1, -0.6, 0.45);   // canvas top
    part(2.2, 0.9, 1.5, 1.4, 2.0, 1.0);     // hot bonnet
  } else if (type === 'ural') {
    part(3.2, 2.6, 6.2, 2.4, -1.6, 0.42);   // cargo bed
    part(3.0, 2.4, 2.2, 2.2, 2.8, 0.7);     // cab
    part(2.6, 1.5, 2.0, 1.6, 4.7, 1.0);     // hot engine
  } else if (type === 'btr') { // BTR-80: long boat hull on eight wheels, small forward turret
    part(2.6, 1.0, 7.4, 1.2, 0, 0.44);        // lower hull
    part(2.9, 0.9, 6.6, 2.0, -0.1, 0.5);    // upper hull, overhanging the wheels
    part(2.3, 0.8, 1.0, 1.7, 3.9, 0.44);      // tapered nose
    for (const z of [-2.7, -1.0, 0.9, 2.6]) { wheel(-1.45, 0.62, z, 0.62, 0.45); wheel(1.45, 0.62, z, 0.62, 0.45); }
    drum(0, 2.75, 1.3, 0.7, 0.6, 0.66);      // turret
    part(0.2, 0.2, 2.0, 2.8, 2.6, 0.62);      // KPVT
    part(2.2, 0.25, 1.9, 2.5, -2.3, 1.0);    // hot rear engine deck
  } else if (type === 'bmp') { // BMP-2: low tracked hull, round two-man turret, long 30 mm
    part(3.1, 1.1, 6.6, 1.15, 0, 0.5);      // hull
    part(3.1, 0.6, 1.0, 0.95, 3.6, 0.44);     // glacis
    part(0.55, 0.8, 6.9, 0.5, 0, 0.34, -1.6); // tracks
    part(0.55, 0.8, 6.9, 0.5, 0, 0.34, 1.6);
    drum(0, 2.0, 0.1, 1.0, 0.6, 0.66);       // turret
    part(0.2, 0.2, 3.4, 2.05, 2.2, 0.62);     // 2A42
    part(1.3, 0.2, 1.6, 1.78, 2.2, 1.0, 0.7); // hot front-right engine
  } else { // t72
    part(4.6, 1.5, 8.8, 1.2, 0, 0.7);
    part(5.2, 0.5, 9.0, 1.0, 0, 0.5);       // skirts / tracks
    part(3.2, 1.1, 3.6, 2.5, 0.4, 0.88);    // turret
    part(0.45, 0.45, 7.0, 2.5, 5.4, 0.8);   // 125 mm
    part(4.0, 0.6, 2.4, 2.1, -3.2, 1.0);    // hot engine deck
  }
  g.scale.setScalar(1.15);
  return g;
}

function spawn(type, x, z, route = null, aa = false) {
  const t = TYPES[type];
  const e = {
    type, def: t, x, z, hp: t.hp, speed: t.speed * rand(0.9, 1.1), route, wi: 0,
    ox: 0, oz: 0, alert: 0, panic: 0, panicDir: 0, alive: true, mesh: makeMesh(type, aa), vx: 0, vz: 1,
    aa, aaT: rand(6, 14), aiming: 0, hold: 0, // MANPADS gunner state
    fireT: rand(4, 10), burst: 0, shotT: 0, // BMP cannon state
  };
  if (type === 'inf') { e.ox = rand(-8, 8); e.oz = rand(-8, 8); }
  e.mesh.position.set(x, groundY(x, z), z);
  e.mesh.rotation.y = rand(0, 6.283);
  e.mesh.traverse((m) => { m.castShadow = true; });
  scene.add(e.mesh);
  G.entities.push(e);
  return e;
}

function makeLoop(cx, cz, r) {
  const n = irand(5, 7), pts = [], a0 = rand(0, 6.283), dir = Math.random() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = a0 + dir * (i / n) * 6.283;
    let rr = r * rand(0.7, 1.3), x, z;
    for (let k = 0; k < 6; k++, rr *= 0.75) {
      x = cx + Math.cos(a) * rr; z = cz + Math.sin(a) * rr;
      const l = Math.hypot(x, z);
      if (l > 300) { x *= 300 / l; z *= 300 / l; }
      if (isLand(x, z)) break;
    }
    pts.push({ x, z });
  }
  return pts;
}

/** Plan a group: returns { type, count, route|null, centre, fromEdge } */
function planGroup(type, count, fromEdge = false) {
  const t = TYPES[type];
  const centre = landPoint(30, 240);
  const parked = !fromEdge && type !== 'inf' && Math.random() < 0.25;
  return { type, count, centre, fromEdge, route: parked ? null : makeLoop(centre.x, centre.z, rand(t.loop[0], t.loop[1])) };
}

function spawnGroup(p) {
  const { type, count, route, centre } = p;
  if (!route) { // parked up
    const a = rand(0, 6.283);
    for (let i = 0; i < count; i++) {
      const x = centre.x + Math.cos(a) * i * 9 + rand(-2, 2), z = centre.z + Math.sin(a) * i * 9 + rand(-2, 2);
      spawn(type, x, z, null, takeAA(type, i));
    }
    return;
  }
  let sx = route[0].x, sz = route[0].z, dx = route[0].x - route[1].x, dz = route[0].z - route[1].z;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl;
  if (p.fromEdge) { const a = Math.atan2(sz, sx) + rand(-0.5, 0.5); sx = Math.cos(a) * EDGE_R; sz = Math.sin(a) * EDGE_R; dx = Math.cos(a); dz = Math.sin(a); }
  for (let i = 0; i < count; i++) {
    const gap = type === 'inf' ? rand(0, 6) : (i + 1) * 15;
    spawn(type, sx + dx * gap, sz + dz * gap, route, takeAA(type, i));
  }
}
// each mission has a few MANPADS gunners, one per infantry group until the budget runs out
function takeAA(type, i) {
  if (type !== 'inf' || i !== 0 || !(G.aaLeft > 0)) return false;
  G.aaLeft--;
  return true;
}

// loaded models share their materials and keep per-unit state in userData.unit (see models.js)
function setOpacity(obj, o) {
  if (obj.userData.unit) { obj.userData.unit.opacity = o; return; }
  obj.traverse((m) => { if (m.material) m.material.opacity = o; });
}
function disposeMesh(obj) {
  scene.remove(obj);
  if (obj.userData.unit || obj.userData.shared) return; // shared materials stay alive
  obj.traverse((m) => { if (m.material) m.material.dispose(); });
}

function updateEntity(e, dt) {
  e.alert = Math.max(0, e.alert - dt);
  if (e.hold > 0 && !(e.panic > 0)) { e.hold -= dt; return; } // standing to fire
  let sp = e.speed * (e.alert > 0 ? 1.6 : 1), vx = 0, vz = 0;
  if (e.panic > 0) {
    e.panic -= dt;
    vx = Math.cos(e.panicDir); vz = Math.sin(e.panicDir); sp = e.speed * 1.8;
  } else if (e.route) {
    const wp = e.route[e.wi], dx = wp.x + e.ox - e.x, dz = wp.z + e.oz - e.z, d = Math.hypot(dx, dz);
    if (d < 4) {
      e.wi = (e.wi + 1) % e.route.length;
      if (e.type === 'inf') { e.ox = rand(-9, 9); e.oz = rand(-9, 9); }
    } else { vx = dx / d; vz = dz / d; }
  } else if (e.alert > 0 && e.type !== 'inf') {
    // parked vehicle spooked: bolt for a new patrol loop
    e.route = makeLoop(e.x, e.z, rand(60, 120));
  }
  if (!vx && !vz) return;
  // steer smoothly so convoys don't snap around corners
  const turn = Math.min(1, dt * (e.type === 'inf' ? 8 : 2.2));
  e.vx += (vx - e.vx) * turn; e.vz += (vz - e.vz) * turn;
  const vl = Math.hypot(e.vx, e.vz) || 1;
  e.x += (e.vx / vl) * sp * dt;
  e.z += (e.vz / vl) * sp * dt;
  for (const o of G.world.obstacles) {
    const ox = e.x - o.x, oz = e.z - o.z, od = Math.hypot(ox, oz);
    if (od < o.r && od > 0.001) { e.x = o.x + (ox / od) * o.r; e.z = o.z + (oz / od) * o.r; }
  }
  e.mesh.rotation.y = Math.atan2(e.vx, e.vz);
  if (e.type !== 'inf') {
    e.dustT = (e.dustT || 0) - dt;
    if (e.dustT <= 0) { // dust kicked up behind the wheels / tracks
      e.dustT = e.alert > 0 ? 0.07 : 0.14;
      particles.dust(e.x - (e.vx / vl) * 3, e.z - (e.vz / vl) * 3, (e.vx / vl) * sp, (e.vz / vl) * sp);
    }
  }
  e.mesh.position.set(e.x, groundY(e.x, e.z), e.z);
}

// ---- sensor reactions and delayed events
const FXS = { gain: 1, defocus: 0, tear: 0, lightning: 0, nextBolt: 8, lastFov: 26, shocks: [], timers: [] };
function shockwave(x, z, reach, strength) { // reach: world radius the ring travels to
  FXS.shocks.push({ x, z, t: 0, reach, strength });
  if (FXS.shocks.length > 4) FXS.shocks.shift();
}
function later(secs, fn) { FXS.timers.push({ t: secs, fn }); }
function cookOff(x, z, big) { // ammunition going up some time after the kill
  explosionFx(x, z, big ? 9 : 5);
  particles.sparks(x, z, big ? 40 : 18, big ? 26 : 16);
  flames?.burst(x, groundY(x, z) + 1.5, z, false);
  shockwave(x, z, 45, 0.004);
  sfx.metal();
  FXS.gain = Math.min(FXS.gain, 0.8);
}

function kill(e) {
  e.alive = false;
  if (e.type === 'inf') {
    if (e.mesh.userData.die) { // animated soldier: fall, then fade
      e.mesh.userData.die();
      addFx(e.mesh, 3.2, (k) => setOpacity(e.mesh, Math.min(1, 2.5 - k * 2.5)));
    } else addFx(e.mesh, 1.3, (k) => setOpacity(e.mesh, 1 - k));
  } else {
    explosionFx(e.x, e.z, e.type === 'uaz' ? 7 : e.type === 't72' ? 15 : 10);
    G.world.scorch(e.x, e.z, e.type === 'uaz' ? 6 : 9);
    flames?.burn(e.x, groundY(e.x, e.z) + 1.2, e.z, e.type === 'uaz' ? 1.6 : 2.6, 30);
    sfx.metal();
    particles.sparks(e.x, e.z, 24, 18);
    shockwave(e.x, e.z, 50, 0.004);
    if (e.type === 't72' || e.type === 'bmp' || e.type === 'btr') { // armour brews up: one to three secondaries
      const x = e.x, z = e.z, n = e.type === 't72' ? 3 : Math.random() < 0.6 ? 2 : 1;
      for (let i = 0; i < n; i++) later(rand(0.5, 3.2), () => cookOff(x, z, e.type === 't72' && i === 0));
    }
    if (e.mesh.userData.unit) Object.assign(e.mesh.userData.unit, { burnt: 1, engine: 0 }); // burnt out, engine dead
    else e.mesh.traverse((m) => { if (m.material) m.material.color.setHex(0x161513); });
    G.wrecks.push({ mesh: e.mesh, t: 0 });
    if (G.wrecks.length > 30) disposeMesh(G.wrecks.shift().mesh);
  }
}

// ---------------------------------------------------------------- fx
function addFx(mesh, T, update) {
  G.fx.push({ mesh, t: 0, T, update });
}

function explosionFx(x, z, radius) {
  const y = groundY(x, z);
  const flash = new THREE.Mesh(GEO.sphere, fxMat(7, 3.4, 1.1));
  flash.position.set(x, y + 0.5, z);
  scene.add(flash);
  addFx(flash, 0.25 + radius * 0.02, (k) => {
    flash.scale.setScalar(radius * (0.35 + 0.65 * Math.sqrt(k)));
    flash.material.opacity = 1 - k * k;
  });
  groundNormal(x, z, tmpN);
  if (radius > 6) {
    const ring = new THREE.Mesh(GEO.ring, fxMat(0.75, 0.7, 0.6));
    ring.position.set(x, y + 0.8, z);
    ring.quaternion.setFromUnitVectors(UP, tmpN);
    scene.add(ring);
    addFx(ring, 0.7, (k) => { ring.scale.setScalar(radius * (0.6 + 1.6 * k)); ring.material.opacity = 0.6 * (1 - k); });
  }
  const puffs = radius < 5 ? 1 : radius < 12 ? 4 : 9;
  for (let i = 0; i < puffs; i++) {
    const p = new THREE.Mesh(GEO.sphere, softMat(0x6f685d, 0.73));
    const a = rand(0, 6.28), r = rand(0, radius * 0.5), s0 = radius * rand(0.25, 0.5);
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, rise = rand(4, 12) + radius * 0.4;
    scene.add(p);
    addFx(p, rand(1.2, 2.2) + radius * 0.06, (k) => {
      p.position.set(px, y + 1 + rise * k, pz);
      p.scale.setScalar(s0 * (1 + 1.6 * k));
      p.material.opacity = 0.55 * (1 - k);
    });
  }
}

// billowing masonry dust where a building is hit or comes down
function dustFx(x, z, radius, n = 6) {
  const y = groundY(x, z);
  for (let i = 0; i < n; i++) {
    const p = new THREE.Mesh(GEO.sphere, softMat(0x8f887c, 0.42));
    const a = rand(0, 6.28), r = rand(0, radius * 0.6), s0 = radius * rand(0.3, 0.55), drift = rand(1, 4);
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, rise = rand(3, 9);
    scene.add(p);
    addFx(p, rand(3, 6), (k) => {
      p.position.set(px + Math.cos(a) * drift * k * 4, y + 1.5 + rise * k, pz + Math.sin(a) * drift * k * 4);
      p.scale.setScalar(s0 * (0.6 + 2.2 * Math.sqrt(k)));
      p.material.opacity = 0.5 * (1 - k) * Math.min(1, k * 8);
    });
  }
}

function popup(text, x, z, bad = false) {
  const v = new THREE.Vector3(x, groundY(x, z) + 3, z).project(camera);
  const d = document.createElement('div');
  d.className = 'pop' + (bad ? ' bad' : '');
  d.innerHTML = text;
  d.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
  d.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 1400);
}

function radio(text) {
  const box = $('radio');
  const d = document.createElement('div');
  d.textContent = '> ' + text;
  sfx.radio();
  box.appendChild(d);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => d.remove(), 7000);
}

let bannerTimer = 0;
function banner(html, secs = 3) {
  const b = $('banner');
  b.innerHTML = html;
  b.classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('on'), secs * 1000);
}

// ---------------------------------------------------------------- weapons
function fire() {
  const w = WEAPONS[G.weapon];
  G.cool[G.weapon] = w.interval;
  if (G.weapon === 0) {
    G.heat += 1.7;
    if (G.heat >= 100) { G.overheated = true; radio('Twenty-five is overheated. Let it cool.'); sfx.beep(300, 0.2, 2); }
  }
  const a = rand(0, 6.28), r = Math.sqrt(Math.random()) * w.spread * (camera.fov / 14 + 0.4);
  const start = camera.position.clone();
  start.y -= 6;
  const ex = G.aim.x + Math.cos(a) * r, ez = G.aim.y + Math.sin(a) * r;
  const end = new THREE.Vector3(ex, groundY(ex, ez), ez);
  const mesh = new THREE.Mesh(GEO.sphere, shellMat);
  mesh.scale.set(w.shell, w.shell, w.shell * 7);
  mesh.position.copy(start);
  mesh.lookAt(end);
  scene.add(mesh);
  G.shells.push({ mesh, start, end, t: 0, w: G.weapon });
  G.shake = Math.max(G.shake, w.shake);
  if (G.weapon === 2) FXS.tear = 1;
  sfx.shot(G.weapon);
}

function impact(s) {
  const w = WEAPONS[s.w], x = s.end.x, z = s.end.z;
  explosionFx(x, z, w.radius);
  if (s.w > 0) flames?.burst(x, groundY(x, z) + 1, z, s.w === 2);
  if (groundY(x, z) <= WATER) particles.spray(x, z, s.w); else particles.dirt(x, z, s.w);
  if (s.w > 0) shockwave(x, z, s.w === 2 ? 130 : 40, s.w === 2 ? 0.012 : 0.004);
  if (s.w === 2) FXS.gain = 0.5; // the flash drives the sensor's gain down for a moment
  const wrecked = G.world.blast(x, z, s.w); // craters, burn scars, buildings, trees
  if (s.w === 2) for (const t of wrecked.felled.slice(0, 2)) flames?.burn(t.x, groundY(t.x, t.z) + 1, t.z, 1.4, 18); // splintered trees catch
  for (const d of wrecked.dust) { dustFx(d.x, d.z, 7, s.w === 2 ? 5 : 2); particles.dirt(d.x, d.z, 1); }
  for (const r of wrecked.ruins) {
    dustFx(r.x, r.z, r.r * 1.1, 9);
    later(0.7, () => dustFx(r.x, r.z, r.r * 1.4, 7)); // second billow as the rest comes down
    flames?.burn(r.x, groundY(r.x, r.z) + 1.5, r.z, Math.min(5, r.r * 0.45), 40);
    sfx.boom(0.8);
    G.levelStats.buildings++;
    if (Math.random() < 0.5) radio(pick(['Structure is down.', 'Building destroyed.', 'That brought the roof in.']));
  }
  if (s.w > 0) { sfx.boom(s.w === 2 ? 1 : 0.4); if (groundY(x, z) <= WATER) sfx.splash(); } else sfx.tick();
  if (s.w === 2) G.shake = Math.max(G.shake, 2.2 / (1 + Math.hypot(x - G.aim.x, z - G.aim.y) / 60));

  let kills = 0, tasked = 0, bonus = 0, wrong = 0;
  for (const e of G.entities) {
    if (!e.alive) continue;
    const d = Math.hypot(e.x - x, e.z - z), soft = e.type === 'inf';
    if (d < 90) e.alert = 14;
    if (d < w.radius + (soft ? 0 : 2.5)) {
      const dmg = w.dmg * (d < w.radius * 0.5 + 1.5 ? 1 : 0.5) - e.def.armor;
      if (dmg > 0) { e.hp -= dmg; if (!soft) particles.sparks(e.x, e.z, s.w === 0 ? 3 : 10, 9); }
      if (soft || e.hp <= 0) {
        kill(e);
        kills++;
        const o = G.objectives.find((ob) => ob.type === e.type);
        if (o && o.done < o.need) {
          if (o.weapon === s.w) { o.done++; tasked += e.def.score; }
          else { wrong++; G.levelStats.wrong++; G.score += Math.round(e.def.score * 0.25); }
        } else { bonus += e.def.score; G.levelStats.bonus += e.def.score; }
      }
    } else if (soft && d < w.radius * 2.5 + 8) {
      e.panic = rand(1.2, 2.6);
      e.panicDir = Math.atan2(e.z - z, e.x - x) + rand(-0.7, 0.7);
    }
  }
  if (!kills) return;
  G.kills += kills;
  G.levelStats.kills += kills;
  G.score += tasked + bonus;
  const lines = [];
  if (tasked) lines.push(`+${tasked}`);
  if (bonus) lines.push(`BONUS +${bonus}`);
  if (wrong) lines.push('WRONG ORDNANCE');
  popup(lines.join('<br>'), x, z, wrong > 0);
  if (wrong && G.time - G.lastWrong > 6) {
    G.lastWrong = G.time;
    radio('Wrong ordnance on a tasked target. That one does not count.');
    sfx.beep(240, 0.2, 2);
  } else if (kills >= 3) radio(pick(MULTI_LINES));
  else if (Math.random() < (s.w === 0 ? 0.08 : 0.35)) radio(pick(KILL_LINES));
  if (tasked) { sfx.beep(990, 0.06); renderTasking(); checkComplete(); }
}

// ---------------------------------------------------------------- missions
function makeObjectives(n) {
  const avail = Object.keys(TYPES).filter((k) => TYPES[k].from <= n);
  const count = Math.min(4, 2 + Math.floor(n / 2));
  const chosen = shuffle([...avail]).slice(0, count);
  if (n >= 3 && !chosen.includes('t72') && !chosen.includes('bmp')) chosen[chosen.length - 1] = 't72';
  if (n === 1 && !chosen.includes('inf')) chosen[0] = 'inf';
  return chosen.map((type) => {
    const t = TYPES[type];
    const need = type === 'inf' ? Math.min(14, 5 + n) : Math.min(6, (type === 't72' || type === 'bmp' ? 1 : 2) + Math.floor(n / 3));
    return { type, need, done: 0, weapon: pick(t.weapons) };
  });
}

function startLevel(n, forceWeather) {
  // clear previous mission
  for (const e of G.entities) disposeMesh(e.mesh);
  for (const s of G.shells) scene.remove(s.mesh);
  for (const f of G.fx) disposeMesh(f.mesh);
  for (const w of G.wrecks) disposeMesh(w.mesh);
  Object.assign(G, {
    level: n, shake: 0, cool: [0, 0, 0], heat: 0, overheated: false, firing: false, lastBeep: 99, reinfT: 0,
    entities: [], shells: [], fx: [], wrecks: [],
    levelStats: { kills: 0, bonus: 0, wrong: 0, buildings: 0, damage: 0, startScore: G.score },
    aaLeft: Math.min(3, 1 + Math.floor((n - 1) / 2)),
  });
  resetThreats();
  $('radio').innerHTML = '';
  flames?.reset();
  particles.clear();
  FXS.shocks.length = FXS.timers.length = 0;
  FXS.nextBolt = rand(5, 12);

  G.weather = forceWeather != null ? WEATHER[forceWeather] : n === 1 ? WEATHER[0] : pick(WEATHER);
  G.objectives = makeObjectives(n);

  // plan forces on a fresh map, then build the map with their tracks pressed into it
  reseed();
  const plans = [];
  const planType = (type, total) => {
    const size = TYPES[type].group;
    for (let left = total; left > 0; left -= size) plans.push(planGroup(type, Math.min(size, left)));
  };
  for (const o of G.objectives) planType(o.type, o.need + (o.type === 'inf' ? irand(2, 5) : irand(0, 2)));
  for (const type of Object.keys(TYPES)) {
    if (TYPES[type].from > n || G.objectives.some((o) => o.type === type)) continue;
    planType(type, type === 'inf' ? irand(3, 6) : irand(1, 2)); // untasked: pure bonus
  }
  const tracks = plans.filter((p) => p.route && p.type !== 'inf').map((p) => ({ pts: p.route, closed: true, width: p.type === 't72' || p.type === 'bmp' ? 5 : 3.5 }));
  G.world = buildWorld(scene, worldGroup, G.weather, tracks);
  plans.forEach(spawnGroup);

  const work = G.objectives.reduce((s, o) => s + o.need * TYPES[o.type].secs, 0);
  G.timeTotal = G.timeLeft = Math.round((35 + work * 0.85) * G.weather.time * Math.max(0.75, 1 - 0.03 * (n - 1)));

  G.aim.set(0, 0);
  selectWeapon(G.objectives[0].weapon);
  renderTasking();
  $('wx').textContent = G.weather.id;
  post.uniforms.uRain.value = G.weather.rain ? 1 : 0;
  applyWeatherLight(G.weather);
  $('level').textContent = n;
  G.state = 'play';
  sfx.setMuted(false);
  $('overlay').classList.add('hide');
  banner(`MISSION ${n}<small>WX ${G.weather.id} · ${fmtTime(G.timeLeft)} ON STATION</small>`, 4);
  radio(`On station. ${G.objectives.map((o) => `${o.need} × ${TYPES[o.type].name} with the ${WEAPONS[o.weapon].tag}`).join(', ')}.`);
  sfx.beep(880, 0.1, 2);
}

function renderTasking() {
  $('tasking').innerHTML = G.objectives.map((o) =>
    `<div class="task${o.done >= o.need ? ' ok' : ''}"><span class="k">${WEAPONS[o.weapon].tag}</span>` +
    `<span class="tn">${TYPES[o.type].name}</span><span>${o.done}/${o.need}</span></div>`).join('');
}

function taskingTable(objs) {
  return '<table>' + objs.map((o) => `<tr><td>${o.need} × ${TYPES[o.type].name}</td><td>${WEAPONS[o.weapon].name}</td></tr>`).join('') + '</table>';
}

function checkComplete() {
  if (G.state !== 'play' || G.objectives.some((o) => o.done < o.need)) return;
  const timeBonus = Math.ceil(G.timeLeft) * 10 * G.level;
  G.score += timeBonus;
  const st = G.levelStats;
  endState('done', `MISSION ${G.level} COMPLETE`, [
    ['TARGETS DESTROYED', st.kills], ['BONUS TARGETS', '+' + st.bonus], ['WRONG ORDNANCE', st.wrong], ['STRUCTURES LEVELLED', st.buildings],
    ['TIME REMAINING', `${fmtTime(G.timeLeft)}  (+${timeBonus})`], ['SCORE', G.score],
  ], 'CLICK FOR NEXT TASKING');
  sfx.beep(880, 0.12, 3);
}

function endState(state, title, rows, go) {
  G.state = state;
  clearProjectiles();
  G.firing = false;
  document.exitPointerLock?.();
  $('banner').classList.remove('on');
  $('ovbody').innerHTML = `<p style="font-size:20px;letter-spacing:.2em">${title}</p><table>` +
    rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('') + '</table>';
  $('go').textContent = go;
  setTimeout(() => $('overlay').classList.remove('hide'), 900);
}

function updateMission(dt) {
  G.timeLeft -= dt;
  if (G.timeLeft <= 10 && Math.ceil(G.timeLeft) !== G.lastBeep) { G.lastBeep = Math.ceil(G.timeLeft); sfx.beep(700, 0.07); }
  if (G.timeLeft <= 0) {
    G.timeLeft = 0;
    const left = G.objectives.filter((o) => o.done < o.need).map((o) => `${o.need - o.done} × ${TYPES[o.type].name}`).join(', ');
    endState('over', 'OFF STATION — TASKING INCOMPLETE', [
      ['REMAINING', left], ['MISSION REACHED', G.level], ['TARGETS DESTROYED', G.kills], ['FINAL SCORE', G.score],
    ], 'CLICK TO RE-ARM');
    return;
  }
  // keep every tasking achievable: if a tasked type runs short, more arrive from the map edge
  G.reinfT -= dt;
  if (G.reinfT <= 0) {
    G.reinfT = 1.5;
    for (const o of G.objectives) {
      const alive = G.entities.reduce((n, e) => n + (e.type === o.type ? 1 : 0), 0);
      const short = o.need - o.done - alive;
      if (short > 0) {
        spawnGroup(planGroup(o.type, o.type === 'inf' ? Math.max(short, 3) : short, true));
        radio(`Additional ${TYPES[o.type].name} entering the area.`);
      }
    }
  }
}

function setPaused(p) {
  if (G.state !== 'play' && G.state !== 'paused') return;
  G.state = p ? 'paused' : 'play';
  G.firing = false;
  sfx.setMuted(p);
  if (p) banner('PAUSED<small>CLICK TO RESUME</small>', 9999);
  else $('banner').classList.remove('on');
}

function selectWeapon(i) {
  G.weapon = i;
  camera.fov = WEAPONS[i].fov;
  document.querySelectorAll('.wpn').forEach((el) => el.classList.toggle('on', +el.dataset.w === i));
  document.querySelectorAll('#reticle svg').forEach((el) => el.classList.toggle('on', +el.dataset.w === i));
  $('tof').textContent = `TOF ${WEAPONS[i].tof.toFixed(1)}s`;
}

const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------- input
function lock() {
  try { const p = canvas.requestPointerLock?.(); p?.catch?.(() => {}); } catch { /* unsupported */ }
}
function advance() {
  if (G.state === 'menu' || G.state === 'over') { sfx.init(); G.score = 0; G.kills = 0; startLevel(1); }
  else if (G.state === 'done') startLevel(G.level + 1);
  else return false;
  return true;
}
$('overlay').addEventListener('click', () => { if (!$('overlay').classList.contains('hide') && advance()) lock(); });
addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (G.state === 'paused') { setPaused(false); lock(); return; }
  if (G.state === 'play') { G.firing = true; if (document.pointerLockElement !== canvas) lock(); }
});
addEventListener('mouseup', () => { G.firing = false; });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) G.hadLock = true;
  else if (G.hadLock && G.state === 'play') setPaused(true);
});
addEventListener('mousemove', (ev) => {
  if (G.state !== 'play' || document.pointerLockElement !== canvas) return;
  slew(ev.movementX, -ev.movementY);
});
addEventListener('wheel', (ev) => { zoom(Math.exp(ev.deltaY * 0.0012)); }, { passive: true });
addEventListener('contextmenu', (ev) => ev.preventDefault());
addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  keys.add(k);
  if (k === ' ') ev.preventDefault();
  if (ev.repeat) return;
  if (k === 'enter' && !$('overlay').classList.contains('hide')) advance();
  if (G.state === 'play') {
    if (k === '1' || k === '2' || k === '3') { selectWeapon(+k - 1); sfx.click(); }
    if (k === 'q') { selectWeapon((G.weapon + 1) % 3); sfx.click(); }
    if (k === 'f') dropFlares();
  }
  if (k === 't' && post.mode === 'ir') { post.uniforms.uInvert.value ^= 1; sensorLabel(); }
  if (k === 'v') { post.setMode(post.mode === 'ir' ? 'tv' : 'ir'); sensorLabel(); sfx.click(); }
  if (k === 'p') setPaused(G.state === 'play');
});
addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); G.firing = false; });

function sensorLabel() {
  $('pol').textContent = post.mode === 'tv' ? 'TV' : post.uniforms.uInvert.value ? 'IR BHOT' : 'IR WHOT';
}

function zoom(f) {
  camera.fov = THREE.MathUtils.clamp(camera.fov * f, FOV_MIN, FOV_MAX);
}

// move the aim point by screen pixels (right, up)
const fwd = new THREE.Vector2();
function slew(px, py) {
  fwd.set(G.aim.x - camera.position.x, G.aim.y - camera.position.z);
  const ground = fwd.length(), drop = ALT - groundY(G.aim.x, G.aim.y), dist = Math.hypot(ground, drop);
  fwd.divideScalar(ground || 1);
  const perPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
  const r = px * perPx, f = (py * perPx) / (drop / dist);
  G.aim.x += -fwd.y * r + fwd.x * f;
  G.aim.y += fwd.x * r + fwd.y * f;
  const l = G.aim.length();
  if (l > AIM_LIMIT) G.aim.multiplyScalar(AIM_LIMIT / l);
}

// ---------------------------------------------------------------- update
function update(dt) {
  G.time += dt;
  G.orbit += ORBIT_SPEED * dt;

  const kx = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const ky = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  if (kx || ky) slew(kx * innerHeight * 0.7 * dt, ky * innerHeight * 0.7 * dt);
  if (keys.has('z')) zoom(Math.exp(-1.6 * dt));
  if (keys.has('x')) zoom(Math.exp(1.6 * dt));

  for (let i = 0; i < 3; i++) G.cool[i] = Math.max(0, G.cool[i] - dt);
  const trigger = G.firing || keys.has(' ');
  if (!(trigger && G.weapon === 0 && !G.overheated)) G.heat = Math.max(0, G.heat - 24 * dt);
  if (G.overheated && G.heat < 25) G.overheated = false;
  if (trigger && G.cool[G.weapon] <= 0 && !(G.weapon === 0 && G.overheated)) fire();

  for (let i = G.shells.length - 1; i >= 0; i--) {
    const s = G.shells[i];
    s.t += dt / WEAPONS[s.w].tof;
    if (s.t >= 1) { scene.remove(s.mesh); G.shells.splice(i, 1); impact(s); }
    else s.mesh.position.lerpVectors(s.start, s.end, s.t);
  }

  for (const e of G.entities) if (e.alive) updateEntity(e, dt);
  G.entities = G.entities.filter((e) => e.alive);
  updateThreats(dt);

  if (G.state === 'play') updateMission(dt);
}

// effects keep animating on the debrief screen
function updateFx(dt) {
  updateSoldiers(dt);
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const f = G.fx[i];
    f.t += dt;
    const k = Math.min(1, f.t / f.T);
    f.update(k);
    if (k >= 1) { disposeMesh(f.mesh); G.fx.splice(i, 1); }
  }
  for (const w of G.wrecks) {
    w.t += dt;
    const burn = Math.max(0, 1 - w.t / 14), v = 0.14 + burn * (0.55 + 0.3 * Math.random());
    if (w.mesh.userData.unit) w.mesh.userData.unit.heat = v;
    else w.mesh.traverse((m) => { if (m.material?.userData.heat) m.material.userData.heat.value = v; });
  }
  G.world?.update(dt);
  flames?.update(dt);
  particles.update(dt);
  for (let i = FXS.timers.length - 1; i >= 0; i--) {
    if ((FXS.timers[i].t -= dt) <= 0) FXS.timers.splice(i, 1)[0].fn();
  }

  // sensor: gain recovers, focus hunts after a zoom change, read-out tear dies away
  FXS.gain += (1 - FXS.gain) * Math.min(1, dt * 1.6);
  FXS.defocus = Math.min(1, FXS.defocus + (Math.abs(camera.fov - FXS.lastFov) / FXS.lastFov) * 2.5);
  FXS.lastFov = camera.fov;
  FXS.defocus = Math.max(0, FXS.defocus - dt * 3);
  FXS.tear = Math.max(0, FXS.tear - dt * 4);

  // lightning in the rain: lights the whole picture, thunder follows
  FXS.lightning = Math.max(0, FXS.lightning - dt * 5);
  if (G.weather.rain && G.state === 'play' && (FXS.nextBolt -= dt) <= 0) {
    FXS.nextBolt = rand(7, 20);
    FXS.lightning = 1;
    later(0.12, () => { FXS.lightning = 0.8; });
    later(rand(0.8, 2.2), () => sfx.thunder());
  }

  // project each shockwave ring into screen space for the post-process
  const viewH = 2 * camera.position.distanceTo(tmpV.set(G.aim.x, groundY(G.aim.x, G.aim.y), G.aim.y)) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  for (let i = FXS.shocks.length - 1; i >= 0; i--) {
    const sh = FXS.shocks[i];
    sh.t += dt;
    if (sh.t * 95 > sh.reach) FXS.shocks.splice(i, 1);
  }
  for (let i = 0; i < 4; i++) {
    const sh = FXS.shocks[i], u = post.shocks[i];
    if (!sh) { u.w = 0; continue; }
    const r = sh.t * 95; // m/s, slowed for drama
    tmpV.set(sh.x, groundY(sh.x, sh.z), sh.z).project(camera);
    u.set(tmpV.x * 0.5 + 0.5, 0.5 - tmpV.y * 0.5, r / viewH, tmpV.z < 1 ? sh.strength * (1 - r / sh.reach) : 0);
  }
}

function applyWeatherLight(w) {
  sun.intensity = w.sun;
  skyLight.intensity = w.sky;
  post.uniforms.uHaze.value = w.irHaze;
}

function updateCamera(dt) {
  // keep the sun's shadow box centred on what the sensor is looking at
  sun.target.position.set(G.aim.x, 0, G.aim.y);
  sun.position.copy(sun.target.position).addScaledVector(SUN, 520);
  G.shake = Math.max(0, G.shake - G.shake * 6 * dt - 0.2 * dt);
  camera.position.set(Math.cos(G.orbit) * ORBIT_R, ALT, Math.sin(G.orbit) * ORBIT_R);
  const k = G.shake * camera.fov / 26;
  camera.lookAt(G.aim.x + rand(-k, k), groundY(G.aim.x, G.aim.y) + rand(-k, k), G.aim.y + rand(-k, k));
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- hud
const radar = $('radar').getContext('2d');
const wpnEls = [...document.querySelectorAll('.wpn')].map((el) => ({ bar: el.querySelector('i'), s: el.querySelector('.s') }));
function drawHud() {
  $('score').textContent = String(G.score).padStart(6, '0');
  const tEl = $('timer');
  tEl.textContent = fmtTime(G.timeLeft);
  tEl.classList.toggle('low', G.state === 'play' && G.timeLeft < 20);
  $('zoom').textContent = 'x' + (FOV_MAX / camera.fov).toFixed(1);
  const hdg = (Math.atan2(G.aim.x - camera.position.x, -(G.aim.y - camera.position.z)) * 180 / Math.PI + 360) % 360;
  $('hdg').textContent = String(Math.round(hdg) % 360).padStart(3, '0');

  $('afbar').style.width = AF.hp + '%';
  $('afs').textContent = Math.ceil(AF.hp) + '%';
  $('afrow').classList.toggle('low', AF.hp < 35);
  $('flbar').style.width = (100 - (AF.flareCool / FLARE_COOL) * 100) + '%';
  $('fls').textContent = AF.flareCool > 0 ? 'RELOAD' : 'READY';
  $('mwarn').classList.toggle('on', G.state === 'play' && AF.missiles.some((m) => !m.flare));
  wpnEls[0].bar.style.width = (100 - Math.min(100, G.heat)) + '%';
  wpnEls[0].s.textContent = G.overheated ? 'OVERHEAT' : 'READY';
  for (let i = 1; i < 3; i++) {
    const k = G.cool[i] / WEAPONS[i].interval;
    wpnEls[i].bar.style.width = (100 - k * 100) + '%';
    wpnEls[i].s.textContent = k > 0 ? 'LOADING' : 'READY';
  }

  // target identification under the reticle
  let best = null, bd = Math.max(7, camera.fov * 0.9);
  for (const e of G.entities) {
    const d = Math.hypot(e.x - G.aim.x, e.z - G.aim.y);
    if (d < bd) { bd = d; best = e; }
  }
  let id = '';
  if (best && G.state === 'play') {
    const o = G.objectives.find((ob) => ob.type === best.type);
    id = best.def.name + (best.aa ? ' · MANPADS' : '') + '<br>' + (o && o.done < o.need
      ? `TASKED · ${WEAPONS[o.weapon].name}${o.weapon === G.weapon ? '' : '  ◄ SWITCH'}` : 'BONUS · ANY WEAPON');
  }
  if ($('tid').innerHTML !== id) $('tid').innerHTML = id;

  // radar (north up): tasked types bright, bonus dim
  const S = 170, c = S / 2, sc = (c - 6) / 345;
  radar.clearRect(0, 0, S, S);
  radar.fillStyle = 'rgba(0,0,0,.45)';
  radar.strokeStyle = 'rgba(230,230,230,.7)';
  radar.lineWidth = 1;
  radar.beginPath(); radar.arc(c, c, c - 2, 0, 6.3); radar.fill(); radar.stroke();
  radar.strokeStyle = 'rgba(230,230,230,.25)';
  radar.beginPath(); radar.arc(c, c, 150 * sc, 0, 6.3); radar.stroke();
  for (const e of G.entities) {
    const x = c + e.x * sc, y = c + e.z * sc, r = e.type === 'inf' ? 1 : e.type === 't72' || e.type === 'bmp' ? 3 : 2;
    const o = G.objectives.find((ob) => ob.type === e.type);
    radar.fillStyle = o && o.done < o.need ? '#fff' : '#6a6a6a';
    radar.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const ax = c + camera.position.x * sc, ay = c + camera.position.z * sc, tx = c + G.aim.x * sc, ty = c + G.aim.y * sc;
  radar.strokeStyle = 'rgba(230,230,230,.5)';
  radar.beginPath(); radar.moveTo(ax, ay); radar.lineTo(tx, ty); radar.stroke();
  radar.strokeStyle = '#fff';
  radar.beginPath(); radar.moveTo(tx - 5, ty); radar.lineTo(tx + 5, ty); radar.moveTo(tx, ty - 5); radar.lineTo(tx, ty + 5); radar.stroke();
  radar.fillStyle = '#fff';
  radar.beginPath(); radar.arc(ax, ay, 3, 0, 6.3); radar.fill();
  radar.fillStyle = 'rgba(230,230,230,.8)';
  radar.font = '10px monospace';
  radar.fillText('N', c - 3, 13);
}

// ---------------------------------------------------------------- enemy fire: MANPADS gunners and BMP cannon
const FLARE_COOL = 4, LAUNCH_GAP = 10; // seconds between flare salvos / between any two missile launches
const AF = { hp: 100, flareCool: 0, warnT: 0, hitRadioT: -99, nextLaunch: 0, missiles: [], tracers: [], flares: [], puffs: [] };
const gunshipPos = (v) => v.set(Math.cos(G.orbit) * ORBIT_R, ALT, Math.sin(G.orbit) * ORBIT_R);
const tmpG = new THREE.Vector3(), tmpD = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpSeg = new THREE.Line3();
// shared materials: one per projectile would stall the game while each compiles
const fadeU = uniform(1).onObjectUpdate(({ object }) => object.userData.fade ?? 1);
const trailMat = (() => {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0xcfcabe, transparent: true, depthWrite: false });
  const a = fadeU.mul(normalView.z.abs().pow(2.2)).mul(0.55);
  m.opacityNode = a;
  return thermalize(m, 0.32, a);
})();
const motorMat = fxMat(10, 7, 3.5, 1), tracerMat = fxMat(9, 3.4, 0.9, 1), flareMat = fxMat(14, 11, 7, 1);
const TRACER = new THREE.BoxGeometry(0.3, 0.3, 6);

function addShared(mesh) { mesh.userData.shared = true; scene.add(mesh); return mesh; }

function clearProjectiles() {
  for (const list of [AF.missiles, AF.tracers, AF.flares, AF.puffs]) { for (const o of list) scene.remove(o.mesh); list.length = 0; }
}
function resetThreats() {
  clearProjectiles();
  Object.assign(AF, { hp: 100, flareCool: 0, warnT: 0, hitRadioT: -99, nextLaunch: G.time + 12 }); // a quiet start
}

function damage(n, kind) {
  if (G.state !== 'play') return;
  AF.hp = Math.max(0, AF.hp - n);
  G.levelStats.damage += n;
  const big = kind === 'missile';
  G.shake = Math.max(G.shake, big ? 3.5 : 0.7);
  FXS.gain = Math.min(FXS.gain, big ? 0.3 : 0.85);
  FXS.tear = Math.max(FXS.tear, big ? 1 : 0.35);
  if (big) {
    sfx.airburst(); sfx.metal();
    radio(pick(["We're hit! Missile impact, number two engine.", 'Missile hit! Damage control, report.', "Impact! We're still flying."]));
  } else {
    sfx.hit();
    if (G.time - AF.hitRadioT > 8) { AF.hitRadioT = G.time; radio(pick(['Taking fire from the ground.', "Triple-A, we're taking hits.", 'Rounds through the fuselage.'])); }
  }
  if (AF.hp <= 0) {
    endState('over', 'GUNSHIP LOST', [
      ['MISSION REACHED', G.level], ['TARGETS DESTROYED', G.kills], ['FINAL SCORE', G.score],
    ], 'CLICK TO RE-ARM');
  } else if (AF.hp < 35 && AF.hp + n >= 35) radio('Airframe critical. Keep those launchers off us.');
}

function dropFlares() {
  if (AF.flareCool > 0 || G.state !== 'play') return;
  AF.flareCool = FLARE_COOL;
  gunshipPos(tmpG);
  for (let i = 0; i < 8; i++) {
    const mesh = addShared(new THREE.Mesh(GEO.sphere, flareMat));
    mesh.scale.setScalar(1.6);
    const p = tmpG.clone().add(tmpD.set(rand(-6, 6), rand(-8, -2), rand(-6, 6)));
    AF.flares.push({ mesh, p, v: new THREE.Vector3(rand(-14, 14), rand(-4, 6), rand(-14, 14)), t: i * 0.1, life: 4 });
  }
  // each tracking missile has a good chance of taking the bait
  for (const m of AF.missiles) if (!m.flare && Math.random() < 0.9) m.flare = pick(AF.flares);
  sfx.flare();
  radio('Flares, flares, flares.');
}

function launchMissile(e) {
  const y = groundY(e.x, e.z) + 2.6;
  const mesh = addShared(new THREE.Mesh(GEO.sphere, motorMat));
  mesh.scale.setScalar(0.8);
  const p = new THREE.Vector3(e.x, y, e.z);
  const v = gunshipPos(tmpG).clone().sub(p).normalize().multiplyScalar(35);
  const m = { mesh, p, v, t: 0, puffT: 0, flare: null };
  // flares still burning can seduce a fresh launch too
  const live = AF.flares.filter((f) => f.t < f.life - 1.5);
  if (live.length && Math.random() < 0.5) m.flare = pick(live);
  AF.missiles.push(m);
  particles.emit(e.x, y - 2, e.z, 12, { out: 6, up: 2, size: 0.7, life: 1.3, s0: 0.7, s1: 0.2 }); // back-blast
  sfx.missile();
  radio('Missile launch! Missile launch! Flares: F.');
}

function puff(p, size, life) {
  const mesh = addShared(new THREE.Mesh(GEO.sphere, trailMat));
  mesh.position.copy(p);
  AF.puffs.push({ mesh, t: 0, life, size });
}

function fireTracer(e) {
  const from = new THREE.Vector3(e.x, groundY(e.x, e.z) + 2.7, e.z);
  gunshipPos(tmpG);
  const dist = from.distanceTo(tmpG), hit = Math.random() < (e.alert > 0 ? 0.09 : 0.05);
  const to = tmpG.clone();
  if (!hit) to.add(tmpD.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(14, 40)));
  const mesh = addShared(new THREE.Mesh(TRACER, tracerMat));
  mesh.position.copy(from);
  mesh.lookAt(to);
  const speed = 420;
  AF.tracers.push({ mesh, p: from, v: to.sub(from).normalize().multiplyScalar(speed), t: 0, T: dist / speed, hit });
  const flash = addShared(new THREE.Mesh(GEO.sphere, tracerMat));
  flash.position.copy(from);
  addFx(flash, 0.07, (k) => flash.scale.setScalar(0.9 * (1 - k) + 0.1));
}

function updateAA(e, dt) {
  if (e.aiming > 0) {
    if (e.panic > 0) { e.aiming = 0; e.hold = 0; e.aaT = rand(5, 9); e.mesh.userData.aim?.(false); return; } // rounds landing close: run
    e.aiming -= dt;
    gunshipPos(tmpG);
    e.mesh.rotation.y = Math.atan2(tmpG.x - e.x, tmpG.z - e.z);
    if (e.aiming <= 0) {
      launchMissile(e);
      AF.nextLaunch = G.time + LAUNCH_GAP;
      e.aaT = rand(25, 40);
      e.hold = 0.8;
      later(0.8, () => { if (e.alive) e.mesh.userData.aim?.(false); });
    }
    return;
  }
  e.aaT -= dt;
  if (e.aaT <= 0 && !(e.panic > 0)) {
    if (AF.missiles.length || G.time < AF.nextLaunch || G.entities.some((o) => o.aiming > 0)) { e.aaT = rand(2, 4); return; }
    e.aiming = 2.4; e.hold = 3; // stop, shoulder the launcher, wait for lock
    e.mesh.userData.aim?.(true);
  }
}

function updateBmp(e, dt) {
  if (e.burst > 0) {
    if ((e.shotT -= dt) <= 0) { e.shotT = 0.11; e.burst--; fireTracer(e); }
    return;
  }
  if ((e.fireT -= dt) <= 0) {
    gunshipPos(tmpG);
    if (Math.hypot(tmpG.x - e.x, ALT, tmpG.z - e.z) < 700) { e.burst = irand(4, 7); e.shotT = 0; }
    e.fireT = e.alert > 0 ? rand(5, 8) : rand(9, 14);
  }
}

function updateThreats(dt) {
  AF.flareCool = Math.max(0, AF.flareCool - dt);
  for (const e of G.entities) {
    if (!e.alive) continue;
    if (e.aa) updateAA(e, dt);
    else if (e.type === 'bmp') updateBmp(e, dt);
  }
  gunshipPos(tmpG);
  // missiles: boost, then lead pursuit of the gunship (or of the flare they were seduced by),
  // with a limited turn rate; the fuze checks the closest approach along each step
  const shipVel = tmpV.set(-Math.sin(G.orbit), 0, Math.cos(G.orbit)).multiplyScalar(ORBIT_SPEED * ORBIT_R);
  for (let i = AF.missiles.length - 1; i >= 0; i--) {
    const m = AF.missiles[i];
    m.t += dt;
    const target = m.flare ? m.flare.p : tmpG;
    const speed = Math.min(150, 35 + m.t * 85);
    const tgo = m.p.distanceTo(target) / speed;
    tmpD.copy(target);
    if (!m.flare) tmpD.addScaledVector(shipVel, tgo);
    tmpD.sub(m.p).normalize();
    const dir = m.v.normalize();
    const q = tmpQ.setFromUnitVectors(dir, tmpD), angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    if (angle > 1e-4) dir.applyQuaternion(tmpQ2.identity().slerp(q, Math.min(1, (m.t < 0.4 ? 0.6 : 2.2) * dt / angle)));
    m.v.copy(dir).multiplyScalar(speed);
    tmpP.copy(m.p);
    m.p.addScaledVector(m.v, dt);
    m.mesh.position.copy(m.p);
    if ((m.puffT -= dt) <= 0) { m.puffT = 0.035; puff(m.p, 1.2, 2.6); }
    const d = tmpSeg.set(tmpP, m.p).closestPointToPoint(target, true, tmpC).distanceTo(target);
    if (!m.flare && d < 18) { damage(rand(25, 30), 'missile'); scene.remove(m.mesh); AF.missiles.splice(i, 1); }
    else if ((m.flare && d < 6) || m.t > 8) { // decoyed or out of fuel: airburst well clear of us
      puff(m.p, 6, 2); puff(m.p, 4, 1.6); sfx.airburst();
      scene.remove(m.mesh); AF.missiles.splice(i, 1);
    }
  }
  if (AF.missiles.some((m) => !m.flare) && (AF.warnT -= dt) <= 0) { AF.warnT = 0.4; sfx.warn(); }
  for (let i = AF.tracers.length - 1; i >= 0; i--) {
    const r = AF.tracers[i];
    r.t += dt;
    r.p.addScaledVector(r.v, dt);
    r.mesh.position.copy(r.p);
    if (r.hit && r.t >= r.T) { damage(rand(1.5, 2.5), 'cannon'); scene.remove(r.mesh); AF.tracers.splice(i, 1); }
    else if (r.t > r.T * 1.6) { scene.remove(r.mesh); AF.tracers.splice(i, 1); }
  }
  for (let i = AF.flares.length - 1; i >= 0; i--) {
    const f = AF.flares[i];
    f.t += dt;
    f.v.y -= 9 * dt; f.v.multiplyScalar(1 - dt * 0.8);
    f.p.addScaledVector(f.v, dt);
    f.mesh.position.copy(f.p);
    f.mesh.scale.setScalar(1.6 * Math.max(0.1, 1 - f.t / f.life));
    if (f.t >= f.life) { scene.remove(f.mesh); AF.flares.splice(i, 1); }
  }
  for (let i = AF.puffs.length - 1; i >= 0; i--) {
    const o = AF.puffs[i];
    o.t += dt;
    const k = o.t / o.life;
    o.mesh.scale.setScalar(o.size * (0.6 + 2.2 * Math.sqrt(k)));
    o.mesh.userData.fade = 1 - k;
    if (k >= 1) { scene.remove(o.mesh); AF.puffs.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (G.state === 'play') update(dt);
  else if (G.state !== 'paused') G.orbit += ORBIT_SPEED * dt;
  if (G.state !== 'paused') updateFx(dt);
  if (warmup && ++warmup.frames > 4) { scene.remove(warmup.group); warmup = null; }
  updateCamera(dt);
  drawHud();
  post.uniforms.uTime.value = now / 1000;
  post.uniforms.uFlash.value = Math.min(1, G.shake / 3 + FXS.lightning * 0.9);
  post.uniforms.uGain.value = FXS.gain;
  post.uniforms.uDefocus.value = FXS.defocus;
  post.uniforms.uTear.value = FXS.tear;
  post.render();
  requestAnimationFrame(frame);
}

// debug hooks (console / automated playtests)
G.debug = {
  backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2', get fire() { return !!flames; }, post, particles, FXS, fireStats: () => flames && JSON.parse(JSON.stringify(flames.sim.stats)),
  step(secs, dt = 1 / 30) { for (let t = 0; t < secs && G.state === 'play'; t += dt) { update(dt); updateFx(dt); } },
  startLevel, spawn, scene, camera, soldierMesh, AF, dropFlares,
};

await loadModels();
console.info(`Game ready after ${((performance.now() - T0) / 1000).toFixed(1)} s`);

// attract-mode backdrop behind the title screen
reseed();
G.world = buildWorld(scene, worldGroup, WEATHER[1], []);
applyWeatherLight(WEATHER[1]);
sensorLabel();
selectWeapon(1);
// draw one of each target behind the title screen for a few frames, so their shaders are
// compiled before the first mission instead of stalling it
let warmup = { group: new THREE.Group(), frames: 0 };
Object.keys(TYPES).forEach((t, i) => {
  const m = makeMesh(t), x = G.aim.x + (i - 2.5) * 10, z = G.aim.y;
  m.position.set(x, groundY(x, z), z);
  m.traverse((o) => { o.castShadow = true; });
  warmup.group.add(m);
});
const gunner = makeMesh('inf', true);
gunner.position.set(G.aim.x + 35, groundY(G.aim.x + 35, G.aim.y), G.aim.y);
warmup.group.add(gunner);
[trailMat, motorMat, tracerMat, flareMat].forEach((mat, i) => {
  const m = new THREE.Mesh(GEO.sphere, mat);
  m.position.set(G.aim.x + 40 + i * 3, groundY(G.aim.x, G.aim.y) + 5, G.aim.y);
  warmup.group.add(m);
});
scene.add(warmup.group);
requestAnimationFrame(frame);
