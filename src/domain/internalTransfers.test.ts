import { describe, it, expect } from 'vitest';
import {
  isInternalTransfer,
  isInternalCounterparty,
  isInternalProviderClassification,
  classifyMovement,
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  movementHashKey,
  computeBankOnlyCashFlow,
} from './netCashFlowEngine';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

function mov(partial: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: partial.cia ?? '00011',
    banco: partial.banco ?? '002',
    cuenta: partial.cuenta ?? '0190047839',
    moneda: partial.moneda ?? 'MXN',
    fechaOperacion: partial.fechaOperacion ?? '2026-04-22',
    referencia: partial.referencia ?? 'REF1',
    concepto: partial.concepto ?? 'Concepto genérico',
    tipoMovimiento: partial.tipoMovimiento ?? 'CARGO',
    importe: partial.importe ?? 1000,
    fechaValor: partial.fechaValor,
    saldo: partial.saldo,
  };
}

function acc(cia: string, cuenta: string, mvs: BankStatementLine[]): BankAccountStatement {
  return {
    cia,
    banco: '002',
    cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-22',
    movimientos: mvs.map(m => ({ ...m, cia, cuenta })),
  };
}

describe('classifyMovement — backwards compatible with isInternalTransfer', () => {
  it('returns "real" for unrelated bank movements', () => {
    const m = mov({ concepto: 'PAGO PROVEEDOR ACME', referencia: 'F-001' });
    expect(classifyMovement(m).kind).toBe('real');
    expect(isInternalTransfer(m)).toBe(false);
  });

  it('detects "TRASPASO REF" legend', () => {
    const m = mov({ concepto: 'TRASPASO REF 123', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend');
  });

  it('detects "TRASLADO" legend without REF (extended)', () => {
    const m = mov({ concepto: 'TRASLADO ENTRE CUENTAS', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend-extended');
  });

  it('detects "INTERCIAS" abbreviation', () => {
    const m = mov({ concepto: 'PAGO INTERCIAS NOVIEMBRE', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend-extended');
  });

  it('detects "INTERCIA" singular', () => {
    const m = mov({ concepto: 'MOVIMIENTO INTERCIA', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend-extended');
  });

  it('detects "ENTRE CIAS" multi-word', () => {
    const m = mov({ concepto: 'MOV ENTRE CIAS DEL GRUPO', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend-extended');
  });

  it('detects "ENTRE EMPRESAS" multi-word', () => {
    const m = mov({ concepto: 'TRANSFERENCIA ENTRE EMPRESAS', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend-extended');
  });

  it('extended pattern does NOT match unrelated tokens (TRANSPORTAR, SERVIVA, INTERCAMBIO)', () => {
    // "TRANSPORTAR" includes "TRA" but not the regex literal patterns.
    expect(classifyMovement(mov({ concepto: 'TRANSPORTAR MERCANCIA', referencia: '' })).kind).toBe('real');
    expect(classifyMovement(mov({ concepto: 'PAGO SERVIVA SUPERMERCADO', referencia: '' })).kind).toBe('real');
    // "INTERCAMBIO" contains "INTERCA" prefix but NOT word "INTERCIA"/"INTERCIAS".
    expect(classifyMovement(mov({ concepto: 'INTERCAMBIO COMERCIAL', referencia: '' })).kind).toBe('real');
  });

  it('detects own-RFC inside concepto', () => {
    const m = mov({ concepto: 'TRCC AL R.F.C. TTA4906038F4', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('rfc');
  });

  it('detects own-beneficiary inside concepto', () => {
    const m = mov({ concepto: 'BCO 002 BENEF TRANSPORTES TAMAULIP', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
  });

  it('detecta sigla corta TRCC como beneficiario interno', () => {
    // Concepto completo es "TRCC" (código empresa del grupo).
    const m = mov({ concepto: 'TRCC', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
    expect(isInternalTransfer(m)).toBe(true);
  });

  it('detecta sigla corta TRTT como beneficiario interno', () => {
    const m = mov({ concepto: 'PAGO TRTT', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
    expect(isInternalTransfer(m)).toBe(true);
  });

  it('word boundary: NO matchea substrings accidentales con TRCC/TRTT', () => {
    // Si apareciera una palabra que contiene "TRCC" sin ser la sigla, no
    // debe clasificarse como interno. Ejemplo sintético.
    const m1 = mov({ concepto: 'SUBATTRCCX SA DE CV', referencia: '' });
    expect(classifyMovement(m1).kind).toBe('real');
    expect(isInternalTransfer(m1)).toBe(false);

    const m2 = mov({ concepto: 'ATTRTTX PROVEEDOR', referencia: '' });
    expect(classifyMovement(m2).kind).toBe('real');
    expect(isInternalTransfer(m2)).toBe(false);
  });

  it('NO clasifica ORDEN DE ABONO como interno (cobro legítimo)', () => {
    // El ejemplo real que antes se nos coló: una cuenta Concentradora no
    // convierte un cobro legítimo en traspaso interno.
    const m = mov({ concepto: 'ORDEN DE ABONO', referencia: '', importe: 113123.76 });
    const c = classifyMovement(m);
    expect(c.kind).toBe('real');
    expect(isInternalTransfer(m)).toBe(false);
  });

  it('NO clasifica pagos normales "BANORTE · Pagadora" como internos por sí solos', () => {
    // Una cuenta Pagadora normal — el concepto sí indicaría si es interno;
    // en este caso el concepto es genérico, así que debe ser real.
    const m = mov({ concepto: 'PAGO PROVEEDOR X', referencia: '' });
    expect(classifyMovement(m).kind).toBe('real');
  });

  it('detects another own-account number in concepto via own-account detector', () => {
    const ownAccounts = new Set(['0190047839', '0190099999']);
    const detector = buildOwnAccountDetector(ownAccounts);
    // CARGO en cuenta A que menciona la cuenta B (ambas del grupo).
    const m = mov({ cuenta: '0190047839', concepto: 'PAGO A CTA 0190099999', referencia: '' });
    const c = classifyMovement(m, { ownAccountDetector: detector });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });
});

describe('buildPairMatchedKeys', () => {
  it('marks a clean 1-to-1 pair (CARGO+ABONO same day, same amount, same cia, different cuentas)', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'salida' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'entrada' }),
      ]),
    ];
    const keys = buildPairMatchedKeys(stmts);
    expect(keys.size).toBe(2);
    const cargoKey = movementHashKey('00011', '0190000001', stmts[0].movimientos[0]);
    const abonoKey = movementHashKey('00011', '0190000002', stmts[1].movimientos[0]);
    expect(keys.has(cargoKey)).toBe(true);
    expect(keys.has(abonoKey)).toBe(true);
  });

  it('does NOT pair when amounts match but cuenta is the same (could be misclassification)', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('PAIRS across different cias when amount/day match (traspaso entre empresas del grupo)', () => {
    // Todas las cuentas en `statements` pertenecen al grupo, así que un
    // traspaso entre dos cias del mismo grupo es interno aunque las cias
    // sean distintas.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
      acc('00022', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(2);
  });

  it('PAIRS N-a-N cuando hay K CARGOs y K ABONOs del mismo monto/día en cuentas distintas', () => {
    // Mismo día y mismo monto pero dos traspasos legítimos: 2 CARGOs en
    // cuentas distintas + 2 ABONOs en cuentas distintas, sin solapamiento
    // entre lados. Antes este caso se descartaba (cardinalidad != 2);
    // ahora se marcan los 4.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R2' }),
      ]),
      acc('00011', '0190000003', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R3' }),
      ]),
      acc('00011', '0190000004', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R4' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(4);
  });

  it('parea greedy a través de cuentas distintas cuando ambos lados aparecen en las mismas cuentas', () => {
    // Cuenta A tiene CARGO+ABONO y cuenta B tiene CARGO+ABONO del mismo
    // monto/día. Greedy aparea cargo01↔abono02 y cargo02↔abono01 — los 4
    // se marcan como pair-matched (cada par cruza cuentas distintas).
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R2' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R3' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R4' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(4);
  });

  it('parea min(K,N) en buckets asimétricos (2 CARGOs + 1 ABONO → marca 1 par)', () => {
    // Asimetría permitida: parea min(K,N)=1 par cruzando cuentas distintas.
    // El CARGO sobrante queda como real.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R2' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R3' }),
      ]),
    ];
    // Sólo se marcan 2 keys (el par) — el otro CARGO queda real.
    expect(buildPairMatchedKeys(stmts).size).toBe(2);
  });

  it('does NOT pair when both movements are CARGO (no symmetry)', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('PAIRS across days within the window (traspaso que liquida en T+1)', () => {
    // CARGO el viernes, ABONO gemelo el lunes (desfase de liquidación SPEI /
    // fin de semana). Mismo importe, cuentas distintas → traspaso interno.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, fechaOperacion: '2026-04-17' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, fechaOperacion: '2026-04-20' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(2);
  });

  it('does NOT pair when the day gap exceeds the window', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, fechaOperacion: '2026-04-10' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, fechaOperacion: '2026-04-20' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('prefers the same-day ABONO over a near-day one when both are available', () => {
    // Un CARGO con dos ABONOs candidatos: uno el mismo día, otro a 2 días.
    // El pareo debe consumir el del mismo día (match óptimo, distancia 0).
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, fechaOperacion: '2026-04-20', referencia: 'C1' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, fechaOperacion: '2026-04-20', referencia: 'A_SAMEDAY' }),
      ]),
      acc('00011', '0190000003', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, fechaOperacion: '2026-04-22', referencia: 'A_NEAR' }),
      ]),
    ];
    const keys = buildPairMatchedKeys(stmts);
    expect(keys.size).toBe(2);
    const sameDayKey = movementHashKey('00011', '0190000002', stmts[1].movimientos[0]);
    const nearKey = movementHashKey('00011', '0190000003', stmts[2].movimientos[0]);
    expect(keys.has(sameDayKey)).toBe(true);
    expect(keys.has(nearKey)).toBe(false);
  });

  it('classifyMovement reports "pair-matched" when key is in pairedKeys', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'pago genérico' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'depósito genérico' }),
      ]),
    ];
    const pairedKeys = buildPairMatchedKeys(stmts);
    const cargo = stmts[0].movimientos[0];
    const c = classifyMovement(cargo, { pairedKeys }, '00011', '0190000001');
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('pair-matched');
  });

  it('priority: legend wins over pair-matched even if both apply', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'TRASPASO REF 999' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'TRASPASO REF 999' }),
      ]),
    ];
    const pairedKeys = buildPairMatchedKeys(stmts);
    const cargo = stmts[0].movimientos[0];
    const c = classifyMovement(cargo, { pairedKeys }, '00011', '0190000001');
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend');
  });
});

