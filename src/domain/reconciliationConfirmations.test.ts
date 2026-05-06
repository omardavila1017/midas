import { describe, expect, it } from 'vitest';
import {
  applyManualConfirmations,
  reviewCandidateKeysAboveThreshold,
} from './reconciliationConfirmations';
import type {
  AbonoEnrichment,
  RealReconciliationMatch,
  RealReconciliationResult,
  ReconciliationCandidateFactura,
  ReconciliationReviewCandidate,
} from './realReconciliationEngine';

function buildResult(): RealReconciliationResult {
  const match: RealReconciliationMatch = {
    cia: '00038',
    noFactura: 'RI-91361',
    noCliente: 'C-1',
    nombreCliente: 'GRUPO CONEKTAME',
    status: 'pendiente',
    importeBruto: 10_771.37,
    importePendiente: 10_771.37,
    fechaFactura: '2026-04-15',
    fechaVence: '2026-05-15',
    diasVencida: 0,
    moneda: 'MXN',
    reviewStatus: 'review',
  };
  const candidate: ReconciliationCandidateFactura = {
    cia: '00038',
    noFactura: 'RI-91361',
    noCliente: 'C-1',
    nombreCliente: 'GRUPO CONEKTAME',
    importeBruto: 10_771.37,
    importePendiente: 10_771.37,
    fechaFactura: '2026-04-15',
    fechaVence: '2026-05-15',
    confidence: 0.86,
    matchTier: 'tolerance',
    matchReason: 'monto exacto',
  };
  const enrichment: AbonoEnrichment = {
    movementKey: 'mov-1',
    status: 'cobranza-sin-factura',
    cia: '00038',
    cuenta: '12345',
    fechaOperacion: '2026-04-30',
    importe: 10_771.37,
    concepto: 'CONEKTAME',
    referencia: 'REF-1',
    candidateFacturas: [candidate],
    matchReason: 'monto coincide',
  };
  const review: ReconciliationReviewCandidate = {
    movement: {
      movementKey: 'mov-1',
      cia: '00038',
      cuenta: '12345',
      fechaOperacion: '2026-04-30',
      importe: 10_771.37,
      concepto: 'CONEKTAME',
      referencia: 'REF-1',
    },
    candidateFacturas: [candidate],
    matchReason: 'monto coincide',
  };
  return {
    matches: [match],
    abonoEnrichments: [enrichment],
    paymentReconciliations: [],
    reviewCandidates: [review],
    bankCoverage: { loadedDates: [], totalMovements: 1, totalAbonos: 1 },
    timingsMs: { totalMs: 0, indexMs: 0, matchMs: 0 },
    summary: {
      totalFacturas: 1,
      facturasCobradasBanco: 0,
      facturasCobradasJdeSinBanco: 0,
      facturasPendientes: 1,
      totalSaldoBruto: 10_771.37,
      totalSaldoPendiente: 10_771.37,
      totalCobradoBanco: 0,
      totalAbonos: 1,
      totalAbonoMonto: 10_771.37,
      abonosFacturaCobrada: 0,
      abonosSinFactura: 1,
      abonosTraspasoInterno: 0,
      pctAbonosCruzados: 0,
      pctFacturasCruzadas: 0,
      ciaBreakdown: [],
    },
  };
}

describe('applyManualConfirmations', () => {
  it('returns result unchanged when no confirmations', () => {
    const result = buildResult();
    const out = applyManualConfirmations(result, new Set());
    expect(out).toBe(result);
  });

  it('hoists a confirmed review candidate to a real match', () => {
    const result = buildResult();
    const out = applyManualConfirmations(result, new Set(['mov-1']));

    expect(out.matches[0].status).toBe('cobrada-banco');
    expect(out.matches[0].bankAmount).toBeCloseTo(10_771.37);
    expect(out.matches[0].matchReason).toContain('Confirmado manual');
    expect(out.abonoEnrichments[0].status).toBe('factura-cobrada');
    expect(out.abonoEnrichments[0].candidateFacturas).toBeUndefined();
    expect(out.reviewCandidates).toHaveLength(0);

    expect(out.summary.facturasCobradasBanco).toBe(1);
    expect(out.summary.facturasPendientes).toBe(0);
    expect(out.summary.abonosFacturaCobrada).toBe(1);
    expect(out.summary.abonosSinFactura).toBe(0);
    expect(out.summary.totalCobradoBanco).toBeCloseTo(10_771.37);
    expect(out.summary.totalSaldoPendiente).toBe(0);
    expect(out.summary.pctAbonosCruzados).toBe(1);
    expect(out.summary.pctFacturasCruzadas).toBe(1);
  });

  it('does not mutate the input result', () => {
    const result = buildResult();
    const out = applyManualConfirmations(result, new Set(['mov-1']));
    expect(out).not.toBe(result);
    expect(result.matches[0].status).toBe('pendiente');
    expect(result.reviewCandidates).toHaveLength(1);
  });

  it('skips confirmed keys with no candidate', () => {
    const result = buildResult();
    result.abonoEnrichments[0].candidateFacturas = [];
    const out = applyManualConfirmations(result, new Set(['mov-1']));
    expect(out.matches[0].status).toBe('pendiente');
    expect(out.summary.facturasCobradasBanco).toBe(0);
  });
});

describe('reviewCandidateKeysAboveThreshold', () => {
  it('returns keys whose best candidate clears threshold', () => {
    const result = buildResult();
    expect(reviewCandidateKeysAboveThreshold(result, 0.85)).toEqual(['mov-1']);
    expect(reviewCandidateKeysAboveThreshold(result, 0.9)).toEqual([]);
  });
});
