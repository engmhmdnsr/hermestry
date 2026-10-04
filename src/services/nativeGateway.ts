// Bridge to the native on-device gateway runner (Capacitor plugin
// "HermesGateway"). Present only inside the Android APK; on plain web
// every helper reports unavailable and callers use their web fallback.

import { plainResultLine } from './plainFailure';

export interface NativeGatewayStatus {
  running: boolean;
  state: string;
  // Secure-store health (present on native status()): when the Keystore is
  // unavailable every secret write is refused, so the UI must say so.
  secureStoreFallback?: boolean;
  secureStoreError?: string;
}

export interface NativeStopVerification {
  verified: boolean;
  processExited: boolean;
  portClosed: boolean;
  healthFalse: boolean;
}

export interface NativeStartupInfo {
  phase: string;
  elapsedMs: number;
  lastError: string;
  logPath: string;
  retryable: boolean;
}

export interface NativePreflight {
  freeBytes: number;
  neededBytes: number;
  enough: boolean;
  appVersion: string;
  gatewayVersion: string;
  protocolVersion: number;
  imageVersion: string;
  compatible: boolean;
  compatError: string;
}

export interface NativeServerKeyAck {
  ok: boolean;
  error?: string;
}

interface HermesGatewayPlugin {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<Partial<NativeStopVerification> & { ok?: boolean }>;
  status(): Promise<NativeGatewayStatus>;
  health(): Promise<NativeGatewayStatus>;
  startupInfo(): Promise<Partial<NativeStartupInfo>>;
  preflight(): Promise<Partial<NativePreflight>>;
  serverKey(): Promise<{ serverKey: string }>;
  secretGet?(options: { key: string }): Promise<{ value: string }>;
  secretSet?(options: { key: string; value: string }): Promise<unknown>;
  monotonicNow?(): Promise<{ now: number }>;
  notifState?(): Promise<{ granted: boolean }>;
  requestNotifAlerts?(): Promise<unknown>;
  notifyAlert?(options: { title: string; body: string }): Promise<unknown>;
  setServerKey?(options: { serverKey: string }): Promise<unknown>;
  setProvider(options: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    serverKey?: string;
    tgToken?: string;
    discordToken?: string;
  }): Promise<void>;
  setAutostart?(options: { enabled: boolean }): Promise<void>;
  addListener(
    event: string,
    cb: (info: Record<string, unknown>) => void
  ): Promise<{ remove: () => void }>;
  streamPost?(options: {
    id: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<void>;
  streamAbort?(options: { id: string }): Promise<void>;
  pickProjectDir?(): Promise<{ uri?: string; name?: string; hostPath?: string }>;
  importProjectTree?(options: { uri: string; id: string }): Promise<{ count?: number; guestPath?: string }>;
  exportProjectTree?(options: { id: string }): Promise<{ count?: number }>;
}

function getPlugin(): HermesGatewayPlugin | null {
  try {
    const cap = (window as unknown as Record<string, unknown>).Capacitor as
      | { Plugins?: Record<string, unknown> }
      | undefined;
    const p = cap?.Plugins?.HermesGateway as HermesGatewayPlugin | undefined;
    return p ?? null;
  } catch {
    return null;
  }
}

export function isNativeGateway(): boolean {
  return getPlugin() !== null;
}

// The Capacitor bridge registers its plugins asynchronously while the
// WebView boots, so an early call can read a null plugin even though the
// native side is healthy. Poll the registry for a moment instead of failing
// on the first empty lookup: a late bridge must not be reported as
// "bridge unavailable", and it must not leave install/start/status stuck in
// their previous state.
const BRIDGE_WAIT_ATTEMPTS = 20;
const BRIDGE_WAIT_MS = 100;
// serverKey() may answer with an empty string before SecurePrefs finished
// minting the key. Retry a few times rather than returning "no key" and
// leaving the WebView keyless while the native side already holds one.
const SERVER_KEY_ATTEMPTS = 4;
const SERVER_KEY_RETRY_MS = 250;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForBridge(): Promise<HermesGatewayPlugin | null> {
  let plugin = getPlugin();
  for (let attempt = 0; attempt < BRIDGE_WAIT_ATTEMPTS && !plugin; attempt += 1) {
    await waitMs(BRIDGE_WAIT_MS);
    plugin = getPlugin();
  }
  return plugin;
}

export async function nativeInstall(
  onLog: (line: string) => void,
  onProgress: (downloaded: number, total: number) => void,
  onPhase?: (phase: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const plugin = await waitForBridge();
  if (!plugin) return { ok: false, error: 'native bridge unavailable' };
  // Subscriptions live inside the try so a rejected addListener() rejects
  // this call as a normal { ok: false } result instead of as an unhandled
  // rejection that leaves the caller sitting in the installing state, and
  // so every listener that did register is removed on every exit path.
  const subs: Array<{ remove: () => void }> = [];
  try {
    subs.push(
      await plugin.addListener('installLog', (info) => {
        const line = String(info.line ?? '');
        if (line) onLog(line);
      })
    );
    subs.push(
      await plugin.addListener('installProgress', (info) => {
        onProgress(Number(info.downloaded ?? 0), Number(info.total ?? 100));
      })
    );
    subs.push(
      await plugin.addListener('installPhase', (info) => {
        const phase = String(info.phase ?? '');
        if (phase && onPhase) onPhase(phase);
      })
    );
    let done: { ok: boolean; error?: string } | null = null;
    const doneSub = await plugin.addListener('installDone', (info) => {
      done = { ok: info.ok === true, error: String(info.error ?? '') || undefined };
    });
    subs.push(doneSub);
    await plugin.install();
    // install() resolves at completion; installDone carries the verdict.
    if (done) return done;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    for (const s of subs) {
      try {
        s.remove();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function nativeStart(): Promise<void> {
  const plugin = await waitForBridge();
  if (!plugin) throw new Error('native bridge unavailable');
  await plugin.start();
}

export async function nativeStop(): Promise<void> {
  const plugin = await waitForBridge();
  if (!plugin) throw new Error('native bridge unavailable');
  await plugin.stop();
}

export async function nativeStatus(): Promise<NativeGatewayStatus> {
  const plugin = await waitForBridge();
  if (!plugin) throw new Error('native bridge unavailable');
  return plugin.status();
}

// Native HTTP probe of 127.0.0.1:8080/health. Preferred over the WebView
// fetch on-device: it runs outside the WebView's network stack, so it cannot
// be blocked by cleartext policy and reports the true gateway state.
export async function nativeHealth(): Promise<boolean> {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.health !== 'function') return false;
  try {
    const res = await plugin.health();
    return res.running === true;
  } catch {
    return false;
  }
}

// Mirror the active provider/key into the native prefs that renderConfig
// reads on every gateway (re)start. Without this the on-device gateway keeps
// running its old provider and chat fails auth.
//
// P0-C: the same call also carries the local-API server key and the Telegram
// / Discord bot tokens. MobileGatewayService.startGateway() reads all three
// out of SecurePrefs (server_key / tg_token / discord_token) and exports them
// as API_SERVER_KEY / TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN, so pushing them
// here is what makes saved credentials reach the gateway process.
export async function nativeSetProvider(opts: {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  // Optional credential carry (P0-C): forwarded only when the caller sets
  // them, so an older 4-field caller behaves exactly as before.
  serverKey?: string;
  tgToken?: string;
  discordToken?: string;
  // Active profile id (prov_<slug>_<rand>), so the native side can tell a
  // per-profile secret write for the ACTIVE profile apart from the rest.
  activeProfileId?: string;
}): Promise<void> {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.setProvider !== 'function') return;
  // Wire names are camelCase; the native plugin also accepts the snake_case
  // aliases (server_key / tg_token / discord_token). A blank/absent serverKey
  // is omitted: the plugin rejects a blank server key loudly and omitting it
  // leaves the stored value untouched. A blank token is forwarded, which the
  // plugin reads as "user cleared this slot".
  const payload: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    serverKey?: string;
    tgToken?: string;
    discordToken?: string;
    activeProfileId?: string;
  } = {
    provider: opts.provider ?? '',
    apiKey: opts.apiKey ?? '',
    baseUrl: opts.baseUrl ?? '',
    model: opts.model ?? '',
  };
  if (typeof opts.activeProfileId === 'string' && opts.activeProfileId !== '') {
    payload.activeProfileId = opts.activeProfileId;
  }
  if (typeof opts.serverKey === 'string' && opts.serverKey !== '') {
    payload.serverKey = opts.serverKey;
  }
  if (typeof opts.tgToken === 'string') payload.tgToken = opts.tgToken;
  if (typeof opts.discordToken === 'string') payload.discordToken = opts.discordToken;
  await plugin.setProvider(payload);
}

export async function nativeSetAutostart(enabled: boolean): Promise<void> {
  const plugin = getPlugin();
  // No-plugin (web) and pre-setAutostart plugin builds are both no-ops, so an
  // older APK never makes the caller throw.
  if (!plugin || typeof plugin.setAutostart !== 'function') return;
  await plugin.setAutostart({ enabled });
}

// Local-API key minted by Bootstrap (SecurePrefs server_key). The WebView
// can never guess it, so sync it once at boot: without it every /api/*
// call fails auth and sessions, jobs and model lists stay empty.
export async function nativeServerKey(): Promise<string> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.serverKey !== 'function') return '';
  for (let attempt = 0; attempt < SERVER_KEY_ATTEMPTS; attempt += 1) {
    try {
      const res = await plugin.serverKey();
      const key = typeof res?.serverKey === 'string' ? res.serverKey.trim() : '';
      if (key) return key;
    } catch {
      // The bridge answered with an error; a later attempt may succeed.
    }
    if (attempt + 1 < SERVER_KEY_ATTEMPTS) await waitMs(SERVER_KEY_RETRY_MS);
  }
  return '';
}

export interface PickedProjectDir {
  uri: string;
  name: string;
  hostPath: string;
}

// Project folders: SAF tree picker on the native side (persisted URI
// permission, any volume the picker offers). The folder is then imported
// into app-private storage, so hostPath is display-only and may be empty.
// Returns null when the user cancels or the bridge is absent (web).
export async function nativePickProjectDir(): Promise<PickedProjectDir | null> {
  if (!isNativeGateway()) return null;
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.pickProjectDir !== 'function') return null;
  try {
    const res = await plugin.pickProjectDir();
    const uri = typeof res?.uri === 'string' ? res.uri : '';
    if (!uri) return null;
    return {
      uri,
      name: typeof res?.name === 'string' && res.name ? res.name : 'project',
      hostPath: typeof res?.hostPath === 'string' ? res.hostPath : '',
    };
  } catch {
    return null;
  }
}