describe('computeBankOnlyCashFlow exposes internal buckets and excludes them from totals', () => {
  it('returns internalAbonos/internalCargos buckets, and net excludes them', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        // Real outflow
        mov({ tipoMovimiento: 'CARGO', importe: 100, concepto: 'pago real' }),
        // Pair-matched outflow
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'mov interno A' }),
      ]),
      acc('00011', '0190000002', [
        // Pair-matched inflow
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'mov interno B' }),
        // Real inflow
        mov({ tipoMovimiento: 'ABONO', importe: 500, concepto: 'cobro real' }),
      ]),
    ];
    const result = computeBankOnlyCashFlow(stmts, 2026, 0);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0].inflows).toBe(500);
    expect(result.daily[0].outflows).toBe(100);
    expect(result.daily[0].net).toBe(400);

    expect(result.internalAbonosByDate.get('2026-04-22')?.length).toBe(1);
    expect(result.internalCargosByDate.get('2026-04-22')?.length).toBe(1);
    const internalAb = result.internalAbonosByDate.get('2026-04-22')![0];
    expect(internalAb.kind).toBe('internal');
    expect(internalAb.internalReason).toBe('pair-matched');
  });
});

describe('buildOwnAccountsIndex (sanity)', () => {
  it('only indexes accounts with length >= 6 chars', () => {
    const idx = buildOwnAccountsIndex([
      acc('00011', '12345', []),       // muy corta — descartada
      acc('00011', '019004780', []),   // ok
    ]);
    expect(idx.has('019004780')).toBe(true);
    expect(idx.has('12345')).toBe(false);
  });
});

