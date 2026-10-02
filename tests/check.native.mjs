// Check 8: the APK-embedded extras module stays byte-identical to device-patch/.
// The phone patch ships whatever is in android assets, so a fix applied only
// to device-patch/ (or only to assets/) would silently diverge.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, rel } from './lib/util.mjs';

export function checkNativeAssets() {
  const name = 'native asset parity (extras py)';
  const failures = [];
  const canonical = path.join(repoRoot, 'device-patch', 'api_server_mobile_extras.py');
  const asset = path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets', 'api_server_mobile_extras.py');
  if (!fs.existsSync(canonical)) {
    failures.push(`${rel(canonical)} is missing`);
  } else if (!fs.existsSync(asset)) {
    failures.push(`${rel(asset)} is missing (fresh installs ship without the memory/blueprint routes)`);
  } else {
    const a = fs.readFileSync(canonical, 'utf8');
    const b = fs.readFileSync(asset, 'utf8');
    if (a !== b) failures.push(`${rel(asset)} differs from ${rel(canonical)} (re-copy it: cp device-patch/api_server_mobile_extras.py android/app/src/main/assets/)`);
  }
  return {
    name,
    passed: failures.length === 0 ? 1 : 0,
    failures,
    warnings: [],
    note: failures.length ? 'asset out of sync' : 'asset matches device-patch',
  };
}
