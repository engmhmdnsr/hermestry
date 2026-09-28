import React, { useState, useMemo, useRef, useEffect } from 'react';
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
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { localizedMessage, toAppError } from '../../services/appErrors';
import { CronJob, CronRun } from '../../types/hermes';
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

const OVERDUE_GRACE_MS = 5 * 60 * 1000;

type PendingAction = 'pause' | 'resume' | 'run' | 'delete' | 'stop';
type ToastTone = 'success' | 'error';

// Raw gateway failures arrive as free text ("Jobs unavailable: HTTP 401").
// Run them through the shared error model so user copy is a friendly
// cause + action string, never a status code or transport detail.
const friendlyGatewayError = (detail: string | undefined, lang: string): string => {
  const raw = (detail || '').trim() || 'gateway unreachable';
  return localizedMessage(toAppError(new Error(raw)), lang);
};

// Run status mapping. Success is an explicit allowlist: any status that is
// not on it must never render as a success badge, and unknown values stay
// neutral instead of borrowing the emerald tone.
type RunTone = 'success' | 'failure' | 'active' | 'neutral';

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
const RUN_ACTIVE_STATUSES = new Set([
  'running',
  'pending',
  'queued',
  'starting',
  'in_progress',
  'in progress',
]);

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

const RUN_TONE_CLASS: Record<RunTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  failure: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  active: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  neutral: 'bg-white/[0.04] text-slate-300 border-white/[0.08]',
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
      : RUN_ACTIVE_STATUSES.has(status)
        ? 'active'
        : 'neutral';
  return { label, tone };
};

const isRunActive = (run: CronRun): boolean =>
  RUN_ACTIVE_STATUSES.has((run.status || '').trim().toLowerCase());

// Most recent in-flight run for a job, so Stop targets the run the history
// shows as running rather than an arbitrary row.
const latestActiveRun = (runs: CronRun[]): CronRun | undefined =>
  [...runs]
    .sort((a, b) => parseRunDate(b.startedAt) - parseRunDate(a.startedAt))
    .find(isRunActive);

const parseRunDate = (s: string): number => {
  if (!s) return NaN;
  const t = new Date(s).getTime();
  if (!Number.isNaN(t)) return t;
  return new Date(s.replace(' ', 'T')).getTime();
};

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

const renderFieldErrors = (errors: ServerFieldError[]) => {
  if (errors.length === 0) return null;
  return (
    <div className="space-y-1.5" role="alert">
      {errors.map((e, i) => (
        <p key={`${e.field}-${e.code}-${i}`} className="text-xs text-rose-400">
          <span className="font-semibold">{e.field}</span>
          <span className="text-rose-400/70"> [{e.code}] </span>
          {e.message}
        </p>
      ))}
    </div>
  );
};

