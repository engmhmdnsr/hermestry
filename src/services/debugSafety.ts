// Export guard: refuse to hand a payload to a share link, a download or a
// server while it still carries key material.
//
// The check used to live inside components/diagnostics/BackupPanel.tsx, where
// nothing imported it, so no export path ever ran it. It now sits in services
// so the Settings export path calls it on the data the user is about to share.

import { REDACTED } from './redaction';

// Guard: refuse to export a payload that still carries key material.
// `payload` is deliberately unknown: the same rules apply to a safe backup and
// to the diagnostics bundle response, because a leak in either one is a leak.
export const assertNoPlaintextSecrets = (payload: unknown, knownSecrets: string[] = []): string[] => {
  const problems: string[] = [];
  const raw = JSON.stringify(payload);
  if (!raw) return problems;
  for (const s of knownSecrets) {
    if (!s || s.length < 4 || !raw.includes(s)) continue;
    // Word-boundary / length-plus-context matching so a 4-digit PIN does not match timestamps
    if (s.length === 4 && /^\d{4}$/.test(s)) {
      const re = new RegExp(`(?<!\\d)${s}(?!\\d)`);
      if (!re.test(raw)) continue;
      // For 4-digit PIN require proximity to a sensitive field context
      if (!/"(?:appLockPin|passcode|pin|password)"\s*:/i.test(raw)) continue;
    }
    problems.push('known secret value present');
  }
  if (fieldLeaks(raw, 'apiKey')) {
    problems.push('apiKey field present');
  }
  const leakKeys = ['api_key', 'serverKey', 'providerKey', 'provider_key', 'clientSecret', 'client_secret', 'refreshToken', 'refresh_token', 'accessToken', 'access_token', 'authToken', 'auth_token', 'botToken', 'bot_token', 'tgToken', 'discordToken', 'appLockPin', 'passcode', 'pin', 'password', 'secret'];
  for (const k of leakKeys) {
    if (fieldLeaks(raw, k)) problems.push(`${k} field present`);
  }
  if (/\"authorization\"\s*:\s*\"Bearer\s+[^"]{4,}/i.test(raw)) problems.push('authorization header present');
  if (/[?&]api_key\s*=\s*[^&\s"]{4,}/i.test(raw) || /\"api_key\"\s*:\s*\"[^"]{4,}/i.test(raw)) problems.push('api_key query param present');
  return problems;
};

// Per-occurrence value check: split on the field name and inspect the value
// that follows each occurrence. Clean only when blank or REDACTED-marked or [set] placeholder.
// The old shape tested REDACTED anywhere in the payload, so one redacted
// field laundered every other one.
function fieldLeaks(raw: string, key: string): boolean {
  const segs = raw.split('"' + key + '"');
  for (let i = 1; i < segs.length; i++) {
    const tail = segs[i].replace(/^\s*:\s*/, '');
    if (!tail) continue;
    if (tail.startsWith('"')) {
      const m = tail.match(/^"((?:\\.|[^"\\])*)"/);
      if (m) {
        const v = m[1].trim();
        if (v !== '' && !v.includes(REDACTED) && v !== '[set]') return true;
      }
    } else if (/^-?\d/.test(tail)) {
      const m = tail.match(/^-?\d+(?:\.\d+)?/);
      if (m && m[0].trim() !== '' && !m[0].includes(REDACTED) && m[0] !== '[set]') return true;
    } else if (tail.startsWith('{') || tail.startsWith('[')) {
      try {
        const end = findJsonEnd(tail);
        const parsed = JSON.parse(tail.slice(0, end));
        const inner = JSON.stringify(parsed);
        if (inner && inner !== '{}' && inner !== '[]' && !inner.includes(REDACTED) && !inner.includes('[set]')) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

function findJsonEnd(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  const comma = s.indexOf(',');
  const brace = s.indexOf('}');
  if (comma === -1 && brace === -1) return s.length;
  if (comma === -1) return brace;
  if (brace === -1) return comma;
  return Math.min(comma, brace);
}
