import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, KeyRound, Lock, Mail } from 'lucide-react';
import PasswordPolicyChecklist from './PasswordPolicyChecklist';
import {
  AuthApiError,
  completePasswordReset,
  getAuthSession,
  login,
  logout,
  requestPasswordReset,
  type LoginResponse,
} from '../services/authApi';
import { passwordMeetsPolicy } from '../services/passwordPolicy';
import {
  clearAuthSession,
  getPrefillEmail,
  rememberLastEmail,
  setCurrentAuthSession,
} from '../contexts/authSession';

const sendaLogoUrl = `${import.meta.env.BASE_URL}logos/senda-corporativo.svg`;

type LoginMode = 'login' | 'forgot' | 'reset';

export function clearAuth() {
  clearAuthSession();
  setCurrentAuthSession(null);
  void logout().catch(() => {
    // Logout debe ser tolerante: la recarga/limpieza local no depende de red.
  });
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function authErrorMessage(error: unknown): string {
  if (error instanceof AuthApiError) {
    if (error.code === 'invalid_credentials') return 'Correo o contraseña incorrectos.';
    if (error.code === 'forbidden') return 'Tu cuenta no tiene acceso asignado a Midas.';
    if (error.code === 'password_expired') return 'Tu contraseña expiró. Solicita una liga para restablecerla.';
    if (error.code === 'rate_limited') return 'Demasiados intentos. Intenta de nuevo más tarde.';
    if (error.code === 'invalid_token') return 'La liga ya expiró o no es válida.';
    if (error.code === 'network') return 'No se pudo conectar con autenticación.';
  }
  return 'No se pudo completar la solicitud.';
}

function readResetToken(): string | null {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('reset_token') || url.searchParams.get('token');
  } catch {
    return null;
  }
}

function clearResetTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('reset_token');
    url.searchParams.delete('token');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Ignorar.
  }
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
      style={{ animation: 'spin 0.7s linear infinite' }}
      aria-hidden
    />
  );
}

function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="skeuo-paper flex min-h-screen items-center justify-center px-4 py-10">
      <div
        className="skeuo-sat-bg w-full max-w-[420px] rounded-[var(--radius-xl)] p-8 sm:p-9"
        data-stamp="Senda"
        style={{
          background: 'var(--skeuo-paper)',
          backgroundImage: 'var(--skeuo-linen)',
          boxShadow: 'var(--skeuo-emboss-md), 0 0 0 1px var(--skeuo-paper-edge), 0 24px 48px -24px rgba(15,23,42,0.35)',
          animation: 'cardIn 360ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        <div className="flex flex-col items-center text-center">
          <img
            src={sendaLogoUrl}
            alt="Senda"
            className="h-9 w-auto"
            decoding="async"
            fetchpriority="high"
          />
          <span className="skeuo-nameplate mt-5">Tesorería · Midas</span>
        </div>
        <div
          className="my-6 h-px w-full"
          style={{
            background:
              'linear-gradient(to right, transparent, color-mix(in oklch, var(--skeuo-brass) 50%, transparent), transparent)',
          }}
        />
        {children}
      </div>
    </div>
  );
}

function AlertBox({ message, tone = 'danger' }: { message: string; tone?: 'danger' | 'success' | 'info' }) {
  const isSuccess = tone === 'success';
  const Icon = isSuccess ? CheckCircle2 : AlertCircle;
  return (
    <div
      className="flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
      style={{
        color: isSuccess ? 'var(--success)' : tone === 'info' ? 'var(--info)' : 'var(--danger)',
        background: isSuccess ? 'var(--success-muted)' : tone === 'info' ? 'var(--info-muted)' : 'var(--danger-muted)',
        border: `1px solid color-mix(in oklch, ${isSuccess ? 'var(--success)' : tone === 'info' ? 'var(--info)' : 'var(--danger)'} 22%, transparent)`,
        animation: 'slideDown 200ms ease both',
      }}
      role={isSuccess ? 'status' : 'alert'}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
      <span>{message}</span>
    </div>
  );
}

function PasswordInput({
  label,
  value,
  onChange,
  disabled,
  autoComplete,
  placeholder = '••••••••••••',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoComplete: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--gray-700)]">
        {label}
      </span>
      <div className="relative mt-1.5">
        <KeyRound
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--gray-400)]"
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          type="password"
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--skeuo-paper-edge)] bg-[var(--input)] pl-9 pr-3 text-[14px] text-[var(--gray-950)] transition-shadow placeholder:text-[var(--gray-400)] focus:border-[var(--skeuo-brass)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--skeuo-brass)_28%,transparent)] disabled:opacity-60"
          style={{ boxShadow: 'var(--skeuo-deboss-md)' }}
          placeholder={placeholder}
        />
      </div>
    </label>
  );
}

