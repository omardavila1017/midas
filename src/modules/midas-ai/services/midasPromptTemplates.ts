import type { MidasContext } from '../types';

export const MIDAS_SYSTEM_PROMPT = `Eres MIDAS, asistente financiero de Grupo Senda. Tu nombre alude al toque dorado: tu trabajo es maximizar la caja final del cierre proyectado sin romper la operación.

IDENTIDAD Y TONO:
- Profesional, directo, en español de México (es-MX).
- Cifras en MXN (formato $1,234,567.89).
- Sin emojis. Sin frases de relleno.
- Justifica TODO con números concretos del contexto recibido.

CONTEXTO DE NEGOCIO — proveedores:
- "CRITICO" / clasificación CRITICO → operación se detiene si no se paga. NUNCA tocar.
- "FLEX_ALTO" → prioritario, tocar solo bajo crisis explícita.
- "FLEX_MEDIO" → negociable; CANDIDATO PRINCIPAL para postponer.
- "FLEX_BAJO" → flexible; CANDIDATO PRINCIPAL para postponer.
- "PAUSAR" → ya está pausado / no se paga. NUNCA proponer postponer ni tocar movimientos de proveedores PAUSAR (ya no están saliendo de caja, postponerlos no mejora nada).
- flexibility "inamovible" → nunca tocar la fecha.

REGLAS DURAS:
1. Postponer pagos SOLO contra proveedores con flex = FLEX_BAJO o FLEX_MEDIO. Nunca contra CRITICO, PAUSAR, inamovible, ni FLEX_ALTO (salvo reasonCode=CRISIS explícita).
2. Nunca toques el escenario Base. Tus propuestas se aplican al escenario activo (no-Base).
3. Cada propuesta debe traer "justification" con: proveedor(es) o filtro citado, monto agregado MXN, flex de los proveedores, y el cobro/ingreso de \`upcomingInflows\` que financia o justifica el desplazamiento.
4. Si el usuario pide algo que rompe estas reglas, responde explicando por qué y propón alternativa válida.
5. **BALANCE OBLIGATORIO**: cuando sugieras ajustes para mejorar caja, NUNCA propongas SOLO adelantar cobros. Debes proponer al menos UNA modificación de egreso por cada propuesta de cobro adelantado.
6. **BULK OBLIGATORIO**: NO emitas una propuesta por cada movimiento individual. Agrupa pagos elegibles del mismo proveedor o de la misma ventana de fechas en UNA sola propuesta usando targetType=COUNTERPARTY (con el id del proveedor) o targetType=FILTER_SET (expresión tipo "flex IN (FLEX_BAJO,FLEX_MEDIO) AND date BETWEEN ..."). Una propuesta = muchos movimientos movidos juntos. Solo usa targetType=MOVEMENT cuando la acción aplique a un único pago aislado.
7. **ANCLAR AL INGRESO**: cada DATE_SHIFT de egreso debe alinearse a un cobro real de \`upcomingInflows\`. Postponer 7-30 días no es arbitrario: la nueva fecha debe caer DESPUÉS del cobro que la financia. En la justification cita el id/cliente/monto del inflow ancla y compara monto agregado de egresos movidos vs monto del cobro (ej. "postpone $4.2M en pagos FLEX_BAJO/MEDIO al 18-may, día siguiente del cobro [INF-123] de Cliente X por $5.1M").
8. Dimensiona el bulk relativo al ingreso: el monto agregado de egresos postpuestos debe ser ≤ al cobro ancla (no postpongas $10M apoyándote en un cobro de $2M).
9. Prioriza egresos primero: revisa proveedores FLEX_BAJO y FLEX_MEDIO en \`upcomingOutflowsElegibles\`. Ignora la sección \`upcomingOutflowsNoTocar\` salvo para explicar por qué no se mueven.
10. Si solo identificas oportunidades de un lado, DECLARA explícitamente por qué no hay propuesta del otro lado, citando datos del contexto.

CÓMO PROPONES AJUSTES:
- Cuando el usuario pida sugerencias o tú detectes oportunidades, USA la function call \`propose_adjustment\` (puedes invocarla varias veces en una sola respuesta).
- Patrón mínimo recomendado: 2-4 propuestas combinadas (ej: 1 cobro adelantado + 1 pago postpuesto + 1 reducción de gasto).
- Para cobros (INFLOW): identifica clientes con monto pendiente alto en \`upcomingInflows\` y usa DATE_SHIFT con deltaDays negativo (adelantar) o ADD_MOVEMENT si vas a registrar un cobro nuevo.
- Para egresos (OUTFLOW): usa el id del movimiento en \`upcomingOutflows\`. Tipos preferidos: DATE_SHIFT (deltaDays positivo, postponer), AMOUNT_DELTA (negativo, reducir), SPLIT_PAYMENT (parcializar), CANCEL_MOVEMENT (cancelar pago no-crítico).
- En tu mensaje de texto resume las propuestas en lenguaje natural (sin repetir el JSON).
- Tipos de ajuste disponibles:
  * DATE_SHIFT — postponer/adelantar; usar deltaDays.
  * AMOUNT_DELTA — sumar/restar al monto; usar deltaAmount (negativo = reducir egreso).
  * AMOUNT_OVERRIDE — fijar monto absoluto; usar adjustedValue.
  * PERCENTAGE_CHANGE — usar percentageChange (-15 = -15%).
  * SPLIT_PAYMENT — dividir en parcialidades.
  * CANCEL_MOVEMENT — cancelar movimiento.
- "targetType" casi siempre es "MOVEMENT" con "targetExpression" = id del movimiento del contexto.
- "reasonCode" obligatorio: LIQUIDITY | NEGOTIATION | CRISIS | UPSIDE | FORECAST_CORRECTION | MANAGEMENT_DECISION.

OBJETIVO:
Mejorar \`finalCash\` y reducir \`deficitDays\`. Cita siempre el delta esperado en pesos.`;

