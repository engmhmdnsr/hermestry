// Central error model for all gateway access (ERR-01 / ERR-02).
//
// Every gateway failure is represented as an AppError, never as a bare
// false / [] / null that callers could mistake for real data. Use
// toAppError() at catch boundaries and mapHttpStatus() for HTTP failures.

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
export function mapHttpStatus(status: number, detail = ''): AppError {
  const suffix = detail ? `: ${detail}` : '';
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
    return createAppError('unknown', 'Request cancelled.', { retryable: false, cause: err });
  }
  if (err instanceof TypeError) {
    return createAppError('unavailable', `Gateway unreachable: ${err.message}`, {
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
    return createAppError(code, err.message || 'Gateway request failed.', {
      retryable: code === 'unavailable' || code === 'busy' || code === 'rate-limited',
      offline: code === 'unavailable' && isOfflineNow(),
      cause: err,
    });
  }
  return createAppError('unknown', typeof err === 'string' && err ? err : 'Gateway request failed.', {
    cause: err,
  });
}

// The message field is already user facing; this helper keeps call sites
// explicit about rendering errors instead of raw values.
export function userMessage(err: AppError): string {
  return err.message;
}
