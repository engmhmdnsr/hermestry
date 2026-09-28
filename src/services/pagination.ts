/**
 * Pagination, cache-reconciliation, and retention helpers (T7 DATA-01/02/06).
 *
 * LIST_UI_SPEC (integration contract for list screens; UI lives elsewhere):
 * - `loading`: first load, no cached items yet. Show skeleton/spinner.
 * - `refreshing`: refetch with cached items shown. Keep list, show pull
 *   indicator; do not blank the list.
 * - `live`: `live === true`. Show items; show lastSyncedAt if desired.
 * - `stale` / `offline`: `stale === true` (fetch failed, cache shown).
 *   Banner: "Offline, showing cached data" + lastSyncedAt. Keep actions
 *   that need the gateway disabled or queued.
 * - `error`: `stale === false`, `live === false`, items empty, error set.
 *   Show error panel with Retry. Do NOT render as an empty list.
 * - `empty`: live fetch succeeded with zero items. Show empty-state copy.
 * Use `resolveListUiState(meta, items, flags)` to map a result to one state.
 *
 * CACHE RECONCILIATION POLICY (server-authoritative + local-pending):
 * 1. Server is authoritative for every id it returns: same-id fields from
 *    the server win over cached fields.
 * 2. Local-only items are kept ONLY when they carry a pending marker
 *    (created/edited while offline and not yet confirmed). They sort after
 *    server items and are flagged for upload/retry.
 * 3. Local-only items with no pending marker are dropped (deleted on server
 *    or superseded). Never concatenate blindly.
 * 4. Deletes are explicit: a confirmed server delete removes the cached
 *    copy; a failed delete keeps the item and surfaces error.
 * 5. Conflict on the same id with both sides dirty: newest write wins by
 *    timestamp (lastActiveAt / timestamp / updatedAt); ties go to server.
 *
 * RETENTION POLICY:
 * - Messages: page size 50 (latest-50 first, older-50 via offset). Local
 *   per-session cache keeps the newest MESSAGE_RETENTION_CAP (200); older
 *   entries are evicted on save. Long history stays on the gateway.
 * - Sessions: page size 50, max 100 per request. Local session list keeps
 *   the newest SESSION_CACHE_CAP (200) by lastActiveAt.
 */

import type { ListSyncResult, ListUiState, PagedResult, SyncMeta } from './syncState';

export const DEFAULT_SESSIONS_PAGE_SIZE = 50;
export const MAX_SESSIONS_PAGE_SIZE = 100;
export const DEFAULT_MESSAGES_PAGE_SIZE = 50;
export const MAX_MESSAGES_PAGE_SIZE = 200;
export const MESSAGE_RETENTION_CAP = 200;
export const SESSION_CACHE_CAP = 200;

export interface PageParams {
  limit?: number;
  offset?: number;
  /** Opaque cursor; gateways that accept it get `cursor=` instead of offset. */
  cursor?: string;
}

export interface ResolvedPage {
  limit: number;
  offset: number;
  cursor?: string;
}

export const clampPage = (
  params: PageParams | undefined,
  def: number,
  max: number
): ResolvedPage => {
  const limit = Math.min(Math.max(params?.limit ?? def, 1), max);
  const offset = Math.max(params?.offset ?? 0, 0);
  const out: ResolvedPage = { limit, offset };
  if (params?.cursor) out.cursor = params.cursor;
  return out;
};

/** Build `?limit=&offset=` (or `&cursor=`) query string. */
export const buildPageQuery = (page: ResolvedPage): string => {
  const q = new URLSearchParams();
  q.set('limit', String(page.limit));
  if (page.cursor) q.set('cursor', page.cursor);
  else q.set('offset', String(page.offset));
  return `?${q.toString()}`;
};

export interface RawPage {
  arr: unknown[];
  total?: number;
}

/** Pick the item array out of the common gateway envelope shapes. */
export const pickArray = (data: unknown, keys: string[]): RawPage => {
  if (Array.isArray(data)) return { arr: data };
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(obj[k])) {
        const total =
          typeof obj.total === 'number'
            ? (obj.total as number)
            : typeof obj.count === 'number'
              ? (obj.count as number)
              : undefined;
        return { arr: obj[k] as unknown[], total };
      }
    }
  }
  return { arr: [] };
};

