// Robust Server-Sent Events parser for the chat stream endpoint.
//
// Replaces ad-hoc manual `event:` / `data:` line parsing. Handles:
// multiline data blocks, CRLF line endings, event/data ordering, chunk
// splits at arbitrary byte offsets, partial final events (no trailing
// blank line), comment heartbeats, unknown event types, malformed JSON,
// reconnect fields (id / retry), and completion events.
//
// Dependency free. No DOM or Node imports so it runs in the app and in
// the bundled self-test. Self-test: `node sseParser.js` after tsc emit,
// or import { runSseParserSelfTest } and call it.

// Event names the gateway is known to emit on the chat stream.
export const KNOWN_SSE_EVENTS: ReadonlySet<string> = new Set([
  'message',
  'assistant.delta',
  'assistant.commentary',
  'tool.progress',
  'tool.started',
  'tool.completed',
  'approval.request',
  'usage',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.stopped',
  'done',
  'complete',
  'completed',
  'cancelled',
  'error',
  'stream.error',
  'stop',
]);

// Event names that terminate a stream turn. Matched case-insensitively.
const TERMINAL_SSE_EVENTS: ReadonlySet<string> = new Set([
  'done',
  'complete',
  'completed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.stopped',
  'cancelled',
  'error',
  'stream.error',
  'stop',
]);

export function isTerminalSseEvent(eventName: string): boolean {
  return TERMINAL_SSE_EVENTS.has(eventName.trim().toLowerCase());
}

export function isKnownSseEvent(eventName: string): boolean {
  return KNOWN_SSE_EVENTS.has(eventName);
}

export interface SseParsedEvent {
  // Event type. Defaults to 'message' for data-only blocks per SSE spec.
  event: string;
  // Joined data payload. Multiple `data:` lines join with '\n'.
  data: string;
  // Parsed JSON when data is valid JSON, else null.
  json: unknown;
  // True when data parsed as JSON. False for empty or malformed data.
  jsonOk: boolean;
  // Last SSE id seen on this event, if any.
  id: string | null;
  // Last `retry:` value in ms seen on this event, if any.
  retryMs: number | null;
  // True when the event name is not in KNOWN_SSE_EVENTS. Passed through,
  // never dropped.
  unknownType: boolean;
  // True when the event name is a terminal/completion event.
  terminal: boolean;
}

export interface SseParserStats {
  dispatched: number;
  commentsIgnored: number;
  unknownTypes: number;
  malformedJson: number;
}

function tryParseJson(data: string): { json: unknown; ok: boolean } {
  if (!data) return { json: null, ok: false };
  try {
    return { json: JSON.parse(data), ok: true };
  } catch {
    return { json: null, ok: false };
  }
}

