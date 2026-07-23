/**
 * Cruce ROL ↔ Cobranza.
 *
 * El ROL diario CITI (viajes ejecutados) y la cobranza JDE (facturas
 * emitidas) son dos vistas del mismo ingreso en momentos distintos del ciclo:
 *
 *   Viaje ejecutado  →  Factura emitida  →  Cobro recibido
 *   (ROL)               (Cobranza)          (Banco ABONO)
 *
 * Cuando el ROL trae `factura` o `uuidFiscal` poblados, podemos amarrar
 * directamente el viaje a la factura correspondiente en cobranza. Esto
 * permite distinguir 3 estados de ingreso:
 *
 *   - Predicho:  ROL ejecutado sin factura match en cobranza → predecir
 *                ingreso a partir de tripDate + creditDays + diaPago.
 *   - Facturado: ROL ejecutado CON factura match en cobranza → usar la
 *                fecha de vencimiento real de la factura.
 *   - Realizado: factura match Y cobranza muestra cobrada (Importe_Pendiente=0)
 *                → consultar también el match banco↔cobranza para fecha real.
 *
 * Este módulo SOLO maneja el primer cruce (ROL ↔ Cobranza); el cruce
 * Cobranza ↔ Banco vive en `realReconciliationEngine.ts`.
 *
 * El match es por NIVELES para llevar los huérfanos a ~0 (un viaje marcado
 * facturado en ROL SIEMPRE tiene una factura JDE detrás; un huérfano es un
 * defecto de cruce, no de negocio):
 *
 *   1. Folio exacto normalizado ("RI - 305405" == "RI-305405", multi-folio
 *      "RI-1/RI-2" se parte en candidatos).
 *   2. UUID fiscal normalizado (sin guiones/llaves, case-insensitive).
 *   3. Núcleo numérico del folio ("305405" == "RI-305405"), con guardia de
 *      cliente (si ambos lados traen clave de cliente y difieren → no match).
 *   4. Pagos aplicados de CobranzaIndicadores (`cobranzaPayments`): una
 *      factura cobrada con uno o varios pagos puede ya no venir (o venir
 *      distinto) en el CXC de /cobranza, pero el recibo sí registra el folio
 *      aplicado — eso NO es un huérfano, es una factura cobrada.
 */

import type {
  CobranzaPayment,
  CobranzaPaymentApplication,
  CobranzaRecord,
  RolRecord,
} from '../services/jdeTypes';

export type RolMatchSource = 'factura' | 'uuid' | 'factura-digits' | 'pago';

export interface RolCobranzaMatch {
  rol: RolRecord;
  /** Factura JDE en CXC cuando el match aterrizó en /cobranza. */
  cobranza?: CobranzaRecord;
  /**
   * Aplicación de pago (CobranzaIndicadores) cuando la factura ya no aparece
   * en el CXC pero el recibo registra el folio — factura cobrada.
   */
  payment?: CobranzaPaymentApplication;
  source: RolMatchSource;
}

export interface RolCobranzaCrossResult {
  matches: RolCobranzaMatch[];
  /** Viajes ROL sin factura en cobranza — proyección "predicha". */
  predicted: RolRecord[];
  /** Viajes ROL con factura pero match no encontrado (factura existe en ROL pero no en cobranza). */
  invoicedOrphans: RolRecord[];
  /**
   * Viajes ROL SIN clave de cliente JDE (Clave_JDE nula/vacía en CITI) que no
   * cruzaron: defecto de ALTA del cliente en CITI (auditoría BD 2026-07-22:
   * 102 viajes efectuados en 8 semanas, un solo cliente), accionable con CITI
   * — NO es huérfano de folio ni "match ok". Un viaje sin clave que SÍ cruzó
   * por folio/UUID exacto se queda en `matches` (el folio lo identifica
   * afirmativamente); aquí caen los que antes pasaban silenciosos a
   * `predicted`/`invoicedOrphans`. Consumidores que quieran el conjunto
   * "sin factura" completo (Venta, proyección ROL) deben unir
   * `predicted ∪ sinClaveCliente`.
   */
  sinClaveCliente: RolRecord[];
}

