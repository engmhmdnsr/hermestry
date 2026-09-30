// Check 8: dead code signals. Exported symbols in src/ that no other code
// references are reported as warnings, never as failures, because a symbol can
// be reached dynamically or kept for API surface.
import { srcFiles, read, rel, maskComments, lineAt } from './lib/util.mjs';

const DECL_RE = /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const REEXPORT_RE = /export\s*(?:type\s*)?\{[^}]*\}\s*from/g;
const NAMED_EXPORT_RE = /export\s*(?:type\s*)?\{([^}]*)\}/g;

export function checkDeadCode() {
  const name = 'dead code signals (exported symbols with zero callers)';
  const files = srcFiles();
  const masked = new Map();
  for (const f of files) masked.set(f, maskComments(read(f)));

  // collect exported symbols per file
  const decls = []; // {name, file, line}
  const namedExports = []; // from export { a, b as c }
  for (const [f, src] of masked) {
    let m;
    DECL_RE.lastIndex = 0;
    while ((m = DECL_RE.exec(src))) {
      decls.push({ name: m[1], file: f, line: lineAt(src, m.index) });
    }
    NAMED_EXPORT_RE.lastIndex = 0;
    while ((m = NAMED_EXPORT_RE.exec(src))) {
      if (REEXPORT_RE.test(m[0])) continue;
      for (const part of m[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        if (!bits.length) continue;
        const exported = (bits[bits.length - 1] || '').replace(/\/\*.*?\*\//g, '').trim();
        const local = (bits[0] || '').trim();
        if (exported) namedExports.push({ name: exported, local, file: f, line: lineAt(src, m.index) });
      }
    }
  }

  // count references
  const warnings = [];
  let checked = 0;
  const seen = new Set();
  for (const d of decls) {
    if (seen.has(d.name + '@' + d.file)) continue;
    seen.add(d.name + '@' + d.file);
    checked++;
    const re = new RegExp(`(?<![A-Za-z0-9_$])${d.name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`, 'g');
    let refs = 0;
    const where = [];
    for (const [f, src] of masked) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const line = lineAt(src, m.index);
        const lineText = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index));
        const isOwnDecl = f === d.file && line === d.line && /export\s/.test(lineText);
        const isReexport = /^\s*export\s*(?:type\s*)?\{[^}]*\}\s*from/.test(lineText);
        if (isOwnDecl || isReexport) continue;
        refs++;
        if (where.length < 3) where.push(`${rel(f)}:${line}`);
      }
    }
    if (refs === 0) {
      warnings.push(`possible dead export: ${d.name} declared at ${rel(d.file)}:${d.line} has no reference anywhere in src/`);
    }
  }
  // named exports that are not declarations (export { a, b as c })
  for (const e of namedExports) {
    const isDecl = decls.some((d) => d.name === e.name && d.file === e.file);
    if (isDecl) continue;
    checked++;
    const re = new RegExp(`(?<![A-Za-z0-9_$])${e.name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`, 'g');
    let refs = 0;
    for (const [f, src] of masked) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const line = lineAt(src, m.index);
        const lineText = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index) === -1 ? src.length : src.indexOf('\n', m.index));
        if (f === e.file && line === e.line) continue;
        if (/^\s*export\s*(?:type\s*)?\{[^}]*\}\s*from/.test(lineText)) continue;
        refs++;
      }
    }
    if (refs === 0) {
      warnings.push(`possible dead re-export: ${e.name} exported at ${rel(e.file)}:${e.line} has no reference anywhere in src/`);
    }
  }

  return {
    name,
    passed: 1, // warnings only, never a failure
    failures: [],
    warnings,
    note: `${checked} exported symbol(s) checked, ${warnings.length} with zero references (warnings only)`,
  };
}
