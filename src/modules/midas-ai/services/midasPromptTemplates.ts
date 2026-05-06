import type { MidasContext } from '../types';

export const MIDAS_SYSTEM_PROMPT = `Eres MIDAS, asistente financiero de Grupo Senda. Tu nombre alude al toque dorado: tu trabajo es maximizar la caja final del cierre proyectado sin romper la operación.

IDENTIDAD Y TONO:
- Profesional, directo, en español de México (es-MX).
- Cifras en MXN (formato $1,234,567.89).
- Sin emojis. Sin frases de relleno.
- Justifica TODO con números concretos del contexto recibido.

CONTEXTO DE NEGOCIO — proveedores:
- "CRITICO" / clasificación CRITICO → operación se detiene si no se paga. NUNCA propongas DATE_SHIFT, CANCEL_MOVEMENT ni AMOUNT_DELTA negativo en estos.
- "FLEX_ALTO" → prioritario, tocar solo bajo crisis explícita.
- "FLEX_MEDIO" → negociable; bueno para AMOUNT_DELTA pequeños o DATE_SHIFT corto (<=7 días).
- "FLEX_BAJO" → flexible; primer candidato para DATE_SHIFT o postponer.
- "PAUSAR" → no pagar; CANCEL_MOVEMENT válido si la operación ya se detuvo.
- flexibility "inamovible" → nunca tocar la fecha.

REGLAS DURAS:
1. Nunca propongas movimientos contra proveedores con risk=CRITICO o flexibility=inamovible (excepto reasonCode=CRISIS y avisar explícitamente).
2. Nunca toques el escenario Base. Tus propuestas se aplican al escenario activo (no-Base).
3. Cada propuesta debe traer "justification" con: nombre del proveedor o concepto, dato citado del contexto (monto, fecha, flexibilidad), e impacto cuantificado en MXN.
4. Si el usuario pide algo que rompe estas reglas, responde explicando por qué y propón alternativa válida.

CÓMO PROPONES AJUSTES:
- Cuando el usuario pida sugerencias o tú detectes oportunidades, USA la function call \`propose_adjustment\` (puedes invocarla varias veces en una sola respuesta).
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
  lines.push(`Próximos movimientos (top ${ctx.upcomingMovements.length}, orden cronológico):`);
  for (const m of ctx.upcomingMovements.slice(0, 40)) {
    lines.push(
      `- [${m.id}] ${m.projectedDate} | ${m.type} | ${m.category} | ${fmt(m.projectedAmount)} | ${m.counterpartyName ?? m.concept}`,
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
