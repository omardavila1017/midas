import { ShieldAlert } from 'lucide-react';
import { isLocalAuthEnabled, UNIVERSAL_PASSWORD_ACTIVE } from '../../../services/localAuth';

/**
 * Warns admins that the UI access gate is not being enforced while the
 * universal password bypass (`Senda123`) is live (see localAuth). Renders
 * nothing once the bypass is removed (`UNIVERSAL_PASSWORD_ACTIVE = false`) or
 * outside local-auth mode. Audit finding #12.
 */
export default function AccessNotEnforcedBanner() {
  if (!UNIVERSAL_PASSWORD_ACTIVE || !isLocalAuthEnabled()) return null;
  return (
    <div
      className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-4 py-3 text-[12px]"
      style={{
        background: 'var(--warning-muted)',
        border: '1px solid var(--warning)',
        color: 'var(--warning)',
      }}
      role="alert"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
      <p className="leading-relaxed">
        <strong>El control de acceso no está siendo forzado.</strong> Hay una contraseña
        universal temporal activa, así que cualquier cuenta conocida puede entrar y el botón
        “Cambiar contraseña” no tiene efecto real. Los roles y permisos de aquí controlan lo
        que se <em>muestra</em>, no lo que se puede <em>abrir</em>. Se quitará antes del
        despliegue en el que el acceso deba ser vinculante.
      </p>
    </div>
  );
}
