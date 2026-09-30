// Check 3: i18n parity.
//
// Coverage:
//   a. keys present in en but missing from ar (and ar keys missing from en)
//   b. EN drift: a call site's English fallback literal differs from the en
//      dictionary value for the same key (the copy the user sees depends on
//      which path resolves, so the two must agree)
//   c. placeholder mismatch: {name} tokens differ between en and ar
//
// The dictionary is read by compiling and importing the real
// src/constants/languages.ts, so the scan runs the shipped code rather than a
// second, private parse of it.
import path from 'node:path';
import {
  repoRoot,
  srcFiles,
  read,
  rel,
  maskComments,
  unquote,
  lineAt,
  compileToEsm,
  importCompiled,
} from './lib/util.mjs';

// tx('key', 'English fallback') and withFallback(t)('key', 'English fallback')
const TX_RE = /\b(?:tx|withFallback\s*\([^()]*\))\(\s*(['"])([^'"]+)\1\s*,\s*('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g;
// t('key')
const T_RE = /(?<![A-Za-z0-9_.$])t\(\s*(['"])([^'"]+)\1\s*\)/g;
// getTranslation('key', ...)
const GET_RE = /\bgetTranslation\(\s*(['"])([^'"]+)\1/g;

const PLACEHOLDER_RE = /\{[A-Za-z0-9_]+\}/g;
const placeholders = (s) => (String(s).match(PLACEHOLDER_RE) || []).sort().join(' ');

export async function checkI18n() {
  const c = { name: 'i18n parity (en/ar)', passed: 0, failures: [], warnings: [], note: '' };

  const [compiled] = await compileToEsm([path.join(repoRoot, 'src', 'constants', 'languages.ts')]);
  const { TRANSLATIONS } = await importCompiled(compiled);
  const en = TRANSLATIONS.en || {};
  const ar = TRANSLATIONS.ar || {};
  const enKeys = Object.keys(en);
  const arKeys = Object.keys(ar);
  const enSet = new Set(enKeys);
  const arSet = new Set(arKeys);

  // a. key parity
  const missingAr = enKeys.filter((k) => !arSet.has(k));
  const orphanAr = arKeys.filter((k) => !enSet.has(k));
  if (missingAr.length === 0 && orphanAr.length === 0) {
    c.passed++;
  } else {
    c.failures.push(
      `en/ar key parity: ${missingAr.length} en key(s) missing from ar, ${orphanAr.length} ar key(s) missing from en` +
        (missingAr.length ? `\n    missing in ar: ${missingAr.slice(0, 25).join(', ')}` : '') +
        (orphanAr.length ? `\n    missing in en: ${orphanAr.slice(0, 25).join(', ')}` : '')
    );
  }

  // c. placeholder parity
  const phMismatches = enKeys
    .filter((k) => arSet.has(k))
    .map((k) => ({ k, en: placeholders(en[k]), ar: placeholders(ar[k]) }))
    .filter((x) => x.en !== x.ar);
  if (phMismatches.length === 0) {
    c.passed++;
  } else {
    c.failures.push(
      `placeholder mismatch between en and ar for ${phMismatches.length} key(s): ` +
        phMismatches.slice(0, 25).map((x) => `${x.k} [en: ${x.en || 'none'}] [ar: ${x.ar || 'none'}]`).join('; ')
    );
  }

  // b. call sites: static keys must exist in en, and the EN fallback literal
  // must match the en dictionary value.
  const usedKeys = new Set();
  const drift = [];
  let txCalls = 0;
  let tCalls = 0;
  for (const file of srcFiles()) {
    const src = read(file);
    const masked = maskComments(src);
    const where = (idx) => `${rel(file)}:${lineAt(masked, idx)}`;

    TX_RE.lastIndex = 0;
    let m;
    while ((m = TX_RE.exec(masked))) {
      txCalls++;
      const key = m[2];
      const fallback = unquote(m[3]) ?? '';
      usedKeys.add(key);
      if (!enSet.has(key)) {
        c.failures.push(`unknown i18n key ${key} at ${where(m.index)} (tx call, not present in TRANSLATIONS.en)`);
      } else if (fallback !== '' && en[key] !== fallback) {
        drift.push({ where: where(m.index), key, fallback, dict: en[key] });
      }
    }
    T_RE.lastIndex = 0;
    while ((m = T_RE.exec(masked))) {
      tCalls++;
      usedKeys.add(m[2]);
      if (!enSet.has(m[2])) {
        c.failures.push(`unknown i18n key ${m[2]} at ${where(m.index)} (t() call, not present in TRANSLATIONS.en)`);
      }
    }
    GET_RE.lastIndex = 0;
    while ((m = GET_RE.exec(masked))) {
      usedKeys.add(m[2]);
      if (!enSet.has(m[2])) {
        c.failures.push(`unknown i18n key ${m[2]} at ${where(m.index)} (getTranslation call, not present in TRANSLATIONS.en)`);
      }
    }
  }

  const unknownCount = c.failures.length;
  if (unknownCount === 0) c.passed++;

  if (drift.length === 0) {
    c.passed++;
  } else {
    c.failures.push(
      `EN drift: ${drift.length} call site(s) where the English fallback literal differs from TRANSLATIONS.en:` +
        drift.map((d) => `\n    ${d.where} key=${d.key}\n      fallback: ${d.fallback}\n      en       : ${d.dict}`).join('')
    );
  }

  // Unused dictionary keys are a maintenance smell, not a failure.
  const unused = enKeys.filter((k) => !usedKeys.has(k));
  if (unused.length) {
    c.warnings.push(`${unused.length} en key(s) never referenced by a static call site (may be dynamic or dead): ${unused.slice(0, 15).join(', ')}${unused.length > 15 ? ', ...' : ''}`);
  }

  c.note = `${enKeys.length} en keys, ${arKeys.length} ar keys, ${txCalls} tx call sites, ${tCalls} t() call sites, ${usedKeys.size} distinct keys used, ${drift.length} drift, ${phMismatches.length} placeholder mismatch`;
  return c;
}
