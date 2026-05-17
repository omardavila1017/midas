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

describe('classifyMovement — opaque income filter', () => {
  // CONSERVA folios numéricos puros: pueden ser refs CIE legítimas de
  // cobranza corporativa. La versión agresiva filtraba estos y
  // subvaluaba ingresos ~3x. Si en el futuro se quiere filtrar, debe
  // cruzar contra `noCliente` del catálogo primero.
  it('CONSERVA ABONOs con concepto numérico puro (posibles refs CIE)', () => {
    expect(classifyMovement(mov('44423')).kind).toBe('real');
    expect(classifyMovement(mov('521838225')).kind).toBe('real');
    expect(classifyMovement(mov('174698704')).kind).toBe('real');
  });

  it('CONSERVA ABONOs tipo "56 GUIAS" (folio + token corto)', () => {
    expect(classifyMovement(mov('56 GUIAS')).kind).toBe('real');
  });

  it('filtra ABONOs tipo "ABONO PTE..."', () => {
    expect(classifyMovement(mov('ABONO PTE. TRANSACCIONES')).kind).toBe('internal');
    expect(classifyMovement(mov('ABONO PTE')).kind).toBe('internal');
  });

  it('filtra ABONOs SPEI genérico sin detalle', () => {
    expect(classifyMovement(mov('ABONO TRANSFERENCIA SPEI')).kind).toBe('internal');
    expect(classifyMovement(mov('ABONO TRANSFERENCIA SPEI.')).kind).toBe('internal');
  });

  it('filtra ABONOs BCO BENEFIC interbancarios', () => {
    expect(classifyMovement(mov('BCO 40012 BENEFIC GOB EDO MEXICO')).kind).toBe('internal');
    expect(classifyMovement(mov('BCO 40156 BENEFIC SABCAPI')).kind).toBe('internal');
  });

  it('CONSERVA ABONOs con nombres claros de clientes', () => {
    expect(classifyMovement(mov('UNIVERSIDAD DE MONTERREY')).kind).toBe('real');
    expect(classifyMovement(mov('COLLECTION')).kind).toBe('real');
    expect(classifyMovement(mov('PAGO CLIENTE COCA COLA SA')).kind).toBe('real');
  });

  it('NO filtra los mismos conceptos cuando son CARGOs', () => {
    // CARGOs con esos conceptos pueden ser pagos legítimos a proveedores
    expect(classifyMovement(mov('BCO 40012 BENEFIC GOB EDO', 'CARGO')).kind).toBe('real');
    expect(classifyMovement(mov('ABONO TRANSFERENCIA SPEI', 'CARGO')).kind).toBe('real');
  });

  it('reason = "opaque-income" cuando se filtra patrón conservado', () => {
    const result = classifyMovement(mov('ABONO PTE. TRANSACCIONES'));
    expect(result.kind).toBe('internal');
    expect(result.reason).toBe('opaque-income');
  });
});
