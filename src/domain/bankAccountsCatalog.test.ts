import { describe, expect, it } from 'vitest';
import {
  bankAccountBusinessUnitLabel,
  findBankAccount,
  findBankAccountByClabe,
  findBankAccountByCuenta,
  BANK_ACCOUNTS,
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

  // v1.3: two BANAMEX FEDERAL accounts that /bancos returns but were absent
  // from the catalog (showed "SIN CATÁLOGO"). Match by the exact 11-digit API
  // form and by CLABE.
  it('matches the v1.3 BANAMEX additions (Oficios y Proyectos / Tamaulipas FONDO GARANTIA)', () => {
    const oficios = findBankAccount('70140350859');
    expect(oficios).not.toBeNull();
    expect(oficios?.razonSocial).toBe('Oficios y Proyectos en Rec Clas de Per');
    expect(oficios?.concepto).toBe('POR CANCELAR / CPAE');
    expect(oficios?.role).toBe('por_cancelar');
    expect(oficios?.flow).toBe('neutro');
    expect(findBankAccountByClabe('002580701403508599')?.razonSocial).toBe(
      'Oficios y Proyectos en Rec Clas de Per',
    );

    const garantia = findBankAccount('70138237077');
    expect(garantia).not.toBeNull();
    expect(garantia?.razonSocial).toBe('TRANSPORTES TAMAULIPAS SA DE CV');
    expect(garantia?.concepto).toBe('FONDO GARANTIA SCT');
    expect(garantia?.role).toBe('garantia');
    expect(garantia?.flow).toBe('neutro');
    expect(findBankAccountByClabe('002580701382370770')?.concepto).toBe(
      'FONDO GARANTIA SCT',
    );
  });

  // El API entrega la cuenta con su longitud natural sin padding
  // ("BANAMEX - 7014 350840" → "7014350840"), pero varios cuentaDigits del
  // catálogo quedaron rellenos con ceros fantasma (v1.2). El cruce por la
  // forma de display `cuenta` (sin padding) los resuelve sin reescribir datos.
  it('resuelve por la forma de display cuando cuentaDigits está sobre-rellenado', () => {
    const entry = BANK_ACCOUNTS.find(a => a.cuenta === '7014 350840');
    expect(entry).toBeTruthy();
    expect(entry!.cuentaDigits).toBe('70140350840'); // forma rellenada (no cruza tal cual)
    const apiDigits = '7014350840'; // lo que realmente manda /bancos
    expect(apiDigits).not.toBe(entry!.cuentaDigits);
    expect(findBankAccountByCuenta(apiDigits)?.razonSocial).toBe(entry!.razonSocial);
    expect(findBankAccount(apiDigits)?.cuenta).toBe('7014 350840');
  });

  // v1.4: BANBAJIO es un centinela sin dígitos (mapBankLine colapsa todas las
  // líneas de Bajío a cuenta="BANBAJIO"). Debe cruzar por token textual.
  it('resuelve el centinela BANBAJIO (FIDEICOMISO DINA) por token', () => {
    const bajio = findBankAccount('BANBAJIO');
    expect(bajio).not.toBeNull();
    expect(bajio?.razonSocial).toBe('SERVICIO INDUSTRIAL REGIOMONTANO SA DE CV');
    expect(bajio?.concepto).toBe('FIDEICOMISO DINA');
    expect(bajio?.unidadNegocio).toBe('CITI');
    expect(findBankAccountByCuenta('banbajio')?.concepto).toBe('FIDEICOMISO DINA');
    // El centinela no contamina los lookups numéricos.
    expect(findBankAccount('70138237069')?.unidadNegocio).toBe('FEDERAL');
  });

  // Accounts that never appear in /bancos (US banks, dead "por cancelar",
  // ahorro, USD pagadoras) were filtered out of the catalog.
  it('does not contain accounts absent from the bank API', () => {
    expect(findBankAccountByClabe('072580005494776286')).toBeNull(); // INMUEBLES renta SES
    expect(findBankAccount('65503112933')).toBeNull(); // Santander caja ahorro operadores
  });
});

// Item 4/10: JDE /bancos Cuenta_Bancos arrives with bank-specific zero
// padding. When the API form doesn't byte-match the catalog cuentaDigits the
// exact lookup missed and the movement fell to "sin catálogo". The fallback
// tolerates leading-zero differences, but only for keys that stay unique.
describe('bankAccountsCatalog — padding-tolerant lookup', () => {
  const padded = BANK_ACCOUNTS.find(
    a => a.cuentaDigits && a.cuentaDigits.startsWith('0'),
  );

  it('still resolves the exact zero-padded form', () => {
    expect(padded).toBeTruthy();
    expect(findBankAccountByCuenta(padded!.cuentaDigits)?.cuentaDigits).toBe(
      padded!.cuentaDigits,
    );
  });

  it('resolves the unpadded API form to the same account', () => {
    const unpadded = padded!.cuentaDigits.replace(/^0+/, '');
    expect(unpadded).not.toBe(padded!.cuentaDigits);
    expect(findBankAccountByCuenta(unpadded)?.cuentaDigits).toBe(
      padded!.cuentaDigits,
    );
    // findBankAccount shares the tolerant path
    expect(findBankAccount(unpadded)?.cuentaDigits).toBe(padded!.cuentaDigits);
  });

  it('Senda Servicios Financieros resolves — RESERVA/neutro by design, not a data gap', () => {
    const ssf = BANK_ACCOUNTS.find(a => /servicios financieros/i.test(a.razonSocial));
    expect(ssf).toBeTruthy();
    expect(ssf!.flow).toBe('neutro');
    expect(findBankAccountByCuenta(ssf!.cuentaDigits)?.razonSocial).toBe(
      ssf!.razonSocial,
    );
  });
});