export function buildContextBlock(ctx: MidasContext): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
  const lines: string[] = [];
  lines.push(`<contexto fecha="${ctx.asOfDate}" cia="${ctx.cia}" escenario_activo="${ctx.activeScenarioId}" tipo="${ctx.activeScenarioKind}">`);
  lines.push(`KPIs proyectados:`);
  lines.push(`- Caja inicial: ${fmt(ctx.forecastSummary.currentCash)}`);
  lines.push(`- Caja final proyectada: ${fmt(ctx.forecastSummary.finalCash)}`);
  lines.push(`- Caja mínima del periodo: ${fmt(ctx.forecastSummary.minCash)}`);
  lines.push(`- Días en déficit: ${ctx.forecastSummary.deficitDays}`);
  lines.push(`- Crédito requerido: ${fmt(ctx.forecastSummary.creditRequired)}`);
  lines.push(`- Inflows totales: ${fmt(ctx.forecastSummary.totalInflows)}`);
  lines.push(`- Outflows totales: ${fmt(ctx.forecastSummary.totalOutflows)}`);
  lines.push(`- Propuestas ya aplicadas en este escenario: ${ctx.existingAdjustmentsCount}`);
  lines.push('');
  lines.push(`Proveedores con monto pendiente (top ${ctx.suppliers.length}, ordenados por monto):`);
  for (const s of ctx.suppliers.slice(0, 30)) {
    lines.push(`- [${s.id}] ${s.name} | risk=${s.risk} | flex=${s.flexibility} | pendiente=${fmt(s.pendingAmount)}`);
  }
  lines.push('');
  const inflows = ctx.upcomingMovements.filter((m) => m.type === 'INFLOW');
  const outflows = ctx.upcomingMovements.filter((m) => m.type === 'OUTFLOW');
  lines.push(`upcomingInflows (cobros próximos, ${inflows.length}) — ANCLAS para postponer egresos:`);
  for (const m of inflows.slice(0, 25)) {
    lines.push(
      `- [${m.id}] ${m.projectedDate} | ${m.category} | ${fmt(m.projectedAmount)} | ${m.counterpartyName ?? m.concept}`,
    );
  }
  lines.push('');

  const supplierMeta = new Map(ctx.suppliers.map((s) => [s.id, s] as const));
  const supplierMetaByName = new Map(ctx.suppliers.map((s) => [s.name, s] as const));
  const lookupMeta = (m: (typeof outflows)[number]) =>
    (m.counterpartyId ? supplierMeta.get(m.counterpartyId) : undefined) ??
    (m.counterpartyName ? supplierMetaByName.get(m.counterpartyName) : undefined);

  const ELEGIBLE_FLEX = new Set(['FLEX_BAJO', 'FLEX_MEDIO']);
  const elegibles: typeof outflows = [];
  const noTocar: { m: (typeof outflows)[number]; reason: string }[] = [];
  for (const m of outflows) {
    const meta = lookupMeta(m);
    const flex = meta?.flexibility ?? 'sin_clasificar';
    const risk = meta?.risk ?? 'SIN_CLASIFICAR';
    if (risk === 'CRITICO') noTocar.push({ m, reason: `risk=CRITICO` });
    else if (flex === 'PAUSAR') noTocar.push({ m, reason: `flex=PAUSAR` });
    else if (flex === 'inamovible') noTocar.push({ m, reason: `flex=inamovible` });
    else if (flex === 'FLEX_ALTO') noTocar.push({ m, reason: `flex=FLEX_ALTO (solo CRISIS)` });
    else if (ELEGIBLE_FLEX.has(flex)) elegibles.push(m);
    else noTocar.push({ m, reason: `flex=${flex}` });
  }

  const groupBySupplier = (list: typeof outflows) => {
    const g = new Map<string, { name: string; flex: string; risk: string; total: number; ids: string[]; dates: string[] }>();
    for (const m of list) {
      const meta = lookupMeta(m);
      const key = m.counterpartyId ?? m.counterpartyName ?? m.concept;
      const cur = g.get(key) ?? {
        name: m.counterpartyName ?? m.concept,
        flex: meta?.flexibility ?? 'sin_clasificar',
        risk: meta?.risk ?? 'SIN_CLASIFICAR',
        total: 0,
        ids: [],
        dates: [],
      };
      cur.total += m.projectedAmount;
      cur.ids.push(m.id);
      cur.dates.push(m.projectedDate);
      g.set(key, cur);
    }
    return [...g.entries()].sort((a, b) => b[1].total - a[1].total);
  };

  lines.push(`upcomingOutflowsElegibles (FLEX_BAJO/FLEX_MEDIO, ${elegibles.length}) — CANDIDATOS A POSTPONER EN BULK:`);
  for (const [key, g] of groupBySupplier(elegibles).slice(0, 20)) {
    const minD = g.dates.reduce((a, b) => (a < b ? a : b));
    const maxD = g.dates.reduce((a, b) => (a > b ? a : b));
    lines.push(
      `- counterpartyId=${key} | ${g.name} | flex=${g.flex} | ${g.ids.length} pagos | total=${fmt(g.total)} | rango=${minD}..${maxD} | ids=[${g.ids.slice(0, 10).join(',')}${g.ids.length > 10 ? ',...' : ''}]`,
    );
  }
  lines.push('');
  lines.push(`upcomingOutflowsNoTocar (${noTocar.length}) — NO PROPONER:`);
  for (const { m, reason } of noTocar.slice(0, 15)) {
    lines.push(
      `- [${m.id}] ${m.projectedDate} | ${fmt(m.projectedAmount)} | ${m.counterpartyName ?? m.concept} | ${reason}`,
    );
  }
  lines.push(`</contexto>`);
  return lines.join('\n');
}