/** Clave de cliente JDE presente y no vacía — sin ella el viaje no puede fecharse por regla de cliente. */
export function hasClientKey(r: Pick<RolRecord, 'claveJDE'>): boolean {
  return trim(r.claveJDE) !== '';
}

function trim(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Placeholders que ROL CITI usa cuando el viaje aún no se factura — cuentan
 * como "sin factura" para que el cruce los marque `predicted`.
 */
const FACTURA_PLACEHOLDERS = new Set(['', '-', '0', 'N/A', 'NA', 'S/F', 'SF', 'SIN FACTURA']);

/**
 * Normaliza UN folio de factura para comparación exacta: case-insensitive,
 * guiones sin espacios alrededor y sin whitespace interno
 * ("RI - 305405" / "ri-305405 " → "RI-305405").
 *
 * Exportada: es el normalizador CANÓNICO de folio para todos los cruces
 * contra cobranza (ROL, Viajes Especiales, re-etiquetado del motor) — no
 * dupliques una versión local, la asimetría de normalización produce
 * no-matches silenciosos y dobles conteos.
 */
export function normFactura(value: string | undefined): string {
  const t = trim(value).toUpperCase();
  if (FACTURA_PLACEHOLDERS.has(t)) return '';
  return t.replace(/\s*-\s*/g, '-').replace(/\s+/g, '');
}

/**
 * Candidatos de folio del campo factura del ROL. El campo puede traer más de
 * un folio ("RI-1/RI-2", "305405, 305406") o espacios sueltos; se parte en
 * tokens y cada token se prueba contra los índices.
 */
function facturaCandidates(value: string | undefined): string[] {
  const t = trim(value).toUpperCase().replace(/\s*-\s*/g, '-');
  if (FACTURA_PLACEHOLDERS.has(t)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (token: string) => {
    const norm = normFactura(token);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  // El campo completo sin espacios va primero (caso 1 folio, el más común).
  push(t);
  for (const part of t.split(/[,;/|\s]+/)) push(part);
  return out;
}

/**
 * Núcleo numérico de un folio: solo dígitos, sin ceros a la izquierda.
 * "RI-0305405" y "305405" comparten núcleo "305405". Folios sin al menos
 * 3 dígitos no generan llave (evita matches basura con tokens tipo "RI").
 */
function facturaDigitsKey(value: string): string {
  const digits = value.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 3 ? digits : '';
}

/**
 * Normaliza UUID fiscal (SAT) a hex puro: sin guiones, llaves ni espacios,
 * case-insensitive. Placeholders "-"/"0"/"N/A" cuentan como ausentes.
 * Exportada por la misma razón que `normFactura`.
 */
export function normUuid(value: string | undefined): string {
  const t = trim(value).toUpperCase();
  if (FACTURA_PLACEHOLDERS.has(t)) return '';
  // Hex ESTRICTO (0-9 A-F): con [^0-9A-Z] un placeholder de texto libre
  // ("PENDIENTE", "SIN TIMBRAR") ≥8 chars generaba llave y dos placeholders
  // idénticos en ambos lados cruzaban un viaje contra una factura ajena —
  // apagando su `rol:` proyectado sin razón.
  const hex = t.replace(/[^0-9A-F]/g, '');
  return hex.length >= 8 ? hex : '';
}

function clientDigits(value: string | undefined): string {
  return (value ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * Guardia de cliente para los niveles laxos (núcleo numérico / pagos): si
 * AMBOS lados traen clave de cliente y difieren, el candidato se descarta —
 * dos clientes distintos no comparten factura aunque el número coincida.
 * Si algún lado no trae clave, no se puede descartar (se permite).
 */
function clientCompatible(rolClave: string | undefined, otherCliente: string | undefined): boolean {
  const a = clientDigits(rolClave);
  const b = clientDigits(otherCliente);
  if (!a || !b) return true;
  return a === b;
}

function pushIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Elige el mejor candidato cuando una llave indexa varias filas: mismo
 * cliente Y misma cia > mismo cliente > misma cia > primero.
 */
function pickBest<T extends { cia: string }>(
  candidates: T[],
  rol: RolRecord,
  clienteOf: (c: T) => string | undefined,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const rolCliente = clientDigits(rol.claveJDE);
  const score = (c: T): number => {
    const sameClient = rolCliente !== '' && clientDigits(clienteOf(c)) === rolCliente;
    const sameCia = c.cia === rol.cia;
    return (sameClient ? 2 : 0) + (sameCia ? 1 : 0);
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (let i = 1; i < candidates.length; i++) {
    const s = score(candidates[i]);
    if (s > bestScore) {
      best = candidates[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * Construye índices por folio (exacto + núcleo numérico) y UUID desde
 * cobranza CXC y, opcionalmente, desde las aplicaciones de pago de
 * CobranzaIndicadores; cruza contra ROL por niveles. ROL sin factura emitida
 * queda en `predicted`; ROL con factura que no aparece en ningún índice queda
 * en `invoicedOrphans` (cobranza/pagos aún no sincronizados o fuera del rango
 * cargado).
 */
export function buildRolCobranzaCross(
  rolRecords: RolRecord[],
  cobranzaRecords: CobranzaRecord[],
  cobranzaPayments: CobranzaPayment[] = [],
): RolCobranzaCrossResult {
  const cobranzaByFactura = new Map<string, CobranzaRecord[]>();
  const cobranzaByDigits = new Map<string, CobranzaRecord[]>();
  const cobranzaByUuid = new Map<string, CobranzaRecord[]>();
  for (const c of cobranzaRecords) {
    const factura = normFactura(c.noFactura);
    if (factura) {
      pushIndex(cobranzaByFactura, factura, c);
      const digits = facturaDigitsKey(factura);
      if (digits) pushIndex(cobranzaByDigits, digits, c);
    }
    const uuid = normUuid(c.uuidFiscal);
    if (uuid) pushIndex(cobranzaByUuid, uuid, c);
  }

  const paymentByFactura = new Map<string, CobranzaPaymentApplication[]>();
  const paymentByDigits = new Map<string, CobranzaPaymentApplication[]>();
  for (const payment of cobranzaPayments) {
    for (const app of payment.applications) {
      const factura = normFactura(app.noFacturaNormalizada || app.noFactura);
      if (!factura) continue;
      pushIndex(paymentByFactura, factura, app);
      const digits = facturaDigitsKey(factura);
      if (digits) pushIndex(paymentByDigits, digits, app);
    }
  }

  const matches: RolCobranzaMatch[] = [];
  const predicted: RolRecord[] = [];
  const invoicedOrphans: RolRecord[] = [];
  const sinClaveCliente: RolRecord[] = [];

  for (const r of rolRecords) {
    const candidates = facturaCandidates(r.factura);
    const uuid = normUuid(r.uuidFiscal);

    // Sin factura ni uuid → viaje aún no facturado, predicción.
    if (candidates.length === 0 && !uuid) {
      // Sin clave de cliente NO es una predicción sana (no puede fecharse por
      // regla de cliente): bucket propio para reclamar el alta a CITI.
      if (!hasClientKey(r)) sinClaveCliente.push(r);
      else predicted.push(r);
      continue;
    }

    let match: RolCobranzaMatch | undefined;

    // 1. Match exacto por folio normalizado (precisión alta).
    for (const factura of candidates) {
      const hit = pickBest(cobranzaByFactura.get(factura) ?? [], r, (c) => c.noCliente);
      if (hit) {
        match = { rol: r, cobranza: hit, source: 'factura' };
        break;
      }
    }

    // 2. UUID fiscal (mismo viaje, otra emisión / otro folio).
    if (!match && uuid) {
      const hit = pickBest(cobranzaByUuid.get(uuid) ?? [], r, (c) => c.noCliente);
      if (hit) match = { rol: r, cobranza: hit, source: 'uuid' };
    }

    // 3. Núcleo numérico del folio ("305405" ↔ "RI-305405"), con guardia
    //    de cliente: nivel laxo, nunca cruza clientes distintos.
    if (!match) {
      for (const factura of candidates) {
        const digits = facturaDigitsKey(factura);
        if (!digits) continue;
        const pool = (cobranzaByDigits.get(digits) ?? []).filter((c) =>
          clientCompatible(r.claveJDE, c.noCliente),
        );
        const hit = pickBest(pool, r, (c) => c.noCliente);
        if (hit) {
          match = { rol: r, cobranza: hit, source: 'factura-digits' };
          break;
        }
      }
    }

    // 4. Pagos aplicados (CobranzaIndicadores): la factura ya se cobró —
    //    puede no venir en el CXC, pero el recibo registra el folio.
    if (!match) {
      for (const factura of candidates) {
        const exact = (paymentByFactura.get(factura) ?? []).filter((a) =>
          clientCompatible(r.claveJDE, a.noCliente),
        );
        const digits = facturaDigitsKey(factura);
        const byDigits = digits
          ? (paymentByDigits.get(digits) ?? []).filter((a) => clientCompatible(r.claveJDE, a.noCliente))
          : [];
        const hit = pickBest(exact, r, (a) => a.noCliente)
          ?? pickBest(byDigits, r, (a) => a.noCliente);
        if (hit) {
          match = { rol: r, payment: hit, source: 'pago' };
          break;
        }
      }
    }

    if (match) matches.push(match);
    // Sin clave de cliente el no-match no es huérfano de folio: es defecto de
    // alta en CITI — no contamina el conteo de huérfanos (meta: 0).
    else if (!hasClientKey(r)) sinClaveCliente.push(r);
    // ROL marcado como facturado pero ni cobranza ni pagos lo tienen → huérfano.
    else invoicedOrphans.push(r);
  }

  return { matches, predicted, invoicedOrphans, sinClaveCliente };
}

/**
 * Resumen tabular por cliente — útil para dashboards y debug. Devuelve total
 * de viajes y subTotal del ROL en cada estado (predicho/facturado/huérfano).
 */
export interface RolCrossSummaryByClient {
  claveJDE: string;
  dCliente: string;
  predictedTrips: number;
  predictedAmount: number;
  invoicedTrips: number;
  invoicedAmount: number;
  orphanTrips: number;
  orphanAmount: number;
  /** Viajes sin clave de cliente JDE (defecto de alta en CITI) — agrupan por razón social. */
  sinClaveTrips: number;
  sinClaveAmount: number;
}

export function summarizeRolCrossByClient(result: RolCobranzaCrossResult): RolCrossSummaryByClient[] {
  const byClient = new Map<string, RolCrossSummaryByClient>();
  const ensure = (claveJDE: string, dCliente: string): RolCrossSummaryByClient => {
    let entry = byClient.get(claveJDE);
    if (!entry) {
      entry = {
        claveJDE, dCliente,
        predictedTrips: 0, predictedAmount: 0,
        invoicedTrips: 0, invoicedAmount: 0,
        orphanTrips: 0, orphanAmount: 0,
        sinClaveTrips: 0, sinClaveAmount: 0,
      };
      byClient.set(claveJDE, entry);
    }
    return entry;
  };
  for (const r of result.predicted) {
    const e = ensure(r.claveJDE, r.dCliente);
    e.predictedTrips += r.viajes;
    e.predictedAmount += r.subTotal;
  }
  for (const m of result.matches) {
    const e = ensure(m.rol.claveJDE, m.rol.dCliente);
    e.invoicedTrips += m.rol.viajes;
    e.invoicedAmount += m.rol.subTotal;
  }
  for (const r of result.invoicedOrphans) {
    const e = ensure(r.claveJDE, r.dCliente);
    e.orphanTrips += r.viajes;
    e.orphanAmount += r.subTotal;
  }
  // Sin clave JDE no hay llave estable: agrupa por razón social para que el
  // desglose delate QUÉ cliente hay que dar de alta en CITI.
  for (const r of result.sinClaveCliente) {
    const e = ensure(trim(r.dCliente) || '(sin clave)', r.dCliente);
    e.sinClaveTrips += r.viajes;
    e.sinClaveAmount += r.subTotal;
  }
  return Array.from(byClient.values()).sort((a, b) =>
    (b.invoicedAmount + b.predictedAmount) - (a.invoicedAmount + a.predictedAmount)
  );
}
