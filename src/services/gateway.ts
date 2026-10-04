import {
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
import type { ListSyncResult, PagedResult } from './syncState';
import { gwFetch } from './gwFetch';
import {
  DEFAULT_MESSAGES_PAGE_SIZE,
  DEFAULT_RUNS_PAGE_SIZE,
  DEFAULT_SESSIONS_PAGE_SIZE,
  MAX_MESSAGES_PAGE_SIZE,
  MAX_RUNS_PAGE_SIZE,
  MAX_SESSIONS_PAGE_SIZE,
  MESSAGE_RETENTION_CAP,
  buildPageQuery,
  capMessages,
  clampPage,
  liveMeta,
  pickArray,
  readSyncedAt,
  staleMeta,
  toPagedResult,
  writeSyncedAt,
  type PageParams,
} from './pagination';

export interface StreamChatCallbacks {
  onRunId?: (runId: string) => void;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  onTool: (toolName: string) => void;
  onToolOutput?: (toolName: string, output: string) => void;
  onUsage: (inputTokens: number, outputTokens: number) => void;
  onApproval: (approval: PendingApproval) => void;
  onThinkingDone: () => void;
  onError?: (message: string) => void;
  onStopped?: () => void;
}

// Honesty flags for data that may be served from a local fallback when the
// gateway is unreachable. stale is always false (we never serve cached
// gateway data as fresh), live tells the UI whether the payload came from
// a live gateway response.
export interface LiveFlag {
  stale: boolean;
  live: boolean;
}

export type LiveValue<T> = T & LiveFlag;
export type LiveList<T> = T[] & LiveFlag;

// One client-context probe of the chat path: resolved URL, reachability,
// HTTP status, latency, and the exception class/message on failure. No key
// material is ever placed in a detail string.
export interface ConnectionPathProbe {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConnectionPathReport {
  url: string;
  ok: boolean;
  probes: ConnectionPathProbe[];
}

const REQUEST_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 5000;
const JOB_ACTIONS = new Set(['pause', 'resume', 'run', 'delete']);

// Existing key/auth hint copy (same words as the context errGatewayAuthHint
// fallback): a 401/403 anywhere in the list fetchers below names the key fix
// instead of a generic load failure. The HTTP token stays in the string
// because context authStatusFromError recognises it to mark the gateway
// unauthorized.
const AUTH_HINT_COPY =
  'Hermes rejected the stored key. Check the provider key and Base URL in Settings, then try again.';

// Honest cause for a failed skills fetch, most actionable first. A rejected
// key names the key fix, an on-device 5xx names the server error with a
// retry (the error UI state keeps its Retry action); anything else keeps
// the generic trailing status.
const honestSkillsCause = (authStatus: string, serverStatus: string, lastStatus: string): string => {
  if (authStatus) return `${authStatus}. ${AUTH_HINT_COPY}`;
  if (serverStatus)
    return `${serverStatus}. The on-device server returned an error. Retry, and check the connection if it repeats.`;
  return lastStatus;
};

import { redactSecrets } from './redaction';
import { plainGatewayFailure, plainListStale, plainServiceFailure } from './plainFailure';
import { createAppError } from './appErrors';
import { withRetry } from './retry';
import { validateProvider, type ProviderValidationInput } from './providerValidation';
import { KEYLESS_PROVIDERS, normProvider } from '../constants/providers';
export { REDACTED } from './redaction';

export class GatewayService {
  private baseUrl: string;
  // Last non-OK HTTP status from a boolean toggle write (null when the last
  // write succeeded or never ran): the UI appends it so a rejected toggle
  // keeps the server's verdict instead of degrading to a bare boolean.
  lastToggleStatus: number | null = null;
  private apiKey: () => string;
  private isConnected: boolean = false;
  /** Last live-catalog fetch outcome: null = ok (or never ran), else a short reason. */
  public lastModelsError: string | null = null;
  /** Live-catalog entry count from the last successful fetch (0 when never/failed). */
  public lastModelsLiveCount: number = 0;

  constructor(baseUrl: string = 'http://127.0.0.1:8080', apiKey: () => string = () => '') {
    this.baseUrl = '';
    this.apiKey = apiKey;
    this.setBaseUrl(baseUrl);
  }

  setBaseUrl(url: string) {
    const normalized = url.trim().replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new Error('Invalid base URL: scheme must be http or https');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid base URL: scheme must be http or https');
    }
    const host = parsed.hostname.toLowerCase();
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (parsed.protocol === 'http:' && !loopback) {
      throw new Error('Invalid base URL: http is allowed only for loopback hosts, use https otherwise');
    }
    this.baseUrl = normalized;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const key = this.apiKey();
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    return headers;
  }

  // Combine a fixed timeout with an optional caller abort signal so every
  // request is bounded even when the caller does not pass a signal.
  private requestSignal(caller: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    if (!caller) return timeout;
    if (caller.aborted) return caller;
    return AbortSignal.any([caller, timeout]);
  }

  private flagList<T>(data: T[], live: boolean): LiveList<T> {
    return Object.assign(data, { stale: false, live });
  }

  private flagValue<T extends object>(data: T, live: boolean): LiveValue<T> {
    return Object.assign(data, { stale: false, live });
  }

  async health(callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/health`, {
        signal: this.requestSignal(callerSignal, HEALTH_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      this.isConnected = res.ok;
      return res.ok;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  async healthDetailed(callerSignal?: AbortSignal): Promise<GatewayStatus> {
    try {
      const res = await gwFetch(`${this.baseUrl}/health/detailed`, {
        signal: this.requestSignal(callerSignal, HEALTH_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          ok: false,
          version: '',
          gatewayState: '',
          platforms: {},
          detail: `HTTP ${res.status}`,
        };
      }
      const data = await res.json();
      const platforms: Record<string, string> = {};
      if (data.platforms) {
        for (const [k, v] of Object.entries(data.platforms)) {
          platforms[k] = (v as { state?: string })?.state || '?';
        }
      }
      return {
        ok: true,
        version: data.version || '1.3.0',
        gatewayState: data.gateway_state || data.readiness?.status || 'ready',
        platforms,
        detail: '',
      };
    } catch (e: unknown) {
      return {
        ok: false,
        version: '',
        gatewayState: 'down',
        platforms: {},
        detail: plainServiceFailure(e),
      };
    }
  }

  // Client-context connection path test: the same gwFetch path and the same
  // auth headers the chat stream uses, split into two probes so a dead
  // gateway (probe 1 fails) reads differently from a live gateway with a
  // rejected key (probe 1 passes, probe 2 reports auth). Runs from the
  // WebView on web and through the native bridge on device, exactly like
  // chat traffic.
  async connectionPathTest(callerSignal?: AbortSignal): Promise<ConnectionPathReport> {
    const probes: ConnectionPathProbe[] = [];
    try {
      const t0 = Date.now();
      const res = await gwFetch(`${this.baseUrl}/health`, {
        signal: this.requestSignal(callerSignal, HEALTH_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      const ms = Date.now() - t0;
      probes.push({
        name: 'GET /health',
        ok: res.ok,
        detail: `HTTP ${res.status} in ${ms}ms`,
      });
    } catch (e: unknown) {
      const err = e as Error;
      probes.push({
        name: 'GET /health',
        ok: false,
        detail: `${err?.name || 'Error'}: ${err?.message || String(e)}`,
      });
    }
    try {
      const t0 = Date.now();
      await this.modelOptions('', callerSignal);
      const ms = Date.now() - t0;
      if (this.lastModelsError) {
        probes.push({
          name: 'GET /api/model/options',
          ok: false,
          detail: `${this.lastModelsError} in ${ms}ms`,
        });
      } else {
        probes.push({
          name: 'GET /api/model/options',
          ok: true,
          detail: `${this.lastModelsLiveCount} models in ${ms}ms`,
        });
      }
    } catch (e: unknown) {
      const err = e as Error;
      probes.push({
        name: 'GET /api/model/options',
        ok: false,
        detail: `${err?.name || 'Error'}: ${err?.message || String(e)}`,
      });
    }
    return {
      url: this.baseUrl,
      ok: probes.length > 0 && probes.every((p) => p.ok),
      probes,
    };
  }

  // Live model catalog (single source of truth). The provider hint is sent as
  // ?provider= when known, but the whole response is parsed either way: the
  // gateway may answer unfiltered, and every provider's models must appear.
  // Accepts all shapes gateways return: {providers:[{slug, models}]},
  // a top-level {models:[...]}, OpenAI-style {data:[...]}, direct arrays,
  // and dictionary maps {providers:{slug:[...]}} or {slug:[...]}.
  async modelOptions(provider: string = '', callerSignal?: AbortSignal): Promise<AiModelInfo[]> {
    try {
      const hint = (provider || '').trim();
      const url = hint
        ? `${this.baseUrl}/api/model/options?provider=${encodeURIComponent(hint)}`
        : `${this.baseUrl}/api/model/options`;
      const res = await gwFetch(url, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        this.lastModelsError = res.status === 401 || res.status === 403 ? 'auth' : `HTTP ${res.status}`;
        this.lastModelsLiveCount = 0;
        return [];
      }
      const data = await res.json();
      if (data && typeof data === 'object') {
        const rec = data as Record<string, unknown>;
        const err = rec.error ?? rec.detail ?? (rec.ok === false && rec.message ? rec.message : undefined);
        if (typeof err === 'string' && err.trim()) {
          const lower = err.toLowerCase();
          this.lastModelsError = (lower.includes('auth') || lower.includes('key') || lower.includes('unauthorized') || lower.includes('forbidden'))
            ? 'auth'
            : err.trim();
          this.lastModelsLiveCount = 0;
          return [];
        }
      }
      const out: AiModelInfo[] = [];
      const seen = new Set<string>();
      const pushModel = (rawId: unknown, rawName: unknown, slug: string) => {
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!id || id.toLowerCase().includes('embed') || seen.has(id)) return;
        seen.add(id);
        const label = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id.split('/').pop() || id;
        const clean = label.replace(/[-_]/g, ' ');
        out.push({
          id,
          displayName: clean.charAt(0).toUpperCase() + clean.slice(1),
          provider: slug || hint,
          source: 'live',
        });
      };
      const readEntry = (entry: unknown, slug: string) => {
        if (typeof entry === 'string') {
          pushModel(entry, '', slug);
          return;
        }
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>;
          const id = rec.id ?? rec.model ?? rec.name;
          const name = rec.displayName ?? rec.display_name ?? rec.label ?? rec.title;
          pushModel(id, typeof name === 'string' ? name : '', slug);
        }
      };

      // Direct array shape
      if (Array.isArray(data)) {
        for (const item of data) readEntry(item, hint);
      }

      // OpenAI-style {data: [...]} shape
      if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
        for (const item of (data as { data: unknown[] }).data) readEntry(item, hint);
      }

      // Top-level {models: [...]} shape
      if (data && typeof data === 'object' && Array.isArray((data as { models?: unknown }).models)) {
        for (const id of (data as { models: unknown[] }).models) readEntry(id, hint);
      }

      // Top-level {models: {id: info}} dictionary shape
      if (
        data &&
        typeof data === 'object' &&
        (data as { models?: unknown }).models &&
        typeof (data as { models: unknown }).models === 'object' &&
        !Array.isArray((data as { models: unknown }).models)
      ) {
        for (const [id, val] of Object.entries((data as { models: Record<string, unknown> }).models)) {
          if (val && typeof val === 'object') readEntry(val, hint);
          else pushModel(id, String(val || id), hint);
        }
      }

      // Provider list {providers: [{slug, models}]} shape
      if (data && typeof data === 'object' && Array.isArray((data as { providers?: unknown }).providers)) {
        for (const p of (data as { providers: unknown[] }).providers) {
          const slug = (p && typeof p === 'object'
            ? String((p as Record<string, unknown>).slug ?? (p as Record<string, unknown>).provider ?? (p as Record<string, unknown>).id ?? hint)
            : hint) || hint;
          const list = (p as { models?: unknown }).models;
          if (Array.isArray(list)) {
            for (const id of list) readEntry(id, slug);
          }
        }
      }

      // Provider dictionary {providers: {slug: models}} shape
      if (
        data &&
        typeof data === 'object' &&
        (data as { providers?: unknown }).providers &&
        typeof (data as { providers: unknown }).providers === 'object' &&
        !Array.isArray((data as { providers: unknown }).providers)
      ) {
        for (const [slug, val] of Object.entries((data as { providers: Record<string, unknown> }).providers)) {
          if (Array.isArray(val)) {
            for (const item of val) readEntry(item, slug);
          } else if (val && typeof val === 'object' && Array.isArray((val as { models?: unknown }).models)) {
            for (const item of (val as { models: unknown[] }).models) readEntry(item, slug);
          }
        }
      }

      // Generic provider dictionary shape { [providerSlug]: [...] }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
          if (key !== 'models' && key !== 'providers' && key !== 'data' && key !== 'ok' && key !== 'error' && key !== 'detail' && Array.isArray(val)) {
            for (const item of val) readEntry(item, key);
          }
        }
      }

      this.lastModelsError = null;
      this.lastModelsLiveCount = out.length;
      return out;
    } catch {
      this.lastModelsError = 'network';
      this.lastModelsLiveCount = 0;
      return [];
    }
  }

  // Sync-state storage keys for lastSyncedAt (DATA-03).
  public static readonly SYNC_KEYS = {
    sessions: 'hermes_sessions_synced_at',
    jobs: 'hermes_jobs_synced_at',
    skills: 'hermes_skills_synced_at',
    memory: 'hermes_memory_synced_at',
    blueprints: 'hermes_blueprints_synced_at',
    runs: 'hermes_runs_synced_at',
    logs: 'hermes_logs_synced_at',
    messages: (id: string) => `hermes_messages_${id}_synced_at`,
  };

  private normalizeSession(s: any): MobileSession {
    return {
      id: String(s.id),
      title: s.title || 'untitled',
      model: s.model || '',
      messageCount: s.message_count || 0,
      lastActiveAt: s.last_active ? s.last_active * 1000 : Date.now(),
      costUsd: s.actual_cost_usd || s.estimated_cost_usd || 0.0,
      source: s.source || '',
    };
  }

  private normalizeMessage(m: any, sessionId: string, idx: number): ChatMessage {
    return {
      id: m.id || `${sessionId}-msg-${idx}`,
      sender: m.role === 'assistant' ? 'hermes' : 'you',
      content: m.content || '',
      thinking: m.thinking || '',
      thinkingDone: true,
      tools: m.tools || [],
      timestamp: m.created_at ? m.created_at * 1000 : Date.now(),
    };
  }

  private normalizeJob(j: any): CronJob {
    return {
      id: String(j.id),
      name: j.name || 'job',
      scheduleDisplay: j.schedule_display || j.schedule?.display || '',
      // Raw schedule for the edit form: the display string ('once at ...')
      // never parses back, so editing must start from the source. Desktop
      // stores {kind, run_at|minutes|expr} (jobs.py parse_schedule), and
      // each form below re-parses: ISO stamp for once, 'every Nm' for
      // interval, the raw expression for cron.
      scheduleRaw:
        typeof j.schedule === 'string'
          ? j.schedule
          : j.schedule?.kind === 'once' && j.schedule?.run_at
            ? String(j.schedule.run_at)
            : j.schedule?.kind === 'interval' && j.schedule?.minutes != null
              ? `every ${Number(j.schedule.minutes)}m`
              : j.schedule?.kind === 'cron' && j.schedule?.expr
                ? String(j.schedule.expr)
                : '',
      prompt: j.prompt || '',
      // Desktop authority (jobs.py effective_job_state): terminal states are
      // preserved regardless of `enabled`; enabled=true rules otherwise.
      enabled:
        j.state === 'completed' || j.state === 'error'
          ? false
          : j.enabled === true || (j.enabled !== false && j.state !== 'paused'),
      state: j.state || 'scheduled',
      nextRunAt: j.next_run_at || '',
      lastStatus: j.last_status || '',
      lastError: j.last_error || j.last_run?.error || '',
    };
  }

  /**
   * Paginated sessions (DATA-01/03). Default page 50, max 100.
   * Failure returns cached slice with stale=true + lastSyncedAt + error,
   * never a bare list masquerading as live.
   */
  async fetchSessionsPage(
    params?: PageParams,
    callerSignal?: AbortSignal
  ): Promise<PagedResult<MobileSession>> {
    const page = clampPage(params, DEFAULT_SESSIONS_PAGE_SIZE, MAX_SESSIONS_PAGE_SIZE);
    try {
      const res = await gwFetch(`${this.baseUrl}/api/sessions${buildPageQuery(page, 'latest')}`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr, total } = pickArray(data, ['data', 'sessions']);
      const items = arr.map((s: any) => this.normalizeSession(s));
      const now = Date.now();
      if (page.offset === 0 && !page.cursor) {
        this.saveLocalSessions(items);
        writeSyncedAt(GatewayService.SYNC_KEYS.sessions, now);
      }
      return toPagedResult(items, liveMeta(now), page, total);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      const cached = this.loadLocalSessions();
      const slice = page.cursor ? cached.slice(0, page.limit) : cached.slice(page.offset, page.offset + page.limit);
      return toPagedResult(
        slice,
        staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.sessions), plainListStale('Sessions unavailable:', msg), cached.length > 0),
        page
      );
    }
  }

  /** Compat wrapper: first 100 sessions as a bare list (existing callers). */
  async fetchSessions(callerSignal?: AbortSignal): Promise<MobileSession[]> {
    const page = await this.fetchSessionsPage({ limit: 100, offset: 0 }, callerSignal);
    return page.items;
  }

  async createSession(model: string, title?: string, callerSignal?: AbortSignal): Promise<string> {
    const res = await gwFetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
      headers: this.getHeaders(),
      body: JSON.stringify({ model: model || undefined, title }),
    });
    if (!res.ok) {
      throw new Error(`Create session failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    const s = data.session || data;
    if (!s.id) {
      throw new Error('Create session failed: gateway returned no session id');
    }
    return String(s.id);
  }

  async deleteSession(id: string, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      // 404 means already gone: the local ghost must die too, not error out.
      if (res.status === 404) return true;
      return res.ok;
    } catch {
      return false;
    }
  }

  async renameSession(id: string, title: string, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ title }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async forkSession(id: string, callerSignal?: AbortSignal): Promise<string | null> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const s = data.session || data;
      if (!s.id) return null;
      return String(s.id);
    } catch {
      return null;
    }
  }

  /**
   * Paginated messages (DATA-02/03). Latest-50 first (offset 0), older-50
   * via offset 50/100... Local cache retains newest MESSAGE_RETENTION_CAP.
   */
  async sessionMessagesPage(
    sessionId: string,
    params?: PageParams,
    callerSignal?: AbortSignal
  ): Promise<PagedResult<ChatMessage>> {
    const page = clampPage(params, DEFAULT_MESSAGES_PAGE_SIZE, MAX_MESSAGES_PAGE_SIZE);
    const syncKey = GatewayService.SYNC_KEYS.messages(sessionId);
    try {
      const res = await gwFetch(
        `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages${buildPageQuery(page, 'latest')}`,
        {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr, total } = pickArray(data, ['data', 'messages']);
      const items = arr
        .filter((m: any) => m.role !== 'system')
        .map((m: any, idx: number) => this.normalizeMessage(m, sessionId, page.offset + idx));
      const now = Date.now();
      if (page.offset === 0 && !page.cursor) {
        // Merge, never replace. The local cache also holds offline-created
        // messages and history older than this page window, while an empty
        // server page is normal for a session the gateway has not caught up
        // on yet. Replacing here (as this used to) wiped local-only messages
        // and truncated the cached history to a single page, which then got
        // persisted as the whole truth. This merge mirrors what
        // HermesContext.selectSession does with the same two lists.
        const existing = this.loadLocalMessages(sessionId);
        const fromServer = new Set(items.map((m) => m.id));
        const localOnly = existing.filter((m) => !fromServer.has(m.id));
        const byTime = (a: ChatMessage, b: ChatMessage): number =>
          (a.timestamp || 0) - (b.timestamp || 0);
        this.saveLocalMessages(sessionId, [...items, ...localOnly].sort(byTime));
        writeSyncedAt(syncKey, now);
      }
      return toPagedResult(items, liveMeta(now), page, total);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      const cached = this.loadLocalMessages(sessionId);
      const slice = page.cursor
        ? cached.slice(0, page.limit)
        : cached.slice(page.offset, page.offset + page.limit);
      return toPagedResult(
        slice,
        staleMeta(readSyncedAt(syncKey), plainListStale('Messages unavailable:', msg), cached.length > 0),
        page
      );
    }
  }

  /** Compat wrapper: latest messages as a bare list (existing callers). */
  async sessionMessages(sessionId: string, callerSignal?: AbortSignal): Promise<ChatMessage[]> {
    const page = await this.sessionMessagesPage(
      sessionId,
      { limit: MESSAGE_RETENTION_CAP, offset: 0 },
      callerSignal
    );
    return page.items;
  }

  async stopRun(runId: string, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({}),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listPendingApprovals(callerSignal?: AbortSignal): Promise<{ items: PendingApproval[]; live: boolean }> {
    const paths = ['/v1/runs/pending', '/api/runs/pending', '/v1/approvals/pending'];
    for (const p of paths) {
      try {
        const res = await gwFetch(`${this.baseUrl}${p}`, {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const arr = data.approvals || data.pending || data.runs || data.data || [];
        // A live answer (even an empty one) is reconcilable; a dead gateway
        // is not: callers must keep the cached cards, never wipe them.
        if (Array.isArray(arr)) return { items: arr.map((a: any) => this.normalizeApproval(a)), live: true };
      } catch {
        // Try the next candidate path.
      }
    }
    return { items: [], live: false };
  }

  normalizeApproval(raw: any, fallbackSessionId: string = ''): PendingApproval {
    const args = Array.isArray(raw.args)
      ? raw.args.map((a: unknown) => String(a))
      : typeof raw.args === 'string' && raw.args
        ? [raw.args]
        : undefined;
    return {
      runId: String(raw.run_id || raw.runId || raw.id || ''),
      sessionId: String(raw.session_id || raw.sessionId || fallbackSessionId || ''),
      summary: String(raw.description || raw.summary || raw.command || 'Approval requested for action'),
      tool: raw.tool_name || raw.tool ? String(raw.tool_name || raw.tool) : undefined,
      command: raw.command ? String(raw.command) : undefined,
      path: raw.path ? String(raw.path) : undefined,
      args,
      risk: raw.risk ? String(raw.risk) : undefined,
      cwd: raw.cwd ? String(raw.cwd) : undefined,
      reason: raw.reason ? String(raw.reason) : undefined,
      // Gateway-advertised decision set (e.g. once-only when session grant
      // is denied server-side). UI hides modes the server did not offer.
      choices: Array.isArray(raw.choices)
        ? raw.choices.map((c: unknown) => String(c))
        : undefined,
      // This gateway emits Unix seconds while the app clocks ms: values below
      // 1e11 can only be seconds, so promote them, or a live card reads as
      // "1970" and the freshness filter drops it on arrival.
      createdAt:
        typeof raw.created_at === 'number'
          ? raw.created_at < 1e11
            ? Math.round(raw.created_at * 1000)
            : Math.round(raw.created_at)
          : Date.now(),
    };
  }

  async resolveApproval(
    runId: string,
    allow: boolean,
    mode: string = 'once',
    callerSignal?: AbortSignal
  ): Promise<'ok' | 'resolved' | 'failed'> {
    try {
      const body = {
        choice: allow ? mode : 'deny',
      };
      const res = await gwFetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) return 'ok';
      // Already resolved elsewhere (approved/denied from another surface):
      // not a failure, the card just has nothing left to decide.
      if (res.status === 404 || res.status === 409) return 'resolved';
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  // streamChat removed: it hand-rolled a broken SSE parser instead of SseParser
  // (no CRLF, stale currentEvent, split data: lines) and had zero callers.

  // Jobs CRUD (DATA-04: envelope distinguishes empty vs stale vs error)
  async jobsWithState(callerSignal?: AbortSignal): Promise<ListSyncResult<CronJob>> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/jobs`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr } = pickArray(data, ['jobs', 'data']);
      const items = arr.map((j: any) => this.normalizeJob(j));
      const now = Date.now();
      this.saveLocalJobs(items);
      writeSyncedAt(GatewayService.SYNC_KEYS.jobs, now);
      return { items, ...liveMeta(now) };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      const cached = this.loadLocalJobs();
      return {
        items: cached,
        ...staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.jobs), plainListStale('Jobs unavailable:', msg), cached.length > 0),
      };
    }
  }

  /** Compat wrapper: bare job list (existing callers). Prefer jobsWithState. */
  async jobs(callerSignal?: AbortSignal): Promise<CronJob[]> {
    const r = await this.jobsWithState(callerSignal);
    return r.items;
  }

  async createJob(
    name: string,
    schedule: string,
    prompt: string,
    callerSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/jobs`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ name, schedule, prompt }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async updateJob(
    id: string,
    patch: Record<string, unknown>,
    callerSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      // The gateway registers PATCH /api/jobs/{id} only; PUT was never
      // routed, so every edit used to fail closed as a 404/405.
      const res = await gwFetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify(patch),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async jobAction(id: string, action: string, callerSignal?: AbortSignal): Promise<boolean> {
    if (!JOB_ACTIONS.has(action)) return false;
    try {
      // Delete follows REST: DELETE /api/jobs/{id}. Other actions POST
      // to /api/jobs/{id}/{action}.
      const isDelete = action === 'delete';
      const res = await gwFetch(
        isDelete
          ? `${this.baseUrl}/api/jobs/${encodeURIComponent(id)}`
          : `${this.baseUrl}/api/jobs/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
        {
          method: isDelete ? 'DELETE' : 'POST',
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
          body: isDelete ? undefined : JSON.stringify({}),
        }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // Run history with sync envelope (DATA-05: empty vs stale vs error).
  async cronRunsPage(
    jobId: string,
    params?: PageParams,
    callerSignal?: AbortSignal
  ): Promise<PagedResult<CronRun>> {
    // Runs are a jobs-domain list: own page size, never the sessions one.
    const page = clampPage(params, DEFAULT_RUNS_PAGE_SIZE, MAX_RUNS_PAGE_SIZE);
    try {
      const res = await gwFetch(
        `${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/runs${buildPageQuery(page, 'latest')}`,
        {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr, total } = pickArray(data, ['runs', 'data']);
      const runs: CronRun[] = arr.map((r: any, idx: number) => ({
        id: String(r.id || `${jobId}-run-${page.offset + idx}`),
        jobId,
        status: r.status || r.state || 'unknown',
        startedAt: r.started_at || '',
        finishedAt: r.finished_at || '',
        error: r.error || '',
      }));
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.runs, now);
      return toPagedResult(runs, liveMeta(now), page, total);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      return toPagedResult<CronRun>(
        [],
        staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.runs), plainListStale('Run history unavailable:', msg), false),
        page
      );
    }
  }

  /** Compat wrapper: bare run list with legacy live/stale flags. */
  async cronRuns(jobId: string, callerSignal?: AbortSignal): Promise<LiveList<CronRun>> {
    const r = await this.cronRunsPage(jobId, undefined, callerSignal);
    return this.flagList(r.items, r.live);
  }

  // Skills with sync envelope (DATA-05).
  // The on-phone gateway (api_server) serves GET /v1/skills with shape
  // {object:'list', data:[{name, description, category}]} and no toggle
  // route. The desktop dashboard (web_server) serves GET /api/skills as a
  // bare array with {name, description, enabled}. Try the live route
  // first, keep the dashboard shape as fallback, and normalize both to
  // SkillInfo. The phone route includes disabled skills without an enabled
  // flag (skip_disabled=False), so enabled reads true here, meaning
  // unknown, not confirmed-on. The dashboard shape carries real flags.
  async skillsWithState(callerSignal?: AbortSignal): Promise<ListSyncResult<SkillInfo>> {
    const candidates = [`${this.baseUrl}/v1/skills`, `${this.baseUrl}/api/skills`];
    let lastStatus = '';
    // The on-phone gateway answers /v1/skills with HTTP 500 (server TypeError)
    // while the desktop fallback route 404s: without priority the trailing
    // 404 masks the real server error, so both verdicts are remembered and
    // the most actionable one composes the outcome below.
    let authStatus = '';
    let serverStatus = '';
    for (const url of candidates) {
      try {
        const res = await gwFetch(url, {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        });
        if (!res.ok) {
          lastStatus = `HTTP ${res.status}`;
          if ((res.status === 401 || res.status === 403) && !authStatus) authStatus = lastStatus;
          else if (res.status >= 500 && !serverStatus) serverStatus = lastStatus;
          continue;
        }
        const data = await res.json();
        const { arr } = pickArray(data, ['skills', 'data', 'items']);
        if (!Array.isArray(arr)) {
          lastStatus = 'unexpected response shape';
          continue;
        }
        const items: SkillInfo[] = (arr as Array<Record<string, unknown>>).map((s) => {
          const name = typeof s.name === 'string' && s.name ? s.name : String((s as { id?: unknown }).id || '');
          return {
            id: typeof s.id === 'string' && s.id ? s.id : name,
            name,
            description: typeof s.description === 'string' ? s.description : '',
            enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
          };
        });
        const now = Date.now();
        writeSyncedAt(GatewayService.SYNC_KEYS.skills, now);
        return { items, ...liveMeta(now) };
      } catch (e: unknown) {
        lastStatus = e instanceof Error ? e.message : 'gateway unreachable';
      }
    }
    // The on-phone gateway answers /v1/skills with HTTP 500 (a server TypeError
    // inside the downloaded image, not something this client can fix) while
    // the desktop fallback route 404s. A red error box for that is
    // unactionable, so it resolves to a neutral empty list with the honest
    // reason kept in the message, the same shape as routines on 404. A
    // rejected key keeps its error state so auth problems stay loud.
    if (serverStatus && !authStatus) {
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.skills, now);
      return {
        items: [],
        ...liveMeta(now),
        error: `Skills are not available on the on-device server (${serverStatus} on /v1/skills).`,
      };
    }
    return {
      items: [],
      ...staleMeta(
        readSyncedAt(GatewayService.SYNC_KEYS.skills),
        plainListStale('Skills unavailable:', honestSkillsCause(authStatus, serverStatus, lastStatus)),
        false
      ),
    };
  }

  /** Compat wrapper: skills with legacy live/stale flags. Prefer skillsWithState. */
  async skillsList(callerSignal?: AbortSignal): Promise<LiveList<SkillInfo>> {
    const r = await this.skillsWithState(callerSignal);
    return this.flagList(r.items, r.live);
  }

  // No toggle route exists on the on-phone gateway (api_server has no
  // skills toggle; the desktop dashboard uses PUT /api/skills/toggle
  // {name, enabled}). The /api/skills/{id}/toggle shape below is
  // speculative and 404s through to the dashboard shape; both attempts
  // report the real outcome so the switch never announces a success
  // the gateway did not confirm.
  async skillToggle(id: string, enabled: boolean, callerSignal?: AbortSignal): Promise<boolean> {
    const attempts: Array<{ url: string; init: RequestInit }> = [
      {
        url: `${this.baseUrl}/api/skills/${encodeURIComponent(id)}/toggle`,
        init: {
          method: 'POST',
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
          body: JSON.stringify({ enabled }),
        },
      },
      {
        url: `${this.baseUrl}/api/skills/toggle`,
        init: {
          method: 'PUT',
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
          body: JSON.stringify({ name: id, enabled }),
        },
      },
    ];
    for (const a of attempts) {
      try {
        const res = await gwFetch(a.url, a.init);
        if (res.ok) {
          this.lastToggleStatus = null;
          return true;
        }
        this.lastToggleStatus = res.status;
        // A 404/405 means this gateway simply has no such route: try the
        // next shape instead of treating it as a verdict on the toggle.
        if (res.status !== 404 && res.status !== 405) return false;
      } catch {
        return false;
      }
    }
    return false;
  }

  // Memory
  async memoryGet(callerSignal?: AbortSignal): Promise<LiveValue<MemoryInfo>> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/memory`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        // No memory route on this server: a neutral unavailable payload from
        // a live response, never a red error. A rejected key keeps its HTTP
        // token plus the key/auth hint; anything else stays a plain status.
        if (res.status === 404) {
          return this.flagValue(
            {
              enabled: false,
              provider: '',
              summary: 'Memory is not available on the on-device server.',
              entries: 0,
            },
            true
          );
        }
        if (res.status === 401 || res.status === 403) {
          return this.flagValue(
            {
              enabled: false,
              provider: '',
              summary: `Memory unavailable: HTTP ${res.status}. ${AUTH_HINT_COPY}`,
              entries: 0,
            },
            false
          );
        }
        return this.flagValue(
          {
            enabled: false,
            provider: '',
            summary: `Memory unavailable: HTTP ${res.status}`,
            entries: 0,
          },
          false
        );
      }
      const data = await res.json();
      // Desktop shape is {active, providers, builtin_files}; older clients
      // sent {enabled, provider, summary, entries}. Map active to enabled
      // so a configured memory no longer reads as disabled.
      const m = (data.memory && typeof data.memory === 'object' ? data.memory : data) as Record<string, unknown>;
      const active = typeof m.active === 'string' ? m.active : '';
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.memory, now);
      return this.flagValue(
        {
          enabled: active !== '' ? true : Boolean(m.enabled),
          provider: active || (typeof m.provider === 'string' ? m.provider : ''),
          summary: typeof m.summary === 'string' ? m.summary : '',
          entries: typeof m.entries === 'number' ? m.entries : 0,
          memoryCharLimit: num(m.memory_char_limit),
          userCharLimit: num(m.user_char_limit),
          memorySize: num(m.memory_size),
          userSize: num(m.user_size),
        },
        true
      );
    } catch (e: unknown) {
      return this.flagValue(
        {
          enabled: false,
          provider: '',
          summary: plainListStale('Memory unavailable:', e instanceof Error ? e.message : ''),
          entries: 0,
        },
        false
      );
    }
  }

  // Memory toggle: speculative attempts against desktop dashboard PUT /api/memory
  // and mobile POST /api/memory/toggle. Reports true only on confirmation.
  async memoryToggle(enabled: boolean, callerSignal?: AbortSignal): Promise<boolean> {
    const attempts: Array<{ url: string; init: RequestInit }> = [
      {
        url: `${this.baseUrl}/api/memory/toggle`,
        init: {
          method: 'POST',
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
          body: JSON.stringify({ enabled }),
        },
      },
      {
        url: `${this.baseUrl}/api/memory`,
        init: {
          method: 'PUT',
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
          body: JSON.stringify({ enabled }),
        },
      },
    ];
    for (const a of attempts) {
      try {
        const res = await gwFetch(a.url, a.init);
        if (res.ok) {
          this.lastToggleStatus = null;
          return true;
        }
        this.lastToggleStatus = res.status;
        if (res.status !== 404 && res.status !== 405) return false;
      } catch {
        return false;
      }
    }
    return false;
  }

  // Memory size: POST /api/memory/limits {memory_char_limit}. True only on
  // confirmation; a 404 means an older server without the route.
  async memorySetLimit(memoryCharLimit: number, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/memory/limits`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ memory_char_limit: memoryCharLimit }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Blueprints with sync envelope (DATA-05).
  async blueprintsWithState(callerSignal?: AbortSignal): Promise<ListSyncResult<Blueprint>> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/blueprints`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        // No routines route on this server: a neutral empty list from a live
        // response, never a red error box. The error field still reports the
        // honest reason for log readers; the UI state resolves to empty.
        // A rejected key keeps its HTTP token plus the key/auth hint.
        if (res.status === 404) {
          const now = Date.now();
          writeSyncedAt(GatewayService.SYNC_KEYS.blueprints, now);
          return { items: [], ...liveMeta(now), error: 'Routines are not available on the on-device server.' };
        }
        if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}. ${AUTH_HINT_COPY}`);
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const { arr } = pickArray(data, ['blueprints', 'data']);
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.blueprints, now);
      return { items: arr as Blueprint[], ...liveMeta(now) };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      return {
        items: [],
        ...staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.blueprints), plainListStale('Blueprints unavailable:', msg), false),
      };
    }
  }

  // Blueprints (compat)
  async blueprints(callerSignal?: AbortSignal): Promise<Blueprint[]> {
    const r = await this.blueprintsWithState(callerSignal);
    return r.items;
  }

  async instantiateBlueprint(
    id: string,
    slots: Record<string, string>,
    callerSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/blueprints/${encodeURIComponent(id)}/instantiate`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ slots }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Projects: local imported copies live under /root/.projects/<id>
  // (SAF-imported, app-private). Legacy host_path binds are kept for
  // old desktop installs only.
  async bindLocalProject(
    id: string,
    callerSignal?: AbortSignal
  ): Promise<{ ok: boolean; guestPath: string; error?: string }> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/projects/bind`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ id, local: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, guestPath: '', error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
      return { ok: true, guestPath: typeof data.guest_path === 'string' ? data.guest_path : '' };
    } catch (e: unknown) {
      return { ok: false, guestPath: '', error: e instanceof Error ? e.message : 'gateway unreachable' };
    }
  }

  async unbindProject(id: string, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Diagnostics & Ops
  async doctor(callerSignal?: AbortSignal): Promise<DoctorReport> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/doctor`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          ok: false,
          summary: `Doctor check failed: HTTP ${res.status}`,
          version: '',
          checks: [],
        };
      }
      // Doctor details can echo keys/tokens: redact before storage/display.
      return redactSecrets(await res.json());
    } catch (e: unknown) {
      return {
        ok: false,
        summary: plainServiceFailure(e),
        version: '',
        checks: [],
      };
    }
  }

  async backup(callerSignal?: AbortSignal): Promise<BackupResult> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/backup`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          ok: false,
          path: '',
          message: `Backup failed: HTTP ${res.status}`,
        };
      }
      // Redact before the archive result is stored or shown anywhere.
      return redactSecrets(await res.json());
    } catch (e: unknown) {
      return {
        ok: false,
        path: '',
        message: plainServiceFailure(e),
      };
    }
  }

  async debugShare(callerSignal?: AbortSignal): Promise<DebugShare> {
    try {
      const res = await gwFetch(`${this.baseUrl}/api/debug/share`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          ok: false,
          urls: [],
          summary: `Debug share failed: HTTP ${res.status}`,
        };
      }
      // Redact before the bundle result is stored or uploaded anywhere.
      // The status payload rarely repeats `ok`, so derive it from what came
      // back: an export only succeeded if it produced shareable urls.
      const data = redactSecrets(await res.json()) as Partial<DebugShare>;
      const urls = Array.isArray(data.urls) ? data.urls : [];
      return {
        ok: data.ok !== false && urls.length > 0,
        urls,
        summary: String(data.summary ?? ''),
      };
    } catch (e: unknown) {
      return {
        ok: false,
        urls: [],
        summary: plainServiceFailure(e),
      };
    }
  }

  // Diagnostics log history with sync envelope (DATA-05).
  async serverLogsPage(
    level: string = '',
    query: string = '',
    params?: PageParams,
    callerSignal?: AbortSignal
  ): Promise<PagedResult<LogLine>> {
    const page = clampPage(params, DEFAULT_SESSIONS_PAGE_SIZE, MAX_SESSIONS_PAGE_SIZE);
    try {
      const res = await gwFetch(
        `${this.baseUrl}/api/logs?level=${encodeURIComponent(level)}&query=${encodeURIComponent(query)}&limit=${page.limit}&offset=${page.offset}`,
        {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr, total } = pickArray(data, ['logs', 'data']);
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.logs, now);
      // Server logs can echo keys/tokens: redact every line before it is
      // stored or shown anywhere.
      return toPagedResult(redactSecrets(arr) as LogLine[], liveMeta(now), page, total);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      return toPagedResult<LogLine>(
        [],
        staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.logs), plainListStale('Logs unavailable:', msg), false),
        page
      );
    }
  }

  async serverLogs(
    level: string = '',
    query: string = '',
    limit: number = 200,
    callerSignal?: AbortSignal
  ): Promise<LiveList<LogLine>> {
    try {
      const res = await gwFetch(
        `${this.baseUrl}/api/logs?level=${encodeURIComponent(level)}&query=${encodeURIComponent(query)}&limit=${limit}`,
        {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        }
      );
      if (!res.ok) return this.flagList([], false);
      const data = await res.json();
      const logs: LogLine[] = redactSecrets(data.logs || []);
      return this.flagList(logs, true);
    } catch {
      return this.flagList([], false);
    }
  }

  async usageAnalytics(range: string = '7d', callerSignal?: AbortSignal): Promise<LiveValue<UsageAnalytics>> {
    const empty: UsageAnalytics = {
      range,
      sessions: 0,
      messages: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    try {
      const res = await gwFetch(`${this.baseUrl}/api/usage?range=${encodeURIComponent(range)}`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return this.flagValue({ ...empty }, false);
      }
      const data = await res.json();
      return this.flagValue({ ...empty, ...data, range: data.range || range }, true);
    } catch {
      return this.flagValue({ ...empty }, false);
    }
  }

  async providersValidate(
    provider: string,
    envVar: string,
    key: string,
    baseUrl: string = '',
    callerSignal?: AbortSignal
  ): Promise<boolean | null> {
    // Keyless local providers (LM Studio, Ollama) carry no key by design:
    // rejecting them as invalid is a false failure. What can be proven is
    // reachability, so answer that honestly instead of false.
    if (!key.trim() && KEYLESS_PROVIDERS.has(normProvider(provider))) {
      return (await this.health(callerSignal)) ? true : null;
    }
    if (!key.trim()) return false;
    // Never send the key when the gateway is unreachable. Probe reachability
    // first with a keyless health check and bail out before any network call
    // that carries the key.
    const reachable = await this.health(callerSignal);
    if (!reachable) return null;
    // One live-validation path for the whole app: validateProvider owns the
    // request shape and the result parsing, so the key test and the Settings
    // flows cannot drift apart. The call carries no side effects, so a
    // transient gateway blip is retried once instead of being reported to the
    // user as "the key was not tested".
    try {
      const result = await withRetry(
        async () => {
          // The caller's Base URL rides along: a hardcoded '' here used to
          // fail every local/custom provider test before it started.
          const input = { provider, baseUrl: (baseUrl || '').trim(), envVar } as ProviderValidationInput;
          input.apiKey = key;
          const r = await validateProvider(
            input,
            { gatewayBaseUrl: this.baseUrl, serverKey: this.apiKey, timeoutMs: REQUEST_TIMEOUT_MS },
            callerSignal
          );
          if (r === null) {
            throw createAppError('unavailable', 'Gateway did not answer the key validation.', { retryable: true });
          }
          return r;
        },
        { idempotent: true, signal: callerSignal, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 500 }
      );
      return result.valid;
    } catch {
      return null;
    }
  }

  // Same live validation, but keeps the model list the gateway returns so
  // the provider form can offer a picker instead of a hand-typed model id.
  async providersValidateWithModels(
    provider: string,
    envVar: string,
    key: string,
    baseUrl: string = '',
    callerSignal?: AbortSignal
  ): Promise<{ valid: boolean; models: string[] } | null> {
    // Same keyless rule as providersValidate: reachability, not key proof.
    if (!key.trim() && KEYLESS_PROVIDERS.has(normProvider(provider))) {
      return (await this.health(callerSignal)) ? { valid: true, models: [] } : null;
    }
    if (!key.trim()) return { valid: false, models: [] };
    const reachable = await this.health(callerSignal);
    if (!reachable) return null;
    try {
      const result = await withRetry(
        async () => {
          const input = { provider, baseUrl: (baseUrl || '').trim(), envVar } as ProviderValidationInput;
          input.apiKey = key;
          const r = await validateProvider(
            input,
            { gatewayBaseUrl: this.baseUrl, serverKey: this.apiKey, timeoutMs: REQUEST_TIMEOUT_MS },
            callerSignal
          );
          if (r === null) {
            throw createAppError('unavailable', 'Gateway did not answer the key validation.', { retryable: true });
          }
          return r;
        },
        { idempotent: true, signal: callerSignal, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 500 }
      );
      return { valid: result.valid, models: Array.isArray(result.models) ? result.models : [] };
    } catch {
      return null;
    }
  }

  // Local Storage Helpers
  private loadLocalSessions(): MobileSession[] {
    try {
      const raw = localStorage.getItem('hermes_sessions');
      if (raw) return JSON.parse(raw);
    } catch {
      // Ignored
    }
    return [];
  }

  saveLocalSessions(sessions: MobileSession[]): void {
    try {
      localStorage.setItem('hermes_sessions', JSON.stringify(sessions));
    } catch {
      // Ignored
    }
  }

  loadLocalMessages(sessionId: string): ChatMessage[] {
    try {
      const raw = localStorage.getItem(`hermes_messages_${sessionId}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  saveLocalMessages(sessionId: string, messages: ChatMessage[]): void {
    try {
      // Retention: keep the newest MESSAGE_RETENTION_CAP so a long session
      // cannot exhaust quota. Older history stays on the gateway (DATA-02).
      const capped = capMessages(messages, MESSAGE_RETENTION_CAP);
      localStorage.setItem(`hermes_messages_${sessionId}`, JSON.stringify(capped));
    } catch {
      // Ignored
    }
  }

  /** Drop a deleted session's cache so it cannot accumulate forever. */
  removeLocalMessages(sessionId: string): void {
    try {
      localStorage.removeItem(`hermes_messages_${sessionId}`);
    } catch {
      // Ignored
    }
  }

  loadLocalJobs(): CronJob[] {
    try {
      const raw = localStorage.getItem('hermes_jobs');
      if (raw) return JSON.parse(raw);
    } catch {
      // Ignored
    }
    return [];
  }

  saveLocalJobs(jobs: CronJob[]): void {
    try {
      localStorage.setItem('hermes_jobs', JSON.stringify(jobs));
    } catch {
      // Ignored
    }
  }
}

