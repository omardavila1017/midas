/**
 * Modal para que un ADMIN fije directamente la contraseña de un usuario.
 *
 * A diferencia de `ChangePasswordModal` (cambio propio), aquí NO se pide la
 * contraseña actual: el admin la fija. La política se valida como guía; en modo
 * backend la autoridad final es el servidor. Reutiliza el primitivo `Modal` y el
 * checklist de política para mantener una sola fuente de verdad de UI/política.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import PasswordPolicyChecklist from '../../../components/PasswordPolicyChecklist';
import { passwordMeetsPolicy } from '../../../services/passwordPolicy';

interface SetPasswordModalProps {
  /** Correo objetivo; `null` = cerrado. */
  email: string | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (newPassword: string) => void;
}

export default function SetPasswordModal({ email, submitting, onClose, onSubmit }: SetPasswordModalProps) {
  const open = email !== null;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => passwordMeetsPolicy(password) && password === confirm && !submitting,
    [password, confirm, submitting],
  );

  const handleClose = () => {
    if (submitting) return;
    setPassword('');
    setConfirm('');
    setError(null);
    onClose();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!passwordMeetsPolicy(password)) {
      setError('La contraseña no cumple la política mínima.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setError(null);
    onSubmit(password);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Cambiar contraseña"
      description={email ? `Defines la contraseña de ${email}. No necesita su contraseña actual.` : undefined}
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
            form="set-user-password-form"
            disabled={!canSubmit}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--primary)] px-3 text-[12px] font-semibold text-white hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {submitting ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      }
    >
      <form id="set-user-password-form" onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
        <label className="block">
          <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--gray-700)]">
            Nueva contraseña
          </span>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            disabled={submitting}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            className="mt-1.5 h-10 w-full rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--input)] px-3 text-[13px] text-[var(--gray-950)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--primary)_22%,transparent)] disabled:opacity-60"
          />
        </label>
        <PasswordPolicyChecklist password={password} />
        <label className="block">
          <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--gray-700)]">
            Confirmar contraseña
          </span>
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            disabled={submitting}
            onChange={(e) => {
              setConfirm(e.target.value);
              if (error) setError(null);
            }}
            className="mt-1.5 h-10 w-full rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--input)] px-3 text-[13px] text-[var(--gray-950)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--primary)_22%,transparent)] disabled:opacity-60"
          />
        </label>
        {confirm && password !== confirm && (
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