describe('buildOwnAccountsIndex — catálogo estático de cuentas del grupo', () => {
  it('incluye dígitos y CLABE del catálogo aunque no haya estados de cuenta cargados', () => {
    const idx = buildOwnAccountsIndex([]);
    // BANAMEX "PAGADORA - PROVEEDORES CM" (SERVICIOS ESPECIALIZADOS SENDA).
    expect(idx.has('70138199310')).toBe(true);
    expect(idx.has('002580701381993103')).toBe(true); // su CLABE
    // BANORTE "PAGADORA CM" — forma con y sin cero a la izquierda.
    expect(idx.has('0120022571')).toBe(true);
    expect(idx.has('120022571')).toBe(true);
  });

  it('detecta traspaso a cuenta del grupo SIN estado de cuenta cargado (CLABE destino en concepto)', () => {
    // Caso raíz del bug "traspasos internos disfrazados de Proveedores sin
    // categoría": el SPEI saliente de una pagadora referencia la CLABE de
    // otra cuenta del grupo, pero esa cuenta no tiene estado de cuenta
    // cargado, así que el índice derivado de bankStatements no la conocía.
    const detector = buildOwnAccountDetector(buildOwnAccountsIndex([]));
    const m = mov({
      cuenta: '0190047839',
      concepto: 'SPEI ENVIADO CLABE 002580701381993103 FOLIO 991',
      referencia: '',
    });
    const c = classifyMovement(m, { ownAccountDetector: detector });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });

  it('detecta traspaso cuando el concepto menciona el número de cuenta de catálogo', () => {
    const detector = buildOwnAccountDetector(buildOwnAccountsIndex([]));
    const m = mov({ cuenta: '0190047839', concepto: 'ENVIO A CTA 70141027881', referencia: '' });
    const c = classifyMovement(m, { ownAccountDetector: detector });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });

  it('NO marca interno cuando el concepto sólo imprime la CLABE de la PROPIA cuenta (SPEI real entrante)', () => {
    // Un SPEI real de un tercero imprime la CLABE beneficiaria — la propia.
    // La auto-exclusión por estructura de CLABE evita el falso positivo.
    const detector = buildOwnAccountDetector(buildOwnAccountsIndex([]));
    const m = mov({
      cuenta: '70138199310',
      tipoMovimiento: 'ABONO',
      concepto: 'DEPOSITO CUENTA CLABE 002580701381993103 DE ACME EXTERIORES SA',
      referencia: '',
    });
    expect(classifyMovement(m, { ownAccountDetector: detector }).kind).toBe('real');
  });

  it('NO marca interno por los dígitos de la propia cuenta con padding distinto', () => {
    const detector = buildOwnAccountDetector(buildOwnAccountsIndex([]));
    // La cuenta llega del API sin el cero inicial; el concepto la repite
    // con el padding del catálogo. Sigue siendo la MISMA cuenta.
    const m = mov({ cuenta: '120022571', concepto: 'COMISION MANEJO CTA 0120022571', referencia: '' });
    expect(classifyMovement(m, { ownAccountDetector: detector }).kind).toBe('real');
  });
});

