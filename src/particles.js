// Lightweight ballistic particles: dirt, sparks, dust trails and water spray.
// One InstancedMesh of small chunks, simulated on the CPU (a few hundred live at most).
import * as THREE from 'three/webgpu';
import { instancedDynamicBufferAttribute } from 'three/tsl';
import { groundY } from './world.js';
import { particleMaterial } from './shaders.js';

const MAX = 1400;
const rand = (a, b) => a + Math.random() * (b - a);

export function createParticles(scene) {
  const heat = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
  const mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), particleMaterial(instancedDynamicBufferAttribute(heat, 'float')), MAX);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  const live = []; // {x,y,z,vx,vy,vz,t,life,size,s0,s1,g,drag,spin,land}
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();

  /**
   * n particles from (x, y, z). out/up: horizontal and vertical speed; s0 -> s1: thermal shade over life.
   * land: stop on the ground instead of sinking through it.
   */
  function emit(x, y, z, n, { out = 6, up = 8, size = 0.5, life = 1.2, s0 = 1, s1 = 0.2, g = 20, drag = 0.4, jitter = 0.5, dirX = 0, dirZ = 0, land = true } = {}) {
    for (let i = 0; i < n && live.length < MAX; i++) {
      const a = rand(0, 6.283), sp = out * rand(0.25, 1);
      live.push({
        x: x + rand(-jitter, jitter), y, z: z + rand(-jitter, jitter),
        vx: Math.cos(a) * sp + dirX, vy: up * rand(0.35, 1), vz: Math.sin(a) * sp + dirZ,
        t: 0, life: life * rand(0.6, 1.2), size: size * rand(0.6, 1.3), s0, s1, g, drag, spin: rand(0, 6.283), land,
      });
    }
  }

  function update(dt) {
    let n = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const o = live[i];
      o.t += dt;
      if (o.t >= o.life) { live[i] = live[live.length - 1]; live.pop(); continue; }
      const k = Math.max(0, 1 - o.drag * dt);
      o.vx *= k; o.vz *= k;
      o.vy -= o.g * dt;
      o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt;
      if (o.land && o.vy < 0) {
        const gy = groundY(o.x, o.z) + 0.2;
        if (o.y < gy) { o.y = gy; o.vx = o.vy = o.vz = 0; o.g = 0; }
      }
    }
    for (const o of live) {
      const f = o.t / o.life, sz = o.size * (1 - f * f);
      p.set(o.x, o.y, o.z);
      s.setScalar(sz);
      e.set(o.spin + o.t * 5, o.spin, 0);
      mesh.setMatrixAt(n, m4.compose(p, q.setFromEuler(e), s));
      heat.array[n] = o.s0 + (o.s1 - o.s0) * f;
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    heat.needsUpdate = true;
  }

  return {
    emit, update,
    clear() { live.length = 0; mesh.count = 0; },
    get count() { return live.length; },

    // ---- presets
    dirt(x, z, power) { // thrown earth: cool clods, a few hot fragments
      const y = groundY(x, z) + 0.5, n = [3, 18, 70][power];
      emit(x, y, z, n, { out: [4, 9, 20][power], up: [6, 13, 26][power], size: [0.3, 0.55, 0.9][power], life: [0.7, 1.4, 2.4][power], s0: 0.5, s1: 0.16, jitter: [0.5, 1.5, 4][power] });
      emit(x, y, z, Math.ceil(n / 4), { out: [5, 11, 24][power], up: [7, 15, 30][power], size: 0.3, life: [0.5, 1, 1.6][power], s0: 1, s1: 0.5 });
    },
    sparks(x, z, n = 10, up = 12) { // hits on armour, cook-offs
      emit(x, groundY(x, z) + 1.5, z, n, { out: 9, up, size: 0.28, life: 0.9, s0: 1, s1: 0.7, g: 24, jitter: 1 });
    },
    spray(x, z, power) { // water is cold: dark spray column
      emit(x, groundY(x, z) + 0.3, z, [4, 24, 70][power], { out: [2, 4, 8][power], up: [8, 18, 34][power], size: [0.4, 0.7, 1.1][power], life: [0.8, 1.6, 2.6][power], s0: 0.02, s1: 0.06, g: 22, land: false, jitter: [0.5, 1.5, 3][power] });
    },
    dust(x, z, vx, vz) { // kicked up behind a moving vehicle: slightly warm, hangs briefly
      emit(x, groundY(x, z) + 0.4, z, 1, { out: 0.8, up: 1.6, size: 1.1, life: 1.5, s0: 0.46, s1: 0.3, g: 0.6, drag: 1.5, dirX: -vx * 0.15, dirZ: -vz * 0.15, land: false, jitter: 1 });
    },
  };
}
