import { describe, expect, it } from 'vitest';
import { parseProposal, type RawProposalArgs } from './proposalParser';

// Justificación válida: ≥30 caracteres Y contiene al menos una cifra.
const VALID_JUSTIFICATION =
  'Diferir el pago libera $1,500,000 MXN de caja durante los próximos 30 días.';

function validArgs(patch: Partial<RawProposalArgs> = {}): RawProposalArgs {
  return {
    name: 'Diferir pago a proveedor crítico',
    type: 'DATE_SHIFT',
    targetType: 'COUNTERPARTY',
    targetExpression: 'PEMEX',
    reasonCode: 'LIQUIDITY',
    justification: VALID_JUSTIFICATION,
    deltaDays: 15,
    estimatedCashImpact: 1_500_000,
    citedSuppliers: ['PEMEX'],
    ...patch,
  };
}

describe('parseProposal — casos válidos', () => {
  it('convierte args completos en una sugerencia ok:true con el draft fiel', () => {
    const result = parseProposal(validArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.draft).toEqual({
      name: 'Diferir pago a proveedor crítico',
      type: 'DATE_SHIFT',
      targetType: 'COUNTERPARTY',
      targetExpression: 'PEMEX',
      reasonCode: 'LIQUIDITY',
      justification: VALID_JUSTIFICATION,
      deltaAmount: undefined,
      deltaDays: 15,
      percentageChange: undefined,
      adjustedValue: undefined,
    });
    expect(result.suggestion.estimatedCashImpact).toBe(1_500_000);
    expect(result.suggestion.citedSuppliers).toEqual(['PEMEX']);
    expect(result.suggestion.id).toMatch(/^midas-prop-/);
  });

  it('recorta whitespace en name, targetExpression y justification', () => {
    const result = parseProposal(validArgs({
      name: '  Ajuste  ',
      targetExpression: '  cxp:123  ',
      justification: `  ${VALID_JUSTIFICATION}  `,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.draft.name).toBe('Ajuste');
    expect(result.suggestion.draft.targetExpression).toBe('cxp:123');
    expect(result.suggestion.draft.justification).toBe(VALID_JUSTIFICATION);
  });

  it('genera ids distintos por sugerencia', () => {
    const a = parseProposal(validArgs());
    const b = parseProposal(validArgs());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.suggestion.id).not.toBe(b.suggestion.id);
  });

  it('acepta todos los types y reasonCodes del contrato', () => {
    const types = [
      'DATE_SHIFT', 'AMOUNT_OVERRIDE', 'AMOUNT_DELTA', 'PERCENTAGE_CHANGE',
      'SPLIT_PAYMENT', 'CANCEL_MOVEMENT', 'ADD_MOVEMENT', 'FINANCING_DRAW', 'RULE_OVERRIDE',
    ];
    for (const type of types) {
      expect(parseProposal(validArgs({ type })).ok).toBe(true);
    }
    const reasons = ['LIQUIDITY', 'NEGOTIATION', 'CRISIS', 'UPSIDE', 'FORECAST_CORRECTION', 'MANAGEMENT_DECISION'];
    for (const reasonCode of reasons) {
      expect(parseProposal(validArgs({ reasonCode })).ok).toBe(true);
    }
  });
});

describe('parseProposal — campos faltantes o vacíos', () => {
  it('rechaza name ausente, no-string o whitespace', () => {
    for (const name of [undefined, null, 42, '', '   ']) {
      const result = parseProposal(validArgs({ name }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('name vacío');
    }
  });

  it('rechaza targetExpression ausente o whitespace', () => {
    for (const targetExpression of [undefined, '', '   ', 123]) {
      const result = parseProposal(validArgs({ targetExpression }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('targetExpression vacío');
    }
  });

  it('rechaza justification faltante o corta (<30 caracteres)', () => {
    const result = parseProposal(validArgs({ justification: 'Corta con cifra 1' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('justification < 30 caracteres');
    expect(parseProposal(validArgs({ justification: undefined })).ok).toBe(false);
  });

  it('rechaza justification larga pero sin cifra cuantificada', () => {
    const result = parseProposal(validArgs({
      justification: 'Esta justificación es suficientemente larga pero no cita ninguna cifra.',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('justification sin cifra cuantificada');
  });

  it('devuelve los args crudos en el fallo para diagnóstico', () => {
    const raw = validArgs({ name: '' });
    const result = parseProposal(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).toBe(raw);
  });
});

describe('parseProposal — tipos inválidos (el LLM no es confiable)', () => {
  it('rechaza type fuera del vocabulario o no-string', () => {
    for (const type of ['MAGIC_FIX', 'date_shift', 7, null, {}]) {
      const result = parseProposal(validArgs({ type }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain('type inválido');
    }
  });

  it('rechaza targetType fuera del vocabulario', () => {
    for (const targetType of ['EVERYTHING', 'movement', 1]) {
      const result = parseProposal(validArgs({ targetType }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain('targetType inválido');
    }
  });

  it('rechaza reasonCode fuera del vocabulario', () => {
    const result = parseProposal(validArgs({ reasonCode: 'BECAUSE_YES' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('reasonCode inválido');
  });
});

describe('parseProposal — montos no numéricos y valores malformados', () => {
  it('descarta montos que no son number finito (strings, NaN, Infinity)', () => {
    const result = parseProposal(validArgs({
      deltaAmount: '5000',
      deltaDays: Number.NaN,
      percentageChange: Number.POSITIVE_INFINITY,
      adjustedValueAmount: { amount: 100 },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.draft.deltaAmount).toBeUndefined();
    expect(result.suggestion.draft.deltaDays).toBeUndefined();
    expect(result.suggestion.draft.percentageChange).toBeUndefined();
    expect(result.suggestion.draft.adjustedValue).toBeUndefined();
  });

  it('estimatedCashImpact no numérico cae a 0', () => {
    const result = parseProposal(validArgs({ estimatedCashImpact: 'mucho dinero' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.estimatedCashImpact).toBe(0);
  });

  it('conserva montos numéricos negativos y cero tal cual', () => {
    const result = parseProposal(validArgs({ deltaAmount: -250_000, estimatedCashImpact: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.draft.deltaAmount).toBe(-250_000);
    expect(result.suggestion.estimatedCashImpact).toBe(0);
  });

  it('citedSuppliers filtra elementos no-string y tolera no-arrays', () => {
    const mixed = parseProposal(validArgs({ citedSuppliers: ['A', 42, null, 'B', {}] }));
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.suggestion.citedSuppliers).toEqual(['A', 'B']);

    const notArray = parseProposal(validArgs({ citedSuppliers: 'PEMEX' }));
    expect(notArray.ok).toBe(true);
    if (!notArray.ok) return;
    expect(notArray.suggestion.citedSuppliers).toEqual([]);
  });

  it('fechas malformadas viajan como string en targetExpression sin romper el parseo (DATE_RANGE)', () => {
    // El parser NO valida el contenido de targetExpression — una "fecha" basura
    // pasa como expresión. Comportamiento actual documentado por este test.
    const result = parseProposal(validArgs({ targetType: 'DATE_RANGE', targetExpression: '2026-13-45..no-fecha' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.draft.targetExpression).toBe('2026-13-45..no-fecha');
  });
});

describe('percentageChange — frontera de unidad porcentaje→fracción', () => {
  // El prompt le pide al modelo PUNTOS porcentuales ("-15 = -15%"); el resto del
  // sistema guarda FRACCIÓN y el motor aplica `monto * (1 + percentageChange)`.
  // Sin la conversión, un -15 llegaba como `monto * -14` → Math.max(0,…) = $0:
  // la propuesta BORRABA el pago en vez de reducirlo.
  function pctArgs(percentageChange: number): RawProposalArgs {
    return validArgs({ type: 'PERCENTAGE_CHANGE', percentageChange, deltaDays: undefined });
  }

  function parsedPct(percentageChange: number): number | undefined {
    const result = parseProposal(pctArgs(percentageChange));
    if (!result.ok) throw new Error(`parseProposal falló: ${result.reason}`);
    return result.suggestion.draft.percentageChange;
  }

  it('-15 (reducir 15%) se guarda como -0.15, no como -15', () => {
    expect(parsedPct(-15)).toBeCloseTo(-0.15, 10);
  });

  it('el monto resultante es una REDUCCIÓN del 15%, no un borrado a $0', () => {
    // Misma aritmética que `applySingleAdjustment` en el motor.
    const amount = 1_000_000;
    const applied = Math.max(0, amount * (1 + (parsedPct(-15) ?? 0)));
    expect(applied).toBeCloseTo(850_000, 6);
  });

  it('+10 (aumentar 10%) multiplica por 1.1, no por 11', () => {
    const amount = 1_000_000;
    const applied = Math.max(0, amount * (1 + (parsedPct(10) ?? 0)));
    expect(applied).toBeCloseTo(1_100_000, 6);
  });

  it('ausente sigue siendo undefined (no se convierte un hueco en 0)', () => {
    const result = parseProposal(validArgs({ type: 'PERCENTAGE_CHANGE', percentageChange: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestion.draft.percentageChange).toBeUndefined();
  });

  it('un modelo que desobedezca y mande ya una fracción degrada a casi no-op, nunca a borrado', () => {
    // -0.15 → -0.0015: una reducción del 0.15%. El modo de falla contrario
    // (tratar -15 como fracción) borraba el pago entero.
    const applied = Math.max(0, 1_000_000 * (1 + (parsedPct(-0.15) ?? 0)));
    expect(applied).toBeGreaterThan(990_000);
  });
});
