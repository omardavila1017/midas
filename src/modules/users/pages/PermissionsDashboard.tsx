/**
 * Módulo de Permisos — elige un usuario y prende/apaga su acceso a cada módulo
 * con switches. Visible solo para `admin`.
 *
 * `admin` ve todo (switches forzados ON, no editables — cambia su rol en
 * Usuarios). `user` ve solo los módulos habilitados aquí. Los tabs admin-only
 * (Usuarios, Permisos) no son habilitables — solo el rol admin los ve.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, ShieldCheck, User as UserIcon } from 'lucide-react';
import PageHeader from '../../../components/ui/PageHeader';
import { useAuth } from '../../../contexts/AuthContext';
import { PERMISSION_GROUPS, GRANTABLE_TABS, tabLabel } from '../../../config/appTabs';
import {
  getHardcodedFloorTabs,
  listManagedUsers,
  setPermission,
  setPermissions,
  subscribeAccessChanged,
  type ManagedUser,
} from '../services/accessControlStore';
import PermissionToggle from '../components/PermissionToggle';
import AccessNotEnforcedBanner from '../components/AccessNotEnforcedBanner';
import LocalRegistryNote from '../components/LocalRegistryNote';
import { useToast } from '../../../components/Toast';

export default function PermissionsDashboard() {
  const { role } = useAuth();
  const toast = useToast();
  const canEdit = role === 'admin';

  const [users, setUsers] = useState<ManagedUser[]>(() => listManagedUsers());
  const reload = useCallback(() => setUsers(listManagedUsers()), []);
  useEffect(() => subscribeAccessChanged(reload), [reload]);

  const [selectedEmail, setSelectedEmail] = useState<string | null>(() => listManagedUsers()[0]?.email ?? null);

  // Mantén una selección válida cuando cambia la lista de usuarios.
  useEffect(() => {
    if (users.length === 0) {
      setSelectedEmail(null);
      return;
    }
    if (!selectedEmail || !users.some((u) => u.email === selectedEmail)) {
      setSelectedEmail(users[0].email);
    }
  }, [users, selectedEmail]);

  const selected = useMemo(
    () => users.find((u) => u.email === selectedEmail) ?? null,
    [users, selectedEmail],
  );

  // Piso hardcodeado del JSON (`authLocalUsers.json`): módulos que este usuario
  // SIEMPRE ve, en todos los navegadores. Se muestran forzados ON y no editables
  // aquí (para quitarlos se edita el JSON) — mismo trato que un admin.
  const floorSet = useMemo(
    () => new Set(getHardcodedFloorTabs(selected?.email ?? null)),
    [selected],
  );

  const grantedSet = useMemo(
    () => new Set([...(selected?.permissions ?? []), ...floorSet]),
    [selected, floorSet],
  );

  const handleToggle = (tab: (typeof GRANTABLE_TABS)[number], enabled: boolean) => {
    if (!selected || !canEdit || selected.role === 'admin') return;
    setPermission(selected.email, tab, enabled);
    reload();
  };

  const handleSetAll = (enabled: boolean) => {
    if (!selected || !canEdit || selected.role === 'admin') return;
    setPermissions(selected.email, enabled ? [...GRANTABLE_TABS] : []);
    reload();
    toast.success(enabled ? 'Se habilitaron todos los módulos.' : 'Se quitaron todos los módulos.');
  };

  if (users.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader meta="Administración" title="Permisos" subtitle="Habilita módulos por usuario." />
        <div
          className="rounded-[var(--radius-lg)] p-8 text-center text-[13px]"
          style={{ background: 'var(--card)', border: '1px solid var(--gray-200)', color: 'var(--gray-500)' }}
        >
          No hay usuarios registrados. Agrega usuarios en el módulo de Usuarios.
        </div>
      </div>
    );
  }

  const isAdminUser = selected?.role === 'admin';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          meta="Administración"
          title="Permisos"
          subtitle="Elige un usuario y prende o apaga su acceso a cada módulo."
        />
      </div>

      <AccessNotEnforcedBanner />
      <LocalRegistryNote />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_1fr]">
        {/* Lista de usuarios */}
        <div
          className="overflow-hidden rounded-[var(--radius-lg)]"
          style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
        >
          <div
            className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
          >
            Usuarios
          </div>
          <ul className="max-h-[520px] overflow-y-auto">
            {users.map((u) => {
              const active = u.email === selectedEmail;
              return (
                <li key={u.email}>
                  <button
                    type="button"
                    onClick={() => setSelectedEmail(u.email)}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13px] transition-colors"
                    style={{
                      background: active ? 'var(--primary-muted)' : 'transparent',
                      color: active ? 'var(--primary)' : 'var(--gray-800)',
                      borderBottom: '1px solid var(--gray-100)',
                    }}
                  >
                    {u.role === 'admin' ? (
                      <ShieldCheck className="h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
                    ) : (
                      <UserIcon className="h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{u.email}</span>
                    {u.role === 'user' && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: 'var(--gray-100)', color: 'var(--gray-500)' }}
                      >
                        {u.permissions.length}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Switches del usuario seleccionado */}
        <div
          className="rounded-[var(--radius-lg)] p-5"
          style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
        >
          {selected && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                    {selected.email}
                  </p>
                  <p className="text-[12px]" style={{ color: 'var(--gray-500)' }}>
                    {isAdminUser ? 'Administrador · acceso total' : 'Usuario · acceso por permisos'}
                  </p>
                </div>
                {!isAdminUser && canEdit && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSetAll(true)}
                      className="h-8 rounded-[var(--radius-md)] border px-2.5 text-[12px] font-medium transition-colors hover:bg-[var(--gray-100)]"
                      style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-700)' }}
                    >
                      Todos
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetAll(false)}
                      className="h-8 rounded-[var(--radius-md)] border px-2.5 text-[12px] font-medium transition-colors hover:bg-[var(--gray-100)]"
                      style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-700)' }}
                    >
                      Ninguno
                    </button>
                  </div>
                )}
              </div>

              {isAdminUser ? (
                <div
                  className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-4 py-3 text-[12px]"
                  style={{ background: 'var(--primary-muted)', color: 'var(--primary)' }}
                >
                  <Info className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
                  <p className="leading-relaxed">
                    Un administrador ve todos los módulos. Para gestionar permisos individuales, cambia su
                    rol a <strong>Usuario</strong> en el módulo de Usuarios.
                  </p>
                </div>
              ) : (
                <div className="space-y-5">
                  {PERMISSION_GROUPS.map((group) => (
                    <div key={group.section}>
                      <p
                        className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]"
                        style={{ color: 'var(--gray-400)' }}
                      >
                        {group.section}
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {group.tabs.map((tab) => {
                          const checked = grantedSet.has(tab);
                          const forced = floorSet.has(tab);
                          return (
                            <label
                              key={tab}
                              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-[13px]"
                              style={{
                                borderColor: 'var(--gray-200)',
                                background: checked ? 'var(--gray-50)' : 'transparent',
                              }}
                            >
                              <span className="flex items-center gap-1.5" style={{ color: 'var(--gray-800)' }}>
                                {tabLabel(tab)}
                                {forced && (
                                  <span
                                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                                    style={{ background: 'var(--primary-muted)', color: 'var(--primary)' }}
                                    title="Módulo fijo del roster (authLocalUsers.json). Se edita en el JSON, no aquí."
                                  >
                                    Fijo
                                  </span>
                                )}
                              </span>
                              <PermissionToggle
                                checked={checked}
                                disabled={!canEdit || forced}
                                label={`Acceso a ${tabLabel(tab)}`}
                                onChange={(enabled) => handleToggle(tab, enabled)}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
