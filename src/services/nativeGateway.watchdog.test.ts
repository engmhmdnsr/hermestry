// Regression test for the native stream watchdog in nativeGateway.ts.
//
// The original bug: nativeStreamPost raced a fixed 90s timer that nothing ever
// reset, so a turn streaming normally for more than 90s in total was reported as
// a failure, and the reason text matched the transport matcher and reached the
// user as "the app could not reach the Hermes server" while the server was up.
//
// window.Capacitor.Plugins.HermesGateway is stubbed and the chunk listener is
// driven directly, so no gateway, device or Capacitor runtime is needed.
//
// Run: node --experimental-strip-types src/services/nativeGateway.watchdog.test.ts


type Listener = (info: Record<string, unknown>) => void;

interface Stub {
  streamPost: (opts: { id: string }) => void;
  streamAbort: (opts: { id: string }) => void;
  addListener: (event: string, cb: Listener) => Promise<{ remove: () => void }>;
  emit: (event: string, info: Record<string, unknown>) => void;
  lastId: string;
}

function installStub(): Stub {
  const listeners = new Map<string, Listener>();
  const stub: Stub = {
    lastId: '',
    streamPost: (opts) => {
      stub.lastId = opts.id;
    },
    streamAbort: () => {},
    addListener: async (event, cb) => {
      listeners.set(event, cb);
      return { remove: () => listeners.delete(event) };
    },
    emit: (event, info) => {
      listeners.get(event)?.(info);
    },
  };
  (globalThis as unknown as Record<string, unknown>).window = {
    Capacitor: { Plugins: { HermesGateway: stub } },
  };
  return stub;
}

const results: Array<{ name: string; passed: boolean; detail?: string }> = [];
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (e) {
    failed += 1;
    results.push({ name, passed: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const KEEPALIVE = ': keepalive\n\n';

import { nativeStreamPost } from './nativeGateway';

const base = () => ({
  url: 'http://127.0.0.1:8080/api/sessions/s/chat/stream',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
  onStatus: () => {},
  onBytes: () => {},
});

async function main() {
  await check('a clean stream resolves done', async () => {
    const stub = installStub();
    const p = nativeStreamPost(base());
    await tick();
    stub.emit('gwStreamDone', { id: stub.lastId });
    assert((await p) === 'done', 'expected done');
  });

  await check('keepalive chunks are decoded and do not settle the stream early', async () => {
    const stub = installStub();
    const seen: number[] = [];
    let settled = false;
    const p = nativeStreamPost({ ...base(), onBytes: (b: Uint8Array) => seen.push(b.length) });
    p.then(() => {
      settled = true;
    });
    await tick();
    const id = stub.lastId;
    assert(!!id, 'stream id was never captured');
    for (let i = 0; i < 12; i += 1) {
      stub.emit('gwStreamChunk', { id, chunk: b64(KEEPALIVE) });
      await tick(2);
    }
    assert(!settled, 'the stream settled while chunks were still arriving');
    stub.emit('gwStreamDone', { id });
    assert((await p) === 'done', 'expected done after keepalives');
    assert(seen.length === 12, `expected 12 decoded chunks, got ${seen.length}`);
  });

  await check('onProgress fires for a keepalive-only chunk', async () => {
    const stub = installStub();
    let progress = 0;
    const p = nativeStreamPost({ ...base(), onProgress: () => (progress += 1) });
    await tick();
    stub.emit('gwStreamChunk', { id: stub.lastId, chunk: b64(KEEPALIVE) });
    await tick(5);
    assert(progress === 1, `expected onProgress once, got ${progress}`);
    stub.emit('gwStreamDone', { id: stub.lastId });
    await p;
  });

  await check('the caller options bag is not left mutated', async () => {
    const stub = installStub();
    const opts = base();
    const p = nativeStreamPost(opts);
    await tick();
    stub.emit('gwStreamDone', { id: stub.lastId });
    await p;
    assert(!('onProgress' in opts), 'onProgress leaked onto the caller options object');
  });

  await check('an aborted stream resolves cancelled', async () => {
    const stub = installStub();
    const ac = new AbortController();
    const p = nativeStreamPost({ ...base(), signal: ac.signal });
    await tick();
    stub.emit('gwStreamError', { id: stub.lastId, cancelled: true, message: 'aborted' });
    assert((await p) === 'cancelled', 'expected cancelled');
  });

  await check('a non-2xx status is reported through onStatus', async () => {
    const stub = installStub();
    let status = 0;
    const p = nativeStreamPost({ ...base(), onStatus: (s: number) => (status = s) });
    await tick();
    stub.emit('gwStreamStatus', { id: stub.lastId, status: 401 });
    await p;
    assert(status === 401, `expected onStatus 401, got ${status}`);
  });

  await check('the watchdog fires when the stream goes silent', async () => {
    const stub = installStub();
    const p = nativeStreamPost({ ...base(), watchdogIdleMs: 60 });
    await tick();
    assert(stub.lastId !== '', 'stream id was never captured');
    // No chunks and no done: the idle deadline is the only thing that can settle it.
    const res = await p;
    assert(
      res === 'error:watchdog idle timeout',
      `expected the idle watchdog reason, got ${res}`
    );
  });

  await check('repeated chunks push the deadline out instead of expiring', async () => {
    const stub = installStub();
    // 40ms idle window, chunks every 20ms: total run is far longer than the
    // window, which is exactly the shape the old absolute 90s timer killed.
    const p = nativeStreamPost({ ...base(), watchdogIdleMs: 40 });
    await tick();
    const id = stub.lastId;
    for (let i = 0; i < 8; i += 1) {
      stub.emit('gwStreamChunk', { id, chunk: b64(KEEPALIVE) });
      await tick(20);
    }
    stub.emit('gwStreamDone', { id });
    assert((await p) === 'done', 'a stream that kept sending must not hit the watchdog');
  });

  await check('a silence longer than the window still trips the watchdog', async () => {
    const stub = installStub();
    const p = nativeStreamPost({ ...base(), watchdogIdleMs: 50 });
    await tick();
    stub.emit('gwStreamChunk', { id: stub.lastId, chunk: b64(KEEPALIVE) });
    const res = await p;
    assert(
      res === 'error:watchdog idle timeout',
      `expected the idle watchdog reason after silence, got ${res}`
    );
  });

  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.passed ? '' : `: ${r.detail ?? ''}`}`);
  }
  console.log(`watchdog regression: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
void main();
