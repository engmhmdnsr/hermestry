// Central error model for all gateway access (ERR-01 / ERR-02).
//
// Every gateway failure is represented as an AppError, never as a bare
// false / [] / null that callers could mistake for real data. Use
// toAppError() at catch boundaries and mapHttpStatus() for HTTP failures.
//
// i18n: `message` stays a plain-English cause+action string (backward
// compatible for logs and existing call sites). User-facing UI should
// prefer localizedMessage(err, lang), which resolves err.messageKey via
// the err* keys in constants/languages (en+ar). messageKey is derived
// from code automatically, so callers never set it by hand.
// Terminology follows the freeze table in constants/languages.ts:
// Gateway (user copy), Provider, Cron Job, Session, Assistant.

import { getTranslation } from '../constants/languages';

export type AppErrorCode =
  | 'unavailable'
  | 'auth'
  | 'provider'
  | 'model'
  | 'too-large'
  | 'approval'
  | 'rate-limited'
  | 'busy'
  | 'validation'
  | 'not-found'
  | 'unknown';

export interface AppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  offline: boolean;
  status?: number;
  cause?: unknown;
  /** i18n key for the localized cause+action string (err* in languages.ts). */
  messageKey?: string;
}

// One key per concept: the UI renders cause + action, never raw
// addresses, IPs, or log paths.
export const APP_ERROR_I18N_KEYS: Record<AppErrorCode, string> = {
  unavailable: 'errUnavailable',
  auth: 'errAuth',
  provider: 'errProvider',
  model: 'errModel',
  'too-large': 'errTooLarge',
  approval: 'errApproval',
  'rate-limited': 'errRateLimited',
  busy: 'errBusy',
  validation: 'errValidation',
  'not-found': 'errNotFound',
  unknown: 'errUnknown',
};

export function errorKey(code: AppErrorCode): string {
  return APP_ERROR_I18N_KEYS[code] ?? 'errUnknown';
}

// Localized cause+action string for UI rendering. Falls back to English
// via getTranslation for locales without err* tables.
export function localizedMessage(err: AppError, lang = 'en'): string {
  return getTranslation(err.messageKey ?? errorKey(err.code), lang);
}