// Import a picked SAF tree into app-private storage
// (files/debian/hermes_home/.projects/<id>). Present only in the APK;
// rejects with too_large past the native cap, cancelled, copy_failed.
export async function nativeImportProjectTree(
  uri: string,
  id: string
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!isNativeGateway()) return { ok: false, count: 0, error: 'web' };
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.importProjectTree !== 'function')
    return { ok: false, count: 0, error: 'unsupported' };
  try {
    const res = await plugin.importProjectTree({ uri, id });
    return { ok: true, count: typeof res?.count === 'number' ? res.count : 0 };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    const code = /too_large|cancelled|copy_failed|exists|bad_id|bad_uri|unsupported/.exec(msg)?.[0];
    return { ok: false, count: 0, error: code || 'copy_failed' };
  }
}

// Export an imported project copy back out to a user-picked folder.
// Silent null when the user cancels.
export async function nativeExportProjectTree(
  id: string
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!isNativeGateway()) return { ok: false, count: 0, error: 'web' };
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.exportProjectTree !== 'function')
    return { ok: false, count: 0, error: 'unsupported' };
  try {
    const res = await plugin.exportProjectTree({ id });
    return { ok: true, count: typeof res?.count === 'number' ? res.count : 0 };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    const code = /cancelled|not_found|copy_failed|bad_id|busy|unsupported/.exec(msg)?.[0];
    if (code === 'cancelled') return { ok: false, count: 0 };
    return { ok: false, count: 0, error: code || 'copy_failed' };
  }
}

