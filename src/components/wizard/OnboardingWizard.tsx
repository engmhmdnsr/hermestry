import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Eye,
  EyeOff,
  Check,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  PROVIDER_OPTIONS,
  KNOWN_PROVIDERS,
  normProvider,
  KEYLESS_PROVIDERS,
} from '../../constants/providers';
import { redactSecrets } from '../../services/redaction';
import { plainGatewayFailure, plainResultLine } from '../../services/plainFailure';
import { useOverlayBehavior } from '../../hooks/useOverlayBehavior';
import { parseInstallPhase } from '../../services/gatewayState';
import type { InstallPhase } from '../../services/gatewayState';

interface OnboardingWizardProps {
  onDone: () => void;
}

// Order of the real phases the native installer reports (mirrors
// Bootstrap.installPhaseForLine). DONE folds to "all complete".
const PHASE_ORDER: InstallPhase[] = ['CHECK_STORAGE', 'DOWNLOAD', 'VERIFY', 'EXTRACT', 'CONFIGURE'];

// One input shape for the whole wizard: same radius, border, background and
// type scale as every other text field in the app.
const WIZARD_FIELD =
  'w-full px-3 min-h-[44px] r-sm edge bg-[var(--app-input-bg)] t-body text-[var(--app-text)] focus:outline-none transition';

// Secondary action: compact, sits beside the primary, never steals its width.
const WIZARD_SECONDARY =
  'min-h-[48px] px-4 r-sm shrink-0 inline-flex items-center justify-center gap-2 t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-[var(--app-card-hover)] cursor-pointer transition';

