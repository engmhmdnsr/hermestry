// Checks 4, 5 and 6: static scans.
//   4. zero em dashes in src/** and android/app/src/main/**
//   5. zero raw hex colors outside src/constants/themes.ts and src/index.css
//   6. zero '...' inside user facing string literals
import path from 'node:path';
import {
  repoRoot,
  srcFiles,
  read,
  rel,
  lineAt,
  maskComments,
  stringLiterals,
  walk,
  listTextFiles,
} from './lib/util.mjs';

const EM_DASH = '\u2014'; // the character this harness itself must never write
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

const HEX_ALLOWED = new Set(['src/constants/themes.ts', 'src/index.css']);

export function checkEmDash() {
  const name = 'no em dash characters';
  const failures = [];
  const files = [
    ...srcFiles(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json', '.md']),
    ...listTextFiles(path.join(repoRoot, 'android', 'app', 'src', 'main')),
  ];
  let scanned = 0;
  for (const f of files) {
    scanned++;
    const src = read(f);
    if (!src.includes(EM_DASH)) continue;
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (l.includes(EM_DASH)) {
        failures.push(`${rel(f)}:${i + 1} contains the em dash character: ${l.trim().slice(0, 120)}`);
      }
    });
  }
  return {
    name,
    passed: failures.length === 0 ? 1 : 0,
    failures,
    warnings: [],
    note: `${scanned} files scanned, ${failures.length} line(s) with em dashes`,
  };
}

export function checkRawHex() {
  const name = 'no raw hex colors outside themes.ts / index.css';
  const failures = [];
  const files = srcFiles(['.ts', '.tsx', '.js', '.jsx', '.css']);
  let scanned = 0;
  for (const f of files) {
    const r = rel(f);
    if (HEX_ALLOWED.has(r)) continue;
    scanned++;
    const src = read(f);
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      HEX_RE.lastIndex = 0;
      let m;
      while ((m = HEX_RE.exec(l))) {
        failures.push(`${r}:${i + 1} raw hex color ${m[0]} in ${l.trim().slice(0, 110)}`);
      }
    });
  }
  return {
    name,
    passed: failures.length === 0 ? 1 : 0,
    failures,
    warnings: [],
    note: `${scanned} files scanned (allowed: ${[...HEX_ALLOWED].join(', ')}), ${failures.length} raw hex value(s)`,
  };
}

/**
 * User facing text is: values inside the TRANSLATIONS dictionary, literals
 * passed to the translation helpers, JSX text nodes, and the JSX attributes
 * that render as copy (placeholder, title, alt, aria-label, label).
 */
export function checkEllipsis() {
  const name = 'no three dot ellipsis in user facing strings';
  const failures = [];
  const info = { dict: 0, call: 0, jsxText: 0, jsxAttr: 0, skipped: 0 };

  for (const f of srcFiles()) {
    const r = rel(f);
    const src = read(f);
    const masked = maskComments(src);

    // spans of user facing literals
    const spans = [];
    const di = src.indexOf('export const TRANSLATIONS');
    if (di >= 0) {
      const end = src.indexOf('\n};', di);
      if (end > di) spans.push({ start: di, end, kind: 'dict' });
    }
    const pushArgs = (re, kind) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(masked))) {
        const literal = m[m.length - 1];
        const start = m.index + m[0].length - literal.length;
        spans.push({ start, end: start + literal.length, kind });
      }
    };
    pushArgs(/\b(?:tx|withFallback\s*\([^()]*\))\(\s*['"][^'"]+['"]\s*,\s*('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g, 'call');
    pushArgs(/(?<![A-Za-z0-9_.$])t\(\s*('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")\s*\)/g, 'call');
    pushArgs(/\bgetTranslation\(\s*('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g, 'call');

    for (const lit of stringLiterals(masked)) {
      if (!lit.raw.includes('...')) continue;
      const inDict = spans.find((s) => s.kind === 'dict' && lit.start > s.start && lit.start < s.end);
      if (inDict) {
        // only dictionary values, not the comment text above the object
        const before = masked.slice(inDict.start, lit.start);
        const tail = before.slice(before.lastIndexOf('\n') + 1);
        if (/^\s*[A-Za-z0-9_]+:\s*$/.test(tail)) {
          info.dict++;
          failures.push(`${r}:${lit.line} dictionary value uses '...': ${lit.raw.slice(0, 100)}`);
          continue;
        }
      }
      const inCall = spans.find((s) => s.kind === 'call' && lit.start >= s.start && lit.start < s.end);
      if (inCall) {
        info.call++;
        failures.push(`${r}:${lit.line} translation argument uses '...': ${lit.raw.slice(0, 100)}`);
        continue;
      }
      info.skipped++;
    }

    // JSX text nodes, e.g. <span>Loading...</span>
    const textRe = />([^<>{}]*\.{3}[^<>{}]*)</g;
    let m;
    while ((m = textRe.exec(masked))) {
      const text = m[1].trim();
      if (!text) continue;
      info.jsxText++;
      failures.push(`${r}:${lineAt(masked, m.index)} JSX text uses '...': ${text.slice(0, 100)}`);
    }

    // JSX attributes that render as copy
    const attrRe = /\b(placeholder|title|alt|aria-label|label)\s*=\s*('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g;
    while ((m = attrRe.exec(masked))) {
      if (!m[2].includes('...')) continue;
      info.jsxAttr++;
      failures.push(`${r}:${lineAt(masked, m.index)} JSX attribute ${m[1]} uses '...': ${m[2].slice(0, 100)}`);
    }
  }

  return {
    name,
    passed: failures.length === 0 ? 1 : 0,
    failures,
    warnings: [],
    note: `${failures.length} user facing string(s) with '...' (${info.dict} dictionary, ${info.call} call argument, ${info.jsxText} JSX text, ${info.jsxAttr} JSX attribute), ${info.skipped} non user facing literal(s) skipped`,
  };
}