// Encrypted secret slots (SecurePrefs). Present only in the APK; on plain
// web these reject and the caller falls back to the vault/localStorage path.
// Keys are allowlisted native-side; anything else rejects.
export async function nativeSecretGet(key: string): Promise<string | null> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.secretGet !== 'function') return null;
  try {
    const res = await plugin.secretGet({ key });
    return typeof res?.value === 'string' ? res.value : null;
  } catch {
    return null;
  }
}

export async function nativeSecretSet(key: string, value: string): Promise<boolean> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.secretSet !== 'function') return false;
  try {
    await plugin.secretSet({ key, value });
    return true;
  } catch {
    return false;
  }
}

// Monotonic device clock (elapsedRealtime, ms since boot). Null on web or
// when the bridge is unavailable; the PIN lockout uses it so moving the
// device clock cannot shorten a running penalty.
export async function nativeMonotonicNow(): Promise<number | null> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.monotonicNow !== 'function') return null;
  try {
    const res = await plugin.monotonicNow();
    return typeof res?.now === 'number' ? res.now : null;
  } catch {
    return null;
  }
}

// Alert notifications (R1). Best-effort: rejections never surface, the
// in-app approvals queue stays authoritative.
export async function nativeNotifGranted(): Promise<boolean | null> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.notifState !== 'function') return null;
  try {
    const res = await plugin.notifState();
    return res?.granted === true;
  } catch {
    return null;
  }
}

