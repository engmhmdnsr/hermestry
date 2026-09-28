import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Eye, EyeOff, Check, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  KNOWN_PROVIDERS,
  normProvider,
  KEYLESS_PROVIDERS,
} from '../../constants/providers';
import { redactSecrets } from '../../services/redaction';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import { parseInstallPhase } from '../../services/gatewayState';
import type { InstallPhase } from '../../services/gatewayState';

interface OnboardingWizardProps {
  onDone: () => void;
}

// Order of the real phases the native installer reports (mirrors
// Bootstrap.installPhaseForLine). DONE folds to "all complete".
const PHASE_ORDER: InstallPhase[] = ['CHECK_STORAGE', 'DOWNLOAD', 'VERIFY', 'EXTRACT', 'CONFIGURE'];

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onDone }) => {
  const {
    settings,
    saveKeys,
    install,
    installProgress,
    installError,
    gatewayLogs,
    connected,
    gatewayFailed,
    gatewayFailureReason,
    startGateway,
    installGateway,
    updateSettings,
    t,
  } = useHermes();

  // New copy may not exist in constants/languages yet: a missing key degrades
  // to the English fallback instead of printing the raw key.
  const tx = (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };

  // Resume: start on the step that matches the real install/connection state
  // so a run killed mid-flow (or an already-configured device) does not
  // re-offer the 305MB download. install/connected are the source of truth.
  const [step, setStep] = useState<number>(() => {
    if (connected) return 3;
    if (install === 'INSTALLED' || install === 'RUNNING') return 2;
    if (install === 'INSTALLING') return 1;
    return 0;
  });
  const stepRef = useRef(step);
  stepRef.current = step;

  const [launching, setLaunching] = useState(false);
  const [launchTried, setLaunchTried] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [skipArmed, setSkipArmed] = useState(false);
  const [showTg, setShowTg] = useState(false);
  // The install keeps running natively once started; Cancel only stops this
  // screen waiting. Track that so step 0 can offer "Show progress" again.
  const [installDismissed, setInstallDismissed] = useState(false);
  // Android back during an install asks once instead of closing the wizard.
  const [backConfirm, setBackConfirm] = useState(false);
  // Autostart policy text lives behind a disclosure, not in the 3-line box.
  const [showPolicy, setShowPolicy] = useState(false);

  // Keep the newest log line visible: the box has a fixed height, so without
  // this the user sees the first lines forever and thinks logging stopped.
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [gatewayLogs]);

  // Form inputs
  const [provider, setProvider] = useState(settings.provider || '');
  const [customProvider, setCustomProvider] = useState(false);
  const [apiKey, setApiKey] = useState(settings.apiKey || '');
  const [showKey, setShowKey] = useState(false);
  const [modelId, setModelId] = useState(settings.modelId || '');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || '');
  const [tgToken, setTgToken] = useState(settings.tgToken || '');
  const [bootRestart, setBootRestart] = useState(settings.autostart);

  // Reconcile the autostart toggle with the real setting: the buttons show
  // stored state, not just the last tap.
  useEffect(() => {
    setBootRestart(!!settings.autostart);
  }, [settings.autostart]);

  // Late resume: a previously-finished install that lands after mount (the
  // native poll loop reports INSTALLED) moves off the welcome step.
  useEffect(() => {
    if (install === 'INSTALLED' && stepRef.current === 0) setStep(1);
  }, [install]);

  // Launch failure surface: startGateway() returning is not success; the
  // gateway machine reports via gatewayFailed/gatewayFailureReason.
  useEffect(() => {
    if (step === 3 && launchTried && !launching && !connected && gatewayFailed) {
      setLaunchError(gatewayFailureReason || t('wizardLaunchFailed'));
    }
  }, [step, launchTried, launching, connected, gatewayFailed, gatewayFailureReason, t]);

  const normed = normProvider(provider);
  const effectiveProvider = customProvider ? provider.trim() || normed : normed;
  const isKnown = KNOWN_PROVIDERS.has(normProvider(effectiveProvider));
  const isKeyless = KEYLESS_PROVIDERS.has(normProvider(effectiveProvider));

  const saveBlockReason: string | null = (() => {
    if (!customProvider && !provider) return t('providerRequired');
    if (customProvider && !provider.trim()) return t('customProviderRequired');
    if (!apiKey.trim() && !isKeyless) return t('keyRequired');
    if (!isKnown && !baseUrl.trim()) return t('customUrlRequired');
    return null;
  })();
  const canSave = !saveBlockReason;
  const isInstalling = install === 'INSTALLING';

  // Real install phase, read from the streamed native install log lines via
  // the repository's phase parser, plus the real percentage the context
  // already reports in installProgress.
  const installPhase = useMemo<InstallPhase | null>(() => {
    for (let i = gatewayLogs.length - 1; i >= 0; i--) {
      const p = parseInstallPhase(gatewayLogs[i]);
      if (p) return p;
    }
    return null;
  }, [gatewayLogs]);

  const installPercent = useMemo(() => {
    const m = /\((\d+)%\)/.exec(installProgress || '');
    return m ? Math.min(100, Math.max(0, Number(m[1]))) : null;
  }, [installProgress]);

  const phaseLabel = (p: InstallPhase): string => {
    switch (p) {
      case 'CHECK_STORAGE':
        return tx('phaseCheckStorage', 'Checking storage');
      case 'DOWNLOAD':
        return tx('phaseDownload', 'Downloading runtime image');
      case 'VERIFY':
        return tx('phaseVerify', 'Verifying checksum');
      case 'EXTRACT':
        return tx('phaseExtract', 'Extracting runtime layers');
      case 'CONFIGURE':
        return tx('phaseConfigure', 'Writing gateway config');
      default:
        return tx('phaseDone', 'Finishing up');
    }
  };
  const phaseIdx = installPhase === 'DONE' ? PHASE_ORDER.length : installPhase ? PHASE_ORDER.indexOf(installPhase) : -1;

  const handleLaunch = async () => {
    if (launching) return;
    setLaunching(true);
    setLaunchTried(true);
    setLaunchError(null);
    try {
      await startGateway();
    } finally {
      setLaunching(false);
    }
    // No unconditional onboard here: the Finish step completes onboarding on
    // real health, and the failure-effect surfaces the reason.
  };

  const finishOnboarding = () => {
    updateSettings({ onboarded: true });
    onDone();
  };

  const handleSkip = () => {
    // Offline skip is a deliberate two-tap confirm, never silent: the first
    // tap arms and explains that chats stay dead until the gateway starts.
    if (!skipArmed) {
      setSkipArmed(true);
      return;
    }
    finishOnboarding();
  };

  // Start the real one-shot image install. Step 1 shows size, duration and
  // the live phases while it runs.
  const startInstall = () => {
    if (install === 'INSTALLING') return;
    setInstallDismissed(false);
    setStep(1);
    installGateway();
  };

  // Cancel: there is no native cancel API, so the on-device install cannot be
  // stopped from here. This stops the screen waiting and returns to the
  // welcome step; the install keeps running and the wizard resumes from real
  // state when it lands.
  const handleCancelInstall = () => {
    setInstallDismissed(true);
    setStep(0);
  };

  // Persist credentials the moment they are entered, through the same write
  // path the Settings tab uses. updateSettings persists and, on the APK,
  // mirrors the provider/key into the native prefs. This is what stops a
  // WebView kill from losing the key. The key value is never logged.
  const persistEnteredCredentials = () => {
    const p = customProvider ? provider.trim() : normProvider(provider);
    const patch: {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      modelId?: string;
      tgToken?: string;
    } = {};
    if (p) patch.provider = p;
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    if (baseUrl.trim()) patch.baseUrl = baseUrl.trim();
    if (modelId.trim()) patch.modelId = modelId.trim();
    if (tgToken.trim()) patch.tgToken = tgToken.trim();
    if (Object.keys(patch).length === 0) return;
    try {
      updateSettings(patch);
    } catch {
      // updateSettings reports failures through settingsSaveError, never to
      // the caller; nothing to add here.
    }
  };

  // Autostart: the same settings write path the Settings tab uses.
  // updateSettings persists the choice and, on the APK, calls
  // nativeSetAutostart internally to mirror it into the prefs BootReceiver
  // reads. The choice is therefore real, never silently ignored.
  const applyAutostart = (next: boolean) => {
    setBootRestart(next);
    updateSettings({ autostart: next });
  };

  const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

  const handleBack = () => {
    if (install === 'INSTALLING' && !installDismissed) {
      // Never kill the app mid-install and never exit silently: ask once.
      setBackConfirm(true);
      return;
    }
    if (step > 0) {
      setStep(step - 1);
      return;
    }
    // Step 0: same two-tap guard as the skip link, never a silent exit.
    handleSkip();
  };

  // Full-screen overlay: Android back and Escape go through handleBack instead
  // of closing the app. trapFocus stays off (this is a page, not a modal).
  const overlayRef = useOverlayBehavior(true, handleBack, undefined, {
    escape: true,
    backButton: true,
    trapFocus: false,
  });

  const stepLabel =
    step === 0
      ? t('stepWelcome')
      : step === 1
        ? t('stepEnvironment')
        : step === 2
          ? t('stepCredentials')
          : t('stepStart');

  return (
    <div
      ref={overlayRef}
      className="min-h-[100dvh] w-full overflow-y-auto overflow-x-hidden bg-[var(--app-bg,#090B0E)] text-slate-200"
    >
      <div
        className="max-w-lg mx-auto flex flex-col justify-start"
        style={{
          padding: '1.5rem',
          paddingTop: 'calc(1.5rem + env(safe-area-inset-top, 0px))',
          paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        {/* Step indicators, driven by the real current step. */}
        <div className="mb-6 pt-2">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2 font-medium">
            <span>
              {t('stepWord')} {step + 1} {t('ofWord')} 4
            </span>
            <span>{stepLabel}</span>
          </div>

          <div
            className="flex items-center gap-2"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={4}
            aria-valuenow={step + 1}
            aria-label={`${t('stepWord')} ${step + 1} ${t('ofWord')} 4: ${stepLabel}`}
          >
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                  i <= step ? 'bg-indigo-500' : 'bg-white/[0.08]'
                }`}
              />
            ))}
          </div>
          {step === 3 && connected && (
            <p className="mt-2 text-[11px] text-emerald-400 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" />
              {tx('wizardGatewayRunning', 'Gateway is running. You are ready to go.')}
            </p>
          )}
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col justify-between">
          {step === 0 && (
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-500/20 to-teal-500/20 border border-indigo-500/30 flex items-center justify-center mb-4 shadow-sm">
                <Sparkles className="w-6 h-6 text-indigo-400" />
              </div>

              <h1 className="text-2xl font-bold text-white tracking-tight">
                {t('welcomeTitle')}
              </h1>

              <p className="text-sm text-slate-400 leading-relaxed">
                {t('welcomeDesc')}
              </p>

              <div className="p-4 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] space-y-2 mt-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>{t('zeroTelemetry')}</span>
                </div>
                <p className="text-xs text-slate-400">
                  {t('zeroTelemetryDesc')}
                </p>
              </div>

              {/* Honest scope before the tap: size and duration, not a surprise. */}
              <div className="p-3.5 rounded-2xl bg-indigo-500/[0.06] border border-indigo-500/20 text-xs text-slate-300 leading-relaxed">
                {tx(
                  'installSizeNote',
                  'This downloads about 305 MB and can take several minutes on a mobile connection. Keep the app open until it finishes.'
                )}
              </div>

              {installDismissed && install === 'INSTALLING' && (
                <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 leading-relaxed space-y-2">
                  <p>
                    {tx(
                      'installRunningBackground',
                      'The environment setup is still running in the background. You can come back to watch it.'
                    )}
                  </p>
                  <button
                    onClick={() => {
                      setInstallDismissed(false);
                      setStep(1);
                    }}
                    className="min-h-[44px] px-3 rounded-xl bg-amber-500/20 text-amber-200 font-medium cursor-pointer"
                  >
                    {tx('showInstallProgress', 'Show progress')}
                  </button>
                </div>
              )}

              <div className="pt-4 space-y-2">
                <button
                  onClick={startInstall}
                  disabled={isInstalling}
                  aria-disabled={isInstalling}
                  className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-semibold text-sm transition shadow-sm cursor-pointer flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-wait"
                >
                  <span>{isInstalling ? tx('installInProgress', 'Setup in progress') : tx('startSetup', 'Start setup')}</span>
                  <ArrowRight className="w-4 h-4 rtl-flip" />
                </button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">
                  {t('preparingEnv')}
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  {install === 'INSTALLING' && t('installingMsg')}
                  {install === 'INSTALLED' && t('installedMsg')}
                  {install === 'FAILED' && t('failedMsg')}
                </p>
              </div>

              {install === 'INSTALLING' && (
                <>
                  {/* Real phases the native installer reports, plus a
                      determinate bar when the download percentage is known.
                      No fake indeterminate animation. */}
                  {phaseIdx >= 0 && (
                    <ul className="space-y-1.5">
                      {PHASE_ORDER.map((p, i) => {
                        const done = i < phaseIdx;
                        const active = i === phaseIdx;
                        return (
                          <li
                            key={p}
                            className={`flex items-center gap-2 text-xs ${
                              active ? 'text-teal-300 font-medium' : done ? 'text-slate-300' : 'text-slate-500'
                            }`}
                          >
                            <span className="w-4 flex justify-center">
                              {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : active ? <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" /> : <span className="w-1.5 h-1.5 rounded-full bg-white/[0.12]" />}
                            </span>
                            <span>{phaseLabel(p)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {installPercent !== null && (installPhase === null || installPhase === 'DOWNLOAD') ? (
                    <div
                      className="w-full bg-white/[0.06] h-1.5 rounded-full overflow-hidden"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={installPercent}
                      aria-label={t('installingMsg')}
                    >
                      <div
                        className="bg-indigo-500 h-full rounded-full transition-all duration-300"
                        style={{ width: `${installPercent}%` }}
                      />
                    </div>
                  ) : null}

                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    {tx(
                      'installSizeNote',
                      'This downloads about 305 MB and can take several minutes on a mobile connection. Keep the app open until it finishes.'
                    )}
                  </p>
                </>
              )}

              {installProgress && (
                <p role="status" className="text-xs font-mono text-teal-400">{redactSecrets(installProgress)}</p>
              )}

              <div className="rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] p-3.5 h-52 overflow-y-auto overflow-x-hidden font-mono text-xs text-slate-400 space-y-1" ref={logBoxRef}>
                {gatewayLogs.slice(-200).map((log, i) => (
                  <div key={`${gatewayLogs.length - 200 + i}`} className="leading-relaxed break-words whitespace-pre-wrap">
                    {redactSecrets(log)}
                  </div>
                ))}
              </div>

              <div className="pt-4 space-y-2">
                {install === 'INSTALLED' && (
                  <button
                    onClick={() => setStep(2)}
                    className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer"
                  >
                    {t('continueCredentials')}
                  </button>
                )}
                {install === 'INSTALLING' && (
                  <button
                    onClick={handleCancelInstall}
                    className="w-full min-h-[44px] inline-flex items-center justify-center text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
                  >
                    {tx('cancelSetup', 'Cancel and continue in the background')}
                  </button>
                )}
                {install === 'FAILED' && (
                  <div className="space-y-3">
                    <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed">
                      {installError
                        ? redactSecrets(installError)
                        : tx('installFailedGeneric', 'Setup did not finish. Check your connection and free storage, then tap Retry.')}
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      {tx('installRetryHint', 'Retry resumes the download instead of starting over.')}
                    </p>
                    <button
                      onClick={() => {
                        if (isInstalling) return;
                        installGateway();
                      }}
                      disabled={isInstalling}
                      className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                    >
                      {t('retrySetup')}
                    </button>
                  </div>
                )}
                <button
                  onClick={() => setStep(0)}
                  className="w-full min-h-[44px] inline-flex items-center justify-center text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
                >
                  {t('back')}
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">
                  {t('modelCredentials')}
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  {t('modelCredentialsDesc')}
                </p>
              </div>

              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="ob-provider" className="block text-xs font-medium text-slate-400">
                      {t('providerLabel')}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        // Never carry a stale id across modes: a selected slug
                        // is not a valid custom id and vice versa.
                        setCustomProvider(!customProvider);
                        setProvider('');
                      }}
                      aria-pressed={customProvider}
                      className={`px-3 min-h-[44px] py-1 rounded-lg text-[11px] font-medium transition cursor-pointer ${
                        customProvider
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white/[0.04] text-slate-400 hover:text-white'
                      }`}
                    >
                      {customProvider ? t('customOn') : t('customOff')}
                    </button>
                  </div>
                  {customProvider ? (
                    <input
                      id="ob-provider"
                      type="text"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                      onBlur={persistEnteredCredentials}
                      placeholder="e.g. my-proxy"
                      dir="ltr"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                    />
                  ) : (
                    <select
                      id="ob-provider"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                      onBlur={persistEnteredCredentials}
                      dir="ltr"
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">{t('selectProvider')}</option>
                      {PROVIDER_OPTIONS.map(([id, name]) => (
                        <option key={id} value={id}>
                          {name} ({id})
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label htmlFor="ob-apikey" className="block text-xs font-medium text-slate-400 mb-1">
                    {t('apiKey')} {isKeyless ? t('optionalLocal') : '*'}
                  </label>
                  <div className="relative">
                    <input
                      id="ob-apikey"
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      onBlur={persistEnteredCredentials}
                      placeholder="sk-..."
                      dir="ltr"
                      autoComplete="off"
                      className="w-full px-3.5 py-2.5 pe-10 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      aria-label={showKey ? t('hideToken') : t('showToken')}
                      aria-pressed={showKey}
                      className="absolute end-2 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-white"
                    >
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="ob-baseurl" className="block text-xs font-medium text-slate-400 mb-1">
                    {t('baseUrl')}{(customProvider || !isKnown) ? ' *' : ` ${t('optionalSuffix')}`}
                  </label>
                  <input
                    id="ob-baseurl"
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    onBlur={persistEnteredCredentials}
                    placeholder="https://api.openai.com/v1"
                    dir="ltr"
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <label htmlFor="ob-model" className="block text-xs font-medium text-slate-400 mb-1">
                    {t('modelLabel')} {t('optionalSuffix')}
                  </label>
                  <input
                    id="ob-model"
                    type="text"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    onBlur={persistEnteredCredentials}
                    placeholder="e.g. deepseek-chat, gpt-4o, claude-3-5-sonnet"
                    dir="ltr"
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <label htmlFor="ob-tgtoken" className="block text-xs font-medium text-slate-400 mb-1">
                    {t('telegramBridge')} {t('optionalSuffix')}
                  </label>
                  <div className="relative">
                    <input
                      id="ob-tgtoken"
                      type={showTg ? 'text' : 'password'}
                      value={tgToken}
                      onChange={(e) => setTgToken(e.target.value)}
                      onBlur={persistEnteredCredentials}
                      placeholder="bot123456:ABC-DEF..."
                      dir="ltr"
                      autoComplete="off"
                      className="w-full px-3.5 py-2.5 pe-10 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTg(!showTg)}
                      aria-label={showTg ? t('hideToken') : t('showToken')}
                      aria-pressed={showTg}
                      className="absolute end-2 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-white"
                    >
                      {showTg ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="pt-4 space-y-2">
                {saveBlockReason && (
                  <p role="status" className="text-[11px] text-amber-400">{saveBlockReason}</p>
                )}
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {tx('credentialsSavedHint', 'Your key is saved as you type, so setup can resume if the app closes.')}
                </p>
                <button
                  disabled={!canSave}
                  aria-disabled={!canSave}
                  onClick={() => {
                    if (!canSave) return;
                    saveKeys(effectiveProvider, apiKey, modelId, baseUrl, tgToken, settings.discordToken, settings.serverKey, bootRestart);
                    setStep(3);
                  }}
                  className={`w-full py-3.5 rounded-2xl font-semibold text-sm transition cursor-pointer ${
                    canSave
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs'
                      : 'bg-white/[0.04] text-slate-600 cursor-not-allowed'
                  }`}
                >
                  {t('saveContinue')}
                </button>
                <button
                  onClick={() => setStep(1)}
                  className="w-full min-h-[44px] inline-flex items-center justify-center text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
                >
                  {t('back')}
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">
                  {t('launchGateway')}
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  {t('launchGatewayDesc')}
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-white">{t('autostartTitle')}?</p>
                  <span
                    className={`text-[11px] font-medium ${settings.autostart ? 'text-emerald-400' : 'text-slate-500'}`}
                    role="status"
                  >
                    {settings.autostart ? t('autostartEnabled') : t('autostartDisabled')}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {tx('autostartWizardShort', 'Start the local gateway automatically when the app opens.')}
                </p>
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => applyAutostart(true)}
                    aria-pressed={bootRestart}
                    className={`flex-1 min-h-[44px] py-2 rounded-xl text-xs font-medium cursor-pointer transition ${
                      bootRestart
                        ? 'bg-indigo-600 text-white font-semibold'
                        : 'bg-white/[0.04] text-slate-400'
                    }`}
                  >
                    {t('enable')}
                  </button>
                  <button
                    onClick={() => applyAutostart(false)}
                    aria-pressed={!bootRestart}
                    className={`flex-1 min-h-[44px] py-2 rounded-xl text-xs font-medium cursor-pointer transition ${
                      !bootRestart
                        ? 'bg-indigo-600 text-white font-semibold'
                        : 'bg-white/[0.04] text-slate-400'
                    }`}
                  >
                    {t('skip')}
                  </button>
                </div>
                {/* Policy detail lives behind a disclosure, not in the box. */}
                <button
                  type="button"
                  onClick={() => setShowPolicy(!showPolicy)}
                  aria-expanded={showPolicy}
                  className="min-h-[44px] inline-flex items-center text-[11px] text-indigo-300 underline cursor-pointer"
                >
                  {tx('autostartPolicyTitle', 'How auto-launch behaves')}
                </button>
                {showPolicy && (
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    {t('autostartWizardDesc')} {' '}
                    {tx(
                      'autostartPolicyNote',
                      'Android may still start the app fresh after a reboot or a battery-optimization kill; auto-launch only controls the local gateway, never what the app can reach.'
                    )}
                  </p>
                )}
              </div>

              <div className="pt-6 space-y-3">
                {launchError && (
                  <div role="alert" className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed">
                    {redactSecrets(launchError)}
                  </div>
                )}

                {connected ? (
                  <button
                    onClick={finishOnboarding}
                    className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow-xs"
                  >
                    <Check className="w-4 h-4" />
                    <span>{tx('finishSetup', 'Finish setup')}</span>
                  </button>
                ) : (
                  <button
                    onClick={handleLaunch}
                    disabled={launching}
                    aria-disabled={launching}
                    className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow-xs disabled:opacity-60 disabled:cursor-wait"
                  >
                    <Check className="w-4 h-4" />
                    <span>{launching ? tx('launching', 'Launching...') : t('launchHermes')}</span>
                  </button>
                )}

                {skipArmed && (
                  <div role="alert" className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 leading-relaxed">
                    {isOffline ? t('skipConfirmOffline') : t('skipConfirmOnline')}
                  </div>
                )}
                <button
                  onClick={handleSkip}
                  className="w-full min-h-[44px] inline-flex items-center justify-center text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
                >
                  {t('skipWorkspace')}
                </button>

                <button
                  onClick={() => setStep(2)}
                  className="w-full min-h-[44px] inline-flex items-center justify-center text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
                >
                  {t('back')}
                </button>
              </div>
            </div>
          )}
        </div>

        {backConfirm && (
          <div role="alert" className="fixed inset-x-4 bottom-4 p-3.5 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-xs text-amber-200 leading-relaxed max-w-lg mx-auto">
            {tx(
              'installBackBlocked',
              'Setup is still running. Leaving now stops this screen, not the install itself, so it is safer to wait. Press back again after setup finishes.'
            )}
          </div>
        )}
      </div>
    </div>
  );
};
