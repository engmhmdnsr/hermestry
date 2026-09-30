// Shared helpers for scripts/verify.mjs and the tests/ check modules.
// Node builtins only. No new dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const buildDir = path.join(repoRoot, 'tests', '.build');
export const generatedDir = path.join(buildDir, 'generated');

export function rel(p) {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}

/** Recursive file listing. */
export function walk(dir, { exts = null, skipDirs = ['.git', 'node_modules'] } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), { exts, skipDirs }));
    } else if (!exts || exts.includes(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

export function srcFiles(exts = ['.ts', '.tsx']) {
  return walk(path.join(repoRoot, 'src'), { exts });
}

export function read(p) {
  return fs.readFileSync(p, 'utf8');
}

export function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Mask line and block comments with spaces, preserving every offset and every
 * newline, so line numbers computed on the result still match the source.
 * String literals are tracked (and left intact) so a "//" inside a string is
 * not mistaken for a comment.
 */
export function maskComments(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  const blank = (k) => {
    if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        blank(i);
        blank(i + 1);
        i += 2;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        i++;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        blank(i);
        blank(i + 1);
        state = 'code';
        i += 2;
        continue;
      }
      blank(i);
      i++;
      continue;
    }
    // inside a string literal
    if (c === '\\') {
      blank(i);
      if (i + 1 < n && src[i + 1] !== '\n') blank(i + 1);
      i += 2;
      continue;
    }
    if (state === 'single' && c === "'") state = 'code';
    else if (state === 'double' && c === '"') state = 'code';
    else if (state === 'template' && c === '`') state = 'code';
    i++;
  }
  return out.join('');
}

const STRING_RE = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/gs;

/**
 * Every string literal in masked source, with offsets and 1-based line numbers.
 * Offsets are valid for both masked and original text because masking preserves
 * length.
 */
export function stringLiterals(masked) {
  const out = [];
  STRING_RE.lastIndex = 0;
  let m;
  while ((m = STRING_RE.exec(masked))) {
    out.push({ raw: m[0], start: m.index, end: m.index + m[0].length, line: lineAt(masked, m.index) });
  }
  return out;
}

/** Unquoted value of a simple quoted literal, or null for template/complex ones. */
export function unquote(raw) {
  const q = raw[0];
  if (q !== "'" && q !== '"') return null;
  return raw.slice(1, -1).replace(/\\(.)/g, (all, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

/** Child process helper. Never throws; resolves with code/stdout/stderr. */
export function run(cmd, args, { cwd = repoRoot, timeout = 600000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: stderr + '\n[harness] timed out', timedOut: true, cmd: `${cmd} ${args.join(' ')}` });
    }, timeout);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -2, stdout, stderr: String(err), cmd: `${cmd} ${args.join(' ')}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, cmd: `${cmd} ${args.join(' ')}` });
    });
  });
}

export const TSC = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
export const VITE = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * Compile standalone TypeScript sources to ESM .js under tests/.build and
 * return the emitted file paths. Uses the repo's own typescript install.
 */
export async function compileToEsm(sources, outDir = buildDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    TSC,
    '--module', 'esnext',
    '--target', 'es2022',
    '--moduleResolution', 'bundler',
    '--skipLibCheck',
    '--strict',
    '--noEmitOnError',
    '--outDir', outDir,
    ...sources,
  ];
  const res = await run(process.execPath, args, { timeout: 300000 });
  if (res.code !== 0) {
    const err = new Error(`tsc compile failed for ${sources.join(', ')}\n${res.stdout}${res.stderr}`);
    err.result = res;
    throw err;
  }
  return sources.map((s) => path.join(outDir, path.basename(s).replace(/\.tsx?$/, '.js')));
}

export async function importCompiled(file) {
  return import(pathToFileURL(file).href);
}

/** Relative paths of every text file under a root (used by the Android scan). */
export function listTextFiles(rootDir) {
  return walk(rootDir, { exts: null }).filter((p) => {
    if (/\.(png|jpg|jpeg|webp|gif|ttf|otf|woff2?|mp4|apk|jar|keystore|so|pdf|webmanifest|class)$/i.test(p)) return false;
    const buf = fs.readFileSync(p);
    const len = Math.min(buf.length, 4096);
    for (let i = 0; i < len; i++) if (buf[i] === 0) return false;
    return true;
  });
}
