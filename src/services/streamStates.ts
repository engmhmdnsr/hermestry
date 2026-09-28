// Stream lifecycle states for chat turns.
//
// CHAT-02: a partial failure must never leave a completed-looking message.
// Every assistant turn carries an explicit StreamTurnState, and any turn
// that ends without a terminal completion event is marked partial.
// CHAT-03: stop distinguishes transport abort from backend cancel.
// CHAT-04: retry defaults to resume/recover, never blind replay.

// Terminal lifecycle of one assistant turn.
export type StreamStatus =
  | 'idle'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed';

// How a stop ended. Transport abort (local AbortController) and backend
// cancel (POST /v1/runs/{id}/stop) are independent and reported separately.
export type StopReason =
  | 'none'
  | 'user-transport-abort'
  | 'backend-cancel-confirmed'
  | 'backend-cancel-failed'
  | 'gateway-closed';

// Retry strategy. resume continues the same run, recover starts a clean
// continuation turn that reuses committed context, replay re-sends the
// original user message (may re-execute side-effecting tools).
export type RetryMode = 'resume' | 'recover' | 'replay';

// Default retry. Never replay side effects unless the user explicitly
// confirms it.
export const DEFAULT_RETRY_MODE: RetryMode = 'resume';

export interface StreamTurnState {
  status: StreamStatus;
  // True when the turn ended with content that is incomplete: no terminal
  // completion event arrived, or the transport failed mid-stream.
  partial: boolean;
  // Non-empty only for failed turns. Displayed separately from content;
  // never appended into the message body as "Stream error: ...".
  error: string;
  runId: string | null;
  stopReason: StopReason;
  // True only when POST /v1/runs/{id}/stop returned ok.
  backendStopConfirmed: boolean;
  startedAt: number;
  finishedAt: number | null;
}

export function initialTurnState(): StreamTurnState {
  return {
    status: 'idle',
    partial: false,
    error: '',
    runId: null,
    stopReason: 'none',
    backendStopConfirmed: false,
    startedAt: 0,
    finishedAt: null,
  };
}

export function beginTurn(runId: string | null = null, now: number = Date.now()): StreamTurnState {
  return {
    status: 'streaming',
    partial: false,
    error: '',
    runId,
    stopReason: 'none',
    backendStopConfirmed: false,
    startedAt: now,
    finishedAt: null,
  };
}

function finish(status: StreamStatus, turn: StreamTurnState, now: number): StreamTurnState {
  return { ...turn, status, finishedAt: now };
}

// Terminal completion event arrived. Clears any partial flag.
export function completeTurn(turn: StreamTurnState, now: number = Date.now()): StreamTurnState {
  return { ...finish('completed', turn, now), partial: false, error: '' };
}

// Transport aborted locally (AbortController). Partial when content exists
// but no completion event arrived. Backend confirmation is recorded
// separately via confirmBackendStop.
export function cancelTurn(
  turn: StreamTurnState,
  opts: { hadContent: boolean; completedEventSeen: boolean; now?: number } = {
    hadContent: false,
    completedEventSeen: false,
  }
): StreamTurnState {
  const now = opts.now ?? Date.now();
  return {
    ...finish('cancelled', turn, now),
    partial: opts.hadContent && !opts.completedEventSeen,
    stopReason: 'user-transport-abort',
  };
}

// Transport failed or gateway closed the stream without a completion event.
// Always partial when any content was produced; failed even when empty.
export function failTurn(
  turn: StreamTurnState,
  error: string,
  opts: { hadContent: boolean; completedEventSeen: boolean; now?: number } = {
    hadContent: false,
    completedEventSeen: false,
  }
): StreamTurnState {
  const now = opts.now ?? Date.now();
  return {
    ...finish('failed', turn, now),
    partial: opts.hadContent && !opts.completedEventSeen,
    error: error || 'the gateway closed the stream unexpectedly',
    stopReason: 'gateway-closed',
  };
}

// Record the POST /v1/runs/{id}/stop outcome on a cancelled turn.
export function confirmBackendStop(turn: StreamTurnState, confirmed: boolean): StreamTurnState {
  return {
    ...turn,
    backendStopConfirmed: confirmed,
    stopReason: confirmed ? 'backend-cancel-confirmed' : 'backend-cancel-failed',
  };
}

export function isTerminalStreamStatus(status: StreamStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

// UI needs Retry/Continue affordances: failed turns, or cancelled turns
// that left partial content.
export function needsRetryUi(turn: StreamTurnState): boolean {
  if (turn.status === 'failed') return true;
  if (turn.status === 'cancelled' && turn.partial) return true;
  return false;
}

// Partial badge: turn ended but content may be incomplete.
export function showsPartialBadge(turn: StreamTurnState): boolean {
  return turn.partial && (turn.status === 'failed' || turn.status === 'cancelled');
}

// Resolve the retry strategy. Defaults to resume. Replay (re-sending the
// user message, which may re-execute side-effecting tools) requires both
// an explicit request and explicit user confirmation when the failed turn
// ran tools.
export function resolveRetryMode(
  requested: RetryMode | undefined,
  opts: { toolsRan: boolean; userConfirmedReplay: boolean } = { toolsRan: false, userConfirmedReplay: false }
): RetryMode {
  if (!requested || requested === DEFAULT_RETRY_MODE) return DEFAULT_RETRY_MODE;
  if (requested === 'replay') {
    if (opts.toolsRan && !opts.userConfirmedReplay) return 'recover';
    return 'replay';
  }
  return requested;
}

// Outcome of the two-phase stop: local transport abort plus backend
// cancel confirmation.
export interface StopOutcome {
  transportAborted: boolean;
  backendConfirm: 'confirmed' | 'failed' | 'skipped' | 'no-run';
  runId: string | null;
}

export function emptyStopOutcome(): StopOutcome {
  return { transportAborted: false, backendConfirm: 'no-run', runId: null };
}

// Human label for the stop state while the backend confirm is pending.
export function stopProgressLabel(outcome: StopOutcome): string {
  if (outcome.backendConfirm === 'no-run' || outcome.backendConfirm === 'skipped') return 'Stopped';
  if (outcome.backendConfirm === 'confirmed') return 'Stopped (backend cancel confirmed)';
  if (outcome.backendConfirm === 'failed') return 'Stopped locally (backend cancel failed)';
  return 'Stopping (confirming backend cancel)';
}
