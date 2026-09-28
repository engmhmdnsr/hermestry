import React, { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Check, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  KNOWN_PROVIDERS,
  normProvider,
  KEYLESS_PROVIDERS,
} from '../../constants/providers';
import { redactSecrets } from '../../services/redaction';

interface OnboardingWizardProps {
  onDone: () => void;
}

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

  const [step, setStep] = useState<number>(install === 'INSTALLED' ? 2 : 0);
  // Launch/skip guards. startGateway() resolves void, so success is read
  // from connected/gatewayFailed state , never assumed from resolution.
  const [launching, setLaunching] = useState(false);
  const [launchTried, setLaunchTried] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [skipArmed, setSkipArmed] = useState(false);
  const [showTg, setShowTg] = useState(false);

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

  useEffect(() => {
    if (connected && step === 3) {
      updateSettings({ onboarded: true });
      onDone();
    }
  }, [connected, step, onDone, updateSettings]);

  // Launch failure surface: startGateway() returning is not success , the
  // gateway machine reports via gatewayFailed/gatewayFailureReason.
  useEffect(() => {
    if (step === 3 && launchTried && !launching && !connected && gatewayFailed) {
      setLaunchError(
        gatewayFailureReason ||
          'Gateway start failed: health check did not pass. See the log or press Skip to open the workspace offline.'
      );
    }
  }, [step, launchTried, launching, connected, gatewayFailed, gatewayFailureReason]);

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
  // Single gate: the button enables exactly when there is no block reason.
  // (keysValid() defaults an empty provider to deepseek, so gating on it
  // alone would let provider:'' through , saveBlockReason is the source.)
  const canSave = !saveBlockReason;
  // Captured before JSX narrowing so guarded buttons can reuse it inside
  // narrowed blocks (e.g. install === 'FAILED').
  const isInstalling = install === 'INSTALLING';

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
    // No unconditional onboard here: the connected-effect above completes
    // onboarding on real health; the failure-effect surfaces the reason.
  };

  const handleSkip = () => {
    // Offline skip is a deliberate two-tap confirm, never silent.
    if (typeof navigator !== 'undefined' && !navigator.onLine && !skipArmed) {
      setSkipArmed(true);
      return;
    }
    updateSettings({ onboarded: true });
    onDone();
  };

  return (
    <div className="min-h-screen bg-[var(--app-bg,#090B0E)] text-slate-200 p-6 max-w-lg mx-auto flex flex-col justify-start">
      {/* Step Indicators */}
      <div className="mb-6 pt-4">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-2 font-medium">
          <span>{t('stepWord')} {step + 1} {t('ofWord')} 4</span>
          <span>
            {step === 0 && t('stepWelcome')}
            {step === 1 && t('stepEnvironment')}
            {step === 2 && t('stepCredentials')}
            {step === 3 && t('stepStart')}
          </span>
        </div>

        <div className="flex items-center gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                i <= step ? 'bg-indigo-500' : 'bg-white/[0.08]'
              }`}
            />
          ))}
        </div>
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

            <div className="pt-8">
              <button
                onClick={() => {
                  if (install === 'INSTALLING') return;
                  setStep(1);
                  installGateway();
                }}
                disabled={install === 'INSTALLING'}
                aria-disabled={install === 'INSTALLING'}
                className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-semibold text-sm transition shadow-sm cursor-pointer flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-wait"
              >
                <span>{t('continue')}</span>
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
                <style>{`@keyframes wizard-indeterminate { 0% { transform: translateX(-100%);} 100% { transform: translateX(300%);} }`}</style>
                <div
                  className="w-full bg-white/[0.06] h-1.5 rounded-full overflow-hidden"
                  role="progressbar"
                  aria-label={t('installingMsg')}
                >
                  <div
                    className="bg-indigo-500 h-full w-1/3 rounded-full"
                    style={{ animation: 'wizard-indeterminate 1.4s ease-in-out infinite' }}
                  />
                </div>
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

            <div className="pt-4">
              {install === 'INSTALLED' && (
                <button
                  onClick={() => setStep(2)}
                  className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer"
                >
                  {t('continueCredentials')}
                </button>
              )}
              {install === 'FAILED' && (
                <div className="space-y-3">
                  {installError && (
                    <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed">
                      {redactSecrets(installError)}
                    </div>
                  )}
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
                    placeholder="e.g. my-proxy"
                    dir="ltr"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                ) : (
                  <select
                    id="ob-provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
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
                    placeholder="sk-..."
                    dir="ltr"
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 pe-10 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
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
                    placeholder="bot123456:ABC-DEF..."
                    dir="ltr"
                    autoComplete="off"
                    className="w-full px-3.5 py-2.5 pe-10 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTg(!showTg)}
                    aria-label={showTg ? 'Hide Telegram token' : 'Show Telegram token'}
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
              <p className="text-xs font-semibold text-white">{t('autostartTitle')}?</p>
              <p className="text-xs text-slate-400">
                {t('autostartWizardDesc')}
              </p>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setBootRestart(true)}
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
                  onClick={() => setBootRestart(false)}
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
            </div>

            <div className="pt-6 space-y-3">
              {launchError && (
                <div role="alert" className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed">
                  {redactSecrets(launchError)}
                </div>
              )}
              <button
                onClick={handleLaunch}
                disabled={launching}
                aria-disabled={launching}
                className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow-xs disabled:opacity-60 disabled:cursor-wait"
              >
                <Check className="w-4 h-4" />
                <span>{launching ? t('installingMsg') : t('launchHermes')}</span>
              </button>

              {skipArmed && (
                <div role="alert" className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 leading-relaxed">
                  You appear to be offline and the gateway is not running. Press Skip again to open the workspace anyway , chats will not work until the gateway starts.
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
    </div>
  );
};
