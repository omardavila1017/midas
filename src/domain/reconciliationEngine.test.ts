import { describe, it, expect } from 'vitest';
import { reconcileCollections, buildReconciliationMap } from './reconciliationEngine';
import type { ReconciliationMatch } from './reconciliationEngine';
import type { CollectionEvent, Client } from './types';
import { eventKey } from './types';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

// ── Fixtures (estilo paymentReconciliationEngine.test.ts) ──

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: 'cl-1',
    name: 'ACME LOGISTICS',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: Array(12).fill(0),
    ...overrides,
  };
}

function event(overrides: Partial<CollectionEvent> = {}): CollectionEvent {
  return {
    clientId: 'cl-1',
    invoiceDate: '2026-02-15',
    theoreticalDate: '2026-03-17',
    realDate: '2026-03-20',
    amount: 100_000,
    lagDays: 3,
    isoWeek: 12,
    ...overrides,
  };
}

// concepto/referencia sin dígitos ni leyendas de traspaso para que
// isInternalTransfer + buildOwnAccountDetector no descarten el abono.
function abono(overrides: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: '00011',
    banco: 'BANAMEX',
    cuenta: '9876501234',
    moneda: 'MXN',
    fechaOperacion: '2026-03-20',
    referencia: 'SPEI-A',
    concepto: 'DEPOSITO CLIENTE ACME',
    tipoMovimiento: 'ABONO',
    importe: 100_000,
    ...overrides,
  };
}

function statement(movs: BankStatementLine[], overrides: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00011',
    banco: 'BANAMEX',
    cuenta: '9876501234',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-03-31',
    movimientos: movs,
    ...overrides,
  };
}

// Reconciliamos marzo 2026 (month es 0-based → 2).
const YEAR = 2026;
const MARCH = 2;

