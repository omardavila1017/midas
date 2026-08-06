import { describe, expect, it } from 'vitest';
import type { Provider } from './types';
import type { PurchaseReceiptRecord } from '../modules/shared-finance/types';
import { buildCargoProviderIndex, matchCargoToProvider } from './cargoProviderMatch';

function provider(id: string, name: string, type = 'DIESEL'): Provider {
  return {
    id,
    name,
    type,
    risk: 'Medio',
    paymentPeriod: '30 días',
  };
}

function receipt(overrides: Partial<PurchaseReceiptRecord> = {}): PurchaseReceiptRecord {
  return {
    cia: '00150',
    noProveedor: 'P-1',
    supplierName: 'PROVEEDOR UNO',
    invoiceNo: 'F-1',
    purchaseOrderNo: 'OC-1',
    receiptNo: 'R-1',
    orderDate: '2026-03-01',
    receiptDate: '2026-03-10',
    creditDays: 30,
    estimatedDueDate: '2026-04-09',
    currency: 'MXP',
    exchangeRate: 1,
    totalAmount: 1000,
    amountMxn: 1000,
    taxTreatment: 'IVA_CREDITABLE',
    isCancelled: false,
    status: 'REAL',
    ...overrides,
  };
}

describe('buildCargoProviderIndex', () => {
  it('indexes only distinctive tokens (unique to ONE provider)', () => {
    const shared1 = provider('p1', 'TRANSPORTES ZAPATA SA DE CV');
    const shared2 = provider('p2', 'GRUPO ZAPATA INDUSTRIAL');
    const unique = provider('p3', 'LLANTERA MONCLOVA');
    const idx = buildCargoProviderIndex([shared1, shared2, unique], []);

    // ZAPATA belongs to two providers → excluded.
    expect(idx.tokenToProvider.has('ZAPATA')).toBe(false);
    // Distinctive tokens survive.
    expect(idx.tokenToProvider.get('LLANTERA')).toBe(unique);
    expect(idx.tokenToProvider.get('MONCLOVA')).toBe(unique);
  });

  it('drops generic tokens, short tokens and pure numbers', () => {
    const p = provider('p1', 'SERVICIOS ABC 12345 QUIMICOS');
    const idx = buildCargoProviderIndex([p], []);
    expect(idx.tokenToProvider.has('SERVICIOS')).toBe(false); // generic
    expect(idx.tokenToProvider.has('ABC')).toBe(false); // < 4 chars
    expect(idx.tokenToProvider.has('12345')).toBe(false); // numeric
    expect(idx.tokenToProvider.get('QUIMICOS')).toBe(p);
  });

  it('normalizes provider names (accents + legal suffixes)', () => {
    const p = provider('p1', 'Química Peñoles, S.A. de C.V.');
    const idx = buildCargoProviderIndex([p], []);
    expect(idx.tokenToProvider.get('QUIMICA')).toBe(p);
    expect(idx.tokenToProvider.get('PENOLES')).toBe(p);
  });

  it('indexes receipts by rounded MXN amount, skipping cancelled and non-positive', () => {
    const a = receipt({ amountMxn: 1000.4 });
    const b = receipt({ amountMxn: 1000.2, receiptNo: 'R-2' });
    const cancelled = receipt({ amountMxn: 500, isCancelled: true });
    const zero = receipt({ amountMxn: 0 });
    const negative = receipt({ amountMxn: -100 });
    const nan = receipt({ amountMxn: Number.NaN });
    const idx = buildCargoProviderIndex([], [a, b, cancelled, zero, negative, nan]);

    expect(idx.receiptsByAmount.get(1000)).toEqual([a, b]);
    expect(idx.receiptsByAmount.has(500)).toBe(false);
    expect(idx.receiptsByAmount.has(0)).toBe(false);
    expect(idx.receiptsByAmount.has(-100)).toBe(false);
    expect(idx.receiptsByAmount.size).toBe(1);
  });

  it('produces empty maps for empty inputs', () => {
    const idx = buildCargoProviderIndex([], []);
    expect(idx.tokenToProvider.size).toBe(0);
    expect(idx.receiptsByAmount.size).toBe(0);
  });
});

