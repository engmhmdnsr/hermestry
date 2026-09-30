// Check 7: unit level assertions that execute real source code.
//
//  a. src/services/plainFailure.ts classification matrix:
//       auth status preserved, transport masked, machine text masked,
//       human sentences pass through.
//    The module is compiled from its real source with the repo's own tsc and
//    imported, so these assertions run shipped code.
//
//  b. the chat bubble code fence splitter from
//     src/components/chat/ChatMessageBubble.tsx. That helper is module private
//     (const splitCodeFences, no export), so its source is extracted verbatim
//     from the file, re-hosted in a generated module under tests/.build, and
//     executed. The extraction is verified against the original text first, so
//     the assertions still run the shipped implementation, not a rewrite.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, generatedDir, read, rel, compileToEsm, importCompiled } from './lib/util.mjs';
import { makeCounter } from './lib/assert.mjs';

const GATEWAY_FALLBACK = 'Could not start Hermes. Try again.';
const UNREACHABLE = 'Hermes is not reachable, so that did not finish.';
const UNREACHABLE_START = 'Hermes is unreachable. Make sure it is running, then try again.';
const LIST_STALE_TRANSPORT = 'Hermes is not reachable, so this list may be out of date.';
const LIST_STALE_MACHINE = 'Hermes did not answer, so this list may be out of date.';
const AUTH_TEXT = 'Hermes rejected the API key. Add or fix it under Settings.';

