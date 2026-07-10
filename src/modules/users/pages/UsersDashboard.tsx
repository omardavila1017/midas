/**
 * Módulo de Usuarios — registro de usuarios (correos) y su rol (admin/user).
 *
 * Solo registro: los permisos por módulo de un `user` se gestionan en el módulo
 * de **Permisos**. Visible solo para `admin`.
 *
 * Nota de provisión: registrar un correo aquí define su rol y permisos en la
 * capa UX. El alta real para INICIAR SESIÓN la sigue haciendo el backend de
 * autenticación (o el JSON local en dev) — esto no crea credenciales.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Info, UserCog, UserPlus } from 'lucide-react';
import PageHeader from '../../../components/ui/PageHeader';
import { useAuth } from '../../../contexts/AuthContext';
import { ASSIGNABLE_ROLE_IDS, ROLES } from '../../../config/roles';
import { canManagePasswordReset } from '../services/usersService';
import {
  listManagedUsers,
  removeUser,
  setUserRole,
  subscribeAccessChanged,
  upsertUser,
  type ManagedRole,
  type ManagedUser,
} from '../services/accessControlStore';
import UsersTable from '../components/UsersTable';
import SetPasswordModal from '../components/SetPasswordModal';
import AccessNotEnforcedBanner from '../components/AccessNotEnforcedBanner';
import LocalRegistryNote from '../components/LocalRegistryNote';
import { adminSetPassword, sendUserPasswordReset } from '../../../services/authApi';
import { isLocalAuthEnabled } from '../../../services/localAuth';
import { useToast } from '../../../components/Toast';

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function UsersDashboard() {
  const { role, email } = useAuth();
  const toast = useToast();
  const canEdit = role === 'admin';
  // En modo local (sin backend de correo) la "liga de reset" es no-op, así que
  // ofrecemos el cambio directo de contraseña en su lugar; en backend mostramos
  // ambos: cambio directo + envío de liga.
  const localMode = isLocalAuthEnabled();
  const canSendReset = canManagePasswordReset(role) && !localMode;
  const [resettingEmail, setResettingEmail] = useState<string | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [users, setUsers] = useState<ManagedUser[]>(() => listManagedUsers());
  const reload = useCallback(() => setUsers(listManagedUsers()), []);
  useEffect(() => subscribeAccessChanged(reload), [reload]);

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<ManagedRole>('user');

  const existingEmails = useMemo(() => new Set(users.map((u) => u.email)), [users]);

  const handleAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit) return;
    const value = newEmail.trim().toLowerCase();
    if (!looksLikeEmail(value)) {
      toast.error('Escribe un correo válido.');
      return;
    }
    if (existingEmails.has(value)) {
      toast.info('Ese correo ya está registrado.');
      return;
    }
    upsertUser(value, newRole);
    reload();
    setNewEmail('');
    setNewRole('user');
    toast.success(`Usuario ${value} registrado.`);
  };

  const handleRoleChange = (targetEmail: string, nextRole: ManagedRole) => {
    setUserRole(targetEmail, nextRole);
    reload();
  };

  const handleRemove = (targetEmail: string) => {
    removeUser(targetEmail);
    reload();
    toast.success(`Usuario ${targetEmail} eliminado.`);
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

  const handleSetPassword = async (newPassword: string) => {
    if (!passwordTarget) return;
    setSavingPassword(true);
    try {
      await adminSetPassword(passwordTarget, newPassword);
      toast.success(`Contraseña actualizada para ${passwordTarget}.`);
      setPasswordTarget(null);
    } catch {
      toast.error('No se pudo actualizar la contraseña.');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        meta="Administración"
        title="Usuarios"
        subtitle="Registra usuarios y su rol. Los permisos por módulo se definen en Permisos."
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

      <AccessNotEnforcedBanner />
      <LocalRegistryNote />

      <div
        className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-4 py-3 text-[12px]"
        style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', color: 'var(--gray-600)' }}
      >
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
        <p className="leading-relaxed">
          Hay dos roles: <strong>Administrador</strong> (acceso total) y <strong>Usuario</strong> (acceso
          por permisos). Para un usuario, prende o apaga el acceso a cada módulo en{' '}
          <strong>Permisos</strong>. El alta para iniciar sesión la realiza el backend de autenticación;
          aquí defines rol y permisos.
        </p>
      </div>

      {canEdit && (
        <form
          onSubmit={handleAdd}
          className="flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] p-4"
          style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
        >
          <label className="flex min-w-[240px] flex-1 flex-col gap-1.5">
            <span className="text-[12px] font-medium text-[var(--gray-600)]">Correo</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="usuario@gruposenda.com"
              className="h-10 rounded-[var(--radius-md)] border px-3 text-[13px]"
              style={{ borderColor: 'var(--gray-200)', background: 'var(--input)', color: 'var(--gray-950)' }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-[var(--gray-600)]">Rol</span>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as ManagedRole)}
              className="h-10 rounded-[var(--radius-md)] border px-2 text-[13px]"
              style={{ borderColor: 'var(--gray-200)', background: 'var(--input)', color: 'var(--gray-950)' }}
            >
              {ASSIGNABLE_ROLE_IDS.map((r) => (
                <option key={r} value={r}>
                  {ROLES[r].label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-md)] px-4 text-[13px] font-semibold text-white transition-colors"
            style={{ background: 'var(--primary)' }}
          >
            <UserPlus className="h-4 w-4" strokeWidth={2} aria-hidden />
            Agregar
          </button>
        </form>
      )}

      <UsersTable
        users={users}
        canEdit={canEdit}
        canSendReset={canSendReset}
        resettingEmail={resettingEmail}
        currentEmail={email}
        onRoleChange={canEdit ? handleRoleChange : undefined}
        onRemove={canEdit ? handleRemove : undefined}
        onSendReset={canSendReset ? handleSendReset : undefined}
        onSetPassword={canEdit ? (targetEmail) => setPasswordTarget(targetEmail) : undefined}
      />

      <SetPasswordModal
        email={passwordTarget}
        submitting={savingPassword}
        onClose={() => setPasswordTarget(null)}
        onSubmit={handleSetPassword}
      />
    </div>
  );
}