export const toPagedResult = <T>(
  items: T[],
  meta: SyncMeta,
  page: ResolvedPage,
  total?: number
): PagedResult<T> => {
  const hasMore =
    typeof total === 'number' ? page.offset + items.length < total : items.length >= page.limit;
  return {
    ...meta,
    items,
    limit: page.limit,
    offset: page.offset,
    hasMore,
    nextOffset: hasMore ? page.offset + page.limit : null,
    ...(typeof total === 'number' ? { total } : {}),
  };
};

export const liveMeta = (lastSyncedAt: number): SyncMeta => ({
  live: true,
  stale: false,
  lastSyncedAt,
  source: 'live',
});

export const staleMeta = (
  lastSyncedAt: number | null,
  error: string,
  hasCache: boolean
): SyncMeta => ({
  live: false,
  stale: hasCache,
  lastSyncedAt,
  error,
  source: hasCache ? 'cache' : 'empty',
});

export const emptyListResult = <T>(): ListSyncResult<T> => ({
  items: [],
  live: false,
  stale: false,
  lastSyncedAt: null,
  source: 'empty',
});

// --- lastSyncedAt persistence (localStorage ms timestamps) ---

export const readSyncedAt = (key: string): number | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

export const writeSyncedAt = (key: string, when: number = Date.now()): void => {
  try {
    localStorage.setItem(key, String(when));
  } catch {
    // Quota or unavailable, sync time is best-effort.
  }
};

// --- reconciliation (DATA-06) ---

export interface Reconcilable {
  id: string;
}

const timeOf = (x: Record<string, unknown>): number => {
  for (const k of ['lastActiveAt', 'timestamp', 'updatedAt', 'updated_at', 'last_active']) {
    const v = x[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
};

/**
 * Server-authoritative merge. Server items win on id collisions; local-only
 * items survive only when `isPending` marks them (offline-created/edited).
 */
export const reconcileById = <T extends Reconcilable>(
  server: T[],
  local: T[],
  isPending: (localItem: T) => boolean = () => false
): T[] => {
  const serverIds = new Set(server.map((s) => s.id));
  const out = [...server];
  for (const item of local) {
    if (!serverIds.has(item.id) && isPending(item)) out.push(item);
  }
  return out;
};

/**
 * Same-id conflict: newest timestamp wins, ties go to the server copy.
 * Use when both sides edited the same record while offline.
 */
export const resolveConflict = <T extends Reconcilable>(serverItem: T, localItem: T): T => {
  const s = timeOf(serverItem as unknown as Record<string, unknown>);
  const l = timeOf(localItem as unknown as Record<string, unknown>);
  if (l > s) return localItem;
  return serverItem;
};

// --- retention (DATA-02) ---

/** Keep the newest `cap` messages (chronological input, chronological out). */
export const capMessages = <T>(messages: T[], cap: number = MESSAGE_RETENTION_CAP): T[] =>
  messages.length > cap ? messages.slice(messages.length - cap) : messages;

/** Keep the newest `cap` sessions by lastActiveAt. */
export const capSessions = <T extends { lastActiveAt: number }>(
  sessions: T[],
  cap: number = SESSION_CACHE_CAP
): T[] =>
  sessions.length > cap
    ? [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, cap)
    : sessions;

// --- list UI state resolver (DATA-03/04/05) ---

export const resolveListUiState = (
  meta: Pick<SyncMeta, 'live' | 'stale' | 'error'>,
  itemCount: number,
  flags?: { loading?: boolean; refreshing?: boolean; offline?: boolean }
): ListUiState => {
  if (flags?.loading && itemCount === 0) return 'loading';
  if (flags?.refreshing && itemCount > 0) return 'refreshing';
  if (meta.live) return itemCount === 0 ? 'empty' : 'live';
  if (meta.stale) return flags?.offline === false ? 'stale' : 'offline';
  if (meta.error) return 'error';
  return itemCount === 0 ? 'empty' : 'live';
};
