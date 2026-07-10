import { Info } from 'lucide-react';
import { isLocalAuthEnabled } from '../../../services/localAuth';

/**
 * Aclara que las ediciones del portal (permisos extra sobre el piso, alta/baja,
 * cambio de rol) se guardan SOLO en este navegador y no se propagan a otros
 * usuarios ni dispositivos mientras el registro viva en localStorage (modo
 * local, store compartido apagado). El piso de roles/permisos sí viaja por el
 * archivo de configuración desplegado. Audit finding #2.2.
 */
export default function LocalRegistryNote() {
  if (!isLocalAuthEnabled()) return null;
  return (
    <div
      className="flex items-start gap-2.5 rounded-[var(--radius-md)] px-4 py-3 text-[12px]"
      style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', color: 'var(--gray-600)' }}
    >
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
      <p className="leading-relaxed">
        Los cambios que hagas aquí (permisos extra, alta/baja, cambio de rol) se guardan
        <strong> solo en este navegador</strong> — no se propagan a otros usuarios ni dispositivos.
        El acceso base viene del archivo de configuración que se despliega. Para que un cambio
        aplique a todos, debe capturarse en esa configuración.
      </p>
    </div>
  );
}
