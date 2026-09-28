import React, { useState, useMemo } from 'react';
import {
  Play,
  Pause,
  Trash2,
  History,
  AlertCircle,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
  Sliders,
  Calendar,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import { CronJob } from '../../types/hermes';

export const JobsTab: React.FC = () => {
  const { jobs, createJob, jobAction, cronRuns, fetchRuns, t } = useHermes();

  // Create form state
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [prompt, setPrompt] = useState('');
  const [createError, setCreateError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Search & history
  const [query, setQuery] = useState('');
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const [pendingDeleteJob, setPendingDeleteJob] = useState<CronJob | null>(null);

  const presets = [
    { label: 'Run Once', val: 'once' },
    { label: 'Daily at 9am', val: 'every day 9am' },
    { label: 'Weekdays at 9am', val: 'every weekday 9am' },
    { label: 'Every 1 Hour', val: 'every 1h' },
  ];

  const handleCreate = async () => {
    if (!name.trim() || !schedule.trim() || !prompt.trim()) {
      setCreateError('Please fill in job title, schedule, and execution prompt');
      return;
    }

    setCreateError('');
    setIsCreating(true);
    const ok = await createJob(name.trim(), schedule.trim(), prompt.trim());
    setIsCreating(false);

    if (ok) {
      setName('');
      setSchedule('');
      setPrompt('');
    } else {
      setCreateError('Failed to create job');
    }
  };

  const isOverdue = (nextRunAt: string, enabled: boolean, state: string) => {
    if (!enabled || state.toLowerCase() === 'paused') return false;
    if (!nextRunAt) return false;
    try {
      const target = new Date(nextRunAt).getTime();
      return target < Date.now();
    } catch {
      return false;
    }
  };

  const visibleJobs = useMemo(() => {
    if (!query.trim()) return jobs;
    const q = query.toLowerCase();
    return jobs.filter(
      (j) => j.name.toLowerCase().includes(q) || j.prompt.toLowerCase().includes(q)
    );
  }, [jobs, query]);

  return (
    <div className="space-y-6 max-w-2xl mx-auto px-4 pt-4 pb-28">
      {/* 1. New Automation Schedule Builder Card */}
      <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-4 shadow-xs">
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
              className="w-full px-3.5 py-2 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
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
              className="w-full px-3.5 py-2 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
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
              {t('instructions')}
            </label>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Task instructions to execute at each scheduled interval..."
              className="w-full px-3.5 py-2 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition resize-none"
            />
          </div>
        </div>

        {createError && (
          <p className="text-xs text-rose-400">{createError}</p>
        )}

        <button
          onClick={handleCreate}
          disabled={isCreating}
          className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" />
          <span>{isCreating ? t('testingKey') : t('newJob')}</span>
        </button>
      </div>

      {/* 2. Search & Filter Bar */}
      {jobs.length > 0 && (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            className="w-full pl-10 pr-3.5 py-2 rounded-xl bg-[#0E1217] border border-white/[0.08] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
          />
        </div>
      )}

      {/* 3. Schedules List */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-slate-400 tracking-wider uppercase">
          {t('scheduledJobsTitle')} ({visibleJobs.length})
        </h3>

        {jobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[#0E1217] border border-white/[0.06] text-center text-xs text-slate-400">
            No scheduled automation jobs configured. Create your first job above using standard cadence or cron expressions.
          </div>
        ) : visibleJobs.length === 0 ? (
          <div className="p-8 rounded-3xl bg-[#0E1217] border border-white/[0.06] text-center text-xs text-slate-400">
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

            return (
              <div
                key={j.id}
                className="rounded-2xl bg-[#0E1217] border border-white/[0.07] p-4 space-y-3 transition hover:border-white/[0.14]"
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
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                      <span>{j.scheduleDisplay}</span>
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
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                    <span>Next execution: {j.nextRunAt.replace('T', ' ').slice(0, 19)}</span>
                  </div>
                )}

                {isFailed && (
                  <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                    {j.lastError || 'Last execution encountered an exception'}
                  </div>
                )}

                <div className="text-xs text-slate-300 bg-[#141920] p-3 rounded-xl border border-white/[0.06] font-mono leading-relaxed">
                  {j.prompt}
                </div>

                {/* Job Action Controls */}
                <div className="flex items-center justify-between pt-2 border-t border-white/[0.06] text-xs">
                  <div className="flex items-center gap-3">
                    {j.enabled ? (
                      <button
                        onClick={() => jobAction(j.id, 'pause')}
                        className="text-slate-400 hover:text-white cursor-pointer flex items-center gap-1.5 transition"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>Pause</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => jobAction(j.id, 'resume')}
                        className="text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1.5 transition"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Resume</span>
                      </button>
                    )}

                    <button
                      onClick={() => jobAction(j.id, 'run')}
                      className="text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1.5 transition font-medium"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Run Now</span>
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
                      className="text-slate-400 hover:text-white cursor-pointer flex items-center gap-1.5 transition"
                    >
                      <History className="w-3.5 h-3.5" />
                      <span>{isHistoryOpen ? 'Close History' : 'History'}</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setPendingDeleteJob(j)}
                    className="text-slate-500 hover:text-rose-400 cursor-pointer p-1.5 rounded-lg hover:bg-white/[0.04] transition"
                    title="Delete schedule"
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
                      runs.slice(0, 10).map((r, i) => (
                        <div
                          key={r.id || i}
                          className="p-2.5 rounded-xl bg-[#141920] border border-white/[0.06] text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between text-slate-300">
                            <span className="font-medium capitalize">{r.status || 'Completed'}</span>
                            <span className="text-slate-500 text-[11px] font-mono">{r.startedAt}</span>
                          </div>
                          {r.error && (
                            <p className="text-rose-400 text-[11px] truncate">{r.error}</p>
                          )}
                        </div>
                      ))
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-[#0E1217] border border-white/[0.1] p-5 shadow-2xl space-y-4">
            <h3 className="text-base font-semibold text-white">
              Delete Schedule?
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Are you sure you want to permanently delete "{pendingDeleteJob.name}"?
            </p>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setPendingDeleteJob(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  jobAction(pendingDeleteJob.id, 'delete');
                  setPendingDeleteJob(null);
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer transition"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
