/**
 * Módulo de Usuarios — visible solo para `admin` y `mesa_ayuda`.
 *
 * Muestra el mapeo correo → rol → módulos visibles. `admin` puede previsualizar
 * cambios de rol en sesión; `mesa_ayuda` solo puede enviar ligas de reset.
 */

import { useMemo, useState } from 'react';
import { Info, UserCog } from 'lucide-react';
import PageHeader from '../../../components/ui/PageHeader';
import { useAuth } from '../../../contexts/AuthContext';
import type { Role } from '../../../config/roles';
import { buildUserRow, buildUsersView, canManagePasswordReset } from '../services/usersService';
import UsersTable from '../components/UsersTable';
import { sendUserPasswordReset } from '../../../services/authApi';
import { useToast } from '../../../components/Toast';

export default function UsersDashboard() {
  const { role, email } = useAuth();
  const toast = useToast();
  const canEdit = role === 'admin';
  const canSendReset = canManagePasswordReset(role);
  const [resettingEmail, setResettingEmail] = useState<string | null>(null);

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

  const handleSendReset = async (targetEmail: string) => {
    setResettingEmail(targetEmail);
    try {
      await sendUserPasswordReset(targetEmail);
      toast.success('Liga de restablecimiento enviada.');
    } catch {
      toast.error('No se pudo enviar la liga de restablecimiento.');
    } finally {
      setResettingEmail(null);
    }
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
            {canEdit ? 'Edición habilitada' : canSendReset ? 'Mesa de ayuda' : 'Solo lectura'}
          </span>
        }
      />

      <div
        className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-4 py-3 text-[12px]"
        style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', color: 'var(--gray-600)' }}
      >
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
        <p className="leading-relaxed">
          La sesión, contraseñas y ligas de restablecimiento viven en el backend de autenticación.
          El mapeo correo→rol visible aquí sigue siendo una vista de RBAC para la interfaz; la
          autorización vinculante la aplica el backend. Mesa de ayuda puede enviar ligas de reset,
          pero no definir contraseñas.
        </p>
      </div>

      <UsersTable
        rows={rows}
        canEdit={canEdit}
        canSendReset={canSendReset}
        resettingEmail={resettingEmail}
        currentEmail={email}
        onRoleChange={canEdit ? handleRoleChange : undefined}
        onSendReset={canSendReset ? handleSendReset : undefined}
      />
    </div>
  );
}
