import { describe, expect, it } from 'vitest';
import {
  IVA_CREDITABLE_EXCLUSIONS,
  isCreditableExcludedConcept,
  matchCreditableExclusion,
} from './ivaCreditableExclusions';

describe('ivaCreditableExclusions', () => {
  it('excluye los 8 conceptos que Fiscal quita del acreditable', () => {
    const cases: Array<[string, string]> = [
      ['Reembolso de gastos a EMPLEADOS varios', 'Empleados'],
      ['ASOCIACION PROTACIO AC', 'Asociación Protacio'],
      ['Pago a asociacion Protasio', 'Asociación Protacio'],
      ['OCSI servicios', 'OCSI'],
      ['Pago de PENSIONES alimenticias', 'Pensiones'],
      ['Dispersión de NÓMINA semanal', 'Nómina'],
      ['Compra de VALES de despensa', 'Vales'],
      ['REEMBOLSO caja chica', 'Reembolsos'],
      ['REPOSICIÓN de fondo fijo', 'Reposiciones'],
    ];
    for (const [text, label] of cases) {
      expect(matchCreditableExclusion(text), text).toBe(label);
      expect(isCreditableExcludedConcept(text), text).toBe(true);
    }
  });

  it('NO excluye proveedores/conceptos legítimos (sin falsos positivos)', () => {
    const legit = [
      'DIESEL DEL NORTE SA DE CV',
      'Refaccionaria La Valenciana', // contiene "vale" pero no como palabra
      'AVALES Y FIANZAS SA',         // "avales" no debe matchear \bvales?\b
      'Denominacion de origen',      // "nomina" dentro de "denominacion"
      'NOMINAL SERVICIOS SA',        // "nominal" no debe matchear \bnominas?\b
      'Valor nominal del titulo',    // "nominal" no debe matchear
      'Servicio de mantenimiento de flota',
      'IVA acreditable (libro mayor) · 16% · cuenta 1180',
    ];
    for (const text of legit) {
      expect(isCreditableExcludedConcept(text), text).toBe(false);
    }
  });

  it('es tolerante a acentos y mayúsculas', () => {
    expect(isCreditableExcludedConcept('nómina')).toBe(true);
    expect(isCreditableExcludedConcept('NOMINA')).toBe(true);
    expect(isCreditableExcludedConcept('reposición')).toBe(true);
  });

  it('acepta un catálogo inyectado', () => {
    const custom = [{ label: 'Combustible', patterns: [/\bdiesel\b/i] }];
    expect(matchCreditableExclusion('compra DIESEL', custom)).toBe('Combustible');
    expect(isCreditableExcludedConcept('NÓMINA', custom)).toBe(false); // no está en el custom
  });

  it('el catálogo por defecto trae exactamente los 8 conceptos', () => {
    expect(IVA_CREDITABLE_EXCLUSIONS.map((r) => r.label)).toEqual([
      'Empleados',
      'Asociación Protacio',
      'OCSI',
      'Pensiones',
      'Nómina',
      'Vales',
      'Reembolsos',
      'Reposiciones',
    ]);
  });
});