function parseRetryMs(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export class SseParser {
  private buf = '';
  private pendingCR = false;
  private eventName = '';
  private dataLines: string[] = [];
  private eventId: string | null = null;
  private pendingId: string | null = null;
  private pendingRetry: number | null = null;
  private bomStripped = false;
  private stats: SseParserStats = { dispatched: 0, commentsIgnored: 0, unknownTypes: 0, malformedJson: 0 };

  // Feed one text chunk. Chunk splits may land anywhere, including inside
  // a CRLF pair or inside a multibyte character (caller decodes with
  // TextDecoder streaming mode so string boundaries stay valid).
  feed(chunk: string): SseParsedEvent[] {
    if (!chunk) return [];
    if (!this.bomStripped) {
      this.bomStripped = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (this.pendingCR) {
      // Previous chunk ended with CR. A leading LF completes a CRLF pair.
      if (chunk.charCodeAt(0) === 0x0a) {
        this.buf += '\r\n';
        chunk = chunk.slice(1);
      } else {
        this.buf += '\r';
      }
      this.pendingCR = false;
    }
    if (chunk.endsWith('\r')) {
      this.pendingCR = true;
      chunk = chunk.slice(0, -1);
    }
    this.buf += chunk;
    const out: SseParsedEvent[] = [];
    let lineStart = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c === 0x0a || c === 0x0d) {
        let end = i;
        if (c === 0x0d && this.buf.charCodeAt(i + 1) === 0x0a) i++;
        const ev = this.processLine(this.buf.slice(lineStart, end));
        if (ev) out.push(ev);
        lineStart = i + 1;
      }
    }
    this.buf = this.buf.slice(lineStart);
    return out;
  }

  // Dispatch any buffered partial event at stream end, even without a
  // trailing blank line. Returns at most one event.
  flush(): SseParsedEvent[] {
    if (this.pendingCR) {
      this.pendingCR = false;
      const ev = this.processLine(this.buf + '\r');
      this.buf = '';
      const tail = this.dispatchBuffered();
      return tail ? [tail] : ev ? [ev] : [];
    }
    if (this.buf) {
      const ev = this.processLine(this.buf);
      this.buf = '';
      if (ev) return [ev];
    }
    const tail = this.dispatchBuffered();
    return tail ? [tail] : [];
  }

  getLastEventId(): string | null {
    return this.eventId;
  }

  // Value for a `Last-Event-ID` header on reconnect. Null when no id seen.
  getReconnectHeader(): { 'Last-Event-ID': string } | null {
    return this.eventId ? { 'Last-Event-ID': this.eventId } : null;
  }

  getStats(): SseParserStats {
    return { ...this.stats };
  }

  reset(): void {
    this.buf = '';
    this.pendingCR = false;
    this.eventName = '';
    this.dataLines = [];
    this.pendingId = null;
    this.pendingRetry = null;
  }

  // Returns a dispatched event on blank lines, else null.
  private processLine(line: string): SseParsedEvent | null {
    if (line === '') return this.dispatchBuffered();
    if (line.charCodeAt(0) === 0x3a) {
      // Comment / heartbeat (e.g. `: ping`). Ignored per SSE spec.
      this.stats.commentsIgnored++;
      return null;
    }
    let field = line;
    let value = '';
    const colon = line.indexOf(':');
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    } else {
      value = '';
    }
    if (field === 'event') {
      this.eventName = value;
    } else if (field === 'data') {
      this.dataLines.push(value);
    } else if (field === 'id') {
      // NUL in id means ignore the field per SSE spec.
      if (!value.includes('\0')) this.pendingId = value;
    } else if (field === 'retry') {
      const ms = parseRetryMs(value);
      if (ms !== null) this.pendingRetry = ms;
    }
    // Unknown fields are ignored per SSE spec.
    return null;
  }

  private dispatchBuffered(): SseParsedEvent | null {
    const hasData = this.dataLines.length > 0;
    const hasEvent = this.eventName !== '';
    // SSE spec dispatches only when data is present, but completion
    // signals sometimes arrive as a bare `event: done` with no data, so
    // dispatch when either is present. Never dispatch fully empty blocks.
    if (!hasData && !hasEvent && this.pendingId === null && this.pendingRetry === null) return null;
    if (!hasData && !hasEvent) {
      if (this.pendingId !== null) this.eventId = this.pendingId;
      this.pendingId = null;
      this.pendingRetry = null;
      return null;
    }
    const event = hasEvent ? this.eventName : 'message';
    const data = this.dataLines.join('\n');
    const { json, ok } = tryParseJson(data);
    const id = this.pendingId !== null ? this.pendingId : this.eventId;
    if (this.pendingId !== null) this.eventId = this.pendingId;
    const retryMs = this.pendingRetry;
    const unknownType = !KNOWN_SSE_EVENTS.has(event);
    if (!ok && data) this.stats.malformedJson++;
    if (unknownType) this.stats.unknownTypes++;
    this.stats.dispatched++;
    const out: SseParsedEvent = {
      event,
      data,
      json,
      jsonOk: ok,
      id,
      retryMs,
      unknownType,
      terminal: isTerminalSseEvent(event),
    };
    this.eventName = '';
    this.dataLines = [];
    this.pendingId = null;
    this.pendingRetry = null;
    return out;
  }
}

