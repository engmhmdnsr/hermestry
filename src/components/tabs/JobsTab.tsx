import React, { useState, useMemo, useEffect } from 'react';
import {
  Play,
  Pause,
  Trash2,
  History,
  Plus,
  Search,
  Clock,
  Pencil,
  X,
  Square,
  ChevronDown,
  ChevronUp,
  MoreVertical,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { localizedMessage, toAppError } from '../../services/appErrors';
import { CronJob, CronRun } from '../../types/hermes';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import {
  COMMON_TIMEZONES,
  ServerFieldError,
  cronHint,
  formatDateTimeInTimezone,
  formatRunTimestamp,
  formatTimeWithZone,
  formatTimezoneOption,
  rejectionErrors,
  resolveDeviceTimezone,
  scheduleSummary,
} from '../../utils/jobTime';
import { resolveListUiState } from '../../services/pagination';

// Local display grace: a job a few minutes past its slot reads as due, not
// overdue. This is a client-side display choice only; the desktop gateway
// may mark overdue at the exact due time, so badges can differ by surface.
const OVERDUE_GRACE_MS = 5 * 60 * 1000;

// List sync envelope shape (subset) read out of context.listsMeta. Same
// shape the Home tab reads, so both screens interpret one envelope.
interface ListMetaLike {
  live?: boolean;
  stale?: boolean;
  error?: string;
  lastSyncedAt?: number | null;
}

type PendingAction = 'pause' | 'resume' | 'run' | 'delete' | 'stop';
type ToastTone = 'success' | 'error';

// Raw gateway failures arrive as free text ("Jobs unavailable: HTTP 401").
// Run them through the shared error model so user copy is a friendly
// cause + action string, never a status code or transport detail.
const friendlyGatewayError = (detail: string | undefined, lang: string): string => {
  const raw = (detail || '').trim() || 'gateway unreachable';
  return localizedMessage(toAppError(new Error(raw)), lang);
};

// A timezone id is data, not copy. The chip shows the place ("Riyadh"), the
// raw id stays in the title and in the technical disclosure.
const timezoneLabel = (tz: string): string => {
  const seg = (tz || '').split('/').pop() || '';
  return seg.replace(/_/g, ' ') || tz;
};

// One plain sentence per rejection scope. The raw field, code and server
// message are technical and stay behind the disclosure instead.
const REJECTION_KEYS: Record<'create' | 'update' | 'action', { key: string; fallback: string }> = {
  create: {
    key: 'taskCreateRejected',
    fallback: 'Hermes did not accept this task, so nothing was created. Try again, or change the timing.',
  },
  update: {
    key: 'taskUpdateRejected',
    fallback: 'Hermes did not accept the change, so nothing was updated.',
  },
  action: {
    key: 'taskActionRejected',
    fallback: 'Hermes did not accept that, so the task is unchanged.',
  },
};

// The create button renders a real Plus icon, so its label carries no leading
// "+" glyph. Every label on this screen is a plain translated word.

// Run status mapping. Success is an explicit allowlist: any status that is
// not on it must never render as a success badge, and unknown values stay
// neutral instead of borrowing the emerald tone. Running and queued are kept
// as separate tones so an in-flight run never looks like a waiting one.
type RunTone = 'success' | 'failure' | 'running' | 'queued' | 'inactive';

const RUN_SUCCESS_STATUSES = new Set([
  'success',
  'succeeded',
  'completed',
  'complete',
  'ok',
  'done',
  'finished',
]);
const RUN_FAILURE_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'errored',
  'timeout',
  'timed-out',
  'timed out',
]);
const RUN_RUNNING_STATUSES = new Set(['running', 'in_progress', 'in progress']);
const RUN_QUEUED_STATUSES = new Set(['pending', 'queued', 'starting']);
// Anything still in flight, used to offer Stop for the newest such run.
const RUN_ACTIVE_STATUSES = new Set([...RUN_RUNNING_STATUSES, ...RUN_QUEUED_STATUSES]);

const RUN_STATUS_KEYS: Record<string, { key: string; fallback: string }> = {
  success: { key: 'runStatusSuccess', fallback: 'Success' },
  succeeded: { key: 'runStatusSuccess', fallback: 'Success' },
  ok: { key: 'runStatusSuccess', fallback: 'Success' },
  completed: { key: 'runStatusCompleted', fallback: 'Completed' },
  complete: { key: 'runStatusCompleted', fallback: 'Completed' },
  done: { key: 'runStatusCompleted', fallback: 'Completed' },
  finished: { key: 'runStatusCompleted', fallback: 'Completed' },
  failed: { key: 'runStatusFailed', fallback: 'Failed' },
  failure: { key: 'runStatusFailed', fallback: 'Failed' },
  error: { key: 'runStatusFailed', fallback: 'Failed' },
  errored: { key: 'runStatusFailed', fallback: 'Failed' },
  delivery_failed: { key: 'runStatusFailed', fallback: 'Failed' },
  'delivery failed': { key: 'runStatusFailed', fallback: 'Failed' },
  timeout: { key: 'runStatusTimeout', fallback: 'Timed out' },
  'timed-out': { key: 'runStatusTimeout', fallback: 'Timed out' },
  'timed out': { key: 'runStatusTimeout', fallback: 'Timed out' },
  cancelled: { key: 'runStatusCancelled', fallback: 'Cancelled' },
  canceled: { key: 'runStatusCancelled', fallback: 'Cancelled' },
  aborted: { key: 'runStatusCancelled', fallback: 'Cancelled' },
  skipped: { key: 'runStatusSkipped', fallback: 'Skipped' },
  running: { key: 'runStatusRunning', fallback: 'Running' },
  'in_progress': { key: 'runStatusRunning', fallback: 'Running' },
  'in progress': { key: 'runStatusRunning', fallback: 'Running' },
  pending: { key: 'runStatusPending', fallback: 'Pending' },
  queued: { key: 'runStatusPending', fallback: 'Pending' },
  starting: { key: 'runStatusPending', fallback: 'Pending' },
};

// Vocabulary badge classes: one geometry for every status chip. Running is
// info and queued is warning, so an in-flight run is visually distinct from a
// waiting one; success and failure keep their semantic tones; any unknown or
// settled-without-verdict status is neutral (never green).
const RUN_TONE_CLASS: Record<RunTone, string> = {
  success: 'pill-success',
  failure: 'pill-danger',
  running: 'pill-info',
  queued: 'pill-warning',
  inactive: 'pill-neutral',
};

const runStatusInfo = (
  raw: string,
  translate: (key: string, fallback: string) => string
): { label: string; tone: RunTone } => {
  const status = (raw || '').trim().toLowerCase();
  const entry = RUN_STATUS_KEYS[status];
  const label = entry ? translate(entry.key, entry.fallback) : translate('runStatusUnknown', 'Unknown');
  const tone: RunTone = RUN_SUCCESS_STATUSES.has(status)
    ? 'success'
    : RUN_FAILURE_STATUSES.has(status)
      ? 'failure'
      : RUN_RUNNING_STATUSES.has(status)
        ? 'running'
        : RUN_QUEUED_STATUSES.has(status)
          ? 'queued'
          : 'inactive';
  return { label, tone };
};

const isRunActive = (run: CronRun): boolean =>
  RUN_ACTIVE_STATUSES.has((run.status || '').trim().toLowerCase());

const parseRunDate = (s: string): number => {
  if (!s) return NaN;
  const t = new Date(s).getTime();
  if (!Number.isNaN(t)) return t;
  return new Date(s.replace(' ', 'T')).getTime();
};

