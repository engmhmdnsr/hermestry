import React, { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Check, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  KNOWN_PROVIDERS,
  normProvider,
  keysValid,
  KEYLESS_PROVIDERS,
} from '../../constants/providers';

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
    startGateway,
    installGateway,
    updateSettings,
    t,
  } = useHermes();

  const [step, setStep] = useState<number>(install === 'INSTALLED' ? 2 : 0);

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

  const normed = normProvider(provider);
  const effectiveProvider = customProvider ? provider.trim() || normed : normed;
  const isKnown = KNOWN_PROVIDERS.has(normProvider(effectiveProvider));
  const isKeyless = KEYLESS_PROVIDERS.has(normProvider(effectiveProvider));
  const isKeyValid = keysValid(effectiveProvider, apiKey, baseUrl);

  const saveBlockReason: string | null = (() => {
    if (!customProvider && !provider) return t('providerRequired');
    if (customProvider && !provider.trim()) return t('customProviderRequired');
    if (!apiKey.trim() && !isKeyless) return t('keyRequired');
    if (!isKnown && !baseUrl.trim()) return t('customUrlRequired');
    return null;
  })();

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

        <div className="flex items-center gap-2">
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
                  setStep(1);
                  installGateway();
                }}
                className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.99] text-white font-semibold text-sm transition shadow-sm cursor-pointer flex items-center justify-center gap-2"
              >
                <span>{t('continue')}</span>
                <ArrowRight className="w-4 h-4" />
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
              <div className="w-full bg-white/[0.06] h-1.5 rounded-full overflow-hidden">
                <div className="bg-indigo-500 h-full w-2/3 animate-pulse rounded-full" />
              </div>
            )}

            {installProgress && (
              <p className="text-xs font-mono text-teal-400">{installProgress}</p>
            )}

            <div className="rounded-2xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] p-3.5 h-52 overflow-y-auto overflow-x-hidden font-mono text-xs text-slate-400 space-y-1" ref={logBoxRef}>
              {gatewayLogs.slice(-200).map((log, i) => (
                <div key={`${gatewayLogs.length - 200 + i}`} className="leading-relaxed break-words whitespace-pre-wrap">
                  {log}
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
                      {installError}
                    </div>
                  )}
                  <button
                    onClick={() => installGateway()}
                    className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer"
                  >
                    {t('retrySetup')}
                  </button>
                </div>
              )}
              <button
                onClick={() => setStep(0)}
                className="w-full text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
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
                  <label className="block text-xs font-medium text-slate-400">
                    {t('providerLabel')}
                  </label>
                  <button
                    type="button"
                    onClick={() => setCustomProvider(!customProvider)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition cursor-pointer ${
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
                    type="text"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="e.g. my-proxy"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                ) : (
                  <select
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
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('apiKey')} {isKeyless ? t('optionalLocal') : '*'}
                </label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('baseUrl')}{(customProvider || !isKnown) ? ' *' : ` ${t('optionalSuffix')}`}
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('modelLabel')} {t('optionalSuffix')}
                </label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="e.g. deepseek-chat, gpt-4o, claude-3-5-sonnet"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {t('telegramBridge')} {t('optionalSuffix')}
                </label>
                <input
                  type="password"
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                  placeholder="bot123456:ABC-DEF..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--app-card,#0E1217)] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
            </div>

            <div className="pt-4 space-y-2">
              {saveBlockReason && (
                <p className="text-[11px] text-amber-400">{saveBlockReason}</p>
              )}
              <button
                disabled={!isKeyValid}
                onClick={() => {
                  saveKeys(effectiveProvider, apiKey, modelId, baseUrl, tgToken, settings.discordToken, settings.serverKey, bootRestart);
                  setStep(3);
                }}
                className={`w-full py-3.5 rounded-2xl font-semibold text-sm transition cursor-pointer ${
                  isKeyValid
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs'
                    : 'bg-white/[0.04] text-slate-600 cursor-not-allowed'
                }`}
              >
                {t('saveContinue')}
              </button>
              <button
                onClick={() => setStep(1)}
                className="w-full text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
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
                  className={`flex-1 py-2 rounded-xl text-xs font-medium cursor-pointer transition ${
                    bootRestart
                      ? 'bg-indigo-600 text-white font-semibold'
                      : 'bg-white/[0.04] text-slate-400'
                  }`}
                >
                  {t('enable')}
                </button>
                <button
                  onClick={() => setBootRestart(false)}
                  className={`flex-1 py-2 rounded-xl text-xs font-medium cursor-pointer transition ${
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
              <button
                onClick={async () => {
                  await startGateway();
                  updateSettings({ onboarded: true });
                  onDone();
                }}
                className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition cursor-pointer flex items-center justify-center gap-2 shadow-xs"
              >
                <Check className="w-4 h-4" />
                <span>{t('launchHermes')}</span>
              </button>

              <button
                onClick={() => {
                  updateSettings({ onboarded: true });
                  onDone();
                }}
                className="w-full text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
              >
                {t('skipWorkspace')}
              </button>

              <button
                onClick={() => setStep(2)}
                className="w-full text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
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
