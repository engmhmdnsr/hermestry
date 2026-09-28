// Bridge to the native on-device gateway runner (Capacitor plugin
// "HermesGateway"). Present only inside the Android APK; on plain web
// every helper reports unavailable and callers use their web fallback.

export interface NativeGatewayStatus {
  running: boolean;
  state: string;
}

interface HermesGatewayPlugin {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<NativeGatewayStatus>;
  health(): Promise<NativeGatewayStatus>;
  setAutostart(options: { enabled: boolean }): Promise<void>;
  addListener(
    event: 'installLog' | 'installProgress' | 'installDone',
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
  onProgress: (downloaded: number, total: number) => void
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

export async function nativeSetAutostart(enabled: boolean): Promise<void> {
  const plugin = getPlugin();
  if (!plugin) return;
  await plugin.setAutostart({ enabled });
}
