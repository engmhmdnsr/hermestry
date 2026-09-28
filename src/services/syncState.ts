/**
 * Sync-state types for gateway list fetchers (T7 DATA-03/04/05).
 *
 * Every paginated fetcher in `pagination.ts` / `gateway.ts` returns one of
 * these envelopes instead of a bare array, so list UI can distinguish
 * loading / live / stale-offline / error / empty without guessing.
 */

export type SyncSource = 'live' | 'cache' | 'empty';

/** UI states a list screen must handle. See LIST_UI_SPEC in pagination.ts. */
export type ListUiState =
  | 'loading'
  | 'refreshing'
  | 'live'
  | 'stale'
  | 'offline'
  | 'error'
  | 'empty';

export interface SyncMeta {
  /** True when the payload came from a live gateway response. */
  live: boolean;
  /** True when the payload is served from local cache after a failure. */
  stale: boolean;
  /** Epoch ms of the last successful gateway sync for this key, else null. */
  lastSyncedAt: number | null;
  /** Human-readable failure reason when stale/error, else undefined. */
  error?: string;
  /** Where the payload came from. */
  source: SyncSource;
}

/** Non-paginated list with sync metadata (jobs, skills, blueprints). */
export interface ListSyncResult<T> extends SyncMeta {
  items: T[];
}

/** Paginated list with sync metadata (sessions, messages, runs, logs). */
export interface PagedResult<T> extends SyncMeta {
  items: T[];
  limit: number;
  offset: number;
  /** True when another page is likely available (page was full). */
  hasMore: boolean;
  /** Offset to request next, null when hasMore is false. */
  nextOffset: number | null;
  /** Server-reported total when the API provides one, else undefined. */
  total?: number;
}
