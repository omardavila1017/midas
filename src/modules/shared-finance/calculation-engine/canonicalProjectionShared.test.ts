import { describe, expect, it } from 'vitest';
import {
  resolveInflowSubcategory,
  usableJdeProviderCategory,
  INCOME_SUBCAT_CITI,
} from './canonicalProjectionShared';
import type { Client } from '../../../domain/types';

const emptyClients = new Map<string, Client>();

describe('resolveInflowSubcategory — buckets de ingreso por unidad de negocio', () => {
  it('routes uncrossed ABONOs on FEDERAL accounts to Federal', () => {
    expect(
      resolveInflowSubcategory({ clientById: emptyClients, businessUnitId: 'FEDERAL' }),
    ).toBe('Federal');
  });

  it('routes uncrossed ABONOs on MULTICARGA accounts (Sendex / guías prepagadas) to Multicarga', () => {
    // El bucket "Multicarga" existía en la taxonomía de Planeación pero el
    // resolver nunca lo emitía — el ingreso de paquetería caía a Clientes Citi.
    expect(
      resolveInflowSubcategory({ clientById: emptyClients, businessUnitId: 'MULTICARGA' }),
    ).toBe('Multicarga');
  });

  it('viajes_especiales subRole dominates over the account business unit', () => {
    expect(
      resolveInflowSubcategory({
        clientById: emptyClients,
        businessUnitId: 'FEDERAL',
        bankSubRole: 'viajes_especiales',
      }),
    ).toBe('Viajes Especiales');
  });

  it('crossed collections (rol) stay Citi even on Federal accounts', () => {
    expect(
      resolveInflowSubcategory({
        clientById: emptyClients,
        businessUnitId: 'FEDERAL',
        isRolCollection: true,
      }),
    ).toBe(INCOME_SUBCAT_CITI);
  });

  it('defaults to Clientes Citi when nothing matches', () => {
    expect(resolveInflowSubcategory({ clientById: emptyClients })).toBe(INCOME_SUBCAT_CITI);
  });
});

describe('usableJdeProviderCategory — centinelas y precedencia por especificidad', () => {
  it('descarta los centinelas de "vacío" que JDE escribe como texto', () => {
    // Medidos en jde.Pago_Proveedor (pagos 2026): `" "` con comillas literales
    // (643 pagos / $62.96M) y `-                              .` (3,023 pagos).
    expect(usableJdeProviderCategory('" "')).toBeUndefined();
    expect(usableJdeProviderCategory('-                              .')).toBeUndefined();
    expect(usableJdeProviderCategory('-')).toBeUndefined();
    expect(usableJdeProviderCategory('220 - Por Clasificar')).toBeUndefined();
    // Un centinela NO debe tapar al campo que sí trae la clasificación:
    // `" "` + `180 - Proveedores TI` = $1,531,533.81 que se perdían.
    expect(usableJdeProviderCategory('" "', '180 - Proveedores TI')).toBe('Proveedores TI');
    expect(usableJdeProviderCategory('-                              .', '010 - Refacciones y Llantas'))
      .toBe('Refacciones y Llantas');
  });

  it('el valor que DESCRIBE el gasto le gana al cajón de sastre, sin importar el orden', () => {
    // Casos reales de la BD (pagos 2026). "Servicios" es cajón de sastre: bajo
    // él conviven casetas, prestaciones sindicales y bancos.
    // PASE, SERVICIOS ELECTRONICOS — casetas — $25,477,473.73
    expect(usableJdeProviderCategory('Servicios', '160 - Autopistas')).toBe('Autopistas');
    // ASOCIACION PROTACIO RODRIGUEZ CUELLAR AC — prestaciones — $40,840,000+
    expect(usableJdeProviderCategory('Servicios', '130 - Beneficios')).toBe('Beneficios');
    // $6,611,231.86 de refacciones que salían como "Proveedores sin categoría"
    expect(usableJdeProviderCategory('Servicios', '010 - Refacciones y Llantas'))
      .toBe('Refacciones y Llantas');
    // "Taller" NO es cajón de sastre (Rectificadores Monterrey, Rodando Seguro):
    // describe el gasto y gana por orden — y cae en el mismo bucket que
    // Refacciones (Flota), así que la fila no se parte.
    expect(usableJdeProviderCategory('Taller', '010 - Refacciones y Llantas')).toBe('Taller');
    // "Bancario" es el CANAL de pago, no el gasto (IMSS, capital del convenio,
    // compra de dólares conviven ahí) → también cede.
    expect(usableJdeProviderCategory('Bancario', '190 - Concurso')).toBe('Concurso');
  });

  it('conserva el genérico como último recurso (nunca degrada a undefined)', () => {
    expect(usableJdeProviderCategory('Servicios', '220 - Por Clasificar')).toBe('Servicios');
    expect(usableJdeProviderCategory('Bancario', '-                              .')).toBe('Bancario');
    // Específico solo: pasa tal cual.
    expect(usableJdeProviderCategory('Refaccionario')).toBe('Refaccionario');
  });
});
