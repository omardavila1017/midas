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

const byClabe = new Map<string, BankAccountCatalogEntry>();
const byCuentaDigits = new Map<string, BankAccountCatalogEntry>();

for (const entry of catalog.accounts) {
  if (entry.clabe) byClabe.set(entry.clabe, entry);
  if (entry.cuentaDigits) byCuentaDigits.set(entry.cuentaDigits, entry);
}

export const BANK_ACCOUNTS: readonly BankAccountCatalogEntry[] = Object.freeze(catalog.accounts);

export function findBankAccountByClabe(clabe: string | null | undefined): BankAccountCatalogEntry | null {
  const norm = digitsOnly(clabe);
  if (norm.length !== 18) return null;
  return byClabe.get(norm) ?? null;
}

export function findBankAccountByCuenta(cuenta: string | null | undefined): BankAccountCatalogEntry | null {
  const norm = digitsOnly(cuenta);
  if (!norm) return null;
  return byCuentaDigits.get(norm) ?? null;
}

export function findBankAccount(input: string | null | undefined): BankAccountCatalogEntry | null {
  const norm = digitsOnly(input);
  if (!norm) return null;
  if (norm.length === 18) {
    const hit = byClabe.get(norm);
    if (hit) return hit;
  }
  return byCuentaDigits.get(norm) ?? null;
}

export function listBankAccountsByUnidadNegocio(un: string): BankAccountCatalogEntry[] {
  const target = un.trim().toUpperCase();
  return catalog.accounts.filter(a => a.unidadNegocio.toUpperCase() === target);
}

export function listBankAccountsByBanco(banco: string): BankAccountCatalogEntry[] {
  const target = banco.trim().toUpperCase();
  return catalog.accounts.filter(a => a.banco.toUpperCase() === target);
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
