import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds ONE self-contained dist/index.html, served by the backend at http://127.0.0.1:8000 (ADR 0008). Opened by
// double-click it only shows "Start the backend and open http://127.0.0.1:8000" (login needs the backend's origin).
// Dev server: /api and /ws go to the backend, so the session cookie is same-origin there too.
const BACKEND = process.env.VITE_BACKEND ?? 'http://127.0.0.1:8000';
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  server: { proxy: { '/api': { target: BACKEND }, '/ws': { target: BACKEND.replace(/^http/, 'ws'), ws: true } } },
});