export const PROPOSE_ADJUSTMENT_TOOL = {
  name: 'propose_adjustment',
  description:
    'Propone un ajuste financiero (FinancialAdjustment) DRAFT al escenario activo. Llamar una vez por cada propuesta independiente.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nombre corto y descriptivo de la propuesta.' },
      type: {
        type: 'string',
        enum: [
          'DATE_SHIFT',
          'AMOUNT_OVERRIDE',
          'AMOUNT_DELTA',
          'PERCENTAGE_CHANGE',
          'SPLIT_PAYMENT',
          'CANCEL_MOVEMENT',
          'ADD_MOVEMENT',
          'FINANCING_DRAW',
          'RULE_OVERRIDE',
        ],
      },
      targetType: { type: 'string', enum: ['MOVEMENT', 'FILTER_SET', 'COUNTERPARTY', 'CATEGORY', 'DATE_RANGE'] },
      targetExpression: { type: 'string', description: 'ID del movimiento o expresión de filtro.' },
      reasonCode: {
        type: 'string',
        enum: ['LIQUIDITY', 'NEGOTIATION', 'CRISIS', 'UPSIDE', 'FORECAST_CORRECTION', 'MANAGEMENT_DECISION'],
      },
      justification: {
        type: 'string',
        description:
          'Explicación obligatoria con cifra en MXN del impacto esperado y referencia al proveedor/dato del contexto. Mínimo 30 caracteres.',
      },
      deltaAmount: { type: 'number', description: 'Delta en MXN (negativo reduce egreso). Solo para AMOUNT_DELTA.' },
      deltaDays: { type: 'number', description: 'Días a postponer (positivo) o adelantar (negativo). Solo DATE_SHIFT.' },
      percentageChange: { type: 'number', description: 'Cambio porcentual; -15 = -15%. Solo PERCENTAGE_CHANGE.' },
      adjustedValueAmount: { type: 'number', description: 'Monto absoluto; solo AMOUNT_OVERRIDE.' },
      estimatedCashImpact: { type: 'number', description: 'Impacto neto estimado en finalCash en MXN (positivo = mejora caja).' },
      citedSuppliers: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs de proveedores referenciados en la justificación.',
      },
    },
    required: ['name', 'type', 'targetType', 'targetExpression', 'reasonCode', 'justification', 'estimatedCashImpact'],
  },
} as const;
