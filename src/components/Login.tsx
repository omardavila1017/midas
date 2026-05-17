import { useEffect, useRef, FormEvent, ReactNode, useState } from 'react';
import { AlertCircle, Lock } from 'lucide-react';

const LOCAL_AUTH_ENABLED = import.meta.env.DEV && import.meta.env.VITE_ENABLE_LOCAL_AUTH_GATE === 'true';
const LOCAL_CONFIRMATION = 'local';

export function clearAuth() {
  // Auth is enforced by Atlas/backend in shared deployments. The optional
  // local gate keeps state only in memory, so there is no browser token to clear.
}

interface LocalGateProps {
  onContinue: () => void;
}

function LocalGate({ onContinue }: LocalGateProps) {
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmation.trim().toLowerCase() === LOCAL_CONFIRMATION) {
      onContinue();
      return;
    }
    setError('Escribe "local" para abrir esta sesión de desarrollo.');
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 skeuo-paper">
      <div
        className="w-full max-w-sm rounded-[var(--radius-lg)] p-8 skeuo-emboss-bordered"
        style={{ background: 'var(--skeuo-paper)' }}
      >
        <div className="flex flex-col items-center text-center mb-6">
          <div
            className="w-12 h-12 rounded-[var(--radius-lg)] flex items-center justify-center mb-3"
            style={{
              background: 'var(--skeuo-paper)',
              boxShadow: 'var(--skeuo-deboss-md)',
              color: 'var(--skeuo-brass-deep)',
            }}
          >
            <Lock className="w-5 h-5" />
          </div>
          <h1 className="text-[18px] font-bold text-[var(--gray-950)] skeuo-letterpress">
            Midas
          </h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            Gate local de desarrollo. La autenticacion real vive en Atlas/backend.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--gray-700)]">Confirmacion</span>
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                if (error) setError(null);
              }}
              className="mt-1 w-full h-10 rounded-[var(--radius-md)] border border-[var(--skeuo-paper-edge)] bg-[var(--input)] px-3 text-[14px] text-[var(--gray-950)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
              style={{ boxShadow: 'var(--skeuo-deboss-md)' }}
              placeholder="local"
            />
          </label>

          {error && (
            <div
              className="flex items-center gap-2 text-[12px] rounded-[var(--radius-md)] px-3 py-2"
              style={{
                color: 'var(--danger)',
                background: 'var(--danger-muted)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              }}
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="w-full h-10 rounded-[var(--radius-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-[14px] font-medium transition-colors"
            style={{
              boxShadow: 'var(--skeuo-emboss-md)',
              border: '1px solid var(--skeuo-brass-deep)',
            }}
          >
            Continuar
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
  const [localGatePassed, setLocalGatePassed] = useState(false);

  if (LOCAL_AUTH_ENABLED && !localGatePassed) {
    return <LocalGate onContinue={() => setLocalGatePassed(true)} />;
  }

  return <>{children}</>;
}