export const JobsTab: React.FC = () => {
  const hermes = useHermes();
  const { jobs, createJob, jobAction, cronRuns, fetchRuns, refreshJobs, t } = hermes;
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
  const [createError, setCreateError] = useState('');
  const [createFieldErrors, setCreateFieldErrors] = useState<ServerFieldError[]>([]);
  const [createMissing, setCreateMissing] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  // Stacked toasts so concurrent create/action/delete notices don't
  // overwrite each other (single-slot toasts lost all but the last). Tone is
  // carried per toast so a failure never renders in the success style.
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: ToastTone }[]>([]);

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
  // list (jobs.length === 0 alone cannot tell them apart). jobsLive tracks
  // the envelope's live flag so cached rows are never presented as current.
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsLive, setJobsLive] = useState(false);
  const [jobsStale, setJobsStale] = useState(false);
  const [jobsError, setJobsError] = useState('');

  // Search & history
  const [query, setQuery] = useState('');
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState<Record<string, boolean>>({});
  const [pendingDeleteJob, setPendingDeleteJob] = useState<CronJob | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const toastTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastId = useRef(0);

  // JOB-04: optimistic overrides with rollback. Context jobs are the
  // source of truth; these layers apply instantly and roll back on failure.
  const [pendingOps, setPendingOps] = useState<Record<string, PendingAction>>({});
  const [optimisticEnabled, setOptimisticEnabled] = useState<Record<string, boolean>>({});
  const [hiddenIds, setHiddenIds] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    const timeouts = toastTimeouts.current;
    return () => {
      for (const id of timeouts) clearTimeout(id);
    };
  }, []);

  const presets = [
    { label: 'Run Once', val: 'once' },
    { label: 'Daily at 9am', val: 'every day 9am' },
    { label: 'Weekdays at 9am', val: 'every weekday 9am' },
    { label: 'Every 1 Hour', val: 'every 1h' },
  ];

  const presetVals = presets.map((p) => p.val);

  // Client-side schedule hints are UX only. The gateway is authoritative.
  const createHint = cronHint(schedule, presetVals);
  const editHint = editingJob ? cronHint(editSchedule, presetVals) : null;
  const createSummary = scheduleSummary(schedule);
  const editSummary = editingJob ? scheduleSummary(editSchedule) : null;

  const timezoneOptions = useMemo(() => {
    if (COMMON_TIMEZONES.includes(deviceTz)) return COMMON_TIMEZONES;
    return [deviceTz, ...COMMON_TIMEZONES];
  }, [deviceTz]);

  const showToast = (msg: string, tone: ToastTone = 'success') => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, msg, tone }]);
    // Failures need reading time: they carry a cause and a next step, so
    // they stay up longer than a confirmation.
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((toastItem) => toastItem.id !== id));
    }, tone === 'error' ? 7000 : 3000);
    toastTimeouts.current.push(timer);
  };

  // Jobs list truthfulness: a live envelope check on mount. The envelope's
  // live flag decides everything: a non-live result (cached rows or a bare
  // failure) must surface as not live regardless of how many items it holds.
  const applyJobsEnvelope = (live: boolean, stale: boolean, error: string | undefined) => {
    setJobsLive(live);
    setJobsStale(Boolean(live) ? false : stale);
    setJobsError(live ? '' : friendlyGatewayError(error, lang));
  };

  useEffect(() => {
    let cancelled = false;
    setJobsLoading(true);
    (async () => {
      try {
        const res = await hermes.service.jobsWithState();
        if (cancelled) return;
        applyJobsEnvelope(res.live, res.stale, res.error);
      } catch (e) {
        if (cancelled) return;
        applyJobsEnvelope(false, false, e instanceof Error ? e.message : '');
      } finally {
        if (!cancelled) setJobsLoading(false);
      }
    })();
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
      // refreshJobs reports failure through the list state below.
    }
    try {
      const res = await hermes.service.jobsWithState();
      applyJobsEnvelope(res.live, res.stale, res.error);
    } catch (e) {
      applyJobsEnvelope(false, false, e instanceof Error ? e.message : '');
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
      setCreateError('Please fill in the missing fields below.');
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
      await handleRetryJobs();
      showToast(`Job created. Times shown in ${displayTz}.`);
    } else {
      const errs = rejectionErrors('create');
      setCreateFieldErrors(errs);
      setCreateError(errs[0].message);
    }
  };

  const openEdit = (j: CronJob) => {
    setEditingJob(j);
    setEditName(j.name);
    setEditSchedule(j.scheduleDisplay);
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
      setEditError('Please fill in the missing fields below.');
      return;
    }
    if (typeof updateJob !== 'function') {
      setEditError('Editing is not supported by this gateway version.');
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
      showToast(`Job updated. Times shown in ${displayTz}.`);
    } else {
      const errs = rejectionErrors('update');
      setEditFieldErrors(errs);
      setEditError(errs[0].message);
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
      showToast(action === 'pause' ? 'Job paused' : 'Job resumed');
    } else {
      setOptimisticEnabled((p) => {
        const next = { ...p };
        delete next[j.id];
        return next;
      });
      const errs = rejectionErrors('action');
      setActionError(errs[0].message);
      const verb =
        action === 'pause'
          ? tx('jobPauseFailed', 'Could not pause')
          : tx('jobResumeFailed', 'Could not resume');
      showToast(
        `${verb} "${j.name}". ${tx('jobUnchanged', 'The gateway did not accept it, so the job was left unchanged.')} ${tx('retryOrCheckGateway', 'Try again, or check the gateway status.')}`,
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
      showToast(`Run triggered for "${j.name}". History opened below.`);
    } else {
      const errs = rejectionErrors('action');
      setActionError(errs[0].message);
      showToast(
        `${tx('jobRunFailed', 'Could not start')} "${j.name}". ${tx('jobUnchanged', 'The gateway did not accept it, so the job was left unchanged.')} ${tx('retryOrCheckGateway', 'Try again, or check the gateway status.')}`,
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
    } else {
      const errs = rejectionErrors('action');
      setActionError(errs[0].message);
      showToast(
        `${tx('jobStopFailed', 'Could not stop')} "${j.name}". ${errs[0].message} ${tx('retryOrCheckGateway', 'Try again, or check the gateway status.')}`,
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
      showToast('Job deleted');
    } else {
      setHiddenIds((p) => {
        const next = { ...p };
        delete next[j.id];
        return next;
      });
      const errs = rejectionErrors('action');
      setActionError(errs[0].message);
      showToast(
        `${tx('jobDeleteFailed', 'Could not delete')} "${j.name}". ${tx('jobRestored', 'The job was restored.')} ${tx('retryOrCheckGateway', 'Try again, or check the gateway status.')}`,
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

  const handleToggleHistory = async (j: CronJob) => {
    if (historyForId === j.id) {
      setHistoryForId(null);
      return;
    }
    setHistoryForId(j.id);
    await handleRetryRuns(j.id);
  };

  const isOverdue = (nextRunAt: string, enabled: boolean, state: string) => {
    if (!enabled || state.toLowerCase() === 'paused') return false;
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
          state: override ? 'active' : 'paused',
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

  return (
    <div className="space-y-6 max-w-2xl mx-auto px-4 pt-4 pb-20">
      {/* Toast stack */}
      {toasts.length > 0 && (
        <div className="fixed top-16 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] space-y-2 w-max max-w-[calc(100vw-2rem)]">
          {toasts.map((toastItem) => (
            <div
              key={toastItem.id}
              role={toastItem.tone === 'error' ? 'alert' : 'status'}
              aria-live={toastItem.tone === 'error' ? 'assertive' : 'polite'}
              className={`px-4 py-2 rounded-xl text-white text-xs font-semibold shadow-2xl animate-in fade-in slide-in-from-top-2 text-center ${
                toastItem.tone === 'error'
                  ? 'bg-rose-600 border border-rose-400/50'
                  : 'bg-indigo-600'
              }`}
            >
              {toastItem.msg}
            </div>
          ))}
        </div>
      )}
      {/* 1. New Automation Schedule Builder Card */}
      <div className="rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] p-5 space-y-4 shadow-xs">
        <div>
          <h2 className="text-sm font-semibold text-white tracking-tight">{t('scheduledJobsTitle')}</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {t('scheduledJobsDesc')}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-400 font-medium mb-1">
              {t('jobName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning Briefing"
              aria-invalid={createMissing.includes('name')}
              className={`w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition ${createMissing.includes('name') ? 'border-rose-500/60' : 'border-white/[0.08]'}`}
            />
            {createMissing.includes('name') && (
              <p className="text-[11px] text-rose-400 mt-1">Job title is required.</p>
            )}
          </div>

          <div>
            <label className="block text-xs text-slate-400 font-medium mb-1">
              {t('cronSchedule')}
            </label>
            <input
              type="text"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="e.g. every 1h, every day 9am, or 0 9 * * *"
              aria-invalid={createMissing.includes('schedule')}
              className={`w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition ${createMissing.includes('schedule') ? 'border-rose-500/60' : 'border-white/[0.08]'}`}
            />
            {createMissing.includes('schedule') && (
              <p className="text-[11px] text-rose-400 mt-1">Schedule is required.</p>
            )}
            {createSummary && (
              <p className="text-[11px] text-slate-400 mt-1">
                {createSummary}{' '}
                <span className="text-slate-500">Local reading only; the gateway decides.</span>
              </p>
            )}
            {createHint && (
              <p className="text-[11px] text-amber-300/90 mt-1">
                Hint: {createHint}
              </p>
            )}
            {/* Quick Presets */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setSchedule(p.val)}
                  title={p.val === 'once' ? 'Runs a single time, then stops' : p.val}
                  className="px-2.5 py-1 min-h-[44px] rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-slate-300 hover:text-white transition cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 font-medium mb-1">
              Display timezone
            </label>
            <select
              value={displayTz}
              onChange={(e) => setDisplayTz(e.target.value)}
              className="w-full px-3.5 py-2 min-h-[44px] rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition"
            >
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {formatTimezoneOption(tz)}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-500 mt-1">
              Display only: the gateway stores no timezone and runs schedules on gateway time.
              Next-run and history times below render in {displayTz}.
            </p>
          </div>

          <div>
            <label className="block text-xs text-slate-400 font-medium mb-1">
              {t('instructions')}
            </label>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Task instructions to execute at each scheduled interval..."
              aria-invalid={createMissing.includes('prompt')}
              className={`w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition resize-none ${createMissing.includes('prompt') ? 'border-rose-500/60' : 'border-white/[0.08]'}`}
            />
            {createMissing.includes('prompt') && (
              <p className="text-[11px] text-rose-400 mt-1">Execution prompt is required.</p>
            )}
          </div>
        </div>

        {createError && (
          <p className="text-xs text-rose-400">{createError}</p>
        )}
        {renderFieldErrors(createFieldErrors)}

        <button
          onClick={handleCreate}
          disabled={isCreating}
          className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" />
          <span>{isCreating ? 'Creating...' : t('newJob')}</span>
        </button>
      </div>

      {/* 2. Search & Filter Bar */}
      {jobs.length > 0 && (
        <div>
          <div className="relative">
            <Search className="w-4 h-4 absolute start-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('search')}
              aria-label={t('search')}
              className="w-full ps-10 pe-12 py-2 min-h-[44px] rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear job search"
                className="absolute end-1 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-slate-500 hover:text-white transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {query.trim() && (
            <p className="text-[11px] text-slate-500 mt-1.5" role="status">
              {visibleJobs.length} of {jobs.length} jobs match
            </p>
          )}
        </div>
      )}

      {/* Action-level rollback notice */}
      {actionError && (
        <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-start justify-between gap-3" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError('')}
            className="text-rose-300/70 hover:text-rose-200 cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg"
            aria-label="Dismiss action error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 3. Schedules List */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
          {/* Count is only meaningful for a live list: a failed load must not
              print a fabricated (0) next to an "unavailable" message. */}
          {t('scheduledJobsTitle')}
          {jobsLive ? ` (${visibleJobs.length})` : ''}
        </h3>

        {/* Not live with rows on screen: the list is a cached snapshot. */}
        {!jobsLive && !jobsLoading && jobs.length > 0 && (
          <div
            role="status"
            className="px-3.5 py-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 space-y-1"
          >
            <p className="font-semibold">
              {jobsStale
                ? tx('jobsStaleTitle', 'Not live: showing saved jobs')
                : tx('jobsNotLiveTitle', 'Not live: the gateway did not confirm this list')}
            </p>
            <p className="text-amber-200/80">{jobsError}</p>
          </div>
        )}

        {jobsLoading && jobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center text-xs text-slate-400" role="status">
            Loading scheduled jobs...
          </div>
        ) : !jobsLive && jobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--app-card,#0E1217)] border border-rose-500/20 text-center text-xs text-rose-300 space-y-3" role="alert">
            <p className="font-medium text-white">
              {tx('jobsUnavailableTitle', 'Could not load scheduled jobs')}
            </p>
            <p className="text-slate-400">
              {jobsError || tx('jobsUnavailableBody', 'The gateway is unreachable. Make sure it is running, then try again.')}
            </p>
            <button
              type="button"
              onClick={() => void handleRetryJobs()}
              disabled={jobsLoading}
              className="px-4 min-h-[44px] py-2 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 disabled:opacity-50 text-rose-200 font-semibold cursor-pointer transition"
            >
              {jobsLoading ? 'Retrying...' : tx('retry', 'Retry')}
            </button>
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center text-xs text-slate-400">
            No scheduled automation jobs configured. Create your first job above using standard cadence or cron expressions.
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center text-xs text-slate-400">
            {`No tasks match "${query}".`}
          </div>
        ) : (
          visibleJobs.map((j) => {
            const overdue = isOverdue(j.nextRunAt, j.enabled, j.state);
            const isFailed =
              j.lastStatus.toLowerCase() === 'failed' ||
              j.lastStatus.toLowerCase() === 'error' ||
              Boolean(j.lastError);
            const isHistoryOpen = historyForId === j.id;
            const runsRaw = cronRuns[j.id];
            const runs = runsRaw || [];
            const runsLive = (runsRaw as unknown as { live?: boolean } | undefined)?.live;
            const isRunsLoading = Boolean(runsLoading[j.id]);
            const runsFetchFailed = runsRaw !== undefined && runsLive === false;
            const pending = pendingOps[j.id];
            // In-flight run for this job, so Stop can be offered for it.
            const activeRun = latestActiveRun(runs);
            const nextRunLabel = j.nextRunAt
              ? formatTimeWithZone(j.nextRunAt, displayTz)
              : '';
            const nextRunFull = j.nextRunAt
              ? formatDateTimeInTimezone(j.nextRunAt, displayTz, lang)
              : '';

            return (
              <div
                key={j.id}
                className={`rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.07] p-4 space-y-3 transition hover:border-white/[0.14] ${pending ? 'opacity-70' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-white truncate">
                        {j.name}
                      </h4>
                      {overdue && (
                        <span className="px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-300 border border-rose-500/20 text-[10px] font-medium">
                          Overdue
                        </span>
                      )}
                      {pending && (
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[10px] font-medium">
                          Pending...
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
                      <span>{j.scheduleDisplay}</span>
                      <span className="px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[10px] font-mono text-slate-300">
                        {displayTz}
                      </span>
                    </div>
                  </div>

                  <span
                    aria-label={`${j.name}: ${j.enabled ? t('enabled') : tx('paused', 'Paused')}`}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      j.enabled
                        ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                        : 'bg-white/[0.04] text-slate-400 border border-white/[0.06]'
                    }`}
                  >
                    {j.enabled ? t('enabled') : tx('paused', 'Paused')}
                  </span>
                </div>

                {j.nextRunAt && (
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono" title={nextRunFull}>
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                    <span>{t('nextRun')}: {nextRunLabel}</span>
                  </div>
                )}

                {isFailed && (
                  <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                    {j.lastError || 'Last execution encountered an exception'}
                  </div>
                )}

                {/* Selectable prompt text with a separate expand toggle so
                    selection/copy is never hijacked by a button wrapper. */}
                <div className="text-xs text-slate-300 bg-[var(--app-card-subtle,#141920)] rounded-xl border border-white/[0.06]">
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
                    aria-label={expandedPrompts[j.id] ? `Collapse prompt for ${j.name}` : `Expand prompt for ${j.name}`}
                    className="w-full min-h-[44px] px-3 flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-200 transition cursor-pointer"
                  >
                    {expandedPrompts[j.id] ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    <span>{expandedPrompts[j.id] ? 'Show less' : 'Show more'}</span>
                  </button>
                </div>

                {/* Job Action Controls */}
                <div className="flex items-center justify-between pt-2 border-t border-white/[0.06] text-xs">
                  <div className="flex items-center gap-3">
                    {j.enabled ? (
                      <button
                        onClick={() => handleTogglePause(j)}
                        disabled={Boolean(pending)}
                        className="text-slate-400 hover:text-white disabled:opacity-50 cursor-pointer flex items-center gap-1.5 transition min-h-[44px]"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>{pending === 'pause' ? 'Pausing...' : 'Pause'}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleTogglePause(j)}
                        disabled={Boolean(pending)}
                        className="text-indigo-400 hover:text-indigo-300 disabled:opacity-50 cursor-pointer flex items-center gap-1.5 transition min-h-[44px]"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>{pending === 'resume' ? 'Resuming...' : 'Resume'}</span>
                      </button>
                    )}

                    <button
                      onClick={() => handleRunNow(j)}
                      disabled={Boolean(pending)}
                      className="text-indigo-400 hover:text-indigo-300 disabled:opacity-50 cursor-pointer flex items-center gap-1.5 transition font-medium min-h-[44px]"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>{pending === 'run' ? `${t('running')}...` : t('runNow')}</span>
                    </button>

                    {/* Stop an in-flight run. Only offered while the run
                        history reports a run that has not settled. */}
                    {activeRun && (
                      <button
                        onClick={() => handleStopRun(j, activeRun.id)}
                        disabled={Boolean(pending)}
                        className="text-rose-300 hover:text-rose-200 disabled:opacity-50 cursor-pointer flex items-center gap-1.5 transition font-medium min-h-[44px]"
                        aria-label={`${tx('stopRun', 'Stop run')} ${j.name}`}
                      >
                        <Square className="w-3.5 h-3.5" />
                        <span>{pending === 'stop' ? tx('stopping', 'Stopping...') : tx('stopRun', 'Stop run')}</span>
                      </button>
                    )}

                    <button
                      onClick={() => openEdit(j)}
                      disabled={Boolean(pending)}
                      className="text-slate-400 hover:text-white disabled:opacity-50 cursor-pointer flex items-center gap-1.5 transition min-h-[44px]"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      <span>{t('edit')}</span>
                    </button>

                    <button
                      onClick={() => handleToggleHistory(j)}
                      aria-expanded={isHistoryOpen}
                      className="text-slate-400 hover:text-white cursor-pointer flex items-center gap-1.5 transition min-h-[44px]"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>{isHistoryOpen ? `Close ${t('runsHistory')}` : t('runsHistory')}</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setPendingDeleteJob(j)}
                    disabled={Boolean(pending)}
                    className="text-slate-500 hover:text-rose-400 disabled:opacity-50 cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-white/[0.04] transition"
                    title={t('delete')}
                    aria-label={`${t('delete')} ${j.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Run History Expansion */}
                {isHistoryOpen && (
                  <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2 animate-in fade-in duration-150">
                    <span className="text-xs font-semibold text-slate-300 block" aria-label={`${t('runsHistory')}: ${runs.length}`}>
                      {t('runsHistory')}{runs.length > 0 ? ` (${runs.length})` : ''}
                    </span>
                    {isRunsLoading && runsRaw === undefined ? (
                      <p className="text-xs text-slate-500" role="status">
                        Loading run history...
                      </p>
                    ) : runsFetchFailed && runs.length === 0 ? (
                      <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 space-y-2" role="alert">
                        <p className="text-xs text-rose-300">
                          Could not load run history. The gateway may be offline.
                        </p>
                        <button
                          type="button"
                          onClick={() => handleRetryRuns(j.id)}
                          disabled={isRunsLoading}
                          className="px-3 min-h-[44px] py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs text-slate-200 disabled:opacity-50 cursor-pointer transition"
                        >
                          {isRunsLoading ? 'Retrying...' : tx('retry', 'Retry')}
                        </button>
                      </div>
                    ) : runs.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No previous runs logged for this job yet.
                      </p>
                    ) : (
                      <>
                        {runs.length > 10 && (
                          <p className="text-[11px] text-slate-500">
                            Showing the 10 most recent of {runs.length} runs.
                          </p>
                        )}
                        {[...runs].sort((a, b) => parseRunDate(b.startedAt) - parseRunDate(a.startedAt)).slice(0, 10).map((r, i) => {
                          const duration = formatDuration(r.startedAt, r.finishedAt);
                          const startedLabel = r.startedAt
                            ? formatRunTimestamp(r.startedAt, displayTz)
                            : '';
                          const endedLabel = r.finishedAt
                            ? formatRunTimestamp(r.finishedAt, displayTz)
                            : '';
                          // Explicit allowlist: known success values read as
                          // success, everything else is neutral or failing.
                          const runInfo = runStatusInfo(r.status, tx);
                          const badgeClass = RUN_TONE_CLASS[runInfo.tone];
                          return (
                            <div
                              key={r.id || i}
                              className="p-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.06] text-xs space-y-1"
                            >
                              <div className="flex items-center justify-between gap-2 text-slate-300">
                                <span className={`px-2 py-0.5 rounded-md border text-[10px] font-medium ${badgeClass}`} aria-label={`${tx('runStatusLabel', 'Run status')}: ${runInfo.label}`}>
                                  {runInfo.label}
                                </span>
                                <span className="text-slate-500 text-[11px] font-mono" title={r.startedAt}>{startedLabel}</span>
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                                {endedLabel && <span>Ended {endedLabel}</span>}
                                {duration && <span>· {duration}</span>}
                              </div>
                              {r.error && (
                                <p className="text-rose-400 text-[11px] whitespace-pre-wrap break-words">{r.error}</p>
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

      {/* Delete Modal */}
      {pendingDeleteJob && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Delete ${pendingDeleteJob.name}`}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDeleteJob(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-white">
              Delete Schedule?
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Are you sure you want to permanently delete &ldquo;{pendingDeleteJob.name}&rdquo;? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setPendingDeleteJob(null)}
                className="px-4 min-h-[44px] py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => handleDeleteConfirm(pendingDeleteJob)}
                className="px-4 min-h-[44px] py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer transition"
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingJob && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${editingJob.name}`}
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingJob(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.1] p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">Edit Schedule</span>
              <button
                onClick={() => setEditingJob(null)}
                aria-label="Close edit dialog"
                className="min-w-[44px] min-h-[44px] rounded-lg flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 font-medium mb-1">
                  {t('jobName')}
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  aria-invalid={editMissing.includes('name')}
                  className={`w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border text-xs text-white focus:outline-none focus:border-indigo-500 transition ${editMissing.includes('name') ? 'border-rose-500/60' : 'border-white/[0.08]'}`}
                />
                {editMissing.includes('name') && (
                  <p className="text-[11px] text-rose-400 mt-1">Job title is required.</p>
                )}
              </div>
              <div>
                <label className="block text-xs text-slate-400 font-medium mb-1">
                  {t('cronSchedule')}
                </label>
                <input
                  type="text"
                  value={editSchedule}
                  onChange={(e) => setEditSchedule(e.target.value)}
                  placeholder="e.g. every 1h, every day 9am, or 0 9 * * *"
                  aria-invalid={editMissing.includes('schedule')}
                  className={`w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border text-xs text-white focus:outline-none focus:border-indigo-500 transition ${editMissing.includes('schedule') ? 'border-rose-500/60' : 'border-white/[0.08]'}`}
                />
                {editMissing.includes('schedule') && (
                  <p className="text-[11px] text-rose-400 mt-1">Schedule is required.</p>
                )}
                {editSummary && (
                  <p className="text-[11px] text-slate-400 mt-1">
                    {editSummary}{' '}
                    <span className="text-slate-500">Local reading only; the gateway decides.</span>
                  </p>
                )}
                {editHint && (
                  <p className="text-[11px] text-amber-300/90 mt-1">
                    Hint: {editHint}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {presets.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setEditSchedule(p.val)}
                      title={p.val === 'once' ? 'Runs a single time, then stops' : p.val}
                      className="px-2.5 py-1 min-h-[44px] rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-slate-300 hover:text-white transition cursor-pointer"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 font-medium mb-1">
                  Display timezone
                </label>
                <select
                  value={displayTz}
                  onChange={(e) => setDisplayTz(e.target.value)}
                  className="w-full px-3.5 py-2 min-h-[44px] rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                >
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {formatTimezoneOption(tz)}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Display only: the gateway stores no timezone. Times render in {displayTz}.
                </p>
              </div>
              <div>
                <label className="block text-xs text-slate-400 font-medium mb-1">
                  {t('instructions')}
                </label>
                <textarea
                  rows={2}
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  aria-invalid={editMissing.includes('prompt')}
                  className={`w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border text-xs text-white focus:outline-none focus:border-indigo-500 transition resize-none ${editMissing.includes('prompt') ? 'border-rose-500/60' : 'border-white/[0.08]'}`}
                />
                {editMissing.includes('prompt') && (
                  <p className="text-[11px] text-rose-400 mt-1">Execution prompt is required.</p>
                )}
              </div>
            </div>

            {editError && (
              <p className="text-xs text-rose-400">{editError}</p>
            )}
            {renderFieldErrors(editFieldErrors)}

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setEditingJob(null)}
                className="px-4 min-h-[44px] py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit}
                className="px-4 min-h-[44px] py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer transition"
              >
                {isSavingEdit ? 'Saving...' : t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
