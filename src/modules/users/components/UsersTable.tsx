/**
 * Tabla de usuarios: correo, rol y módulos visibles.
 *
 * Read-only por defecto. Cuando `canEdit` es `true` (solo `admin`), el rol se
 * vuelve un `<select>` editable. La edición es SOLO de sesión — el mapeo
 * durable vive en `.env` (`VITE_USER_ROLES`); ver aviso en `UsersDashboard`.
 */

import { ShieldCheck } from 'lucide-react';
import { ROLES, ROLE_IDS, type Role } from '../../../config/roles';
import type { UserRow } from '../services/usersService';

interface UsersTableProps {
  rows: UserRow[];
  canEdit: boolean;
  /** Correo del usuario actual, para destacar su propia fila. */
  currentEmail: string | null;
  onRoleChange?: (email: string, role: Role) => void;
}

export default function UsersTable({ rows, canEdit, currentEmail, onRoleChange }: UsersTableProps) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-[var(--radius-lg)] p-8 text-center text-[13px]"
        style={{ background: 'var(--card)', border: '1px solid var(--gray-200)', color: 'var(--gray-500)' }}
      >
        No hay usuarios configurados. Define el mapeo correo:rol en{' '}
        <code className="font-mono">VITE_USER_ROLES</code> (archivo <code className="font-mono">.env</code>).
      </div>
    );
  }

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
            <th className="px-4 py-3 font-medium">Módulos visibles</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isCurrent = currentEmail !== null && row.email === currentEmail.trim().toLowerCase();
            return (
              <tr
                key={row.email}
                style={{
                  borderBottom: '1px solid var(--gray-100)',
                  background: isCurrent ? 'var(--gray-50)' : 'transparent',
                }}
              >
                <td className="px-4 py-3 align-top">
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
                <td className="px-4 py-3 align-top">
                  {canEdit && onRoleChange ? (
                    <select
                      value={row.role}
                      onChange={(e) => onRoleChange(row.email, e.target.value as Role)}
                      className="h-9 rounded-[var(--radius-md)] border px-2 text-[13px]"
                      style={{ borderColor: 'var(--gray-200)', background: 'var(--input)', color: 'var(--gray-950)' }}
                      aria-label={`Rol de ${row.email}`}
                    >
                      {ROLE_IDS.map((r) => (
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
                      {row.fullAccess && <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />}
                      {row.roleLabel}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 align-top">
                  {row.fullAccess ? (
                    <span className="text-[12px] font-medium" style={{ color: 'var(--primary)' }}>
                      Todos los módulos
                    </span>
                  ) : row.tabLabels.length === 0 ? (
                    <span className="text-[12px]" style={{ color: 'var(--gray-400)' }}>
                      Sin acceso
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {row.tabLabels.map((label) => (
                        <span
                          key={label}
                          className="rounded-md px-2 py-0.5 text-[11px]"
                          style={{ background: 'var(--gray-100)', color: 'var(--gray-600)' }}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
