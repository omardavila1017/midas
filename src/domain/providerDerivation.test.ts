import { describe, expect, it } from 'vitest';
import {
  deriveProvidersFromJde,
  EMPLOYEE_PROVIDER_TYPE,
  isEmployeeClassificationText,
  isEmployeeSearchType,
  type AgedRecordLike,
} from './providerDerivation';
import type { PagoProveedorRecord } from '../services/jdeTypes';

function aged(patch: Partial<AgedRecordLike>): AgedRecordLike {
  return {
    noProveedor: '107671',
    nombre: 'PROVEEDOR DEMO',
    clasificacionProveedor: '',
    clasifica: '',
    importePendientePesos: 1000,
    fechaFactura: '2026-01-15',
    condPago: '30',
    ...patch,
  };
}

function pago(patch: Partial<PagoProveedorRecord>): PagoProveedorRecord {
  return {
    tipoPago: 'PT',
    noPago: 'P1',
    cia: '00011',
    nombreCia: 'CIA',
    cuentaBancaria: '',
    cuentaBanco: '',
    fechaPago: '2026-01-20',
    importePesos: 5000,
    moneda: 'MXP',
    batchPago: 'B1',
    claveProveedor: '200500',
    rfcProveedor: '',
    nombreProveedor: 'JUAN PEREZ',
    tipoBusqueda: '',
    clasificacionProveedor: '',
    clasificacionProveedorFinanciera: '',
    comentarioPago: '',
    ...patch,
  };
}

describe('isEmployeeSearchType / isEmployeeClassificationText', () => {
  it('detecta tipoBusqueda Employees (case-insensitive, con espacios)', () => {
    expect(isEmployeeSearchType('Employees')).toBe(true);
    expect(isEmployeeSearchType('  employee ')).toBe(true);
    expect(isEmployeeSearchType('Suppliers')).toBe(false);
    expect(isEmployeeSearchType(undefined)).toBe(false);
  });

  it('detecta texto de clasificación nómina/reembolso/vales', () => {
    expect(isEmployeeClassificationText('NOMINA')).toBe(true);
    expect(isEmployeeClassificationText('Nóminas')).toBe(true);
    expect(isEmployeeClassificationText('Reembolso de gastos')).toBe(true);
    expect(isEmployeeClassificationText('Vales de despensa')).toBe(true);
    expect(isEmployeeClassificationText('220 - Por Clasificar')).toBe(false);
    expect(isEmployeeClassificationText(undefined, '')).toBe(false);
  });
});

describe('deriveProvidersFromJde — clasificación de empleados', () => {
  it('marca isEmployee y tipo Prestaciones desde tipoBusqueda=Employees', () => {
    const providers = deriveProvidersFromJde({
      pagoProveedorRecords: [pago({ claveProveedor: '200500', tipoBusqueda: 'Employees' })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBe(true);
    expect(providers[0].type).toBe(EMPLOYEE_PROVIDER_TYPE);
  });

  it('marca empleado por texto de clasificación en CXP aunque no haya pago', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '300900', clasificacionProveedor: 'NOMINA' })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBe(true);
    expect(providers[0].type).toBe(EMPLOYEE_PROVIDER_TYPE);
  });

  it('un proveedor comercial normal no se marca como empleado y conserva su categoría', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671', clasificacionProveedor: 'DIESEL' })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBeFalsy();
    expect(providers[0].type).toBe('DIESEL');
  });

  it('marca empleado por pensión alimenticia', () => {
    const providers = deriveProvidersFromJde({
      pagoProveedorRecords: [pago({
        claveProveedor: '52783473',
        nombreProveedor: 'ALMA ROSA CHAVES CASTAÑUELA',
        clasificacionProveedor: 'PENSION ALIMENTICIA',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBe(true);
    expect(providers[0].type).toBe(EMPLOYEE_PROVIDER_TYPE);
  });

  it('persona física con categoría Recursos Humanos → empleado', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '71675620',
        nombre: 'ANA LIZETH LOPEZ GAYTAN',
        clasificacionProveedor: 'Recursos Humanos',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBe(true);
    expect(providers[0].type).toBe(EMPLOYEE_PROVIDER_TYPE);
  });

  it('razón social con categoría Recursos Humanos sigue siendo proveedor comercial', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '88001122',
        nombre: 'SERVICIOS DE CAPITAL HUMANO SA DE CV',
        clasificacionProveedor: 'Recursos Humanos',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBeFalsy();
    expect(providers[0].type).toBe('Recursos Humanos');
  });
});

describe('deriveProvidersFromJde — llaves JDE en notación científica', () => {
  it('fusiona por nombre el registro con llave científica en el de número íntegro', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '52783473',
        nombre: 'ALMA ROSA CHAVES CASTAÑUELA',
        importePendientePesos: 1000,
      })],
      pagoProveedorRecords: [pago({
        claveProveedor: '5.27835e+007',
        nombreProveedor: 'ALMA ROSA CHAVES CASTAÑUELA',
        importePesos: 5000,
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].numProveedorJDE).toBe('52783473');
  });

  it('llave científica sin contraparte por nombre queda como fila aparte con la llave expandida', () => {
    const providers = deriveProvidersFromJde({
      pagoProveedorRecords: [pago({
        claveProveedor: '5.27835e+007',
        nombreProveedor: 'PROVEEDOR HUERFANO',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe('derived-52783500');
  });

  it('no fusiona cuando hay más de un candidato homónimo con número íntegro', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [
        aged({ noProveedor: '100001', nombre: 'JUAN PEREZ' }),
        aged({ noProveedor: '100002', nombre: 'JUAN PEREZ' }),
      ],
      pagoProveedorRecords: [pago({ claveProveedor: '1.0e+005', nombreProveedor: 'JUAN PEREZ' })],
    });
    expect(providers).toHaveLength(3);
  });
});
