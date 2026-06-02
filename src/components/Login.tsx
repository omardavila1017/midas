/**
 * Login — pantalla de acceso (UX) + gate de carga de la app.
 *
 * Flujo: PRIMERO login, DESPUÉS carga. `AuthGate` envuelve a `<App/>` en
 * `main.tsx`; mientras no haya identidad resuelta muestra la pantalla de
 * acceso y NO monta la app (ni dispara los fetches de boot). Al entrar, guarda
 * la sesión y recién entonces renderiza a sus hijos.
 *
 * IMPORTANTE (ver `AUTH.md`): esto NO es una frontera de seguridad. La
 * autenticación vinculante la hace Atlas SSO / el backend en `/api/*`. Aquí
 * solo capturamos el correo del usuario para resolver su rol de UI (RBAC) y
 * personalizar la experiencia. No se pide ni se valida contraseña en el
 * frontend a propósito.
 *
 * Estética: tema "artefacto" skeuomórfico (papel + lino + placa de latón +
 * relieve embossed/deboss + letterpress + sello), alineado con el resto del DS.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Lock } from 'lucide-react';
import {
  clearAuthSession,
  needsLogin,
  writeAuthSession,
} from '../contexts/authSession';

const sendaLogoUrl = `${import.meta.env.BASE_URL}logos/senda-corporativo.svg`;

/** Borra la sesión de identidad. Usado por logout y por el "cold boot". */
export function clearAuth() {
  clearAuthSession();
}

/** Validación ligera de forma de correo (no es seguridad, solo UX). */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

interface LoginScreenProps {
  onSignedIn: () => void;
}

function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim();
    if (!looksLikeEmail(value)) {
      setError('Escribe un correo válido para entrar.');
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    writeAuthSession(value);
    // Pequeña pausa para que el sello de "Entrar" se sienta físico antes de
    // ceder el hilo al boot de la app (que es pesado).
    window.setTimeout(onSignedIn, 220);
  };

  return (
    <div className="skeuo-paper min-h-screen flex items-center justify-center px-4 py-10">
      <div
        className="skeuo-sat-bg w-full max-w-[400px] rounded-[var(--radius-xl)] p-8 sm:p-9"
        data-stamp="Senda"
        style={{
          background: 'var(--skeuo-paper)',
          backgroundImage: 'var(--skeuo-linen)',
          boxShadow: 'var(--skeuo-emboss-md), 0 0 0 1px var(--skeuo-paper-edge), 0 24px 48px -24px rgba(15,23,42,0.35)',
          animation: 'cardIn 360ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        {/* Marca */}
        <div className="flex flex-col items-center text-center">
          <img
            src={sendaLogoUrl}
            alt="Senda"
            className="h-9 w-auto"
            decoding="async"
            fetchpriority="high"
          />
          <span className="skeuo-nameplate mt-5">Tesorería · Midas</span>
          <h1 className="mt-4 text-[22px] font-bold leading-tight text-[var(--gray-950)] skeuo-letterpress">
            Bienvenido de vuelta
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--gray-500)]">
            Ingresa tu correo corporativo para abrir tu panel.
          </p>
        </div>

        {/* Divisor de latón */}
        <div
          className="my-6 h-px w-full"
          style={{
            background:
              'linear-gradient(to right, transparent, color-mix(in oklch, var(--skeuo-brass) 50%, transparent), transparent)',
          }}
        />

        <form onSubmit={handleSubmit} className="space-y-4">
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

          {error && (
            <div
              className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
              style={{
                color: 'var(--danger)',
                background: 'var(--danger-muted)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                animation: 'slideDown 200ms ease both',
              }}
              role="alert"
            >
              <AlertCircle className="h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          )}

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
                <span
                  className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                  style={{ animation: 'spin 0.7s linear infinite' }}
                  aria-hidden
                />
                Entrando…
              </>
            ) : (
              <>
                Entrar
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                  strokeWidth={2}
                  aria-hidden
                />
              </>
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--gray-400)]">
          La autenticación corporativa la realiza Atlas SSO. Este acceso solo
          ajusta tu experiencia y los módulos visibles según tu rol.
        </p>
      </div>
    </div>
  );
}

interface AuthGateProps {
  children: ReactNode;
}

/**
 * Gate de identidad. Si no hay identidad resuelta (ni sesión guardada ni email
 * inyectado por el entorno), muestra la pantalla de login y posterga el montaje
 * de la app. Una vez identificado, renderiza a sus hijos → la app carga.
 */
export default function AuthGate({ children }: AuthGateProps) {
  const [authed, setAuthed] = useState(() => !needsLogin());

  if (!authed) {
    return <LoginScreen onSignedIn={() => setAuthed(true)} />;
  }

  return <>{children}</>;
}