// Primary action: fills the remaining width so it lands on the outside edge of
// the row, inside thumb reach on a 360dp phone.
const WIZARD_PRIMARY =
  'flex-1 min-h-[48px] px-4 r-sm inline-flex items-center justify-center gap-2 t-body font-semibold transition cursor-pointer disabled:opacity-60 disabled:cursor-wait';

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onDone }) => {
  const hermes = useHermes();
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
  } = hermes;

  // A start timeout reports install === 'FAILED' as well, but the image is
  // already on the phone in that case, so "nothing was installed" would be
  // untrue. The context publishes the start cause beside the install state;
  // read it through a narrow cast so this screen still compiles against a
  // context build that has not published the field yet.
  const startFailureRaw = (hermes as unknown as { startFailure?: unknown }).startFailure;
  const startFailure =
    typeof startFailureRaw === 'string' && startFailureRaw.trim() ? startFailureRaw.trim() : null;

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
    // A failed run resumes where the cause and the control that acts on it
    // are both visible. Step 0 would only offer a plain "Start setup", which
    // hides why it failed and sends the user through a full re-setup.
    if (install === 'FAILED') return 1;
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
  // Prominent disclosure (Play Deceptive Behavior rule): nothing downloads
  // until the user reads what the 305MB image is and checks this box.
  const [discloseOk, setDiscloseOk] = useState(false);
  // Raw installer lines carry absolute paths and mirror URLs. The default
  // view is the plain phase list; the technical log is one disclosure away
  // for the case where the actual text is needed.
  const [showInstallLog, setShowInstallLog] = useState(false);

  // Raw installer output is a log line, not a sentence: on screen only a
  // line that survives plainResultLine is shown under the failure copy.
  const installErrorLine = installError
    ? plainResultLine(redactSecrets(installError), '', tx)
    : '';

  // Keep the newest log line visible: the box has a fixed height, so without
  // this the user sees the first lines forever and thinks logging stopped.
  // Re-runs when the disclosure opens too, so a log opened late starts at the
  // end instead of at lines that have long scrolled out of the stream.
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [gatewayLogs, showInstallLog]);

  // Phases the native installer has reported, in order, as plain labels. This
  // is what the step shows by default: parsing is done once per log update
  // rather than on every render, and the raw lines stay out of the flow.
  const plainLogPhases = useMemo(() => {
    const seen: InstallPhase[] = [];
    for (const line of gatewayLogs) {
      const phase = parseInstallPhase(line);
      if (phase && !seen.includes(phase)) seen.push(phase);
    }
    return seen;
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
      setLaunchError(
        gatewayFailureReason
          ? plainGatewayFailure(gatewayFailureReason, tx)
          : tx('launchFailedPlain', 'Hermes did not start. Nothing was changed, so your setup is intact. Check the log below, then try again.')
      );
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
        return tx('phaseDownloadPlain', 'Downloading files');
      case 'VERIFY':
        return tx('phaseVerifyPlain', 'Checking the download');
      case 'EXTRACT':
        return tx('phaseExtractPlain', 'Unpacking files');
      case 'CONFIGURE':
        return tx('phaseConfigurePlain', 'Saving settings');
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
    // Reached by going Back from the progress step on a finished install:
    // resume the flow instead of kicking off a second full image download.
    setInstallDismissed(false);
    setStep(1);
    // RUNNING means the gateway is already up (health can lag behind it), so
    // re-running the installer here would re-download over a running install.
    // A start failure is the same case: the image landed, so the resume step
    // offers Start rather than a second full download.
    if (install !== 'INSTALLED' && install !== 'RUNNING' && !startFailure) installGateway();
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

  // The two-tap exit guard is shared by the welcome step (where the hardware
  // back button and Escape arm it) and step 3's Skip button, so the same
  // confirm copy renders on both. Without it the welcome step's second back
  // press closed the wizard in silence.
  const skipConfirmBlock = skipArmed ? (
    <div
      role="alert"
      className="p-4 r-md bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] t-caption text-[var(--app-warning)]"
    >
      {isOffline
        ? tx(
            'skipConfirmOfflinePlain',
            'You appear to be offline and Hermes is not running. Tap Skip for now again to open the app anyway. Chats will not work until Hermes runs.',
          )
        : tx(
            'skipConfirmOnlinePlain',
            'Hermes is not running yet. Tap Skip for now again to open the app without it. Chats will not work until Hermes runs.',
          )}
    </div>
  ) : null;

  const skipButton = (
    <button
      onClick={handleSkip}
      className="w-full min-h-[44px] inline-flex items-center justify-center text-center t-caption text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer transition"
    >
      {tx('skipForNowPlain', 'Skip for now')}
    </button>
  );

  // Three signals must not outlive the condition that produced them: the
  // back-block notice once the install has stopped, a skip armed on a step the
  // user has since left, and a launch failure once the gateway answers.
  useEffect(() => {
    if (install !== 'INSTALLING') setBackConfirm(false);
  }, [install]);

  useEffect(() => {
    setSkipArmed(false);
  }, [step]);

  useEffect(() => {
    if (connected) setLaunchError(null);
  }, [connected]);

  const stepLabel =
    step === 0
      ? tx('stepWelcomePlain', 'Welcome')
      : step === 1
        ? tx('stepSetupPlain', 'Phone setup')
        : step === 2
          ? tx('stepKeysPlain', 'Your key')
          : tx('stepFinishPlain', 'Start Hermes');

  // One accent-filled progress track for the four wizard steps.
  const progressPercent = ((step + 1) / 4) * 100;

  return (
    <div
      ref={overlayRef}
      className="min-h-[100dvh] w-full overflow-y-auto overflow-x-hidden bg-[var(--app-bg)] text-[var(--app-text)]"
    >
      <div
        className="max-w-lg md:max-w-2xl mx-auto p-3 md:p-6"
        style={{
          paddingTop: 'calc(0.75rem + var(--safe-top))',
          paddingBottom: 'calc(0.75rem + var(--safe-bottom))',
        }}
      >
        {/* The wizard reads as one sheet: one radius, one edge, one depth. */}
        <div className="r-lg elev-3 edge bg-[var(--app-card)] p-4 space-y-6">
          {/* Step indicator: a stepper label pair over one accent track. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="t-caption text-[var(--app-text-muted)]">
                {t('stepWord')} {step + 1} {t('ofWord')} 4
              </span>
              <span className="t-caption font-semibold text-[var(--app-text)]">{stepLabel}</span>
            </div>

            <div
              className="h-1.5 w-full r-full bg-[var(--app-card-subtle)] overflow-hidden"
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={4}
              aria-valuenow={step + 1}
              aria-label={`${t('stepWord')} ${step + 1} ${t('ofWord')} 4: ${stepLabel}`}
            >
              <div
                className="h-full r-full bg-[var(--app-accent)] transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {step === 3 && connected && (
              <p className="t-caption text-[var(--app-success)] flex items-center gap-2">
                <Check className="w-3.5 h-3.5 shrink-0" />
                {tx('wizardRunningPlain', 'Hermes is running on this phone. You can start chatting.')}
              </p>
            )}
          </div>

          {/* Main Content Area */}
          <div className="flex-1 flex flex-col justify-between">
            {step === 0 && (
              <div className="space-y-4">
                <div className="w-12 h-12 r-md bg-[var(--app-accent-subtle)] border border-[var(--app-accent-border)] flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-[var(--app-accent-text)]" />
                </div>

                <h1 className="t-title text-[var(--app-text)]">{t('welcomeTitle')}</h1>

                <p className="t-body text-[var(--app-text-muted)]">
                  {tx(
                    'welcomeDescPlain',
                    'Chat with Hermes on this phone. It can run tools, show each step it takes, and work on a schedule while you are away.'
                  )}
                </p>

                <div className="p-4 r-md bg-[var(--app-card-subtle)] hairline space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[var(--app-success)] shrink-0" />
                    <span className="t-label text-[var(--app-text)]">{tx('privacyTitle', 'Your data stays on this phone')}</span>
                  </div>
                  <p className="t-caption text-[var(--app-text-muted)]">
                    {tx('privacyDescPlain', 'Your keys, chats, and scheduled tasks stay on this phone, not on our servers.')}
                  </p>
                </div>

                {/* Honest scope before the tap: size and duration, not a surprise. */}
                <div className="p-4 r-md bg-[var(--app-accent-subtle)] border border-[var(--app-accent-border)] t-caption text-[var(--app-text-muted)]">
                  {tx(
                    'installSizeNote',
                    'This downloads about 305 MB and can take several minutes on a mobile connection. Keep the app open until it finishes.'
                  )}
                </div>

                {/* Shown whenever the install is still running, not only after
                    Cancel: Back from the progress step also lands here, and
                    without this card that welcome screen shows only a disabled
                    "Setup in progress" button with no way back to progress. */}
                {install === 'INSTALLING' && (
                  <div className="p-4 r-md bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] space-y-3">
                    <p className="t-caption text-[var(--app-warning)]">
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
                      className="min-h-[44px] px-4 r-sm bg-[var(--app-card-subtle)] border border-[var(--app-warning-border)] t-caption font-semibold text-[var(--app-warning)] cursor-pointer transition"
                    >
                      {tx('showInstallProgress', 'Show progress')}
                    </button>
                  </div>
                )}

                {/* Prominent disclosure before any download: source, size,
                    hash check, local-only execution. The Start button stays
                    disabled until the box is checked. */}
                <div className="p-4 r-md bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] space-y-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[var(--app-warning)] shrink-0" />
                    <span className="t-label text-[var(--app-text)]">{tx('discloseTitle', 'What gets downloaded')}</span>
                  </div>
                  <p className="t-caption text-[var(--app-text-muted)]">
                    {tx(
                      'discloseBody',
                      'Setup downloads a verified 305 MB Linux environment (Debian plus Python plus the Hermes server) from the official Hermes releases page on GitHub. Its SHA-256 checksum is checked before anything runs, and setup stops if it does not match. The environment runs on your phone only, without root. Nothing runs until you tap Start setup.'
                    )}
                  </p>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={discloseOk}
                      onChange={(e) => setDiscloseOk(e.target.checked)}
                      className="mt-1 w-4 h-4 shrink-0 accent-[var(--app-accent)]"
                    />
                    <span className="t-caption font-semibold text-[var(--app-text)]">
                      {tx('discloseConsent', 'I understand and agree to this download')}
                    </span>
                  </label>
                </div>

                <div className="pt-4">
                  <button
                    onClick={startInstall}
                    disabled={isInstalling || !discloseOk}
                    aria-disabled={isInstalling || !discloseOk}
                    className={`${WIZARD_PRIMARY} w-full bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]`}
                  >
                    <span>
                      {isInstalling
                        ? tx('installInProgress', 'Setup in progress')
                        : tx('startSetup', 'Start setup')}
                    </span>
                    <ArrowRight className="w-4 h-4 rtl-flip" />
                  </button>
                </div>

                {/* Escape and the hardware back button both arm this two-tap
                    exit from the welcome step, so it needs the same visible
                    confirm and the same explicit control as step 3. */}
                <div className="pt-4 space-y-3">
                  {skipConfirmBlock}
                  {skipButton}
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <h2 className="t-title text-[var(--app-text)]">
                    {tx('preparingEnvPlain', 'Setting up Hermes on this phone')}
                  </h2>
                  <p className="t-body text-[var(--app-text-muted)] mt-1">
                    {install === 'INSTALLING' && tx('installingMsgPlain', 'Downloading about 305 MB and unpacking it. Keep this screen open.')}
                    {install === 'INSTALLED' && tx('installedMsgPlain', 'Setup finished. Your Hermes server is ready.')}
                    {install === 'RUNNING' && tx('installedMsgPlain', 'Setup finished. Your Hermes server is ready.')}
                    {install === 'FAILED' &&
                      (startFailure
                        ? tx('startFailedPlain', 'Could not start Hermes. Try again.')
                        : tx('failedMsgPlain', 'Setup failed. Nothing was installed, so nothing was lost. Press Retry to try again.'))}
                  </p>
                </div>

                {install === 'INSTALLING' && (
                  <>
                    {/* Real phases the native installer reports, as a vertical
                        stepper: done is success, active is accent, pending is
                        neutral. No fake indeterminate animation. */}
                    {phaseIdx >= 0 && (
                      <ul className="space-y-2">
                        {PHASE_ORDER.map((p, i) => {
                          const done = i < phaseIdx;
                          const active = i === phaseIdx;
                          return (
                            <li key={p} className="flex items-center gap-3 min-h-[32px]">
                              <span
                                className={done ? 'pill-success' : active ? 'pill-accent' : 'pill-neutral'}
                                aria-label={
                                  done
                                    ? tx('phaseStateDone', 'Done')
                                    : active
                                      ? tx('phaseStateActive', 'Active')
                                      : tx('phaseStatePending', 'Pending')
                                }
                              >
                                {done ? (
                                  <Check className="w-3 h-3" />
                                ) : (
                                  <span
                                    className={`w-1.5 h-1.5 r-full ${active ? 'bg-[var(--app-accent-text)]' : 'bg-[var(--app-text-dim)]'}`}
                                  />
                                )}
                                {done
                                  ? tx('phaseStateDone', 'Done')
                                  : active
                                    ? tx('phaseStateActive', 'Active')
                                    : tx('phaseStatePending', 'Pending')}
                              </span>
                              <span
                                className={`t-caption ${
                                  active || done
                                    ? 'text-[var(--app-text)]'
                                    : 'text-[var(--app-text-muted)]'
                                }`}
                              >
                                {phaseLabel(p)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {installPercent !== null && (installPhase === null || installPhase === 'DOWNLOAD') ? (
                      <div
                        className="w-full h-1.5 r-full bg-[var(--app-card-subtle)] overflow-hidden"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={installPercent}
                        aria-label={tx('installingMsgPlain', 'Downloading about 305 MB and unpacking it. Keep this screen open.')}
                      >
                        <div
                          className="h-full r-full bg-[var(--app-accent)] transition-all duration-300"
                          style={{ width: `${installPercent}%` }}
                        />
                      </div>
                    ) : null}

                    <p className="t-caption text-[var(--app-text-dim)]">
                      {tx(
                        'installSizeNote',
                        'This downloads about 305 MB and can take several minutes on a mobile connection. Keep the app open until it finishes.'
                      )}
                    </p>
                  </>
                )}

                {installProgress && (
                  <p role="status" className="t-caption font-mono text-[var(--app-accent-text)] break-words">
                    {redactSecrets(installProgress)}
                  </p>
                )}

                {/* Plain phase lines are the default surface. Raw installer
                    output carries absolute paths and mirror URLs, so it stays
                    behind a disclosure instead of in the reading flow. */}
                <div className="r-md bg-[var(--app-card-subtle)] hairline p-3 space-y-2">
                  <div role="status" aria-live="polite" className="space-y-1">
                    {plainLogPhases.length > 0 ? (
                      plainLogPhases.map((p) => (
                        <p key={p} className="t-caption text-[var(--app-text-muted)] leading-relaxed">
                          {phaseLabel(p)}
                        </p>
                      ))
                    ) : (
                      <p className="t-caption text-[var(--app-text-muted)]">
                        {tx('installInProgress', 'Setup in progress')}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowInstallLog((v) => !v)}
                    aria-expanded={showInstallLog}
                    className="min-h-[44px] inline-flex items-center gap-1 t-caption text-[var(--app-accent-text)] hover:text-[var(--app-accent-hover)] cursor-pointer transition"
                  >
                    {showInstallLog ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    <span>{tx('technicalDetails', 'Technical details')}</span>
                  </button>
                  {showInstallLog && (
                    <div
                      className="h-48 overflow-y-auto overflow-x-hidden font-mono t-caption text-[var(--app-text-muted)] space-y-1"
                      ref={logBoxRef}
                    >
                      {gatewayLogs.slice(-200).map((log, i) => (
                        <div
                          key={`${gatewayLogs.length - 200 + i}`}
                          className="leading-relaxed break-words whitespace-pre-wrap"
                        >
                          {redactSecrets(log)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pt-4 space-y-3">
                  {/* RUNNING (gateway up, health still settling) is as ready as
                      INSTALLED: without a forward control here the wizard has no
                      next step, because Back from step 2 lands on this screen. */}
                  {(install === 'INSTALLED' || install === 'RUNNING') && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setStep(0)} className={WIZARD_SECONDARY}>
                        {t('back')}
                      </button>
                      <button
                        onClick={() => setStep(2)}
                        className={`${WIZARD_PRIMARY} bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]`}
                      >
                        {tx('continueToKeys', 'Continue to keys')}
                      </button>
                    </div>
                  )}

                  {install === 'INSTALLING' && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setStep(0)} className={WIZARD_SECONDARY}>
                        {t('back')}
                      </button>
                      <button onClick={handleCancelInstall} className={`${WIZARD_SECONDARY} flex-1`}>
                        {tx('cancelSetup', 'Cancel and continue in the background')}
                      </button>
                    </div>
                  )}

                  {install === 'FAILED' && (
                    <div className="space-y-3">
                      <div className="p-4 r-md bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] space-y-2">
                        <p className="t-caption text-[var(--app-danger)] break-words">
                          {/* A start failure is not an install failure: the image
                              landed, so "nothing was installed" would be untrue.
                              startFailure is a stable token, never copy, so it is
                              mapped to wording here instead of printed. */}
                          {startFailure
                            ? tx('launchFailedPlain', 'Hermes did not start. Nothing was changed, so your setup is intact. Check the log below, then try again.')
                            : tx('failedMsgPlain', 'Setup failed. Nothing was installed, so nothing was lost. Press Retry to try again.')}
                        </p>
                        {installErrorLine && (
                          <p className="t-micro font-mono text-[var(--app-text-muted)] break-words">
                            {installErrorLine}
                          </p>
                        )}
                      </div>
                      {!startFailure && (
                        <p className="t-caption text-[var(--app-text-dim)]">
                          {tx('installRetryHint', 'Retry resumes the download instead of starting over.')}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={() => setStep(0)} className={WIZARD_SECONDARY}>
                          {t('back')}
                        </button>
                        {startFailure ? (
                          <button
                            onClick={() => {
                              // The image is already installed: start it and
                              // let the launch step report the real outcome
                              // instead of re-running setup.
                              setStep(3);
                              void handleLaunch();
                            }}
                            className={`${WIZARD_PRIMARY} bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]`}
                          >
                            {tx('startHermesNow', 'Start Hermes')}
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              if (isInstalling) return;
                              installGateway();
                            }}
                            disabled={isInstalling}
                            className={`${WIZARD_PRIMARY} bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]`}
                          >
                            {tx('retrySetupPlain', 'Try setup again')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {install !== 'INSTALLED' &&
                    install !== 'RUNNING' &&
                    install !== 'INSTALLING' &&
                    install !== 'FAILED' && (
                    <button onClick={() => setStep(0)} className={`${WIZARD_SECONDARY} w-full`}>
                      {t('back')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <h2 className="t-title text-[var(--app-text)]">{tx('modelCredentialsPlain', 'Connect your model')}</h2>
                  <p className="t-body text-[var(--app-text-muted)] mt-1">
                    {tx(
                      'modelCredentialsDescPlain',
                      'Pick the provider you have a key for, then paste the key. Hermes keeps it on this phone.'
                    )}
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label htmlFor="ob-provider" className="block t-label text-[var(--app-text-muted)]">
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
                        className={`px-3 min-h-[44px] r-sm t-caption font-medium transition cursor-pointer ${
                          customProvider
                            ? 'bg-[var(--app-accent)] text-[var(--app-on-accent)]'
                            : 'edge bg-[var(--app-card-subtle)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
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
                        className={`${WIZARD_FIELD} font-mono`}
                      />
                    ) : (
                      <select
                        id="ob-provider"
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                        onBlur={persistEnteredCredentials}
                        dir="ltr"
                        className={WIZARD_FIELD}
                      >
                        <option value="">{t('selectProvider')}</option>
                        {PROVIDER_OPTIONS.map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div>
                    <label htmlFor="ob-apikey" className="block t-label text-[var(--app-text-muted)] mb-1">
                      {t('apiKey')} {isKeyless ? t('optionalLocal') : '*'}
                    </label>
                    <div className="relative">
                      <input
                        id="ob-apikey"
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        onBlur={persistEnteredCredentials}
                        placeholder="sk-…"
                        dir="ltr"
                        autoComplete="off"
                        className={`${WIZARD_FIELD} pe-12 font-mono`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        aria-label={showKey ? t('hideToken') : t('showToken')}
                        aria-pressed={showKey}
                        className="absolute end-1 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-dim)] hover:text-[var(--app-text)] cursor-pointer"
                      >
                        {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="ob-baseurl" className="block t-label text-[var(--app-text-muted)] mb-1">
                      {t('baseUrl')}{(customProvider || !isKnown) ? ' *' : ` ${t('optionalSuffix')}`}
                    </label>
                    <input
                      id="ob-baseurl"
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      onBlur={persistEnteredCredentials}
                      placeholder={tx('baseUrlPlaceholder', 'https://api.openai.com/v1')}
                      dir="ltr"
                      autoComplete="off"
                      className={`${WIZARD_FIELD} font-mono`}
                    />
                  </div>

                  <div>
                    <label htmlFor="ob-model" className="block t-label text-[var(--app-text-muted)] mb-1">
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
                      className={`${WIZARD_FIELD} font-mono`}
                    />
                  </div>

                  <div>
                    <label htmlFor="ob-tgtoken" className="block t-label text-[var(--app-text-muted)] mb-1">
                      {t('telegramBridge')} {t('optionalSuffix')}
                    </label>
                    <div className="relative">
                      <input
                        id="ob-tgtoken"
                        type={showTg ? 'text' : 'password'}
                        value={tgToken}
                        onChange={(e) => setTgToken(e.target.value)}
                        onBlur={persistEnteredCredentials}
                        placeholder="bot123456:ABC-DEF…"
                        dir="ltr"
                        autoComplete="off"
                        className={`${WIZARD_FIELD} pe-12 font-mono`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowTg(!showTg)}
                        aria-label={showTg ? t('hideToken') : t('showToken')}
                        aria-pressed={showTg}
                        className="absolute end-1 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-dim)] hover:text-[var(--app-text)] cursor-pointer"
                      >
                        {showTg ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="pt-4 space-y-3">
                  {saveBlockReason && (
                    <p role="status" className="t-caption text-[var(--app-warning)]">
                      {saveBlockReason}
                    </p>
                  )}
                  <p className="t-caption text-[var(--app-text-dim)]">
                    {tx('credentialsSavedHint', 'Your key is saved as you type, so setup can resume if the app closes.')}
                  </p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setStep(1)} className={WIZARD_SECONDARY}>
                      {t('back')}
                    </button>
                    <button
                      disabled={!canSave}
                      aria-disabled={!canSave}
                      onClick={() => {
                        if (!canSave) return;
                        saveKeys(effectiveProvider, apiKey, modelId, baseUrl, tgToken, settings.discordToken, settings.serverKey, bootRestart);
                        setStep(3);
                      }}
                      className={`${WIZARD_PRIMARY} ${
                        canSave
                          ? 'bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]'
                          : 'bg-[var(--app-card-subtle)] text-[var(--app-text-dim)] cursor-not-allowed'
                      }`}
                    >
                      {t('saveContinue')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div>
                  <h2 className="t-title text-[var(--app-text)]">{tx('launchServerTitle', 'Start your Hermes server')}</h2>
                  <p className="t-body text-[var(--app-text-muted)] mt-1">
                    {tx('launchServerDesc', 'Hermes runs on this phone. Start it now so chats can work.')}
                  </p>
                </div>

                <div className="p-4 r-md bg-[var(--app-card-subtle)] hairline space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="t-label text-[var(--app-text)]">{t('autostartTitle')}?</p>
                    {/* Off is always neutral; on uses the accent tone. */}
                    <span className={settings.autostart ? 'pill-accent' : 'pill-neutral'} role="status">
                      {settings.autostart ? t('autostartEnabled') : t('autostartDisabled')}
                    </span>
                  </div>
                  <p className="t-caption text-[var(--app-text-muted)]">
                    {tx(
                      'autostartShortPlain',
                      'Hermes keeps running when your phone is locked, and starts again by itself each time you open the app.'
                    )}
                  </p>
                  <div className="flex gap-2 pt-1">
                    {/* Selected state is accent tint plus a check, never a
                        colour-only difference. */}
                    <button
                      onClick={() => applyAutostart(true)}
                      aria-pressed={bootRestart}
                      className={`flex-1 min-h-[48px] px-3 r-sm inline-flex items-center justify-center gap-2 t-caption transition cursor-pointer ${
                        bootRestart
                          ? 'bg-[var(--app-accent-subtle)] border border-[var(--app-accent-border)] text-[var(--app-accent-text)] font-semibold'
                          : 'edge bg-[var(--app-card)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
                      }`}
                    >
                      {bootRestart && <Check className="w-4 h-4 shrink-0" />}
                      <span>{tx('turnOn', 'Turn on')}</span>
                    </button>
                    <button
                      onClick={() => applyAutostart(false)}
                      aria-pressed={!bootRestart}
                      className={`flex-1 min-h-[48px] px-3 r-sm inline-flex items-center justify-center gap-2 t-caption transition cursor-pointer ${
                        !bootRestart
                          ? 'bg-[var(--app-accent-subtle)] border border-[var(--app-accent-border)] text-[var(--app-accent-text)] font-semibold'
                          : 'edge bg-[var(--app-card)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
                      }`}
                    >
                      {!bootRestart && <Check className="w-4 h-4 shrink-0" />}
                      <span>{tx('keepOff', 'Keep off')}</span>
                    </button>
                  </div>
                  {/* Policy detail lives behind a disclosure, not in the box. */}
                  <button
                    type="button"
                    onClick={() => setShowPolicy(!showPolicy)}
                    aria-expanded={showPolicy}
                    className="min-h-[44px] inline-flex items-center gap-1 t-caption text-[var(--app-accent-text)] cursor-pointer"
                  >
                    {showPolicy ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    <span>{tx('autostartPolicyTitle', 'How auto-launch behaves')}</span>
                  </button>
                  {showPolicy && (
                    <p className="t-caption text-[var(--app-text-dim)]">
                      {tx('autostartPolicyShort', 'With auto-launch on, the local service starts by itself when the app opens.')}{' '}
                      {tx(
                        'autostartPolicyNote',
                        'Android may still start the app fresh after a reboot or a battery-optimization kill; auto-launch only controls the local service, never what the app can reach.'
                      )}
                    </p>
                  )}
                </div>

                <div className="pt-4 space-y-3">
                  {launchError && (
                    <div
                      role="alert"
                      className="p-4 r-md bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] t-caption text-[var(--app-danger)] break-words"
                    >
                      {redactSecrets(launchError)}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button onClick={() => setStep(2)} className={WIZARD_SECONDARY}>
                      {t('back')}
                    </button>
                    {connected ? (
                      <button
                        onClick={finishOnboarding}
                        className={`${WIZARD_PRIMARY} bg-[var(--app-success-solid)] hover:opacity-90 text-[var(--app-on-success)]`}
                      >
                        <Check className="w-4 h-4 shrink-0" />
                        <span>{tx('finishSetup', 'Finish setup')}</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleLaunch}
                        disabled={launching}
                        aria-disabled={launching}
                        className={`${WIZARD_PRIMARY} bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)]`}
                      >
                        <Check className="w-4 h-4 shrink-0" />
                        <span>{launching ? tx('launchingPlain', 'Starting…') : tx('startHermesNow', 'Start Hermes')}</span>
                      </button>
                    )}
                  </div>

                  {skipConfirmBlock}

                  {skipButton}
                </div>
              </div>
            )}
          </div>
        </div>

        {backConfirm && (
          <div
            role="alert"
            className="fixed inset-x-4 bottom-4 p-4 r-lg elev-3 bg-[var(--app-warning-subtle)] border border-[var(--app-warning-border)] t-caption text-[var(--app-warning)] max-w-lg mx-auto"
          >
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
