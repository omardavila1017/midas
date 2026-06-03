import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Modal } from './ui/Modal';
import PasswordPolicyChecklist from './PasswordPolicyChecklist';
import { AuthApiError, changePassword } from '../services/authApi';
import { passwordMeetsPolicy } from '../services/passwordPolicy';

interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthApiError) {
    if (error.code === 'invalid_credentials') return 'La contraseña actual no es correcta.';
    if (error.code === 'rate_limited') return 'Demasiados intentos. Intenta de nuevo más tarde.';
    if (error.code === 'forbidden') return 'Tu sesión no permite cambiar esta contraseña.';
    if (error.code === 'network') return 'No se pudo conectar con autenticación.';
    // El backend es la autoridad final de la política: si rechaza la contraseña
    // (débil, reutilizada, etc.) mostramos su motivo en vez de un genérico.
    if (error.code === 'validation') {
      return error.message || 'La contraseña nueva no cumple los requisitos del servidor.';
    }
    if (error.code === 'unknown' && error.message && error.message !== 'No se pudo completar la solicitud.') {
      return error.message;
    }
  }
  return 'No se pudo cambiar la contraseña.';
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--gray-700)]">
        {label}
      </span>
      <input
        type="password"
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-10 w-full rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--input)] px-3 text-[13px] text-[var(--gray-950)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--primary)_22%,transparent)] disabled:opacity-60"
      />
    </label>
  );
}

export default function ChangePasswordModal({ open, onClose, onChanged }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () =>
      currentPassword.length > 0 &&
      passwordMeetsPolicy(newPassword) &&
      newPassword === confirmPassword &&
      !submitting,
    [currentPassword, newPassword, confirmPassword, submitting],
  );

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!passwordMeetsPolicy(newPassword)) {
      setError('La contraseña nueva no cumple la política mínima.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      reset();
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Cambiar contraseña"
      description="La política se valida aquí como guía; el backend es la autoridad final."
      size="sm"
      closeOnBackdrop={!submitting}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="h-9 rounded-[var(--radius-md)] border border-[var(--gray-200)] px-3 text-[12px] font-medium text-[var(--gray-600)] hover:bg-[var(--gray-100)] disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            form="change-password-form"
            disabled={!canSubmit}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--primary)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {submitting ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      }
    >
      <form id="change-password-form" onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
        <Field
          label="Contraseña actual"
          value={currentPassword}
          onChange={(next) => {
            setCurrentPassword(next);
            if (error) setError(null);
          }}
          autoComplete="current-password"
          disabled={submitting}
        />
        <Field
          label="Nueva contraseña"
          value={newPassword}
          onChange={(next) => {
            setNewPassword(next);
            if (error) setError(null);
          }}
          autoComplete="new-password"
          disabled={submitting}
        />
        <PasswordPolicyChecklist password={newPassword} />
        <Field
          label="Confirmar nueva contraseña"
          value={confirmPassword}
          onChange={(next) => {
            setConfirmPassword(next);
            if (error) setError(null);
          }}
          autoComplete="new-password"
          disabled={submitting}
        />
        {confirmPassword && newPassword !== confirmPassword && (
          <p className="text-[12px] text-[var(--info)]">Las contraseñas deben coincidir.</p>
        )}
        {error && (
          <p
            className="rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
            style={{ background: 'var(--danger-muted)', color: 'var(--danger)' }}
            role="alert"
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
