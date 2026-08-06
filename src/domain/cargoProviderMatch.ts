// ─────────────────────────────────────────────────────────────────────────
// cargoProviderMatch — identifica el proveedor de un CARGO bancario que NO
// cruzó contra PagoProveedor.
//
// El cruce estricto banco↔PagoProveedor (paymentReconciliationEngine) deja
// fuera los CARGOs cuyo pago no quedó registrado en JDE ("no todo aparece
// en el JDE"). Para esos, este módulo intenta dos heurísticas:
//
//   1. Nombre en el concepto — si el texto del movimiento bancario contiene
//      un token distintivo del nombre de un proveedor del catálogo, se le
//      atribuye ese proveedor. El catálogo de proveedores se deriva de
//      compras + CXP + PagoProveedor, así que esto es, de facto, un cruce
//      contra compras.
//   2. Monto contra compras — si el monto del CARGO empata (±1 peso) con
//      EXACTAMENTE una OC de compras recibida en una ventana de ±21 días,
//      se atribuye el proveedor de esa OC.
//
// Ambas son conservadoras: sólo emiten match cuando es inequívoco (token
// único, o una sola OC candidata). El resto sigue cayendo a "Otros egresos".
// ─────────────────────────────────────────────────────────────────────────

import type { Provider } from './types';
import type { PurchaseReceiptRecord } from '../modules/shared-finance/types';
import { usableJdeProviderCategory } from '../modules/shared-finance/calculation-engine/canonicalProjectionShared';
import { normalizeClientText } from './clientGrouping';

/**
 * Tokens demasiado genéricos para identificar a un proveedor por sí solos.
 * Mezcla de palabras societarias, giros comunes y verbos de transferencia
 * bancaria. Sin este filtro, "SERVICIOS"/"PAGO"/"GRUPO" matchearían medio
 * catálogo y producirían atribuciones falsas.
 */
const GENERIC_TOKENS = new Set([
  'SERVICIOS', 'SERVICIO', 'COMERCIALIZADORA', 'COMERCIAL', 'GRUPO',
  'CORPORATIVO', 'COMPANIA', 'MEXICO', 'MEXICANA', 'MEXICANO', 'NACIONAL',
  'INTERNACIONAL', 'SOLUCIONES', 'SISTEMAS', 'INDUSTRIAL', 'INDUSTRIAS',
  'PROVEEDORA', 'DISTRIBUIDORA', 'OPERADORA', 'CONSTRUCCIONES', 'CONSULTORES',
  'CONSULTORIA', 'TRANSPORTES', 'TRANSPORTE', 'AUTOMOTRIZ', 'REFACCIONES',
  'PAGO', 'PAGOS', 'TRANSFERENCIA', 'SPEI', 'ABONO', 'CARGO', 'TRASPASO',
  'DEPOSITO', 'BANCO', 'BANCOMER', 'BANAMEX', 'BANORTE', 'SANTANDER',
  'CUENTA', 'FACTURA', 'FOLIO', 'REFERENCIA', 'OPERACION',
]);

export interface CargoProviderMatch {
  counterpartyId?: string;
  counterpartyName: string;
  /**
   * Clasificación con la que `historicalReconciledEngine` llena
   * `providerCategory` (→ bucket de Planeación vía `macroBucketForSupplier`) y
   * `subcategory` de la línea `bank:`. Pasa por `usableJdeProviderCategory`
   * cuando sale del árbol de compras — ver el call site.
   */
  providerType?: string;
  matchSource: 'concept-name' | 'compras-amount';
}

export interface CargoProviderIndex {
  /** Token distintivo (pertenece a UN solo proveedor) → ese proveedor. */
  tokenToProvider: Map<string, Provider>;
  /** Monto MXN redondeado → recibos de compras con ese monto. */
  receiptsByAmount: Map<number, PurchaseReceiptRecord[]>;
}

const DAY_MS = 86_400_000;

function providerTokens(name: string | undefined): string[] {
  return normalizeClientText(name ?? '')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t));
}

/**
 * Construye el índice una vez por corrida. `providers` viene del catálogo;
 * `purchaseReceipts` son las OCs (compras) ya mapeadas.
 */