export async function nativeRequestNotifAlerts(): Promise<boolean> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.requestNotifAlerts !== 'function') return false;
  try {
    await plugin.requestNotifAlerts();
    return true;
  } catch {
    return false;
  }
}

export async function nativeNotifyAlert(title: string, body: string): Promise<void> {
  const plugin = await waitForBridge();
  if (!plugin || typeof plugin.notifyAlert !== 'function') return;
  try {
    await plugin.notifyAlert({ title, body });
  } catch {
    // Best-effort by design.
  }
}

// Verified stop (GATEWAY-05): resolves the native stop() verdict payload.
// verified is true only when process exit + port closed + health false hold.
// nativeStop() keeps its void signature; use this when the UI must gate on it.
export async function nativeStopVerified(): Promise<NativeStopVerification> {
  const plugin = await waitForBridge();
  if (!plugin) throw new Error('native bridge unavailable');
  const res = await plugin.stop();
  const verified = res?.verified === true;
  return {
    verified,
    processExited: res?.processExited === true,
    portClosed: res?.portClosed === true,
    healthFalse: res?.healthFalse === true,
  };
}

// Startup phase detail (GATEWAY-04) without a full status round-trip.
export async function nativeStartupInfo(): Promise<NativeStartupInfo> {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.startupInfo !== 'function') {
    throw new Error('native bridge unavailable');
  }
  const res = await plugin.startupInfo();
  return {
    phase: typeof res.phase === 'string' ? res.phase : 'IDLE',
    elapsedMs: Number(res.elapsedMs ?? 0) || 0,
    lastError: typeof res.lastError === 'string' ? res.lastError : '',
    logPath: typeof res.logPath === 'string' ? res.logPath : '',
    retryable: res.retryable === true,
  };
}

// Install preflight (INSTALL-01/04): storage headroom + compat metadata.
export async function nativePreflight(): Promise<NativePreflight> {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.preflight !== 'function') {
    throw new Error('native bridge unavailable');
  }
  const res = await plugin.preflight();
  return {
    freeBytes: Number(res.freeBytes ?? -1),
    neededBytes: Number(res.neededBytes ?? 0),
    enough: res.enough !== false,
    appVersion: typeof res.appVersion === 'string' ? res.appVersion : '',
    gatewayVersion: typeof res.gatewayVersion === 'string' ? res.gatewayVersion : '',
    protocolVersion: Number(res.protocolVersion ?? 0) || 0,
    imageVersion: typeof res.imageVersion === 'string' ? res.imageVersion : '',
    compatible: res.compatible !== false,
    compatError: typeof res.compatError === 'string' ? res.compatError : '',
  };
}

