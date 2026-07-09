import { describe, it, expect } from 'vitest';
import {
  COMPENSATION_CLIENT_RULES,
  COMPENSATION_SCHEME_LABEL,
  resolveCompensationRule,
} from './compensationClientsCatalog';

describe('resolveCompensationRule — seed de producción (junta 2026-07-09)', () => {
  it('TLJ empata por nombre → aplica-a-proveedor', () => {
    const rule = resolveCompensationRule('', 'TLJ SA DE CV');
    expect(rule?.label).toBe('TLJ');
    expect(rule?.scheme).toBe('aplica-a-proveedor');
  });

  it('APTIV empata (razón social completa del catálogo de clientes) → descuento-en-origen', () => {
    const rule = resolveCompensationRule('', 'APTIV CONTRACT SERVICES NORESTE, S. DE R.L. DE C.V.');
    expect(rule?.label).toBe('APTIV');
    expect(rule?.scheme).toBe('descuento-en-origen');
  });

  it('la abreviatura "APTI" (como se citó en la junta) también empata', () => {
    expect(resolveCompensationRule('', 'APTI')?.label).toBe('APTIV');
  });

  it('CMI empata → descuento-en-origen', () => {
    const rule = resolveCompensationRule('', 'CMI FILTRATION MEXICO MANUFACTURA');
    expect(rule?.label).toBe('CMI');
    expect(rule?.scheme).toBe('descuento-en-origen');
  });

  it('Corning NO es excepción (paga a Bajío y aparece normal en bancos)', () => {
    expect(resolveCompensationRule('', 'CORNING  OPTICAL COMMUNICATIONS, S DE RL DE CV')).toBeUndefined();
    expect(resolveCompensationRule('', 'CORNING MONTERREY')).toBeUndefined();
  });

  it('un cliente cualquiera no empata', () => {
    expect(resolveCompensationRule('999', 'TRANSPORTES GENERICOS SA')).toBeUndefined();
  });

  it('"CMI" como substring de otra palabra NO empata (límite de palabra)', () => {
    expect(resolveCompensationRule('', 'ACMISA INDUSTRIAL')).toBeUndefined();
  });
});

describe('resolveCompensationRule — mecánica del matching', () => {
  const RULES = [
    {
      scheme: 'aplica-a-proveedor' as const,
      label: 'X',
      clientKeys: ['00456'],
      namePatterns: [/\bEQUIS\b/i],
    },
  ];

  it('empata por clave JDE exacta, tolerante a ceros a la izquierda en ambos lados', () => {
    expect(resolveCompensationRule('456', 'OTRO NOMBRE', RULES)?.label).toBe('X');
    expect(resolveCompensationRule('00456', 'OTRO NOMBRE', RULES)?.label).toBe('X');
    expect(resolveCompensationRule('456 ', 'OTRO NOMBRE', RULES)?.label).toBe('X');
  });

  it('empata por nombre tolerante a case y whitespace', () => {
    expect(resolveCompensationRule('', '  equis   sa de cv ', RULES)?.label).toBe('X');
  });

  it('clave distinta y nombre sin patrón → undefined', () => {
    expect(resolveCompensationRule('457', 'ZETA SA', RULES)).toBeUndefined();
  });

  it('clave vacía no empata contra nada (no colapsa en "")', () => {
    expect(resolveCompensationRule('', 'ZETA SA', RULES)).toBeUndefined();
  });
});

describe('catálogo', () => {
  it('cada regla del seed trae esquema con etiqueta UI y al menos un criterio de match', () => {
    for (const rule of COMPENSATION_CLIENT_RULES) {
      expect(COMPENSATION_SCHEME_LABEL[rule.scheme]).toBeTruthy();
      const criteria = (rule.clientKeys?.length ?? 0) + (rule.namePatterns?.length ?? 0);
      expect(criteria).toBeGreaterThan(0);
    }
  });
});
