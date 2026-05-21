import { describe, it, expect } from 'vitest';
import { classifyBankConcept } from './bankConceptClassifier';

describe('classifyBankConcept', () => {
  it('clasifica IVA a TAX', () => {
    expect(classifyBankConcept({ concepto: 'PAGO IVA MAYO' }).counterpartyName).toBe('SAT — IVA');
    expect(classifyBankConcept({ concepto: 'PAGO IVA MAYO' }).category).toBe('TAX');
  });

  it('clasifica ISR a TAX', () => {
    expect(classifyBankConcept({ infAdi2: 'PAGO ISR RETENCIONES' }).counterpartyName).toBe('SAT — ISR');
  });

  it('clasifica IEPS antes que SAT genérico', () => {
    const result = classifyBankConcept({ concepto: 'PAGO SAT IEPS' });
    expect(result.subcategory).toBe('IEPS');
  });

  it('clasifica IMSS', () => {
    expect(classifyBankConcept({ concepto: 'PAGO IMSS BIMESTRAL' }).counterpartyName).toBe('IMSS');
    expect(classifyBankConcept({ concepto: 'SEGURO SOCIAL' }).counterpartyName).toBe('IMSS');
  });

  it('clasifica INFONAVIT', () => {
    expect(classifyBankConcept({ infAdi1: 'INFONAVIT' }).counterpartyName).toBe('INFONAVIT');
  });

  it('clasifica comisiones a OPEX', () => {
    const r = classifyBankConcept({ concepto: 'COMISION POR MANEJO DE CUENTA' });
    expect(r.category).toBe('OPEX');
    expect(r.counterpartyName).toBe('Comisiones bancarias');
  });

  it('clasifica intereses a OPEX', () => {
    expect(classifyBankConcept({ concepto: 'INTERES PRESTAMO' }).counterpartyName).toBe('Intereses bancarios');
  });

  it('no empata IVA dentro de palabra (SERVIVA)', () => {
    const r = classifyBankConcept({ concepto: 'PAGO SERVIVA SA' });
    expect(r.counterpartyName).toBe('Sin identificar');
  });

  it('folio JDE crudo cae en Sin identificar', () => {
    const r = classifyBankConcept({ infAdi1: '342?20/EI/0977251' });
    expect(r.category).toBe('TRANSFER');
    expect(r.counterpartyName).toBe('Sin identificar');
  });

  it('combina concepto + infAdi para clasificar', () => {
    const r = classifyBankConcept({
      concepto: '342?20/EI/0977251',
      infAdi2: 'PAGO IVA MAYO 2026',
    });
    expect(r.subcategory).toBe('IVA');
  });

  it('campos vacíos → Sin identificar', () => {
    expect(classifyBankConcept({}).counterpartyName).toBe('Sin identificar');
  });

  it('clasifica cargos bancarios sin la palabra COMISION', () => {
    for (const c of [
      'MANEJO DE CUENTA',
      'MANEJO CTA EMPRESARIAL',
      'ANUALIDAD TARJETA EMPRESARIAL',
      'CARGO POR SERVICIO',
      'CARGO POR SERVICIOS BANCARIOS',
      'CHEQUE DEVUELTO',
      'REPOSICION DE TARJETA',
      'MEMBRESIA ANUAL',
      'COMIS SPEI',
    ]) {
      const r = classifyBankConcept({ concepto: c });
      expect(r.category, c).toBe('OPEX');
      expect(r.counterpartyName, c).toBe('Comisiones bancarias');
    }
  });

  it('IVA sobre comisión → Comisiones bancarias, no SAT — IVA', () => {
    const r = classifyBankConcept({ concepto: 'IVA COMISION SPEI' });
    expect(r.category).toBe('OPEX');
    expect(r.counterpartyName).toBe('Comisiones bancarias');
    expect(classifyBankConcept({ concepto: 'IVA POR MANEJO DE CUENTA' }).counterpartyName)
      .toBe('Comisiones bancarias');
  });

  it('IVA fiscal sin comisión sigue siendo SAT — IVA', () => {
    expect(classifyBankConcept({ concepto: 'PAGO IVA MAYO' }).counterpartyName).toBe('SAT — IVA');
  });

  it('no confunde ANUALIDAD de seguro con comisión', () => {
    expect(classifyBankConcept({ concepto: 'ANUALIDAD SEGURO FLOTILLA' }).counterpartyName)
      .toBe('Sin identificar');
  });
});
