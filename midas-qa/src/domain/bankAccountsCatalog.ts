/**
 * Bank Accounts Catalog — static metadata for Grupo Senda bank accounts.
 *
 * Source: src/assets/bankAccountsCatalog.json (treasury-maintained).
 * Each entry classifies a bank account by:
 *   - role: account purpose (concentradora, pagadora, reserva, etc.)
 *   - subRole: optional sub-classification (proveedores, nomina, dolares, taquillas, tpv, …)
 *   - flow: expected cash direction (ingreso = ABONOs sumar como ingreso real,
 *           egreso = CARGOs sumar como egreso real, neutro = traspasos internos)
 *
 * Lookups by CLABE or by normalized account digits. enrichMovementWithCatalog()
 * is the consumer-facing API: pass a bank movement, get back catalog entry +
 * directional flow (sign-aware: ingreso flips to egreso if tipoMovimiento=CARGO
 * on a concentradora, etc.).
 */

import catalogRaw from '../assets/bankAccountsCatalog.json';

export type BankAccountCurrency = 'MXN' | 'USD';

export type BankAccountRole =
  | 'concentradora'
  | 'pagadora'
  | 'reserva'
  | 'credito'
  | 'ahorro'
  | 'por_cancelar'
  | 'garantia'
  | 'saldo_retenido';

export type BankAccountFlow = 'ingreso' | 'egreso' | 'neutro';

export type BankAccountUnidadNegocio =
  | 'AC'
  | 'FEDERAL'
  | 'MULTICARGA'
  | 'CITI'
  | 'RESERVA'
  | 'TURIMEX LLC';

export interface BankAccountCatalogEntry {
  banco: string;
  numeroCliente: string | null;
  razonSocial: string;
  cuenta: string;
  cuentaDigits: string;
  clabe: string | null;
  moneda: BankAccountCurrency;
  unidadNegocio: BankAccountUnidadNegocio | string;
  concepto: string;
  role: BankAccountRole;
  subRole: string | null;
  flow: BankAccountFlow;
}

interface CatalogShape {
  version: string;
  generated: string;
  notes?: string[];
  currencyMap?: Record<string, BankAccountCurrency>;
  roleValues?: BankAccountRole[];
  flowValues?: BankAccountFlow[];
  accounts: BankAccountCatalogEntry[];
}

const catalog = catalogRaw as unknown as CatalogShape;

function digitsOnly(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\D+/g, '');
}

function stripLeadingZeros(s: string): string {
  return s.replace(/^0+/, '');
}

const byClabe = new Map<string, BankAccountCatalogEntry>();
const byCuentaDigits = new Map<string, BankAccountCatalogEntry>();
// Padding-tolerant fallback. JDE `/bancos` Cuenta_Bancos arrives with
// bank-specific zero-padding (Banamex padded to 11, Banorte 10, Santander
// as-is). When the API form doesn't match the catalog's `cuentaDigits`
// byte-for-byte, the exact lookup misses and the movement silently falls to
// "sin catálogo" (root cause of items 4 & 10). We index by the
// leading-zero-stripped form too, but ONLY for keys that stay unique after
// stripping — ambiguous keys are dropped so we never mis-attribute a movement
// to the wrong account.
const byCuentaDigitsStripped = new Map<string, BankAccountCatalogEntry>();
const ambiguousStripped = new Set<string>();
// El API de /bancos entrega la cuenta con su longitud natural (sin padding):
// "BANAMEX - 7014 350840" → dígitos "7014350840". Varios `cuentaDigits` del
// catálogo se rellenaron con ceros fantasma en v1.2 (teoría de padding fija,
// falsa) y nunca cruzan. El campo de display `cuenta` SÍ trae la forma humana
// real ("7014 350840"), cuyos dígitos == los del API. Indexamos también por
// ahí (collision-safe) para cruzar sin reescribir cuentaDigits.
const byCuentaDisplayDigits = new Map<string, BankAccountCatalogEntry>();
const ambiguousDisplay = new Set<string>();
// Cuentas centinela sin dígitos. BANBAJIO: el API manda un Cuenta_Bancos
// distinto por línea (folio SPEI), así que mapBankLine colapsa todas las
// líneas al centinela cuenta="BANBAJIO". No tiene forma numérica que cruzar,
// se busca por el token textual.
const bySentinel = new Map<string, BankAccountCatalogEntry>();

