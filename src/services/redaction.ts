// redaction.ts
// Central content-aware redaction engine (DEBUG-01, LOG-01).
// Key-name matching alone is not enough: secrets also appear inside free
// text, headers, URLs, .env bodies, and bearer tokens. Every string that
// leaves the app toward backups, debug bundles, share sheets, or logs
// must pass through redactSecrets / redactText first. Frontend redaction
// is the last defense: secrets must never reach native or gateway logs.

export const REDACTED = '***REDACTED***';

const SENSITIVE_KEY_PARTS = [
  'apikey',
  'api_key',
  'serverkey',
  'server_key',
  'tgtoken',
  'tg_token',
  'discordtoken',
  'discord_token',
  'applockpin',
  'app_lock_pin',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'pin',
];

export const isSensitiveKey = (key: string): boolean => {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return false;
  if (norm === 'pin' || norm.endsWith('pin')) return true;
  return SENSITIVE_KEY_PARTS.some((part) => part !== 'pin' && norm.includes(part));
};

// Content-aware patterns applied to every free-text string.
const PATTERNS: RegExp[] = [
  // Bearer tokens: "Bearer abc123..." Short values included (4+ chars).
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/g,
  // Basic auth header value.
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/g,
  // JWT: three base64url segments, short-tolerant (4+ chars each).
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // Telegram bot token: 123456789:AAH...
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g,
  // AWS access key id: AKIA + 16 uppercase alphanumerics.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Well-known provider prefixes: sk-, sk-ant-, xoxb/xoxp/xoxa, ghp_/gho_/github_pat_, discord M..., stripe sk_live.
  /\b(?:sk-ant-|sk-|xox[bpas]-|ghp_|gho_|github_pat_|sk_live_|sk_test_|rk_live_|whsec_)[A-Za-z0-9._~+/=-]{8,}/g,
  // PEM private key blocks (multiline).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Truncated PEM: BEGIN marker with no END plus one trailing base64 token.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]{4,})?/g,
  // PIN in free text: "pin 4821", "pin: 4821", "pin is 4821",
  // "app lock pin is 4821", "passcode=987654". Label kept, digits redacted.
  /\b(?:app[\s_-]?lock[\s_-]?pin|passcode|pin)(?:\s+is)?\s*[:=]?\s*#?\s*\d{4,8}\b/gi,
  // URL userinfo: https://user:password@host -> https://user:REDACTED@host
  /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g,
  // Query-string secrets: ?api_key=...&token=...
  /([?&](?:api[_-]?key|token|access[_-]?token|auth|secret)[^=]*=)([^&\s'"]+)/gi,
];

// Assignment style: apiKey=..., "secret": "...", Authorization: Bearer ...
// Keep the key/prefix, redact only the value.
const ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|server[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|auth[_-]?token|bot[_-]?token|discord[_-]?token|tg[_-]?token|app[_-]?lock[_-]?pin|passcode|pin|bearer)\s*[:=]\s*)(["']?)([^\s"',;}\]]{4,})/gi;

// .env style lines: SOME_API_KEY=plaintext (whole value redacted).
const ENV_LINE_PATTERN =
  /^([^#\n]*?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|PIN)[^=\n]*=)([^\n]+)$/gim;

const scrubKnownValues = (text: string, known: string[]): string => {
  let out = text;
  for (const s of known) {
    if (s && s.length >= 4 && out.includes(s)) {
      out = out.split(s).join(REDACTED);
    }
  }
  return out;
};

export const redactText = (input: string, knownSecrets: string[] = []): string => {
  if (!input) return input;
  let out = scrubKnownValues(input, knownSecrets);
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      // For URL userinfo keep the scheme and username.
      const urlMatch = /^(https?:\/\/)([^/\s:@]+):([^/\s@]+)@$/.exec(m);
      if (urlMatch) return `${urlMatch[1]}${urlMatch[2]}:${REDACTED}@`;
      // For query params keep the key name.
      const qMatch = /^([?&][^=]*=)(.+)$/.exec(m);
      if (qMatch && /^(?:[?&])/u.test(m)) return `${qMatch[1]}${REDACTED}`;
      if (/^Bearer\s+/i.test(m)) return `Bearer ${REDACTED}`;
      if (/^Basic\s+/i.test(m)) return `Basic ${REDACTED}`;
      if (/^-----BEGIN /i.test(m)) return REDACTED;
      // PIN in free text: keep the label, redact only the digits.
      if (/^(?:app[\s_-]?lock[\s_-]?pin|passcode|pin)\b/i.test(m)) {
        return m.replace(/\d{4,8}\b/, REDACTED);
      }
      return REDACTED;
    });
  }
  ASSIGNMENT_PATTERN.lastIndex = 0;
  out = out.replace(ASSIGNMENT_PATTERN, (_m, prefix: string, quote: string) => {
    return `${prefix}${quote}${REDACTED}`;
  });
  ENV_LINE_PATTERN.lastIndex = 0;
  out = out.replace(ENV_LINE_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = scrubKnownValues(out, knownSecrets);
  return out;
};

// Deep-clone a value with secrets redacted by key name AND by content.
// Strings are passed through redactText; object keys use isSensitiveKey;
// knownSecrets lets callers also scrub live vault values (LOG-01).
export const redactSecrets = <T>(value: T, knownSecrets: string[] = []): T => {
  if (typeof value === 'string') {
    return redactText(value, knownSecrets) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, knownSecrets)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === 'string' && v) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSecrets(v as unknown, knownSecrets);
      }
    }
    return out as unknown as T;
  }
  return value;
};

