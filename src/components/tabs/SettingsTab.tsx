import React, { useState, useEffect } from 'react';
import {
  Eye,
  EyeOff,
  Play,
  Square,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lock,
  Unlock,
  Shield,
  Activity,
  Sliders,
  Cpu,
  Layers,
  Database,
  ArrowRight,
  Check,
  X,
  Sparkles,
  Sun,
  Moon,
  Monitor,
  Search,
  Globe,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  normProvider,
  DEFAULT_MODELS,
} from '../../constants/providers';
import { THEME_PALETTES, ThemeMode } from '../../constants/themes';
import { LANGUAGES } from '../../constants/languages';
import {
  Blueprint,
  DoctorReport,
  BackupResult,
  DebugShare,
  SkillInfo,
  MemoryInfo,
  ConfiguredProvider,
} from '../../types/hermes';

export const SettingsTab: React.FC = () => {
  const {
    settings,
    updateSettings,
    configuredProviders,
    addConfiguredProvider,
    updateConfiguredProvider,
    removeConfiguredProvider,
    activateProvider,
    install,
    connected,
    startGateway,
    stopGateway,
    installGateway,
    service,
    approvals,
    jobs,
    addLog,
    t,
  } = useHermes();

  // Multi-provider form modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [newProvType, setNewProvType] = useState('deepseek');
  const [newProvCustom, setNewProvCustom] = useState(false);
  const [newProvName, setNewProvName] = useState('');
  const [newProvKey, setNewProvKey] = useState('');
  const [newProvBaseUrl, setNewProvBaseUrl] = useState('');
  const [newProvModel, setNewProvModel] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);

  // Key testing state
  const [testingKey, setTestingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<string | null>(null);
  const [keyOk, setKeyOk] = useState<boolean | null>(null);

  // External bot bridges state
  const [tgToken, setTgToken] = useState(settings.tgToken);

  useEffect(() => {
    setTgToken(settings.tgToken);
  }, [settings.tgToken]);

  // Toast feedback
  const [toast, setToast] = useState<string | null>(null);

  // Ops state
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [runningDoctor, setRunningDoctor] = useState(false);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [runningBackup, setRunningBackup] = useState(false);
  const [debugResult, setDebugResult] = useState<DebugShare | null>(null);
  const [sharingDebug, setSharingDebug] = useState(false);

  // Library & Skills state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [selectedBlueprint, setSelectedBlueprint] = useState<Blueprint | null>(null);
  const [blueprintSlots, setBlueprintSlots] = useState<Record<string, string>>({});

  // Active settings section tab
  const [activeSection, setActiveSection] = useState<'connection' | 'gateway' | 'preferences' | 'library'>('connection');

  // Preferences search filters
  const [themeSearch, setThemeSearch] = useState('');
  const [langSearch, setLangSearch] = useState('');

  const currentTheme = settings.themePalette || 'midnight';
  const currentMode = settings.themeMode || 'dark';

  const filteredThemes = THEME_PALETTES.filter((th) =>
    th.name.toLowerCase().includes(themeSearch.toLowerCase()) ||
    th.description.toLowerCase().includes(themeSearch.toLowerCase())
  );

  const filteredLanguages = LANGUAGES.filter((l) =>
    l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.code.toLowerCase().includes(langSearch.toLowerCase())
  );

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    service.skillsList().then(setSkills);
    service.memoryGet().then(setMemory);
    service.blueprints().then(setBlueprints);
  }, [service]);

  const handleTestKey = async () => {
    if (!newProvKey.trim()) return;
    setTestingKey(true);
    setKeyResult(null);
    setKeyOk(null);

    const norm = normProvider(newProvType);
    const valid = await service.providersValidate(norm, 'HERMES_API_KEY', newProvKey.trim());
    setTestingKey(false);
    if (valid === true) {
      setKeyOk(true);
      setKeyResult('Key validated successfully');
    } else if (valid === false) {
      setKeyOk(false);
      setKeyResult('Key format rejected by provider');
    } else {
      setKeyOk(null);
      setKeyResult('Key pattern verified');
    }
  };

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    const report = await service.doctor();
    setDoctorReport(report);
    setRunningDoctor(false);
  };

  const handleRunBackup = async () => {
    setRunningBackup(true);
    const res = await service.backup();
    setBackupResult(res);
    setRunningBackup(false);
  };

  const handleShareDebug = async () => {
    setSharingDebug(true);
    const res = await service.debugShare();
    setDebugResult(res);
    setSharingDebug(false);
  };

  const handleToggleSkill = async (id: string, current: boolean) => {
    await service.skillToggle(id, !current);
    const updated = await service.skillsList();
    setSkills(updated);
    showToast(`Skill ${!current ? 'enabled' : 'disabled'}`);
  };

  const handleInstantiateBlueprint = async (id: string) => {
    await service.instantiateBlueprint(id, blueprintSlots);
    setSelectedBlueprint(null);
    setBlueprintSlots({});
    showToast('Workflow routine launched into active session');
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto px-4 pt-4 pb-28">
      {/* Toast popup */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold shadow-2xl animate-in fade-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      {/* Settings Navigation Tabs */}
      <div className="flex items-center gap-1.5 p-1 rounded-2xl bg-[#0E1217] border border-white/[0.08] overflow-x-auto">
        {[
          { id: 'connection', label: t('inference') },
          { id: 'gateway', label: t('daemonOps') },
          { id: 'preferences', label: t('preferences') },
          { id: 'library', label: t('skillsMemory') },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSection(tab.id as any)}
            className={`flex-1 min-h-[40px] px-3 py-2 rounded-xl text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
              activeSection === tab.id
                ? 'bg-white/[0.08] text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ========================================================= */}
      {/* 1. INFERENCE & MULTI-PROVIDER PROFILES */}
      {/* ========================================================= */}
      {activeSection === 'connection' && (
        <div className="space-y-4">
          {/* Multi-provider Overview & Switcher */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-4 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white tracking-tight">
                  {t('configuredProviders')}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Connect multiple LLM providers simultaneously (DeepSeek, OpenAI, Anthropic, Gemini, Ollama, etc.) and switch between them on the fly.
                </p>
              </div>
              <button
                onClick={() => {
                  setEditingProviderId(null);
                  setNewProvType('deepseek');
                  setNewProvCustom(false);
                  setNewProvName('DeepSeek');
                  setNewProvKey('');
                  setNewProvBaseUrl('');
                  setNewProvModel(DEFAULT_MODELS['deepseek']?.[0] || 'deepseek/deepseek-chat');
                  setKeyResult(null);
                  setKeyOk(null);
                  setShowAddModal(true);
                }}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer shrink-0"
              >
                <span>{t('addProvider')}</span>
              </button>
            </div>

            {/* List of Configured Providers */}
            <div className="space-y-2 pt-1">
              {configuredProviders.map((prov) => {
                const isActive = prov.provider === settings.provider;
                return (
                  <div
                    key={prov.id}
                    className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-3 ${
                      isActive
                        ? 'bg-indigo-600/10 border-indigo-500/40 text-white shadow-xs'
                        : 'bg-[#141920] border-white/[0.06] text-slate-300 hover:border-white/[0.12]'
                    }`}
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs uppercase shrink-0 ${
                          isActive
                            ? 'bg-indigo-600 text-white'
                            : 'bg-white/[0.06] text-slate-400'
                        }`}
                      >
                        {prov.provider.slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-semibold text-white truncate">
                            {prov.name}
                          </p>
                          {isActive && (
                            <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 text-[10px] font-medium border border-emerald-500/30">
                              {t('active')}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                          {prov.defaultModel || 'Default Model'} · {prov.baseUrl ? 'Custom Proxy' : 'Official Endpoint'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {!isActive ? (
                        <button
                          onClick={() => {
                            activateProvider(prov.id);
                            showToast(`Active provider switched to ${prov.name}`);
                          }}
                          className="px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-slate-200 transition cursor-pointer"
                        >
                          {t('use')}
                        </button>
                      ) : (
                        <span className="text-xs text-indigo-400 font-medium px-2 flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" />
                          <span>{t('active')}</span>
                        </span>
                      )}

                      <button
                        onClick={() => {
                          setEditingProviderId(prov.id);
                          setNewProvType(prov.provider);
                          setNewProvName(prov.name);
                          setNewProvKey(prov.apiKey);
                          setNewProvBaseUrl(prov.baseUrl || '');
                          setNewProvModel(prov.defaultModel || '');
                          setKeyResult(null);
                          setKeyOk(null);
                          setShowAddModal(true);
                        }}
                        className="px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                      >
                        {t('edit')}
                      </button>

                      {configuredProviders.length > 1 && (
                        <button
                          onClick={() => {
                            removeConfiguredProvider(prov.id);
                            showToast(`Removed ${prov.name}`);
                          }}
                          className="p-1.5 rounded-xl text-slate-500 hover:text-rose-400 hover:bg-white/[0.06] transition cursor-pointer"
                          title="Delete provider"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 2. GATEWAY DAEMON & OPS */}
      {/* ========================================================= */}
      {activeSection === 'gateway' && (
        <div className="space-y-4">
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-4 shadow-xs">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white tracking-tight">
                  Gateway Daemon Supervisor
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  127.0.0.1:8080 · State: {install}
                </p>
              </div>

              <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                connected ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-300 border border-rose-500/20'
              }`}>
                {connected ? 'Running' : 'Stopped'}
              </span>
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <button
                onClick={async () => {
                  await startGateway();
                  showToast('Gateway service started');
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-white" />
                <span>Start Daemon</span>
              </button>
              <button
                onClick={() => {
                  stopGateway();
                  showToast('Gateway service stopped');
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 text-xs font-medium transition cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-slate-300" />
                <span>Stop</span>
              </button>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
              <div>
                <p className="text-xs font-medium text-white">Auto-launch on startup</p>
                <p className="text-[11px] text-slate-400">Initialize local gateway automatically upon opening app</p>
              </div>
              <button
                onClick={() => {
                  const next = !settings.autostart;
                  updateSettings({ autostart: next });
                  showToast(next ? 'Auto-start enabled' : 'Auto-start disabled');
                }}
                className={`w-11 h-6 flex items-center rounded-full p-1 cursor-pointer transition-colors ${
                  settings.autostart ? 'bg-indigo-600' : 'bg-white/[0.1]'
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                    settings.autostart ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Diagnostics Doctor */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white">System Diagnostics</h4>
                <p className="text-xs text-slate-400 mt-0.5">Comprehensive audit of local execution components</p>
              </div>
              <button
                onClick={handleRunDoctor}
                disabled={runningDoctor}
                className="px-3.5 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-slate-300 hover:text-white transition cursor-pointer"
              >
                {runningDoctor ? 'Auditing…' : 'Run Diagnostics'}
              </button>
            </div>

            {doctorReport && (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-slate-300 font-medium">{doctorReport.summary}</p>
                <div className="space-y-1.5">
                  {doctorReport.checks.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2.5 p-2.5 rounded-xl bg-[#141920] border border-white/[0.06] text-xs"
                    >
                      {c.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span className="text-white font-medium">{c.name}</span>
                      <span className="text-slate-400 ml-auto truncate max-w-[200px]">{c.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Backup & Debug Export */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-4 space-y-2">
              <h4 className="text-xs font-semibold text-white">Local Snapshot</h4>
              <p className="text-[11px] text-slate-400">Save workspace sessions, cron schedules, and settings.</p>
              <button
                onClick={handleRunBackup}
                disabled={runningBackup}
                className="w-full py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-slate-300 hover:text-white transition cursor-pointer mt-2"
              >
                {runningBackup ? 'Backing up…' : 'Create Snapshot'}
              </button>
              {backupResult && (
                <p className="text-[11px] text-emerald-400 pt-1">{backupResult.message}</p>
              )}
            </div>

            <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-4 space-y-2">
              <h4 className="text-xs font-semibold text-white">Debug Bundle</h4>
              <p className="text-[11px] text-slate-400">Extract sanitized socket connection logs and daemon traces.</p>
              <button
                onClick={handleShareDebug}
                disabled={sharingDebug}
                className="w-full py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs font-medium text-slate-300 hover:text-white transition cursor-pointer mt-2"
              >
                {sharingDebug ? 'Exporting…' : 'Generate Bundle'}
              </button>
              {debugResult && (
                <p className="text-[11px] text-indigo-400 pt-1 truncate">{debugResult.summary}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 3. PREFERENCES & SECURITY */}
      {/* ========================================================= */}
      {activeSection === 'preferences' && (
        <div className="space-y-4">
          {/* 1. Theme Configuration Card (Matching Image 2) */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-4 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white tracking-tight">
                  {t('themeTitle')}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {t('themeSubtitle')}
                </p>
              </div>

              {/* Mode Switcher [Light | Dark | System] */}
              <div className="flex items-center gap-1 p-1 bg-[#141920] border border-white/[0.08] rounded-xl self-start sm:self-auto">
                {[
                  { id: 'light', label: t('light') || 'Light', icon: Sun },
                  { id: 'dark', label: t('dark') || 'Dark', icon: Moon },
                  { id: 'system', label: t('system') || 'System', icon: Monitor },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => {
                      updateSettings({ themeMode: mode.id as any });
                      showToast(`${t('themeTitle')}: ${mode.label}`);
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                      currentMode === mode.id
                        ? 'bg-white/[0.12] text-white shadow-xs font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <mode.icon className="w-3.5 h-3.5" />
                    <span>{mode.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Theme Search */}
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={themeSearch}
                onChange={(e) => setThemeSearch(e.target.value)}
                placeholder={t('searchThemes')}
                className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-slate-500"
              />
            </div>

            {/* Themes 3-Column Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 pt-1">
              {filteredThemes.map((th) => {
                const isSelected = currentTheme === th.id;
                return (
                  <button
                    key={th.id}
                    onClick={() => {
                      updateSettings({ themePalette: th.id });
                      showToast(`Applied ${th.name} theme`);
                    }}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer flex flex-col justify-between group ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500/50 shadow-sm'
                        : 'border-white/[0.08] bg-[#141920]/60 hover:bg-[#141920] hover:border-white/[0.18]'
                    }`}
                  >
                    {/* Mockup Preview illustration matching Image 2 */}
                    <div
                      className="w-full h-24 rounded-xl border border-white/[0.08] overflow-hidden flex relative mb-3 shadow-inner"
                      style={{ backgroundColor: th.preview.bg }}
                    >
                      {/* Left sidebar strip */}
                      <div
                        className="w-12 h-full border-r border-white/[0.06] shrink-0"
                        style={{ backgroundColor: th.preview.sidebar }}
                      />
                      {/* Right content mockup */}
                      <div className="flex-1 p-2.5 flex flex-col justify-between">
                        <div className="space-y-1.5">
                          <div
                            className="h-2.5 w-20 rounded-full"
                            style={{ backgroundColor: th.preview.bar1 }}
                          />
                          <div
                            className="h-2 w-28 rounded-full"
                            style={{ backgroundColor: th.preview.bar2 }}
                          />
                        </div>
                        <div className="flex justify-end">
                          <div
                            className="h-4 w-12 rounded-full"
                            style={{ backgroundColor: th.preview.pill }}
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold text-white group-hover:text-indigo-300 transition-colors">
                          {th.name}
                        </h4>
                        {isSelected && (
                          <span className="w-2 h-2 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 leading-snug line-clamp-2">
                        {th.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Language & Locale Configuration Card (Matching Image 1) */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-4 shadow-xs">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white tracking-tight">
                  {t('languageTitle')}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Select your interface language. Hermes will adapt text, labels, and text direction.
                </p>
              </div>
              <span className="px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-xs font-mono font-medium uppercase">
                {LANGUAGES.find((l) => l.id === (settings.language || 'en'))?.code || 'EN'}
              </span>
            </div>

            {/* Language Search matching Image 1 placeholder */}
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={langSearch}
                onChange={(e) => setLangSearch(e.target.value)}
                placeholder={t('searchLanguages')}
                className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-slate-500 font-sans"
              />
            </div>

            {/* Languages List matching Image 1 */}
            <div className="divide-y divide-white/[0.04] max-h-64 overflow-y-auto rounded-2xl bg-[#141920] border border-white/[0.06]">
              {filteredLanguages.map((lang) => {
                const isSelected = (settings.language || 'en') === lang.id;
                return (
                  <button
                    key={lang.id}
                    onClick={() => {
                      updateSettings({ language: lang.id });
                      showToast(`${t('languageTitle')}: ${lang.name}`);
                    }}
                    className={`w-full px-4 py-3 flex items-center justify-between transition cursor-pointer hover:bg-white/[0.04] ${
                      isSelected ? 'bg-white/[0.06]' : ''
                    }`}
                  >
                    <span className={`text-xs ${isSelected ? 'text-white font-semibold' : 'text-slate-300'}`}>
                      {lang.name}
                    </span>

                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-slate-500 uppercase font-semibold">
                        {lang.code}
                      </span>
                      {isSelected && (
                        <Check className="w-4 h-4 text-indigo-400 stroke-[2.5]" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Interface & Security Controls Card */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-5 shadow-xs">
            <div>
              <h3 className="text-sm font-semibold text-white tracking-tight">
                Interface & Security Controls
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Customize chat scale, automated security grants, and local lockouts.
              </p>
            </div>

            {/* Font Scaling */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span className="font-medium">{t('fontScale')}</span>
                <span className="font-mono text-slate-400">{Math.round(settings.fontScale * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.8"
                max="1.4"
                step="0.05"
                value={settings.fontScale}
                onChange={(e) => updateSettings({ fontScale: parseFloat(e.target.value) })}
                className="w-full accent-indigo-500"
              />
            </div>

            {/* Reasoning Effort Level */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-300">
                {t('reasoningEffort')}
              </label>
              <div className="grid grid-cols-4 gap-2">
                {['none', 'low', 'medium', 'high'].map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => updateSettings({ reasoningEffort: lvl })}
                    className={`py-2 rounded-xl text-xs font-medium capitalize cursor-pointer border transition-all ${
                      settings.reasoningEffort === lvl
                        ? 'bg-indigo-600 border-indigo-500 text-white shadow-xs'
                        : 'bg-white/[0.03] border-white/[0.06] text-slate-400 hover:text-white'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-white/[0.06] space-y-3">
              {/* Auto-Approve Global */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[#141920] border border-white/[0.06]">
                <div>
                  <p className="text-xs font-medium text-white">{t('autoApprove')}</p>
                  <p className="text-[11px] text-slate-400">Skip manual security confirmation popups</p>
                </div>
                <button
                  onClick={() => {
                    const next = !settings.autoApproveGlobal;
                    updateSettings({ autoApproveGlobal: next });
                    showToast(next ? `${t('autoApprove')}: Active` : `${t('autoApprove')}: Disabled`);
                  }}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                    settings.autoApproveGlobal
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-white/[0.04] text-slate-400'
                  }`}
                >
                  {settings.autoApproveGlobal ? 'Active' : 'Disabled'}
                </button>
              </div>

              {/* App Lock PIN */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[#141920] border border-white/[0.06]">
                <div>
                  <p className="text-xs font-medium text-white">{t('appLock')}</p>
                  <p className="text-[11px] text-slate-400">Require PIN code upon opening workspace</p>
                </div>
                <button
                  onClick={() => {
                    const next = !settings.appLockEnabled;
                    updateSettings({ appLockEnabled: next });
                    showToast(next ? `${t('appLock')}: Enabled` : `${t('appLock')}: Disabled`);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                    settings.appLockEnabled
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-white/[0.04] text-slate-400'
                  }`}
                >
                  {settings.appLockEnabled ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  <span>{settings.appLockEnabled ? 'Locked' : 'Disabled'}</span>
                </button>
              </div>

              {/* Telegram Bot Token (Optional multi-channel bridge) */}
              <div className="p-3 rounded-2xl bg-[#141920] border border-white/[0.06] space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-white">{t('telegramBridge')}</p>
                    <p className="text-[11px] text-slate-400">Optional bridge to chat with Hermes via Telegram</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={tgToken}
                    onChange={(e) => setTgToken(e.target.value)}
                    placeholder="bot123456:ABC-DEF..."
                    className="flex-1 px-3 py-2 rounded-xl bg-[#0E1217] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    onClick={() => {
                      updateSettings({ tgToken: tgToken.trim() });
                      showToast('Telegram bot token saved');
                    }}
                    className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 4. LIBRARY: SKILLS & BLUEPRINTS */}
      {/* ========================================================= */}
      {activeSection === 'library' && (
        <div className="space-y-4">
          {/* Agent Skills */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-3 shadow-xs">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-white">Agent Skills Catalog</h4>
                <p className="text-xs text-slate-400 mt-0.5">Modular tool plugins available to the prompt context</p>
              </div>
              <button
                onClick={() => service.skillsList().then(setSkills)}
                className="text-xs text-indigo-400 hover:underline"
              >
                Refresh
              </button>
            </div>

            <div className="space-y-2 pt-1">
              {skills.map((sk) => (
                <div
                  key={sk.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-[#141920] border border-white/[0.06]"
                >
                  <div className="pr-3">
                    <p className="text-xs font-semibold text-white">{sk.name}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{sk.description}</p>
                  </div>
                  <button
                    onClick={() => handleToggleSkill(sk.id, sk.enabled)}
                    className={`w-10 h-5 flex items-center rounded-full p-0.5 cursor-pointer transition-colors ${
                      sk.enabled ? 'bg-indigo-600' : 'bg-white/[0.1]'
                    }`}
                  >
                    <div
                      className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                        sk.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Long Term Memory */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-2 shadow-xs">
            <h4 className="text-sm font-semibold text-white">Persistent Semantic Memory</h4>
            <p className="text-xs text-slate-400">
              Provider: {memory?.provider || 'local-vector'} · Entries: {memory?.entries || 0}
            </p>
            <div className="text-xs text-slate-300 bg-[#141920] p-3 rounded-xl border border-white/[0.06] font-mono leading-relaxed mt-2">
              {memory?.summary || 'Long term semantic vectors active across sessions.'}
            </div>
          </div>

          {/* Blueprints */}
          <div className="rounded-3xl bg-[#0E1217] border border-white/[0.08] p-5 space-y-3 shadow-xs">
            <h4 className="text-sm font-semibold text-white">Blueprint Automation Workflows</h4>
            <div className="space-y-2">
              {blueprints.map((bp) => (
                <div
                  key={bp.id}
                  className="p-3.5 rounded-2xl bg-[#141920] border border-white/[0.06] flex items-center justify-between gap-3"
                >
                  <div>
                    <p className="text-xs font-semibold text-white">{bp.name}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{bp.description}</p>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedBlueprint(bp);
                      const initialSlots: Record<string, string> = {};
                      bp.parameters?.forEach((p) => {
                        initialSlots[p.name] = p.default || '';
                      });
                      setBlueprintSlots(initialSlots);
                    }}
                    className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition cursor-pointer shrink-0"
                  >
                    Launch
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Blueprint Launch Modal */}
      {selectedBlueprint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-3xl bg-[#0E1217] border border-white/[0.1] p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">
                {selectedBlueprint.name}
              </span>
              <button
                onClick={() => setSelectedBlueprint(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">{selectedBlueprint.description}</p>

            {selectedBlueprint.parameters && selectedBlueprint.parameters.length > 0 && (
              <div className="space-y-2.5 pt-1">
                {selectedBlueprint.parameters.map((param) => (
                  <div key={param.name}>
                    <label className="block text-xs font-medium text-slate-400 mb-1">
                      {param.label}
                    </label>
                    <input
                      type="text"
                      value={blueprintSlots[param.name] || ''}
                      onChange={(e) =>
                        setBlueprintSlots({
                          ...blueprintSlots,
                          [param.name]: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                onClick={() => setSelectedBlueprint(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => handleInstantiateBlueprint(selectedBlueprint.id)}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs cursor-pointer transition"
              >
                Launch Routine
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Multi-Provider Add / Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-3xl bg-[#0E1217] border border-white/[0.1] p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.08]">
              <span className="text-sm font-semibold text-white">
                {editingProviderId ? 'Edit Model Provider' : 'Add Model Provider'}
              </span>
              <button
                onClick={() => setShowAddModal(false)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Provider Type */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('modelCatalog')}
                </label>
                <select
                  value={newProvType}
                  onChange={(e) => {
                    const val = e.target.value;
                    setNewProvType(val);
                    const opt = PROVIDER_OPTIONS.find(([id]) => id === val);
                    if (opt) setNewProvName(opt[1]);
                    const defModel = DEFAULT_MODELS[val]?.[0] || '';
                    if (defModel) setNewProvModel(defModel);
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {PROVIDER_OPTIONS.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name} ({id})
                    </option>
                  ))}
                </select>
              </div>

              {/* Provider Profile Label */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('modelCatalog')} Name
                </label>
                <input
                  type="text"
                  value={newProvName}
                  onChange={(e) => setNewProvName(e.target.value)}
                  placeholder="e.g. My Anthropic Key / DeepSeek Work"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* API Key */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('apiKey')} *
                </label>
                <div className="relative">
                  <input
                    type={showNewKey ? 'text' : 'password'}
                    value={newProvKey}
                    onChange={(e) => {
                      setNewProvKey(e.target.value);
                      setKeyResult(null);
                    }}
                    placeholder="sk-..."
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewKey(!showNewKey)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                  >
                    {showNewKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {/* Key verification inside Modal */}
                <div className="flex items-center gap-3 mt-2">
                  <button
                    type="button"
                    onClick={handleTestKey}
                    disabled={!newProvKey.trim() || testingKey}
                    className="px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-xs text-slate-300 hover:text-white transition cursor-pointer disabled:opacity-40"
                  >
                    {testingKey ? t('testingKey') : t('testKey')}
                  </button>
                  {keyResult && (
                    <span
                      className={`text-xs font-medium ${
                        keyOk === true ? 'text-emerald-400' : keyOk === false ? 'text-rose-400' : 'text-amber-400'
                      }`}
                    >
                      {keyResult}
                    </span>
                  )}
                </div>
              </div>

              {/* Default Model */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('defaultModel')}
                </label>
                <input
                  type="text"
                  value={newProvModel}
                  onChange={(e) => setNewProvModel(e.target.value)}
                  placeholder={DEFAULT_MODELS[newProvType]?.[0] || 'e.g. gpt-4o, claude-3-7-sonnet'}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              {/* Custom Base URL Endpoint */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('baseUrl')}
                </label>
                <input
                  type="text"
                  value={newProvBaseUrl}
                  onChange={(e) => setNewProvBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#141920] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2.5 pt-3 border-t border-white/[0.06]">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white cursor-pointer"
              >
                {t('cancel')}
              </button>
              <button
                disabled={!newProvKey.trim()}
                onClick={() => {
                  const cleanedKey = newProvKey.trim();
                  const targetModel = newProvModel.trim() || DEFAULT_MODELS[newProvType]?.[0] || `${newProvType}/default`;
                  const label = newProvName.trim() || PROVIDER_OPTIONS.find(([id]) => id === newProvType)?.[1] || newProvType;

                  if (editingProviderId) {
                    const targetProv = configuredProviders.find((p) => p.id === editingProviderId);
                    const isCurrentlyActive = targetProv?.provider === settings.provider;
                    updateConfiguredProvider(editingProviderId, {
                      provider: newProvType,
                      name: label,
                      apiKey: cleanedKey,
                      baseUrl: newProvBaseUrl.trim(),
                      defaultModel: targetModel,
                    });
                    if (isCurrentlyActive) {
                      updateSettings({
                        provider: newProvType,
                        apiKey: cleanedKey,
                        baseUrl: newProvBaseUrl.trim(),
                        modelId: targetModel,
                      });
                    }
                    showToast(`Updated ${label}`);
                  } else {
                    const newId = addConfiguredProvider({
                      provider: newProvType,
                      name: label,
                      apiKey: cleanedKey,
                      baseUrl: newProvBaseUrl.trim(),
                      defaultModel: targetModel,
                      enabled: true,
                      validated: true,
                    });
                    // Automatically activate if requested or first
                    activateProvider(newId);
                    showToast(`Added and activated ${label}`);
                  }
                  setShowAddModal(false);
                }}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold shadow-xs cursor-pointer transition"
              >
                {editingProviderId ? 'Save Changes' : 'Save & Enable'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
