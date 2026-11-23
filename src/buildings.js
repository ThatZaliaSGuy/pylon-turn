// Destructible buildings. Each design is modelled as walls, floor slabs and a roof,
// pre-fractured into irregular chunks with three-pinata. An undamaged building is one
// merged mesh; the first hit swaps it for its chunks, and Rapier physics takes over:
// chunks near the blast are thrown, chunks that lose what was holding them up fall,
// and the rubble piles up where it lands.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { DestructibleMesh, FractureOptions } from '@dgreenheck/three-pinata';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Fn, attribute, mrt, uniform, float, vec2, vec3, vec4, fract, floor, abs, max, min, mix, step, smoothstep, pow, clamp, sin } from 'three/tsl';

await RAPIER.init();
const rand = (a, b) => a + Math.random() * (b - a);

// kind of surface a vertex belongs to (baked per vertex)
const K_RUBBLE = 0, K_FACADE = 1, K_INTERIOR = 2, K_ROOF = 3, K_SLAB = 4;
const STOREY = 3.0, WALL_T = 0.4;

// ---------------------------------------------------------------- designs
// w, d: footprint; storeys; roof: 'gable' | 'flat'; windows: facade openings on/off; wall / roof colours
const DESIGNS = [
  { w: 9, d: 7, storeys: 1, roof: 'gable', windows: true, wall: 0xd9d3c5, tile: 0x7a3f2e },
  { w: 11, d: 8, storeys: 2, roof: 'gable', windows: true, wall: 0xc9bfa9, tile: 0x5b3a30 },
  { w: 8, d: 8, storeys: 1, roof: 'gable', windows: true, wall: 0xb9c2c4, tile: 0x4a4d52 },
  { w: 13, d: 9, storeys: 2, roof: 'gable', windows: true, wall: 0xa0705a, tile: 0x3f3a38 },
  { w: 17, d: 10, storeys: 1, roof: 'gable', windows: false, wall: 0x8a8378, tile: 0x6d7378, tall: 5 },   // barn / workshop
  { w: 6, d: 5, storeys: 1, roof: 'flat', windows: false, wall: 0x9c948a, tile: 0x55575a },                // shed
  { w: 18, d: 11, storeys: 3, roof: 'flat', windows: true, wall: 0xbdb9b0, tile: 0x47494c },               // block
];

function fracture(geometry, count, axis, seed) {
  const src = new DestructibleMesh(geometry, new THREE.MeshBasicMaterial());
  return src.fracture(new FractureOptions({
    fractureMethod: 'voronoi', fragmentCount: count, seed,
    voronoiOptions: { mode: '2.5D', projectionAxis: axis },
  }));
}