export interface RedactionSelfTest {
  name: string;
  input: string;
  mustNotContain: string[];
}

// Leak test suite (DEBUG-01): every case fails if the raw secret survives
// redaction or if no REDACTED marker was produced.
export const REDACTION_SELF_TESTS: RedactionSelfTest[] = [
  {
    name: 'openai-style key',
    input: 'my key is sk-abcDEF1234567890abcdef',
    mustNotContain: ['sk-abcDEF1234567890abcdef'],
  },
  {
    name: 'bearer header',
    input: 'Authorization: Bearer abcDEF1234567890',
    mustNotContain: ['abcDEF1234567890'],
  },
  {
    name: 'telegram bot token',
    input: 'bot token 123456789:AAHdqTcvO-ABCDEFGHIJKLMNOPQRSTuvwx',
    mustNotContain: ['123456789:AAHdqTcvO-ABCDEFGHIJKLMNOPQRSTuvwx'],
  },
  {
    name: 'api_key assignment',
    input: 'config api_key=supersecretvalue123',
    mustNotContain: ['supersecretvalue123'],
  },
  {
    name: 'env body',
    input: 'HERMES_API_KEY=supersecretvalue123\nMODEL=deepseek-chat',
    mustNotContain: ['supersecretvalue123'],
  },
  {
    name: 'url userinfo',
    input: 'fetch https://alice:hunter2hunter@example.com/api now',
    mustNotContain: ['hunter2hunter'],
  },
  {
    name: 'query param token',
    input: 'GET /api/logs?token=supersecretvalue123&limit=5',
    mustNotContain: ['supersecretvalue123'],
  },
  {
    name: 'jwt',
    input: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c here',
    mustNotContain: ['eyJhbGciOiJIUzI1NiJ9'],
  },
  {
    name: 'pem block',
    input: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKxyz\n-----END RSA PRIVATE KEY-----',
    mustNotContain: ['MIIBOgIBAAJBAKxyz'],
  },
  {
    name: 'object key names',
    input: JSON.stringify({ apiKey: 'supersecretvalue123', nested: { password: 'pw hunter2hunter' } }),
    mustNotContain: ['supersecretvalue123', 'hunter2hunter'],
  },
  {
    name: 'pin free text',
    input: 'my app lock pin is 4821, do not share it',
    mustNotContain: ['4821'],
  },
  {
    name: 'pin assignment',
    input: 'config pin=93741 please rotate',
    mustNotContain: ['93741'],
  },
  {
    name: 'aws akia key',
    input: 'deploy key AKIAQWERTYUIOPASDFGH leaked in log',
    mustNotContain: ['AKIAQWERTYUIOPASDFGH'],
  },
  {
    name: 'truncated pem',
    input: 'truncated -----BEGIN PRIVATE KEY----- MIIBTSTB0DY9X8Q7W6E5',
    mustNotContain: ['BEGIN PRIVATE KEY', 'MIIBTSTB0DY9X8Q7W6E5'],
  },
  {
    name: 'short bearer',
    input: 'Authorization: Bearer ab12',
    mustNotContain: ['ab12'],
  },
  {
    name: 'short jwt',
    input: 'jwt eyJhYmNk.eFgHiJkL.mNoPqRsT end',
    mustNotContain: ['eyJhYmNk.eFgHiJkL.mNoPqRsT'],
  },
];

export interface RedactionSelfTestResult {
  passed: boolean;
  checked: number;
  failures: string[];
}

export const runRedactionSelfTests = (): RedactionSelfTestResult => {
  const failures: string[] = [];
  for (const t of REDACTION_SELF_TESTS) {
    let redacted: string;
    if (t.name === 'object key names') {
      try {
        redacted = JSON.stringify(redactSecrets(JSON.parse(t.input)));
      } catch {
        redacted = redactText(t.input);
      }
    } else {
      redacted = redactText(t.input);
    }
    const leaked = t.mustNotContain.filter((s) => redacted.includes(s));
    if (leaked.length > 0 || !redacted.includes(REDACTED)) {
      failures.push(`${t.name}: leaked ${leaked.join(', ') || 'no marker'}`);
    }
  }
  return { passed: failures.length === 0, checked: REDACTION_SELF_TESTS.length, failures };
};
