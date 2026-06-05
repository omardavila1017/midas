import {
  ArrowLeftRight,
  Banknote,
  Building2,
  Bus,
  CircleDollarSign,
  CreditCard,
  Cpu,
  Globe,
  HardHat,
  HelpCircle,
  Landmark,
  type LucideIcon,
  Package,
  Pencil,
  PiggyBank,
  Receipt,
  Scale,
  Truck,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import type { FinancialMovementType } from '../../../shared-finance/types';

/**
 * Visual affordances (icono + color de acento) por bucket de la planeación.
 * Declarativo a propósito (patrón `roles.ts` / `glAccountFlowCatalog.ts`): el
 * mapa es la única fuente de verdad del color/ícono de cada categoría del flujo
 * de efectivo. Sólo decora — NO cambia clasificación, monto ni orden (eso vive
 * en `planningRowTaxonomy.ts`). Las etiquetas son las mismas que emite el motor;
 * por eso indexa por el label base (sin el sufijo ` · Subcategoría`).
 */
export interface BucketVisual {
  Icon: LucideIcon;
  /** Color del ícono. Token Senda DS o hex curado. */
  color: string;
}

// Todos los ingresos comparten la familia verde (señal "dinero que entra") con
// glifos distintos por origen, para que la sección lea como un bloque coherente.
const INCOME_COLOR = 'var(--success)';

const INCOME_VISUALS: Record<string, BucketVisual> = {
  AC: { Icon: Wallet, color: INCOME_COLOR },
  'Clientes Citi': { Icon: Bus, color: INCOME_COLOR },
  Federal: { Icon: Landmark, color: INCOME_COLOR },
  Multicarga: { Icon: Truck, color: INCOME_COLOR },
  Reserva: { Icon: PiggyBank, color: INCOME_COLOR },
  'Turimex LLC': { Icon: Globe, color: INCOME_COLOR },
  'Viajes Especiales': { Icon: Bus, color: INCOME_COLOR },
  'Traspasos internos (neto)': { Icon: ArrowLeftRight, color: 'var(--gray-400)' },
  'Otros ingresos': { Icon: CircleDollarSign, color: INCOME_COLOR },
};

const OUTFLOW_VISUALS: Record<string, BucketVisual> = {
  Flota: { Icon: Truck, color: '#D97706' },
  'Proveedor TI': { Icon: Cpu, color: '#4F46E5' },
  'Inmuebles y rentas': { Icon: Building2, color: '#0D9488' },
  'Personal y nómina': { Icon: Users, color: '#7C3AED' },
  Servicios: { Icon: Wrench, color: '#0891B2' },
  'Int. CM': { Icon: Scale, color: '#E11D48' },
  'Proveedores sin categoría': { Icon: Package, color: 'var(--gray-400)' },
  Impuestos: { Icon: Receipt, color: 'var(--danger)' },
  Nómina: { Icon: Users, color: '#7C3AED' },
  Deuda: { Icon: CreditCard, color: '#A21CAF' },
  CAPEX: { Icon: HardHat, color: '#2563EB' },
  OPEX: { Icon: Receipt, color: '#475569' },
  'Egresos bancarios sin identificar': { Icon: HelpCircle, color: 'var(--gray-400)' },
  'Traspasos internos (neto)': { Icon: ArrowLeftRight, color: 'var(--gray-400)' },
  Manual: { Icon: Pencil, color: 'var(--primary)' },
};

const INCOME_FALLBACK: BucketVisual = { Icon: CircleDollarSign, color: INCOME_COLOR };
const OUTFLOW_FALLBACK: BucketVisual = { Icon: Banknote, color: 'var(--gray-500)' };

/**
 * Resuelve el ícono + color de un bucket. `label` puede traer el sufijo de
 * subcategoría de proveedor (`Flota · Taller`); se indexa por la raíz.
 */
export function bucketVisual(label: string, type: FinancialMovementType): BucketVisual {
  const baseLabel = label.split(' · ')[0]?.trim() || label;
  if (type === 'INFLOW') return INCOME_VISUALS[baseLabel] ?? INCOME_FALLBACK;
  return OUTFLOW_VISUALS[baseLabel] ?? OUTFLOW_FALLBACK;
}
