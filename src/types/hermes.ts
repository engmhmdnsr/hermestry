export interface MobileSession {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  lastActiveAt: number;
  costUsd: number;
  source: string;
}

// On-device project: a host folder symlinked into the gateway so agent
// turns can work on device files. guestPath is /root/.projects/<id>.
export interface Project {
  id: string;
  name: string;
  hostPath: string;
  guestPath: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  sender: 'you' | 'hermes';
  content: string;
  thinking?: string;
  thinkingDone?: boolean;
  tools?: string[];
  toolOutputs?: Array<{ toolName: string; output: string }>;
  timestamp?: number;
}

export interface CronJob {
  id: string;
  name: string;
  scheduleDisplay: string;
  scheduleRaw?: string;
  prompt: string;
  enabled: boolean;
  state: string;
  nextRunAt: string;
  lastStatus: string;
  lastError: string;
}

export interface AiModelInfo {
  id: string;
  displayName: string;
  provider?: string;
  source?: 'live' | 'offline-fallback';
}

export interface ConfiguredProvider {
  id: string;
  provider: string; // e.g. 'deepseek', 'gemini', 'anthropic', 'openai-api', 'ollama-cloud'
  name: string; // custom or display label
  /**
   * @deprecated Plaintext legacy field. Never persisted going forward;
   * use secretRef (vault-map key) via providerStore instead.
   */
  apiKey?: string;
  /** Vault-map key holding this profile's key. See secretRefs.ts. */
  secretRef?: string;
  baseUrl?: string;
  defaultModel: string;
  enabled: boolean;
  validated?: boolean;
}

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface PendingApproval {
  runId: string;
  sessionId: string;
  summary: string;
  tool?: string;
  command?: string;
  path?: string;
  args?: string[];
  risk?: ApprovalRisk | string;
  cwd?: string;
  reason?: string;
  createdAt?: number;
  choices?: string[];
}

export interface GatewayStatus {
  ok: boolean;
  version: string;
  gatewayState: string;
  platforms: Record<string, string>;
  detail: string;
}

export interface CronRun {
  id: string;
  jobId: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  error: string;
}

export interface Blueprint {
  id: string;
  name: string;
  description: string;
  parameters?: Array<{ name: string; label: string; default?: string }>;
}

export interface UsageAnalytics {
  range: string;
  sessions: number;
  messages: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LogLine {
  timestamp: string;
  level: string;
  file: string;
  message: string;
}

export interface OpsResult {
  ok: boolean;
  message: string;
}

export interface OpsStatus {
  name: string;
  state: string;
  detail: string;
}

export interface DebugShare {
  // True only when the export actually produced something shareable. Callers
  // branch on it instead of guessing from a non-empty string, so a failure
  // never gets rendered as a success colour.
  ok: boolean;
  urls: string[];
  summary: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: string;
  version: string;
  checks: DoctorCheck[];
}

export interface BackupResult {
  ok: boolean;
  path: string;
  message: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface MemoryInfo {
  enabled: boolean;
  provider: string;
  summary: string;
  entries: number;
}

export type InstallState = 'NOT_INSTALLED' | 'INSTALLING' | 'INSTALLED' | 'RUNNING' | 'FAILED';

export type AgentStatus = 'ONLINE' | 'THINKING' | 'EXECUTING' | 'WAITING' | 'OFFLINE' | 'CONNECTING' | 'ERROR';

export interface TurnMeta {
  model: string;
  durationMs: number;
  stopped?: boolean;
  estimated?: boolean;
  error?: string;
}

export interface QueuedMessage {
  text: string;
  images: string[];
}
