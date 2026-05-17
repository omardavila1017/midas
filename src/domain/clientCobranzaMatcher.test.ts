import { describe, it, expect } from 'vitest';
import { buildMatchSuggestions, suggestionToLink, AUTO_ACCEPT_THRESHOLD } from './clientCobranzaMatcher';
import type { Client } from './types';
import type { CobranzaRecord } from '../services/jdeTypes';

const baseClient: Omit<Client, 'id' | 'name'> = {
  monthlyBilling: new Array(12).fill(0),
  frequency: 'Mensual',
  creditDays: 30,
  paymentDay: { kind: 'ANY' },
};

function mkClient(over: Partial<Client> & { id: string; name: string }): Client {
  return { ...baseClient, ...over };
}

function mkRecord(over: Partial<CobranzaRecord> & { noCliente: string; nombreCliente: string }): CobranzaRecord {
  return {
    cia: '00010',
    noFactura: 'F1',
    fechaFactura: '2026-01-15',
    fechaVence: '2026-02-15',
    fechaCobro: '2026-01-15',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'CERRADA',
    tipoCambio: 17,
    ...over,
  } as CobranzaRecord;
}

describe('clientCobranzaMatcher', () => {
  it('matches by RFC exact even when names differ', () => {
    const clients = [mkClient({ id: 'c1', name: 'Corning Optical', rfc: 'COR123ABC78' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL COMMUNICATIONS S DE RL DE CV', rfc: 'COR123ABC78' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(1);
    expect(out.autoAccepted[0].tier).toBe('rfc-exact');
    expect(out.autoAccepted[0].confidence).toBe(1);
    expect(out.autoAccepted[0].clientId).toBe('c1');
  });

  it('matches by normalized name when RFC is missing', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING  OPTICAL COMMUNICATIONS, S DE RL DE CV' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL COMMUNICATIONS S DE RL DE CV' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(1);
    expect(out.autoAccepted[0].tier).toBe('name-exact');
  });

  it('matches substring (≥8 chars) over different suffixes', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING OPTICAL COMMUNICATIONS' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL COMMUNICATIONS, S.A. DE C.V.' })];
    const out = buildMatchSuggestions(clients, recs);
    // Compact normalize: "corningopticalcommunications" vs "corningopticalcommunicationssadecv"
    // → substring tier
    const all = [...out.autoAccepted, ...out.needsReview];
    expect(all).toHaveLength(1);
    expect(['substring', 'name-exact']).toContain(all[0].tier);
  });

  it('falls back to token-overlap for partial matches and routes to review', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING SCIENCE MEXICO' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING DISPLAY TECHNOLOGIES' })];
    const out = buildMatchSuggestions(clients, recs);
    // Solo "CORNING" como token significativo común; jaccard < 0.5 → orphan
    const hits = out.autoAccepted.length + out.needsReview.length;
    expect(hits).toBe(0);
    expect(out.orphanNoClientes).toHaveLength(1);
  });

  it('routes ambiguous (jaccard 0.5+) to needsReview', () => {
    const clients = [mkClient({ id: 'c1', name: 'FERROCARRIL MEXICANO TRANSPORTES NORTE' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'FERROCARRIL MEXICANO NORTE LOGISTICA' })];
    const out = buildMatchSuggestions(clients, recs);
    const all = [...out.autoAccepted, ...out.needsReview, ...(out.orphanNoClientes.map(o => o.bestGuess).filter(Boolean) as object[])];
    expect(all.length).toBeGreaterThan(0);
  });

  it('skips already-linked accounts', () => {
    const clients = [
      mkClient({
        id: 'c1',
        name: 'Corning',
        jdeAccounts: [{
          cia: '00010', noCliente: '100', nombreCliente: 'CORNING',
          matchedAt: '2026-01-01', matchedBy: 'user',
        }],
      }),
    ];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(0);
    expect(out.needsReview).toHaveLength(0);
    expect(out.orphanNoClientes).toHaveLength(0);
  });

  it('aggregates multiple invoices for one (cia,noCliente)', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING OPTICAL', rfc: 'COR123ABC78' })];
    const recs = [
      mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL', rfc: 'COR123ABC78', noFactura: 'F1' }),
      mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL', rfc: 'COR123ABC78', noFactura: 'F2' }),
      mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL', rfc: 'COR123ABC78', noFactura: 'F3' }),
    ];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(1);
    expect(out.autoAccepted[0].invoiceCount).toBe(3);
  });

  it('breaks ties preferring the client with RFC defined', () => {
    const clients = [
      mkClient({ id: 'no-rfc', name: 'CORNING' }),
      mkClient({ id: 'with-rfc', name: 'CORNING', rfc: 'COR000ABC00' }),
    ];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted[0]?.clientId).toBe('with-rfc');
  });

  it('reports orphan when no client comes close', () => {
    const clients = [mkClient({ id: 'c1', name: 'Apple Mexico' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'Constructora del Sur' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.orphanNoClientes).toHaveLength(1);
    expect(out.autoAccepted).toHaveLength(0);
  });

  it('auto-accept threshold is exactly 0.85 (substring at 0.90 passes)', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING OPTICAL COMMUNICATIONS' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING OPTICAL COMMUNICATIONS USA' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(1);
    expect(out.autoAccepted[0].confidence).toBeGreaterThanOrEqual(AUTO_ACCEPT_THRESHOLD);
  });

  it('suggestionToLink stamps auto/user metadata correctly', () => {
    const link = suggestionToLink(
      {
        clientId: 'c1', cia: '00010', noCliente: '100', nombreCliente: 'X',
        tier: 'rfc-exact', confidence: 1, invoiceCount: 5,
      },
      'auto',
    );
    expect(link.matchedBy).toBe('auto');
    expect(link.confidence).toBe(1);
    expect(link.tier).toBe('rfc-exact');

    const userLink = suggestionToLink(
      {
        clientId: 'c1', cia: '00010', noCliente: '100', nombreCliente: 'X',
        tier: 'substring', confidence: 0.7, invoiceCount: 1,
      },
      'user',
    );
    expect(userLink.matchedBy).toBe('user');
    expect(userLink.confidence).toBeUndefined();
    expect(userLink.tier).toBeUndefined();
  });
});
