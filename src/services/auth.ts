import { isNativeGateway, nativeSecretGet, nativeSecretSet } from './nativeGateway';

export const AUTH_BASE_URL = 'http://100.112.74.9:8082';

// Storage keys: localStorage on web, lockout.* slots on native (SecurePrefs, allowlisted)
const LS_ACCESS = 'hermes.auth.accessToken';
const LS_REFRESH = 'hermes.auth.refreshToken';
const LS_USER = 'hermes.auth.user';

const NATIVE_ACCESS = 'lockout.authAccessToken';
const NATIVE_REFRESH = 'lockout.authRefreshToken';
const NATIVE_USER = 'lockout.authUser';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  tokenType?: string;
}

export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export interface SessionInfo {
  id: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  createdAt?: string;
  lastActiveAt?: string;
  current?: boolean;
  [key: string]: unknown;
}

export interface Credential {
  id: string;
  name?: string;
  type?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface RegisterPayload {
  email: string;
  password: string;
  name?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface VerifyEmailPayload {
  token: string;
}

export interface ForgotPasswordPayload {
  email: string;
}

export interface ResetPasswordPayload {
  token: string;
  password: string;
}

export interface PatchMePayload {
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export interface AddCredentialPayload {
  name: string;
  value?: string;
  type?: string;
  [key: string]: unknown;
}

// In-memory cache to avoid async storage read on every request
let memAccess: string | null = null;
let memRefresh: string | null = null;
let memUser: AuthUser | null = null;
let loaded = false;
let refreshFlight: Promise<string | null> | null = null;

function isNative(): boolean {
  try {
    return isNativeGateway();
  } catch {
    return false;
  }
}

async function nativeGet(key: string): Promise<string | null> {
  try {
    const v = await nativeSecretGet(key);
    return v;
  } catch {
    return null;
  }
}

async function nativeSet(key: string, value: string): Promise<void> {
  try {
    await nativeSecretSet(key, value);
  } catch {
    // best effort
  }
}

function lsGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // quota or unavailable
  }
}

function lsRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (isNative()) {
    const [a, r, u] = await Promise.all([
      nativeGet(NATIVE_ACCESS),
      nativeGet(NATIVE_REFRESH),
      nativeGet(NATIVE_USER),
    ]);
    memAccess = a && a.length > 0 ? a : null;
    memRefresh = r && r.length > 0 ? r : null;
    if (u && u.length > 0) {
      try {
        memUser = JSON.parse(u) as AuthUser;
      } catch {
        memUser = null;
      }
    } else {
      memUser = null;
    }
  } else {
    const a = lsGet(LS_ACCESS);
    const r = lsGet(LS_REFRESH);
    const u = lsGet(LS_USER);
    memAccess = a && a.length > 0 ? a : null;
    memRefresh = r && r.length > 0 ? r : null;
    if (u && u.length > 0) {
      try {
        memUser = JSON.parse(u) as AuthUser;
      } catch {
        memUser = null;
      }
    } else {
      memUser = null;
    }
  }
  loaded = true;
}

async function persistAccessToken(token: string): Promise<void> {
  memAccess = token;
  if (isNative()) await nativeSet(NATIVE_ACCESS, token);
  else lsSet(LS_ACCESS, token);
}

async function persistRefreshToken(token: string): Promise<void> {
  memRefresh = token;
  if (isNative()) await nativeSet(NATIVE_REFRESH, token);
  else lsSet(LS_REFRESH, token);
}

async function persistUser(user: AuthUser | null): Promise<void> {
  memUser = user;
  const raw = user ? JSON.stringify(user) : '';
  if (isNative()) await nativeSet(NATIVE_USER, raw);
  else {
    if (user) lsSet(LS_USER, raw);
    else lsRemove(LS_USER);
  }
  // nativeSet with blank removes the slot
  if (isNative() && !user) await nativeSet(NATIVE_USER, '');
}

async function persistPair(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([persistAccessToken(accessToken), persistRefreshToken(refreshToken)]);
}

async function removeAccessToken(): Promise<void> {
  memAccess = null;
  if (isNative()) await nativeSet(NATIVE_ACCESS, '');
  else lsRemove(LS_ACCESS);
}

async function removeRefreshToken(): Promise<void> {
  memRefresh = null;
  if (isNative()) await nativeSet(NATIVE_REFRESH, '');
  else lsRemove(LS_REFRESH);
}

async function removeUser(): Promise<void> {
  await persistUser(null);
}

