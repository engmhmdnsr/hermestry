import React, { useState } from 'react';
import { X, Mail, Lock, User, KeyRound, ArrowLeft } from 'lucide-react';
import { useHermes } from '../../context/HermesContext';

export const AUTH_BASE_URL = 'http://100.112.74.9:8082';

type AuthView = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

type AuthScreensProps = {
  initialView?: AuthView;
  baseUrl?: string;
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

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
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

export const AuthScreens: React.FC<AuthScreensProps> = ({ initialView = 'login', baseUrl = AUTH_BASE_URL, onClose, onAuthenticated }) => {
  const tx = useTx();
  const [view, setView] = useState<AuthView>(initialView);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = (baseUrl || AUTH_BASE_URL).replace(/\/+$/, '');

  const clearFeedback = () => {
    setMessage(null);
    setError(null);
  };

  const handleRegister = async () => {
    clearFeedback();
    if (!name.trim() || !email.trim() || !password) {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
      return;
    }
    setLoading(true);
    try {
      const r = await postJson(`${base}/api/auth/register`, { name: name.trim(), email: email.trim(), password });
      if (!r.ok) {
        const msg = (r.data as { message?: string; error?: string })?.message || (r.data as { error?: string })?.error || '';
        setError(msg || tx('authErrorGeneric', 'Something went wrong. Try again.'));
        return;
      }
      setMessage(tx('authSuccessRegister', 'Account created. Check your email to verify.'));
      setView('verify');
    } catch {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
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
      const r = await postJson(`${base}/api/auth/login`, { email: email.trim(), password });
      if (!r.ok) {
        const msg = (r.data as { message?: string; error?: string })?.message || (r.data as { error?: string })?.error || '';
        setError(msg || tx('authErrorGeneric', 'Something went wrong. Try again.'));
        return;
      }
      const d = r.data as { access_token?: string; refresh_token?: string; user?: unknown };
      setMessage(tx('authSuccessLogin', 'Signed in.'));
      if (d?.access_token) {
        try {
          localStorage.setItem('hermes_access_token', d.access_token);
          if (d.refresh_token) localStorage.setItem('hermes_refresh_token', d.refresh_token);
          if (d.user) localStorage.setItem('hermes_user', JSON.stringify(d.user));
        } catch {
          // ignore storage write failures
        }
        onAuthenticated?.({ accessToken: d.access_token, refreshToken: d.refresh_token || '', user: d.user || null });
      }
    } catch {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
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
      const r = await postJson(`${base}/api/auth/verify-email`, { token: token.trim() });
      if (!r.ok) {
        const msg = (r.data as { message?: string; error?: string })?.message || (r.data as { error?: string })?.error || '';
        setError(msg || tx('authErrorGeneric', 'Something went wrong. Try again.'));
        return;
      }
      setMessage(tx('authSuccessVerify', 'Email verified.'));
      setView('login');
    } catch {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
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
      const r = await postJson(`${base}/api/auth/resend-verification`, { email: email.trim() });
      if (!r.ok) {
        const msg = (r.data as { message?: string; error?: string })?.message || (r.data as { error?: string })?.error || '';
        setError(msg || tx('authErrorGeneric', 'Something went wrong. Try again.'));
        return;
      }
      setMessage(tx('authSuccessResend', 'Verification code sent.'));
    } catch {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
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
      const r = await postJson(`${base}/api/auth/forgot-password`, { email: email.trim() });
      if (!r.ok) {
        const msg = (r.data as { message?: string; error?: string })?.message || (r.data as { error?: string })?.error || '';
        setError(msg || tx('authErrorGeneric', 'Something went wrong. Try again.'));
        return;
      }
      setMessage(tx('authSuccessForgot', 'If that email exists, a reset link was sent.'));
    } catch {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
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
      const r = await postJson(`${base}/api/auth/reset-password`, { token: token.trim(), new_password: newPassword });
      if (!r.ok) {
        const msg = (r.data as { message?: string; error?: string })?.message || (r.data as { error?: string })?.error || '';
        setError(msg || tx('authErrorGeneric', 'Something went wrong. Try again.'));
        return;
      }
      setMessage(tx('authSuccessReset', 'Password updated. You can now sign in.'));
      setView('login');
    } catch {
      setError(tx('authErrorGeneric', 'Something went wrong. Try again.'));
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
          <button
            onClick={onClose}
            aria-label={tx('authClose', 'Close')}
            className="w-11 h-11 flex items-center justify-center r-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
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
            <PrimaryButton loading={loading} onClick={handleLogin}>
              {loading ? tx('authLoading', 'Please wait') : tx('authLoginAction', 'Sign in')}
            </PrimaryButton>
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => { clearFeedback(); setView('forgot'); }} className="t-caption text-[var(--app-accent-text)] underline text-start cursor-pointer">
                {tx('authForgotLink', 'Forgot your password?')}
              </button>
              <button type="button" onClick={() => { clearFeedback(); setView('register'); }} className="t-caption text-[var(--app-text-muted)] underline text-start cursor-pointer">
                {tx('authNoAccount', 'No account? Create one')}
              </button>
            </div>
          </div>
        )}

        {view === 'register' && (
          <div className="space-y-4">
            <Field label={tx('authNameLabel', 'Name')} value={name} onChange={setName} placeholder={tx('authNamePlaceholder', 'Your name')} autoComplete="name" id="auth-name" />
            <Field label={tx('authEmailLabel', 'Email')} value={email} onChange={setEmail} placeholder={tx('authEmailPlaceholder', 'you@example.com')} autoComplete="email" id="auth-email-reg" />
            <Field label={tx('authPasswordLabel', 'Password')} type="password" value={password} onChange={setPassword} placeholder={tx('authPasswordPlaceholder', 'Your password')} autoComplete="new-password" id="auth-password-reg" />
            <PrimaryButton loading={loading} onClick={handleRegister}>
              {loading ? tx('authLoading', 'Please wait') : tx('authRegisterAction', 'Create account')}
            </PrimaryButton>
            <button type="button" onClick={() => { clearFeedback(); setView('login'); }} className="t-caption text-[var(--app-text-muted)] underline text-start cursor-pointer">
              {tx('authHaveAccount', 'Already have an account? Sign in')}
            </button>
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
