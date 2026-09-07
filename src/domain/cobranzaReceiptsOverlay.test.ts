import { describe, expect, it } from 'vitest';
import type { CobranzaPayment, CobranzaPaymentApplication } from '../services/jdeTypes';
import {
  buildAppliedAmountByFactura,
  buildReceiptSurplusByFolio,
  consumeReceiptSurplus,
  receiptOverlayKey,
  type ReceiptOverlayLine,
} from './cobranzaReceiptsOverlay';

function application(patch: Partial<CobranzaPaymentApplication>): CobranzaPaymentApplication {
  return {
    idPago: patch.idPago ?? 'P-1',
    cia: patch.cia ?? '00011',
    fechaAplicacion: patch.fechaAplicacion ?? '2026-09-02',
    noCliente: patch.noCliente ?? '1',
    cliente: patch.cliente ?? 'CLIENTE',
    tipoDocto: patch.tipoDocto ?? 'RI',
    noFactura: patch.noFactura ?? 'RI-310071',
    noFacturaNormalizada: patch.noFacturaNormalizada ?? 'RI-310071',
    fechaFactura: patch.fechaFactura ?? '2026-08-10',
    fechaVencimiento: patch.fechaVencimiento ?? '2026-09-08',
    diasAntiguedadFafv: patch.diasAntiguedadFafv ?? 0,
    importeCobrado: patch.importeCobrado ?? 0,
    importeOriginalFactura: patch.importeOriginalFactura ?? 0,
    tasaIva: patch.tasaIva ?? '16',
    importeIvaFacturaOriginal: patch.importeIvaFacturaOriginal ?? 0,
  };
}

function payment(patch: Partial<CobranzaPayment>): CobranzaPayment {
  return {
    idPago: patch.idPago ?? 'P-1',
    cia: patch.cia ?? '00011',
    fechaCobro: patch.fechaCobro ?? '2026-09-02',
    fechaContable: patch.fechaContable ?? '2026-09-02',
    cuentaBancaria: patch.cuentaBancaria ?? '123',
    banco: patch.banco ?? 'BANAMEX',
    noRecibo: patch.noRecibo ?? '855877',
    importeRecibo: patch.importeRecibo ?? 0,
    pendienteAplicar: patch.pendienteAplicar ?? 0,
    noCliente: patch.noCliente ?? '1',
    cliente: patch.cliente ?? 'CLIENTE',
    noBatch: patch.noBatch ?? '1',
    tipoCambio: patch.tipoCambio ?? 1,
    applications: patch.applications ?? [],
  };
}

describe('buildAppliedAmountByFactura', () => {
  // Formatos REALES verificados contra la BD el 2026-09-07: Indicadores manda
  // "RI - 92238" (espacios alrededor del guion) y /cobranza manda "RI-92238".
  // Si el normalizador dejara de colapsar el guion, el overlay no cruzaría
  // NADA y el descuento quedaría inerte sin ninguna señal de error.
  it('cruza el folio con espacios de Indicadores contra el folio compacto de /cobranza', () => {
    const applied = buildAppliedAmountByFactura([
      payment({ applications: [application({ noFactura: 'RI - 92238', importeCobrado: 1_000 })] }),
    ]);

    expect(applied.get(receiptOverlayKey('00011', 'RI-92238'))).toBe(1_000);
  });

  it('ACUMULA N aplicaciones del mismo folio (recibos distintos)', () => {
    const applied = buildAppliedAmountByFactura([
      payment({ idPago: 'P-1', applications: [application({ importeCobrado: 600 })] }),
      payment({ idPago: 'P-2', applications: [application({ idPago: 'P-2', importeCobrado: 400 })] }),
    ]);

    expect(applied.get(receiptOverlayKey('00011', 'RI-310071'))).toBe(1_000);
  });

  it('descarta aplicaciones sin folio, con importe no positivo o no finito', () => {
    const applied = buildAppliedAmountByFactura([
      payment({
        applications: [
          application({ noFactura: '', importeCobrado: 500 }),
          application({ noFactura: 'RI-1', importeCobrado: 0 }),
          application({ noFactura: 'RI-2', importeCobrado: -100 }),
          application({ noFactura: 'RI-3', importeCobrado: Number.NaN }),
        ],
      }),
    ]);

    expect(applied.size).toBe(0);
  });

  it('cae al cia del header cuando la aplicación no lo trae', () => {
    const applied = buildAppliedAmountByFactura([
      payment({ cia: '00038', applications: [application({ cia: '', importeCobrado: 250 })] }),
    ]);

    expect(applied.get(receiptOverlayKey('00038', 'RI-310071'))).toBe(250);
  });

  it('sin pagos devuelve un mapa vacío', () => {
    expect(buildAppliedAmountByFactura(undefined).size).toBe(0);
    expect(buildAppliedAmountByFactura([]).size).toBe(0);
  });
});