export async function clearAuthStorage(): Promise<void> {
  memAccess = null;
  memRefresh = null;
  memUser = null;
  loaded = true;
  if (isNative()) {
    await Promise.all([
      nativeSet(NATIVE_ACCESS, ''),
      nativeSet(NATIVE_REFRESH, ''),
      nativeSet(NATIVE_USER, ''),
    ]);
  } else {
    lsRemove(LS_ACCESS);
    lsRemove(LS_REFRESH);
    lsRemove(LS_USER);
  }
}

export async function getAccessToken(): Promise<string | null> {
  await ensureLoaded();
  return memAccess;
}

export async function getRefreshToken(): Promise<string | null> {
  await ensureLoaded();
  return memRefresh;
}

export async function getStoredUser(): Promise<AuthUser | null> {
  await ensureLoaded();
  return memUser;
}

export async function isAuthenticated(): Promise<boolean> {
  const t = await getAccessToken();
  return !!t;
}

function extractTokens(data: Record<string, unknown>): { accessToken: string; refreshToken: string } {
  const at =
    (typeof data.accessToken === 'string' ? data.accessToken : '') ||
    (typeof data.access_token === 'string' ? (data.access_token as string) : '') ||
    (typeof (data.tokens as Record<string, unknown> | undefined)?.accessToken === 'string'
      ? ((data.tokens as Record<string, unknown>).accessToken as string)
      : '') ||
    (typeof (data.data as Record<string, unknown> | undefined)?.accessToken === 'string'
      ? ((data.data as Record<string, unknown>).accessToken as string)
      : '');
  const rt =
    (typeof data.refreshToken === 'string' ? data.refreshToken : '') ||
    (typeof data.refresh_token === 'string' ? (data.refresh_token as string) : '') ||
    (typeof (data.tokens as Record<string, unknown> | undefined)?.refreshToken === 'string'
      ? ((data.tokens as Record<string, unknown>).refreshToken as string)
      : '') ||
    (typeof (data.data as Record<string, unknown> | undefined)?.refreshToken === 'string'
      ? ((data.data as Record<string, unknown>).refreshToken as string)
      : '');
  return { accessToken: at, refreshToken: rt };
}

function extractUser(data: Record<string, unknown>): AuthUser | null {
  const cand =
    (data.user as AuthUser | undefined) ||
    (data.data as Record<string, unknown> | undefined)?.user as AuthUser | undefined ||
    (data.profile as AuthUser | undefined) ||
    null;
  if (cand && typeof cand === 'object' && typeof (cand as AuthUser).email === 'string') return cand as AuthUser;
  if (typeof data.email === 'string' && typeof data.id === 'string') return data as unknown as AuthUser;
  return null;
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  try {
    const j = (await res.json()) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    return { data: j } as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function unauthedFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${AUTH_BASE_URL}${path}`, init);
}

async function doRefresh(): Promise<string | null> {
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async (): Promise<string | null> => {
    await ensureLoaded();
    const rt = memRefresh;
    if (!rt) return null;
    try {
      const res = await unauthedFetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) {
        await clearAuthStorage();
        return null;
      }
      const data = await parseJsonSafe(res);
      const { accessToken, refreshToken } = extractTokens(data);
      if (!accessToken) {
        await clearAuthStorage();
        return null;
      }
      await persistAccessToken(accessToken);
      if (refreshToken) await persistRefreshToken(refreshToken);
      const u = extractUser(data);
      if (u) await persistUser(u);
      return accessToken;
    } catch {
      await clearAuthStorage();
      return null;
    } finally {
      refreshFlight = null;
    }
  })();
  const result = await refreshFlight;
  refreshFlight = null;
  return result;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await ensureLoaded();
  const headers: Record<string, string> = {};
  if (init.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => {
      headers[k] = v;
    });
  }
  if (!headers['Content-Type'] && init.body) headers['Content-Type'] = 'application/json';
  if (memAccess) headers['Authorization'] = `Bearer ${memAccess}`;

  let res = await fetch(`${AUTH_BASE_URL}${path}`, { ...init, headers });

  if (res.status === 401 && memRefresh) {
    const newAccess = await doRefresh();
    if (newAccess) {
      const retryHeaders: Record<string, string> = { ...headers, Authorization: `Bearer ${newAccess}` };
      res = await fetch(`${AUTH_BASE_URL}${path}`, { ...init, headers: retryHeaders });
    }
  }
  return res;
}

function ensureOk(res: Response, data: Record<string, unknown>): void {
  if (res.ok) return;
  const msg =
    (typeof data.message === 'string' ? data.message : '') ||
    (typeof data.error === 'string' ? data.error : '') ||
    (typeof data.detail === 'string' ? data.detail : '') ||
    `Request failed: HTTP ${res.status}`;
  throw new Error(msg);
}

// Public API

export async function register(payload: RegisterPayload): Promise<AuthResponse> {
  const res = await unauthedFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const { accessToken, refreshToken } = extractTokens(data);
  const user = extractUser(data);
  if (accessToken && refreshToken) await persistPair(accessToken, refreshToken);
  else if (accessToken) await persistAccessToken(accessToken);
  if (user) await persistUser(user);
  return {
    user: user ?? ({ email: payload.email, id: (data.id as string) ?? '' } as AuthUser),
    accessToken: accessToken || '',
    refreshToken: refreshToken || '',
  };
}

export async function login(payload: LoginPayload): Promise<AuthResponse> {
  const res = await unauthedFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const { accessToken, refreshToken } = extractTokens(data);
  const user = extractUser(data);
  if (accessToken && refreshToken) await persistPair(accessToken, refreshToken);
  else if (accessToken) await persistAccessToken(accessToken);
  if (user) await persistUser(user);
  else if (data.email) await persistUser(data as unknown as AuthUser);
  return {
    user: user ?? ({ email: payload.email, id: (data.id as string) ?? '' } as AuthUser),
    accessToken: accessToken || '',
    refreshToken: refreshToken || '',
  };
}

export async function refresh(): Promise<TokenPair> {
  const at = await doRefresh();
  if (!at) throw new Error('Refresh failed');
  await ensureLoaded();
  return { accessToken: at, refreshToken: memRefresh ?? '' };
}

export async function logout(): Promise<void> {
  await ensureLoaded();
  const rt = memRefresh;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (memAccess) headers['Authorization'] = `Bearer ${memAccess}`;
    await fetch(`${AUTH_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rt ? { refresh_token: rt } : {}),
    });
  } catch {
    // wipe regardless
  } finally {
    await clearAuthStorage();
    await removeAccessToken();
    await removeRefreshToken();
    await removeUser();
  }
}