for (const entry of catalog.accounts) {
  if (entry.clabe) byClabe.set(entry.clabe, entry);
  if (entry.cuentaDigits && /\d/.test(entry.cuentaDigits)) {
    byCuentaDigits.set(entry.cuentaDigits, entry);
    const stripped = stripLeadingZeros(entry.cuentaDigits);
    if (stripped) {
      const prior = byCuentaDigitsStripped.get(stripped);
      if (prior && prior !== entry) {
        ambiguousStripped.add(stripped);
      } else {
        byCuentaDigitsStripped.set(stripped, entry);
      }
    }
  } else if (entry.cuentaDigits) {
    bySentinel.set(entry.cuentaDigits.trim().toUpperCase(), entry);
  }
  const displayDigits = digitsOnly(entry.cuenta);
  if (displayDigits) {
    const prior = byCuentaDisplayDigits.get(displayDigits);
    if (prior && prior !== entry) {
      ambiguousDisplay.add(displayDigits);
    } else {
      byCuentaDisplayDigits.set(displayDigits, entry);
    }
  }
}
for (const key of ambiguousStripped) byCuentaDigitsStripped.delete(key);
for (const key of ambiguousDisplay) byCuentaDisplayDigits.delete(key);

/**
 * Exact digits lookup → leading-zero-tolerant fallback → display-form digits
 * fallback (catálogo `cuenta` sin padding). Todos collision-safe.
 */
function lookupByCuentaDigits(norm: string): BankAccountCatalogEntry | null {
  const exact = byCuentaDigits.get(norm);
  if (exact) return exact;
  const display = byCuentaDisplayDigits.get(norm);
  if (display) return display;
  const stripped = stripLeadingZeros(norm);
  if (!stripped) return null;
  return (
    byCuentaDigitsStripped.get(stripped) ??
    byCuentaDisplayDigits.get(stripped) ??
    null
  );
}

export const BANK_ACCOUNTS: readonly BankAccountCatalogEntry[] = Object.freeze(catalog.accounts);

export function findBankAccountByClabe(clabe: string | null | undefined): BankAccountCatalogEntry | null {
  const norm = digitsOnly(clabe);
  if (norm.length !== 18) return null;
  return byClabe.get(norm) ?? null;
}

function lookupBySentinel(input: string | null | undefined): BankAccountCatalogEntry | null {
  const token = (input ?? '').trim().toUpperCase();
  if (!token) return null;
  return bySentinel.get(token) ?? null;
}

export function findBankAccountByCuenta(cuenta: string | null | undefined): BankAccountCatalogEntry | null {
  const norm = digitsOnly(cuenta);
  if (!norm) return lookupBySentinel(cuenta);
  return lookupByCuentaDigits(norm);
}

export function findBankAccount(input: string | null | undefined): BankAccountCatalogEntry | null {
  const norm = digitsOnly(input);
  if (!norm) return lookupBySentinel(input);
  if (norm.length === 18) {
    const hit = byClabe.get(norm);
    if (hit) return hit;
  }
  return lookupByCuentaDigits(norm);
}

export function listBankAccountsByUnidadNegocio(un: string): BankAccountCatalogEntry[] {
  const target = un.trim().toUpperCase();
  return catalog.accounts.filter(a => a.unidadNegocio.toUpperCase() === target);
}

export function listBankAccountsByBanco(banco: string): BankAccountCatalogEntry[] {
  const target = banco.trim().toUpperCase();
  return catalog.accounts.filter(a => a.banco.toUpperCase() === target);
}

export function bankAccountBusinessUnitLabel(un: string | null | undefined): string {
  const value = un?.trim();
  if (!value) return 'Otros ingresos';
  const upper = value.toUpperCase();
  if (upper === 'FEDERAL') return 'Federal';
  if (upper === 'MULTICARGA') return 'Multicarga';
  if (upper === 'TURIMEX LLC') return 'Turimex LLC';
  if (upper === 'RESERVA') return 'Reserva';
  if (upper === 'CITI') return 'Clientes Citi';
  if (upper === 'AC') return 'AC';
  return value;
}