describe('reconcileCollections — matching', () => {
  it('match exacto por monto y fecha → matched con confianza 1 y deltas 0', () => {
    const { matches } = reconcileCollections(
      [event()],
      [client()],
      [statement([abono()])],
      YEAR,
      MARCH,
    );
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(m.status).toBe('matched');
    expect(m.confidence).toBeCloseTo(1, 6);
    expect(m.actualAmount).toBe(100_000);
    expect(m.actualDate).toBe('2026-03-20');
    expect(m.bankReference).toBe('SPEI-A');
    expect(m.amountDelta).toBe(0);
    expect(m.dateDelta).toBe(0);
    expect(m.eventKey).toBe(eventKey(event()));
  });

  it('monto dentro de la tolerancia ±5% (aquí +2%) en la misma fecha → matched', () => {
    const { matches } = reconcileCollections(
      [event()],
      [client()],
      [statement([abono({ importe: 102_000 })])],
      YEAR,
      MARCH,
    );
    const m = matches[0];
    // amountSim = 1 − 0.02/0.05 = 0.6 → conf = 0.6·0.6 + 1·0.4 = 0.76
    expect(m.status).toBe('matched');
    expect(m.confidence).toBeCloseTo(0.76, 2);
    expect(m.amountDelta).toBe(2_000);
  });

  it('monto al borde de la tolerancia (+4%) degrada a likely', () => {
    const { matches } = reconcileCollections(
      [event()],
      [client()],
      [statement([abono({ importe: 104_000 })])],
      YEAR,
      MARCH,
    );
    const m = matches[0];
    // amountSim = 1 − 0.04/0.05 = 0.2 → conf = 0.12 + 0.4 = 0.52 (≥0.5, <0.75)
    expect(m.status).toBe('likely');
    expect(m.confidence).toBeCloseTo(0.52, 2);
  });

  it('monto fuera de tolerancia (+10%) → unmatched, sin movimiento bancario', () => {
    const { matches, summary } = reconcileCollections(
      [event()],
      [client()],
      [statement([abono({ importe: 110_000 })])],
      YEAR,
      MARCH,
    );
    const m = matches[0];
    expect(m.status).toBe('unmatched');
    expect(m.confidence).toBe(0);
    expect(m.bankMovement).toBeUndefined();
    expect(m.actualAmount).toBeUndefined();
    // El abono queda como depósito sin proyección correspondiente.
    expect(summary.unmatchedBankAbonos).toHaveLength(1);
  });

  it('ventana de fecha: 2 días de drift → matched con dateDelta 2; 5 días exactos → unmatched', () => {
    // 2 días: dateSim = 1 − 2/5 = 0.6 → conf = 0.6 + 0.6·0.4 = 0.84
    const twoDays = reconcileCollections(
      [event()],
      [client()],
      [statement([abono({ fechaOperacion: '2026-03-22' })])],
      YEAR,
      MARCH,
    );
    expect(twoDays.matches[0].status).toBe('matched');
    expect(twoDays.matches[0].confidence).toBeCloseTo(0.84, 2);
    expect(twoDays.matches[0].dateDelta).toBe(2);

    // Frontera: a exactamente 5 días, dateSimilarity = 0 y el candidato se
    // descarta — la "tolerancia ±5 días" documentada es en la práctica
    // EXCLUSIVA en el límite (solo ±4 días cruzan). Pineado como está.
    const fiveDays = reconcileCollections(
      [event()],
      [client()],
      [statement([abono({ fechaOperacion: '2026-03-25' })])],
      YEAR,
      MARCH,
    );
    expect(fiveDays.matches[0].status).toBe('unmatched');
  });

  it('variantes de IVA: cruza el bruto con IVA (16% default y el ivaRate del cliente)', () => {
    // Sin cliente en catálogo → IVA default 16%: 100,000 proyectado cruza con 116,000.
    const conIvaDefault = reconcileCollections(
      [event()],
      [],
      [statement([abono({ importe: 116_000 })])],
      YEAR,
      MARCH,
    );
    expect(conIvaDefault.matches[0].status).toBe('matched');
    expect(conIvaDefault.matches[0].confidence).toBeCloseTo(1, 6);
    expect(conIvaDefault.matches[0].amountDelta).toBe(16_000);

    // Cliente frontera (ivaRate 8): cruza con 108,000.
    const conIva8 = reconcileCollections(
      [event()],
      [client({ ivaRate: 8 })],
      [statement([abono({ importe: 108_000 })])],
      YEAR,
      MARCH,
    );
    expect(conIva8.matches[0].status).toBe('matched');
    expect(conIva8.matches[0].confidence).toBeCloseTo(1, 6);
  });

  it('un abono solo puede cruzar UN evento (1:1): dos eventos idénticos, un abono → 1 matched + 1 unmatched', () => {
    const { matches, summary } = reconcileCollections(
      [
        event({ invoiceDate: '2026-02-10' }),
        event({ invoiceDate: '2026-02-20' }),
      ],
      [client()],
      [statement([abono()])],
      YEAR,
      MARCH,
    );
    expect(matches).toHaveLength(2);
    expect(matches.filter(m => m.status === 'matched')).toHaveLength(1);
    expect(matches.filter(m => m.status === 'unmatched')).toHaveLength(1);
    expect(summary.unmatchedBankAbonos).toHaveLength(0);
  });

  it('traspasos internos NUNCA entran al pool de abonos candidatos', () => {
    const { matches, summary } = reconcileCollections(
      [event()],
      [client()],
      [statement([abono({ concepto: 'TRASPASO REF ENTRE CUENTAS' })])],
      YEAR,
      MARCH,
    );
    // Ni cruza el evento ni aparece como depósito huérfano — se excluye del pool.
    expect(matches[0].status).toBe('unmatched');
    expect(summary.unmatchedBankAbonos).toHaveLength(0);
  });

  it('spillover de mes adyacente: abono en los primeros 7 días del mes siguiente sí cruza; después ya no', () => {
    const { matches } = reconcileCollections(
      [
        event({ amount: 50_000, realDate: '2026-03-30', invoiceDate: '2026-02-25' }),
        event({ amount: 60_000, realDate: '2026-03-30', invoiceDate: '2026-02-26' }),
      ],
      [client()],
      [
        statement([
          abono({ importe: 50_000, fechaOperacion: '2026-04-02', referencia: 'SPEI-B' }),
          // Día 15 del mes siguiente: fuera de la ventana de spillover (≤7).
          abono({ importe: 60_000, fechaOperacion: '2026-04-15', referencia: 'SPEI-C' }),
        ]),
      ],
      YEAR,
      MARCH,
    );
    const m50 = matches.find(m => m.projectedAmount === 50_000)!;
    const m60 = matches.find(m => m.projectedAmount === 60_000)!;
    expect(m50.status).toBe('matched');
    expect(m50.actualDate).toBe('2026-04-02');
    expect(m50.dateDelta).toBe(3);
    expect(m60.status).toBe('unmatched');
  });

  it('solo los eventos del mes objetivo entran a matches y a totalProjected', () => {
    const { matches, summary } = reconcileCollections(
      [
        event({ amount: 100_000, realDate: '2026-03-20' }),
        event({ amount: 40_000, realDate: '2026-02-20', invoiceDate: '2026-01-20' }),
      ],
      [client()],
      [statement([abono()])],
      YEAR,
      MARCH,
    );
    expect(matches).toHaveLength(1);
    expect(summary.totalProjected).toBe(100_000);
  });

  it('QUIRK pineado: el filtro de mes ignora el AÑO — un evento de marzo de otro año entra al periodo', () => {
    // monthEvents solo compara el mes de realDate, no el año recibido como
    // parámetro. Comportamiento actual pineado; si algún día se corrige,
    // este test debe actualizarse a propósito.
    const { matches, summary } = reconcileCollections(
      [event({ amount: 70_000, realDate: '2025-03-10', invoiceDate: '2025-02-10' })],
      [client()],
      [],
      YEAR,
      MARCH,
    );
    expect(matches).toHaveLength(1);
    expect(summary.totalProjected).toBe(70_000);
  });
});

