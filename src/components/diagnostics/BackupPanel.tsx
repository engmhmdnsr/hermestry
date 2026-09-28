// BackupPanel.tsx
// BACKUP-01: snapshots must never export plaintext API keys.
// Two backup classes:
//   safe: sessions, jobs, prefs, provider NAMES only (no key material).
//   secret: opt-in, separately encrypted envelope only, never plaintext.
// The component documents the classes and builds safe payloads through
// the central redaction engine. Every user-visible string goes through the
// translate function; the raw field lists stay in the code comments.

import React, { useState } from 'react';
import type { BackupResult } from '../../types/hermes';
import { redactSecrets, REDACTED } from '../../services/redaction';
import { useHermes } from '../../context/HermesContext';

// Labels and explanations are translatable pairs. The fallback is the English
// text a user reads when the key is not in constants/languages yet.
export const BACKUP_CLASSES = [
  {
    id: 'safe',
    labelKey: 'backupSafeLabel',
    label: 'Snapshot',
    includesKey: 'backupSafeIncludes',
    includes: 'chats (titles, models, message counts), scheduled tasks (names, schedules), and appearance settings',
    excludesKey: 'backupSafeExcludes',
    excludes: 'API keys, bot tokens, your Hermes server key, and the app lock PIN',
  },
  {
    id: 'secret',
    labelKey: 'backupSecretLabel',
    label: 'Keys backup',
    includesKey: 'backupSecretIncludes',
    includes: 'one separate file that is encrypted and locked to this phone',
    excludesKey: 'backupSecretExcludes',
    excludes: 'any plain-text copy of a key',
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
  // Translate lookup from the caller (useHermes). Optional: a missing lookup
  // degrades to the English fallback instead of printing the raw key.
  t?: (key: string) => string;
}

export const BackupPanel: React.FC<BackupPanelProps> = ({ running, result, onRunBackup, t }) => {
  const [ack, setAck] = useState(false);
  // The prop wins when a caller passes its own lookup; otherwise the app
  // context supplies it, so this panel translates even when mounted bare.
  const { t: ctxT } = useHermes();
  const lookup = t ?? ctxT;
  const tx = (key: string, fallback: string): string => {
    const v = lookup(key);
    return !v || v === key ? fallback : v;
  };
  return (
    <div className="r-md edge elev-0 bg-[var(--app-card)] p-5 space-y-4">
      <div>
        <h4 className="t-heading text-[var(--app-text)]">{tx('backupTitlePlain', 'Local snapshot')}</h4>
        <p className="t-body text-[var(--app-text-muted)] mt-1">
          {tx('backupIntroPlain', 'A snapshot saves your chats, tasks, and settings. Keys are never included.')}
        </p>
      </div>
      <ul className="space-y-2">
        {BACKUP_CLASSES.map((c) => (
          <li key={c.id} className="t-caption text-[var(--app-text-muted)]">
            <span className="t-label text-[var(--app-text)]">{tx(c.labelKey, c.label)}: </span>
            {tx('backupIncludesWord', 'Includes')} {tx(c.includesKey, c.includes)}.{' '}
            {tx('backupExcludesWord', 'Leaves out')} {tx(c.excludesKey, c.excludes)}.
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-2 t-label text-[var(--app-text)] cursor-pointer">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-1"
        />
        <span>
          {tx('backupAckLabel', 'I understand this snapshot holds no keys. A keys backup is a separate, encrypted step.')}
        </span>
      </label>
      <button
        onClick={onRunBackup}
        disabled={running || !ack}
        className="inline-flex items-center justify-center px-4 min-h-[44px] r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:opacity-50 text-[var(--app-on-accent)] t-label font-semibold cursor-pointer"
      >
        {running ? tx('backupRunningShort', 'Saving the snapshot…') : tx('backupCreateAction', 'Create snapshot')}
      </button>
      {result && (
        <div
          role="status"
          className="r-sm edge bg-[var(--app-card-subtle)] px-3 py-2 flex items-start gap-2"
        >
          <span className={`${result.ok ? 'pill-success' : 'pill-danger'} shrink-0`}>
            {result.ok ? tx('backupOkPill', 'Saved') : tx('backupFailedPill', 'Not saved')}
          </span>
          <span className="min-w-0">
            <span className="t-caption text-[var(--app-text)] break-words">{result.message}</span>
            {result.ok && result.path && (
              <span className="block t-micro normal-case font-mono text-[var(--app-text-muted)] break-all mt-1">
                {result.path}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
};
