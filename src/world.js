// Procedural, destructible world: terrain with craters and burn scars, villages
// that shatter (three-pinata), ez-tree forests that can be felled, and weather.
// Rebuilt for every mission.
import * as THREE from 'three/webgpu';
import { DestructibleMesh, FractureOptions } from '@dgreenheck/three-pinata';
import { Tree, TreePreset } from '@dgreenheck/ez-tree';
import { createBuildings, DESIGN_COUNT, designRadius } from './buildings.js';
import { uTime, terrainMaterial, waterMaterial, cloudMaterial, thermalize, HOT_SLOTS } from './shaders.js';

export const WORLD = 900;   // terrain edge length
export const WATER = -15;   // lake surface height
const SEG = 150, CELL = WORLD / SEG;

const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- noise
let seed = 1;
const craters = []; // {x, z, r, depth}
/** Pick a new map. Call before generating routes, then buildWorld(). */
export function reseed() {
  seed = (Math.random() * 1e9) | 0;
  craters.length = 0;
}
function hash(ix, iz) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 144269507)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function fbm(x, z) {
  return (vnoise(x, z) * 0.5 + vnoise(x * 2.1 + 7, z * 2.1 + 3) * 0.25 + vnoise(x * 4.3 + 1, z * 4.3 + 9) * 0.125) / 0.875;
}

// ---------------------------------------------------------------- height field (with craters)
function craterDelta(x, z) {
  let d = 0;
  for (let i = 0; i < craters.length; i++) {
    const c = craters[i], dx = x - c.x, dz = z - c.z, R = c.r * 1.8;
    if (dx > R || dx < -R || dz > R || dz < -R) continue;
    const q = Math.hypot(dx, dz) / c.r;
    if (q < 1) { const k = 1 - q * q; d -= c.depth * k * k; }                             // bowl
    if (q < 1.8) { const k = (q - 1.05) / 0.3; d += c.depth * 0.22 * Math.exp(-k * k); }  // thrown-up rim
  }
  return d;
}
export function terrainHeight(x, z) {
  return (fbm(x / 170 + 40, z / 170 + 40) - 0.5) * 90 + craterDelta(x, z);
}
/** Height things stand on (never below the water surface). */
export function groundY(x, z) {
  return Math.max(terrainHeight(x, z), WATER);
}
export function isLand(x, z) {
  return terrainHeight(x, z) > WATER + 2;
}
export function groundNormal(x, z, out) {
  const e = 2;
  return out.set(groundY(x - e, z) - groundY(x + e, z), 2 * e, groundY(x, z - e) - groundY(x, z + e)).normalize();
}
/** Random land point between rMin and rMax of the map centre. */
export function landPoint(rMin, rMax) {
  for (let i = 0; i < 60; i++) {
    const a = rand(0, 6.283), r = rand(rMin, rMax);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (isLand(x, z)) return { x, z };
  }
  return { x: 0, z: 0 };
}

// ---------------------------------------------------------------- weather
export const WEATHER = [
  // fog: [sky/haze colour, near, far] for the colour camera; irHaze: contrast lost in the thermal picture
  { id: 'CLEAR', cover: 0, fog: [0xa9bfd6, 500, 4200], sun: 3.2, sky: 1.0, irHaze: 0, rain: false, time: 1 },
  { id: 'SCATTERED CLOUD', cover: 0.5, fog: [0xa9bfd6, 500, 4200], sun: 2.6, sky: 1.0, irHaze: 0, rain: false, time: 1.1 },
  { id: 'HAZE', cover: 0.3, fog: [0xbcc4c6, 140, 1250], sun: 2.0, sky: 1.2, irHaze: 0.22, rain: false, time: 1.1 },
  { id: 'OVERCAST / RAIN', cover: 0.78, fog: [0x717c84, 150, 1000], sun: 0.5, sky: 1.3, irHaze: 0.3, rain: true, time: 1.2 },
];

// ---------------------------------------------------------------- pre-fractured shards (three-pinata)
// Fracturing is done once on unit shapes; every building / tree reuses the shards, scaled to fit.
function makeShards(geometry, count) {
  const src = new DestructibleMesh(geometry, new THREE.MeshBasicMaterial());
  const frags = src.fracture(new FractureOptions({ fractureMethod: 'voronoi', fragmentCount: count, voronoiOptions: { mode: '3D' }, seed: 7 }));
  return frags.map((f) => {
    const g = f.geometry, c = new THREE.Vector3();
    g.computeBoundingBox();
    g.boundingBox.getCenter(c);
    g.translate(-c.x, -c.y, -c.z);
    g.clearGroups();
    return { geometry: g, centre: c.add(f.position) };
  });
}
let trunkShards = null, town = null;

