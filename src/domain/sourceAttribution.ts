/**
 * Source attribution — de dónde viene cada renglón de detalle en Midas.
 *
 * El usuario pidió que en CADA detalle (no en los totales) se pueda ver la
 * fuente de la que Midas tomó el dato, y AMBAS fuentes cuando el renglón es un
 * cruce (p. ej. una factura de Cobranza que ROL confirmó, o un depósito de la
 * concentradora Citi prorrateado por Cobranza).
 *
 * Este módulo es la ÚNICA fuente de verdad para:
 *  - el catálogo de fuentes (`SOURCE_CATALOG`) con etiqueta es-MX + origen técnico,
 *  - el resolver por `FinancialMovement.id` (`attributeMovementId`) — el prefijo
 *    del id codifica la fuente (mapa completo en `docs/MAPA-CONEXIONES-APIS.md`),
 *  - los helpers para construir la atribución de un renglón crudo/cruzado y
 *    para emitirla a CSV (`sourceCsvFields`).
 *
 * Es PURO y no importa de React ni de los motores — para no crear ciclos y para
 * poder testearlo aislado (`sourceAttribution.test.ts`). La UI lo consume vía
 * `SourceInfo` (el ícono ⓘ con tooltip) y los builders de CSV lo consumen vía
 * `sourceCsvFields`.
 */

/** Identificador canónico de una fuente del datalake de Midas. */
export type SourceId =
  | 'bancos'
  | 'cobranza'
  | 'cobranzaindicadores'
  | 'rol'
  | 'viajes-especiales'
  | 'cxp'
  | 'compras'
  | 'pagoproveedor'
  | 'auxiliarcontable'
  | 'tress-nomina'
  | 'catalog-clients'
  | 'catalog-providers'
  | 'catalog-bankaccounts'
  | 'convenio'
  | 'fideicomiso-config'
  | 'impuestos'
  | 'computed';

export interface SourceDescriptor {
  id: SourceId;
  /** Etiqueta corta es-MX (lo que ve el usuario en el chip/tooltip). */
  label: string;
  /** Origen técnico (API / archivo), para la línea de detalle del tooltip. */
  origin: string;
}

/**
 * Catálogo declarativo de fuentes. Las etiquetas están en es-MX; el `origin`
 * apunta al endpoint/archivo real (útil para depurar de dónde salió el dato).
 */
export const SOURCE_CATALOG: Record<SourceId, SourceDescriptor> = {
  bancos: { id: 'bancos', label: 'Bancos', origin: 'Estado de cuenta · /jde/bancos' },
  cobranza: { id: 'cobranza', label: 'Cobranza JDE', origin: 'Facturas CXC · /jde/cobranza' },
  cobranzaindicadores: {
    id: 'cobranzaindicadores',
    label: 'Pagos aplicados',
    origin: 'Cobranza Indicadores · /jde/cobranzaindicadores',
  },
  rol: { id: 'rol', label: 'ROL CITI', origin: 'Viajes ejecutados · /citi/roldiario' },
  'viajes-especiales': {
    id: 'viajes-especiales',
    label: 'Viajes Especiales',
    origin: 'Servicios especiales · /viajes-especiales',
  },
  cxp: { id: 'cxp', label: 'CxP', origin: 'Antigüedad de saldos · /jde/antiguedadsaldos' },
  compras: { id: 'compras', label: 'Compras', origin: 'Órdenes de compra · /jde/compras' },
  pagoproveedor: {
    id: 'pagoproveedor',
    label: 'Pago a proveedores',
    origin: 'Pagos ejecutados · /jde/pagoproveedor',
  },
  auxiliarcontable: {
    id: 'auxiliarcontable',
    label: 'Auxiliar Contable',
    origin: 'Libro mayor 1010-1020 · /JDEdwards/AuxiliarContable',
  },
  'tress-nomina': { id: 'tress-nomina', label: 'Nómina TRESS', origin: 'Costos de nómina · TRESS /Nomina' },
  'catalog-clients': {
    id: 'catalog-clients',
    label: 'Catálogo de clientes',
    origin: 'Reglas de cobro (crédito / día de pago / frecuencia)',
  },
  'catalog-providers': {
    id: 'catalog-providers',
    label: 'Catálogo de proveedores',
    origin: 'Clasificación / prioridad / días de crédito',
  },
  'catalog-bankaccounts': {
    id: 'catalog-bankaccounts',
    label: 'Catálogo de cuentas',
    origin: 'Roles de cuenta / detección de traspasos',
  },
  convenio: {
    id: 'convenio',
    label: 'Convenio concursal',
    origin: 'Calendario del convenio (deuda firmada)',
  },
  'fideicomiso-config': {
    id: 'fideicomiso-config',
    label: 'Fideicomiso DINA',
    origin: 'Configuración del compromiso fijo',
  },
  impuestos: {
    id: 'impuestos',
    label: 'Módulo de Impuestos',
    origin: 'Reservas / obligaciones fiscales del motor',
  },
  computed: {
    id: 'computed',
    label: 'Calculado',
    origin: 'Derivado por el motor de Midas',
  },
};

