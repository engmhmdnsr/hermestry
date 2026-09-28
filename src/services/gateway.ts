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

export const REDACTED = '***REDACTED***';

const SENSITIVE_KEY_PARTS = [
  'apikey',
  'api_key',
  'serverkey',
  'server_key',
  'tgtoken',
  'tg_token',
  'discordtoken',
  'discord_token',
  'applockpin',
  'app_lock_pin',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'pin',
];

const isSensitiveKey = (key: string): boolean => {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm === 'pin' || norm.endsWith('pin')) return true;
  return SENSITIVE_KEY_PARTS.some((part) => part !== 'pin' && norm.includes(part));
};

// Deep-clone a value with plaintext secrets replaced by ***REDACTED***.
// Used before archiving or uploading diagnostics so snapshots and debug
// bundles never carry live credentials.
export const redactSecrets = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) && typeof v === 'string' && v ? REDACTED : redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
};

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

  async fetchSessions(callerSignal?: AbortSignal): Promise<MobileSession[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions?limit=100&offset=0`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) return this.loadLocalSessions();
      const data = await res.json();
      const arr = data.data || data.sessions || [];
      return arr.map((s: any) => ({
        id: String(s.id),
        title: s.title || 'untitled',
        model: s.model || '',
        messageCount: s.message_count || 0,
        lastActiveAt: s.last_active ? s.last_active * 1000 : Date.now(),
        costUsd: s.actual_cost_usd || s.estimated_cost_usd || 0.0,
        source: s.source || '',
      }));
    } catch {
      return this.loadLocalSessions();
    }
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

  async sessionMessages(sessionId: string, callerSignal?: AbortSignal): Promise<ChatMessage[]> {
    try {
      const res = await fetch(
        `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`,
        {
          signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
          headers: this.getHeaders(),
        }
      );
      if (!res.ok) return this.loadLocalMessages(sessionId);
      const data = await res.json();
      const arr = data.data || [];
      return arr
        .filter((m: any) => m.role !== 'system')
        .map((m: any, idx: number) => ({
          id: m.id || `${sessionId}-msg-${idx}`,
          sender: m.role === 'assistant' ? 'hermes' : 'you',
          content: m.content || '',
          thinking: m.thinking || '',
          thinkingDone: true,
          tools: m.tools || [],
          timestamp: m.created_at ? m.created_at * 1000 : Date.now(),
        }));
    } catch {
      return this.loadLocalMessages(sessionId);
    }
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

  // Jobs CRUD
  async jobs(callerSignal?: AbortSignal): Promise<CronJob[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const arr = data.jobs || [];
      return arr.map((j: any) => ({
        id: String(j.id),
        name: j.name || 'job',
        scheduleDisplay: j.schedule_display || j.schedule?.display || '',
        prompt: j.prompt || '',
        enabled: j.enabled !== false && j.state !== 'paused',
        state: j.state || 'active',
        nextRunAt: j.next_run_at || '',
        lastStatus: j.last_status || '',
        lastError: j.last_error || j.last_run?.error || '',
      }));
    } catch {
      return [];
    }
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

  async cronRuns(jobId: string, callerSignal?: AbortSignal): Promise<LiveList<CronRun>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/runs`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) return this.flagList([], false);
      const data = await res.json();
      const arr = data.runs || data.data || [];
      const runs: CronRun[] = arr.map((r: any, idx: number) => ({
        id: String(r.id || `${jobId}-run-${idx}`),
        jobId,
        status: r.status || r.state || 'success',
        startedAt: r.started_at || '',
        finishedAt: r.finished_at || '',
        error: r.error || '',
      }));
      return this.flagList(runs, true);
    } catch {
      return this.flagList([], false);
    }
  }

  // Skills
  async skillsList(callerSignal?: AbortSignal): Promise<LiveList<SkillInfo>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) return this.flagList([], false);
      const data = await res.json();
      const skills: SkillInfo[] = data.skills || [];
      return this.flagList(skills, true);
    } catch {
      return this.flagList([], false);
    }
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

  // Blueprints
  async blueprints(callerSignal?: AbortSignal): Promise<Blueprint[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/blueprints`, {
        signal: this.requestSignal(callerSignal, REQUEST_TIMEOUT_MS),
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.blueprints || [];
    } catch {
      return [];
    }
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
      // Cap per-session history so a long session cannot exhaust quota.
      const capped = messages.length > 200 ? messages.slice(-200) : messages;
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