describe('matchCargoToProvider — concept-name tier', () => {
  it('matches when the concept contains a distinctive provider token', () => {
    const p = provider('p1', 'LLANTERA MONCLOVA', 'REFACCIONES');
    const idx = buildCargoProviderIndex([p], []);
    const m = matchCargoToProvider({
      conceptHaystack: 'SPEI PAGO LLANTERA REF 998877',
      amount: 123,
      dateIso: '2026-03-10',
      index: idx,
    });
    expect(m).toEqual({
      counterpartyId: 'p1',
      counterpartyName: 'LLANTERA MONCLOVA',
      providerType: 'REFACCIONES',
      matchSource: 'concept-name',
    });
  });

  it('normalizes the concept haystack (case + accents) before token lookup', () => {
    const p = provider('p1', 'QUIMICA PENOLES');
    const idx = buildCargoProviderIndex([p], []);
    const m = matchCargoToProvider({
      conceptHaystack: 'pago a química peñoles factura 12',
      amount: 0,
      dateIso: '2026-03-10',
      index: idx,
    });
    expect(m?.matchSource).toBe('concept-name');
    expect(m?.counterpartyName).toBe('QUIMICA PENOLES');
  });

  it('returns null when the concept has no distinctive token', () => {
    const p = provider('p1', 'LLANTERA MONCLOVA');
    const idx = buildCargoProviderIndex([p], []);
    const m = matchCargoToProvider({
      conceptHaystack: 'TRANSFERENCIA SPEI 000123 PAGO SERVICIOS',
      amount: 0,
      dateIso: '2026-03-10',
      index: idx,
    });
    expect(m).toBeNull();
  });

  it('concept-name wins over compras-amount when both would match', () => {
    const p = provider('p1', 'LLANTERA MONCLOVA');
    const r = receipt({ amountMxn: 500, noProveedor: 'P-9', supplierName: 'OTRO' });
    const idx = buildCargoProviderIndex([p], [r]);
    const m = matchCargoToProvider({
      conceptHaystack: 'PAGO MONCLOVA',
      amount: 500,
      dateIso: '2026-03-10',
      index: idx,
    });
    expect(m?.matchSource).toBe('concept-name');
    expect(m?.counterpartyId).toBe('p1');
  });
});

describe('matchCargoToProvider — compras-amount tier', () => {
  it('attributes the provider of a single receipt matching amount within ±21 days', () => {
    const r = receipt({
      amountMxn: 15_000,
      receiptDate: '2026-03-01',
      noProveedor: 'P-7',
      supplierName: 'ACEROS DEL NORTE',
      categoryName: 'ACERO',
    });
    const idx = buildCargoProviderIndex([], [r]);
    const m = matchCargoToProvider({
      conceptHaystack: 'CARGO SIN NOMBRE',
      amount: 15_000,
      dateIso: '2026-03-15',
      index: idx,
    });
    expect(m).toEqual({
      counterpartyId: 'P-7',
      counterpartyName: 'ACEROS DEL NORTE',
      providerType: 'ACERO',
      matchSource: 'compras-amount',
    });
  });

  it('tolerates ±1 peso between cargo and receipt', () => {
    const r = receipt({ amountMxn: 1000, receiptDate: '2026-03-10' });
    const idx = buildCargoProviderIndex([], [r]);
    for (const amount of [999, 1000, 1001]) {
      const m = matchCargoToProvider({
        conceptHaystack: '',
        amount,
        dateIso: '2026-03-10',
        index: idx,
      });
      expect(m?.matchSource).toBe('compras-amount');
    }
    const far = matchCargoToProvider({
      conceptHaystack: '',
      amount: 1002,
      dateIso: '2026-03-10',
      index: idx,
    });
    expect(far).toBeNull();
  });

  it('rejects receipts outside the ±21 day window', () => {
    const r = receipt({ amountMxn: 1000, receiptDate: '2026-03-01' });
    const idx = buildCargoProviderIndex([], [r]);
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: 1000, dateIso: '2026-03-22', index: idx })
        ?.matchSource,
    ).toBe('compras-amount'); // exactly 21 days → still in
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: 1000, dateIso: '2026-03-23', index: idx }),
    ).toBeNull(); // 22 days → out
  });

  it('returns null when multiple near receipts belong to DIFFERENT providers', () => {
    const a = receipt({ amountMxn: 1000, noProveedor: 'P-1', receiptDate: '2026-03-10' });
    const b = receipt({ amountMxn: 1000, noProveedor: 'P-2', receiptDate: '2026-03-12' });
    const idx = buildCargoProviderIndex([], [a, b]);
    const m = matchCargoToProvider({
      conceptHaystack: '',
      amount: 1000,
      dateIso: '2026-03-11',
      index: idx,
    });
    expect(m).toBeNull();
  });

  it('matches when multiple near receipts belong to the SAME provider', () => {
    const a = receipt({ amountMxn: 1000, noProveedor: 'P-1', receiptDate: '2026-03-10' });
    const b = receipt({ amountMxn: 1000, noProveedor: 'P-1', receiptNo: 'R-2', receiptDate: '2026-03-12' });
    const idx = buildCargoProviderIndex([], [a, b]);
    const m = matchCargoToProvider({
      conceptHaystack: '',
      amount: 1000,
      dateIso: '2026-03-11',
      index: idx,
    });
    expect(m?.matchSource).toBe('compras-amount');
    expect(m?.counterpartyId).toBe('P-1');
  });

  it('falls back through receiptDate → estimatedDueDate → orderDate for the window', () => {
    const noReceipt = receipt({
      amountMxn: 2000,
      receiptDate: '',
      estimatedDueDate: '2026-05-01',
      orderDate: '2026-01-01',
    });
    const idx = buildCargoProviderIndex([], [noReceipt]);
    // Near estimatedDueDate → match.
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: 2000, dateIso: '2026-05-05', index: idx })
        ?.matchSource,
    ).toBe('compras-amount');
    // Near orderDate only (estimatedDueDate is the resolved date, so this misses).
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: 2000, dateIso: '2026-01-05', index: idx }),
    ).toBeNull();
  });

  it('ignores receipts whose resolved date is not ISO yyyy-mm-dd', () => {
    const bad = receipt({ amountMxn: 3000, receiptDate: '10/03/2026', estimatedDueDate: '', orderDate: '' });
    const idx = buildCargoProviderIndex([], [bad]);
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: 3000, dateIso: '2026-03-10', index: idx }),
    ).toBeNull();
  });

  it('skips the amount tier for non-positive cargo amounts', () => {
    const r = receipt({ amountMxn: 1, receiptDate: '2026-03-10' });
    const idx = buildCargoProviderIndex([], [r]);
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: 0, dateIso: '2026-03-10', index: idx }),
    ).toBeNull();
    expect(
      matchCargoToProvider({ conceptHaystack: '', amount: -1000, dateIso: '2026-03-10', index: idx }),
    ).toBeNull();
  });

  it('applies name/type fallbacks when receipt fields are empty', () => {
    const r = receipt({
      amountMxn: 4000,
      receiptDate: '2026-03-10',
      noProveedor: '',
      supplierName: '',
      categoryName: undefined,
      familyName: 'LUBRICANTES',
    });
    const idx = buildCargoProviderIndex([], [r]);
    const m = matchCargoToProvider({
      conceptHaystack: '',
      amount: 4000,
      dateIso: '2026-03-10',
      index: idx,
    });
    expect(m).toEqual({
      counterpartyId: undefined,
      counterpartyName: 'Proveedor compras',
      providerType: 'LUBRICANTES',
      matchSource: 'compras-amount',
    });
  });
});