// ---------------------------------------------------------------- ez-tree variants
let treeVariants = null;
function makeTreeVariants() {
  const variants = [];
  for (const name of ['Pine Medium', 'Oak Medium', 'Ash Medium', 'Aspen Medium']) {
    const o = structuredClone(TreePreset[name]);
    // seen from 300 m up: keep the silhouette, drop the polygon count
    o.branch.levels = Math.min(o.branch.levels, 2);
    for (const k of Object.keys(o.branch.sections)) o.branch.sections[k] = Math.max(2, Math.round(o.branch.sections[k] * 0.35));
    for (const k of Object.keys(o.branch.segments)) o.branch.segments[k] = 3;
    o.branch.children[0] = Math.min(o.branch.children[0], 22);
    if (o.branch.children[1]) o.branch.children[1] = Math.min(o.branch.children[1], 3);
    o.leaves.count = Math.min(o.leaves.count, 5);
    o.leaves.size *= 1.9;
    const tree = new Tree();
    tree.loadFromJson(o);
    const branches = tree.branchesMesh.geometry, leaves = tree.leavesMesh.geometry;
    branches.computeBoundingBox();
    const height = branches.boundingBox.max.y || 1;
    variants.push({
      branches, leaves, norm: 1 / height,
      // ez-tree's own bark and leaf textures by day; cold canopy in IR
      bark: thermalize(new THREE.MeshStandardNodeMaterial({ map: tree.branchesMesh.material.map, roughness: 1 }), 0.17),
      leaf: thermalize(new THREE.MeshStandardNodeMaterial({ map: tree.leavesMesh.material.map, color: 0xc8d8b0, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 1 }), 0.08),
      tris: ((branches.index?.count || 0) + (leaves.index?.count || 0)) / 3,
    });
  }
  return variants;
}

// ---------------------------------------------------------------- build
const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3();
const WALLS = [0xd8d2c4, 0xc4bba9, 0x9a6a55, 0xcfc9bb, 0x8f8a80, 0xb7a58a]; // plaster, render, brick, concrete
const UP = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Builds a fresh map into `group` (disposing whatever was there).
 * Returns { obstacles, update(dt), blast(x, z, power), scorch(x, z, r), stats() }.
 */
