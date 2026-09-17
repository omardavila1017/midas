import { describe, expect, it } from 'vitest';
import { parseCSVLine, parseCXP, parseNum } from './cxpCsv';

const HEADERS =
  'cia,no_prov,nombre,no_factura,fecha_factura,fecha_vence,importe_pendiente_pesos,importe_bruto_pesos,por_vencer,v_1_30,moneda';

function csv(...rows: string[]): string {
  return [HEADERS, ...rows].join('\n');
}

describe('parseCSVLine', () => {
  it('splits on commas outside quotes and preserves commas inside', () => {
    expect(parseCSVLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes and trims fields', () => {
    expect(parseCSVLine('"dijo ""hola""" ,  x ')).toEqual(['dijo "hola"', 'x']);
  });
});

describe('parseNum', () => {
  it('strips thousand separators and quotes', () => {
    expect(parseNum('"1,234,567.89"')).toBe(1234567.89);
  });

  it('returns 0 for empty or non-numeric input', () => {
    expect(parseNum('')).toBe(0);
    expect(parseNum('   ')).toBe(0);
    expect(parseNum('N/A')).toBe(0);
  });
});

describe('parseCXP', () => {
  it('parses rows and normalizes cia like the JDE fetchers ("150" → "00150")', () => {
    const records = parseCXP(
      csv('150,P001,ACME SA,F-1,2026-01-01,2026-02-01,"1,500.50",2000,1500.50,0,MXP'),
    );
    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({
      cia: '00150',
      noProveedor: 'P001',
      nombre: 'ACME SA',
      importePendientePesos: 1500.5,
      importeBrutoPesos: 2000,
      porVencer: 1500.5,
      moneda: 'MXP',
    });
  });

  it('handles \\r\\n line endings and quoted names with commas', () => {
    const records = parseCXP(
      csv('33,P2,"TRANSPORTES, SA DE CV",F-2,2026-01-05,2026-02-05,100,100,100,0,MXP').replace(
        /\n/g,
        '\r\n',
      ),
    );
    expect(records[0].cia).toBe('00033');
    expect(records[0].nombre).toBe('TRANSPORTES, SA DE CV');
  });

  it('skips rows with too few columns but keeps valid ones', () => {
    const records = parseCXP(
      csv('solo,tres,campos', '150,P1,OK SA,F-9,2026-01-01,2026-02-01,50,50,50,0,MXP'),
    );
    expect(records.length).toBe(1);
    expect(records[0].nombre).toBe('OK SA');
  });

  it('defaults missing optional columns to empty string / 0', () => {
    const [rec] = parseCXP(csv('150,P1,ACME,F-1,2026-01-01,2026-02-01,10,10,10,0,MXP'));
    expect(rec.clasificacionProveedor).toBe('');
    expect(rec.tipoCambio).toBe(0);
    expect(rec.mas180).toBe(0);
  });

  it('throws on empty CSV, missing required columns and zero valid rows', () => {
    expect(() => parseCXP('')).toThrow('CSV vacío');
    expect(() => parseCXP('cia,nombre\n1,x')).toThrow(/Columnas faltantes/);
    expect(() => parseCXP(csv('a,b'))).toThrow(/No se encontraron registros válidos/);
  });

  it('matches header names case-insensitively', () => {
    const upper = csv('150,P1,ACME,F-1,2026-01-01,2026-02-01,10,10,10,0,MXP').replace(
      HEADERS,
      HEADERS.toUpperCase(),
    );
    expect(parseCXP(upper)[0].cia).toBe('00150');
  });
});

describe('parseCXP — el documento PAGADO no es pasivo (misma regla que el fetcher)', () => {
  const H = `${HEADERS},edo_pago`;
  // cia,no_prov,nombre,no_factura,fecha_factura,fecha_vence,pend,bruto,por_vencer,v_1_30,moneda,edo_pago
  const doc = (...rows: string[]) => [H, ...rows].join('\n');

  it('descarta las filas PAGADAS de un CSV exportado de la tabla envenenada', () => {
    // Sin esto, el mismo documento se comporta distinto según la puerta por la
    // que entró: el fetcher lo descarta y el import manual lo reintroduce.
    const records = parseCXP(doc(
      '11,P1,ACME,F-VIVA,2026-01-01,2026-02-01,137.5,200,0,0,MXP,A',
      '11,P2,BETA,F-PAGADA,2025-01-01,2025-02-01,3056.1,3056.1,0,0,MXP,P',
      '11,P3,GAMA,F-PAGADA2,2025-01-01,2025-02-01,999,999,0,0,MXP,PAGADO',
    ));
    expect(records.map((r) => r.noFactura)).toEqual(['F-VIVA']);
  });

  it('match EXACTO: "POR PAGAR" y "NO PAGADO" sobreviven', () => {
    const records = parseCXP(doc(
      '11,P1,A,F-1,2026-01-01,2026-02-01,500,500,0,0,MXP,POR PAGAR',
      '11,P2,B,F-2,2026-01-01,2026-02-01,700,700,0,0,MXP,NO PAGADO',
      '11,P3,C,F-3,2026-01-01,2026-02-01,300,300,0,0,MXP,H',
    ));
    expect(records.reduce((a, r) => a + r.importePendientePesos, 0)).toBe(1500);
  });

  it('un CSV sólo de pagados falla con un mensaje que dice POR QUÉ', () => {
    // Silenciar esto dejaría al usuario con un import "exitoso" de 0 registros
    // que además REEMPLAZA las cías del archivo (replaceCxpForCias).
    expect(() => parseCXP(doc('11,P1,A,F-1,2025-01-01,2025-02-01,100,100,0,0,MXP,P')))
      .toThrow(/sólo trae documentos ya PAGADOS/);
  });

  it('degrada solo: un CSV sin columna edo_pago pasa intacto', () => {
    const records = parseCXP(csv(
      '11,P1,A,F-1,2026-01-01,2026-02-01,100,100,0,0,MXP',
      '11,P2,B,F-2,2026-01-01,2026-02-01,200,200,0,0,MXP',
    ));
    expect(records).toHaveLength(2);
  });
});
