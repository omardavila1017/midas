import { describe, expect, it } from 'vitest';
import {
  bankAccountBusinessUnitLabel,
  findBankAccount,
  findBankAccountByClabe,
} from './bankAccountsCatalog';

describe('bankAccountsCatalog', () => {
  it('resolves representative Federal, CITI and Multicarga accounts by cuenta and CLABE', () => {
    const multicarga = findBankAccount('678 7361240');
    expect(multicarga?.unidadNegocio).toBe('MULTICARGA');
    expect(bankAccountBusinessUnitLabel(multicarga?.unidadNegocio)).toBe('Multicarga');

    const citi = findBankAccountByClabe('002580701388051721');
    expect(citi?.unidadNegocio).toBe('CITI');
    expect(bankAccountBusinessUnitLabel(citi?.unidadNegocio)).toBe('Clientes Citi');

    const federal = findBankAccount('7013 8237069');
    expect(federal?.unidadNegocio).toBe('FEDERAL');
    expect(bankAccountBusinessUnitLabel(federal?.unidadNegocio)).toBe('Federal');
  });
});
