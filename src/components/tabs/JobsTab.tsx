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
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { CronJob } from '../../types/hermes';
import {
  COMMON_TIMEZONES,
  ServerFieldError,
  cronHint,
  formatDateTimeInTimezone,
  formatRunTimestamp,
  formatTimeWithZone,
  rejectionErrors,
  resolveDeviceTimezone,
} from '../../utils/jobTime';

const OVERDUE_GRACE_MS = 5 * 60 * 1000;

type PendingAction = 'pause' | 'resume' | 'run' | 'delete';

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
  const { jobs, createJob, jobAction, cronRuns, fetchRuns, t } = hermes;
  const updateJob = (hermes as unknown as {
    updateJob?: (id: string, patch: { name?: string; schedule?: string; prompt?: string }) => Promise<boolean>;
  }).updateJob;

  const deviceTz = useMemo(() => resolveDeviceTimezone(), []);
  const lang = hermes.settings?.language || 'en';

  // Create form state
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  const [timezone, setTimezone] = useState(deviceTz);
  const [createError, setCreateError] = useState('');
  const [createFieldErrors, setCreateFieldErrors] = useState<ServerFieldError[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Edit form state
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [editName, setEditName] = useState('');
  const [editSchedule, setEditSchedule] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editTimezone, setEditTimezone] = useState(deviceTz);
  const [editError, setEditError] = useState('');
  const [editFieldErrors, setEditFieldErrors] = useState<ServerFieldError[]>([]);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Search & history
  const [query, setQuery] = useState('');
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [pendingDeleteJob, setPendingDeleteJob] = useState<CronJob | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // JOB-04: optimistic overrides with rollback. Context jobs are the
  // source of truth; these layers apply instantly and roll back on failure.
  const [pendingOps, setPendingOps] = useState<Record<string, PendingAction>>({});
  const [optimisticEnabled, setOptimisticEnabled] = useState<Record<string, boolean>>({});
  const [hiddenIds, setHiddenIds] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
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

  const timezoneOptions = useMemo(() => {
    if (COMMON_TIMEZONES.includes(deviceTz)) return COMMON_TIMEZONES;
    return [deviceTz, ...COMMON_TIMEZONES];
  }, [deviceTz]);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const handleCreate = async () => {
    if (!name.trim() || !schedule.trim() || !prompt.trim()) {
      setCreateError('Please fill in job title, schedule, and execution prompt');
      setCreateFieldErrors([]);
      return;
    }
    // NOTE: no client-side blocking on schedule shape. The gateway decides.
    setCreateError('');
    setCreateFieldErrors([]);
    setIsCreating(true);
    // Gateway createJob carries no timezone field, so the selected zone is
    // the interpretation label for display (next run renders in this zone).
    const ok = await createJob(name.trim(), schedule.trim(), prompt.trim());
    setIsCreating(false);

    if (ok) {
      setName('');
      setSchedule('');
      setPrompt('');
      setTimezone(deviceTz);
      showToast(`Job created, runs interpreted in ${timezone}`);
    } else {
      const errs = rejectionErrors('create');
      setCreateFieldErrors(errs);
      setCreateError(errs[0].message);
      showToast('Failed to create job: gateway rejected the request');
    }
  };

  const openEdit = (j: CronJob) => {
    setEditingJob(j);
    setEditName(j.name);
    setEditSchedule(j.scheduleDisplay);
    setEditPrompt(j.prompt);
    setEditTimezone(deviceTz);
    setEditError('');
    setEditFieldErrors([]);
  };

  const handleSaveEdit = async () => {
    if (!editingJob) return;
    if (!editName.trim() || !editSchedule.trim() || !editPrompt.trim()) {
      setEditError('Please fill in job title, schedule, and execution prompt');
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
      showToast(`Job updated, shown in ${editTimezone}`);
    } else {
      const errs = rejectionErrors('update');
      setEditFieldErrors(errs);
      setEditError(errs[0].message);
      showToast('Failed to update job: gateway rejected the request');
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
      showToast(`Failed to ${action} "${j.name}", rolled back`);
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
      showToast('Run triggered');
    } else {
      const errs = rejectionErrors('action');
      setActionError(errs[0].message);
      showToast(`Failed to run "${j.name}", rolled back`);
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
      showToast(`Failed to delete "${j.name}", restored`);
    }
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
      {/* Toast popup */}
      {toast && (
        <div className="fixed top-16 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[70] px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold shadow-2xl animate-in fade-in slide-in-from-top-2">
          {toast}
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
              className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
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
              className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
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
                  className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-slate-300 hover:text-white transition cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 font-medium mb-1">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition"
            >
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-500 mt-1">
              Runs interpreted in {timezone}. Next run shows as clock time plus zone.
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
              className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition resize-none"
            />
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
        <div className="relative">
          <Search className="w-4 h-4 absolute start-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            className="w-full ps-10 pe-3.5 py-2 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
          />
        </div>
      )}

      {/* Action-level rollback notice */}
      {actionError && (
        <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-start justify-between gap-3" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError('')}
            className="text-rose-300/70 hover:text-rose-200 cursor-pointer"
            aria-label="Dismiss action error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 3. Schedules List */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
          {t('scheduledJobsTitle')} ({visibleJobs.length})
        </h3>

        {jobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center text-xs text-slate-400">
            No scheduled automation jobs configured. Create your first job above using standard cadence or cron expressions.
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[var(--app-card,#0E1217)] border border-white/[0.06] text-center text-xs text-slate-400">
            No tasks match "{query}".
          </div>
        ) : (
          visibleJobs.map((j) => {
            const overdue = isOverdue(j.nextRunAt, j.enabled, j.state);
            const isFailed =
              j.lastStatus.toLowerCase() === 'failed' ||
              j.lastStatus.toLowerCase() === 'error' ||
              Boolean(j.lastError);
            const isHistoryOpen = historyForId === j.id;
            const runs = cronRuns[j.id] || [];
            const pending = pendingOps[j.id];
            const nextRunLabel = j.nextRunAt
              ? formatTimeWithZone(j.nextRunAt, deviceTz)
              : '';
            const nextRunFull = j.nextRunAt
              ? formatDateTimeInTimezone(j.nextRunAt, deviceTz, lang)
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
                        {deviceTz}
                      </span>
                      <span>·</span>
                      <span className={j.enabled ? 'text-emerald-400' : 'text-slate-500'}>
                        {j.state || (j.enabled ? 'Active' : 'Paused')}
                      </span>
                    </div>
                  </div>

                  <span
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      j.enabled
                        ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                        : 'bg-white/[0.04] text-slate-400 border border-white/[0.06]'
                    }`}
                  >
                    {j.enabled ? 'Enabled' : 'Paused'}
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

                <button
                  type="button"
                  onClick={() => setExpandedPrompts((prev) => ({ ...prev, [j.id]: !prev[j.id] }))}
                  aria-expanded={!!expandedPrompts[j.id]}
                  title={j.prompt}
                  aria-label={`Job prompt: ${j.prompt}. Tap to ${expandedPrompts[j.id] ? 'collapse' : 'expand'}.`}
                  className={`block w-full text-start text-xs text-slate-300 bg-[var(--app-card-subtle,#141920)] p-3 rounded-xl border border-white/[0.06] font-mono leading-relaxed cursor-pointer ${expandedPrompts[j.id] ? 'whitespace-pre-wrap break-all' : 'line-clamp-6'}`}
                >
                  {j.prompt}
                </button>

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
                      <span>{pending === 'run' ? 'Running...' : 'Run Now'}</span>
                    </button>

                    <button
                      onClick={() => openEdit(j)}
                      disabled={Boolean(pending)}
                      className="text-slate-400 hover:text-white disabled:opacity-50 cursor-pointer flex items-center gap-1.5 transition min-h-[44px]"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>

                    <button
                      onClick={async () => {
                        if (isHistoryOpen) {
                          setHistoryForId(null);
                        } else {
                          setHistoryForId(j.id);
                          await fetchRuns(j.id);
                        }
                      }}
                      className="text-slate-400 hover:text-white cursor-pointer flex items-center gap-1.5 transition min-h-[44px]"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>{isHistoryOpen ? 'Close History' : 'History'}</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setPendingDeleteJob(j)}
                    disabled={Boolean(pending)}
                    className="text-slate-500 hover:text-rose-400 disabled:opacity-50 cursor-pointer p-1.5 rounded-lg hover:bg-white/[0.04] transition"
                    title={t('delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Run History Expansion */}
                {isHistoryOpen && (
                  <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2 animate-in fade-in duration-150">
                    <span className="text-xs font-semibold text-slate-300 block">
                      Execution History
                    </span>
                    {runs.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No previous runs logged for this job yet.
                      </p>
                    ) : (
                      runs.slice(0, 10).map((r, i) => {
                        const duration = formatDuration(r.startedAt, r.finishedAt);
                        const startedLabel = r.startedAt
                          ? formatRunTimestamp(r.startedAt, deviceTz)
                          : '';
                        const endedLabel = r.finishedAt
                          ? formatRunTimestamp(r.finishedAt, deviceTz)
                          : '';
                        return (
                          <div
                            key={r.id || i}
                            className="p-2.5 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.06] text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between text-slate-300">
                              <span className="font-medium capitalize">{r.status || 'Completed'}</span>
                              <span className="text-slate-500 text-[11px] font-mono" title={r.startedAt}>{startedLabel}</span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                              {endedLabel && <span>Ended {endedLabel}</span>}
                              {duration && <span>· {duration}</span>}
                            </div>
                            {r.error && (
                              <p className="text-rose-400 text-[11px] truncate">{r.error}</p>
                            )}
                          </div>
                        );
                      })
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
              Are you sure you want to permanently delete "{pendingDeleteJob.name}"? It hides at once and restores if the gateway rejects the delete.
            </p>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setPendingDeleteJob(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                onClick={() => handleDeleteConfirm(pendingDeleteJob)}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer transition"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingJob && (
        <div
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
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white"
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
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                />
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
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                />
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
                      className="px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-xs text-slate-300 hover:text-white transition cursor-pointer"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 font-medium mb-1">
                  Timezone
                </label>
                <select
                  value={editTimezone}
                  onChange={(e) => setEditTimezone(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                >
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Displayed in {editTimezone}.
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
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--app-card-subtle,#141920)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 transition resize-none"
                />
              </div>
            </div>

            {editError && (
              <p className="text-xs text-rose-400">{editError}</p>
            )}
            {renderFieldErrors(editFieldErrors)}

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setEditingJob(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer transition"
              >
                {isSavingEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
