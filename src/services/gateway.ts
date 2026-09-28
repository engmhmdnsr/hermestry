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

  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
        headers: this.getHeaders(),
      });
      clearTimeout(timeoutId);
      this.isConnected = res.ok;
      return res.ok;
    } catch {
      this.isConnected = false;
      return false;
    }
  }

  async healthDetailed(): Promise<GatewayStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/health/detailed`, {
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

  async modelOptions(provider: string = 'deepseek'): Promise<AiModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/model/options`, {
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

  async fetchSessions(): Promise<MobileSession[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions?limit=100&offset=0`, {
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

  async createSession(model: string, title?: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
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

  async deleteSession(id: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.getHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async renameSession(id: string, title: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify({ title }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async forkSession(id: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}/fork`, {
        method: 'POST',
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

  async sessionMessages(sessionId: string): Promise<ChatMessage[]> {
    try {
      const res = await fetch(
        `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`,
        { headers: this.getHeaders() }
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

  async stopRun(runId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({}),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async resolveApproval(runId: string, allow: boolean, mode: string = 'once'): Promise<boolean> {
    try {
      const body = {
        choice: allow ? mode : 'deny',
      };
      const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

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
      callbacks.onThinkingDone();
    } catch (err: any) {
      if (err && err.name === 'AbortError') {
        callbacks.onStopped?.();
        return;
      }
      callbacks.onError?.(err instanceof Error ? err.message : 'Stream failed: gateway unreachable');
    }
  }

  // Jobs CRUD
  async jobs(): Promise<CronJob[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs`, {
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

  async createJob(name: string, schedule: string, prompt: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ name, schedule, prompt, deliver: 'local' }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async updateJob(id: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(patch),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async jobAction(id: string, action: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: this.getHeaders(),
        body: action === 'delete' ? undefined : JSON.stringify({}),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async cronRuns(jobId: string): Promise<CronRun[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/runs`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const arr = data.runs || data.data || [];
      return arr.map((r: any, idx: number) => ({
        id: String(r.id || `${jobId}-run-${idx}`),
        jobId,
        status: r.status || r.state || 'success',
        startedAt: r.started_at || '',
        finishedAt: r.finished_at || '',
        error: r.error || '',
      }));
    } catch {
      return [];
    }
  }

  // Skills
  async skillsList(): Promise<SkillInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.skills || [];
    } catch {
      return [];
    }
  }

  async skillToggle(id: string, enabled: boolean): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ enabled }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Memory
  async memoryGet(): Promise<MemoryInfo> {
    try {
      const res = await fetch(`${this.baseUrl}/api/memory`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          enabled: false,
          provider: '',
          summary: `Memory unavailable: HTTP ${res.status}`,
          entries: 0,
        };
      }
      const data = await res.json();
      return {
        enabled: Boolean(data.enabled),
        provider: data.provider || '',
        summary: data.summary || '',
        entries: typeof data.entries === 'number' ? data.entries : 0,
      };
    } catch (e: unknown) {
      return {
        enabled: false,
        provider: '',
        summary: e instanceof Error ? `Memory unavailable: ${e.message}` : 'Memory unavailable: gateway unreachable',
        entries: 0,
      };
    }
  }

  // Blueprints
  async blueprints(): Promise<Blueprint[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/blueprints`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.blueprints || [];
    } catch {
      return [];
    }
  }

  async instantiateBlueprint(id: string, slots: Record<string, string>): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/blueprints/${encodeURIComponent(id)}/instantiate`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ slots }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Diagnostics & Ops
  async doctor(): Promise<DoctorReport> {
    try {
      const res = await fetch(`${this.baseUrl}/api/doctor`, {
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

  async backup(): Promise<BackupResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/backup`, {
        method: 'POST',
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          ok: false,
          path: '',
          message: `Backup failed: HTTP ${res.status}`,
        };
      }
      return await res.json();
    } catch (e: unknown) {
      return {
        ok: false,
        path: '',
        message: e instanceof Error ? `Backup failed: ${e.message}` : 'Backup failed: gateway unreachable',
      };
    }
  }

  async debugShare(): Promise<DebugShare> {
    try {
      const res = await fetch(`${this.baseUrl}/api/debug/share`, {
        method: 'POST',
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          urls: [],
          summary: `Debug share failed: HTTP ${res.status}`,
        };
      }
      return await res.json();
    } catch (e: unknown) {
      return {
        urls: [],
        summary: e instanceof Error ? `Debug share failed: ${e.message}` : 'Debug share failed: gateway unreachable',
      };
    }
  }

  async serverLogs(level: string = '', query: string = '', limit: number = 200): Promise<LogLine[]> {
    try {
      const res = await fetch(
        `${this.baseUrl}/api/logs?level=${encodeURIComponent(level)}&query=${encodeURIComponent(query)}&limit=${limit}`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.logs || [];
    } catch {
      return [];
    }
  }

  async usageAnalytics(range: string = '7d'): Promise<UsageAnalytics> {
    try {
      const res = await fetch(`${this.baseUrl}/api/usage?range=${encodeURIComponent(range)}`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          range,
          sessions: 0,
          messages: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      return await res.json();
    } catch {
      return {
        range,
        sessions: 0,
        messages: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  async providersValidate(provider: string, envVar: string, key: string): Promise<boolean | null> {
    if (!key.trim()) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/providers/validate`, {
        method: 'POST',
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
      localStorage.setItem(`hermes_messages_${sessionId}`, JSON.stringify(messages));
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

