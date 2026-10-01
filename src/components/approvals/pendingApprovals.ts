import type { PendingApproval } from '../../types/hermes';

export const PENDING_APPROVALS_KEY = 'hermes_pending_approvals';

/** Approvals older than this are dead context: the run is gone and the user
 *  has moved on. Dropped on load, on reconcile and on resolve. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Gateways emit either ms (camelCase) or Unix seconds (snake_case): values
 *  below 1e11 can only be seconds, so promote them, or a seconds timestamp
 *  reads as "1970" and the freshness filter drops a live card. */
export function normTs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
}

/** True while an approval is young enough to still be actionable. A row with
 *  no timestamp is treated as fresh (the gateway omitted it). */
export function isApprovalFresh(a: PendingApproval, now = Date.now()): boolean {
  return (a.createdAt ?? now) + APPROVAL_TTL_MS > now;
}

export function sanitizeApproval(raw: unknown): PendingApproval | null {
  if (!isRecord(raw)) return null;
  const runId = raw.runId ?? raw.run_id ?? raw.id;
  if (typeof runId !== 'string' || !runId) return null;
  const sessionId = raw.sessionId ?? raw.session_id;
  const summary = raw.summary ?? raw.description ?? raw.command;
  const args = Array.isArray(raw.args)
    ? raw.args.map((a) => String(a))
    : undefined;
  // Choice sets come back as plain strings on this gateway; a nested object
  // form is tolerated by stringifying nothing at all (dropped) rather than
  // rendering "[object Object]" as a button label.
  const choices = Array.isArray(raw.choices)
    ? raw.choices
        .map((c) => (typeof c === 'string' ? c : ''))
        .filter((c) => c.length > 0)
    : undefined;
  return {
    runId,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    summary: typeof summary === 'string' && summary ? summary : 'Approval requested for action',
    tool: typeof raw.tool === 'string' ? raw.tool : undefined,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    path: typeof raw.path === 'string' ? raw.path : undefined,
    args,
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    createdAt: normTs(raw.createdAt ?? (raw as Record<string, unknown>).created_at),
    choices,
  };
}

export function loadCachedPending(): PendingApproval[] {
  try {
    const raw = localStorage.getItem(PENDING_APPROVALS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PendingApproval[] = [];
    for (const item of parsed) {
      const clean = sanitizeApproval(item);
      // Expired rows are dropped at the door, never resurrected into the UI.
      if (clean && isApprovalFresh(clean)) out.push(clean);
    }
    return out;
  } catch {
    return [];
  }
}

export function cachePending(approvals: PendingApproval[]): void {
  try {
    localStorage.setItem(PENDING_APPROVALS_KEY, JSON.stringify(approvals));
  } catch {
    // Storage full or unavailable: pending list stays in memory only.
  }
}

// Merge gateway-fresh approvals over locally cached ones. Gateway wins on
// field content, and a live gateway that reports nothing means nothing is
// pending: cached rows for vanished runs are dropped instead of resurrected.
// The one exception is a row that arrived while the fetch was in flight
// (SSE raced the poll): `keepNewerThan` carries the fetch start timestamp so
// those survive one round instead of flickering out of the UI.
export function reconcilePending(
  cached: PendingApproval[],
  fresh: PendingApproval[],
  keepNewerThan = 0
): PendingApproval[] {
  const freshByKey = new Map(fresh.map((a) => [approvalKey(a), a]));
  const merged: PendingApproval[] = fresh
    .map((a) => ({ ...a }))
    .filter((a) => isApprovalFresh(a));
  const freshKeys = new Set(freshByKey.keys());
  for (const c of cached) {
    if (!c.runId || freshKeys.has(approvalKey(c))) continue;
    if (!isApprovalFresh(c)) continue;
    // A cached card without a timestamp carries no age signal: keep it, so a
    // missing field can never read as "older than everything".
    if (keepNewerThan > 0 && (c.createdAt ?? Number.MAX_SAFE_INTEGER) >= keepNewerThan) {
      merged.push({ ...c });
    }
  }
  merged.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return merged;
}

// Identity covers the action, not just the run: one run may hold several
// approvals (e.g. read x, then write y), and dedupe by runId alone would
// swallow every approval after the first.
export function approvalKey(a: Pick<PendingApproval, 'runId' | 'tool' | 'command'>): string {
  return `${a.runId}::${a.tool ?? ''}::${a.command ?? ''}`;
}

export function mergeIncoming(
  current: PendingApproval[],
  incoming: PendingApproval
): PendingApproval[] {
  const key = approvalKey(incoming);
  if (current.some((a) => approvalKey(a) === key)) return current;
  return [...current, incoming];
}

export function removeResolved(
  current: PendingApproval[],
  runId: string
): PendingApproval[] {
  return current.filter((a) => a.runId !== runId);
}
