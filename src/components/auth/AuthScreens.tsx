import React, { useState } from 'react';
import { X, Mail, Lock, User, KeyRound, ArrowLeft } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';
import {
  login as authLogin,
  register as authRegister,
  verifyEmail as authVerify,
  resendVerification as authResend,
  forgotPassword as authForgot,
  resetPassword as authReset,
  AUTH_BASE_URL,
} from '../../services/auth';

type AuthView = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

type AuthScreensProps = {
  initialView?: AuthView;
  baseUrl?: string;
  forced?: boolean;
  onClose?: () => void;
  onAuthenticated?: (payload: { accessToken: string; refreshToken: string; user: unknown }) => void;
};

function useTx() {
  const { t } = useHermes();
  return (key: string, fallback: string): string => {
    const v = t(key);
    return !v || v === key ? fallback : v;
  };
}

const Field: React.FC<{
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete?: string;
  id: string;
}> = ({ label, type = 'text', value, onChange, placeholder, autoComplete, id }) => (
  <label className="block space-y-1.5">
    <span className="t-label text-[var(--app-text-muted)]">{label}</span>
    <input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      className="w-full px-4 py-3 min-h-[44px] r-sm bg-[var(--app-input-bg)] edge t-label text-[var(--app-text)] focus:outline-none focus:border-[var(--app-accent)] placeholder:text-[var(--app-text-dim)]"
    />
  </label>
);

const PrimaryButton: React.FC<{ loading?: boolean; children: React.ReactNode; onClick?: () => void; type?: 'button' | 'submit' }> = ({
  loading,
  children,
  onClick,
  type = 'button',
}) => (
  <button
    type={type}
    onClick={onClick}
    disabled={!!loading}
    className="w-full min-h-[44px] px-4 py-3 r-sm bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-on-accent)] t-label transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center"
  >
    {children}
  </button>
);

const GhostButton: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full min-h-[44px] px-4 py-2 r-sm edge bg-[var(--app-card-subtle)] hover:bg-[var(--app-card-hover)] t-label text-[var(--app-text)] transition-colors cursor-pointer"
  >
    {children}
  </button>
);

