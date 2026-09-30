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
    if (s && s.length >= 4 && raw.includes(s)) problems.push('known secret value present');
  }
  if (fieldLeaks(raw, 'apiKey')) {
    problems.push('apiKey field present');
  }
  const leakKeys = ['api_key', 'serverKey', 'providerKey', 'provider_key', 'clientSecret', 'client_secret', 'refreshToken', 'refresh_token', 'accessToken', 'access_token', 'authToken', 'auth_token', 'botToken', 'bot_token', 'tgToken', 'discordToken', 'appLockPin', 'passcode', 'pin', 'password', 'secret'];
  for (const k of leakKeys) {
    if (fieldLeaks(raw, k)) problems.push(`${k} field present`);
  }
  return problems;
};

// Per-occurrence value check: split on the field name and inspect the value
// that follows each occurrence. Clean only when blank or REDACTED-marked.
// The old shape tested REDACTED anywhere in the payload, so one redacted
// field laundered every other one.
function fieldLeaks(raw: string, key: string): boolean {
  const segs = raw.split('"' + key + '"');
  for (let i = 1; i < segs.length; i++) {
    const m = segs[i].match(/^\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (m && m[1].trim() !== '' && !m[1].includes(REDACTED)) return true;
  }
  return false;
}
