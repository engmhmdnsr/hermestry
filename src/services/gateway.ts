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
import {
  DEFAULT_MESSAGES_PAGE_SIZE,
  DEFAULT_SESSIONS_PAGE_SIZE,
  MAX_MESSAGES_PAGE_SIZE,
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

const REQUEST_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 5000;
const JOB_ACTIONS = new Set(['pause', 'resume', 'run', 'delete']);

import { redactSecrets } from './redaction';
export { REDACTED } from './redaction';

export class GatewayService {
  private baseUrl: string;
  private apiKey: () => string;
  private isConnected: boolean = false;

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
      const res = await fetch(`${this.baseUrl}/health`, {
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
      const res = await fetch(`${this.baseUrl}/health/detailed`, {
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
        detail: e instanceof Error ? e.message : 'unreachable',
      };
    }
  }

  async modelOptions(provider: string = 'deepseek', callerSignal?: AbortSignal): Promise<AiModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/model/options`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const out: AiModelInfo[] = [];
      const seen = new Set<string>();
      if (Array.isArray(data.providers)) {
        for (const p of data.providers) {
          if (Array.isArray(p.models)) {
            for (const id of p.models) {
              if (typeof id === 'string' && id && !id.toLowerCase().includes('embed') && !seen.has(id)) {
                seen.add(id);
                const clean = id.split('/').pop()?.replace(/[-_]/g, ' ') || id;
                out.push({
                  id,
                  displayName: clean.charAt(0).toUpperCase() + clean.slice(1),
                  provider: p.slug || provider,
                });
              }
            }
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // Sync-state storage keys for lastSyncedAt (DATA-03).
  private static readonly SYNC_KEYS = {
    sessions: 'hermes_sessions_synced_at',
    jobs: 'hermes_jobs_synced_at',
    skills: 'hermes_skills_synced_at',
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
      prompt: j.prompt || '',
      enabled: j.enabled !== false && j.state !== 'paused',
      state: j.state || 'active',
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
      const res = await fetch(`${this.baseUrl}/api/sessions${buildPageQuery(page)}`, {
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
        staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.sessions), `Sessions unavailable: ${msg}`, cached.length > 0),
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
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
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
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async renameSession(id: string, title: string, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
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
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/fork`, {
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
      const res = await fetch(
        `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages${buildPageQuery(page)}`,
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
        this.saveLocalMessages(sessionId, items);
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
        staleMeta(readSyncedAt(syncKey), `Messages unavailable: ${msg}`, cached.length > 0),
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
      const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/stop`, {
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

  async listPendingApprovals(callerSignal?: AbortSignal): Promise<PendingApproval[]> {
    const paths = ['/v1/runs/pending', '/api/runs/pending', '/v1/approvals/pending'];
    for (const p of paths) {
      try {
        const res = await fetch(`${this.baseUrl}${p}`, {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const arr = data.approvals || data.pending || data.runs || data.data || [];
        if (Array.isArray(arr)) return arr.map((a: any) => this.normalizeApproval(a));
      } catch {
        // Try the next candidate path.
      }
    }
    return [];
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
      createdAt: typeof raw.created_at === 'number' ? raw.created_at : Date.now(),
    };
  }

  async resolveApproval(
    runId: string,
    allow: boolean,
    mode: string = 'once',
    callerSignal?: AbortSignal
  ): Promise<boolean> {
    try {
      const body = {
        choice: allow ? mode : 'deny',
      };
      const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async streamChat(
    sessionId: string,
    model: string,
    message: string,
    reasoningEffort: string,
    imageDataUrls: string[],
    callbacks: StreamChatCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Streaming responses stay open for minutes by design, so no fixed
    // timeout applies here. The caller abort signal is honored, and the
    // reader is always cancelled and released to avoid leaking locks.
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const onAbort = () => {
      if (reader) {
        reader.cancel().catch(() => {});
      }
    };
    try {
      const body: Record<string, any> = { model };
      if (imageDataUrls && imageDataUrls.length > 0) {
        const parts: any[] = [];
        if (message) parts.push({ type: 'text', text: message });
        for (const url of imageDataUrls) {
          parts.push({ type: 'image_url', image_url: { url } });
        }
        body.message = parts;
      } else {
        body.message = message;
      }
      if (reasoningEffort && reasoningEffort !== 'none') {
        body.model_options = { reasoning_effort: reasoningEffort.toLowerCase() };
      }

      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: abortSignal,
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          callbacks.onError?.(`Auth failed: HTTP ${res.status}`);
        } else {
          callbacks.onError?.(`Stream failed: HTTP ${res.status}`);
        }
        return;
      }
      if (!res.body) {
        callbacks.onError?.('Stream failed: empty response body');
        return;
      }

      reader = res.body.getReader();
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.replace('event:', '').trim();
            } else if (trimmed.startsWith('data:')) {
              const dataRaw = trimmed.replace('data:', '').trim();
              if (!dataRaw) continue;
              try {
                const ev = JSON.parse(dataRaw);
                if (ev.run_id && callbacks.onRunId) {
                  callbacks.onRunId(ev.run_id);
                }
                if (currentEvent === 'assistant.delta' && ev.delta) {
                  callbacks.onThinkingDone();
                  callbacks.onText(ev.delta);
                } else if (currentEvent === 'assistant.commentary' && ev.text) {
                  callbacks.onThinkingDone();
                  callbacks.onText(ev.text);
                } else if (currentEvent === 'tool.progress') {
                  if (ev.tool_name === '_thinking' || ev.tool_name === 'thinking') {
                    callbacks.onThinking(ev.delta || ev.preview || '');
                  } else {
                    callbacks.onTool(ev.tool_name || 'tool');
                  }
                } else if (currentEvent === 'tool.started' || currentEvent === 'tool.completed') {
                  callbacks.onThinkingDone();
                  const name = ev.tool_name || 'tool';
                  callbacks.onTool(name);
                  if (ev.output && callbacks.onToolOutput) {
                    callbacks.onToolOutput(name, ev.output);
                  }
                } else if (currentEvent === 'approval.request') {
                  if (ev.run_id) {
                    callbacks.onApproval({
                      runId: String(ev.run_id),
                      sessionId,
                      summary: ev.description || ev.command || 'Approval requested for action',
                      tool: ev.tool_name || ev.tool ? String(ev.tool_name || ev.tool) : undefined,
                      command: ev.command ? String(ev.command) : undefined,
                      path: ev.path ? String(ev.path) : undefined,
                      args: Array.isArray(ev.args)
                        ? ev.args.map((a: unknown) => String(a))
                        : undefined,
                      risk: ev.risk ? String(ev.risk) : undefined,
                      cwd: ev.cwd ? String(ev.cwd) : undefined,
                      reason: ev.reason ? String(ev.reason) : undefined,
                      createdAt: Date.now(),
                    });
                  }
                } else if (ev.usage) {
                  callbacks.onUsage(ev.usage.input_tokens || 0, ev.usage.output_tokens || 0);
                }
              } catch {
                // Non JSON line, skip
              }
            }
          }
        }
      } finally {
        abortSignal?.removeEventListener('abort', onAbort);
        try {
          await reader.cancel();
        } catch {
          // Stream already closed, nothing to cancel
        }
        try {
          reader.releaseLock();
        } catch {
          // Lock already released, ignore
        }
        reader = null;
      }
      callbacks.onThinkingDone();
    } catch (err: any) {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel errors during teardown
        }
        try {
          reader.releaseLock();
        } catch {
          // Ignore release errors during teardown
        }
        reader = null;
      }
      if (err && err.name === 'AbortError') {
        callbacks.onStopped?.();
        return;
      }
      callbacks.onError?.(err instanceof Error ? err.message : 'Stream failed: gateway unreachable');
    }
  }

  // Jobs CRUD (DATA-04: envelope distinguishes empty vs stale vs error)
  async jobsWithState(callerSignal?: AbortSignal): Promise<ListSyncResult<CronJob>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs`, {
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
        ...staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.jobs), `Jobs unavailable: ${msg}`, cached.length > 0),
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
      const res = await fetch(`${this.baseUrl}/api/jobs`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ name, schedule, prompt, deliver: 'local' }),
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
      const res = await fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(id)}`, {
        method: 'PUT',
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
      const res = await fetch(
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
    const page = clampPage(params, DEFAULT_SESSIONS_PAGE_SIZE, MAX_SESSIONS_PAGE_SIZE);
    try {
      const res = await fetch(
        `${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/runs${buildPageQuery(page)}`,
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
        status: r.status || r.state || 'success',
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
        staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.runs), `Run history unavailable: ${msg}`, false),
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
  async skillsWithState(callerSignal?: AbortSignal): Promise<ListSyncResult<SkillInfo>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr } = pickArray(data, ['skills', 'data']);
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.skills, now);
      return { items: arr as SkillInfo[], ...liveMeta(now) };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      return {
        items: [],
        ...staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.skills), `Skills unavailable: ${msg}`, false),
      };
    }
  }

  /** Compat wrapper: skills with legacy live/stale flags. Prefer skillsWithState. */
  async skillsList(callerSignal?: AbortSignal): Promise<LiveList<SkillInfo>> {
    const r = await this.skillsWithState(callerSignal);
    return this.flagList(r.items, r.live);
  }

  async skillToggle(id: string, enabled: boolean, callerSignal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ enabled }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Memory
  async memoryGet(callerSignal?: AbortSignal): Promise<LiveValue<MemoryInfo>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/memory`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
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
      return this.flagValue(
        {
          enabled: Boolean(data.enabled),
          provider: data.provider || '',
          summary: data.summary || '',
          entries: typeof data.entries === 'number' ? data.entries : 0,
        },
        true
      );
    } catch (e: unknown) {
      return this.flagValue(
        {
          enabled: false,
          provider: '',
          summary: e instanceof Error ? `Memory unavailable: ${e.message}` : 'Memory unavailable: gateway unreachable',
          entries: 0,
        },
        false
      );
    }
  }

  // Blueprints with sync envelope (DATA-05).
  async blueprintsWithState(callerSignal?: AbortSignal): Promise<ListSyncResult<Blueprint>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/blueprints`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const { arr } = pickArray(data, ['blueprints', 'data']);
      const now = Date.now();
      writeSyncedAt(GatewayService.SYNC_KEYS.blueprints, now);
      return { items: arr as Blueprint[], ...liveMeta(now) };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      return {
        items: [],
        ...staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.blueprints), `Blueprints unavailable: ${msg}`, false),
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
      const res = await fetch(`${this.baseUrl}/api/blueprints/${encodeURIComponent(id)}/instantiate`, {
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

  // Diagnostics & Ops
  async doctor(callerSignal?: AbortSignal): Promise<DoctorReport> {
    try {
      const res = await fetch(`${this.baseUrl}/api/doctor`, {
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
      return await res.json();
    } catch (e: unknown) {
      return {
        ok: false,
        summary: e instanceof Error ? `Doctor check failed: ${e.message}` : 'Doctor check failed: gateway unreachable',
        version: '',
        checks: [],
      };
    }
  }

  async backup(callerSignal?: AbortSignal): Promise<BackupResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/backup`, {
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
        message: e instanceof Error ? `Backup failed: ${e.message}` : 'Backup failed: gateway unreachable',
      };
    }
  }

  async debugShare(callerSignal?: AbortSignal): Promise<DebugShare> {
    try {
      const res = await fetch(`${this.baseUrl}/api/debug/share`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          urls: [],
          summary: `Debug share failed: HTTP ${res.status}`,
        };
      }
      // Redact before the bundle result is stored or uploaded anywhere.
      return redactSecrets(await res.json());
    } catch (e: unknown) {
      return {
        urls: [],
        summary: e instanceof Error ? `Debug share failed: ${e.message}` : 'Debug share failed: gateway unreachable',
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
      const res = await fetch(
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
      return toPagedResult(arr as LogLine[], liveMeta(now), page, total);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'gateway unreachable';
      return toPagedResult<LogLine>(
        [],
        staleMeta(readSyncedAt(GatewayService.SYNC_KEYS.logs), `Logs unavailable: ${msg}`, false),
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
      const res = await fetch(
        `${this.baseUrl}/api/logs?level=${encodeURIComponent(level)}&query=${encodeURIComponent(query)}&limit=${limit}`,
        {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        }
      );
      if (!res.ok) return this.flagList([], false);
      const data = await res.json();
      const logs: LogLine[] = data.logs || [];
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
      const res = await fetch(`${this.baseUrl}/api/usage?range=${encodeURIComponent(range)}`, {
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
    callerSignal?: AbortSignal
  ): Promise<boolean | null> {
    if (!key.trim()) return false;
    // Never send the key when the gateway is unreachable. Probe reachability
    // first with a keyless health check and bail out before any network call
    // that carries the key.
    const reachable = await this.health(callerSignal);
    if (!reachable) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/providers/validate`, {
        method: 'POST',
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
        body: JSON.stringify({ provider, key, env_var: envVar }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Boolean(data.valid);
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

