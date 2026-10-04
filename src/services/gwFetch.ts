import { Capacitor, CapacitorHttp } from '@capacitor/core';

// Same-origin fetch is blocked on device: the WebView runs on
// https://localhost while the gateway listens on http://127.0.0.1:8080,
// and the gateway sends no CORS headers, so every plain fetch to it dies
// with 'blocked by CORS policy' (memory, routines, sessions, provider
// validation, jobs: all of them). On native, route through CapacitorHttp,
// which runs on the native stack with no origin check; on web keep fetch.
// The result is shaped as a real Response, so call sites stay unchanged.
export async function gwFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!Capacitor.isNativePlatform()) return fetch(input, init);
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const method = (init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (init.headers) new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const doRequest = CapacitorHttp.request({
    url: input,
    method: method as 'GET',
    headers,
    data: (init.body as string | undefined) ?? undefined,
    connectTimeout: 15000,
    readTimeout: 60000,
  });
  if (!init.signal) {
    const res = await doRequest;
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers || {})) outHeaders.append(k, String(v));
    if (!outHeaders.has('content-type') && typeof res.data !== 'string') {
      outHeaders.set('content-type', 'application/json');
    }
    return new Response(text, { status: res.status, headers: outHeaders });
  }
  let abortHandler: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
    init.signal!.addEventListener('abort', abortHandler as EventListener, { once: true });
  });
  try {
    const res = await Promise.race([doRequest, abortPromise]);
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers || {})) outHeaders.append(k, String(v));
    if (!outHeaders.has('content-type') && typeof res.data !== 'string') {
      outHeaders.set('content-type', 'application/json');
    }
    return new Response(text, { status: res.status, headers: outHeaders });
  } finally {
    if (abortHandler && init.signal) init.signal.removeEventListener('abort', abortHandler as EventListener);
  }
}
