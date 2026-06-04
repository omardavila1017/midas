import { describe, it, expect } from 'vitest';
import { classifyMovement } from '../netCashFlowEngine';

function mov(concepto: string, tipoMovimiento: 'ABONO' | 'CARGO' = 'ABONO') {
  return {
    concepto,
    referencia: '',
    cuenta: '001',
    fechaOperacion: '2026-05-01',
    tipoMovimiento,
    importe: 1000,
  };
}

describe('classifyMovement — conceptos opacos en ABONOs (regla retirada)', () => {
  // La regla `opaque-income` fue RETIRADA por decisión de negocio: los ABONOs
  // con conceptos genéricos (ABONO PTE, SPEI sin detalle, BCO BENEFIC) ya NO
  // se tratan como traspasos internos; vuelven a contar como ingreso real.
  // Las otras señales de "interno" (leyenda TRASPASO/REF, RFC/beneficiario del
  // grupo, cuenta-destino propia, pair-matched) siguen vigentes.

  it('CONSERVA ABONOs con concepto numérico puro (posibles refs CIE)', () => {
    expect(classifyMovement(mov('44423')).kind).toBe('real');
    expect(classifyMovement(mov('521838225')).kind).toBe('real');
    expect(classifyMovement(mov('174698704')).kind).toBe('real');
  });

  it('CONSERVA ABONOs tipo "56 GUIAS" (folio + token corto)', () => {
    expect(classifyMovement(mov('56 GUIAS')).kind).toBe('real');
  });

  it('CONSERVA ABONOs tipo "ABONO PTE..." (regla retirada)', () => {
    expect(classifyMovement(mov('ABONO PTE. TRANSACCIONES')).kind).toBe('real');
    expect(classifyMovement(mov('ABONO PTE')).kind).toBe('real');
  });

  it('CONSERVA ABONOs SPEI genérico sin detalle (regla retirada)', () => {
    expect(classifyMovement(mov('ABONO TRANSFERENCIA SPEI')).kind).toBe('real');
    expect(classifyMovement(mov('ABONO TRANSFERENCIA SPEI.')).kind).toBe('real');
  });

  it('CONSERVA ABONOs BCO BENEFIC interbancarios (regla retirada)', () => {
    expect(classifyMovement(mov('BCO 40012 BENEFIC GOB EDO MEXICO')).kind).toBe('real');
    expect(classifyMovement(mov('BCO 40156 BENEFIC SABCAPI')).kind).toBe('real');
  });

  it('CONSERVA ABONOs con nombres claros de clientes', () => {
    expect(classifyMovement(mov('UNIVERSIDAD DE MONTERREY')).kind).toBe('real');
    expect(classifyMovement(mov('COLLECTION')).kind).toBe('real');
    expect(classifyMovement(mov('PAGO CLIENTE COCA COLA SA')).kind).toBe('real');
  });

  it('CONSERVA los mismos conceptos cuando son CARGOs', () => {
    // CARGOs con esos conceptos pueden ser pagos legítimos a proveedores
    expect(classifyMovement(mov('BCO 40012 BENEFIC GOB EDO', 'CARGO')).kind).toBe('real');
    expect(classifyMovement(mov('ABONO TRANSFERENCIA SPEI', 'CARGO')).kind).toBe('real');
  });
});
