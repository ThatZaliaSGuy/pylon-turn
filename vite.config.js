import { defineConfig } from 'vite';

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages serves the site from /pylon-turn/; the dev server stays at /
  base: command === 'build' || isPreview ? '/pylon-turn/' : '/',
  // Serve three.js as native ES modules so 'three', 'three/webgpu' and 'three/tsl'
  // (and the libraries that import them) all share one copy.
  optimizeDeps: { exclude: ['three'] },
  resolve: { dedupe: ['three'] },
  build: { target: 'esnext' }, // top-level await
}));
