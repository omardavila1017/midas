/**
 * ProviderBadge — chip subtítulo para tablas transaccionales.
 *
 * Dado un código JDE + nombre, busca en el catálogo de proveedores y
 * muestra: "JDE 107671 · Crítico" cuando hay match, "Sin match" cuando no.
 *
 * Usado en Compras, CXP y Pagos para que el operador vea de inmediato si la
 * fila transaccional está cruzada con el catálogo.
 */

import {
  findProviderByRef,
  provierClassificationLabel,
  providerClassificationTone,
  type ProviderIndex,
} from '../domain/providerIdentity';

interface Props {
  index: ProviderIndex;
  jdeCode?: string | number | null;
  name?: string | null;
  /** Si false, no se renderiza la etiqueta "Sin match". Default true. */
  showUnmatched?: boolean;
}

export default function ProviderBadge({ index, jdeCode, name, showUnmatched = true }: Props) {
  const match = findProviderByRef(index, { jdeCode, name });

  if (!match.provider) {
    if (!showUnmatched) return null;
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
        style={{
          background: 'var(--gray-50)',
          color: 'var(--gray-400)',
          border: '1px solid var(--gray-200)',
        }}
        title="Proveedor sin coincidencia en el catálogo"
      >
        Sin catálogo
      </span>
    );
  }

  const label = provierClassificationLabel(match.provider);
  const tone = providerClassificationTone(match.provider);
  const jdeText = match.provider.numProveedorJDE
    ? `JDE ${match.provider.numProveedorJDE}`
    : 'JDE —';

  return (
    <span className="inline-flex items-center gap-1.5 text-[10px]">
      <span
        className="font-mono px-1.5 py-0.5 rounded text-[var(--gray-500)]"
        style={{ background: 'var(--gray-100)' }}
        title={`Match por ${match.matchKind === 'jde' ? 'código JDE' : 'nombre'}`}
      >
        {jdeText}
      </span>
      {label && tone && (
        <span
          className="px-1.5 py-0.5 rounded font-medium"
          style={{ background: tone.bg, color: tone.text, border: `1px solid ${tone.border}` }}
          title={match.provider.type || 'Sin categoría'}
        >
          {label}
        </span>
      )}
    </span>
  );
}