export async function verifyEmail(payload: VerifyEmailPayload): Promise<void> {
  const res = await unauthedFetch('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
}

export async function resendVerification(email: string): Promise<void> {
  const res = await unauthedFetch('/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
}

export async function forgotPassword(payload: ForgotPasswordPayload): Promise<void> {
  const res = await unauthedFetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
}

export async function resetPassword(payload: ResetPasswordPayload): Promise<void> {
  const res = await unauthedFetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
}

export async function me(): Promise<AuthUser> {
  const res = await authedFetch('/api/auth/me', { method: 'GET' });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const user = extractUser(data) ?? (data as unknown as AuthUser);
  if (user && typeof user.email === 'string') {
    await persistUser(user as AuthUser);
    return user as AuthUser;
  }
  throw new Error('Invalid user response');
}

export async function patchMe(payload: PatchMePayload): Promise<AuthUser> {
  const res = await authedFetch('/api/auth/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const user = extractUser(data) ?? (data as unknown as AuthUser);
  if (user && typeof user.email === 'string') {
    await persistUser(user as AuthUser);
    return user as AuthUser;
  }
  throw new Error('Invalid user response');
}

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await authedFetch('/api/auth/sessions', { method: 'GET' });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const arr =
    (data.sessions as SessionInfo[] | undefined) ??
    (data.data as SessionInfo[] | undefined) ??
    ((data as unknown as SessionInfo[]) instanceof Array ? (data as unknown as SessionInfo[]) : undefined) ??
    [];
  return Array.isArray(arr) ? arr : [];
}

export async function revokeSession(sessionId: string): Promise<void> {
  const res = await authedFetch(`/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
}

export async function listCredentials(): Promise<Credential[]> {
  const res = await authedFetch('/api/auth/credentials', { method: 'GET' });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const arr =
    (data.credentials as Credential[] | undefined) ??
    (data.data as Credential[] | undefined) ??
    ((data as unknown as Credential[]) instanceof Array ? (data as unknown as Credential[]) : undefined) ??
    [];
  return Array.isArray(arr) ? arr : [];
}

export async function addCredential(payload: AddCredentialPayload): Promise<Credential> {
  const res = await authedFetch('/api/auth/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
  const cred = (data.credential as Credential | undefined) ?? (data as unknown as Credential);
  return cred as Credential;
}

export async function deleteCredential(id: string): Promise<void> {
  const res = await authedFetch(`/auth/credentials/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await parseJsonSafe(res);
  ensureOk(res, data);
}
