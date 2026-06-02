/**
 * Módulo de Usuarios — visible solo para `admin` y `mesa_ayuda`.
 *
 * Muestra el mapeo correo → rol → módulos visibles leído de `.env`
 * (`VITE_USER_ROLES`, parseado en `userRoles.ts`). `admin` puede editar el rol
 * de cada usuario; `mesa_ayuda` es solo lectura.
 *
 * Nota de honestidad: la edición es SOLO de sesión (estado local). El mapeo
 * durable vive en `.env` / backend — esta UI no escribe a `.env` (los `VITE_*`
 * se embeben en build-time). Sirve para inspección y para previsualizar el
 * efecto de un cambio de rol antes de aplicarlo en configuración.
 */

import { useMemo, useState } from 'react';
import { Info, UserCog } from 'lucide-react';
import PageHeader from '../../../components/ui/PageHeader';
import { useAuth } from '../../../contexts/AuthContext';
import type { Role } from '../../../config/roles';
import { buildUserRow, buildUsersView } from '../services/usersService';
import UsersTable from '../components/UsersTable';

export default function UsersDashboard() {
  const { role, email } = useAuth();
  const canEdit = role === 'admin';

  // Filas base derivadas de `.env`. Las ediciones de admin se guardan como
  // overrides de sesión (no se persisten — ver nota del módulo).
  const baseRows = useMemo(() => buildUsersView(), []);
  const [overrides, setOverrides] = useState<Record<string, Role>>({});

  const rows = useMemo(
    () =>
      baseRows.map((row) =>
        overrides[row.email] ? buildUserRow(row.email, overrides[row.email]) : row,
      ),
    [baseRows, overrides],
  );

  const handleRoleChange = (targetEmail: string, nextRole: Role) => {
    setOverrides((prev) => ({ ...prev, [targetEmail]: nextRole }));
  };

  return (
    <div className="space-y-5">
      <PageHeader
        meta="Administración"
        title="Usuarios"
        subtitle="Mapeo de correos a roles y módulos visibles (RBAC)."
        actions={
          <span
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-[12px] font-medium"
            style={{ background: 'var(--gray-100)', color: 'var(--gray-600)' }}
          >
            <UserCog className="h-4 w-4" strokeWidth={1.75} />
            {canEdit ? 'Edición habilitada' : 'Solo lectura'}
          </span>
        }
      />

      <div
        className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-4 py-3 text-[12px]"
        style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', color: 'var(--gray-600)' }}
      >
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
        <p className="leading-relaxed">
          El mapeo durable de correos a roles vive en <code className="font-mono">.env</code>{' '}
          (<code className="font-mono">VITE_USER_ROLES</code>), fuera del repositorio. Los cambios
          que hagas aquí son solo de esta sesión y no se guardan. La autorización vinculante la
          aplica el backend; este módulo controla qué se muestra en la interfaz.
        </p>
      </div>

      <UsersTable
        rows={rows}
        canEdit={canEdit}
        currentEmail={email}
        onRoleChange={canEdit ? handleRoleChange : undefined}
      />
    </div>
  );
}
