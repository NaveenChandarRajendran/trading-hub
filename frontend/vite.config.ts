import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds ONE self-contained dist/index.html that opens by double-click (no server, no Node).
export default defineConfig({ base: './', plugins: [react(), viteSingleFile()] });
