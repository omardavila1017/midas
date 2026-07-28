/**
 * Tabla del registro de usuarios: correo, rol (admin/user) y acciones.
 *
 * Solo registro: el detalle de permisos por módulo se gestiona en el módulo de
 * Permisos. Admin puede cambiar rol, quitar usuario y enviar liga de reset.
 */

import { KeyRound, Mail, ShieldCheck, Trash2, User as UserIcon } from 'lucide-react';
import { ASSIGNABLE_ROLE_IDS, ROLES } from '../../../config/roles';
import type { ManagedRole, ManagedUser } from '../services/accessControlStore';

interface UsersTableProps {
  users: ManagedUser[];
  canEdit: boolean;
  /** Hay una escritura en vuelo (modo online): deshabilita rol, contraseña y eliminar. */
  mutating?: boolean;
  canSendReset: boolean;
  resettingEmail: string | null;
  /** Correo del usuario actual, para destacar su propia fila. */
  currentEmail: string | null;
  onRoleChange?: (email: string, role: ManagedRole) => void;
  onRemove?: (email: string) => void;
  onSendReset?: (email: string) => void;
  /** Admin fija directamente la contraseña del usuario (sin liga). */
  onSetPassword?: (email: string) => void;
}

export default function UsersTable({
  users,
  canEdit,
  mutating = false,
  canSendReset,
  resettingEmail,
  currentEmail,
  onRoleChange,
  onRemove,
  onSendReset,
  onSetPassword,
}: UsersTableProps) {
  if (users.length === 0) {
    return (
      <div
        className="rounded-[var(--radius-lg)] p-8 text-center text-[13px]"
        style={{ background: 'var(--card)', border: '1px solid var(--gray-200)', color: 'var(--gray-500)' }}
      >
        No hay usuarios registrados todavía. Agrega un correo arriba para empezar.
      </div>
    );
  }

  const normalizedCurrent = currentEmail ? currentEmail.trim().toLowerCase() : null;
  const hasActions = Boolean(onSetPassword || onSendReset || (canEdit && onRemove));

  return (
    <div
      className="overflow-x-auto rounded-[var(--radius-lg)]"
      style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
    >
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--gray-200)', color: 'var(--gray-500)' }}>
            <th className="px-4 py-3 font-medium">Correo</th>
            <th className="px-4 py-3 font-medium">Rol</th>
            {hasActions && <th className="px-4 py-3 text-right font-medium">Acciones</th>}
          </tr>
        </thead>
        <tbody>
          {users.map((row) => {
            const isCurrent = normalizedCurrent !== null && row.email === normalizedCurrent;
            const isAdmin = row.role === 'admin';
            return (
              <tr
                key={row.email}
                style={{
                  borderBottom: '1px solid var(--gray-100)',
                  background: isCurrent ? 'var(--gray-50)' : 'transparent',
                }}
              >
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: 'var(--gray-950)' }}>
                      {row.email}
                    </span>
                    {isCurrent && (
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ background: 'var(--primary)', color: '#fff' }}
                      >
                        Tú
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 align-middle">
                  {canEdit && onRoleChange ? (
                    <select
                      value={row.role}
                      disabled={mutating}
                      onChange={(e) => onRoleChange(row.email, e.target.value as ManagedRole)}
                      className="h-9 rounded-[var(--radius-md)] border px-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ borderColor: 'var(--gray-200)', background: 'var(--input)', color: 'var(--gray-950)' }}
                      aria-label={`Rol de ${row.email}`}
                    >
                      {ASSIGNABLE_ROLE_IDS.map((r) => (
                        <option key={r} value={r}>
                          {ROLES[r].label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
                      style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}
                    >
                      {isAdmin ? (
                        <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                      ) : (
                        <UserIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
                      )}
                      {ROLES[row.role].label}
                    </span>
                  )}
                </td>
                {hasActions && (
                  <td className="px-4 py-3 align-middle">
                    <div className="flex justify-end gap-2">
                      {onSetPassword && (
                        <button
                          type="button"
                          onClick={() => onSetPassword(row.email)}
                          disabled={mutating}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-[12px] font-medium transition-colors hover:bg-[var(--gray-100)] disabled:cursor-not-allowed disabled:opacity-60"
                          style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-700)' }}
                          aria-label={`Cambiar contraseña de ${row.email}`}
                        >
                          <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          Cambiar contraseña
                        </button>
                      )}
                      {canSendReset && onSendReset && (
                        <button
                          type="button"
                          onClick={() => onSendReset(row.email)}
                          disabled={resettingEmail !== null}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-[12px] font-medium transition-colors hover:bg-[var(--gray-100)] disabled:cursor-not-allowed disabled:opacity-60"
                          style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-700)' }}
                          aria-label={`Enviar reset de contraseña a ${row.email}`}
                        >
                          <Mail className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          {resettingEmail === row.email ? 'Enviando...' : 'Enviar reset'}
                        </button>
                      )}
                      {canEdit && onRemove && (
                        <button
                          type="button"
                          onClick={() => onRemove(row.email)}
                          disabled={isCurrent || mutating}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-[12px] font-medium transition-colors hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-600)' }}
                          aria-label={`Quitar a ${row.email}`}
                          title={isCurrent ? 'No puedes quitarte a ti mismo' : 'Quitar usuario'}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          Quitar
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
