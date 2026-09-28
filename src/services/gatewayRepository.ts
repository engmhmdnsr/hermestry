// Gateway Repository: the single typed layer over GatewayService (T6).
//
// Reads return QueryState<T> with an explicit live / stale / error status so
// the UI never has to infer failure from an empty list. Writes return
// MutationResult<T> with a typed AppError instead of a bare false. All
// failures flow through toAppError(); nothing is swallowed.
//
// This layer wraps GatewayService without modifying it. Reads retry via the
// centralized policy (idempotent GETs only); writes and streams run once.

import type { GatewayService, StreamChatCallbacks } from './gateway';
import type {
  AiModelInfo,
  BackupResult,
  Blueprint,
  ChatMessage,
  CronJob,
  CronRun,
  DebugShare,
  DoctorReport,
  GatewayStatus,
  LogLine,
  MemoryInfo,
  MobileSession,
  PendingApproval,
  SkillInfo,
  UsageAnalytics,
} from '../types/hermes';
import { type AppError, toAppError } from './appErrors';
import { withRetry } from './retry';

export type QueryStatus = 'live' | 'stale' | 'error';

export interface QueryState<T> {
  status: QueryStatus;
  data: T;
  error?: AppError;
  live: boolean;
  stale: boolean;
}

export interface MutationResult<T = void> {
  ok: boolean;
  data?: T;
  error?: AppError;
}

export interface RepositoryStreamCallbacks extends StreamChatCallbacks {
  onAppError?: (err: AppError) => void;
}

export function isLive<T>(state: QueryState<T>): boolean {
  return state.status === 'live';
}

export function isStale<T>(state: QueryState<T>): boolean {
  return state.status === 'stale';
}

export function isQueryError<T>(state: QueryState<T>): boolean {
  return state.status === 'error';
}

function live<T>(data: T): QueryState<T> {
  return { status: 'live', data, live: true, stale: false };
}

function stale<T>(data: T, error: AppError): QueryState<T> {
  return { status: 'stale', data, error, live: false, stale: true };
}

function failed<T>(data: T, error: AppError): QueryState<T> {
  return { status: 'error', data, error, live: false, stale: false };
}

function ok(): MutationResult<void>;
function ok<T>(data: T): MutationResult<T>;
function ok<T>(data?: T): MutationResult<T> {
  return data === undefined ? { ok: true } : { ok: true, data };
}

function fail<T = void>(error: AppError): MutationResult<T> {
  return { ok: false, error };
}

function unwrapList<T>(value: T[] & { stale?: boolean; live?: boolean }): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function unwrapValue<T extends object>(value: T & { stale?: boolean; live?: boolean }): T {
  const { live: _live, stale: _stale, ...rest } = value;
  void _live;
  void _stale;
  return rest as T;
}

export class GatewayRepository {
  constructor(private readonly gateway: GatewayService) {}

  get service(): GatewayService {
    return this.gateway;
  }

