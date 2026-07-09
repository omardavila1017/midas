import { describe, expect, it } from 'vitest';
import {
  COORDINADO_LABEL,
  SIN_COORDINADO,
  coordinadoLabelForCia,
  resolveCoordinadoForCia,
} from './coordinadoFiscalCatalog';

describe('coordinadoFiscalCatalog', () => {
  describe('resolveCoordinadoForCia — siembra provisional por nombre', () => {
    it('mapea nombres de transporte de personal a SIRES', () => {
      expect(resolveCoordinadoForCia('00001', 'Transportes CIR SA de CV')).toBe('SIRES');
      expect(resolveCoordinadoForCia('00002', 'Servicio Industrial Potosino')).toBe('SIRES');
      expect(resolveCoordinadoForCia('00003', 'Autotransportes Zacatecano')).toBe('SIRES');
    });

    it('mapea Tamaulipas / TVN / Turimex a Federal', () => {
      expect(resolveCoordinadoForCia('00010', 'Transportes Tamaulipas')).toBe('FEDERAL');
      expect(resolveCoordinadoForCia('00011', 'TVN Logística')).toBe('FEDERAL');
      expect(resolveCoordinadoForCia('00012', 'Turimex Internacional')).toBe('FEDERAL');
    });

    it('normaliza acentos antes de empatar', () => {
      expect(resolveCoordinadoForCia('00020', 'Autotransportes Zacatecáno')).toBe('SIRES');
    });

    it('regresa undefined para una empresa sin patrón conocido', () => {
      expect(resolveCoordinadoForCia('00099', 'Empresa Genérica del Norte')).toBeUndefined();
      expect(resolveCoordinadoForCia('00099', '')).toBeUndefined();
    });

    it('prioriza el código de cia exacto sobre el nombre', () => {
      const rules = [
        { coordinado: 'FEDERAL' as const, cias: ['00001'], namePatterns: [] },
        { coordinado: 'SIRES' as const, cias: [], namePatterns: [/\bCIR\b/i] },
      ];
      // El nombre diría SIRES, pero el código 00001 está listado en FEDERAL.
      expect(resolveCoordinadoForCia('00001', 'Transportes CIR', rules)).toBe('FEDERAL');
    });
  });

  describe('coordinadoLabelForCia', () => {
    it('resuelve la etiqueta desde el catálogo de empresas', () => {
      const companies = [{ cia: '00012', nombre: 'Turimex Internacional' }];
      expect(coordinadoLabelForCia('00012', companies)).toBe(COORDINADO_LABEL.FEDERAL);
    });

    it('cae a "Sin coordinado" cuando no hay match', () => {
      expect(coordinadoLabelForCia('00099', [{ cia: '00099', nombre: 'Otra' }])).toBe(SIN_COORDINADO);
      expect(coordinadoLabelForCia('00099', [])).toBe(SIN_COORDINADO);
    });
  });
});