describe('INTERNAL_BENEFICIARIES — razones sociales del grupo (catálogo de cuentas)', () => {
  it('detecta beneficiario TURIMEX DEL NORTE', () => {
    const m = mov({ concepto: 'BCO 002 BENEF TURIMEX DEL NORTE SA DE CV', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
  });

  it('detecta beneficiario truncado SERVICIO INDUSTRIAL REGIOMONT', () => {
    const m = mov({ concepto: 'PAGO CTA TERCERO SERVICIO INDUSTRIAL REGIOMONT', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
  });

  it('NO atrapa proveedores externos con nombres parecidos', () => {
    expect(classifyMovement(mov({ concepto: 'PAGO SERVICIOS INDUSTRIALES DEL BAJIO SA', referencia: '' })).kind).toBe('real');
    expect(classifyMovement(mov({ concepto: 'MULTISERVICIOS SA DE CV', referencia: '' })).kind).toBe('real');
  });

  it('detecta MULTICARGA aunque el banco omita el "SA" al truncar', () => {
    expect(classifyMovement(mov({ concepto: 'BCO 002 BENEF MULTICARGA', referencia: '' })).kind).toBe('internal');
    // El nombre del proveedor JDE llega como "MULTICARGA" a secas.
    expect(isInternalCounterparty(undefined, 'MULTICARGA')).toBe(true);
    // "MULTISERVICIOS" sigue sin colisionar con el fragmento "MULTICARGA".
    expect(isInternalCounterparty(undefined, 'MULTISERVICIOS DEL NORTE')).toBe(false);
  });
});

describe('isInternalProviderClassification — clasificación JDE intra-grupo', () => {
  it('marca "Filiales"/intercompañía como interno', () => {
    expect(isInternalProviderClassification('Filiales')).toBe(true);
    expect(isInternalProviderClassification('FILIAL')).toBe(true);
    expect(isInternalProviderClassification('Intercompañía')).toBe(true);
    expect(isInternalProviderClassification('Inter Cia')).toBe(true);
    expect(isInternalProviderClassification('INTERCIAS')).toBe(true);
  });

  it('NO marca clasificaciones de proveedores externos', () => {
    expect(isInternalProviderClassification('REFACCIONARIO')).toBe(false);
    expect(isInternalProviderClassification('COMBUSTIBLE')).toBe(false);
    expect(isInternalProviderClassification('Servicios')).toBe(false);
    expect(isInternalProviderClassification(undefined)).toBe(false);
    expect(isInternalProviderClassification('')).toBe(false);
  });
});

describe('Campos InF_ADI — cuenta destino del traspaso fuera del concepto', () => {
  // Caso raíz del bug "Sin identificar · BANAMEX <pagadora CM>" en Planeación:
  // InF_ADI_1 trae una leyenda limpia ("PAGO A TERCEROS") que parseConcepto
  // adopta como concepto, e InF_ADI_2 — que el detector NO escaneaba — trae el
  // detalle real "P589  00877732401 a 7013870885 1 SERVICIOS T DE N?21 …" con
  // la cuenta DESTINO del grupo troceada por espacios de ancho fijo.
  const detector = () => buildOwnAccountDetector(buildOwnAccountsIndex([]));

  it('detecta traspaso cuando la cuenta destino del grupo viene en InF_ADI_2 troceada por espacios', () => {
    // "7013 8708851" = PAGADORA - PROVEEDORES CM de SERVICIOS T DE N en el
    // catálogo; el banco la imprime como "7013870885 1".
    const m = {
      ...mov({ cuenta: '00877732401', concepto: 'PAGO A TERCEROS', referencia: '20/EI/TR' }),
      infAdi2: 'P589  00877732401 a 7013870885 1 SERVICIOS T DE N?21  Pago de SERVICIOS T DE N 170405',
    };
    const c = classifyMovement(m, { ownAccountDetector: detector() });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });

  it('detecta el barrido de la pagadora hacia otra cuenta del grupo vía InF_ADI', () => {
    // CARGO en la pagadora CM cuyo InF_ADI referencia la concentradora.
    const m = {
      ...mov({ cuenta: '70138708851', concepto: 'PAGO A TERCEROS', referencia: '' }),
      infAdi2: 'P612  70138708851 a 0087773240 1 SERVICIOS T DE N?21  Pago de SERVICIOS T DE N 170900',
    };
    const c = classifyMovement(m, { ownAccountDetector: detector() });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });

  it('NO marca interno un pago real a tercero aunque InF_ADI nombre al ordenante propio', () => {
    // El InF_ADI de TODO pago imprime la cuenta origen (propia, auto-excluida)
    // y "Pago de <empresa propia>" (ordenante). Los patrones de nombre/RFC NO
    // escanean InF_ADI a propósito — si lo hicieran, este pago legítimo a un
    // proveedor externo se marcaría interno.
    const m = {
      ...mov({ cuenta: '70138708851', concepto: 'PAGO A TERCEROS', referencia: '' }),
      infAdi2: 'P630  70138708851 a 1234567890 1 PROVEEDOR EXTERNO SA?21  Pago de SERVICIOS T DE N 171001',
    };
    expect(classifyMovement(m, { ownAccountDetector: detector() }).kind).toBe('real');
    expect(isInternalTransfer(m, detector())).toBe(false);
  });

  it('NO marca interno un ABONO real cuyo InF_ADI imprime la CLABE de la PROPIA cuenta', () => {
    // SPEI real entrante: la CLABE beneficiaria (la propia) viaja en InF_ADI.
    // La auto-exclusión estructural de la cuenta origen lo cubre.
    const m = {
      ...mov({ cuenta: '70138708851', tipoMovimiento: 'ABONO', concepto: 'ABONO SPEI', referencia: '' }),
      infAdi3: 'CLABE 002580701387088517 DE ACME EXTERIORES SA',
    };
    expect(classifyMovement(m, { ownAccountDetector: detector() }).kind).toBe('real');
  });

  it('NO une dígitos a través de campos distintos al normalizar', () => {
    // concepto termina en dígitos y InF_ADI empieza con dígitos: juntos
    // formarían "70138708851" (cuenta del grupo), pero la normalización es
    // por campo — no debe fabricar el número.
    const m = {
      ...mov({ cuenta: '0190047839', concepto: 'FOLIO 7013', referencia: '' }),
      infAdi1: '8708851 OPERACION VENTANILLA',
    };
    expect(classifyMovement(m, { ownAccountDetector: detector() }).kind).toBe('real');
  });

  it('sigue detectando dígitos troceados también en el concepto', () => {
    const m = mov({ cuenta: '0190047839', concepto: 'ENVIO A CTA 7014 102 7881', referencia: '' });
    const c = classifyMovement(m, { ownAccountDetector: detector() });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });
});
