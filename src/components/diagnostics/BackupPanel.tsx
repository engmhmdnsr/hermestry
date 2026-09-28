// BackupPanel.tsx
// BACKUP-01: snapshots must never export plaintext API keys.
// Two backup classes:
//   safe: sessions, jobs, prefs, provider NAMES only (no key material).
//   secret: opt-in, separately encrypted envelope only, never plaintext.
// The component documents the classes and builds safe payloads through
// the central redaction engine.

import React, { useState } from 'react';
import type { BackupResult } from '../../types/hermes';
import { redactSecrets, REDACTED } from '../../services/redaction';

export const BACKUP_CLASSES = [
  {
    id: 'safe',
    label: 'Safe backup (default)',
    includes: ['sessions (ids, titles, models, counts)', 'jobs (ids, names, schedules, enabled)', 'prefs (theme, language, font scale)', 'provider names (label, provider, model, no keys)'],
    excludes: ['apiKey, serverKey, tgToken, discordToken, appLockPin', 'baseUrls with credentials', 'message bodies with token leakage (redacted)'],
  },
  {
    id: 'secret',
    label: 'Secret backup (opt-in, separately encrypted)',
    includes: ['AES-GCM envelope via secureStore only'],
    excludes: ['plaintext export is refused', 'never bundled with safe backup file'],
  },
] as const;

export interface SafeSession {
  id: string;
  title: string;
  model: string;
  messageCount: number;
}

export interface SafeJob {
  id: string;
  name: string;
  scheduleDisplay: string;
  enabled: boolean;
}

export interface SafeProviderRef {
  id: string;
  provider: string;
  name: string;
  defaultModel: string;
  enabled: boolean;
}

export interface SafeBackupV1 {
  v: 1;
  kind: 'safe';
  exportedAt: string;
  sessions: SafeSession[];
  jobs: SafeJob[];
  prefs: Record<string, unknown>;
  providers: SafeProviderRef[];
}

// Secret backup travels only as an opaque encrypted envelope.
// The plaintext key map must never be serialized into a backup file.
export interface SecretBackupEnvelope {
  v: 1;
  kind: 'secret';
  exportedAt: string;
  encryptedWith: 'secureStore-aes-gcm';
  envelope: string;
}

export interface RawBackupInput {
  sessions: Array<{ id: unknown; title: unknown; model: unknown; messageCount: unknown }>;
  jobs: Array<{ id: unknown; name: unknown; scheduleDisplay: unknown; enabled: unknown }>;
  prefs: Record<string, unknown>;
  providers: Array<{ id: unknown; provider: unknown; name: unknown; defaultModel: unknown; enabled: unknown }>;
}

// Build a safe backup: pick allow-listed fields only, then redact.
// Key material has no field to live in, so it cannot leak by shape;
// redaction catches secrets embedded in titles or pref strings.
export const buildSafeBackup = (input: RawBackupInput): SafeBackupV1 => {
  const sessions: SafeSession[] = input.sessions.map((s) => ({
    id: String(s.id ?? ''),
    title: String(s.title ?? 'untitled'),
    model: String(s.model ?? ''),
    messageCount: Number(s.messageCount ?? 0),
  }));
  const jobs: SafeJob[] = input.jobs.map((j) => ({
    id: String(j.id ?? ''),
    name: String(j.name ?? ''),
    scheduleDisplay: String(j.scheduleDisplay ?? ''),
    enabled: Boolean(j.enabled),
  }));
  const providers: SafeProviderRef[] = input.providers.map((p) => ({
    id: String(p.id ?? ''),
    provider: String(p.provider ?? ''),
    name: String(p.name ?? ''),
    defaultModel: String(p.defaultModel ?? ''),
    enabled: Boolean(p.enabled),
  }));
  const prefs = redactSecrets({ ...input.prefs });
  return redactSecrets({
    v: 1,
    kind: 'safe',
    exportedAt: new Date().toISOString(),
    sessions,
    jobs,
    prefs,
    providers,
  });
};

// Guard: refuse to write a safe backup that still carries key material.
export const assertNoPlaintextSecrets = (backup: SafeBackupV1, knownSecrets: string[] = []): string[] => {
  const problems: string[] = [];
  const raw = JSON.stringify(backup);
  for (const s of knownSecrets) {
    if (s && s.length >= 4 && raw.includes(s)) problems.push('known secret value present');
  }
  if (raw.includes('"apiKey"') && !raw.split('"apiKey"').every((_, i) => i === 0 || raw.includes(REDACTED))) {
    problems.push('apiKey field present');
  }
  const leakKeys = ['serverKey', 'tgToken', 'discordToken', 'appLockPin'];
  for (const k of leakKeys) {
    if (raw.includes(`"${k}"`)) problems.push(`${k} field present`);
  }
  return problems;
};

interface BackupPanelProps {
  running: boolean;
  result: BackupResult | null;
  onRunBackup: () => void;
}

export const BackupPanel: React.FC<BackupPanelProps> = ({ running, result, onRunBackup }) => {
  const [ack, setAck] = useState(false);
  return (
    <div className="rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] p-5 space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-white">Local snapshot</h4>
        <p className="text-xs text-slate-400 mt-0.5">
          Safe backup only. Plaintext API keys are never exported.
        </p>
      </div>
      <ul className="space-y-1.5">
        {BACKUP_CLASSES.map((c) => (
          <li key={c.id} className="text-[11px] text-slate-400">
            <span className="text-slate-200 font-medium">{c.label}: </span>
            includes {c.includes.join('; ')}. Excludes: {c.excludes.join('; ')}.
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-2 text-[11px] text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5"
        />
        <span>I understand this snapshot contains no API keys. Secret backup is a separate encrypted step.</span>
      </label>
      <button
        onClick={onRunBackup}
        disabled={running || !ack}
        className="px-3.5 py-2 min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
      >
        {running ? 'Creating snapshot...' : 'Create safe snapshot'}
      </button>
      {result && (
        <p role="status" className={`text-[11px] ${result.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
};