export interface SourceAttribution {
  /** Fuentes que alimentan este renglón (≥1). */
  sources: SourceId[];
  /** true si el renglón combina 2+ fuentes (es un cruce). */
  crossed: boolean;
  /** Etiqueta corta, p. ej. "Cobranza JDE" o "ROL ↔ Cobranza JDE". */
  label: string;
  /** Detalle largo (multilínea) para el tooltip: orígenes + llave/nota del cruce. */
  detail: string;
  /** Llave del cruce cuando aplica (folio, UUID, batch, cuenta+fecha). Vacío si no. */
  crossKey?: string;
}

export interface AttributionOptions {
  /** Llave exacta que unió las fuentes (se muestra en tooltip y CSV). */
  crossKey?: string;
  /**
   * Nota adicional para el tooltip (p. ej. "fecha por regla del catálogo",
   * "conciliado contra CARGO bancario", "monto prorrateado por cobranza").
   */
  note?: string;
}

const labelFor = (id: SourceId): string => SOURCE_CATALOG[id]?.label ?? id;
const originFor = (id: SourceId): string => SOURCE_CATALOG[id]?.origin ?? id;

/**
 * Construye la atribución de un renglón a partir de sus fuentes.
 *
 * - `sources` en orden de importancia (la primera es la fuente principal).
 * - Se de-duplica preservando el orden.
 * - `crossed` = hay 2+ fuentes distintas.
 * - `label` = fuentes unidas con " ↔ " (una sola → su etiqueta).
 * - `detail` = una línea por fuente (etiqueta + origen) + llave/nota del cruce.
 */
export function makeAttribution(sources: SourceId[], opts: AttributionOptions = {}): SourceAttribution {
  const unique: SourceId[] = [];
  for (const s of sources) {
    if (s && !unique.includes(s)) unique.push(s);
  }
  const safe = unique.length > 0 ? unique : (['computed'] as SourceId[]);
  const crossed = safe.length > 1;
  const label = safe.map(labelFor).join(' ↔ ');

  const lines: string[] = [];
  lines.push(crossed ? 'Fuentes cruzadas:' : 'Fuente:');
  for (const s of safe) {
    lines.push(`• ${labelFor(s)} — ${originFor(s)}`);
  }
  if (opts.crossKey) lines.push(`Cruce: ${opts.crossKey}`);
  if (opts.note) lines.push(opts.note);

  return {
    sources: safe,
    crossed,
    label,
    detail: lines.join('\n'),
    crossKey: opts.crossKey,
  };
}

/** Atribución de una única fuente (azúcar sobre `makeAttribution`). */
export function sourceOf(id: SourceId, note?: string): SourceAttribution {
  return makeAttribution([id], note ? { note } : {});
}

/**
 * Tabla de prefijos de `FinancialMovement.id` → fuentes.
 *
 * ORDENADA de más específico a más general — el resolver toma la PRIMERA que
 * haga prefijo, así que `cxc:especial:viaje:` debe ir antes que `cxc:especial:`
 * y éste antes que `cxc:`. Mapa completo en `docs/MAPA-CONEXIONES-APIS.md` §2.
 */