function LoginForm({ onSignedIn, onForgot }: { onSignedIn: (session: LoginResponse) => void; onForgot: () => void }) {
  const [email, setEmail] = useState(() => getPrefillEmail());
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!looksLikeEmail(value)) {
      setError('Escribe un correo válido para entrar.');
      inputRef.current?.focus();
      return;
    }
    if (!password) {
      setError('Escribe tu contraseña.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await login(value, password);
      if (session.passwordExpired) {
        setError('Tu contraseña expiró. Solicita una liga para restablecerla.');
        return;
      }
      if (session.role === 'none') {
        setError('Tu cuenta no tiene un rol asignado para Midas.');
        return;
      }
      rememberLastEmail(session.email);
      onSignedIn(session);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="text-center">
        <h1 className="text-[22px] font-bold leading-tight text-[var(--gray-950)] skeuo-letterpress">
          Acceso empresarial
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--gray-500)]">
          Entra con tu cuenta corporativa para abrir tu panel.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--gray-700)]">
            Correo
          </span>
          <div className="relative mt-1.5">
            <Lock
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--gray-400)]"
              strokeWidth={1.75}
              aria-hidden
            />
            <input
              ref={inputRef}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="off"
              spellCheck={false}
              value={email}
              disabled={submitting}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error) setError(null);
              }}
              className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--skeuo-paper-edge)] bg-[var(--input)] pl-9 pr-3 text-[14px] text-[var(--gray-950)] transition-shadow placeholder:text-[var(--gray-400)] focus:border-[var(--skeuo-brass)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--skeuo-brass)_28%,transparent)] disabled:opacity-60"
              style={{ boxShadow: 'var(--skeuo-deboss-md)' }}
              placeholder="usuario@senda.com"
              aria-invalid={error ? true : undefined}
            />
          </div>
        </label>

        <PasswordInput
          label="Contraseña"
          value={password}
          onChange={(next) => {
            setPassword(next);
            if (error) setError(null);
          }}
          disabled={submitting}
          autoComplete="current-password"
        />

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onForgot}
            className="text-[12px] font-medium text-[var(--primary)] hover:underline"
            disabled={submitting}
          >
            Olvidé mi contraseña
          </button>
        </div>

        {error && <AlertBox message={error} />}

        <button
          type="submit"
          disabled={submitting}
          className="group flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--primary)] text-[14px] font-semibold text-white transition-[background,transform] hover:bg-[var(--primary-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-80"
          style={{
            boxShadow: 'var(--skeuo-emboss-md)',
            border: '1px solid var(--skeuo-brass-deep)',
          }}
        >
          {submitting ? (
            <>
              <Spinner />
              Entrando...
            </>
          ) : (
            <>
              Entrar
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2} aria-hidden />
            </>
          )}
        </button>
      </form>

      <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--gray-400)]">
        La sesión real vive en el backend corporativo. Midas no guarda tokens ni contraseñas en el navegador.
      </p>
    </>
  );
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState(() => getPrefillEmail());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!looksLikeEmail(value)) {
      setError('Escribe un correo válido.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await requestPasswordReset(value);
      rememberLastEmail(value);
      setSent(true);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-900)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        Volver al acceso
      </button>
      <h1 className="text-[22px] font-bold leading-tight text-[var(--gray-950)] skeuo-letterpress">
        Restablecer contraseña
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--gray-500)]">
        Si el correo existe y tiene acceso, recibirá una liga de un solo uso.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--gray-700)]">
            Correo corporativo
          </span>
          <div className="relative mt-1.5">
            <Mail
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--gray-400)]"
              strokeWidth={1.75}
              aria-hidden
            />
            <input
              type="email"
              value={email}
              disabled={submitting || sent}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error) setError(null);
              }}
              className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--skeuo-paper-edge)] bg-[var(--input)] pl-9 pr-3 text-[14px] text-[var(--gray-950)] transition-shadow placeholder:text-[var(--gray-400)] focus:border-[var(--skeuo-brass)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--skeuo-brass)_28%,transparent)] disabled:opacity-60"
              style={{ boxShadow: 'var(--skeuo-deboss-md)' }}
              placeholder="usuario@senda.com"
            />
          </div>
        </label>
        {sent && <AlertBox tone="success" message="Si el correo está registrado, la liga de restablecimiento ya fue enviada." />}
        {error && <AlertBox message={error} />}
        <button
          type="submit"
          disabled={submitting || sent}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--primary)] text-[14px] font-semibold text-white transition-[background,transform] hover:bg-[var(--primary-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-80"
          style={{ boxShadow: 'var(--skeuo-emboss-md)', border: '1px solid var(--skeuo-brass-deep)' }}
        >
          {submitting ? <><Spinner /> Enviando...</> : 'Enviar liga'}
        </button>
      </form>
    </>
  );
}

function ResetPasswordForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = useMemo(
    () => passwordMeetsPolicy(password) && password === confirm && !submitting,
    [password, confirm, submitting],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!passwordMeetsPolicy(password)) {
      setError('La contraseña no cumple la política mínima.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await completePasswordReset(token, password);
      clearResetTokenFromUrl();
      onDone();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1 className="text-[22px] font-bold leading-tight text-[var(--gray-950)] skeuo-letterpress">
        Definir nueva contraseña
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--gray-500)]">
        La liga es de un solo uso. Al terminar podrás iniciar sesión con tu contraseña nueva.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <PasswordInput
          label="Nueva contraseña"
          value={password}
          onChange={(next) => {
            setPassword(next);
            if (error) setError(null);
          }}
          disabled={submitting}
          autoComplete="new-password"
        />
        <PasswordPolicyChecklist password={password} />
        <PasswordInput
          label="Confirmar contraseña"
          value={confirm}
          onChange={(next) => {
            setConfirm(next);
            if (error) setError(null);
          }}
          disabled={submitting}
          autoComplete="new-password"
        />
        {confirm && password !== confirm && <AlertBox tone="info" message="Las contraseñas deben coincidir." />}
        {error && <AlertBox message={error} />}
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--primary)] text-[14px] font-semibold text-white transition-[background,transform] hover:bg-[var(--primary-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-80"
          style={{ boxShadow: 'var(--skeuo-emboss-md)', border: '1px solid var(--skeuo-brass-deep)' }}
        >
          {submitting ? <><Spinner /> Guardando...</> : 'Guardar contraseña'}
        </button>
      </form>
    </>
  );
}

function CheckingSession() {
  return (
    <LoginShell>
      <div className="py-8 text-center">
        <div className="mx-auto mb-4 h-6 w-6 rounded-full border-2 border-[var(--gray-300)] border-t-[var(--primary)]" style={{ animation: 'spin 0.7s linear infinite' }} />
        <h1 className="text-[18px] font-bold text-[var(--gray-950)]">Validando sesión</h1>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">Conectando con autenticación corporativa.</p>
      </div>
    </LoginShell>
  );
}

interface AuthGateProps {
  children: ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<LoginMode>(() => (readResetToken() ? 'reset' : 'login'));
  const [notice, setNotice] = useState<string | null>(null);
  const resetToken = useMemo(() => readResetToken(), []);

  useEffect(() => {
    if (mode === 'reset') {
      setChecking(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const session = await getAuthSession();
        if (cancelled) return;
        if (session.authenticated && session.email && session.role !== 'none') {
          setCurrentAuthSession({
            email: session.email,
            role: session.role,
            expiresAt: session.expiresAt,
          });
          setAuthed(true);
          return;
        }
        if (session.authenticated && session.role === 'none') {
          setNotice('Tu cuenta no tiene un rol asignado para Midas.');
        }
      } catch {
        if (!cancelled) setNotice('No se pudo validar una sesión existente. Inicia sesión para continuar.');
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authed) return <>{children}</>;
  if (checking) return <CheckingSession />;

  const handleSignedIn = (session: LoginResponse) => {
    setCurrentAuthSession({
      email: session.email,
      role: session.role,
      expiresAt: session.expiresAt,
    });
    setAuthed(true);
  };

  return (
    <LoginShell>
      {notice && mode === 'login' && <div className="mb-4"><AlertBox tone="info" message={notice} /></div>}
      {mode === 'forgot' ? (
        <ForgotPasswordForm onBack={() => setMode('login')} />
      ) : mode === 'reset' && resetToken ? (
        <ResetPasswordForm
          token={resetToken}
          onDone={() => {
            setNotice('Contraseña actualizada. Inicia sesión con tu nueva contraseña.');
            setMode('login');
          }}
        />
      ) : (
        <LoginForm onSignedIn={handleSignedIn} onForgot={() => setMode('forgot')} />
      )}
    </LoginShell>
  );
}
