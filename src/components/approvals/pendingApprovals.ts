import type { PendingApproval } from '../../types/hermes';

export const PENDING_APPROVALS_KEY = 'hermes_pending_approvals';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
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
      if (clean) out.push(clean);
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
// field content; locally cached entries for runs the gateway no longer
// reports are dropped, since a WebView reload must not resurrect them.
export function reconcilePending(
  cached: PendingApproval[],
  fresh: PendingApproval[]
): PendingApproval[] {
  const freshById = new Map(fresh.map((a) => [a.runId, a]));
  const merged: PendingApproval[] = fresh.map((a) => ({ ...a }));
  const freshIds = new Set(freshById.keys());
  for (const c of cached) {
    if (!c.runId || freshIds.has(c.runId)) continue;
    // Keep cached entries only when the gateway returned nothing at all
    // (offline startup). Otherwise drop them as resolved or expired.
    if (fresh.length === 0) merged.push({ ...c });
  }
  merged.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return merged;
}

export function mergeIncoming(
  current: PendingApproval[],
  incoming: PendingApproval
): PendingApproval[] {
  if (current.some((a) => a.runId === incoming.runId)) return current;
  return [...current, incoming];
}

export function removeResolved(
  current: PendingApproval[],
  runId: string
): PendingApproval[] {
  return current.filter((a) => a.runId !== runId);
}
