// Centralized retry policy for gateway access (ERR-03).
//
// Rules: retry only failures marked retryable by the error model, back off
// exponentially with jitter, cap attempts, honor abort, and never auto-retry
// a non-idempotent operation unless the caller explicitly opts in.

import { AppError, isAbortError, isAppError, toAppError } from './appErrors';

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_IDEMPOTENT_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitterRatio: 0.25,
};

export interface WithRetryOptions extends Partial<RetryPolicy> {
  signal?: AbortSignal;
  // True for safe reads (GET-style). False for writes, mutations and
  // streams: with idempotent=false only one attempt runs unless
  // allowNonIdempotentRetry is set explicitly.
  idempotent: boolean;
  allowNonIdempotentRetry?: boolean;
  retryableStatuses?: ReadonlySet<number>;
  shouldRetry?: (err: AppError, attempt: number) => boolean;
  onRetry?: (err: AppError, attempt: number, delayMs: number) => void;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}

export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  const grown = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(grown, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function statusAllowsRetry(err: AppError, retryableStatuses: ReadonlySet<number>): boolean {
  if (err.status === undefined) return true;
  if (retryableStatuses.has(err.status)) return true;
  if (err.status === 0) return true;
  return false;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions
): Promise<T> {
  const policy: RetryPolicy = {
    maxAttempts: opts.maxAttempts ?? DEFAULT_IDEMPOTENT_POLICY.maxAttempts,
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_IDEMPOTENT_POLICY.baseDelayMs,
    maxDelayMs: opts.maxDelayMs ?? DEFAULT_IDEMPOTENT_POLICY.maxDelayMs,
    jitterRatio: opts.jitterRatio ?? DEFAULT_IDEMPOTENT_POLICY.jitterRatio,
  };
  const retryableStatuses = opts.retryableStatuses ?? RETRYABLE_STATUSES;
  const maxAttempts =
    opts.idempotent || opts.allowNonIdempotentRetry ? Math.max(1, policy.maxAttempts) : 1;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    throwIfAborted(opts.signal);
    try {
      return await fn(attempt);
    } catch (raw) {
      throwIfAborted(opts.signal);
      if (isAbortError(raw)) throw raw;
      if (!isAppError(raw) && isAbortError((raw as { cause?: unknown })?.cause)) throw raw;
      const err = isAppError(raw) ? raw : toAppError(raw);
      const retriesLeft = attempt < maxAttempts;
      const customOk = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (!retriesLeft || !err.retryable || !statusAllowsRetry(err, retryableStatuses) || !customOk) {
        throw err;
      }
      const delayMs = computeBackoffMs(attempt, policy);
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs, opts.signal);
    }
  }
}