// One-shot parse of a complete SSE text payload.
export function parseSseText(text: string): SseParsedEvent[] {
  const parser = new SseParser();
  const events = parser.feed(text);
  return events.concat(parser.flush());
}

// Self-test. Runnable via node after tsc emit (`node sseParser.js`).
// Returns failure count so embedders can assert on it. Zero Node imports;
// process access goes through globalThis so browser builds stay clean.
export interface SseSelfTestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export function runSseParserSelfTest(): { passed: number; failed: number; results: SseSelfTestResult[] } {
  const results: SseSelfTestResult[] = [];
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      results.push({ name, passed: true });
    } catch (e) {
      results.push({ name, passed: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  check('multiline data joins with newline', () => {
    const evs = parseSseText('event: assistant.delta\ndata: {"delta":"hel"}\ndata: {"delta":"lo"}\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].data === '{"delta":"hel"}\n{"delta":"lo"}', `bad join: ${JSON.stringify(evs[0].data)}`);
  });

  check('CRLF line endings parse', () => {
    const evs = parseSseText('event: usage\r\ndata: {"usage":{"input_tokens":1}}\r\n\r\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].event === 'usage', `bad event: ${evs[0].event}`);
    assert(evs[0].jsonOk, 'expected jsonOk');
  });

  check('lone CR line endings parse', () => {
    const evs = parseSseText('event: done\rdata: {"ok":true}\r\r');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].terminal, 'done should be terminal');
  });

  check('event after data ordering works', () => {
    const evs = parseSseText('data: {"delta":"hi"}\nevent: assistant.delta\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].event === 'assistant.delta', `bad event: ${evs[0].event}`);
    assert(evs[0].jsonOk, 'expected jsonOk');
  });

  check('data-only block defaults to message event', () => {
    const evs = parseSseText('data: hello\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].event === 'message', `bad event: ${evs[0].event}`);
    assert(!evs[0].jsonOk && evs[0].data === 'hello', 'raw data should pass through');
  });

  check('first colon splits field, JSON colons preserved', () => {
    const evs = parseSseText('event:assistant.delta\ndata:{"a":1,"b":"x:y"}\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].event === 'assistant.delta', `bad event: ${evs[0].event}`);
    assert(evs[0].jsonOk, 'expected jsonOk');
  });

  check('comments and heartbeats ignored', () => {
    const p = new SseParser();
    const evs = p.feed(': ping\n: keep-alive\n\ndata: hi\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(p.getStats().commentsIgnored === 2, 'expected 2 ignored comments');
  });

  check('unknown event types pass through flagged', () => {
    const evs = parseSseText('event: frobnicate.future\ndata: {"x":1}\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].unknownType, 'expected unknownType flag');
    assert(!evs[0].terminal, 'unknown type must not be terminal');
    assert(evs[0].jsonOk, 'payload should still parse');
  });

  check('malformed JSON keeps raw data', () => {
    const p = new SseParser();
    const evs = p.feed('event: assistant.delta\ndata: {not json\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(!evs[0].jsonOk, 'expected jsonOk false');
    assert(evs[0].data === '{not json', `raw lost: ${JSON.stringify(evs[0].data)}`);
    assert(p.getStats().malformedJson === 1, 'expected malformedJson stat');
  });

  check('chunk split mid-line reassembles', () => {
    const p = new SseParser();
    const a = p.feed('event: assistant.d');
    const b = p.feed('elta\ndata: {"del');
    const c = p.feed('ta":"hi"}\n\n');
    assert(a.length === 0 && b.length === 0, 'no event before blank line');
    assert(c.length === 1, `expected 1 event, got ${c.length}`);
    assert(c[0].event === 'assistant.delta' && c[0].jsonOk, 'reassembly failed');
  });

  check('chunk split inside CRLF reassembles', () => {
    const p = new SseParser();
    const a = p.feed('event: done\r');
    const b = p.feed('\ndata: 1\n\r\n');
    assert(a.length === 0, 'CR at chunk end must not dispatch yet');
    assert(b.length === 1 && b[0].terminal, 'split CRLF failed');
  });

  check('partial final event flushes without trailing blank line', () => {
    const p = new SseParser();
    const a = p.feed('event: assistant.delta\ndata: {"delta":"tail"}');
    assert(a.length === 0, 'partial block must not dispatch early');
    const f = p.flush();
    assert(f.length === 1, `expected 1 flushed event, got ${f.length}`);
    assert(f[0].event === 'assistant.delta' && f[0].jsonOk, 'flush dispatch failed');
  });

  check('bare completion event dispatches as terminal', () => {
    const evs = parseSseText('event: done\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].terminal, 'bare done must be terminal');
  });

  check('completion event with payload detected', () => {
    const evs = parseSseText('event: run.completed\ndata: {"run_id":"r1","usage":{"input_tokens":2}}\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].terminal && !evs[0].unknownType, 'run.completed must be known terminal');
  });

  check('error event is known terminal with raw fallback', () => {
    const evs = parseSseText('event: error\ndata: gateway blew up\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].terminal && !evs[0].unknownType, 'error must be known terminal');
    assert(!evs[0].jsonOk && evs[0].data === 'gateway blew up', 'raw error text lost');
  });

  check('id tracks for reconnect and Last-Event-ID header', () => {
    const p = new SseParser();
    p.feed('id: 42\nevent: assistant.delta\ndata: {"delta":"a"}\n\n');
    assert(p.getLastEventId() === '42', `bad last id: ${p.getLastEventId()}`);
    const h = p.getReconnectHeader();
    assert(h !== null && h['Last-Event-ID'] === '42', 'reconnect header missing');
  });

  check('retry field parses, invalid retry ignored', () => {
    const p = new SseParser();
    const evs = p.feed('retry: 3000\ndata: x\n\nretry: banana\ndata: y\n\n');
    assert(evs.length === 2, `expected 2 events, got ${evs.length}`);
    assert(evs[0].retryMs === 3000, `bad retry: ${evs[0].retryMs}`);
    assert(evs[1].retryMs === null, 'invalid retry must be null');
  });

  check('empty data value contributes empty line to join', () => {
    const evs = parseSseText('event: message\ndata: line1\ndata:\ndata: line3\n\n');
    assert(evs.length === 1, `expected 1 event, got ${evs.length}`);
    assert(evs[0].data === 'line1\n\nline3', `bad join: ${JSON.stringify(evs[0].data)}`);
  });

  check('BOM on first chunk stripped', () => {
    const evs = parseSseText('\uFEFFevent: done\ndata: 1\n\n');
    assert(evs.length === 1 && evs[0].terminal, 'BOM broke parsing');
  });

  check('multiple events in one chunk dispatch in order', () => {
    const evs = parseSseText('data: one\n\ndata: two\n\n');
    assert(evs.length === 2, `expected 2 events, got ${evs.length}`);
    assert(evs[0].data === 'one' && evs[1].data === 'two', 'ordering broken');
  });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  return { passed, failed, results };
}

function printSelfTest(): number {
  const { passed, failed, results } = runSseParserSelfTest();
  const log = (s: string) => {
    const g = globalThis as { console?: { log?: (m: string) => void } };
    g.console?.log?.(s);
  };
  for (const r of results) {
    log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.passed ? '' : `: ${r.detail ?? 'assertion failed'}`}`);
  }
  log(`sseParser self-test: ${passed} passed, ${failed} failed`);
  return failed;
}

// Direct execution after tsc emit: `node sseParser.js`.
const g = globalThis as {
  process?: { argv?: string[]; exit?: (code: number) => void };
  require?: { main?: unknown };
  module?: { exports?: unknown };
};
try {
  const argv1 = g.process?.argv?.[1] ?? '';
  const underNode = !!g.process?.argv;
  const isMain = underNode && /sseParser(\.js|\.ts)?$/.test(argv1.replace(/\\/g, '/'));
  if (isMain) g.process?.exit?.(printSelfTest() === 0 ? 0 : 1);
} catch {
  // Never let the self-test hook break library import.
}