/** Build one design: returns { pieces: [{geometry, centre, hull, supports, ground}], merged, radius, height }. */
function buildDesign(def, seed) {
  const pieces = [];
  const H = def.tall || def.storeys * STOREY;
  const tint = new THREE.Color(def.wall), tile = new THREE.Color(def.tile);

  // part: a box (sx, sy, sz) fractured through its thin `axis`, placed by `matrix` in building space
  const addPart = (sx, sy, sz, axis, matrix, kinds, color, count) => {
    const rot = new THREE.Matrix4().extractRotation(matrix);
    for (const frag of fracture(new THREE.BoxGeometry(sx, sy, sz), count, axis, seed++)) {
      let g = frag.geometry;
      if (g.index) g = g.toNonIndexed();
      g.clearGroups();
      const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count;
      const rest = new Float32Array(n * 3), kind = new Float32Array(n), col = new Float32Array(n * 3);
      const half = axis === 'z' ? sz / 2 : sy / 2;
      for (let i = 0; i < n; i++) {
        // rest position inside the un-fractured part: drives windows / tile rows wherever the chunk ends up
        const rx = pos.getX(i) + frag.position.x, ry = pos.getY(i) + frag.position.y, rz = pos.getZ(i) + frag.position.z;
        rest[i * 3] = rx + sx / 2; rest[i * 3 + 1] = ry + sy / 2; rest[i * 3 + 2] = rz;
        const along = axis === 'z' ? nrm.getZ(i) : nrm.getY(i), depth = axis === 'z' ? rz : ry;
        kind[i] = along > 0.9 && depth > half - 0.02 ? kinds[0] : along < -0.9 && depth < -half + 0.02 ? kinds[1] : K_RUBBLE;
        col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
      }
      g.setAttribute('rest', new THREE.BufferAttribute(rest, 3));
      g.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
      g.setAttribute('tint', new THREE.BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      g.applyMatrix4(rot);
      g.computeBoundingSphere();
      const centre = frag.position.clone().applyMatrix4(matrix);
      // physics hull: the chunk's own points pulled in slightly so neighbours don't start interpenetrating
      const hull = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { hull[i * 3] = pos.getX(i) * 0.93; hull[i * 3 + 1] = pos.getY(i) * 0.93; hull[i * 3 + 2] = pos.getZ(i) * 0.93; }
      pieces.push({ geometry: g, centre, hull, supports: [], ground: false, r: g.boundingSphere.radius });
    }
  };

  const M = (x, y, z, ry = 0, rx = 0) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ')).setPosition(x, y, z);
  const facade = [def.windows ? K_FACADE : K_SLAB, K_INTERIOR];
  const per = (area) => Math.max(5, Math.min(18, Math.round(area / 7)));

  // four walls, outside face = +z of each panel
  addPart(def.w, H, WALL_T, 'z', M(0, H / 2, def.d / 2, 0), facade, tint, per(def.w * H));
  addPart(def.w, H, WALL_T, 'z', M(0, H / 2, -def.d / 2, Math.PI), facade, tint, per(def.w * H));
  addPart(def.d - WALL_T, H, WALL_T, 'z', M(def.w / 2, H / 2, 0, Math.PI / 2), facade, tint, per(def.d * H));
  addPart(def.d - WALL_T, H, WALL_T, 'z', M(-def.w / 2, H / 2, 0, -Math.PI / 2), facade, tint, per(def.d * H));
  // intermediate floors
  for (let s = 1; s < def.storeys; s++) addPart(def.w - WALL_T, 0.3, def.d - WALL_T, 'y', M(0, s * STOREY, 0), [K_SLAB, K_SLAB], tint, per(def.w * def.d));
  // roof
  if (def.roof === 'flat') {
    addPart(def.w + 0.6, 0.35, def.d + 0.6, 'y', M(0, H + 0.17, 0), [K_ROOF, K_SLAB], tile, per(def.w * def.d));
  } else {
    const pitch = 0.5, run = def.d / 2 + 0.7, len = run / Math.cos(pitch), rise = Math.tan(pitch) * (def.d / 2);
    addPart(def.w + 1, 0.3, len, 'y', M(0, H + rise / 2, def.d / 4, 0, pitch), [K_ROOF, K_SLAB], tile, per(def.w * len));
    addPart(def.w + 1, 0.3, len, 'y', M(0, H + rise / 2, -def.d / 4, 0, -pitch), [K_ROOF, K_SLAB], tile, per(def.w * len));
  }

  // what holds each chunk up: chunks below it and near it. Chunks touching the ground hold themselves.
  for (const p of pieces) {
    p.ground = p.centre.y - p.r < 0.9;
    for (let j = 0; j < pieces.length; j++) {
      const o = pieces[j];
      if (o === p) continue;
      const dy = p.centre.y - o.centre.y, dh = Math.hypot(p.centre.x - o.centre.x, p.centre.z - o.centre.z);
      if (dy > 0.3 && dy < 4.2 && dh < p.r + o.r) p.supports.push(j);
    }
  }

  const merged = mergeGeometries(pieces.map((p) => p.geometry.clone().translate(p.centre.x, p.centre.y, p.centre.z)), false);
  merged.computeBoundingSphere();
  return { pieces, merged, radius: Math.hypot(def.w, def.d) / 2, height: H + (def.roof === 'gable' ? 3 : 0.5) };
}

// ---------------------------------------------------------------- one material for every wall, roof and chunk
function buildingMaterial() {
  const rest = attribute('rest', 'vec3'), kind = attribute('kind', 'float'), tint = attribute('tint', 'vec3');
  const hash = Fn(([p]) => { const q = fract(p.mul(vec2(0.1731, 0.2137))).toVar(); q.addAssign(q.dot(q.yx.add(31.73))); return fract(q.x.add(q.y).mul(q.x).mul(q.y).mul(3.1)); });
  const noise = Fn(([p]) => {
    const i = floor(p), f = fract(p), u = f.mul(f).mul(float(3).sub(f.mul(2)));
    return mix(mix(hash(i), hash(i.add(vec2(1, 0))), u.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x), u.y);
  });
  const is = (k) => float(1).sub(min(abs(kind.sub(k)).mul(4), 1)); // 1 where the vertex kind matches
  const lin = (c) => pow(c, vec3(2.2));

  // window grid on the facade: one opening per 3 m bay per storey, a door-height strip left solid at the corners
  const window_ = () => {
    const bay = fract(rest.x.div(3.0)), lvl = fract(rest.y.div(STOREY));
    const inX = step(0.27, bay).mul(step(bay, 0.73)), inY = step(0.32, lvl).mul(step(lvl, 0.78));
    const glass = inX.mul(inY);
    const frame = step(0.23, bay).mul(step(bay, 0.77)).mul(step(0.28, lvl)).mul(step(lvl, 0.82)).sub(glass);
    return { glass, frame };
  };

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  mat.colorNode = Fn(() => {
    const grime = noise(rest.xy.mul(0.9)).mul(0.5).add(noise(rest.xy.mul(4.3)).mul(0.5));       // weathering
    const streak = smoothstep(0.55, 0.9, noise(vec2(rest.x.mul(2.2), rest.y.mul(0.25))));         // rain streaks under the eaves
    const wall = tint.mul(grime.mul(0.35).add(0.75)).mul(float(1).sub(streak.mul(0.22)));
    const w = window_();
    const facade = mix(mix(wall, lin(vec3(0.82, 0.8, 0.76)), w.frame), lin(vec3(0.07, 0.09, 0.11)), w.glass);
    // roof: rows of tiles / sheets along the slope
    const row = fract(rest.z.mul(2.2)), tiles = tint.mul(row.mul(0.35).add(0.7)).mul(noise(rest.xz.mul(1.7)).mul(0.3).add(0.8));
    const slab = lin(vec3(0.55, 0.54, 0.52)).mul(grime.mul(0.3).add(0.8));
    const inner = lin(vec3(0.74, 0.72, 0.68)).mul(grime.mul(0.2).add(0.85));
    // broken faces: brick and mortar core
    const brick = mix(lin(vec3(0.52, 0.27, 0.2)), lin(vec3(0.6, 0.57, 0.52)), step(0.86, fract(rest.y.mul(4.0))).add(noise(rest.xy.mul(6)).mul(0.25)));
    return brick.mul(is(K_RUBBLE)).add(facade.mul(is(K_FACADE))).add(inner.mul(is(K_INTERIOR))).add(tiles.mul(is(K_ROOF))).add(slab.mul(is(K_SLAB)));
  })();
  mat.roughnessNode = Fn(() => mix(float(0.92), float(0.12), window_().glass.mul(is(K_FACADE))))(); // glass glints

  // thermal: sun-warmed masonry, cold glass, warm roof; `uHeat` adds heat after a hit
  const uHeat = uniform(0);
  mat.mrtNode = mrt({
    thermal: Fn(() => {
      const base = float(0.3).add(noise(rest.xy.mul(0.7)).mul(0.08));
      const t = base.mul(is(K_FACADE).add(is(K_INTERIOR)).add(is(K_SLAB))).add(float(0.4).mul(is(K_ROOF))).add(float(0.36).mul(is(K_RUBBLE))).toVar();
      t.assign(mix(t, 0.13, window_().glass.mul(is(K_FACADE))));
      return vec4(vec3(pow(clamp(t.add(uHeat), 0, 1), 2.2)), 1);
    })(),
  });
  return mat;
}

// ---------------------------------------------------------------- runtime
let designs = null, material = null;

/**
 * placements: [{x, z, y, rot, design}]. Returns { obstacles, blast(x, y, z, power), update(dt), dispose(), stats() }.
 * obstacles is the live list of standing buildings ({x, z, r}) for pathing.
 */
export function createBuildings(group, placements) {
  designs ??= DESIGNS.map((d, i) => buildDesign(d, 100 + i * 37));
  material ??= buildingMaterial();

  const physics = new RAPIER.World({ x: 0, y: -19.6, z: 0 });
  physics.timestep = 1 / 60;
  const buildings = placements.map((p) => {
    const design = designs[p.design % designs.length];
    const mesh = new THREE.Mesh(design.merged, material);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.rot;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.keep = true;
    mesh.updateMatrixWorld(true);
    group.add(mesh);
    return { x: p.x, z: p.z, y: p.y, r: design.radius + 1.5, design, mesh, chunks: null, standing: design.pieces.length, total: design.pieces.length, destroyed: false, quiet: 0, ground: null };
  });
  const obstacles = [...buildings];
  const pending = []; // delayed releases: { t, b, i }
  let acc = 0, live = 0;
  const v3 = new THREE.Vector3(), q4 = new THREE.Quaternion();

  // swap the merged mesh for individual chunks with fixed physics bodies
  function activate(b) {
    group.remove(b.mesh);
    b.mesh.getWorldQuaternion(q4);
    const quat = { x: q4.x, y: q4.y, z: q4.z, w: q4.w };
    b.ground = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.x, b.y - 1, b.z));
    physics.createCollider(RAPIER.ColliderDesc.cuboid(45, 1, 45).setFriction(0.9), b.ground);
    b.chunks = b.design.pieces.map((p) => {
      const mesh = new THREE.Mesh(p.geometry, material);
      mesh.position.copy(p.centre).applyMatrix4(b.mesh.matrixWorld);
      mesh.quaternion.copy(q4);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.keep = true;
      group.add(mesh);
      const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(mesh.position.x, mesh.position.y, mesh.position.z).setRotation(quat));
      const desc = RAPIER.ColliderDesc.convexHull(p.hull) || RAPIER.ColliderDesc.ball(p.r * 0.5);
      physics.createCollider(desc.setDensity(1.6).setFriction(0.8).setRestitution(0.05), body);
      return { mesh, body, loose: false };
    });
  }

  function release(b, i, impulse) {
    const c = b.chunks[i];
    if (c.loose) return;
    c.loose = true;
    b.standing--;
    b.quiet = 0;
    c.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    c.body.setLinearDamping(0.05);
    c.body.setAngularDamping(0.3);
    if (impulse) {
      const m = c.body.mass();
      c.body.applyImpulse({ x: impulse.x * m, y: impulse.y * m, z: impulse.z * m }, true);
      c.body.applyTorqueImpulse({ x: rand(-1, 1) * m * 3, y: rand(-1, 1) * m * 3, z: rand(-1, 1) * m * 3 }, true);
    }
    live++;
  }

  // anything that has lost most of what was under it comes down a moment later
  function checkSupport(b) {
    b.design.pieces.forEach((p, i) => {
      const c = b.chunks[i];
      if (c.loose || c.queued || p.ground || !p.supports.length) return;
      const held = p.supports.reduce((n, j) => n + (b.chunks[j].loose ? 0 : 1), 0);
      if (held / p.supports.length < 0.5) { c.queued = true; pending.push({ t: rand(0.12, 0.6), b, i }); }
    });
  }

  return {
    obstacles,

    /** power: 1 = 40 mm, 2 = 105 mm. Returns { hit: n chunks thrown, ruins: [{x, z, r}] newly destroyed, dust: [{x, y, z}] }. */
    blast(x, y, z, power) {
      const out = { hit: 0, ruins: [], dust: [] };
      const R = power === 2 ? 13 : 4.6, force = power === 2 ? 22 : 11;
      for (const b of buildings) {
        if (Math.hypot(b.x - x, b.z - z) > b.r + R) continue;
        if (!b.chunks) activate(b);
        let thrown = 0;
        b.chunks.forEach((c, i) => {
          if (c.loose) { // rubble already lying about gets kicked
            const p = c.body.translation(), d = Math.hypot(p.x - x, p.y - y, p.z - z);
            if (d < R) { const m = c.body.mass(), k = (force * 0.6 * (1 - d / R)) / (d || 1); c.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true); c.body.applyImpulse({ x: (p.x - x) * k * m, y: (Math.abs(p.y - y) + 2) * k * m, z: (p.z - z) * k * m }, true); b.quiet = 0; live++; }
            return;
          }
          v3.copy(c.mesh.position);
          const d = Math.hypot(v3.x - x, v3.y - y, v3.z - z);
          if (d > R) return;
          const k = (force * (1 - (d / R) * 0.7)) / (d || 1);
          release(b, i, { x: (v3.x - x) * k, y: (Math.abs(v3.y - y) + 1.5) * k * 0.8, z: (v3.z - z) * k });
          thrown++;
        });
        if (!thrown) continue;
        out.hit += thrown;
        out.dust.push({ x: b.x, y: b.y + 2, z: b.z });
        checkSupport(b);
        if (!b.destroyed && b.standing / b.total < 0.5) {
          b.destroyed = true;
          const k = obstacles.indexOf(b);
          if (k >= 0) obstacles.splice(k, 1);
          out.ruins.push({ x: b.x, z: b.z, r: b.r });
          // past the point of no return: the rest follows over the next second or so
          b.chunks.forEach((c, i) => { if (!c.loose && !c.queued && !b.design.pieces[i].ground) { c.queued = true; pending.push({ t: rand(0.3, 1.6), b, i }); } });
        }
      }
      return out;
    },

    update(dt) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if ((p.t -= dt) > 0) continue;
        pending.splice(i, 1);
        release(p.b, p.i, { x: rand(-1, 1), y: -1, z: rand(-1, 1) });
        checkSupport(p.b);
      }
      if (!live) return;
      acc = Math.min(acc + dt, 0.05);
      while (acc >= physics.timestep) { physics.step(); acc -= physics.timestep; }
      live = 0;
      for (const b of buildings) {
        if (!b.chunks) continue;
        let moving = 0;
        for (const c of b.chunks) {
          if (!c.loose || c.body.isFixed()) continue;
          if (c.body.isSleeping()) continue;
          moving++;
          const p = c.body.translation(), r = c.body.rotation();
          c.mesh.position.set(p.x, p.y, p.z);
          c.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        }
        b.quiet = moving ? 0 : b.quiet + dt;
        // settled rubble becomes part of the scenery again (but can still be kicked by the next round)
        if (b.quiet > 1.5) { for (const c of b.chunks) if (c.loose && !c.body.isFixed()) c.body.setBodyType(RAPIER.RigidBodyType.Fixed, true); }
        else live += moving;
      }
    },

    dispose() { physics.free(); },
    stats: () => ({ buildings: buildings.length, standing: obstacles.length, active: buildings.filter((b) => b.chunks).length, live, pending: pending.length }),
  };
}

export const DESIGN_COUNT = DESIGNS.length;
export const designRadius = (i) => Math.hypot(DESIGNS[i % DESIGNS.length].w, DESIGNS[i % DESIGNS.length].d) / 2;
