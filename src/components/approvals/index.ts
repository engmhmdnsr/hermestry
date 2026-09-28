export { ApprovalCard } from './ApprovalCard';
export { AutoApproveGate } from './AutoApproveGate';
export {
  APPROVAL_SCOPES,
  AUTO_APPROVE_SCOPES,
  DEFAULT_AUTO_APPROVE_POLICY,
  SCOPE_DESCRIPTIONS,
  describePolicy,
  fromLegacyGlobal,
  isApprovalScope,
  isAutoApproveScope,
  isScopeAllowed,
  normalizePolicy,
} from './approvalScopes';
export type {
  ApprovalScope,
  AutoApprovePolicy,
  AutoApproveScope,
} from './approvalScopes';
export {
  PENDING_APPROVALS_KEY,
  cachePending,
  loadCachedPending,
  mergeIncoming,
  reconcilePending,
  removeResolved,
  sanitizeApproval,
} from './pendingApprovals';
