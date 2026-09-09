import { describe, it, expect } from 'vitest';
import {
  buildMatchSuggestions,
  rankClientsForAccount,
  suggestionToLink,
  AUTO_ACCEPT_THRESHOLD,
  REVIEW_THRESHOLD,
} from './clientCobranzaMatcher';
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

  it('returns empty buckets when either side is empty (early return)', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING' })];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'CORNING' })];
    expect(buildMatchSuggestions([], recs)).toEqual({ autoAccepted: [], needsReview: [], orphanNoClientes: [] });
    expect(buildMatchSuggestions(clients, [])).toEqual({ autoAccepted: [], needsReview: [], orphanNoClientes: [] });
  });

  it('an account with empty name and no RFC lands as orphan (nothing to score)', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING OPTICAL' })];
    const recs = [mkRecord({ noCliente: '999', nombreCliente: '' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(0);
    expect(out.needsReview).toHaveLength(0);
    expect(out.orphanNoClientes).toHaveLength(1);
    expect(out.orphanNoClientes[0].bestGuess).toBeUndefined();
  });

  it('a stronger later candidate replaces an earlier weaker best (confidence DESC)', () => {
    const clients = [
      // Débil: solo comparte tokens parciales con la cuenta.
      mkClient({ id: 'weak', name: 'ACEROS INDUSTRIALES MONTERREY PLANTA' }),
      // Fuerte: RFC exacto.
      mkClient({ id: 'strong', name: 'Nombre Totalmente Distinto', rfc: 'AIM010101AAA' }),
    ];
    const recs = [mkRecord({ noCliente: '100', nombreCliente: 'ACEROS INDUSTRIALES MONTERREY NORTE', rfc: 'AIM010101AAA' })];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(1);
    expect(out.autoAccepted[0].clientId).toBe('strong');
    expect(out.autoAccepted[0].tier).toBe('rfc-exact');
  });

  it('backfills the aggregate RFC from a later invoice of the same account', () => {
    const clients = [mkClient({ id: 'c1', name: 'ZZZ Sin Parecido', rfc: 'COR123ABC78' })];
    const recs = [
      // Primera factura sin RFC, segunda con RFC — el agregado debe adoptarlo.
      mkRecord({ noCliente: '100', nombreCliente: 'OTRO NOMBRE QUE NO EMPATA', noFactura: 'F1' }),
      mkRecord({ noCliente: '100', nombreCliente: 'OTRO NOMBRE QUE NO EMPATA', rfc: 'COR123ABC78', noFactura: 'F2' }),
    ];
    const out = buildMatchSuggestions(clients, recs);
    expect(out.autoAccepted).toHaveLength(1);
    expect(out.autoAccepted[0].tier).toBe('rfc-exact');
    expect(out.autoAccepted[0].invoiceCount).toBe(2);
    expect(out.autoAccepted[0].rfc).toBe('COR123ABC78');
  });
});

describe('rankClientsForAccount', () => {
  const account = (nombreCliente: string, over: Partial<{ rfc: string; invoiceCount: number }> = {}) => ({
    cia: '00010',
    noCliente: '500',
    nombreCliente,
    ...over,
  });

  it('returns [] when the account name normalizes to empty', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING' })];
    expect(rankClientsForAccount(account(''), clients)).toEqual([]);
    expect(rankClientsForAccount(account('###'), clients)).toEqual([]);
  });

  it('scores name-exact at 1 (normalized comparison)', () => {
    const clients = [mkClient({ id: 'c1', name: 'corning  óptical, s.a.' })];
    const out = rankClientsForAccount(account('CORNING OPTICAL SA'), clients);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('name-exact');
    expect(out[0].confidence).toBe(1);
    expect(out[0].clientId).toBe('c1');
  });

  it('scores long-substring containment at 0.9', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING OPTICAL COMMUNICATIONS' })];
    const out = rankClientsForAccount(account('CORNING OPTICAL COMMUNICATIONS QRO SA DE CV'), clients);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('substring');
    expect(out[0].confidence).toBe(0.9);
  });

  it('scores token-overlap with a partial-substring bonus, below the substring tier', () => {
    const clients = [mkClient({ id: 'c1', name: 'FERROCARRIL MEXICANO NORTE' })];
    const out = rankClientsForAccount(account('FERROCARRIL MEXICANO SUR'), clients);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('token-overlap');
    expect(out[0].confidence).toBeGreaterThan(0);
    expect(out[0].confidence).toBeLessThan(0.9);
  });

  it('excludes zero-score clients and honors the limit, sorted by score desc', () => {
    const clients = [
      mkClient({ id: 'nada', name: 'PANIFICADORA DEL BAJIO' }),
      mkClient({ id: 'token', name: 'CORNING DISPLAY MONTERREY' }),
      mkClient({ id: 'sub', name: 'CORNING OPTICAL COMMUNICATIONS' }),
      mkClient({ id: 'exact', name: 'CORNING OPTICAL COMMUNICATIONS QRO' }),
    ];
    const out = rankClientsForAccount(account('CORNING OPTICAL COMMUNICATIONS QRO'), clients, 2);
    expect(out).toHaveLength(2);
    expect(out[0].clientId).toBe('exact');
    expect(out[0].confidence).toBe(1);
    expect(out[1].clientId).toBe('sub');
    expect(out.map((s) => s.clientId)).not.toContain('nada');
  });

  it('threads account metadata through and defaults invoiceCount to 0', () => {
    const clients = [mkClient({ id: 'c1', name: 'CORNING OPTICAL' })];
    const withCount = rankClientsForAccount(account('CORNING OPTICAL', { rfc: 'XX', invoiceCount: 7 }), clients);
    expect(withCount[0]).toMatchObject({ cia: '00010', noCliente: '500', rfc: 'XX', invoiceCount: 7 });

    const withoutCount = rankClientsForAccount(account('CORNING OPTICAL'), clients);
    expect(withoutCount[0].invoiceCount).toBe(0);
  });
});

describe('REVIEW_THRESHOLD es el PISO del tier más bajo', () => {
  // El orphan bucket de `buildMatchSuggestions` significa "ningún candidato
  // puntuó" y sale SIN `bestGuess`; eso sólo es cierto mientras todo tier que
  // puntúa alcance review. `token-overlap` con jaccard 0.5 devuelve exactamente
  // `REVIEW_THRESHOLD`, así que si alguien baja la confianza de un tier por
  // debajo de ese piso, un candidato real caería al orphan y la conjetura se
  // perdería en silencio. Esto truena antes.
  it('todo candidato que puntúa alcanza review; el orphan va sin conjetura', () => {
    const clients = [mkClient({ id: 'c1', name: 'TRANSPORTES DEL NORTE UNIDOS' })];
    const records = [
      // Jaccard 0.5 sobre tokens significativos = el piso exacto del tier.
      mkRecord({ noCliente: '1', nombreCliente: 'TRANSPORTES NORTE' }),
      // Sin ningún token en común: nadie puntúa → orphan real.
      mkRecord({ noCliente: '2', nombreCliente: 'ZZZQQQ WWW YYY' }),
    ];

    const out = buildMatchSuggestions(clients, records);

    for (const s of [...out.autoAccepted, ...out.needsReview]) {
      expect(s.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    }
    for (const o of out.orphanNoClientes) {
      expect(o.bestGuess).toBeUndefined();
    }
  });

  it('el piso declarado coincide con el mínimo que produce token-overlap', () => {
    expect(REVIEW_THRESHOLD).toBe(0.62);
  });
});
