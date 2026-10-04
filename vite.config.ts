import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

// The About card used to hardcode "1.3.0" while the APK shipped 1.3.1, so the
// app told the user it was older than it was. Single source of truth is
// package.json, injected so the string can never drift again.
const appVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    strictPort: true,
    watch: {
      ignored: ['**/.gradle/**', '**/debug.keystore*', '**/build/**', '**/.build-outputs/**'],
    },
  },
});
