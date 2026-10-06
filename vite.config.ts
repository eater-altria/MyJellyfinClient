import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/.tmp/**',
        '**/.toolchain/**',
        '**/.npm-cache/**',
        '**/src-tauri/target/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/*.tmpdir/**',
      ],
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
