/// <reference types="vite/client" />

// Injected by vite.config.ts from package.json so the About card cannot drift
// away from the version the APK actually ships.
declare const __APP_VERSION__: string;