export function bankAccountRoleLabel(role: BankAccountRole | string | null | undefined): string {
  switch (role) {
    case 'concentradora': return 'Concentradora';
    case 'pagadora': return 'Pagadora';
    case 'reserva': return 'Reserva';
    case 'credito': return 'Crédito';
    case 'ahorro': return 'Ahorro';
    case 'por_cancelar': return 'Por cancelar';
    case 'garantia': return 'Garantía';
    case 'saldo_retenido': return 'Saldo retenido';
    default: return role ? String(role) : 'Sin rol';
  }
}

export function bankAccountFlowLabel(flow: BankAccountFlow | string | null | undefined): string {
  switch (flow) {
    case 'ingreso': return 'Ingreso';
    case 'egreso': return 'Egreso';
    case 'neutro': return 'Neutro';
    default: return flow ? String(flow) : 'Sin flujo';
  }
}

export function bankAccountSearchText(entry: BankAccountCatalogEntry | null | undefined): string {
  if (!entry) return '';
  return [
    entry.banco,
    entry.numeroCliente,
    entry.razonSocial,
    entry.cuenta,
    entry.cuentaDigits,
    entry.clabe,
    entry.moneda,
    entry.unidadNegocio,
    bankAccountBusinessUnitLabel(entry.unidadNegocio),
    entry.concepto,
    entry.role,
    bankAccountRoleLabel(entry.role),
    entry.subRole,
    entry.flow,
    bankAccountFlowLabel(entry.flow),
  ].filter(Boolean).join(' ');
}

/* ─── Movement enrichment ─────────────────────────────────────────────── */

/** Minimal shape needed to enrich a bank movement. Compatible with BankStatementLine. */
export interface EnrichableMovement {
  cuenta?: string | null;
  cuentaBancos?: string | null;
  tipoMovimiento?: string | null;
  importe?: number;
}

export interface MovementCatalogEnrichment {
  entry: BankAccountCatalogEntry;
  /** Directional classification for this specific movement.
   *  - 'ingreso': flow=ingreso AND tipoMovimiento=ABONO  (venta real entrante)
   *  - 'egreso':  flow=egreso  AND tipoMovimiento=CARGO  (pago real saliente)
   *  - 'reverso_ingreso': flow=ingreso AND tipoMovimiento=CARGO (devolución / traspaso saliente desde concentradora)
   *  - 'reverso_egreso':  flow=egreso  AND tipoMovimiento=ABONO (reembolso entrante a pagadora)
   *  - 'neutro': cuenta con flow=neutro (reserva, ahorro, crédito, por_cancelar, garantía, saldo_retenido)
   */
  direction: 'ingreso' | 'egreso' | 'reverso_ingreso' | 'reverso_egreso' | 'neutro';
  /** Signed amount: positive = ingreso real para el grupo, negative = egreso real. */
  signedAmount: number;
}

/**
 * Look up the catalog entry for a movement and compute its directional flow.
 * Returns null when the account is not in the catalog (e.g., legacy / external
 * counterparty accounts) so callers can fall through to existing classifiers.
 */
export function enrichMovementWithCatalog(mov: EnrichableMovement): MovementCatalogEnrichment | null {
  const lookup = mov.cuenta || mov.cuentaBancos;
  const entry = findBankAccount(lookup);
  if (!entry) return null;

  const importe = Math.abs(Number(mov.importe ?? 0));
  const isAbono = mov.tipoMovimiento === 'ABONO';
  const isCargo = mov.tipoMovimiento === 'CARGO';

  let direction: MovementCatalogEnrichment['direction'];
  let signedAmount: number;

  if (entry.flow === 'neutro') {
    direction = 'neutro';
    signedAmount = 0;
  } else if (entry.flow === 'ingreso') {
    if (isAbono) {
      direction = 'ingreso';
      signedAmount = importe;
    } else if (isCargo) {
      direction = 'reverso_ingreso';
      signedAmount = -importe;
    } else {
      direction = 'neutro';
      signedAmount = 0;
    }
  } else {
    // entry.flow === 'egreso'
    if (isCargo) {
      direction = 'egreso';
      signedAmount = -importe;
    } else if (isAbono) {
      direction = 'reverso_egreso';
      signedAmount = importe;
    } else {
      direction = 'neutro';
      signedAmount = 0;
    }
  }

  return { entry, direction, signedAmount };
}

export const BANK_ACCOUNTS_CATALOG_VERSION = catalog.version;
export const BANK_ACCOUNTS_CATALOG_GENERATED = catalog.generated;