function line(patch: Partial<ReceiptOverlayLine> = {}): ReceiptOverlayLine {
  return {
    cia: patch.cia ?? '00011',
    noFactura: patch.noFactura ?? 'RI-310071',
    importeBrutoPesos: patch.importeBrutoPesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
  };
}

/** Aplica el overlay a un set de líneas como lo hacen los motores. */
function applyOverlay(
  lines: ReceiptOverlayLine[],
  applied: Map<string, number>,
): number[] {
  const pool = buildReceiptSurplusByFolio(lines, applied);
  return lines.map((l) => {
    const adj = consumeReceiptSurplus(pool, receiptOverlayKey(l.cia, l.noFactura), l.importePendientePesos);
    return l.importePendientePesos - adj;
  });
}

describe('receiptOverlayKey', () => {
  it("devuelve '' sin folio reconocible — no mezcla las líneas sin folio de una cía", () => {
    expect(receiptOverlayKey('00011', '')).toBe('');
    expect(receiptOverlayKey('00011', '-')).toBe('');
    expect(receiptOverlayKey('00011', undefined)).toBe('');
  });
});

describe('overlay por folio (pozo consumido línea por línea)', () => {
  // REGLA DURA: degrada solo. Sin recibos el resultado tiene que ser el
  // pendiente que reportó /cobranza, al centavo — es lo que hace que los meses
  // sin cobertura de Indicadores (ene–may 2026: CERO filas en la tabla) no se
  // muevan ni un peso.
  it('sin recibos devuelve el pendiente reportado, byte-idéntico', () => {
    const lines = [line({ importeBrutoPesos: 1_160, importePendientePesos: 580 })];
    expect(applyOverlay(lines, new Map())).toEqual([580]);
  });

  // El caso que motiva el overlay: /cobranza dice pendiente completo (no
  // aplicó el recibo) e Indicadores dice cobrada al 100%.
  it('deja en 0 la factura que Indicadores reporta cobrada por completo', () => {
    const lines = [line({ importeBrutoPesos: 221_201.53, importePendientePesos: 221_201.53 })];
    const applied = new Map([['00011::RI-310071', 221_201.53]]);
    expect(applyOverlay(lines, applied)).toEqual([0]);
  });

  it('proyecta sólo el residuo de una factura parcialmente cobrada', () => {
    const lines = [line({ importeBrutoPesos: 1_000, importePendientePesos: 1_000 })];
    expect(applyOverlay(lines, new Map([['00011::RI-310071', 400]]))).toEqual([600]);
  });

  // Idempotencia: si /cobranza YA aplicó ese mismo recibo, restarlo del
  // pendiente lo descontaría DOS veces. El pozo descuenta primero lo que
  // /cobranza reconoce, así que el excedente queda en 0 y no hay ajuste.
  it('no descuenta dos veces cuando /cobranza ya aplicó el mismo recibo', () => {
    const lines = [line({ importeBrutoPesos: 1_000, importePendientePesos: 600 })];
    expect(applyOverlay(lines, new Map([['00011::RI-310071', 400]]))).toEqual([600]);
  });

  it('gana la vista MÁS avanzada de las dos fuentes', () => {
    // /cobranza reconoce 700 cobrados; el recibo sólo 400 → manda /cobranza.
    expect(applyOverlay(
      [line({ importeBrutoPesos: 1_000, importePendientePesos: 300 })],
      new Map([['00011::RI-310071', 400]]),
    )).toEqual([300]);
    // El recibo reconoce 900; /cobranza sólo 700 → el excedente de 200 baja el saldo.
    expect(applyOverlay(
      [line({ importeBrutoPesos: 1_000, importePendientePesos: 300 })],
      new Map([['00011::RI-310071', 900]]),
    )).toEqual([100]);
  });

  it('nunca devuelve negativo aunque el recibo exceda el bruto', () => {
    expect(applyOverlay(
      [line({ importeBrutoPesos: 1_000, importePendientePesos: 1_000 })],
      new Map([['00011::RI-310071', 5_000]]),
    )).toEqual([0]);
  });

  // EL DEFECTO QUE EL POZO EXISTE PARA CERRAR: el recibo es del folio COMPLETO
  // y `/cobranza` puede devolver la factura en VARIAS líneas. Aplicarlo entero
  // a cada línea hace DESAPARECER cobranza real — peor que inflar un
  // pronóstico, porque no deja rastro.
  it('reparte el recibo entre las líneas del folio, sin borrar saldo vivo', () => {
    const lines = [
      line({ importeBrutoPesos: 100_000, importePendientePesos: 100_000 }),
      line({ importeBrutoPesos: 100_000, importePendientePesos: 100_000 }),
    ];
    // Recibo de $150k contra dos líneas de $100k: quedan $50k por cobrar.
    const out = applyOverlay(lines, new Map([['00011::RI-310071', 150_000]]));
    expect(out).toEqual([0, 50_000]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(50_000);
  });

  it('no excede el saldo de una línea al consumir el pozo', () => {
    const lines = [
      line({ importeBrutoPesos: 40_000, importePendientePesos: 40_000 }),
      line({ importeBrutoPesos: 100_000, importePendientePesos: 100_000 }),
    ];
    // Recibo de $40k: agota la primera línea y NO toca la segunda.
    expect(applyOverlay(lines, new Map([['00011::RI-310071', 40_000]]))).toEqual([0, 100_000]);
  });

  it('el pozo descuenta lo ya aplicado por /cobranza en TODAS las líneas del folio', () => {
    const lines = [
      // /cobranza ya reconoce 60k cobrados en el folio (30k + 30k).
      line({ importeBrutoPesos: 100_000, importePendientePesos: 70_000 }),
      line({ importeBrutoPesos: 100_000, importePendientePesos: 70_000 }),
    ];
    // El recibo dice 60k: es el MISMO cobro → excedente 0, nada que ajustar.
    expect(applyOverlay(lines, new Map([['00011::RI-310071', 60_000]]))).toEqual([70_000, 70_000]);
    // Con 80k, el excedente real es 20k y baja la primera línea.
    expect(applyOverlay(lines, new Map([['00011::RI-310071', 80_000]]))).toEqual([50_000, 70_000]);
  });

  it('folios distintos no comparten pozo', () => {
    const lines = [
      line({ noFactura: 'RI-1', importeBrutoPesos: 1_000, importePendientePesos: 1_000 }),
      line({ noFactura: 'RI-2', importeBrutoPesos: 1_000, importePendientePesos: 1_000 }),
    ];
    expect(applyOverlay(lines, new Map([['00011::RI-1', 1_000]]))).toEqual([0, 1_000]);
  });

  it('líneas sin folio reconocible no reciben ajuste ni se mezclan entre sí', () => {
    const lines = [
      line({ noFactura: '', importeBrutoPesos: 1_000, importePendientePesos: 1_000 }),
      line({ noFactura: '-', importeBrutoPesos: 2_000, importePendientePesos: 2_000 }),
    ];
    expect(applyOverlay(lines, new Map([['00011::', 5_000]]))).toEqual([1_000, 2_000]);
  });

  it('tolera importes no finitos sin propagar NaN', () => {
    const pool = buildReceiptSurplusByFolio(
      [line({ importeBrutoPesos: Number.NaN, importePendientePesos: 1_000 })],
      new Map([['00011::RI-310071', 500]]),
    );
    expect(consumeReceiptSurplus(pool, '00011::RI-310071', Number.NaN)).toBe(0);
  });

  it('sin pozo no hace trabajo ni ajuste', () => {
    expect(buildReceiptSurplusByFolio([line()], new Map()).size).toBe(0);
    expect(consumeReceiptSurplus(new Map(), '00011::RI-1', 1_000)).toBe(0);
  });
});
