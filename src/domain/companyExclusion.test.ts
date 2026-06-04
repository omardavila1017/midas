import { describe, it, expect } from 'vitest';
import {
  EXCLUSION_RULES,
  matchesExclusionIdentity,
  isExcludedCompany,
  filterActiveCompanies,
  normalizeCiaNumber,
  type ExclusionRules,
} from './companyExclusion';

// Reglas explícitas para ejercitar la LÓGICA de match con independencia del
// default de producción (que hoy está vacío — nada se excluye). Espejan lo que
// alguna vez estuvo configurado (empresa 33 + multicarga).
const SAMPLE_RULES: ExclusionRules = {
  ciaNumbers: [33],
  namePatterns: ['multicarga'],
  unidadesNegocio: ['MULTICARGA'],
};

describe('companyExclusion — matching logic (3 match modes)', () => {
  it('matches empresa 33 regardless of cia padding', () => {
    expect(matchesExclusionIdentity({ cia: '00033' }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ cia: '33' }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ cia: 33 }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ cia: '00011' }, SAMPLE_RULES)).toBe(false);
  });

  it('matches multicarga by company name (accent/case-insensitive)', () => {
    expect(matchesExclusionIdentity({ nombre: 'MULTICARGA SA DE CV' }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ nombre: 'Múlticarga' }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ nombre: 'Senda Citi' }, SAMPLE_RULES)).toBe(false);
  });

  it('matches multicarga by bank-account unidadNegocio', () => {
    expect(matchesExclusionIdentity({ unidadNegocio: 'MULTICARGA' }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ unidadNegocio: 'multicarga' }, SAMPLE_RULES)).toBe(true);
    expect(matchesExclusionIdentity({ unidadNegocio: 'CITI' }, SAMPLE_RULES)).toBe(false);
  });

  it('normalizeCiaNumber strips padding', () => {
    expect(normalizeCiaNumber('00033')).toBe(33);
    expect(normalizeCiaNumber('abc')).toBeNull();
  });

  it('isExcludedCompany honors explicit rules (identity-only)', () => {
    expect(isExcludedCompany({ cia: '00033' }, SAMPLE_RULES)).toBe(true);
    expect(isExcludedCompany({ nombre: 'Multicarga del Norte' }, SAMPLE_RULES)).toBe(true);
    expect(isExcludedCompany({ cia: '00011', nombre: 'Senda' }, SAMPLE_RULES)).toBe(false);
  });

  it('filterActiveCompanies drops inactive AND excluded companies (explicit rules)', () => {
    const companies = [
      { cia: '00011', nombre: 'Senda', activa: true },
      { cia: '00033', nombre: 'Multicarga', activa: true },
      { cia: '00012', nombre: 'Inactiva', activa: false },
    ];
    const kept = filterActiveCompanies(companies, SAMPLE_RULES);
    expect(kept.map(c => c.cia)).toEqual(['00011']);
  });
});

describe('companyExclusion — default rules are empty (nothing excluded)', () => {
  it('default EXCLUSION_RULES exclude nothing', () => {
    expect(EXCLUSION_RULES.ciaNumbers).toEqual([]);
    expect(EXCLUSION_RULES.namePatterns).toEqual([]);
    expect(EXCLUSION_RULES.unidadesNegocio).toEqual([]);
  });

  it('empresa 33 and multicarga now pass through with the default rules', () => {
    expect(matchesExclusionIdentity({ cia: '00033' })).toBe(false);
    expect(matchesExclusionIdentity({ nombre: 'MULTICARGA SA DE CV' })).toBe(false);
    expect(matchesExclusionIdentity({ unidadNegocio: 'MULTICARGA' })).toBe(false);
  });

  it('filterActiveCompanies still drops only inactive companies by default', () => {
    const companies = [
      { cia: '00011', nombre: 'Senda', activa: true },
      { cia: '00033', nombre: 'Multicarga', activa: true },
      { cia: '00012', nombre: 'Inactiva', activa: false },
    ];
    const kept = filterActiveCompanies(companies);
    expect(kept.map(c => c.cia)).toEqual(['00011', '00033']);
  });
});