export function buildWorld(scene, group, weather, tracks) {
  trunkShards ??= makeShards(new THREE.CylinderGeometry(0.4, 0.55, 6, 6), 4);
  treeVariants ??= makeTreeVariants();

  // dispose previous map (shared shard / tree resources are kept)
  town?.dispose();
  const shared = new Set(trunkShards.map((s) => s.geometry));
  for (const v of treeVariants) { shared.add(v.branches); shared.add(v.leaves); shared.add(v.bark); shared.add(v.leaf); }
  group.traverse((o) => {
    if (o.userData.keep) return; // buildings share geometry and material across missions
    if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
    if (o.material && !shared.has(o.material)) o.material.dispose();
  });
  group.clear();

  // ---- terrain mesh
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();

  // ---- surfacing is TSL (shaders.js). This map carries R = vehicle tracks, G = burn scars.
  const S = 1024, canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d');
  const px = (w) => (w / WORLD + 0.5) * S;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#f00';
  g.lineJoin = g.lineCap = 'round';
  for (const t of tracks) {
    g.lineWidth = t.width;
    g.beginPath();
    t.pts.forEach((p, i) => (i ? g.lineTo(px(p.x), px(p.z)) : g.moveTo(px(p.x), px(p.z))));
    if (t.closed) g.closePath();
    g.stroke();
  }
  g.globalCompositeOperation = 'lighter';
  const mapTex = new THREE.CanvasTexture(canvas);
  mapTex.anisotropy = 8;
  let mapDirty = false, mapTimer = 0;

  const hot = Array.from({ length: HOT_SLOTS }, () => new THREE.Vector4(0, 0, 1, -1e4));
  let hotIdx = 0;
  const addHot = (x, z, r) => { hot[hotIdx].set(x, z, r, uTime.value); hotIdx = (hotIdx + 1) % HOT_SLOTS; };
  const addBurn = (x, z, r, a) => {
    const cx = px(x), cy = px(z), cr = Math.max(1.5, (r / WORLD) * S);
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, cr);
    gr.addColorStop(0, `rgba(0,255,0,${a})`);
    gr.addColorStop(0.6, `rgba(0,255,0,${a * 0.7})`);
    gr.addColorStop(1, 'rgba(0,255,0,0)');
    g.fillStyle = gr;
    g.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
    mapDirty = true;
  };

  const ground = new THREE.Mesh(geo, terrainMaterial(mapTex, seed % 97, WATER, WORLD, hot));
  ground.receiveShadow = true;
  group.add(ground);

  function addCrater(x, z, r, depth) {
    craters.push({ x, z, r, depth });
    const R = r * 1.8 + CELL;
    const i0 = Math.max(0, Math.floor((x - R + WORLD / 2) / CELL)), i1 = Math.min(SEG, Math.ceil((x + R + WORLD / 2) / CELL));
    const j0 = Math.max(0, Math.floor((z - R + WORLD / 2) / CELL)), j1 = Math.min(SEG, Math.ceil((z + R + WORLD / 2) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * (SEG + 1) + i, vx = pos.getX(k), vz = pos.getZ(k);
        pos.setY(k, terrainHeight(vx, vz));
        p3.set(terrainHeight(vx - CELL, vz) - terrainHeight(vx + CELL, vz), 2 * CELL, terrainHeight(vx, vz - CELL) - terrainHeight(vx, vz + CELL)).normalize();
        nrm.setXYZ(k, p3.x, p3.y, p3.z);
      }
    }
    pos.needsUpdate = nrm.needsUpdate = true;
  }

  // ---- water: cold, with drifting swell and glints
  const water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD, WORLD).rotateX(-Math.PI / 2), waterMaterial(new THREE.Color(weather.fog[0])));
  water.position.y = WATER;
  group.add(water);

  // ---- villages: placed here, modelled and destroyed in buildings.js
  const placements = [];
  const nVillages = 3 + ((Math.random() * 3) | 0);
  for (let v = 0; v < nVillages; v++) {
    const centre = landPoint(30, 270), n = 6 + ((Math.random() * 12) | 0), street = rand(0, 3.14);
    for (let i = 0, tries = 0; i < n && tries < 200; tries++) {
      const a = rand(0, 6.283), r = rand(0, 62);
      const x = centre.x + Math.cos(a) * r, z = centre.z + Math.sin(a) * r;
      const design = (Math.random() * DESIGN_COUNT) | 0, rad = designRadius(design);
      if (!isLand(x, z) || placements.some((o) => Math.hypot(o.x - x, o.z - z) < o.rad + rad + 4)) continue;
      // sit on the lowest corner so no wall floats; houses loosely follow the village's street direction
      const y = Math.min(groundY(x, z), groundY(x + rad, z), groundY(x - rad, z), groundY(x, z + rad), groundY(x, z - rad)) - 0.15;
      if (groundY(x, z) - y > 2.2) continue; // too steep to build on
      placements.push({ x, z, y, rad, design, rot: street + (Math.random() < 0.5 ? 0 : Math.PI / 2) + rand(-0.12, 0.12) });
      i++;
    }
  }
  town = createBuildings(group, placements);
  const obstacles = town.obstacles;

  // ---- forests: ez-tree variants, instanced; clumped by a second noise field
  const PER = 170, trees = [];
  const forest = treeVariants.map((v) => {
    const b = new THREE.InstancedMesh(v.branches, v.bark, PER), l = new THREE.InstancedMesh(v.leaves, v.leaf, PER);
    b.count = l.count = 0;
    b.frustumCulled = l.frustumCulled = false;
    b.castShadow = l.castShadow = true;
    group.add(b, l);
    return { b, l, norm: v.norm };
  });
  for (let tries = 0; trees.length < PER * forest.length && tries < 14000; tries++) {
    const x = rand(-WORLD / 2, WORLD / 2), z = rand(-WORLD / 2, WORLD / 2);
    if (!isLand(x, z) || fbm(x / 110 + 200, z / 110 + 200) < 0.54) continue;
    if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 3)) continue;
    const f = forest[trees.length % forest.length], idx = f.b.count, height = rand(9, 17);
    p3.set(x, terrainHeight(x, z) - 0.4, z);
    q4.setFromAxisAngle(UP, rand(0, 6.283));
    s3.setScalar(height * f.norm);
    m4.compose(p3, q4, s3);
    f.b.setMatrixAt(idx, m4);
    f.l.setMatrixAt(idx, m4);
    f.b.count = f.l.count = idx + 1;
    trees.push({ x, z, f, idx, height, alive: true });
  }

  // ---- weather
  scene.fog = new THREE.Fog(...weather.fog);
  scene.background = new THREE.Color(weather.fog[0]);
  const windA = rand(0, 6.283), windV = rand(6, 16);
  const wind = { x: Math.cos(windA) * windV, z: Math.sin(windA) * windV };
  if (weather.cover > 0) { // two noise decks at different heights give parallax as the aircraft orbits
    for (const [y, scale] of [[150, 300], [100, 210]]) {
      const deck = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), cloudMaterial(weather.cover, wind, scale, weather.rain));
      deck.position.y = y;
      deck.renderOrder = 10;
      group.add(deck);
    }
  }

  // ---- debris: shards fly ballistically, land, and cool
  const debris = [];
  function throwShards(shards, origin, quat, scale, material, bx, bz, force, pick = 1) {
    for (const s of shards) {
      if (Math.random() > pick) continue;
      const mesh = new THREE.Mesh(s.geometry, material);
      mesh.castShadow = true;
      mesh.scale.copy(scale);
      mesh.quaternion.copy(quat);
      mesh.position.copy(s.centre).multiply(scale).applyQuaternion(quat).add(origin);
      const dx = mesh.position.x - bx, dz = mesh.position.z - bz, dl = Math.hypot(dx, dz) || 1, sp = rand(0.3, 1) * force;
      group.add(mesh);
      debris.push({
        mesh, vx: (dx / dl) * sp, vz: (dz / dl) * sp, vy: rand(0.4, 1.1) * force,
        axis: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(), spin: rand(-5, 5), rest: false,
      });
    }
    while (debris.length > 500) group.remove(debris.shift().mesh);
  }

  function fellTree(t, bx, bz, force) {
    t.alive = false;
    t.f.b.setMatrixAt(t.idx, ZERO);
    t.f.l.setMatrixAt(t.idx, ZERO);
    t.f.b.instanceMatrix.needsUpdate = t.f.l.instanceMatrix.needsUpdate = true;
    p3.set(t.x, groundY(t.x, t.z) + t.height * 0.3, t.z);
    s3.set(1, t.height / 10, 1);
    q4.identity();
    throwShards(trunkShards, p3, q4, s3, treeVariants[0].bark, bx, bz, force * 0.7, 0.75);
  }

  return {
    obstacles,

    /** A round lands. power: 0 = 25 mm, 1 = 40 mm, 2 = 105 mm. Returns what it wrecked. */
    blast(x, z, power) {
      const out = { ruins: [], trees: 0, felled: [], dust: [] };
      if (power === 0) { addBurn(x, z, 2.2, 0.35); return out; }
      const big = power === 2;
      if (terrainHeight(x, z) > WATER - 2) addCrater(x, z, big ? 15 : 5, big ? 4 : 1.1);
      addBurn(x, z, big ? 24 : 8, big ? 0.9 : 0.6);
      addHot(x, z, big ? 24 : 8);
      const hit = town.blast(x, groundY(x, z) + 1.2, z, power);
      out.dust = hit.dust;
      for (const r of hit.ruins) { out.ruins.push(r); addBurn(r.x, r.z, r.r * 1.2, 0.5); addHot(r.x, r.z, r.r); }
      const reach = big ? 21 : 6.5;
      for (const t of trees) {
        if (t.alive && Math.abs(t.x - x) < reach && Math.abs(t.z - z) < reach && Math.hypot(t.x - x, t.z - z) < reach) { fellTree(t, x, z, big ? 24 : 12); out.trees++; out.felled.push(t); }
      }
      return out;
    },

    /** Burning wreck: scorch the ground and leave it glowing. */
    scorch(x, z, r) { addBurn(x, z, r, 0.7); addHot(x, z, r); },

    update(dt) {
      uTime.value += dt;
      mapTimer -= dt;
      if (mapDirty && mapTimer <= 0) { mapTex.needsUpdate = true; mapDirty = false; mapTimer = 0.2; }
      for (const d of debris) {
        if (d.rest) continue;
        d.vy -= 22 * dt;
        d.mesh.position.x += d.vx * dt;
        d.mesh.position.y += d.vy * dt;
        d.mesh.position.z += d.vz * dt;
        d.mesh.rotateOnAxis(d.axis, d.spin * dt);
        const gy = groundY(d.mesh.position.x, d.mesh.position.z) + 0.5;
        if (d.vy < 0 && d.mesh.position.y <= gy) { d.mesh.position.y = gy; d.rest = true; }
      }
      town.update(dt);
    },

    stats: () => ({ trees: trees.length, treeTris: treeVariants.map((v) => v.tris), debris: debris.length, craters: craters.length, buildings: obstacles.length, town: town.stats() }),
  };
}
