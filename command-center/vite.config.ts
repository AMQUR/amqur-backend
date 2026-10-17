import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served same-origin by the API at /cc/ (see backend src/main.ts). Dev: proxies /api to :3001.
export default defineConfig({
  base: '/cc/',
  plugins: [react()],
  server: { port: 5180, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
});
