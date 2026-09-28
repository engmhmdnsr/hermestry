import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Check, AlertCircle, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  KNOWN_PROVIDERS,
  normProvider,
  keysValid,
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
  } = useHermes();

  const [step, setStep] = useState<number>(install === 'INSTALLED' ? 2 : 0);

  // Form inputs
  const [provider, setProvider] = useState(settings.provider || 'deepseek');
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
  const isKnown = KNOWN_PROVIDERS.has(normed);
  const isKeyValid = keysValid(provider, apiKey, baseUrl);

  return (
    <div className="min-h-screen bg-[#090B0E] text-slate-200 p-6 max-w-lg mx-auto flex flex-col justify-start">
      {/* Step Indicators */}
      <div className="mb-6 pt-4">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-2 font-medium">
          <span>Step {step + 1} of 4</span>
          <span>
            {step === 0 && 'Welcome'}
            {step === 1 && 'Environment'}
            {step === 2 && 'API Credentials'}
            {step === 3 && 'Start Daemon'}
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
              Welcome to Hermes Mobile
            </h1>

            <p className="text-sm text-slate-400 leading-relaxed">
              Hermes Mobile gives you a native on-device gateway experience with streaming tool executions, reasoning accordions, autonomous scheduled cron jobs, and multi-model access.
            </p>

            <div className="p-4 rounded-2xl bg-[#0E1217] border border-white/[0.08] space-y-2 mt-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Zero-Cloud Telemetry</span>
              </div>
              <p className="text-xs text-slate-400">
                Your keys, chat histories, and cron triggers stay strictly on your device.
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
                <span>Continue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Preparing Gateway Environment
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                {install === 'INSTALLING' && 'Unpacking runtime layers and configuring daemon sockets…'}
                {install === 'INSTALLED' && 'Environment verified and ready.'}
                {install === 'FAILED' && 'An error occurred during verification.'}
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

            <div className="rounded-2xl bg-[#0E1217] border border-white/[0.08] p-3.5 h-52 overflow-y-auto font-mono text-xs text-slate-400 space-y-1">
              {gatewayLogs.slice(-20).map((log, i) => (
                <div key={i} className="leading-relaxed">
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
                  Continue to Credentials
                </button>
              )}
              {install === 'FAILED' && (
                <button
                  onClick={() => installGateway()}
                  className="w-full py-3.5 rounded-2xl bg-indigo-600 text-white font-semibold text-sm transition cursor-pointer"
                >
                  Retry Setup
                </button>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Model Credentials
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Select your preferred LLM provider and enter your API key.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Provider
                </label>
                <select
                  value={normed}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#0E1217] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  {PROVIDER_OPTIONS.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name} ({id})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  API Key *
                </label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[#0E1217] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
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
                  Model Identifier (optional)
                </label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="e.g. deepseek-chat, gpt-4o, claude-3-5-sonnet"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#0E1217] border border-white/[0.08] text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
            </div>

            <div className="pt-4">
              <button
                disabled={!isKeyValid}
                onClick={() => {
                  saveKeys(provider, apiKey, modelId, baseUrl, tgToken, settings.discordToken, settings.serverKey, bootRestart);
                  setStep(3);
                }}
                className={`w-full py-3.5 rounded-2xl font-semibold text-sm transition cursor-pointer ${
                  isKeyValid
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs'
                    : 'bg-white/[0.04] text-slate-600 cursor-not-allowed'
                }`}
              >
                Save and Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Launch On-Device Gateway
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Start the local socket daemon to begin processing conversations.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-[#0E1217] border border-white/[0.08] space-y-2">
              <p className="text-xs font-semibold text-white">Auto-launch on startup?</p>
              <p className="text-xs text-slate-400">
                With this enabled, the gateway initializes automatically when the app loads.
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
                  Enable
                </button>
                <button
                  onClick={() => setBootRestart(false)}
                  className={`flex-1 py-2 rounded-xl text-xs font-medium cursor-pointer transition ${
                    !bootRestart
                      ? 'bg-indigo-600 text-white font-semibold'
                      : 'bg-white/[0.04] text-slate-400'
                  }`}
                >
                  Skip
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
                <span>Launch Hermes</span>
              </button>

              <button
                onClick={() => {
                  updateSettings({ onboarded: true });
                  onDone();
                }}
                className="w-full text-center text-xs text-slate-400 hover:text-white py-2 cursor-pointer transition"
              >
                Skip to Workspace
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
