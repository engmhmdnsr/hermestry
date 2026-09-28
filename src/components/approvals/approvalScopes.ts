export type ApprovalScope = 'once' | 'session';

export const APPROVAL_SCOPES: ApprovalScope[] = ['once', 'session'];

export const isApprovalScope = (value: unknown): value is ApprovalScope =>
  value === 'once' || value === 'session';

// Granular auto-approve scopes. Prefer these over the single global switch:
// callers should enable only the capability classes they accept.
export type AutoApproveScope = 'read' | 'write' | 'exec' | 'network' | 'install';

export const AUTO_APPROVE_SCOPES: AutoApproveScope[] = [
  'read',
  'write',
  'exec',
  'network',
  'install',
];

export const isAutoApproveScope = (value: unknown): value is AutoApproveScope =>
  AUTO_APPROVE_SCOPES.includes(value as AutoApproveScope);

export interface AutoApprovePolicy {
  // Master switch. Always OFF by default; enabling requires the
  // high-friction flow in AutoApproveGate.
  enabled: boolean;
  scopes: AutoApproveScope[];
  // Free-text rationale recorded when the user enables auto-approve.
  reason?: string;
}

export const DEFAULT_AUTO_APPROVE_POLICY: AutoApprovePolicy = {
  enabled: false,
  scopes: [],
};

const RANK: Record<AutoApproveScope, number> = {
  read: 0,
  write: 1,
  network: 2,
  exec: 3,
  install: 4,
};

export const SCOPE_DESCRIPTIONS: Record<AutoApproveScope, string> = {
  read: 'Read-only actions: file reads and listings.',
  write: 'File writes and edits.',
  exec: 'Shell and command execution.',
  network: 'Outbound network calls and fetches.',
  install: 'Package installs and system changes.',
};

export function normalizePolicy(raw: unknown): AutoApprovePolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTO_APPROVE_POLICY };
  const p = raw as Partial<AutoApprovePolicy>;
  const scopes = Array.isArray(p.scopes)
    ? [...new Set(p.scopes.filter(isAutoApproveScope))].sort((a, b) => RANK[a] - RANK[b])
    : [];
  return {
    enabled: p.enabled === true && scopes.length > 0,
    scopes,
    reason: typeof p.reason === 'string' ? p.reason : undefined,
  };
}

// Legacy single boolean migration: a stored `true` maps to a disabled
// policy until the user re-enables it scope by scope.
export function fromLegacyGlobal(autoApproveGlobal: boolean): AutoApprovePolicy {
  void autoApproveGlobal;
  return { ...DEFAULT_AUTO_APPROVE_POLICY };
}

export function isScopeAllowed(policy: AutoApprovePolicy, scope: AutoApproveScope): boolean {
  return policy.enabled && policy.scopes.includes(scope);
}

export function describePolicy(policy: AutoApprovePolicy): string {
  if (!policy.enabled || policy.scopes.length === 0) return 'Manual approval for everything';
  return `Auto-approve: ${policy.scopes.join(', ')}`;
}
