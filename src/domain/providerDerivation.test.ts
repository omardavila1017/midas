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
});