export const AuthScreens: React.FC<AuthScreensProps> = ({ initialView = 'login', forced = false, onClose, onAuthenticated }) => {
  const tx = useTx();
  const [view, setView] = useState<AuthView>(initialView);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearFeedback = () => {
    setMessage(null);
    setError(null);
  };

  const failMessage = (e: unknown) =>
    e instanceof Error && e.message ? e.message : tx('authErrorGeneric', 'Something went wrong. Try again.');

  const handleRegister = async () => {
    clearFeedback();
    if (!name.trim() || !email.trim() || !password) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    if (password !== confirmPassword) {
      setError(tx('authPasswordMismatch', 'Passwords do not match.'));
      return;
    }
    setLoading(true);
    try {
      await authRegister({ name: name.trim(), email: email.trim(), password });
      setMessage(tx('authSuccessRegister', 'Account created. Check your email to verify.'));
      setView('verify');
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    clearFeedback();
    if (!email.trim() || !password) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    setLoading(true);
    try {
      const r = await authLogin({ email: email.trim(), password });
      setMessage(tx('authSuccessLogin', 'Signed in.'));
      onAuthenticated?.({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user });
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    clearFeedback();
    if (!token.trim()) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    setLoading(true);
    try {
      await authVerify({ token: token.trim() });
      setMessage(tx('authSuccessVerify', 'Email verified.'));
      setView('login');
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    clearFeedback();
    if (!email.trim()) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    setLoading(true);
    try {
      await authResend(email.trim());
      setMessage(tx('authSuccessResend', 'Verification code sent.'));
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async () => {
    clearFeedback();
    if (!email.trim()) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    setLoading(true);
    try {
      await authForgot({ email: email.trim() });
      setMessage(tx('authSuccessForgot', 'If that email exists, a reset link was sent.'));
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    clearFeedback();
    if (!token.trim() || !newPassword) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    setLoading(true);
    try {
      await authReset({ token: token.trim(), password: newPassword });
      setMessage(tx('authSuccessReset', 'Password updated. You can now sign in.'));
      setView('login');
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const title =
    view === 'login'
      ? tx('authLoginTitle', 'Sign in')
      : view === 'register'
        ? tx('authRegisterTitle', 'Create account')
        : view === 'verify'
          ? tx('authVerifyTitle', 'Verify email')
          : view === 'forgot'
            ? tx('authForgotTitle', 'Forgot password')
            : tx('authResetTitle', 'Reset password');

  const subtitle =
    view === 'login'
      ? tx('authLoginSubtitle', 'Welcome back')
      : view === 'register'
        ? tx('authRegisterSubtitle', 'Join Hermes')
        : view === 'verify'
          ? tx('authVerifySubtitle', 'Enter the code sent to your email')
          : view === 'forgot'
            ? tx('authForgotSubtitle', 'We will send a reset link to your email')
            : tx('authResetSubtitle', 'Choose a new password');

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-[var(--app-scrim)] backdrop-blur-sm">
      <div className="w-full max-w-md r-md elev-3 bg-[var(--app-card)] edge p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-[var(--app-border-subtle)]">
          <div>
            <h2 className="t-heading text-[var(--app-text)] flex items-center gap-2">
              {view === 'login' && <Lock className="w-5 h-5 text-[var(--app-accent-text)]" />}
              {view === 'register' && <User className="w-5 h-5 text-[var(--app-accent-text)]" />}
              {view === 'verify' && <Mail className="w-5 h-5 text-[var(--app-accent-text)]" />}
              {view === 'forgot' && <KeyRound className="w-5 h-5 text-[var(--app-accent-text)]" />}
              {view === 'reset' && <KeyRound className="w-5 h-5 text-[var(--app-accent-text)]" />}
              {title}
            </h2>
            <p className="t-caption text-[var(--app-text-muted)] mt-1">{subtitle}</p>
          </div>
          {!forced && (
            <button
              onClick={onClose}
              aria-label={tx('authClose', 'Close')}
              className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {loading && <p className="t-caption text-[var(--app-text-dim)]">{tx('authLoading', 'Please wait')}</p>}
        {message && (
          <p className="t-caption text-[var(--app-success)] r-sm bg-[var(--app-success-subtle)] border border-[var(--app-success-border)] px-3 py-2" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="t-caption text-[var(--app-danger)] r-sm bg-[var(--app-danger-subtle)] border border-[var(--app-danger-border)] px-3 py-2" role="alert">
            {error}
          </p>
        )}

        {view === 'login' && (
          <div className="space-y-4">
            <Field label={tx('authEmailLabel', 'Email')} value={email} onChange={setEmail} placeholder={tx('authEmailPlaceholder', 'you@example.com')} autoComplete="email" id="auth-email" />
            <Field label={tx('authPasswordLabel', 'Password')} type="password" value={password} onChange={setPassword} placeholder={tx('authPasswordPlaceholder', 'Your password')} autoComplete="current-password" id="auth-password" />
            <div className="flex gap-2">
              <div className="flex-1">
                <PrimaryButton loading={loading} onClick={handleLogin}>
                  {loading ? tx('authLoading', 'Please wait') : tx('authLoginAction', 'Sign in')}
                </PrimaryButton>
              </div>
              <div className="flex-1">
                <GhostButton onClick={() => { clearFeedback(); setView('register'); }}>
                  {tx('authRegisterAction', 'Create account')}
                </GhostButton>
              </div>
            </div>
            <button type="button" onClick={() => { clearFeedback(); setView('forgot'); }} className="t-caption text-[var(--app-accent-text)] underline text-start cursor-pointer">
              {tx('authForgotLink', 'Forgot your password?')}
            </button>
          </div>
        )}

        {view === 'register' && (
          <div className="space-y-4">
            <Field label={tx('authNameLabel', 'Name')} value={name} onChange={setName} placeholder={tx('authNamePlaceholder', 'Your name')} autoComplete="name" id="auth-name" />
            <Field label={tx('authEmailLabel', 'Email')} value={email} onChange={setEmail} placeholder={tx('authEmailPlaceholder', 'you@example.com')} autoComplete="email" id="auth-email-reg" />
            <Field label={tx('authPasswordLabel', 'Password')} type="password" value={password} onChange={setPassword} placeholder={tx('authPasswordPlaceholder', 'Your password')} autoComplete="new-password" id="auth-password-reg" />
            <Field label={tx('authConfirmPasswordLabel', 'Confirm password')} type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder={tx('authPasswordPlaceholder', 'Your password')} autoComplete="new-password" id="auth-password-confirm" />
            <div className="flex gap-2">
              <div className="flex-1">
                <PrimaryButton loading={loading} onClick={handleRegister}>
                  {loading ? tx('authLoading', 'Please wait') : tx('authRegisterAction', 'Create account')}
                </PrimaryButton>
              </div>
              <div className="flex-1">
                <GhostButton onClick={() => { clearFeedback(); setView('login'); }}>
                  {tx('authLoginAction', 'Sign in')}
                </GhostButton>
              </div>
            </div>
          </div>
        )}

        {view === 'verify' && (
          <div className="space-y-4">
            <Field label={tx('authEmailLabel', 'Email')} value={email} onChange={setEmail} placeholder={tx('authEmailPlaceholder', 'you@example.com')} autoComplete="email" id="auth-email-verify" />
            <Field label={tx('authTokenLabel', 'Verification code')} value={token} onChange={setToken} placeholder={tx('authTokenPlaceholder', 'Enter code')} id="auth-token-verify" />
            <PrimaryButton loading={loading} onClick={handleVerify}>
              {loading ? tx('authLoading', 'Please wait') : tx('authVerifyAction', 'Verify')}
            </PrimaryButton>
            <GhostButton onClick={handleResend}>{tx('authResendAction', 'Resend code')}</GhostButton>
            <button type="button" onClick={() => { clearFeedback(); setView('login'); }} className="t-caption text-[var(--app-text-muted)] flex items-center gap-1 cursor-pointer">
              <ArrowLeft className="w-3.5 h-3.5" /> {tx('authBackToLogin', 'Back to sign in')}
            </button>
          </div>
        )}

        {view === 'forgot' && (
          <div className="space-y-4">
            <Field label={tx('authEmailLabel', 'Email')} value={email} onChange={setEmail} placeholder={tx('authEmailPlaceholder', 'you@example.com')} autoComplete="email" id="auth-email-forgot" />
            <PrimaryButton loading={loading} onClick={handleForgot}>
              {loading ? tx('authLoading', 'Please wait') : tx('authForgotAction', 'Send reset link')}
            </PrimaryButton>
            <button type="button" onClick={() => { clearFeedback(); setView('reset'); }} className="t-caption text-[var(--app-accent-text)] underline text-start cursor-pointer">
              {tx('authResetTitle', 'Reset password')}
            </button>
            <button type="button" onClick={() => { clearFeedback(); setView('login'); }} className="t-caption text-[var(--app-text-muted)] flex items-center gap-1 cursor-pointer">
              <ArrowLeft className="w-3.5 h-3.5" /> {tx('authBackToLogin', 'Back to sign in')}
            </button>
          </div>
        )}

        {view === 'reset' && (
          <div className="space-y-4">
            <Field label={tx('authTokenLabel', 'Verification code')} value={token} onChange={setToken} placeholder={tx('authTokenPlaceholder', 'Enter code')} id="auth-token-reset" />
            <Field label={tx('authNewPasswordLabel', 'New password')} type="password" value={newPassword} onChange={setNewPassword} placeholder={tx('authNewPasswordPlaceholder', 'New password')} autoComplete="new-password" id="auth-new-password" />
            <PrimaryButton loading={loading} onClick={handleReset}>
              {loading ? tx('authLoading', 'Please wait') : tx('authResetAction', 'Reset password')}
            </PrimaryButton>
            <button type="button" onClick={() => { clearFeedback(); setView('login'); }} className="t-caption text-[var(--app-text-muted)] flex items-center gap-1 cursor-pointer">
              <ArrowLeft className="w-3.5 h-3.5" /> {tx('authBackToLogin', 'Back to sign in')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AuthScreens;
