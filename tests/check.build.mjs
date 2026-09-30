// Check 1 and 2: tsc --noEmit and vite build exit codes.
import path from 'node:path';
import { repoRoot, buildDir, run, TSC, VITE } from './lib/util.mjs';

const tail = (text, n = 30) => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
};

export async function checkTypes() {
  const res = await run(process.execPath, [TSC, '--noEmit', '-p', path.join(repoRoot, 'tsconfig.json')], { timeout: 600000 });
  const failures = [];
  if (res.code !== 0) {
    failures.push(`tsc --noEmit exited ${res.code}\n${tail(res.stdout + res.stderr, 40)}`);
  }
  return {
    name: 'typescript: tsc --noEmit',
    passed: res.code === 0 ? 1 : 0,
    failures,
    warnings: [],
    note: res.code === 0 ? 'exit code 0' : `exit code ${res.code}`,
  };
}

export async function checkViteBuild() {
  // Output goes to the scratch dir so nothing outside tests/ and scripts/ is written.
  const outDir = path.join(buildDir, 'vite-out');
  const res = await run(
    process.execPath,
    [VITE, 'build', '--outDir', outDir, '--emptyOutDir'],
    { cwd: repoRoot, timeout: 600000 }
  );
  const failures = [];
  if (res.code !== 0) {
    failures.push(`vite build exited ${res.code}\n${tail(res.stdout + res.stderr, 40)}`);
  }
  const sizeLine = (res.stdout.split(/\r?\n/).find((l) => l.includes('built in')) || '').trim();
  return {
    name: 'vite build',
    passed: res.code === 0 ? 1 : 0,
    failures,
    warnings: [],
    note: res.code === 0 ? `exit code 0${sizeLine ? ` (${sizeLine})` : ''}` : `exit code ${res.code}`,
  };
}
