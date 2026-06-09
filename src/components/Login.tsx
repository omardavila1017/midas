import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, KeyRound, Lock, Mail } from 'lucide-react';
import PasswordPolicyChecklist from './PasswordPolicyChecklist';
import {
  AuthApiError,
  checkRegistrationEligibility,
  completeFirstLogin,
  completePasswordReset,
  getAuthSession,
  isRegistrationAvailable,
  login,
  logout,
  requestPasswordReset,
  requiresPasswordSetup,
  type LoginResponse,
} from '../services/authApi';
import { passwordMeetsPolicy } from '../services/passwordPolicy';
import {
  clearAuthSession,
  rememberLastEmail,
  setCurrentAuthSession,
} from '../contexts/authSession';

const sendaLogoUrl = `${import.meta.env.BASE_URL}logos/senda-corporativo.svg`;

type LoginMode = 'login' | 'forgot' | 'reset' | 'setup' | 'register';

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
    if (error.code === 'password_setup_required') return 'Tu cuenta aún no tiene contraseña. Defínela para activarla.';
    if (error.code === 'invalid_token') return 'La liga ya expiró o no es válida.';
    if (error.code === 'network') return 'No se pudo conectar con autenticación.';
    if (error.code === 'validation') {
      return error.message || 'Los datos enviados no son válidos.';
    }
    if (error.code === 'unknown' && error.message && error.message !== 'No se pudo completar la solicitud.') {
      return error.message;
    }
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

function LoginForm({
  onSignedIn,
  onForgot,
  onNeedsSetup,
  onRegister,
  canRegister,
}: {
  onSignedIn: (session: LoginResponse) => void;
  onForgot: () => void;
  onNeedsSetup: (email: string) => void;
  onRegister: (email: string) => void;
  canRegister: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!looksLikeEmail(value)) {
      setError('Escribe un correo válido para entrar.');
      inputRef.current?.focus();
      return;
    }
    // Usuario registrado que aún no define su contraseña → primer ingreso.
    if (requiresPasswordSetup(value)) {
      onNeedsSetup(value);
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
      // El backend/local puede señalar "falta definir contraseña" en una carrera
      // con el chequeo síncrono de arriba: enrutamos al primer ingreso.
      if (err instanceof AuthApiError && err.code === 'password_setup_required') {
        onNeedsSetup(value);
        return;
      }
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

      {canRegister && (
        <p className="mt-5 text-center text-[12px] leading-relaxed text-[var(--gray-500)]">
          ¿Primera vez en Midas?{' '}
          <button
            type="button"
            onClick={() => onRegister(email.trim().toLowerCase())}
            className="font-medium text-[var(--primary)] hover:underline"
            disabled={submitting}
          >
            Crea tu cuenta
          </button>
        </p>
      )}

      <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--gray-400)]">
        La sesión real vive en el backend corporativo. Midas no guarda tokens ni contraseñas en el navegador.
      </p>
    </>
  );
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
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

function FirstLoginForm({
  email,
  onActivated,
  onBack,
}: {
  email: string;
  onActivated: (session: LoginResponse) => void;
  onBack: () => void;
}) {
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
      const session = await completeFirstLogin(email, password);
      rememberLastEmail(session.email);
      onActivated(session);
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
        Primer ingreso
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--gray-500)]">
        Tu cuenta <span className="font-medium text-[var(--gray-700)]">{email}</span> está registrada pero aún
        no tiene contraseña. Defínela para activarla.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <PasswordInput
          label="Crea tu contraseña"
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
          {submitting ? <><Spinner /> Activando...</> : 'Activar cuenta'}
        </button>
      </form>
    </>
  );
}

function RegisterForm({
  initialEmail,
  onActivated,
  onBack,
  onGoLogin,
}: {
  initialEmail: string;
  onActivated: (session: LoginResponse) => void;
  onBack: () => void;
  onGoLogin: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Si llegamos sin correo prellenado, enfoca el campo para empezar a escribir.
    if (!initialEmail) emailRef.current?.focus();
  }, [initialEmail]);

  const canSubmit = useMemo(
    () =>
      looksLikeEmail(email) &&
      passwordMeetsPolicy(password) &&
      password === confirm &&
      !submitting,
    [email, password, confirm, submitting],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!looksLikeEmail(value)) {
      setError('Escribe un correo válido.');
      emailRef.current?.focus();
      return;
    }
    // El correo debe estar pre-registrado por un admin (capa de registro de
    // usuarios). Damos un mensaje preciso según el caso antes de tocar la red.
    const eligibility = checkRegistrationEligibility(value);
    if (eligibility === 'not_pre_registered') {
      setError('Tu correo no está pre-registrado. Pide a un administrador que te dé de alta en el módulo de Usuarios.');
      return;
    }
    if (eligibility === 'already_registered') {
      setError('Ya tienes una cuenta activa. Inicia sesión con tu contraseña.');
      return;
    }
    if (eligibility === 'backend_managed') {
      setError('El alta de cuentas la gestiona el backend corporativo. Solicita tu acceso a un administrador.');
      return;
    }
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
      const session = await completeFirstLogin(value, password);
      rememberLastEmail(session.email);
      onActivated(session);
    } catch (err) {
      // Carrera: si entre el chequeo y el submit el correo ya quedó registrado.
      if (err instanceof AuthApiError && err.code === 'validation' && err.status === 409) {
        setError('Ya tienes una cuenta activa. Inicia sesión con tu contraseña.');
        return;
      }
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
        Crear cuenta
      </h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--gray-500)]">
        Tu correo debe estar pre-registrado por un administrador. Defínele una contraseña para activar tu cuenta.
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
              ref={emailRef}
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
            />
          </div>
        </label>
        <PasswordInput
          label="Crea tu contraseña"
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
          {submitting ? <><Spinner /> Creando cuenta...</> : 'Crear cuenta'}
        </button>
      </form>

      <p className="mt-5 text-center text-[12px] leading-relaxed text-[var(--gray-500)]">
        ¿Ya tienes cuenta?{' '}
        <button
          type="button"
          onClick={onGoLogin}
          className="font-medium text-[var(--primary)] hover:underline"
          disabled={submitting}
        >
          Inicia sesión
        </button>
      </p>
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
  const [setupEmail, setSetupEmail] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const resetToken = useMemo(() => readResetToken(), []);
  const canRegister = useMemo(() => isRegistrationAvailable(), []);

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
      ) : mode === 'setup' && setupEmail ? (
        <FirstLoginForm
          email={setupEmail}
          onActivated={handleSignedIn}
          onBack={() => {
            setSetupEmail('');
            setMode('login');
          }}
        />
      ) : mode === 'register' ? (
        <RegisterForm
          initialEmail={registerEmail}
          onActivated={handleSignedIn}
          onBack={() => {
            setRegisterEmail('');
            setMode('login');
          }}
          onGoLogin={() => {
            setRegisterEmail('');
            setMode('login');
          }}
        />
      ) : (
        <LoginForm
          onSignedIn={handleSignedIn}
          onForgot={() => setMode('forgot')}
          onNeedsSetup={(em) => {
            setSetupEmail(em);
            setMode('setup');
          }}
          onRegister={(em) => {
            setRegisterEmail(em);
            setMode('register');
          }}
          canRegister={canRegister}
        />
      )}
    </LoginShell>
  );
}