/**
 * El `providerType` del tier compras-amount alimenta `providerCategory` de la
 * línea `bank:` (historicalReconciledEngine) → bucket de Planeación vía
 * `macroBucketForSupplier`. El árbol de compras tiene DOS niveles y el PADRE
 * (`Desc_Categoria`) no describe el gasto: medido en la BD, "Directos" /
 * "Indirectos" / "." / "Seleccionar Familia" NO generalizan a ningún bucket, así
 * que tomarlos antes que la familia manda el CARGO a "Proveedores sin
 * categoría". Es el mismo gate que `purchaseReceiptToMovement` ya aplica.
 */
describe('matchCargoToProvider — árbol de clasificación de compras (mismo gate que las OCs)', () => {
  const attribute = (overrides: Partial<PurchaseReceiptRecord>) => {
    const r = receipt({ amountMxn: 7_500, receiptDate: '2026-03-10', ...overrides });
    return matchCargoToProvider({
      conceptHaystack: '',
      amount: 7_500,
      dateIso: '2026-03-10',
      index: buildCargoProviderIndex([], [r]),
    })?.providerType;
  };

  it.each([
    ['Directos', 'MOTOR'],
    ['Indirectos', 'LLANTAS'],
    ['Servicios', 'ARRENDAMIENTO INMOBILIARIO'],
  ])('la familia le gana al padre %s', (categoryName, familyName) => {
    expect(attribute({ categoryName, familyName })).toBe(familyName);
  });

  it('descarta los centinelas que el propio API escribe como texto', () => {
    // `.` como Desc_Categoria y el placeholder del capturista como Desc_Familia:
    // ambos deben caer, y sin nada usable queda `undefined` (no una etiqueta
    // basura que se filtre al sub-bucket de Planeación).
    expect(attribute({ categoryName: '.', familyName: 'Seleccionar Familia' })).toBeUndefined();
    expect(attribute({ categoryName: '.', familyName: 'CARROCERÍA' })).toBe('CARROCERÍA');
    expect(attribute({ categoryName: 'Directos', familyName: 'Seleccionar Familia' }))
      .toBe('Directos'); // genérico como ÚLTIMO recurso, mejor que sin categoría
  });

  it('la subfamilia entra antes que el padre cuando no hay familia', () => {
    expect(attribute({ categoryName: 'Directos', familyName: undefined, subfamilyName: 'CHASIS' }))
      .toBe('CHASIS');
  });
});
