/**
 * SourceInfo — ícono ⓘ discreto con tooltip que confiesa la fuente de un
 * renglón de detalle (y ambas fuentes cuando es un cruce).
 *
 * Diseño elegido con el usuario (2026-07-09): mínima saturación — un ícono de
 * información por renglón; la fuente aparece al pasar el mouse. Usa el atributo
 * nativo `title` (multilínea con `\n`), el mismo patrón que el resto de Midas
 * (`ProviderBadge`, etc.): es a prueba de recortes en tablas con overflow y en
 * el grid virtualizado, sin bugs de posicionamiento.
 *
 * Regla de negocio: se pone SOLO en detalles, NUNCA en totales/subtotales/KPIs.
 */

import { Info } from 'lucide-react';
import type { SourceAttribution } from '../../domain/sourceAttribution';

interface Props {
  /** Atribución ya resuelta (preferido). */
  attribution?: SourceAttribution;
  /** Alternativa: etiqueta + detalle sueltos (cuando no hay `SourceAttribution`). */
  label?: string;
  detail?: string;
  /** Marca visual de cruce (ícono en acento). Se infiere de `attribution` si viene. */
  crossed?: boolean;
  /** Tamaño del ícono en px. Default 12 (discreto, para tablas densas). */
  size?: number;
  className?: string;
}

/**
 * Ícono ⓘ + `title`. Neutro (gris) para una sola fuente; en acento cuando el
 * renglón es un cruce, para que se note "de un vistazo" que combina fuentes.
 */
export default function SourceInfo({ attribution, label, detail, crossed, size = 12, className }: Props) {
  const title = detail ?? attribution?.detail ?? label ?? attribution?.label ?? '';
  const isCrossed = crossed ?? attribution?.crossed ?? false;
  const aria = attribution?.label ?? label ?? 'Fuente';

  if (!title) return null;

  return (
    <span
      className={`inline-flex items-center align-middle cursor-help ${className ?? ''}`}
      title={title}
      role="img"
      aria-label={`Fuente: ${aria}`}
      tabIndex={0}
      style={{ color: isCrossed ? 'var(--accent-blue)' : 'var(--gray-400)' }}
    >
      <Info size={size} strokeWidth={2} />
    </span>
  );
}
