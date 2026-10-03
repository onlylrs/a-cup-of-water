import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5411 },
  preview: { port: 5412 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
