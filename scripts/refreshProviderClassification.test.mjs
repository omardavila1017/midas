import { describe, expect, it } from 'vitest';
import {
  buildKnownVocabulary,
  buildRefreshedCatalog,
  classKey,
  parseCsv,
  parseRelacionRows,
  validateRow,
} from './refresh-provider-classification.mjs';

describe('refresh-provider-classification (helpers puros)', () => {
  it('classKey deacentúa, colapsa espacios y sube a mayúsculas', () => {
    expect(classKey('Tecnología de la  Información')).toBe('TECNOLOGIA DE LA INFORMACION');
    expect(classKey('  Arrendamientos  ')).toBe('ARRENDAMIENTOS');
  });

  it('parseCsv respeta comillas + comas embebidas + BOM', () => {
    const text = '﻿a,b,c\n"x,1","y ""q""",z\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'y "q"', 'z'],
    ]);
  });

  it('parseRelacionRows mapea columnas por encabezado', () => {
    const csv = 'Clave_Proveedor,Nombre_Proveedor,Tipo_Busqueda,Clasificacion_Proveedor,Importe_Pagado\n'
      + '123,ZAR KRUSE,Proveedores,Refaccionario,1000\n';
    expect(parseRelacionRows(csv)).toEqual([
      { clave: '123', nombre: 'ZAR KRUSE', tipoBusqueda: 'Proveedores', clasificacion: 'Refaccionario', importe: '1000' },
    ]);
  });

  it('parseRelacionRows LANZA si falta un encabezado esperado (no filas vacías silenciosas)', () => {
    // Antes: encabezado ausente → indexOf -1 → cells[-1] → '' en TODAS las
    // filas, 100% marcadas `vacia` sin error. Debe fallar ruidoso.
    const csv = 'Proveedor,Nombre_Proveedor,Tipo_Busqueda,Clasificacion_Proveedor,Importe_Pagado\n'
      + '123,ZAR KRUSE,Proveedores,Refaccionario,1000\n';
    expect(() => parseRelacionRows(csv)).toThrow(/Clave_Proveedor/);
  });

  const known = buildKnownVocabulary({
    industryCatalog: { catalog: { ARR: 'Arrendamientos', AUT: 'Automotriz' } },
    providerCatalog: { providerTypeByName: { Foo: 'Refaccionario' }, classificationByName: {}, flexibilityByClass: {} },
  });

  it('buildKnownVocabulary une industria + vocab de Midas (normalizado)', () => {
    expect(known.has(classKey('Arrendamientos'))).toBe(true);
    expect(known.has(classKey('Automotriz'))).toBe(true);
    expect(known.has(classKey('Refaccionario'))).toBe(true);
    expect(known.has(classKey('Inventado'))).toBe(false);
  });

  it('validateRow marca vacía / NULL / no-mapeable y acepta lo válido', () => {
    expect(validateRow({ clasificacion: '' }, known)).toEqual({ ok: false, motivo: 'vacia' });
    expect(validateRow({ clasificacion: 'NULL' }, known)).toEqual({ ok: false, motivo: 'null-literal' });
    expect(validateRow({ clasificacion: 'Xyz' }, known)).toEqual({ ok: false, motivo: 'no-mapeable' });
    expect(validateRow({ clasificacion: 'Arrendamientos' }, known)).toEqual({ ok: true, motivo: null });
  });

  it('buildRefreshedCatalog mergea sin tocar otros campos y es idempotente', () => {
    const base = {
      version: '1.2',
      sources: ['x.xlsx'],
      providerTypeByName: { Existente: 'Servicios' },
      classificationByName: { Existente: 'Servicios' },
      providerNoByName: { Existente: '9' },
      flexibilityByName: { Existente: 'flexible' }, // otro campo: debe preservarse
    };
    const rows = [
      { nombre: 'Existente', clave: '9', clasificacion: 'Refaccionario' },
      { nombre: 'Nuevo', clave: '77', clasificacion: 'Automotriz' },
    ];
    const first = buildRefreshedCatalog(base, rows, { generated: '2026-07-21', sourceLabel: 'mayte.xlsx' });
    expect(first.updated).toBe(1);
    expect(first.added).toBe(1);
    expect(first.catalog.providerTypeByName).toEqual({ Existente: 'Refaccionario', Nuevo: 'Automotriz' });
    expect(first.catalog.flexibilityByName).toEqual({ Existente: 'flexible' }); // preservado
    expect(first.catalog.sources).toContain('mayte.xlsx');
    expect(first.catalog.generated).toBe('2026-07-21');
    // Idempotencia: re-correr sobre el resultado no cambia nada.
    const second = buildRefreshedCatalog(first.catalog, rows, { generated: '2026-07-21', sourceLabel: 'mayte.xlsx' });
    expect(second.catalog).toEqual(first.catalog);
  });
});
