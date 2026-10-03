// Release endpoint scan (P0): fail when a dev/staging backend URL is
// baked into the web bundle source. The account service base URL must be
// a permanent origin before any store release; a temporary tunnel hostname
// dies with the tunnel process and bricks auth on already-installed apps.
// Usage: node scripts/scan-dev-endpoints.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

const BANNED = [
  /trycloudflare\.com/,
  /ngrok\.io/,
  /\.onion\//,
  /localhost:8082/,
  /100\.112\.74\.9/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

let failures = 0;
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) {
      console.error(`BANNED endpoint ${m[0]} in ${file}`);
      failures += 1;
    }
  }
}
if (failures > 0) {
  console.error(`\nFAIL: ${failures} banned endpoint(s). Set a permanent auth origin first.`);
  process.exit(1);
}
console.log('OK: no dev/staging endpoints in src.');
