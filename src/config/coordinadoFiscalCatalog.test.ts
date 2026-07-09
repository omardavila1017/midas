import { describe, expect, it } from 'vitest';
import {
  COORDINADO_LABEL,
  SIN_COORDINADO,
  coordinadoLabelForCia,
  resolveCoordinadoForCia,
} from './coordinadoFiscalCatalog';

describe('coordinadoFiscalCatalog', () => {
  describe('resolveCoordinadoForCia — por código de cía JDE (autoritativo)', () => {
    it('mapea las cabezas de coordinado por código', () => {
      expect(resolveCoordinadoForCia('00001')).toBe('TT'); // Transportes Tamaulipas
      expect(resolveCoordinadoForCia('00011')).toBe('SIR'); // Servicio Industrial Regiomontano
    });

    it('mapea las cías integrantes confirmadas por código', () => {
      expect(resolveCoordinadoForCia('00038')).toBe('TT'); // STDN — Servicios T de N
      expect(resolveCoordinadoForCia('00043')).toBe('TT'); // SES — Servicios Especializados Senda
      expect(resolveCoordinadoForCia('00042')).toBe('SIR'); // TICH
      expect(resolveCoordinadoForCia('00017')).toBe('SIR'); // SIT (familia Servicio Industrial)
    });

    it('empata el código de cía sin importar el zero-padding', () => {
      expect(resolveCoordinadoForCia('1')).toBe('TT');
      expect(resolveCoordinadoForCia('11')).toBe('SIR');
      expect(resolveCoordinadoForCia('42')).toBe('SIR');
    });
  });

  describe('resolveCoordinadoForCia — por RFC (autoritativo alterno)', () => {
    it('resuelve por RFC cuando el código de cía no está en el catálogo', () => {
      // Turimex del Norte — sin cía confirmada, pero su RFC está en el escrito TT.
      expect(resolveCoordinadoForCia('90001', 'Nombre Truncado', 'TNO010131U98')).toBe('TT');
      // Servicio Industrial Potosino — RFC del escrito SIR.
      expect(resolveCoordinadoForCia('90002', '', 'SIP990527FA0')).toBe('SIR');
    });

    it('normaliza el RFC (espacios/guiones/minúsculas) antes de empatar', () => {
      expect(resolveCoordinadoForCia('90003', '', 'ses051125tr5')).toBe('TT');
      expect(resolveCoordinadoForCia('90003', '', 'SES-051125-TR5')).toBe('TT');
    });
  });

  describe('resolveCoordinadoForCia — por nombre (fallback)', () => {
    it('mapea integrantes de TT por nombre', () => {
      expect(resolveCoordinadoForCia('90010', 'TURIMEX DEL NORTE, S.A. DE C.V.')).toBe('TT');
      expect(resolveCoordinadoForCia('90011', 'Autotransporte Adventur SA de CV')).toBe('TT');
      expect(resolveCoordinadoForCia('90012', 'Operadora de Ventas Grupo Senda')).toBe('TT');
      expect(resolveCoordinadoForCia('90013', 'Inmuebles Autobuses Coahuilenses')).toBe('TT');
    });

    it('mapea integrantes de SIR por nombre', () => {
      expect(resolveCoordinadoForCia('90020', 'Servicio Industrial Potosino')).toBe('SIR');
      expect(resolveCoordinadoForCia('90021', 'Servicio Industrial Zacatecano')).toBe('SIR');
      expect(resolveCoordinadoForCia('90022', 'Senda Servicio Industrial')).toBe('SIR');
      expect(resolveCoordinadoForCia('90023', 'Transportes Industriales Chihuahuenses')).toBe('SIR');
    });

    it('normaliza acentos antes de empatar', () => {
      expect(resolveCoordinadoForCia('90030', 'Servicio Industrial Zacatecáno')).toBe('SIR');
    });
  });

  describe('MULTICARGA — opta por coordinado: NO', () => {
    it('cae a Sin coordinado por código de cía aunque esté en el escrito TT', () => {
      expect(resolveCoordinadoForCia('00033')).toBeUndefined();
      expect(resolveCoordinadoForCia('33')).toBeUndefined();
    });

    it('cae a Sin coordinado por RFC o por nombre', () => {
      expect(resolveCoordinadoForCia('90040', 'MULTICARGA SA DE CV')).toBeUndefined();
      expect(resolveCoordinadoForCia('90040', 'X', 'MUL9707108M3')).toBeUndefined();
    });
  });

  describe('precedencia y casos borde', () => {
    it('el código de cía gana sobre el nombre', () => {
      const rules = [
        { coordinado: 'TT' as const, cias: ['00099'], namePatterns: [] },
        { coordinado: 'SIR' as const, cias: [], namePatterns: [/regiomontano/i] },
      ];
      // El nombre diría SIR, pero el código 00099 está listado en TT.
      expect(resolveCoordinadoForCia('00099', 'Servicio Industrial Regiomontano', undefined, rules)).toBe('TT');
    });

    it('regresa undefined para una empresa sin patrón conocido', () => {
      expect(resolveCoordinadoForCia('88888', 'Empresa Genérica del Norte')).toBeUndefined();
      expect(resolveCoordinadoForCia('88888', '')).toBeUndefined();
    });
  });

  describe('coordinadoLabelForCia', () => {
    it('resuelve la etiqueta desde el catálogo de empresas (por código)', () => {
      const companies = [{ cia: '00001', nombre: 'Transportes Tamaulipas', rfc: 'TTA4906038F4' }];
      expect(coordinadoLabelForCia('00001', companies)).toBe(COORDINADO_LABEL.TT);
    });

    it('resuelve por RFC cuando el nombre no basta', () => {
      const companies = [{ cia: '90099', nombre: 'Razón Social Truncada', rfc: 'SIP990527FA0' }];
      expect(coordinadoLabelForCia('90099', companies)).toBe(COORDINADO_LABEL.SIR);
    });

    it('cae a "Sin coordinado" cuando no hay match', () => {
      expect(coordinadoLabelForCia('88888', [{ cia: '88888', nombre: 'Otra' }])).toBe(SIN_COORDINADO);
      expect(coordinadoLabelForCia('88888', [])).toBe(SIN_COORDINADO);
    });

    it('etiqueta Multicarga como Sin coordinado (opta por NO)', () => {
      const companies = [{ cia: '00033', nombre: 'MULTICARGA SA DE CV', rfc: 'MUL9707108M3' }];
      expect(coordinadoLabelForCia('00033', companies)).toBe(SIN_COORDINADO);
    });
  });
});
