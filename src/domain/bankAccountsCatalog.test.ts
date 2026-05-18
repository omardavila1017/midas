import { describe, expect, it } from 'vitest';
import {
  bankAccountBusinessUnitLabel,
  findBankAccount,
  findBankAccountByClabe,
} from './bankAccountsCatalog';

describe('bankAccountsCatalog', () => {
  // cuentaDigits mirrors the exact `Cuenta_Bancos` string the JDE /bancos API
  // returns: Banamex = 11-digit zero-padded (sucursal 4 + cuenta 7),
  // Banorte = 10-digit (leading zero), Santander = as-is. Lookups must use
  // that form because the only runtime caller (enrichMovementWithCatalog)
  // feeds the raw API value.
  it('resolves representative Federal, CITI and Multicarga accounts by API account string and CLABE', () => {
    const multicarga = findBankAccount('06787361240');
    expect(multicarga?.unidadNegocio).toBe('MULTICARGA');
    expect(bankAccountBusinessUnitLabel(multicarga?.unidadNegocio)).toBe('Multicarga');

    const citi = findBankAccountByClabe('002580701388051721');
    expect(citi?.unidadNegocio).toBe('CITI');
    expect(bankAccountBusinessUnitLabel(citi?.unidadNegocio)).toBe('Clientes Citi');

    const federal = findBankAccount('70138237069');
    expect(federal?.unidadNegocio).toBe('FEDERAL');
    expect(bankAccountBusinessUnitLabel(federal?.unidadNegocio)).toBe('Federal');
  });

  // Regression: the IMSS concentradora (STDN) shipped in the catalog with the
  // unpadded digits "877732401" and never matched the API's "00877732401",
  // so its movements fell through catalog enrichment. cuentaDigits must be
  // the zero-padded API form.
  it('matches the STDN IMSS account using the zero-padded API account number', () => {
    const imss = findBankAccount('00877732401');
    expect(imss).not.toBeNull();
    expect(imss?.razonSocial).toBe('SERVICIOS T DE N SA DE CV');
    expect(imss?.concepto).toContain('IMSS');
    expect(imss?.clabe).toBe('002580008777324018');
  });

  // Accounts that never appear in /bancos (US banks, dead "por cancelar",
  // ahorro, USD pagadoras) were filtered out of the catalog.
  it('does not contain accounts absent from the bank API', () => {
    expect(findBankAccountByClabe('072580005494776286')).toBeNull(); // INMUEBLES renta SES
    expect(findBankAccount('65503112933')).toBeNull(); // Santander caja ahorro operadores
  });
});
