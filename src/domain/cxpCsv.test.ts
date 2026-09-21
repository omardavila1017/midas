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

describe('parseCXP — las MISMAS defensas que el fetcher (dos puertas, un comportamiento)', () => {
  // La tabla origen guarda las fechas como DD-MM-YYYY y trae `nd` y
  // `dias_vencida`, así que un CSV exportado de ahí las trae igual.
  const H = 'cia,no_prov,nombre,no_factura,nd,fecha_factura,fecha_vence,dias_vencida,'
    + 'importe_pendiente_pesos,importe_bruto_pesos,por_vencer,v_1_30,moneda,edo_pago';
  const file = (...rows: string[]): string => [H, ...rows].join('\n');
  const row = (
    { factura = 'F-1', nd = '1', dias = '-86', pendiente = '1000', edo = 'A' } = {},
  ): string => `00011,P-1,ACME,${factura},${nd},14-09-2026,13-12-2026,${dias},${pendiente},${pendiente},0,0,MXP,${edo}`;

  it('normaliza DD-MM-YYYY a ISO: sin esto el CXP importado se queda sin vencimiento', () => {
    const [r] = parseCXP(file(row()));
    expect(r.fechaVence).toBe('2026-12-13');
    expect(r.fechaFactura).toBe('2026-09-14');
  });

  it('colapsa el documento repetido (CSV exportado de la tabla sin truncar)', () => {
    const records = parseCXP(file(row(), row(), row()));
    expect(records).toHaveLength(1);
    expect(records[0].importePendientePesos).toBe(1000);
  });

  it('NO colapsa dos documentos distintos que comparten folio', () => {
    const records = parseCXP(file(row({ nd: '1' }), row({ nd: '2', pendiente: '400' })));
    expect(records).toHaveLength(2);
    expect(records.reduce((a, r) => a + r.importePendientePesos, 0)).toBe(1400);
  });

  it('descarta las filas de cargas anteriores', () => {
    const records = parseCXP(file(
      row({ factura: 'VIEJA-1', nd: '1', dias: '-90' }),
      row({ factura: 'VIEJA-2', nd: '2', dias: '-90' }),
      row({ factura: 'VIVA-1', nd: '3' }),
      row({ factura: 'VIVA-2', nd: '4' }),
    ));
    expect(records.map(r => r.noFactura).sort()).toEqual(['VIVA-1', 'VIVA-2']);
  });

  it('degrada solo: una sola carga entra completa', () => {
    const records = parseCXP(file(
      row({ factura: 'F-1', nd: '1' }),
      row({ factura: 'F-2', nd: '2' }),
      row({ factura: 'F-3', nd: '3' }),
    ));
    expect(records).toHaveLength(3);
  });

  // ── El corte de snapshot va POR CÍA ──────────────────────────────────────
  //
  // El fetcher es inmune por construcción (`/antiguedadsaldos` = una cía por
  // request); el CSV es multi-cía por diseño. Medido en la BD el 2026-09-21:
  // las cías 11/01/42 sellan al 21-sep mientras 30/43/21 siguen en el 14-sep,
  // sin que nada esté corrupto. Con un corte global la cía del sello viejo se
  // descarta ENTERA y, como `replaceCxpForCias` la reemplaza, su saldo queda
  // en cero.
  it('no descarta la cía cuyo sello es más viejo que el de otra cía del archivo', () => {
    const otra = (
      { factura = 'X-1', nd = '1', dias = '-86', pendiente = '700' } = {},
    ): string => `00030,P-9,BETA,${factura},${nd},14-09-2026,13-12-2026,${dias},${pendiente},${pendiente},0,0,MXP,A`;
    const records = parseCXP(file(
      // cía 00011 al día (sello más reciente del archivo)
      row({ factura: 'A-1', nd: '1' }),
      row({ factura: 'A-2', nd: '2' }),
      // cía 00030 con un sello ANTERIOR, pero es su único snapshot
      otra({ factura: 'B-1', nd: '1', dias: '-93' }),
      otra({ factura: 'B-2', nd: '2', dias: '-93' }),
    ));
    expect(records.filter(r => r.cia === '00030').map(r => r.noFactura).sort()).toEqual(['B-1', 'B-2']);
    expect(records.filter(r => r.cia === '00011').map(r => r.noFactura).sort()).toEqual(['A-1', 'A-2']);
  });

  it('sigue descartando la carga vieja DENTRO de cada cía', () => {
    const otra = (
      { factura = 'X-1', nd = '1', dias = '-86' } = {},
    ): string => `00030,P-9,BETA,${factura},${nd},14-09-2026,13-12-2026,${dias},500,500,0,0,MXP,A`;
    const records = parseCXP(file(
      row({ factura: 'A-VIEJA-1', nd: '1', dias: '-90' }),
      row({ factura: 'A-VIEJA-2', nd: '2', dias: '-90' }),
      row({ factura: 'A-VIVA-1', nd: '3' }),
      row({ factura: 'A-VIVA-2', nd: '4' }),
      otra({ factura: 'B-VIEJA-1', nd: '1', dias: '-93' }),
      otra({ factura: 'B-VIEJA-2', nd: '2', dias: '-93' }),
      otra({ factura: 'B-VIVA-1', nd: '3', dias: '-91' }),
      otra({ factura: 'B-VIVA-2', nd: '4', dias: '-91' }),
    ));
    expect(records.map(r => r.noFactura).sort())
      .toEqual(['A-VIVA-1', 'A-VIVA-2', 'B-VIVA-1', 'B-VIVA-2']);
  });

  it('lee `nd` por los mismos alias que el mapper del API', () => {
    const H2 = 'cia,no_prov,nombre,no_factura,no_documento,fecha_factura,fecha_vence,dias_vencida,'
      + 'importe_pendiente_pesos,importe_bruto_pesos,por_vencer,v_1_30,moneda,edo_pago';
    const r = (nd: string, pend: string) =>
      `00011,P-1,ACME,F-1,${nd},14-09-2026,13-12-2026,-86,${pend},${pend},0,0,MXP,A`;
    // Dos pay-items del MISMO folio: sin el alias la llave degrada y se
    // colapsan, llevándose pasivo real.
    const records = parseCXP([H2, r('1', '1000'), r('2', '400')].join('\n'));
    expect(records).toHaveLength(2);
    expect(records.reduce((a, x) => a + x.importePendientePesos, 0)).toBe(1400);
  });
});