// Most recent in-flight run for a job, so Stop targets the run the history
// shows as running rather than an arbitrary row.
const latestActiveRun = (runs: CronRun[]): CronRun | undefined =>
  [...runs].sort((a, b) => parseRunDate(b.startedAt) - parseRunDate(a.startedAt)).find(isRunActive);

const formatDuration = (startedAt: string, finishedAt: string): string => {
  const a = parseRunDate(startedAt);
  const b = parseRunDate(finishedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '';
  const secs = Math.round((b - a) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
};

// Toasts live in a module store, not in component state: App.tsx unmounts this
// tab the moment another tab is picked, and an owner-scoped list died with it,
// so a "Task created" confirmation vanished if the user switched tabs inside
// the three seconds it was on screen. The timers belong to the store too, so
// nothing is left running against an unmounted component.
type JobsToast = { id: number; msg: string; tone: ToastTone };

let toastStore: JobsToast[] = [];
let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const toastListeners = new Set<(toasts: JobsToast[]) => void>();

const emitToasts = (): void => {
  const snapshot = [...toastStore];
  for (const listener of toastListeners) listener(snapshot);
};

const pushToast = (msg: string, tone: ToastTone = 'success'): void => {
  const id = ++toastSeq;
  toastStore = [...toastStore.slice(-2), { id, msg, tone }];
  emitToasts();
  // Failures need reading time: they carry a cause and a next step, so
  // they stay up longer than a confirmation.
  const timer = setTimeout(() => {
    toastTimers.delete(id);
    toastStore = toastStore.filter((toastItem) => toastItem.id !== id);
    emitToasts();
  }, tone === 'error' ? 7000 : 3000);
  toastTimers.set(id, timer);
};

// New listeners inherit whatever is still showing, so a tab that remounts
// mid-display keeps the notice instead of starting blank.
const subscribeToasts = (listener: (toasts: JobsToast[]) => void): (() => void) => {
  toastListeners.add(listener);
  listener([...toastStore]);
  return () => {
    toastListeners.delete(listener);
  };
};

export const JobsTab: React.FC = () => {
  const hermes = useHermes();
  const { jobs, createJob, jobAction, cronRuns, fetchRuns, refreshJobs, connected, listsMeta, t } =
    hermes;
  const updateJob = (hermes as unknown as {
    updateJob?: (id: string, patch: { name?: string; schedule?: string; prompt?: string }) => Promise<boolean>;
  }).updateJob;

  const deviceTz = useMemo(() => resolveDeviceTimezone(), []);
  const lang = hermes.settings?.language || 'en';

  // i18n with an English fallback for keys a locale bundle does not ship.
  // t() returns the key itself when nothing has it, so fallbacks stay honest
  // instead of rendering raw key names.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Create form state
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  // Single display timezone shared by the create form, the edit form, and
  // every job card. It is display-only: the gateway create/update API
  // carries no timezone field, so schedules run on gateway time and all
  // times on this screen are rendered in this zone.
  const [displayTz, setDisplayTz] = useState(deviceTz);
  // The display-only timezone explanation is long; keep it behind a
  // disclosure so the create card never reads as a wall of grey text.
  const [showTzNote, setShowTzNote] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createFieldErrors, setCreateFieldErrors] = useState<ServerFieldError[]>([]);
  const [createMissing, setCreateMissing] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  // Creation panel visibility. With tasks on screen the builder starts
  // collapsed so the list leads; see createCardNode for where each state renders.
  const [createOpen, setCreateOpen] = useState(false);
  // Stacked toasts so concurrent create/action/delete notices don't
  // overwrite each other (single-slot toasts lost all but the last). Tone is
  // carried per toast so a failure never renders in the success style. The
  // list itself lives in the module store above, so switching tabs (which
  // unmounts this component) no longer erases a notice in flight.
  const [toasts, setToasts] = useState<JobsToast[]>(() => [...toastStore]);
  useEffect(() => subscribeToasts(setToasts), []);

  // Edit form state (shares displayTz above; opening edit never resets it)
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [editName, setEditName] = useState('');
  const [editSchedule, setEditSchedule] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editError, setEditError] = useState('');
  const [editFieldErrors, setEditFieldErrors] = useState<ServerFieldError[]>([]);
  const [editMissing, setEditMissing] = useState<string[]>([]);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Jobs list sync state: distinguishes gateway error from a truly empty
  // list (jobs.length === 0 alone cannot tell them apart). The live/stale/
  // error verdict itself comes from the shared envelope below, so this
  // screen and Home can never describe the same rows differently.
  const [jobsLoading, setJobsLoading] = useState(() => !listsMeta['jobs']);

  // Search & history
  const [query, setQuery] = useState('');
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState<Record<string, boolean>>({});
  const [pendingDeleteJob, setPendingDeleteJob] = useState<CronJob | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  // Per-row action overflow. On a 360dp phone the old inline row of five
  // labelled actions clipped; the two common actions stay inline and the rest
  // live in a bottom sheet.
  const [menuJobId, setMenuJobId] = useState<string | null>(null);

  // JOB-04: optimistic overrides with rollback. Context jobs are the
  // source of truth; these layers apply instantly and roll back on failure.
  const [pendingOps, setPendingOps] = useState<Record<string, PendingAction>>({});
  const [optimisticEnabled, setOptimisticEnabled] = useState<Record<string, boolean>>({});
  const [hiddenIds, setHiddenIds] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState('');

  // The overflow sheet is an overlay: Escape and the Android back button
  // close it through the shared overlay stack, the same contract as every
  // other sheet in the app.
  const menuRef = useOverlayBehavior(Boolean(menuJobId), () => setMenuJobId(null));

  // The delete confirm and the edit form are overlays on the same contract:
  // Escape, the Android back button and a focus trap go through the shared
  // stack, so neither dialog can strand focus or ignore back navigation.
  const deleteDialogRef = useOverlayBehavior(Boolean(pendingDeleteJob), () =>
    setPendingDeleteJob(null)
  );
  const editDialogRef = useOverlayBehavior(Boolean(editingJob), () => setEditingJob(null));

  const presets = [
    // One-shot the gateway understands: 'once' is not a desktop schedule
    // (parse_schedule rejects it), relative 'in 30m' fires a single run.
    { label: tx('presetOnce', 'Run once'), val: 'in 30m' },
    { label: tx('presetDaily9', 'Daily at 9am'), val: 'every day 9am' },
    { label: tx('presetWeekdays9', 'Weekdays at 9am'), val: 'every weekday 9am' },
    { label: tx('presetHourly', 'Every hour'), val: 'every 1h' },
  ];

  const presetVals = presets.map((p) => p.val);

  // Client-side schedule hints are UX only. The gateway is authoritative.
  const createHint = cronHint(schedule, presetVals);
  const editHint = editingJob ? cronHint(editSchedule, presetVals) : null;
  const createSummary = scheduleSummary(schedule);
  const editSummary = editingJob ? scheduleSummary(editSchedule) : null;

  // The client hint is one plain sentence, never a lecture about a format.
  const scheduleHintText = tx(
    'scheduleFormatHint',
    'That timing is not one of the presets. Tap a preset above, or write a pattern like 0 9 * * * for 9am daily.'
  );

  // scheduleSummary falls back to developer wording for an unknown pattern
  // ("Cron expression. The gateway decides..."). Never show that on screen.
  const plainSummary = (summary: string | null): string | null => {
    if (!summary) return null;
    return /cron|gateway/i.test(summary)
      ? tx('customTiming', 'Custom timing. Hermes runs it on the pattern you gave.')
      : summary;
  };

  // Times are shown in the picked zone, so swap the raw id for its place name.
  const friendlyTime = (value: string): string =>
    displayTz && value.includes(displayTz)
      ? value.split(displayTz).join(timezoneLabel(displayTz))
      : value;

  const timezoneOptions = useMemo(() => {
    if (COMMON_TIMEZONES.includes(deviceTz)) return COMMON_TIMEZONES;
    return [deviceTz, ...COMMON_TIMEZONES];
  }, [deviceTz]);

  const showToast = (msg: string, tone: ToastTone = 'success') => {
    pushToast(msg, tone);
  };

  // Jobs list truthfulness: the same context envelope the Home tab reads,
  // resolved with the shared helper. The rows rendered here are context
  // rows, so their liveness has to come from the same source: a private
  // fetch could report "not confirmed" here while Home reports the very
  // same list as live (or the reverse).
  const jobMeta: ListMetaLike | undefined = listsMeta['jobs'];
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const jobsListState = resolveListUiState(
    {
      live: jobMeta ? jobMeta.live === true : connected,
      stale: jobMeta ? jobMeta.stale === true : !connected && jobs.length > 0,
      error:
        jobMeta?.error ||
        (!connected ? tx('notReachable', 'Hermes is not reachable.') : undefined),
    },
    jobs.length,
    { offline: browserOffline || !connected }
  );
  const jobsCountKnown =
    jobsListState === 'live' || jobsListState === 'empty' || jobsListState === 'refreshing';
  const jobsStale = jobMeta?.stale === true;
  // Transport detail for the disclosures only; never the sentence on the card.
  // Only a real envelope error qualifies: a list that is merely mid-refresh
  // has no cause to disclose, and inventing one would claim a failure.
  const jobsError = jobMeta?.error ? friendlyGatewayError(jobMeta.error, lang) : '';
  // Never synced at all, or still fetching a first list, counts as loading
  // rather than a failure.
  const jobsPanelState: 'loading' | 'stale' | 'error' | null =
    jobsLoading && jobs.length === 0
      ? 'loading'
      : jobsCountKnown
        ? null
        : !jobMeta
          ? 'loading'
          : jobsListState === 'stale' || jobsListState === 'offline'
            ? 'stale'
            : 'error';

  useEffect(() => {
    // The context publishes the envelope on load and on every reconnect, but a
    // list read while the tab was closed can still be stale: ask for a fresh one
    // on mount so runs that finished in the background show up.
    let cancelled = false;
    setJobsLoading(true);
    refreshJobs()
      .catch(() => {
        // refreshJobs writes the failure envelope itself.
      })
      .finally(() => {
        if (!cancelled) setJobsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetryJobs = async () => {
    setJobsLoading(true);
    try {
      await refreshJobs();
    } catch {
      // refreshJobs reports failure through the list state above.
    } finally {
      setJobsLoading(false);
    }
  };

  const missingFields = (vals: { name: string; schedule: string; prompt: string }): string[] => {
    const missing: string[] = [];
    if (!vals.name.trim()) missing.push('name');
    if (!vals.schedule.trim()) missing.push('schedule');
    if (!vals.prompt.trim()) missing.push('prompt');
    return missing;
  };

  const handleCreate = async () => {
    const missing = missingFields({ name, schedule, prompt });
    setCreateMissing(missing);
    if (missing.length > 0) {
      setCreateError(tx('taskFormIncomplete', 'Fill in the missing fields below.'));
      setCreateFieldErrors([]);
      return;
    }
    // NOTE: no client-side blocking on schedule shape. The gateway decides.
    setCreateError('');
    setCreateFieldErrors([]);
    setIsCreating(true);
    // Honest label: createJob carries no timezone field, so the selected
    // zone only controls how times render on this screen.
    const ok = await createJob(name.trim(), schedule.trim(), prompt.trim());
    setIsCreating(false);

    if (ok) {
      setName('');
      setSchedule('');
      setPrompt('');
      setCreateMissing([]);
      // The new row lands at the top of the list above, so fold the form away.
      setCreateOpen(false);
      await handleRetryJobs();
      showToast(
        `${tx('taskCreated', 'Task scheduled.')} ${tx('timesShownIn', 'Times shown in')} ${timezoneLabel(displayTz)}.`
      );
    } else {
      const errs = rejectionErrors('create');
      setCreateFieldErrors(errs);
      setCreateError(tx(REJECTION_KEYS.create.key, REJECTION_KEYS.create.fallback));
    }
  };

  const openEdit = (j: CronJob) => {
    setEditingJob(j);
    setEditName(j.name);
    setEditSchedule(j.scheduleRaw || j.scheduleDisplay);
    setEditPrompt(j.prompt);
    // displayTz is shared and deliberately left untouched here.
    setEditError('');
    setEditFieldErrors([]);
    setEditMissing([]);
  };

  const handleSaveEdit = async () => {
    if (!editingJob) return;
    const missing = missingFields({ name: editName, schedule: editSchedule, prompt: editPrompt });
    setEditMissing(missing);
    if (missing.length > 0) {
      setEditError(tx('taskFormIncomplete', 'Fill in the missing fields below.'));
      return;
    }
    if (typeof updateJob !== 'function') {
      setEditError(
        tx('editingUnsupported', 'This version cannot edit a task. Delete it and create a new one.')
      );
      return;
    }
    setEditError('');
    setEditFieldErrors([]);
    setIsSavingEdit(true);
    const ok = await updateJob(editingJob.id, {
      name: editName.trim(),
      schedule: editSchedule.trim(),
      prompt: editPrompt.trim(),
    });
    setIsSavingEdit(false);
    if (ok) {
      setEditingJob(null);
      setEditMissing([]);
      showToast(
        `${tx('taskUpdated', 'Task updated.')} ${tx('timesShownIn', 'Times shown in')} ${timezoneLabel(displayTz)}.`
      );
    } else {
      const errs = rejectionErrors('update');
      setEditFieldErrors(errs);
      setEditError(tx(REJECTION_KEYS.update.key, REJECTION_KEYS.update.fallback));
    }
  };

  // JOB-04: optimistic pause/resume/run with rollback on gateway failure.
  const handleTogglePause = async (j: CronJob) => {
    const action: PendingAction = j.enabled ? 'pause' : 'resume';
    setActionError('');
    setPendingOps((p) => ({ ...p, [j.id]: action }));
    setOptimisticEnabled((p) => ({ ...p, [j.id]: !j.enabled }));
    const ok = await jobAction(j.id, action);
    setPendingOps((p) => {
      const next = { ...p };
      delete next[j.id];
      return next;
    });
    if (ok) {
      setOptimisticEnabled((p) => {
        const next = { ...p };
        delete next[j.id];
        return next;
      });
      showToast(action === 'pause' ? tx('taskPaused', 'Task paused.') : tx('taskResumed', 'Task resumed.'));
    } else {
      setOptimisticEnabled((p) => {
        const next = { ...p };
        delete next[j.id];
        return next;
      });
      setActionError(tx(REJECTION_KEYS.action.key, REJECTION_KEYS.action.fallback));
      const verb =
        action === 'pause'
          ? tx('jobPauseFailed', 'Could not pause')
          : tx('jobResumeFailed', 'Could not resume');
      showToast(
        `${verb} "${j.name}". ${tx('nothingChanged', 'Nothing changed, so the task was left as it was.')} ${tx('tryAgainShort', 'Try again.')}`,
        'error'
      );
    }
  };

  const handleRunNow = async (j: CronJob) => {
    setActionError('');
    setPendingOps((p) => ({ ...p, [j.id]: 'run' }));
    const ok = await jobAction(j.id, 'run');
    setPendingOps((p) => {
      const next = { ...p };
      delete next[j.id];
      return next;
    });
    if (ok) {
      // Open history on the job and refresh it so the triggered run
      // becomes visible instead of leaving the user with a bare toast.
      setHistoryForId(j.id);
      await handleRetryRuns(j.id);
      showToast(
        `${tx('runStarted', 'Run started for')} "${j.name}". ${tx('historyOpenBelow', 'Run history is open below.')}`
      );
    } else {
      setActionError(tx(REJECTION_KEYS.action.key, REJECTION_KEYS.action.fallback));
      showToast(
        `${tx('jobRunFailed', 'Could not start')} "${j.name}". ${tx('nothingChanged', 'Nothing changed, so the task was left as it was.')} ${tx('tryAgainShort', 'Try again.')}`,
        'error'
      );
    }
  };

  // Stop an in-flight run through the gateway stop endpoint. The gateway only
  // acknowledges the request, so the toast says "requested" and the run
  // history refresh reports the real outcome.
  const handleStopRun = async (j: CronJob, runId: string) => {
    setActionError('');
    setPendingOps((p) => ({ ...p, [j.id]: 'stop' }));
    const ok = await hermes.service.stopRun(runId);
    setPendingOps((p) => {
      const next = { ...p };
      delete next[j.id];
      return next;
    });
    if (ok) {
      showToast(
        `${tx('runStopRequested', 'Stop requested for')} "${j.name}". ${tx('runStopRefreshing', 'Refreshing the run history to confirm.')}`
      );
      setHistoryForId(j.id);
      await handleRetryRuns(j.id);
      // Post-stop refresh goes through context like every other job action,
      // so a future envelope change covers Stop too instead of silently
      // skipping the one action that reached past context to the service.
      void refreshJobs();
    } else {
      setActionError(tx(REJECTION_KEYS.action.key, REJECTION_KEYS.action.fallback));
      showToast(
        `${tx('jobStopFailed', 'Could not stop')} "${j.name}". ${tx('nothingChanged', 'Nothing changed, so the task was left as it was.')} ${tx('tryAgainShort', 'Try again.')}`,
        'error'
      );
    }
  };

  // JOB-04: optimistic delete. Card hides at once, restores on failure.
  const handleDeleteConfirm = async (j: CronJob) => {
    setActionError('');
    setPendingOps((p) => ({ ...p, [j.id]: 'delete' }));
    setHiddenIds((p) => ({ ...p, [j.id]: true }));
    setPendingDeleteJob(null);
    if (historyForId === j.id) setHistoryForId(null);
    const ok = await jobAction(j.id, 'delete');
    setPendingOps((p) => {
      const next = { ...p };
      delete next[j.id];
      return next;
    });
    if (ok) {
      showToast(tx('taskDeleted', 'Task deleted.'));
    } else {
      setHiddenIds((p) => {
        const next = { ...p };
        delete next[j.id];
        return next;
      });
      setActionError(tx(REJECTION_KEYS.action.key, REJECTION_KEYS.action.fallback));
      showToast(
        `${tx('jobDeleteFailed', 'Could not delete')} "${j.name}". ${tx('taskStillHere', 'The task is still here.')} ${tx('tryAgainShort', 'Try again.')}`,
        'error'
      );
    }
  };

  // Runs history: the context list carries the gateway live flag
  // (LiveList). A failed fetch stores an empty list with live === false,
  // so the UI must not mistake it for a job with zero runs.
  const handleRetryRuns = async (jobId: string) => {
    setRunsLoading((p) => ({ ...p, [jobId]: true }));
    try {
      await fetchRuns(jobId);
    } finally {
      setRunsLoading((p) => {
        const next = { ...p };
        delete next[jobId];
        return next;
      });
    }
  };

  // Live runs: while a history panel is open on a job with an in-flight
  // run, re-fetch every 15s so the status cannot go stale behind the panel.
  useEffect(() => {
    if (!historyForId || !connected) return;
    const id = historyForId;
    const tick = () => {
      const runs = cronRuns[id] || [];
      const live = runs.some((r) => RUN_ACTIVE_STATUSES.has(String((r as CronRun).status || '').trim().toLowerCase()));
      if (live) void fetchRuns(id);
    };
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, [historyForId, connected, cronRuns, fetchRuns]);

  const handleToggleHistory = async (j: CronJob) => {
    if (historyForId === j.id) {
      setHistoryForId(null);
      return;
    }
    setHistoryForId(j.id);
    await handleRetryRuns(j.id);
  };

  const isOverdue = (nextRunAt: string, enabled: boolean, state: string) => {
    const s = state.toLowerCase();
    // Terminal jobs never fire again: a stale past next_run_at on them is a
    // record, not a missed run. Grace stays a fixed 5 minutes client-side
    // (desktop computes it from the period; the period is not exposed here).
    if (!enabled || s === 'paused' || s === 'completed' || s === 'error') return false;
    if (!nextRunAt) return false;
    try {
      const target = new Date(nextRunAt).getTime();
      return target < Date.now() - OVERDUE_GRACE_MS;
    } catch {
      return false;
    }
  };

  // Apply optimistic layers over context truth, then filter hidden and query.
  const displayJobs = useMemo(() => {
    return jobs
      .filter((j) => !hiddenIds[j.id])
      .map((j) => {
        const override = optimisticEnabled[j.id];
        if (override === undefined) return j;
        return {
          ...j,
          enabled: override,
          state: override ? 'scheduled' : 'paused',
        };
      });
  }, [jobs, hiddenIds, optimisticEnabled]);

  const visibleJobs = useMemo(() => {
    if (!query.trim()) return displayJobs;
    const q = query.toLowerCase();
    return displayJobs.filter(
      (j) => j.name.toLowerCase().includes(q) || j.prompt.toLowerCase().includes(q)
    );
  }, [displayJobs, query]);

  // The job whose overflow sheet is open, plus its newest in-flight run (so
  // the sheet can offer Stop for the run the history is showing).
  const menuJob = menuJobId ? jobs.find((j) => j.id === menuJobId) ?? null : null;
  const menuActiveRun = menuJob ? latestActiveRun(cronRuns[menuJob.id] || []) : undefined;

  // Prefetch history when the sheet opens: without it Stop only appears for
  // jobs whose history was already fetched elsewhere (the emergency action
  // must not hide precisely when the user has not gone looking yet).
  useEffect(() => {
    if (menuJobId) {
      setHistoryForId(menuJobId);
      void handleRetryRuns(menuJobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuJobId]);

  const closeMenu = () => setMenuJobId(null);

  const fieldClass = (invalid: boolean) =>
    `w-full px-3 py-2 min-h-[44px] r-sm bg-[var(--app-input-bg)] t-body text-[var(--app-text)] focus:outline-none transition ${
      invalid ? 'border border-[var(--app-danger-border)]' : 'edge'
    }`;

  const presetChipClass =
    'hm-hit h-9 px-3 r-xs edge bg-[var(--app-card-subtle)] t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] transition cursor-pointer whitespace-nowrap';

  // Raw field path, error code and server text are technical, so they stay
  // behind a disclosure and never become the sentence on the surface.
  const renderFieldErrors = (errors: ServerFieldError[]) => {
    if (errors.length === 0) return null;
    return (
      <details className="r-sm">
        <summary className="cursor-pointer t-caption text-[var(--app-text-dim)]">
          {tx('technicalDetails', 'Technical details')}
        </summary>
        <div className="space-y-2 pt-2" role="alert">
          {errors.map((e, i) => (
            <p key={`${e.field}-${e.code}-${i}`} className="t-caption font-mono break-words text-[var(--app-text-muted)]">
              {e.field} [{e.code}] {e.message}
            </p>
          ))}
        </div>
      </details>
    );
  };

  // Creation entry point: built once and rendered in exactly one place. With
  // no tasks the builder sits above the list (the empty state points at "the
  // form above"); once rows exist the list leads and creation collapses behind
  // its own button, so statuses and next runs are what the screen opens on.
  const canCollapseCreate = jobs.length > 0;
  const createCardNode = (
    <div id="job-create-card" className="r-md edge elev-0 bg-[var(--app-card)] p-5 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="t-heading text-[var(--app-text)]">{tx('jobsCreateTitle', 'Schedule a task')}</h2>
          <p className="t-caption text-[var(--app-text-muted)] mt-1">
            {tx('jobsCreateDesc', 'Choose when it runs and write what Hermes should do each time.')}
          </p>
        </div>
        {canCollapseCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(false)}
            aria-label={tx('closeDialog', 'Close')}
            className="w-11 h-11 -me-2 -mt-2 shrink-0 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="job-name" className="block t-label text-[var(--app-text-muted)] mb-1">
            {tx('taskNameLabel', 'Task name')}
          </label>
          <input
            id="job-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={tx('taskNamePlaceholder', 'e.g. Morning briefing')}
            aria-invalid={createMissing.includes('name')}
            className={fieldClass(createMissing.includes('name'))}
          />
          {createMissing.includes('name') && (
            <p className="t-caption text-[var(--app-danger)] mt-1">
              {tx('taskNameRequired', 'Give this task a name.')}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="job-schedule" className="block t-label text-[var(--app-text-muted)] mb-1">
            {tx('jobScheduleLabel', 'When should it run')}
          </label>
          <input
            id="job-schedule"
            type="text"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder={tx('jobSchedulePlaceholder', 'e.g. every day 9am')}
            aria-invalid={createMissing.includes('schedule')}
            className={fieldClass(createMissing.includes('schedule'))}
          />
          {createMissing.includes('schedule') && (
            <p className="t-caption text-[var(--app-danger)] mt-1">
              {tx('jobScheduleRequired', 'Add a timing for this task.')}
            </p>
          )}
          {plainSummary(createSummary) && (
            <p className="t-caption text-[var(--app-text-muted)] mt-1">
              {plainSummary(createSummary)}
            </p>
          )}
          {createHint && (
            <p className="t-caption text-[var(--app-warning)] mt-1">{scheduleHintText}</p>
          )}
          {/* Quick presets: one scrollable rail of equal chips, so nothing
              wraps and leaves a lone chip orphaned on a second row. */}
          <div
            className="hm-rail gap-2 mt-2 -mx-1 px-1"
            role="group"
            aria-label={tx('quickPresets', 'Quick presets')}
          >
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setSchedule(p.val)}
                title={p.val === 'in 30m' ? tx('presetOnceNote', 'Runs one time, then stops.') : undefined}
                className={presetChipClass}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="job-tz" className="block t-label text-[var(--app-text-muted)] mb-1">
            {tx('displayTimezone', 'Timezone for times shown')}
          </label>
          <select
            id="job-tz"
            value={displayTz}
            onChange={(e) => setDisplayTz(e.target.value)}
            className="w-full px-3 py-2 min-h-[44px] r-sm edge bg-[var(--app-input-bg)] t-body text-[var(--app-text)] focus:outline-none transition"
          >
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {formatTimezoneOption(tz)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowTzNote((v) => !v)}
            aria-expanded={showTzNote}
            className="mt-1 inline-flex items-center gap-1 t-caption text-[var(--app-accent-text)] min-h-[40px] cursor-pointer"
          >
            {showTzNote ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            <span>{tx('timezoneNoteTitle', 'How times are shown')}</span>
          </button>
          {showTzNote && (
            <p className="t-caption text-[var(--app-text-dim)]">
              {tx(
                'timezoneNote',
                'This only changes how times look on this screen. The task keeps running on the time Hermes already uses.'
              )}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="job-prompt" className="block t-label text-[var(--app-text-muted)] mb-1">
            {tx('jobPromptLabel', 'What should it do')}
          </label>
          <textarea
            id="job-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={tx(
              'jobPromptPlaceholder',
              'Write the message or instruction Hermes gets each time it runs.'
            )}
            aria-invalid={createMissing.includes('prompt')}
            className={`${fieldClass(createMissing.includes('prompt'))} resize-none`}
          />
          {createMissing.includes('prompt') && (
            <p className="t-caption text-[var(--app-danger)] mt-1">
              {tx('jobPromptRequired', 'Write what Hermes should do.')}
            </p>
          )}
        </div>
      </div>

      {createError && <p className="t-caption text-[var(--app-danger)]">{createError}</p>}
      {renderFieldErrors(createFieldErrors)}

      <button
        onClick={handleCreate}
        disabled={isCreating}
        className="w-full min-h-[48px] px-4 r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:opacity-50 text-[var(--app-on-accent)] t-body font-semibold transition cursor-pointer flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        <span>{isCreating ? tx('creating', 'Scheduling…') : tx('jobsCreateTitle', 'Schedule a task')}</span>
      </button>
    </div>
  );

  return (
    <div className="space-y-6 max-w-2xl md:max-w-4xl mx-auto px-4 md:px-6 pt-4 hm-tab-bottom">
      {/* Toast stack: overlays sit at elev-3, never a raw shadow. */}
      {toasts.length > 0 && (
        <div className="fixed top-[calc(4rem+env(safe-area-inset-top,0px))] start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] space-y-2 w-max max-w-[calc(100vw-2rem)]">
          {toasts.map((toastItem) => (
            <div
              key={toastItem.id}
              role={toastItem.tone === 'error' ? 'alert' : 'status'}
              aria-live={toastItem.tone === 'error' ? 'assertive' : 'polite'}
              className={`px-4 py-2 r-sm elev-3 t-caption font-semibold text-center break-words ${
                toastItem.tone === 'error'
                  ? 'bg-[var(--app-danger-solid)] text-[var(--app-on-danger)]'
                  : 'bg-[var(--app-accent)] text-[var(--app-on-accent)]'
              }`}
            >
              {toastItem.msg}
            </div>
          ))}
        </div>
      )}

      {/* First run has no list to lead with, and the empty state points at
          "the form above", so the builder stays above it until a task exists. */}
      {jobs.length === 0 && createCardNode}

      {/* 2. Search & filter bar */}
      {jobs.length > 0 && (
        <div>
          <div className="relative">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-[var(--app-text-dim)] pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('search')}
              aria-label={t('search')}
              className="w-full ps-10 pe-12 py-2 min-h-[44px] r-sm edge bg-[var(--app-card)] t-body text-[var(--app-text)] focus:outline-none transition"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={tx('clearSearch', 'Clear the search')}
                className="absolute end-0 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {query.trim() && (
            <p className="t-caption text-[var(--app-text-dim)] mt-2" role="status">
              {visibleJobs.length} {tx('ofWord', 'of')} {jobs.length}{' '}
              {jobs.length === 1 ? tx('taskMatches', 'task matches') : tx('tasksMatch', 'tasks match')}
            </p>
          )}
        </div>
      )}

      {/* Action-level rollback notice */}
      {actionError && (
        <div
          className="p-3 r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] t-caption text-[var(--app-danger)] flex items-start justify-between gap-3"
          role="alert"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError('')}
            className="text-[var(--app-danger)] cursor-pointer w-11 h-11 flex items-center justify-center r-sm shrink-0"
            aria-label={tx('dismissNotice', 'Dismiss this notice')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 3. Schedules list */}
      <div className="space-y-3">
        <h3 className="t-micro text-[var(--app-text-dim)]">
          {/* Count is only meaningful for a live list: a failed load must not
              print a fabricated (0) next to an "unavailable" message. */}
          {tx('scheduledTasksHeading', 'Scheduled tasks')}
          {jobsCountKnown
            ? ` (${visibleJobs.length} ${
                visibleJobs.length === 1 ? tx('taskWord', 'task') : tx('tasksWord', 'tasks')
              })`
            : ''}
        </h3>

        {/* Not live with rows on screen: the list is a cached snapshot. The
            transport detail stays behind the disclosure. */}
        {jobsPanelState === 'stale' && (
          <div
            role="status"
            className="p-3 r-md bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] space-y-1"
          >
            <p className="t-label text-[var(--app-warning)]">
              {jobsStale
                ? tx('tasksStaleTitle', 'Showing saved tasks')
                : tx('tasksNotLiveTitle', 'Showing saved tasks, not confirmed')}
            </p>
            <details className="r-sm">
              <summary className="cursor-pointer t-caption text-[var(--app-warning)] opacity-80">
                {tx('technicalDetails', 'Technical details')}
              </summary>
              <p className="t-caption font-mono break-words text-[var(--app-warning)] opacity-80">
                {jobsError}
              </p>
            </details>
          </div>
        )}

        {jobsPanelState === 'loading' ? (
          <div
            className="p-6 r-md edge elev-0 bg-[var(--app-card)] text-center t-caption text-[var(--app-text-muted)]"
            role="status"
          >
            {tx('jobsLoading', 'Loading your tasks…')}
          </div>
        ) : jobsPanelState === 'error' ? (
          <div
            className="p-6 r-md bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] text-center space-y-3"
            role="alert"
          >
            <p className="t-heading text-[var(--app-text)]">
              {tx('tasksUnavailableTitle', 'Could not load your scheduled tasks')}
            </p>
            <p className="t-caption text-[var(--app-text-muted)]">
              {tx('tasksUnavailableBody', 'Nothing was lost. Refresh to try again.')}
            </p>
            {/404|not found|no route/i.test(jobsError) && (
              <p className="t-caption text-[var(--app-text-muted)]">
                {tx('jobsDesktopOnlyPlain', 'Scheduled tasks live on the desktop gateway. This server does not have them.')}
              </p>
            )}
            {jobsError && (
              <details className="r-sm text-start">
                <summary className="cursor-pointer t-caption text-[var(--app-text-dim)]">
                  {tx('technicalDetails', 'Technical details')}
                </summary>
                <p className="t-caption font-mono break-words text-[var(--app-text-muted)]">{jobsError}</p>
              </details>
            )}
            <button
              type="button"
              onClick={() => void handleRetryJobs()}
              disabled={jobsLoading}
              className="px-4 min-h-[44px] r-sm bg-[var(--app-danger-solid)] disabled:opacity-50 text-[var(--app-on-danger)] t-caption font-semibold cursor-pointer transition"
            >
              {jobsLoading ? tx('retrying', 'Retrying…') : tx('retry', 'Retry')}
            </button>
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-6 r-md edge elev-0 bg-[var(--app-card)] text-center space-y-2">
            <p className="t-heading text-[var(--app-text)]">
              {tx('jobsEmptyTitle', 'No scheduled tasks yet')}
            </p>
            <p className="t-caption text-[var(--app-text-muted)]">
              {tx('jobsEmptyBody', 'Fill in the form above to create your first task. It runs on the timing you choose.')}
            </p>
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="p-6 r-md edge elev-0 bg-[var(--app-card)] text-center t-caption text-[var(--app-text-muted)]">
            {tx('jobsNoMatch', 'No tasks match that search.')}
          </div>
        ) : (
          visibleJobs.map((j) => {
            const overdue = isOverdue(j.nextRunAt, j.enabled, j.state);
            const isFailed =
              j.lastStatus.toLowerCase() === 'failed' ||
              j.lastStatus.toLowerCase() === 'error' ||
              j.lastStatus.toLowerCase() === 'delivery_failed' ||
              Boolean(j.lastError);
            const isHistoryOpen = historyForId === j.id;
            const runsRaw = cronRuns[j.id];
            const runs = runsRaw || [];
            const runsLive = (runsRaw as unknown as { live?: boolean } | undefined)?.live;
            const isRunsLoading = Boolean(runsLoading[j.id]);
            const runsFetchFailed = runsRaw !== undefined && runsLive === false;
            const pending = pendingOps[j.id];
            const nextRunLabel = j.nextRunAt
              ? formatTimeWithZone(j.nextRunAt, displayTz)
              : '';
            const nextRunFull = j.nextRunAt
              ? formatDateTimeInTimezone(j.nextRunAt, displayTz, lang)
              : '';

            return (
              <div
                key={j.id}
                className={`r-md edge elev-0 bg-[var(--app-card)] p-4 space-y-3 transition ${pending ? 'opacity-70' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="t-heading text-[var(--app-text)] truncate">
                        {j.name}
                      </h4>
                      {overdue && <span className="pill-danger">{tx('overdue', 'Overdue')}</span>}
                      {pending && (
                        <span className="pill-warning">{tx('pendingWord', 'Pending')}…</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span
                        className="t-caption text-[var(--app-text-muted)]"
                        title={j.scheduleDisplay}
                      >
                        {plainSummary(scheduleSummary(j.scheduleDisplay)) ||
                          tx('customSchedule', 'Custom schedule')}
                      </span>
                      <span className="pill-neutral" title={displayTz}>
                        {timezoneLabel(displayTz)}
                      </span>
                    </div>
                  </div>

                  {/* Job state badge. Enabled uses the accent tone (never the
                      success tone a run chip uses); Paused is neutral: Off is
                      always neutral. */}
                  <span
                    aria-label={`${j.name}: ${j.enabled ? t('enabled') : tx('paused', 'Paused')}`}
                    className={j.enabled ? 'pill-accent' : 'pill-neutral'}
                  >
                    {j.enabled ? t('enabled') : tx('paused', 'Paused')}
                  </span>
                </div>

                {j.nextRunAt && (
                  <div
                    className="flex items-center gap-2 t-caption text-[var(--app-text-muted)] font-mono"
                    title={nextRunFull}
                  >
                    <Clock className="w-3.5 h-3.5 text-[var(--app-text-dim)]" />
                    <span>{tx('nextRunPlain', 'Next run')}: {friendlyTime(nextRunLabel)}</span>
                  </div>
                )}

                {isFailed && (
                  <div className="p-3 r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] t-caption text-[var(--app-danger)] space-y-1">
                    <p>{tx('lastRunFailedLine', 'The last run failed.')}</p>
                    {j.lastError && (
                      <details className="r-sm">
                        <summary className="cursor-pointer opacity-80">
                          {tx('technicalDetails', 'Technical details')}
                        </summary>
                        <p className="font-mono break-words opacity-80">{j.lastError}</p>
                      </details>
                    )}
                  </div>
                )}

                {/* Selectable prompt text with a separate expand toggle so
                    selection/copy is never hijacked by a button wrapper. */}
                <div className="t-body text-[var(--app-text-muted)] bg-[var(--app-card-subtle)] r-sm hairline">
                  <p
                    title={j.prompt}
                    className={`px-3 pt-3 font-mono leading-relaxed select-text ${expandedPrompts[j.id] ? 'whitespace-pre-wrap break-words' : 'line-clamp-6'}`}
                  >
                    {j.prompt}
                  </p>
                  <button
                    type="button"
                    onClick={() => setExpandedPrompts((prev) => ({ ...prev, [j.id]: !prev[j.id] }))}
                    aria-expanded={!!expandedPrompts[j.id]}
                    aria-label={
                      expandedPrompts[j.id]
                        ? `${tx('collapsePrompt', 'Collapse')}: ${j.name}`
                        : `${tx('expandPrompt', 'Expand')}: ${j.name}`
                    }
                    className="w-full min-h-[44px] px-3 flex items-center gap-2 t-caption text-[var(--app-text-dim)] hover:text-[var(--app-text)] transition cursor-pointer"
                  >
                    {expandedPrompts[j.id] ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    <span>{expandedPrompts[j.id] ? tx('showLess', 'Show less') : tx('showMore', 'Show more')}</span>
                  </button>
                </div>

                {/* Job action controls: the two common actions stay inline and
                    the rest move into the overflow sheet so nothing clips at
                    360dp. */}
                <div className="flex items-center justify-between gap-2 pt-3 border-t border-[var(--app-border-subtle)]">
                  <div className="flex items-center gap-2 min-w-0">
                    {j.enabled ? (
                      <button
                        onClick={() => handleTogglePause(j)}
                        disabled={Boolean(pending)}
                        className="h-11 px-3 r-sm inline-flex items-center gap-2 t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] disabled:opacity-50 cursor-pointer transition whitespace-nowrap"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>{pending === 'pause' ? tx('pausing', 'Pausing…') : tx('pause', 'Pause')}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleTogglePause(j)}
                        disabled={Boolean(pending)}
                        className="h-11 px-3 r-sm inline-flex items-center gap-2 t-caption text-[var(--app-accent-text)] hover:bg-[var(--app-card-hover)] disabled:opacity-50 cursor-pointer transition whitespace-nowrap"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>{pending === 'resume' ? tx('resuming', 'Resuming…') : tx('resume', 'Resume')}</span>
                      </button>
                    )}

                    <button
                      onClick={() => handleRunNow(j)}
                      disabled={Boolean(pending)}
                      className="h-11 px-3 r-sm inline-flex items-center gap-2 t-caption font-semibold text-[var(--app-accent-text)] hover:bg-[var(--app-card-hover)] disabled:opacity-50 cursor-pointer transition whitespace-nowrap"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>{pending === 'run' ? `${tx('runningPlain', 'Running')}…` : tx('runNowPlain', 'Run now')}</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setMenuJobId(j.id)}
                    disabled={Boolean(pending)}
                    aria-haspopup="dialog"
                    aria-label={`${tx('jobActionsMore', 'More actions')} ${j.name}`}
                    className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] disabled:opacity-50 cursor-pointer transition shrink-0"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </div>

                {/* Run history expansion */}
                {isHistoryOpen && (
                  <div className="mt-3 pt-3 border-t border-[var(--app-border-subtle)] space-y-2 animate-in fade-in duration-150">
                    <span
                      className="t-label text-[var(--app-text)] block"
                      aria-label={`${tx('runHistoryPlain', 'Run history')}: ${runs.length}`}
                    >
                      {tx('runHistoryPlain', 'Run history')}{runs.length > 0 ? ` (${runs.length})` : ''}
                    </span>
                    {isRunsLoading && runsRaw === undefined ? (
                      <p className="t-caption text-[var(--app-text-dim)]" role="status">
                        {tx('runsLoading', 'Loading run history…')}
                      </p>
                    ) : runsFetchFailed && runs.length === 0 ? (
                      <div
                        className="p-3 r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] space-y-2"
                        role="alert"
                      >
                        <p className="t-caption text-[var(--app-danger)]">
                          {tx('runsUnavailable', 'Could not load run history. Nothing was lost.')}
                        </p>
                        <button
                          type="button"
                          onClick={() => handleRetryRuns(j.id)}
                          disabled={isRunsLoading}
                          className="px-3 min-h-[44px] r-sm bg-[var(--app-card-subtle)] edge t-caption text-[var(--app-text)] disabled:opacity-50 cursor-pointer transition"
                        >
                          {isRunsLoading ? tx('retrying', 'Retrying…') : tx('retry', 'Retry')}
                        </button>
                      </div>
                    ) : runs.length === 0 ? (
                      <p className="t-caption text-[var(--app-text-dim)]">
                        {tx('runsEmpty', 'No runs yet for this task.')}
                      </p>
                    ) : (
                      <>
                        {runs.length > 10 && (
                          <p className="t-caption text-[var(--app-text-dim)]">
                            {tx('runsShowingRecent', 'Showing the 10 most recent runs.')} ({runs.length})
                          </p>
                        )}
                        {[...runs]
                          .sort((a, b) => parseRunDate(b.startedAt) - parseRunDate(a.startedAt))
                          .slice(0, 10)
                          .map((r, i) => {
                            const duration = formatDuration(r.startedAt, r.finishedAt);
                            const startedLabel = r.startedAt ? formatRunTimestamp(r.startedAt, displayTz) : '';
                            const endedLabel = r.finishedAt ? formatRunTimestamp(r.finishedAt, displayTz) : '';
                            // Explicit allowlist: known success values read as
                            // success, everything else is neutral or failing.
                            const runInfo = runStatusInfo(r.status, tx);
                            const badgeClass = RUN_TONE_CLASS[runInfo.tone];
                            return (
                              <div key={r.id || i} className="p-3 r-sm bg-[var(--app-card-subtle)] hairline space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span
                                    className={badgeClass}
                                    aria-label={`${tx('runStatusLabel', 'Run status')}: ${runInfo.label}`}
                                  >
                                    {runInfo.label}
                                  </span>
                                  <span
                                    className="t-caption text-[var(--app-text-dim)] font-mono"
                                    title={r.startedAt}
                                  >
                                    {friendlyTime(startedLabel)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 t-caption text-[var(--app-text-dim)] font-mono">
                                  {endedLabel && (
                                    <span>{tx('endedWord', 'Ended')} {friendlyTime(endedLabel)}</span>
                                  )}
                                  {duration && <span>· {duration}</span>}
                                </div>
                                {r.error && (
                                  <details className="r-sm">
                                    <summary className="cursor-pointer t-caption text-[var(--app-danger)]">
                                      {tx('runFailedLine', 'This run reported an error.')}
                                    </summary>
                                    <p className="t-caption font-mono text-[var(--app-danger)] whitespace-pre-wrap break-words">
                                      {r.error}
                                    </p>
                                  </details>
                                )}
                              </div>
                            );
                          })}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* With rows on screen the list leads. Creation sits behind a single
          button so statuses and next runs stay above the fold. */}
      {jobs.length > 0 &&
        (createOpen ? (
          createCardNode
        ) : (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            aria-expanded={false}
            className="w-full min-h-[48px] px-4 r-md edge elev-0 bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] text-[var(--app-accent-text)] t-body font-semibold flex items-center justify-center gap-2 cursor-pointer transition"
          >
            <Plus className="w-4 h-4" />
            <span>{tx('jobsCreateTitle', 'Schedule a task')}</span>
            <ChevronDown className="w-4 h-4" />
          </button>
        ))}

      {/* Per-row action overflow sheet. Bottom sheet so every item is a full
          48px target and the destructive action is set off on its own. */}
      {menuJob && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-[var(--app-scrim)] animate-in fade-in duration-150"
          onClick={closeMenu}
        >
          <div
            ref={menuRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${tx('jobActionsMore', 'More actions')}: ${menuJob.name}`}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md r-lg elev-3 edge bg-[var(--app-card)] p-3 space-y-1 pb-[calc(12px+var(--safe-bottom))]"
          >
            <div className="px-3 pt-1 pb-2 border-b border-[var(--app-border-subtle)]">
              <p className="t-label text-[var(--app-text)] truncate">{menuJob.name}</p>
              <p
                className="t-caption text-[var(--app-text-dim)] truncate mt-1"
                title={`${menuJob.scheduleDisplay} · ${displayTz}`}
              >
                {plainSummary(scheduleSummary(menuJob.scheduleDisplay)) ||
                  tx('customSchedule', 'Custom schedule')}{' '}
                · {timezoneLabel(displayTz)}
              </p>
            </div>

            <button
              onClick={() => {
                const target = menuJob;
                closeMenu();
                openEdit(target);
              }}
              className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-body text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition-colors"
            >
              <Pencil className="w-4 h-4 text-[var(--app-text-muted)] shrink-0" />
              <span>{t('edit')}</span>
            </button>

            <button
              onClick={() => {
                const target = menuJob;
                closeMenu();
                void handleToggleHistory(target);
              }}
              className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-body text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition-colors"
            >
              <History className="w-4 h-4 text-[var(--app-text-muted)] shrink-0" />
              <span>
                {historyForId === menuJob.id
                  ? tx('closeRunsHistory', 'Close run history')
                  : tx('runHistoryPlain', 'Run history')}
              </span>
            </button>

            {menuActiveRun && (
              <button
                onClick={() => {
                  const target = menuJob;
                  const run = menuActiveRun;
                  closeMenu();
                  void handleStopRun(target, run.id);
                }}
                className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-body text-[var(--app-warning)] hover:bg-[var(--app-card-hover)] cursor-pointer transition-colors"
              >
                <Square className="w-4 h-4 shrink-0" />
                <span>{tx('stopRun', 'Stop run')}</span>
              </button>
            )}

            {/* Destructive action, set off by a rule and never adjacent to a
                primary action. */}
            <div className="pt-1 mt-1 border-t border-[var(--app-border-subtle)]">
              <button
                onClick={() => {
                  const target = menuJob;
                  closeMenu();
                  setPendingDeleteJob(target);
                }}
                className="w-full min-h-[48px] px-3 r-sm flex items-center gap-3 text-start t-body font-semibold text-[var(--app-danger)] hover:bg-[var(--app-danger-subtle)] cursor-pointer transition-colors"
              >
                <Trash2 className="w-4 h-4 shrink-0" />
                <span>{t('delete')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {pendingDeleteJob && (
        <div
          ref={deleteDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${tx('deleteTaskTitle', 'Delete this task')}: ${pendingDeleteJob.name}`}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-[var(--app-scrim)] animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDeleteJob(null);
          }}
        >
          <div
            className="w-full max-w-sm r-lg elev-3 edge bg-[var(--app-card)] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="t-heading text-[var(--app-text)]">
              {tx('deleteTaskTitle', 'Delete this task')}
            </h3>
            <p className="t-body text-[var(--app-text-muted)]">
              {tx('deleteTaskBody', 'This removes the task for good, so it cannot be undone.')}{' '}
              &ldquo;{pendingDeleteJob.name}&rdquo;
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setPendingDeleteJob(null)}
                className="px-4 min-h-[44px] r-sm t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition"
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => handleDeleteConfirm(pendingDeleteJob)}
                className="px-4 min-h-[44px] r-sm bg-[var(--app-danger-solid)] hover:opacity-90 text-[var(--app-on-danger)] t-caption font-semibold cursor-pointer transition"
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingJob && (
        <div
          ref={editDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editingJob.name}`}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-[var(--app-scrim)] animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingJob(null);
          }}
        >
          <div
            className="w-full max-w-sm r-lg elev-3 edge bg-[var(--app-card)] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-[var(--app-border-subtle)]">
              <span className="t-heading text-[var(--app-text)]">
                {tx('editTaskTitle', 'Edit task')}
              </span>
              <button
                onClick={() => setEditingJob(null)}
                aria-label={tx('closeDialog', 'Close')}
                className="w-11 h-11 r-sm flex items-center justify-center text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="edit-name" className="block t-label text-[var(--app-text-muted)] mb-1">
                  {tx('taskNameLabel', 'Task name')}
                </label>
                <input
                  id="edit-name"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  aria-invalid={editMissing.includes('name')}
                  className={fieldClass(editMissing.includes('name'))}
                />
                {editMissing.includes('name') && (
                  <p className="t-caption text-[var(--app-danger)] mt-1">
                    {tx('taskNameRequired', 'Give this task a name.')}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="edit-schedule" className="block t-label text-[var(--app-text-muted)] mb-1">
                  {tx('jobScheduleLabel', 'When should it run')}
                </label>
                <input
                  id="edit-schedule"
                  type="text"
                  value={editSchedule}
                  onChange={(e) => setEditSchedule(e.target.value)}
                  placeholder={tx('jobSchedulePlaceholder', 'e.g. every day 9am')}
                  aria-invalid={editMissing.includes('schedule')}
                  className={fieldClass(editMissing.includes('schedule'))}
                />
                {editMissing.includes('schedule') && (
                  <p className="t-caption text-[var(--app-danger)] mt-1">
                    {tx('jobScheduleRequired', 'Add a timing for this task.')}
                  </p>
                )}
                {plainSummary(editSummary) && (
                  <p className="t-caption text-[var(--app-text-muted)] mt-1">
                    {plainSummary(editSummary)}
                  </p>
                )}
                {editHint && (
                  <p className="t-caption text-[var(--app-warning)] mt-1">{scheduleHintText}</p>
                )}
                <div
                  className="hm-rail gap-2 mt-2 -mx-1 px-1"
                  role="group"
                  aria-label={tx('quickPresets', 'Quick presets')}
                >
                  {presets.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setEditSchedule(p.val)}
                      title={p.val === 'in 30m' ? tx('presetOnceNote', 'Runs one time, then stops.') : undefined}
                      className={presetChipClass}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="edit-tz" className="block t-label text-[var(--app-text-muted)] mb-1">
                  {tx('displayTimezone', 'Timezone for times shown')}
                </label>
                <select
                  id="edit-tz"
                  value={displayTz}
                  onChange={(e) => setDisplayTz(e.target.value)}
                  className="w-full px-3 py-2 min-h-[44px] r-sm edge bg-[var(--app-input-bg)] t-body text-[var(--app-text)] focus:outline-none transition"
                >
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {formatTimezoneOption(tz)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="edit-prompt" className="block t-label text-[var(--app-text-muted)] mb-1">
                  {tx('jobPromptLabel', 'What should it do')}
                </label>
                <textarea
                  id="edit-prompt"
                  rows={3}
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  aria-invalid={editMissing.includes('prompt')}
                  className={`${fieldClass(editMissing.includes('prompt'))} resize-none`}
                />
                {editMissing.includes('prompt') && (
                  <p className="t-caption text-[var(--app-danger)] mt-1">
                    {tx('jobPromptRequired', 'Write what Hermes should do.')}
                  </p>
                )}
              </div>
            </div>

            {editError && <p className="t-caption text-[var(--app-danger)]">{editError}</p>}
            {renderFieldErrors(editFieldErrors)}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditingJob(null)}
                className="px-4 min-h-[44px] r-sm t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit}
                className="px-4 min-h-[44px] r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] disabled:opacity-50 text-[var(--app-on-accent)] t-caption font-semibold cursor-pointer transition"
              >
                {isSavingEdit ? tx('saving', 'Saving…') : tx('saveShort', 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
