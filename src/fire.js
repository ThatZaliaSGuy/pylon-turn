// Volumetric fire and smoke via Fire Pro (GPU fluid simulation). It needs the
// renderer's real WebGPU backend; on the WebGL 2 fallback this returns null and
// the game simply shows glowing wrecks instead.
const MAX_FIRES = 8;

export async function createFire(renderer, scene) {
  if (!renderer.backend?.isWebGPUBackend) return null;
  const { FireSimulation } = await import('threejs-fire-pro');

  // Coarse voxels: fires are several metres across and seen from ~400 m.
  const sim = new FireSimulation({
    voxelSize: 0.5, velocityDivisor: 2, smokeDivisor: 2,
    grid: { maxVoxels: 1_500_000, ground: false },
    flame: { lifespan: 2.4, brightness: 4 },
    smoke: { dissipation: 0.45, color: '#3c3c3c' },
    lighting: { illuminateScene: false },
    rendering: { halfResolution: true, raySteps: 48, filter: 'trilinear' },
  });
  scene.add(sim);
  await sim.initialize(renderer);

  // The volume must not take scene fog (haze / rain would tint its whole bounding bricks).
  const noFog = () => sim.traverse((o) => { if (o.material) o.material.fog = false; });
  noFog();

  const fires = []; // { emitter, t }
  let broken = false;
  const burstBig = sim.addExplosion({ radius: 7, outwardSpeed: 16, charge: { flame: 1, heat: 30, smoke: 8 } });
  const burstSmall = sim.addExplosion({ radius: 3, outwardSpeed: 9, charge: { flame: 1, heat: 14, smoke: 3 } });

  return {
    sim,
    /** A fire that burns for `secs` seconds. */
    burn(x, y, z, radius, secs) {
      if (broken) return;
      if (fires.length >= MAX_FIRES) fires.shift().emitter.remove();
      const emitter = sim.addFire({ shape: { type: 'sphere', radius: Math.min(radius, 16) } });
      emitter.object.position.set(x, y, z);
      fires.push({ emitter, t: secs });
      noFog();
    },
    /** A one-off fireball. */
    burst(x, y, z, big) {
      if (broken) return;
      (big ? burstBig : burstSmall).trigger({ worldPosition: [x, y, z] });
    },
    update(dt) {
      if (broken) return;
      try {
        for (let i = fires.length - 1; i >= 0; i--) {
          if ((fires[i].t -= dt) <= 0) fires.splice(i, 1)[0].emitter.remove();
        }
        sim.update(dt);
      } catch (err) { // never let the fire simulation take the game loop down
        broken = true;
        sim.visible = false;
        console.warn('Fire Pro disabled after an error:', err);
      }
    },
    reset() {
      for (const f of fires) f.emitter.remove();
      fires.length = 0;
      sim.reset();
    },
  };
}