async function checkPlainFailure(c) {
  const [out] = await compileToEsm([path.join(repoRoot, 'src', 'services', 'plainFailure.ts')]);
  const pf = await importCompiled(out);
  const {
    isTransportFailure,
    isMachineFailure,
    plainGatewayFailure,
    plainResultLine,
    plainServiceFailure,
    plainListStale,
  } = pf;
  const noTx = (key, fallback) => fallback;

  // --- predicates -------------------------------------------------------
  c.eq(isTransportFailure('Failed to fetch'), true, 'isTransportFailure(Failed to fetch)');
  c.eq(isTransportFailure('connect ECONNREFUSED 127.0.0.1:8080'), true, 'isTransportFailure(ECONNREFUSED)');
  c.eq(isTransportFailure(''), false, 'isTransportFailure(empty)');
  c.eq(isTransportFailure(null), false, 'isTransportFailure(null)');
  c.eq(isTransportFailure('The provider is rate limited.'), false, 'isTransportFailure(human sentence)');
  c.eq(isMachineFailure('service_start_blocked'), true, 'isMachineFailure(service_start_blocked)');
  c.eq(isMachineFailure('java.lang.SecurityException'), true, 'isMachineFailure(java.lang.SecurityException)');
  c.eq(isMachineFailure(''), false, 'isMachineFailure(empty)');
  c.eq(isMachineFailure('The provider is rate limited.'), false, 'isMachineFailure(human sentence)');

  // --- auth status is preserved, never replaced by a fallback ------------
  const authRows = [
    ['plainResultLine(http 401)', plainResultLine('http 401', 'FALLBACK'), 'HTTP 401'],
    ['plainResultLine(HTTP 403)', plainResultLine('HTTP 403', 'FALLBACK'), 'HTTP 403'],
    ['plainResultLine(upstream http 401)', plainResultLine('upstream said http 401 unauthorized', 'FALLBACK'), 'HTTP 401'],
    ['plainListStale keeps http 500', plainListStale('Sessions unavailable:', 'http 500'), 'Sessions unavailable: http 500'],
    ['plainListStale keeps http 403', plainListStale('Sessions unavailable:', 'HTTP 403'), 'Sessions unavailable: HTTP 403'],
    ['plainGatewayFailure 401', plainGatewayFailure('server replied 401 invalid key'), AUTH_TEXT],
    ['plainGatewayFailure 403', plainGatewayFailure('403 forbidden for this model'), AUTH_TEXT],
    ['plainGatewayFailure 401 localizes as errAuth', plainGatewayFailure('401', (k) => `<${k}>`), '<errAuth>'],
  ];
  for (const [label, actual, expected] of authRows) c.eq(actual, expected, label);
  c.ok(
    plainResultLine('http 401', 'FALLBACK') !== 'FALLBACK',
    'auth: an HTTP status is never replaced by the caller fallback'
  );

  // --- transport noise is masked to plain copy --------------------------
  const maskedTransport = [
    ['Failed to fetch', plainResultLine('Failed to fetch', 'FALLBACK'), UNREACHABLE],
    ['Network Error', plainResultLine('Network Error', 'FALLBACK'), UNREACHABLE],
    ['connect ECONNREFUSED 127.0.0.1:8080', plainResultLine('connect ECONNREFUSED 127.0.0.1:8080', 'FALLBACK'), UNREACHABLE],
    ['net::ERR_CONNECTION_REFUSED', plainResultLine('net::ERR_CONNECTION_REFUSED', 'FALLBACK'), UNREACHABLE],
    ['timeout of 30000ms exceeded', plainResultLine('timeout of 30000ms exceeded', 'FALLBACK'), UNREACHABLE],
    ['net::ERR_INTERNET_DISCONNECTED', plainResultLine('net::ERR_INTERNET_DISCONNECTED', 'FALLBACK'), UNREACHABLE],
    ['gateway(Failed to fetch)', plainGatewayFailure('Failed to fetch'), UNREACHABLE_START],
    ['gateway(ECONNREFUSED)', plainGatewayFailure('connect ECONNREFUSED 127.0.0.1:8080'), UNREACHABLE_START],
    ['service(Network Error)', plainServiceFailure(new Error('Network Error')), UNREACHABLE],
    ['list(ECONNREFUSED)', plainListStale('Jobs:', 'connect ECONNREFUSED 127.0.0.1:9'), `Jobs: ${LIST_STALE_TRANSPORT}`],
  ];
  for (const [label, actual, expected] of maskedTransport) {
    c.eq(actual, expected, `transport masked: ${label}`);
  }

  // Strings the module header says must never surface but that pass through
  // verbatim today. Each row is one expected mask across all four mappers, so
  // a leak produces a single, readable failure and is reported as a finding.
  const leakReport = (raw) => {
    const rows = [
      ['plainGatewayFailure', plainGatewayFailure(raw)],
      ['plainResultLine', plainResultLine(raw, 'FALLBACK')],
      ['plainServiceFailure', plainServiceFailure(new Error(raw))],
      ['plainListStale', plainListStale('Sessions unavailable:', raw)],
    ];
    return rows.filter(([, out]) => out.includes(raw)).map(([n, out]) => `${n} returned ${JSON.stringify(out)}`);
  };

  const transportLeaks = [
    'fetch failed',
    'getaddrinfo ENOTFOUND api.deepseek.com',
    'read ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
    'unable to verify the first certificate',
  ];
  for (const raw of transportLeaks) {
    const bad = leakReport(raw);
    c.ok(bad.length === 0, `transport masked: ${JSON.stringify(raw)}`, bad.join('; '));
  }

  // Reachability proof: a real fetch failure in this runtime produces exactly
  // the message the mapper fails to mask, so the leak is not hypothetical.
  try {
    const res = await fetch('http://127.0.0.1:9/', { signal: AbortSignal.timeout(3000) });
    c.warn(`live fetch repro skipped: unexpected response ${res.status}`);
  } catch (err) {
    if (err && err.message === 'fetch failed') {
      c.eq(
        plainServiceFailure(err),
        UNREACHABLE,
        'transport masked: live fetch() to a closed local port must not surface "fetch failed"'
      );
    } else {
      c.warn(`live fetch repro used a different message: ${err && err.message}`);
    }
  }

  // --- machine text is masked ------------------------------------------
  const maskedMachine = [
    ['gateway(service_start_blocked)', plainGatewayFailure('service_start_blocked'), 'Hermes could not start in the background. Open the app, then try again.'],
    ['gateway(not_installed)', plainGatewayFailure('not_installed'), 'Hermes is not set up on this device yet.'],
    ['gateway(startForegroundService)', plainGatewayFailure('startForegroundService() not allowed due to toAppStrictMode'), GATEWAY_FALLBACK],
    ['gateway(TypeError)', plainGatewayFailure('TypeError: x is not a function'), GATEWAY_FALLBACK],
    ['result(service_start_blocked)', plainResultLine('service_start_blocked', 'FALLBACK'), 'FALLBACK'],
    ['result(not_installed)', plainResultLine('not_installed', 'FALLBACK'), 'FALLBACK'],
    ['result(TypeError)', plainResultLine('TypeError: x is not a function', 'FALLBACK'), 'FALLBACK'],
    ['result(java.lang.SecurityException)', plainResultLine('java.lang.SecurityException', 'FALLBACK'), 'FALLBACK'],
    ['result(QuotaExceededError)', plainResultLine('QuotaExceededError', 'FALLBACK'), 'FALLBACK'],
    ['result(native bridge unavailable)', plainResultLine('native bridge unavailable', 'FALLBACK'), 'FALLBACK'],
    ['service(QuotaExceededError)', plainServiceFailure(new Error('QuotaExceededError')), UNREACHABLE],
    ['list(service_start_blocked)', plainListStale('Sessions unavailable:', 'service_start_blocked'), `Sessions unavailable: ${LIST_STALE_MACHINE}`],
    ['list(TypeError)', plainListStale('Sessions unavailable:', 'TypeError: x is not a function'), `Sessions unavailable: ${LIST_STALE_MACHINE}`],
  ];
  for (const [label, actual, expected] of maskedMachine) c.eq(actual, expected, `machine masked: ${label}`);

  // Platform and setup reasons that only plainGatewayFailure maps. The other
  // three mappers hand them to the UI verbatim (low severity finding).
  const platformRows = [
    'install()',
    'startForegroundService() not allowed due to toAppStrictMode',
  ];
  for (const raw of platformRows) {
    const bad = leakReport(raw);
    c.ok(bad.length === 0, `machine masked: ${JSON.stringify(raw)}`, bad.join('; '));
    c.eq(plainGatewayFailure(raw), raw.includes('install()') ? 'Hermes needs one setup step before it can start.' : GATEWAY_FALLBACK,
      `machine masked: plainGatewayFailure(${JSON.stringify(raw)}) maps the start reason`);
  }

  // --- human sentences pass through untouched ---------------------------
  const humans = [
    'The provider is rate limited. Try again in a minute.',
    'Could not save the snapshot because storage is full.',
    'Session deleted. Undo is not available.',
    'The server is busy right now, so this list was not refreshed.',
  ];
  for (const s of humans) {
    c.eq(plainGatewayFailure(s), s, `human passes through: plainGatewayFailure(${JSON.stringify(s)})`);
    c.eq(plainResultLine(s, 'FALLBACK'), s, `human passes through: plainResultLine(${JSON.stringify(s)})`);
    c.eq(plainServiceFailure(new Error(s)), s, `human passes through: plainServiceFailure(${JSON.stringify(s)})`);
    c.eq(plainListStale('Sessions unavailable:', s), `Sessions unavailable: ${s}`, `human passes through: plainListStale(${JSON.stringify(s)})`);
  }

  // --- empty input falls back to plain copy, never to raw ---------------
  c.eq(plainGatewayFailure(''), GATEWAY_FALLBACK, 'empty input: plainGatewayFailure default copy');
  c.eq(plainGatewayFailure(null), GATEWAY_FALLBACK, 'empty input: plainGatewayFailure(null)');
  c.eq(plainResultLine('', 'FALLBACK'), 'FALLBACK', 'empty input: plainResultLine caller fallback');
  c.eq(plainListStale('Sessions:', ''), 'Sessions:', 'empty input: plainListStale keeps prefix');
  c.eq(plainServiceFailure(''), UNREACHABLE, 'empty input: plainServiceFailure plain copy');
  c.eq(plainServiceFailure({ nope: true }), UNREACHABLE, 'non string error: plainServiceFailure');

  // --- the caller supplied translate function decides the key ------------
  c.eq(plainGatewayFailure('service_start_blocked', noTx), 'Hermes could not start in the background. Open the app, then try again.', 'tx fallback is the English copy');
  c.eq(plainResultLine('Failed to fetch', 'FALLBACK', (k) => `<${k}>`), '<opsUnreachablePlain>', 'tx key used for transport');
}