// Strip network addresses and filesystem paths from free-text details so
// user-facing strings never leak raw IPs or log locations.
export function sanitizeDetail(detail: string): string {
  return detail
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]')
    .replace(/\[[0-9a-fA-F:]{2,}\](?::\d+)?/g, '[host]')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[path]')
    .replace(/\/(?:[^\s"']*\/)+[^\s"']*/g, '[path]')
    .replace(/\b[A-Za-z0-9_-]*?(?:api[_-]?key|token|secret|password)[=:]\s*\S+/gi, '[redacted]')
    .trim();
}

export function createAppError(
  code: AppErrorCode,
  message: string,
  opts?: { retryable?: boolean; offline?: boolean; status?: number; cause?: unknown }
): AppError {
  return {
    code,
    message,
    retryable: opts?.retryable ?? false,
    offline: opts?.offline ?? false,
    ...(opts?.status !== undefined ? { status: opts.status } : {}),
    ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
    messageKey: errorKey(code),
  };
}

export function isAppError(value: unknown): value is AppError {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string' && typeof v.retryable === 'boolean';
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 20;
}

function isOfflineNow(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

// Map an HTTP status to the standard error model (ERR-02).
// Messages are cause + action; free-text detail is sanitized so no raw
// host or path ever reaches the UI.
export function mapHttpStatus(status: number, detail = ''): AppError {
  const clean = sanitizeDetail(detail);
  const suffix = clean ? `: ${clean}` : '';
  switch (status) {
    case 401:
    case 403:
      return createAppError('auth', `Gateway auth failed (HTTP ${status})${suffix}. Check the gateway key.`, {
        retryable: false,
        status,
      });
    case 402:
      return createAppError('provider', `Provider billing or quota issue (HTTP 402)${suffix}.`, {
        retryable: false,
        status,
      });
    case 404:
      return createAppError('not-found', `Gateway resource not found (HTTP 404)${suffix}.`, {
        retryable: false,
        status,
      });
    case 408:
      return createAppError('unavailable', `Gateway request timed out (HTTP 408)${suffix}.`, {
        retryable: true,
        offline: isOfflineNow(),
        status,
      });
    case 409:
      return createAppError('busy', `Gateway rejected the request as conflicting (HTTP 409)${suffix}.`, {
        retryable: false,
        status,
      });
    case 413:
      return createAppError('too-large', `Request too large for the gateway (HTTP 413)${suffix}.`, {
        retryable: false,
        status,
      });
    case 422:
      return createAppError('validation', `Gateway rejected the request (HTTP 422)${suffix}.`, {
        retryable: false,
        status,
      });
    case 429:
      return createAppError('rate-limited', `Gateway rate limit hit (HTTP 429)${suffix}. Try again shortly.`, {
        retryable: true,
        status,
      });
    case 502:
    case 504:
      return createAppError('unavailable', `Gateway unreachable (HTTP ${status})${suffix}.`, {
        retryable: true,
        offline: isOfflineNow(),
        status,
      });
    case 503:
      return createAppError('busy', `Gateway busy (HTTP 503)${suffix}. Try again shortly.`, {
        retryable: true,
        status,
      });
    default:
      if (status >= 500) {
        return createAppError('unavailable', `Gateway error (HTTP ${status})${suffix}.`, {
          retryable: true,
          offline: isOfflineNow(),
          status,
        });
      }
      return createAppError('unknown', `Request failed (HTTP ${status})${suffix}.`, {
        retryable: false,
        status,
      });
  }
}

// Map a free text gateway failure to the closest user facing code (ERR-02).
export function mapMessageToCode(message: string): AppErrorCode {
  const m = message.toLowerCase();
  if (
    m.includes('approval') ||
    m.includes('needs review') ||
    m.includes('denied by approver') ||
    m.includes('forbidden action')
  ) {
    return 'approval';
  }
  if (
    m.includes('too large') ||
    m.includes('too_large') ||
    m.includes('payload too large') ||
    m.includes('request entity too large') ||
    m.includes('context length') ||
    m.includes('context window') ||
    m.includes('max tokens') ||
    m.includes('maximum tokens')
  ) {
    return 'too-large';
  }
  if (
    m.includes('unknown model') ||
    m.includes('model not found') ||
    m.includes('unsupported model') ||
    m.includes('invalid model')
  ) {
    return 'model';
  }
  if (
    m.includes('provider') ||
    m.includes('api key') ||
    m.includes('apikey') ||
    m.includes('invalid key') ||
    m.includes('billing') ||
    m.includes('quota') ||
    m.includes('upstream')
  ) {
    return 'provider';
  }
  if (
    m.includes('overloaded') ||
    m.includes('try again later') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('server busy')
  ) {
    return 'busy';
  }
  if (
    m.includes('offline') ||
    m.includes('networkerror') ||
    m.includes('network error') ||
    m.includes('failed to fetch') ||
    m.includes('load failed') ||
    m.includes('econnrefused') ||
    m.includes('unreachable') ||
    m.includes('not reachable')
  ) {
    return 'unavailable';
  }
  return 'unknown';
}

const HTTP_STATUS_PATTERN = /http\s+(\d{3})/i;

function statusFromMessage(message: string): number | undefined {
  const match = HTTP_STATUS_PATTERN.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

// Normalize any thrown value to an AppError. Abort errors pass through
// untouched so callers can treat cancellation separately from failure.
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (isAbortError(err)) {
    const cancelled = createAppError('unknown', 'Request cancelled.', { retryable: false, cause: err });
    cancelled.messageKey = 'errCancelled';
    return cancelled;
  }
  if (err instanceof TypeError) {
    return createAppError('unavailable', `Gateway unreachable: ${sanitizeDetail(err.message)}`, {
      retryable: true,
      offline: isOfflineNow(),
      cause: err,
    });
  }
  if (err instanceof Error) {
    const status = statusFromMessage(err.message);
    if (status !== undefined) {
      const mapped = mapHttpStatus(status);
      mapped.cause = err;
      return mapped;
    }
    const code = mapMessageToCode(err.message);
    return createAppError(code, sanitizeDetail(err.message) || 'Gateway request failed.', {
      retryable: code === 'unavailable' || code === 'busy' || code === 'rate-limited',
      offline: code === 'unavailable' && isOfflineNow(),
      cause: err,
    });
  }
  return createAppError('unknown', typeof err === 'string' && err ? sanitizeDetail(err) : 'Gateway request failed.', {
    cause: err,
  });
}

// The message field is already user facing; this helper keeps call sites
// explicit about rendering errors instead of raw values. Prefer
// localizedMessage(err, lang) for translated UI.
export function userMessage(err: AppError): string {
  return err.message;
}
