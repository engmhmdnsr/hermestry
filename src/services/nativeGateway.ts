// Bridge to the native on-device gateway runner (Capacitor plugin
// "HermesGateway"). Present only inside the Android APK; on plain web
// every helper reports unavailable and callers use their web fallback.

export interface NativeGatewayStatus {
  running: boolean;
  state: string;
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
    event: 'installLog' | 'installProgress' | 'installPhase' | 'installDone',
    cb: (info: Record<string, unknown>) => void
  ): Promise<{ remove: () => void }>;
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

export async function nativeInstall(
  onLog: (line: string) => void,
  onProgress: (downloaded: number, total: number) => void,
  onPhase?: (phase: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const plugin = getPlugin();
  if (!plugin) return { ok: false, error: 'native bridge unavailable' };
  const subs = await Promise.all([
    plugin.addListener('installLog', (info) => {
      const line = String(info.line ?? '');
      if (line) onLog(line);
    }),
    plugin.addListener('installProgress', (info) => {
      onProgress(Number(info.downloaded ?? 0), Number(info.total ?? 100));
    }),
    plugin.addListener('installPhase', (info) => {
      const phase = String(info.phase ?? '');
      if (phase && onPhase) onPhase(phase);
    }),
  ]);
  try {
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
  const plugin = getPlugin();
  if (!plugin) throw new Error('native bridge unavailable');
  await plugin.start();
}

export async function nativeStop(): Promise<void> {
  const plugin = getPlugin();
  if (!plugin) throw new Error('native bridge unavailable');
  await plugin.stop();
}

export async function nativeStatus(): Promise<NativeGatewayStatus> {
  const plugin = getPlugin();
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
  } = {
    provider: opts.provider ?? '',
    apiKey: opts.apiKey ?? '',
    baseUrl: opts.baseUrl ?? '',
    model: opts.model ?? '',
  };
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
  const plugin = getPlugin();
  if (!plugin || typeof plugin.serverKey !== 'function') return '';
  try {
    const res = await plugin.serverKey();
    return typeof res.serverKey === 'string' ? res.serverKey : '';
  } catch {
    return '';
  }
}

// Verified stop (GATEWAY-05): resolves the native stop() verdict payload.
// verified is true only when process exit + port closed + health false hold.
// nativeStop() keeps its void signature; use this when the UI must gate on it.
export async function nativeStopVerified(): Promise<NativeStopVerification> {
  const plugin = getPlugin();
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
    return { ok: false, error: 'setServerKey unavailable' };
  }
  try {
    await plugin.setServerKey({ serverKey });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Stop then start the on-device gateway.
export async function nativeRestart(): Promise<void> {
  await nativeStop();
  await nativeStart();
}
