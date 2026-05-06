import { useState, useEffect, useRef, FormEvent, ReactNode } from 'react';
import { Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';

const AUTH_STORAGE_KEY = 'midas-auth-v1';

// Registro de usuarios habilitados. Comparación directa contra el password
// en texto plano configurado en la env var correspondiente
// (VITE_<USER>_PASSWORD). Este gate vive en cliente y solo disuade lecturas
// casuales — la auth real debe delegarse a Atlas SSO (ver AUTH.md).
const USERS: Record<string, string> = {
  admin: import.meta.env.VITE_ADMIN_PASSWORD ?? 'admin',
  paolo: import.meta.env.VITE_PAOLO_PASSWORD ?? 'paolo',
};

function isAuthenticated(): boolean {
  try {
    return sessionStorage.getItem(AUTH_STORAGE_KEY) === 'ok';
  } catch {
    return false;
  }
}

function persistAuth() {
  try {
    sessionStorage.setItem(AUTH_STORAGE_KEY, 'ok');
  } catch {
    /* no-op */
  }
}

interface LoginScreenProps {
  onSuccess: () => void;
}

function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    userInputRef.current?.focus();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expected = USERS[user.trim().toLowerCase()];
    if (expected && password === expected) {
      persistAuth();
      onSuccess();
      return;
    }
    setError('Usuario o contraseña incorrectos.');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[var(--gray-50)] via-white to-[var(--gray-100)] px-4">
      <div className="w-full max-w-sm bg-white rounded-[var(--radius-lg)] border border-[var(--gray-200)] shadow-[var(--shadow-card-hover)] p-8">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-12 h-12 rounded-[var(--radius-lg)] bg-[var(--primary)] text-white flex items-center justify-center mb-3">
            <Lock className="w-5 h-5" />
          </div>
          <h1 className="text-[18px] font-bold text-[var(--gray-950)]">Midas</h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            Ingresa tus credenciales para continuar
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--gray-700)]">Usuario</span>
            <div className="mt-1 relative">
              <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gray-400)]" />
              <input
                ref={userInputRef}
                type="text"
                autoComplete="username"
                value={user}
                onChange={(event) => {
                  setUser(event.target.value);
                  if (error) setError(null);
                }}
                className="w-full h-10 pl-9 pr-3 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--input)] text-[14px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                placeholder="admin"
              />
            </div>
          </label>

          <label className="block">
            <span className="text-[12px] font-medium text-[var(--gray-700)]">Contraseña</span>
            <div className="mt-1 relative">
              <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gray-400)]" />
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
                className="w-full h-10 pl-9 pr-9 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--input)] text-[14px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-[var(--gray-400)] hover:text-[var(--gray-700)] hover:bg-[var(--gray-100)]"
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>

          {error && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--destructive)] bg-red-50 border border-red-100 rounded-[var(--radius-md)] px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="w-full h-10 rounded-[var(--radius-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-[14px] font-medium transition-colors"
          >
            Entrar
          </button>
        </form>
      </div>
    </div>
  );
}

interface AuthGateProps {
  children: ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [authed, setAuthed] = useState<boolean>(() => isAuthenticated());

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }

  return <>{children}</>;
}