const MOVEMENT_ID_SOURCES: ReadonlyArray<{
  prefix: string;
  sources: SourceId[];
  note?: string;
  crossed?: boolean;
}> = [
  // Ingreso — Viajes Especiales sintético (sin factura JDE cruzada)
  { prefix: 'cxc:especial:viaje:', sources: ['viajes-especiales'], note: 'Viaje especial sin factura cruzada; fecha = Fecha_Factura + días de crédito.' },
  // Ingreso — factura CXC que cruzó con un Viaje Especial (re-etiquetada)
  { prefix: 'cxc:especial:', sources: ['cobranza', 'viajes-especiales'], note: 'Factura de cobranza confirmada como Viaje Especial (cruce por folio/UUID).' },
  // Ingreso — factura CXC abierta (cobranza)
  { prefix: 'cxc:', sources: ['cobranza'], note: 'Factura abierta; fecha de cobro por regla del cliente o del API.' },
  // Ingreso — ROL proyectado (viaje ejecutado sin facturar)
  { prefix: 'rol:', sources: ['rol'], note: 'Viaje ejecutado sin facturar; fecha estimada por la regla del catálogo de clientes.' },
  // Histórico bancario
  { prefix: 'bank:', sources: ['bancos'] },
  // Plug de reconciliación de traspasos internos (neto, ancla la caja al banco)
  { prefix: 'internal-recon:', sources: ['bancos'], note: 'Neto de traspasos internos (reconciliación de caja contra el saldo bancario).' },
  // Rellenos históricos sin banco
  { prefix: 'cobranza-historic:', sources: ['cobranza'], note: 'Cobranza histórica sin línea bancaria cruzada.' },
  { prefix: 'auxiliar-historic:', sources: ['auxiliarcontable'], note: 'Movimiento del libro mayor sin línea bancaria cruzada.' },
  // Egreso — órdenes de compra
  { prefix: 'purchase:', sources: ['compras'], note: 'OC recibida; fecha de pago = recepción + días de crédito.' },
  { prefix: 'po:', sources: ['compras'], note: 'OC pedida sin recibir; fecha de pago proyectada por lead time + crédito.' },
  // Egreso — CXP abierta
  { prefix: 'cxp:', sources: ['cxp'], note: 'Factura por pagar abierta.' },
  // Egreso — nómina TRESS (futuro)
  { prefix: 'payroll:', sources: ['tress-nomina'] },
  // Prorrateo de la concentradora Citi por cobranza del cliente (cruce)
  { prefix: 'citi-prorrateo:', sources: ['bancos', 'cobranza'], note: 'Depósito de la concentradora Citi (monto bancario real) prorrateado entre clientes por su cobranza del mes.' },
  // Compromisos contractuales
  { prefix: 'fideicomiso-dina:', sources: ['fideicomiso-config'] },
  { prefix: 'fideicomiso-corning:', sources: ['bancos'], note: 'Ingreso CORNING real leído de los estados de cuenta Bajío.' },
  { prefix: 'convenio-payment:', sources: ['convenio'] },
  { prefix: 'convenio', sources: ['convenio'] },
  // Impuestos
  { prefix: 'tax-reserve:', sources: ['impuestos'], note: 'Reserva fiscal proyectada por el motor de impuestos.' },
  { prefix: 'tax-payment:', sources: ['impuestos'] },
  // Predictivo / sintéticos
  { prefix: 'forecast:trend:', sources: ['computed'], note: 'Complemento de tendencia (Holt-Winters) sobre lo ya comprometido.' },
  { prefix: 'recurring-provider:', sources: ['computed'], note: 'Patrón recurrente derivado del histórico.' },
  { prefix: 'recurring-operating:', sources: ['computed'], note: 'Patrón operativo recurrente derivado del histórico.' },
  { prefix: 'budget-opex-gap:', sources: ['computed'], note: 'Reserva presupuestal de opex.' },
  { prefix: 'client:', sources: ['catalog-clients'], note: 'Proyección genérica por regla del catálogo de clientes.' },
];

/**
 * Resuelve la fuente de un `FinancialMovement` a partir del prefijo de su `id`.
 *
 * Es el resolver central para las listas de movimientos (Planeación /
 * Proyección): cada movimiento ya lleva codificada su fuente en el id.
 * Desconocido → `computed` (nunca lanza).
 */
export function attributeMovementId(id: string | null | undefined): SourceAttribution {
  const key = String(id ?? '');
  for (const entry of MOVEMENT_ID_SOURCES) {
    if (key.startsWith(entry.prefix)) {
      return makeAttribution(entry.sources, { note: entry.note });
    }
  }
  return makeAttribution(['computed'], { note: 'Origen no clasificado por prefijo de id.' });
}

/**
 * Campos de fuente para una fila de CSV. Se hace spread dentro del objeto-fila
 * (`{ ...campos, ...sourceCsvFields(attr) }`) para que TODO export gane las
 * columnas "Fuente" y "Cruce" de forma consistente.
 */
export function sourceCsvFields(attr: SourceAttribution): { Fuente: string; Cruce: string } {
  return { Fuente: attr.label, Cruce: attr.crossKey ?? '' };
}
