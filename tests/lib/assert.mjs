// Minimal assertion counter: every check module reports how many assertions it
// actually executed, so the harness can print real pass/fail counts.
export function makeCounter() {
  let passed = 0;
  const failures = [];
  const warnings = [];

  const fail = (label, detail = '') => {
    failures.push(detail ? `${label}: ${detail}` : label);
  };

  return {
    get passed() {
      return passed;
    },
    get failed() {
      return failures.length;
    },
    failures,
    warnings,
    ok(condition, label, detail = '') {
      if (condition) passed++;
      else fail(label, detail);
      return !!condition;
    },
    eq(actual, expected, label) {
      if (Object.is(actual, expected)) passed++;
      else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      return Object.is(actual, expected);
    },
    includes(haystack, needle, label) {
      if (typeof haystack === 'string' && haystack.includes(needle)) passed++;
      else fail(label, `expected ${JSON.stringify(String(haystack)).slice(0, 160)} to contain ${JSON.stringify(needle)}`);
      return typeof haystack === 'string' && haystack.includes(needle);
    },
    excludes(haystack, needle, label) {
      if (typeof haystack === 'string' && !haystack.includes(needle)) passed++;
      else fail(label, `expected ${JSON.stringify(String(haystack)).slice(0, 160)} to NOT contain ${JSON.stringify(needle)}`);
      return typeof haystack === 'string' && !haystack.includes(needle);
    },
    warn(msg) {
      warnings.push(msg);
    },
  };
}
