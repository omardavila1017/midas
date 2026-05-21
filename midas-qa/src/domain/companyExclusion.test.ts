import { describe, it, expect } from 'vitest';
import {
  matchesExclusionIdentity,
  isExcludedCompany,
  filterActiveCompanies,
  normalizeCiaNumber,
} from './companyExclusion';

describe('companyExclusion — identity (3 match modes)', () => {
  it('matches empresa 33 regardless of cia padding', () => {
    expect(matchesExclusionIdentity({ cia: '00033' })).toBe(true);
    expect(matchesExclusionIdentity({ cia: '33' })).toBe(true);
    expect(matchesExclusionIdentity({ cia: 33 })).toBe(true);
    expect(matchesExclusionIdentity({ cia: '00011' })).toBe(false);
  });

  it('matches multicarga by company name (accent/case-insensitive)', () => {
    expect(matchesExclusionIdentity({ nombre: 'MULTICARGA SA DE CV' })).toBe(true);
    expect(matchesExclusionIdentity({ nombre: 'Múlticarga' })).toBe(true);
    expect(matchesExclusionIdentity({ nombre: 'Senda Citi' })).toBe(false);
  });

  it('matches multicarga by bank-account unidadNegocio', () => {
    expect(matchesExclusionIdentity({ unidadNegocio: 'MULTICARGA' })).toBe(true);
    expect(matchesExclusionIdentity({ unidadNegocio: 'multicarga' })).toBe(true);
    expect(matchesExclusionIdentity({ unidadNegocio: 'CITI' })).toBe(false);
  });

  it('normalizeCiaNumber strips padding', () => {
    expect(normalizeCiaNumber('00033')).toBe(33);
    expect(normalizeCiaNumber('abc')).toBeNull();
  });
});

describe('companyExclusion — blanket (no date boundary)', () => {
  it('excludes empresa 33 in all dates, including history', () => {
    expect(matchesExclusionIdentity({ cia: '00033' })).toBe(true);
  });

  it('never drops a non-excluded entity', () => {
    expect(matchesExclusionIdentity({ cia: '00011' })).toBe(false);
  });
});

describe('companyExclusion — company gating', () => {
  it('filterActiveCompanies drops inactive AND excluded companies', () => {
    const companies = [
      { cia: '00011', nombre: 'Senda', activa: true },
      { cia: '00033', nombre: 'Multicarga', activa: true },
      { cia: '00012', nombre: 'Inactiva', activa: false },
    ];
    const kept = filterActiveCompanies(companies);
    expect(kept.map(c => c.cia)).toEqual(['00011']);
  });

  it('isExcludedCompany is identity-only (forward-looking)', () => {
    expect(isExcludedCompany({ cia: '00033' })).toBe(true);
    expect(isExcludedCompany({ nombre: 'Multicarga del Norte' })).toBe(true);
    expect(isExcludedCompany({ cia: '00011', nombre: 'Senda' })).toBe(false);
  });
});