  // Reads: idempotent, retried, stale fallback where a local cache exists.

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      return await withRetry(() => this.gateway.health(signal), { idempotent: true, signal });
    } catch {
      return false;
    }
  }

  async healthDetailed(signal?: AbortSignal): Promise<QueryState<GatewayStatus>> {
    try {
      const data = await withRetry(() => this.gateway.healthDetailed(signal), {
        idempotent: true,
        signal,
      });
      return data.ok
        ? live(data)
        : failed(data, toAppError(`Gateway unhealthy: ${data.detail || data.gatewayState || 'unknown'}`));
    } catch (raw) {
      const error = toAppError(raw);
      return failed(
        { ok: false, version: '', gatewayState: 'down', platforms: {}, detail: error.message },
        error
      );
    }
  }

  async modelOptions(provider = 'deepseek', signal?: AbortSignal): Promise<QueryState<AiModelInfo[]>> {
    try {
      const data = await withRetry(() => this.gateway.modelOptions(provider, signal), {
        idempotent: true,
        signal,
      });
      return live(data);
    } catch (raw) {
      return failed([], toAppError(raw));
    }
  }

  async sessions(signal?: AbortSignal): Promise<QueryState<MobileSession[]>> {
    try {
      // fetchSessionsPage never throws: transport failures come back as a
      // stale/error envelope, so branch on its live/stale flags instead of
      // treating every resolved list as live.
      const page = await withRetry(
        () => this.gateway.fetchSessionsPage({ limit: 100, offset: 0 }, signal),
        { idempotent: true, signal }
      );
      if (page.live) return live([...page.items]);
      if (page.stale) return stale([...page.items], toAppError(page.error || 'Sessions unavailable.'));
      return failed([], toAppError(page.error || 'Sessions unavailable.'));
    } catch (raw) {
      return failed([], toAppError(raw));
    }
  }

  async sessionMessages(sessionId: string, signal?: AbortSignal): Promise<QueryState<ChatMessage[]>> {
    try {
      const data = await withRetry(() => this.gateway.sessionMessages(sessionId, signal), {
        idempotent: true,
        signal,
      });
      return live(data);
    } catch (raw) {
      const error = toAppError(raw);
      const cached = this.gateway.loadLocalMessages(sessionId);
      return cached.length > 0 ? stale(cached, error) : failed([], error);
    }
  }

  async jobs(signal?: AbortSignal): Promise<QueryState<CronJob[]>> {
    try {
      const data = await withRetry(() => this.gateway.jobs(signal), { idempotent: true, signal });
      return live(data);
    } catch (raw) {
      const error = toAppError(raw);
      const cached = this.gateway.loadLocalJobs();
      return cached.length > 0 ? stale(cached, error) : failed([], error);
    }
  }

  async cronRuns(jobId: string, signal?: AbortSignal): Promise<QueryState<CronRun[]>> {
    try {
      const data = await withRetry(() => this.gateway.cronRuns(jobId, signal), {
        idempotent: true,
        signal,
      });
      return live(unwrapList(data));
    } catch (raw) {
      return failed([], toAppError(raw));
    }
  }

  async skills(signal?: AbortSignal): Promise<QueryState<SkillInfo[]>> {
    try {
      // skillsWithState never throws: failures arrive as a non-live envelope,
      // so map non-live to failed instead of live([]).
      const result = await withRetry(() => this.gateway.skillsWithState(signal), {
        idempotent: true,
        signal,
      });
      if (result.live) return live([...result.items]);
      if (result.stale) {
        return stale([...result.items], toAppError(result.error || 'Skills unavailable.'));
      }
      return failed([], toAppError(result.error || 'Skills unavailable.'));
    } catch (raw) {
      return failed([], toAppError(raw));
    }
  }

  async memory(signal?: AbortSignal): Promise<QueryState<MemoryInfo>> {
    try {
      const data = await withRetry(() => this.gateway.memoryGet(signal), {
        idempotent: true,
        signal,
      });
      return data.live
        ? live(unwrapValue(data))
        : stale(unwrapValue(data), toAppError('Memory unavailable.'));
    } catch (raw) {
      const error = toAppError(raw);
      return failed({ enabled: false, provider: '', summary: error.message, entries: 0 }, error);
    }
  }

  async blueprints(signal?: AbortSignal): Promise<QueryState<Blueprint[]>> {
    try {
      // blueprintsWithState never throws: failures arrive as a non-live
      // envelope, so map non-live to failed instead of live([]).
      const result = await withRetry(() => this.gateway.blueprintsWithState(signal), {
        idempotent: true,
        signal,
      });
      if (result.live) return live([...result.items]);
      if (result.stale) {
        return stale([...result.items], toAppError(result.error || 'Blueprints unavailable.'));
      }
      return failed([], toAppError(result.error || 'Blueprints unavailable.'));
    } catch (raw) {
      return failed([], toAppError(raw));
    }
  }

  async logs(
    level = '',
    query = '',
    limit = 200,
    signal?: AbortSignal
  ): Promise<QueryState<LogLine[]>> {
    try {
      const data = await withRetry(() => this.gateway.serverLogs(level, query, limit, signal), {
        idempotent: true,
        signal,
      });
      return live(unwrapList(data));
    } catch (raw) {
      return failed([], toAppError(raw));
    }
  }

  async usage(range = '7d', signal?: AbortSignal): Promise<QueryState<UsageAnalytics>> {
    const empty: UsageAnalytics = {
      range,
      sessions: 0,
      messages: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    try {
      const data = await withRetry(() => this.gateway.usageAnalytics(range, signal), {
        idempotent: true,
        signal,
      });
      return data.live
        ? live(unwrapValue(data))
        : stale(unwrapValue(data), toAppError('Usage unavailable.'));
    } catch (raw) {
      return failed({ ...empty }, toAppError(raw));
    }
  }

  async doctor(signal?: AbortSignal): Promise<QueryState<DoctorReport>> {
    try {
      const data = await withRetry(() => this.gateway.doctor(signal), { idempotent: true, signal });
      return data.ok ? live(data) : failed(data, toAppError(data.summary || 'Doctor check failed.'));
    } catch (raw) {
      const error = toAppError(raw);
      return failed({ ok: false, summary: error.message, version: '', checks: [] }, error);
    }
  }

  async backup(signal?: AbortSignal): Promise<MutationResult<BackupResult>> {
    try {
      const data = await withRetry(() => this.gateway.backup(signal), {
        idempotent: false,
        signal,
      });
      return data.ok ? ok(data) : fail(toAppError(data.message || 'Backup failed.'));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async debugShare(signal?: AbortSignal): Promise<MutationResult<DebugShare>> {
    try {
      const data = await withRetry(() => this.gateway.debugShare(signal), {
        idempotent: false,
        signal,
      });
      const succeeded = data.urls.length > 0 && !/failed/i.test(data.summary);
      return succeeded ? ok(data) : fail(toAppError(data.summary || 'Debug share failed.'));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  // Writes: non-idempotent, single attempt, typed errors.

  async createSession(
    model: string,
    title?: string,
    signal?: AbortSignal
  ): Promise<MutationResult<string>> {
    try {
      const id = await withRetry(() => this.gateway.createSession(model, title, signal), {
        idempotent: false,
        signal,
      });
      return ok(id);
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async deleteSession(id: string, signal?: AbortSignal): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.deleteSession(id, signal), {
        idempotent: false,
        signal,
      });
      return done
        ? ok()
        : fail(toAppError(`Delete session failed: gateway returned an error for ${id}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async renameSession(id: string, title: string, signal?: AbortSignal): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.renameSession(id, title, signal), {
        idempotent: false,
        signal,
      });
      return done
        ? ok()
        : fail(toAppError(`Rename session failed: gateway returned an error for ${id}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async forkSession(id: string, signal?: AbortSignal): Promise<MutationResult<string>> {
    try {
      const newId = await withRetry(() => this.gateway.forkSession(id, signal), {
        idempotent: false,
        signal,
      });
      return newId
        ? ok(newId)
        : fail<string>(toAppError(`Fork session failed: gateway returned no id for ${id}.`));
    } catch (raw) {
      return fail<string>(toAppError(raw));
    }
  }

  async stopRun(runId: string, signal?: AbortSignal): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.stopRun(runId, signal), {
        idempotent: false,
        signal,
      });
      return done ? ok() : fail(toAppError(`Stop run failed for ${runId}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async listPendingApprovalsDetailed(
    signal?: AbortSignal
  ): Promise<{ items: PendingApproval[]; reachable: boolean }> {
    // Additive: GatewayService.listPendingApprovals returns [] both when the
    // queue is empty and when the gateway is unreachable, so disambiguate
    // with a health probe only when the list comes back empty.
    try {
      const items = await withRetry(() => this.gateway.listPendingApprovals(signal), {
        idempotent: true,
        signal,
      });
      if (items.length > 0) return { items, reachable: true };
      return { items, reachable: await this.health(signal) };
    } catch {
      return { items: [], reachable: false };
    }
  }

  async resolveApproval(
    runId: string,
    allow: boolean,
    mode = 'once',
    signal?: AbortSignal
  ): Promise<MutationResult> {
    try {
      const done = await withRetry(
        () => this.gateway.resolveApproval(runId, allow, mode, signal),
        { idempotent: false, signal }
      );
      return done
        ? ok()
        : fail(toAppError(`Approval ${allow ? 'grant' : 'denial'} failed for run ${runId}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async createJob(
    name: string,
    schedule: string,
    prompt: string,
    signal?: AbortSignal
  ): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.createJob(name, schedule, prompt, signal), {
        idempotent: false,
        signal,
      });
      return done ? ok() : fail(toAppError(`Create job failed for "${name}".`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async updateJob(
    id: string,
    patch: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.updateJob(id, patch, signal), {
        idempotent: false,
        signal,
      });
      return done ? ok() : fail(toAppError(`Update job failed for ${id}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async jobAction(id: string, action: string, signal?: AbortSignal): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.jobAction(id, action, signal), {
        idempotent: false,
        signal,
      });
      return done ? ok() : fail(toAppError(`Job action "${action}" failed for ${id}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async skillToggle(id: string, enabled: boolean, signal?: AbortSignal): Promise<MutationResult> {
    try {
      const done = await withRetry(() => this.gateway.skillToggle(id, enabled, signal), {
        idempotent: false,
        signal,
      });
      return done ? ok() : fail(toAppError(`Skill toggle failed for ${id}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async instantiateBlueprint(
    id: string,
    slots: Record<string, string>,
    signal?: AbortSignal
  ): Promise<MutationResult> {
    try {
      const done = await withRetry(
        () => this.gateway.instantiateBlueprint(id, slots, signal),
        { idempotent: false, signal }
      );
      return done ? ok() : fail(toAppError(`Instantiate blueprint failed for ${id}.`));
    } catch (raw) {
      return fail(toAppError(raw));
    }
  }

  async validateProvider(
    provider: string,
    envVar: string,
    key: string,
    signal?: AbortSignal
  ): Promise<MutationResult<boolean>> {
    try {
      const valid = await withRetry(
        () => this.gateway.providersValidate(provider, envVar, key, signal),
        { idempotent: false, signal }
      );
      if (valid === null) {
        return fail<boolean>(toAppError('Provider validation failed: gateway unreachable.'));
      }
      return valid
        ? ok<boolean>(true)
        : fail<boolean>(toAppError('Provider key rejected by the gateway.'));
    } catch (raw) {
      return fail<boolean>(toAppError(raw));
    }
  }

  // Streaming: long lived and non-idempotent, so never retried. Transport
  // error strings are also surfaced as AppError via onAppError.
  async streamChat(
    sessionId: string,
    model: string,
    message: string,
    reasoningEffort: string,
    imageDataUrls: string[],
    callbacks: RepositoryStreamCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const { onAppError, onError, ...rest } = callbacks;
    await this.gateway.streamChat(
      sessionId,
      model,
      message,
      reasoningEffort,
      imageDataUrls,
      {
        ...rest,
        onError: (msg: string) => {
          onError?.(msg);
          onAppError?.(toAppError(msg));
        },
      },
      abortSignal
    );
  }

  // Local cache passthroughs (synchronous, unchanged semantics).
  // loadLocalSessions stays private on GatewayService (T7 owns it).

  saveLocalSessions(sessions: MobileSession[]): void {
    this.gateway.saveLocalSessions(sessions);
  }

  loadLocalMessages(sessionId: string): ChatMessage[] {
    return this.gateway.loadLocalMessages(sessionId);
  }

  saveLocalMessages(sessionId: string, messages: ChatMessage[]): void {
    this.gateway.saveLocalMessages(sessionId, messages);
  }

  loadLocalJobs(): CronJob[] {
    return this.gateway.loadLocalJobs();
  }

  saveLocalJobs(jobs: CronJob[]): void {
    this.gateway.saveLocalJobs(jobs);
  }
}