// Push the minted local-API key into native prefs. Fails gracefully when
// the plugin build predates setServerKey: returns ok=false, never throws.
export async function nativeSetServerKey(serverKey: string): Promise<NativeServerKeyAck> {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.setServerKey !== 'function') {
    return { ok: false, error: plainResultLine('setServerKey unavailable', '') };
  }
  try {
    await plugin.setServerKey({ serverKey });
    return { ok: true };
  } catch (e) {
    // The ack error is rendered by the settings screen, so the native
    // exception text must not ride along: plainResultLine keeps an honest
    // sentence and returns an empty string for machine text, which makes the
    // caller fall back to its own copy.
    return { ok: false, error: plainResultLine(e instanceof Error ? e.message : String(e), '') };
  }
}

// Stop then start the on-device gateway with verified stop.
export async function nativeRestart(): Promise<void> {
  try {
    await nativeStopVerified();
  } catch {
    await nativeStop();
  }
  await nativeStart();
}

// Chat SSE over the native stream bridge (streamPost/streamAbort): the
// WebView cannot fetch() the gateway (CORS), and CapacitorHttp cannot
// stream, so the POST runs on HttpURLConnection and ships raw bytes as
// base64 chunks. Resolves 'done' on clean EOF, 'cancelled' on abort,
// 'error' otherwise; non-2xx goes through onStatus like res.ok handling.
export async function nativeStreamPost(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  onStatus: (status: number) => void;
  onBytes: (bytes: Uint8Array) => void;
}): Promise<'done' | 'cancelled' | 'error' | string> {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.streamPost !== 'function') return 'error';
  const id = `s${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
  const subs: Array<{ remove: () => void }> = [];
  let settle: ((v: 'done' | 'cancelled' | string) => void) | null = null;
  const finished = new Promise<'done' | 'cancelled' | string>((resolve) => {
    settle = resolve;
  });
  const cleanup = () => {
    for (const s of subs) {
      try {
        s.remove();
      } catch {
        /* ignore */
      }
    }
    subs.length = 0;
  };
  const forId = (info: Record<string, unknown>, fn: () => void) => {
    if (String(info.id ?? '') === id) fn();
  };
  try {
    subs.push(
      await plugin.addListener('gwStreamChunk', (info) =>
        forId(info, () => {
          const b64 = String(info.chunk ?? '');
          if (!b64) return;
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          opts.onBytes(bytes);
        })
      )
    );
    subs.push(
      await plugin.addListener('gwStreamDone', (info) =>
        forId(info, () => settle?.('done'))
      )
    );
    subs.push(
      await plugin.addListener('gwStreamError', (info) =>
        forId(info, () => {
          const msg = String((info as Record<string, unknown>).message ?? '');
          if (info.cancelled === true) settle?.('cancelled');
          else settle?.(msg ? `error:${msg}` : 'error');
        })
      )
    );
    subs.push(
      await plugin.addListener('gwStreamStatus', (info) =>
        forId(info, () => {
          opts.onStatus(Number(info.status ?? 0));
          settle?.('error');
        })
      )
    );
    const onAbort = () => {
      try {
        void plugin.streamAbort?.({ id });
      } catch {
        /* ignore */
      }
    };
    let abortAttached = false;
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return 'cancelled';
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
      abortAttached = true;
    }
    const WATCHDOG_MS = 90000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const watchdogPromise = new Promise<string>((resolve) => {
      watchdog = setTimeout(() => resolve('error:watchdog timeout'), WATCHDOG_MS);
    });
    try {
      await plugin.streamPost({ id, url: opts.url, headers: opts.headers, body: opts.body });
      const result = await Promise.race([finished, watchdogPromise]);
      return result as 'done' | 'cancelled' | 'error' | string;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (abortAttached && opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  } catch {
    return 'error';
  } finally {
    cleanup();
    settle = null;
  }
}