describe('reconcileCollections — summary', () => {
  it('agrega totales, conteos, matchRate y depósitos huérfanos', () => {
    const { summary } = reconcileCollections(
      [
        event({ amount: 100_000, invoiceDate: '2026-02-10' }),          // cruza exacto
        event({ amount: 30_000, invoiceDate: '2026-02-11' }),           // sin abono → unmatched
      ],
      [client()],
      [
        statement([
          abono({ importe: 100_000 }),
          abono({ importe: 999_999, referencia: 'SPEI-X', concepto: 'DEPOSITO SIN PROYECCION' }),
        ]),
      ],
      YEAR,
      MARCH,
    );
    expect(summary.totalProjected).toBe(130_000);
    expect(summary.totalMatched).toBe(100_000);   // suma de actualAmount de matched
    expect(summary.totalLikely).toBe(0);
    expect(summary.totalUnmatched).toBe(30_000);  // suma de projectedAmount de unmatched
    expect(summary.matchedCount).toBe(1);
    expect(summary.likelyCount).toBe(0);
    expect(summary.unmatchedCount).toBe(1);
    expect(summary.matchRate).toBeCloseTo(0.5, 6);
    expect(summary.unmatchedBankAbonos).toHaveLength(1);
    expect(summary.unmatchedBankAbonos[0].referencia).toBe('SPEI-X');
  });

  it('sin eventos: matches vacío, matchRate 0 y todos los abonos quedan huérfanos', () => {
    const { matches, summary } = reconcileCollections(
      [],
      [client()],
      [statement([abono()])],
      YEAR,
      MARCH,
    );
    expect(matches).toHaveLength(0);
    expect(summary.matchRate).toBe(0);
    expect(summary.totalProjected).toBe(0);
    expect(summary.unmatchedBankAbonos).toHaveLength(1);
  });
});

describe('buildReconciliationMap', () => {
  it('indexa los matches por eventKey', () => {
    const a: ReconciliationMatch = {
      eventKey: 'cl-1::2026-03-20::2026-02-15',
      clientId: 'cl-1',
      projectedDate: '2026-03-20',
      projectedAmount: 100_000,
      status: 'matched',
      confidence: 1,
    };
    const b: ReconciliationMatch = {
      eventKey: 'cl-2::2026-03-25::2026-02-20',
      clientId: 'cl-2',
      projectedDate: '2026-03-25',
      projectedAmount: 50_000,
      status: 'unmatched',
      confidence: 0,
    };
    const map = buildReconciliationMap([a, b]);
    expect(map.size).toBe(2);
    expect(map.get(a.eventKey)).toBe(a);
    expect(map.get(b.eventKey)).toBe(b);
    expect(map.get('no-existe')).toBeUndefined();
  });
});