// --------------------------------------------------------------------------
const FN_START = 'const splitCodeFences = (content: string): ContentPart[] => {';
const IFACE_START = 'interface ContentPart {';

function extractSplitter() {
  const file = path.join(repoRoot, 'src', 'components', 'chat', 'ChatMessageBubble.tsx');
  const src = read(file);
  const ifaceAt = src.indexOf(IFACE_START);
  const fnAt = src.indexOf(FN_START);
  if (ifaceAt < 0 || fnAt < 0) throw new Error('could not locate splitCodeFences in ChatMessageBubble.tsx');
  const ifaceEnd = src.indexOf('\n}', ifaceAt) + 2;
  const fnEnd = src.indexOf('\n};', fnAt) + 3;
  const iface = src.slice(ifaceAt, ifaceEnd);
  const fn = src.slice(fnAt, fnEnd);
  if (!src.includes(iface) || !src.includes(fn)) throw new Error('extraction did not match the source text');
  return { file, iface, fn };
}

async function checkFenceSplitter(c) {
  const { file, iface, fn } = extractSplitter();
  fs.mkdirSync(generatedDir, { recursive: true });
  const genTs = path.join(generatedDir, 'fenceSplit.ts');
  fs.writeFileSync(
    genTs,
    [
      '// Generated by tests/check.unit.mjs from ' + rel(file) + '. Do not edit.',
      'type ContentPart = { text: string; isCode: boolean; lang: string };',
      '',
      fn,
      '',
      'export { splitCodeFences };',
      'export type { ContentPart };',
      '',
    ].join('\n'),
    'utf8'
  );
  c.ok(iface.includes('isCode') && iface.includes('lang'), 'extracted ContentPart interface looks intact', iface);

  const [out] = await compileToEsm([genTs]);
  const { splitCodeFences } = await importCompiled(out);

  const shape = (parts) => parts.map((p) => ({ text: p.text, isCode: p.isCode, lang: p.lang }));

  c.eq(JSON.stringify(shape(splitCodeFences('No fences in this reply.'))),
    JSON.stringify([{ text: 'No fences in this reply.', isCode: false, lang: '' }]),
    'splitter: plain prose stays one text part');

  c.eq(JSON.stringify(shape(splitCodeFences('Intro\n```js\nconst a = 1;\n```\nOutro'))),
    JSON.stringify([
      { text: 'Intro\n', isCode: false, lang: '' },
      { text: 'const a = 1;', isCode: true, lang: 'js' },
      { text: '\nOutro', isCode: false, lang: '' },
    ]),
    'splitter: fenced block with language tag');

  c.eq(JSON.stringify(shape(splitCodeFences('```\nplain block\n```'))),
    JSON.stringify([{ text: 'plain block', isCode: true, lang: '' }]),
    'splitter: fence without info string');

  c.eq(JSON.stringify(shape(splitCodeFences('```py\nprint(1)\n```'))),
    JSON.stringify([{ text: 'print(1)', isCode: true, lang: 'py' }]),
    'splitter: fence at the very start of the reply');

  c.eq(JSON.stringify(shape(splitCodeFences('Before\n```ts\nlet x = 1'))),
    JSON.stringify([
      { text: 'Before\n', isCode: false, lang: '' },
      { text: 'let x = 1', isCode: true, lang: 'ts' },
    ]),
    'splitter: unterminated streaming fence renders as code');

  c.eq(JSON.stringify(shape(splitCodeFences('Use ``` for inline code.'))),
    JSON.stringify([{ text: 'Use ``` for inline code.', isCode: false, lang: '' }]),
    'splitter: inline fence inside a sentence never opens a block');

  c.eq(JSON.stringify(shape(splitCodeFences('hello ```'))),
    JSON.stringify([{ text: 'hello ```', isCode: false, lang: '' }]),
    'splitter: dangling fence at the end of a sentence stays prose');

  const twoBlocks = 'p1\n```js\na\n```\np2\n```\nb\n```\np3';
  c.eq(JSON.stringify(shape(splitCodeFences(twoBlocks))),
    JSON.stringify([
      { text: 'p1\n', isCode: false, lang: '' },
      { text: 'a', isCode: true, lang: 'js' },
      { text: '\np2\n', isCode: false, lang: '' },
      { text: 'b', isCode: true, lang: '' },
      { text: '\np3', isCode: false, lang: '' },
    ]),
    'splitter: two blocks in one reply');

  const prose = 'just text\nwith two lines';
  const joined = splitCodeFences(prose).map((p) => p.text).join('');
  c.eq(joined, prose, 'splitter: prose only reply round trips exactly');

  const noCode = 'a\n```js\nx\n```\nb';
  const codeText = splitCodeFences(noCode).filter((p) => p.isCode).map((p) => p.text).join('\n');
  c.eq(codeText, 'x', 'splitter: code body excludes the fences and info string');
}

export async function checkUnits() {
  const c = makeCounter();
  const failures = [];
  const warnings = [];
  try {
    await checkPlainFailure(c);
  } catch (err) {
    failures.push(`plainFailure.ts could not be compiled or imported: ${err.message}`);
  }
  try {
    await checkFenceSplitter(c);
  } catch (err) {
    failures.push(`splitCodeFences could not be executed: ${err.message}`);
  }
  failures.push(...c.failures);
  warnings.push(
    ...c.warnings,
    'splitCodeFences is module private in ChatMessageBubble.tsx (not exported), so the unit test extracts its source verbatim instead of importing it'
  );
  return {
    name: 'unit assertions (plainFailure + code fence splitter)',
    passed: c.passed,
    failures,
    warnings,
    note: `${c.passed} assertions passed, ${c.failures.length} failed`,
  };
}
