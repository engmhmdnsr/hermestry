// Single gateway lifecycle machine, web-side half (GATEWAY-03/04/05,
// INSTALL-01..04). The native plugin (HermesGatewayPlugin.status) reports
// one of GATEWAY_STATES plus startup/install detail; every UI flag derives
// from that report via the helpers below. No component keeps its own
// gateway/install boolean alongside this: map then derive.
//
// Forbidden-file wiring lives in the integration spec (summary), not here:
// HermesContext.tsx owns the polling loop, nativeGateway.ts owns transport.

export const GATEWAY_STATES = [
  'UNINITIALIZED',
  'CHECKING',
  'NOT_INSTALLED',
  'INSTALLING',
  'INSTALLED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'DEGRADED',
  'FAILED',
] as const;

export type GatewayState = (typeof GATEWAY_STATES)[number];

export const STARTUP_PHASES = [
  'IDLE',
  'RENDER_CONFIG',
  'PROOT_CHECK',
  'LAUNCH',
  'WAIT_LISTEN',
  'HEALTH_PROBE',
  'READY',
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export const INSTALL_PHASES = [
  'CHECK_STORAGE',
  'DOWNLOAD',
  'VERIFY',
  'EXTRACT',
  'CONFIGURE',
  'DONE',
] as const;

export type InstallPhase = (typeof INSTALL_PHASES)[number];

/** Raw payload from HermesGatewayPlugin.status(). */
export interface NativeStatusReport {
  running: boolean;
  /** Machine value (upper-case) or a legacy string, see map function. */
  state: string;
  phase?: string;
  elapsedMs?: number;
  lastError?: string;
  logPath?: string;
  retryable?: boolean;
  installed?: boolean;
  appVersion?: string;
  gatewayVersion?: string;
  protocolVersion?: number;
  imageVersion?: string;
}

/** GATEWAY-04: where a STARTING gateway is plus how to recover. */
export interface StartupReport {
  phase: StartupPhase;
  elapsedMs: number;
  lastError: string;
  logPath: string;
  retryable: boolean;
}

/** GATEWAY-05: stop is real only when every flag holds. */
export interface StopVerification {
  processExited: boolean;
  portClosed: boolean;
  healthFalse: boolean;
  verified: boolean;
}

/** INSTALL-03: phased install progress for the progress bar. */
export interface InstallProgress {
  phase: InstallPhase;
  downloaded: number;
  total: number;
  percent: number;
  message: string;
}

/** INSTALL-01: app/gateway/protocol compatibility metadata. */
export interface GatewayCompat {
  appVersion: string;
  gatewayVersion: string;
  protocolVersion: number;
  imageVersion: string;
  compatible: boolean;
  compatError: string;
}

/** INSTALL-04: pre-install storage calculation. */
export interface StoragePreflight {
  freeBytes: number;
  neededBytes: number;
  enough: boolean;
}

export const GATEWAY_PORT = 8080;
export const GATEWAY_LOG_NAME = 'gateway.log';

const asGatewayState = (s: string): GatewayState | null =>
  (GATEWAY_STATES as readonly string[]).includes(s) ? (s as GatewayState) : null;

/**
 * Map a native status report to the single machine. Accepts the upper-case
 * machine values plus every legacy string the old plugin/UI produced:
 * running, down, failed[: reason], installed_stopped, not_installed.
 * Unknown input falls back to health: running=true -> RUNNING, else CHECKING
 * (never FAILED: absence of signal is not failure).
 */
export function mapNativeStatusToGatewayState(report: NativeStatusReport): GatewayState {
  const direct = asGatewayState(String(report.state ?? '').toUpperCase());
  if (direct) return direct;
  const raw = String(report.state ?? '').toLowerCase();
  if (raw === 'running') return 'RUNNING';
  if (raw.startsWith('failed')) return 'FAILED';
  if (raw === 'installed_stopped' || raw === 'stopped') return 'STOPPED';
  if (raw === 'not_installed') return 'NOT_INSTALLED';
  if (raw === 'installing') return 'INSTALLING';
  if (raw === 'starting') return 'STARTING';
  if (raw === 'stopping') return 'STOPPING';
  if (raw === 'degraded') return 'DEGRADED';
  if (raw === 'installed') return 'INSTALLED';
  if (raw === 'checking') return 'CHECKING';
  return report.running ? 'RUNNING' : 'CHECKING';
}

/** Legacy InstallState fold: the wizard only needs these five. */
export function toLegacyInstallState(s: GatewayState): string {
  switch (s) {
    case 'NOT_INSTALLED':
      return 'NOT_INSTALLED';
    case 'INSTALLING':
    case 'CHECKING':
    case 'STARTING':
    case 'STOPPING':
      return 'INSTALLING';
    case 'FAILED':
    case 'DEGRADED':
      return 'FAILED';
    case 'RUNNING':
      return 'RUNNING';
    default:
      return 'INSTALLED';
  }
}

export interface GatewayUiFlags {
  canStart: boolean;
  canStop: boolean;
  canInstall: boolean;
  showRetry: boolean;
  showProgress: boolean;
  isStable: boolean;
}

/**
 * Derive every button/spinner from the machine (GATEWAY-03).
 * There is deliberately no English `label` here: a word a person reads has
 * to come from the locale bundle, and the UI builds it from the same state.
 */
export function deriveUiFlags(s: GatewayState): GatewayUiFlags {
  switch (s) {
    case 'NOT_INSTALLED':
      return { canStart: false, canStop: false, canInstall: true, showRetry: false, showProgress: false, isStable: true };
    case 'INSTALLING':
      return { canStart: false, canStop: false, canInstall: false, showRetry: false, showProgress: true, isStable: false };
    case 'CHECKING':
    case 'STARTING':
      return { canStart: false, canStop: true, canInstall: false, showRetry: false, showProgress: true, isStable: false };
    case 'RUNNING':
      return { canStart: false, canStop: true, canInstall: false, showRetry: false, showProgress: false, isStable: true };
    case 'STOPPING':
      return { canStart: false, canStop: false, canInstall: false, showRetry: false, showProgress: true, isStable: false };
    case 'STOPPED':
    case 'INSTALLED':
      return { canStart: true, canStop: false, canInstall: false, showRetry: false, showProgress: false, isStable: true };
    case 'DEGRADED':
      return { canStart: false, canStop: true, canInstall: false, showRetry: true, showProgress: false, isStable: true };
    case 'FAILED':
      return { canStart: true, canStop: false, canInstall: false, showRetry: true, showProgress: false, isStable: true };
    default:
      return { canStart: false, canStop: false, canInstall: false, showRetry: false, showProgress: true, isStable: false };
  }
}

/** Transitional states: poll fast, block Start/Install. */
export function isTransitional(s: GatewayState): boolean {
  return (
    s === 'UNINITIALIZED' ||
    s === 'CHECKING' ||
    s === 'INSTALLING' ||
    s === 'STARTING' ||
    s === 'STOPPING'
  );
}

/** Mirror of Bootstrap.installPhaseForLine (Kotlin): fallback line parser. */
export function parseInstallPhase(line: string): InstallPhase | null {
  const t = line.toLowerCase();
  if (t.includes('storage:') || t.includes('needs_space') || t.includes('no space left')) return 'CHECK_STORAGE';
  if (t.includes('downloading')) return 'DOWNLOAD';
  if (t.includes('checksum') || t.includes('verifying')) return 'VERIFY';
  if (t.includes('extracting') || t.includes('linking') || t.includes('clearing previous rootfs')) return 'EXTRACT';
  if (
    t.includes('writing gateway config') ||
    t.includes('proot') ||
    t.includes('dns fixed') ||
    t.includes('installing hermes-agent') ||
    t.includes('debian rootfs ready') ||
    t.includes('prebuilt image ready') ||
    t.includes('proot ready')
  )
    return 'CONFIGURE';
  if (t.trim() === 'done' || t.includes('already installed')) return 'DONE';
  return null;
}

export function startupReportFromStatus(r: NativeStatusReport): StartupReport {
  const phase = (STARTUP_PHASES as readonly string[]).includes(String(r.phase ?? '').toUpperCase())
    ? (String(r.phase).toUpperCase() as StartupPhase)
    : 'IDLE';
  return {
    phase,
    elapsedMs: Number(r.elapsedMs ?? 0) || 0,
    lastError: String(r.lastError ?? ''),
    logPath: String(r.logPath ?? GATEWAY_LOG_NAME),
    retryable: r.retryable === true,
  };
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STARTUP_PHASE_LABELS: Record<StartupPhase, string> = {
  IDLE: 'Idle',
  RENDER_CONFIG: 'Writing gateway config',
  PROOT_CHECK: 'Checking runtime',
  LAUNCH: 'Launching gateway process',
  WAIT_LISTEN: 'Waiting for listen port',
  HEALTH_PROBE: 'Probing health endpoint',
  READY: 'Ready',
};

export function startupPhaseLabel(p: StartupPhase): string {
  return STARTUP_PHASE_LABELS[p] ?? p;
}
