import type { RealReconciliationResult } from './realReconciliationEngine';

export function emptyRealReconciliationResult(): RealReconciliationResult {
  return {
    matches: [],
    abonoEnrichments: [],
    paymentReconciliations: [],
    summary: {
      totalFacturas: 0,
      facturasCobradasBanco: 0,
      facturasCobradasJdeSinBanco: 0,
      facturasPendientes: 0,
      totalSaldoBruto: 0,
      totalSaldoPendiente: 0,
      totalCobradoBanco: 0,
      totalAbonos: 0,
      totalAbonoMonto: 0,
      abonosFacturaCobrada: 0,
      abonosSinFactura: 0,
      abonosTraspasoInterno: 0,
      pctAbonosCruzados: 0,
      pctFacturasCruzadas: 0,
      ciaBreakdown: [],
    },
    reviewCandidates: [],
    bankCoverage: {
      loadedDates: [],
      totalMovements: 0,
      totalAbonos: 0,
    },
    timingsMs: {
      totalMs: 0,
      indexMs: 0,
      matchMs: 0,
    },
  };
}