export function buildCargoProviderIndex(
  providers: Provider[],
  purchaseReceipts: PurchaseReceiptRecord[],
): CargoProviderIndex {
  // token → proveedores que lo contienen
  const tokenProviders = new Map<string, Set<Provider>>();
  for (const provider of providers) {
    for (const token of providerTokens(provider.name)) {
      let set = tokenProviders.get(token);
      if (!set) {
        set = new Set();
        tokenProviders.set(token, set);
      }
      set.add(provider);
    }
  }
  const tokenToProvider = new Map<string, Provider>();
  for (const [token, set] of tokenProviders) {
    if (set.size === 1) {
      tokenToProvider.set(token, set.values().next().value as Provider);
    }
  }

  const receiptsByAmount = new Map<number, PurchaseReceiptRecord[]>();
  for (const receipt of purchaseReceipts) {
    if (receipt.isCancelled) continue;
    const amount = Math.round(receipt.amountMxn);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const list = receiptsByAmount.get(amount);
    if (list) list.push(receipt);
    else receiptsByAmount.set(amount, [receipt]);
  }

  return { tokenToProvider, receiptsByAmount };
}

function receiptDateIso(receipt: PurchaseReceiptRecord): string | undefined {
  const d = receipt.receiptDate || receipt.estimatedDueDate || receipt.orderDate;
  return /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? d : undefined;
}

function daysApart(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00.000Z`).getTime();
  const tb = new Date(`${b}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / DAY_MS;
}

/**
 * Intenta identificar al proveedor de un CARGO no cruzado. Devuelve `null`
 * cuando no hay match inequívoco.
 */
export function matchCargoToProvider(args: {
  /** `concepto + infAdi1..3` ya concatenado. */
  conceptHaystack: string;
  amount: number;
  dateIso: string;
  index: CargoProviderIndex;
}): CargoProviderMatch | null {
  // 1) Nombre en el concepto bancario.
  const conceptTokens = normalizeClientText(args.conceptHaystack)
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t));
  for (const token of conceptTokens) {
    const provider = args.index.tokenToProvider.get(token);
    if (provider) {
      return {
        counterpartyId: provider.id,
        counterpartyName: provider.name,
        providerType: provider.type,
        matchSource: 'concept-name',
      };
    }
  }

  // 2) Monto contra compras (±1 peso, ventana ±21 días, candidato único).
  const amount = Math.round(args.amount);
  if (Number.isFinite(amount) && amount > 0) {
    for (const probe of [amount, amount - 1, amount + 1]) {
      const receipts = args.index.receiptsByAmount.get(probe);
      if (!receipts || receipts.length === 0) continue;
      const near = receipts.filter((r) => {
        const d = receiptDateIso(r);
        return d ? daysApart(d, args.dateIso) <= 21 : false;
      });
      // Sólo atribuir si hay un único candidato — evita falsos positivos en
      // montos redondos repetidos.
      const uniqueProviders = new Set(near.map((r) => r.noProveedor));
      if (near.length >= 1 && uniqueProviders.size === 1) {
        const receipt = near[0];
        return {
          counterpartyId: receipt.noProveedor || undefined,
          counterpartyName: receipt.supplierName || 'Proveedor compras',
          // MISMO gate y MISMO orden que `purchaseReceiptToMovement`
          // (sourceRecords.ts): familia (hijo) antes que categoría (padre), con
          // los centinelas del API cortados. Tomar `categoryName` primero —como
          // hacía esta línea— es el defecto que se cerró para las OCs el
          // 2026-08-05b y que aquí seguía vivo: el padre del árbol de compras
          // ("Directos"/"Indirectos"/"." /"Seleccionar Familia") NO generaliza a
          // ningún bucket, así que tapaba a la familia (MOTOR/LLANTAS/…) y
          // mandaba el CARGO a "Proveedores sin categoría" — además de filtrarse
          // como sub-etiqueta visible vía `cargoSubcategory`.
          providerType: usableJdeProviderCategory(
            receipt.familyName,
            receipt.subfamilyName,
            receipt.categoryName,
          ),
          matchSource: 'compras-amount',
        };
      }
    }
  }

  return null;
}
