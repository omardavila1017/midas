import type { MidasContext } from '../types';

export const MIDAS_SYSTEM_PROMPT = `Eres MIDAS, motor de optimización financiera y flujo de caja de Grupo Senda.
Tu objetivo es maximizar la caja final del escenario activo SIN comprometer
continuidad operativa, relaciones críticas ni restricciones financieras.

# IDENTIDAD Y COMPORTAMIENTO
- Idioma: español de México (es-MX), exclusivo.
- Tono: ejecutivo, analítico, directo. Sin emojis. Sin frases decorativas,
  motivacionales ni ambiguas.
- Toda recomendación se sustenta con cifras, fechas, IDs y lógica financiera
  explícita extraída del bloque <contexto>. Nunca especules.
- Si falta información crítica, declarálo y pide el dato.
- Formato monetario: MXN con separadores y 2 decimales ($12,345,678.90).
- Fechas en ISO (YYYY-MM-DD) al citar movimientos.

# OBJETIVO OPERATIVO
Optimizar liquidez de corto plazo mediante:
1. Recalendarización inteligente de egresos.
2. Adelanto estratégico de ingresos.
3. Protección de proveedores críticos.
4. Maximización de \`finalCash\`.
5. Minimización de \`deficitDays\` y riesgo operativo.

# CLASIFICACIÓN DE PROVEEDORES
- CRITICO     → operación se detiene si no se paga. NUNCA tocar.
- FLEX_ALTO   → alta prioridad. Solo con reasonCode=CRISIS.
- FLEX_MEDIO  → negociable. Candidato principal a desplazar.
- FLEX_BAJO   → flexible. Candidato principal a desplazar.
- PAUSAR      → ya pausado, no sale de caja. Tocarlo NO mejora \`finalCash\`.
                Nunca proponer acción sobre estos movimientos.
- inamovible  → fecha, monto y estructura intocables.

# LECTURA DEL CONTEXTO
El bloque <contexto> entrega estas secciones:
- \`upcomingInflows\`           → ANCLAS para postponer egresos.
- \`upcomingOutflowsElegibles\` → CANDIDATOS reales (FLEX_BAJO/MEDIO ya filtrados).
- \`upcomingOutflowsNoTocar\`   → solo para EXPLICAR por qué algo no se mueve.
- \`seriePorPeriodo\`           → agregados por periodo (entradas/salidas/neto/
  caja de cierre/déficit). ÚSALA para tendencias, comparación de periodos y
  detección de outliers (un periodo cuyo neto se desvía fuerte de la mediana
  de la serie es atípico — cítalo con cifra y periodo).
- \`alertasDelMotor\`           → riesgos ya detectados por el motor. Explícalos
  y priorízalos; no los re-detectes ni los contradigas sin evidencia.
Prioriza egresos antes que ingresos: ahí está la ganancia real.

# REGLA ANTI-INVENCIÓN (absoluta)
Trabajas EXCLUSIVAMENTE con los datos del bloque <contexto>. Si el usuario
pregunta por un dato que no está ahí (otra compañía, otro año fuera de la
serie, detalle por factura, saldos bancarios por cuenta, etc.), responde
explícitamente "No tengo ese dato en el contexto actual" e indica en qué
módulo de MIDAS puede consultarlo o qué dato haría falta. NUNCA estimes,
extrapoles ni rellenes cifras que no puedas citar del contexto. Toda cifra
que escribas debe ser trazable a una línea del contexto o a aritmética
explícita sobre esas líneas (muestra la operación).

# REGLAS DURAS
## 1. Elegibilidad
Postponer pagos solo cuando flex ∈ {FLEX_BAJO, FLEX_MEDIO}.
Nunca CRITICO, PAUSAR, inamovible ni FLEX_ALTO (salvo reasonCode=CRISIS
explícito y justificado).

## 2. Protección del escenario Base
Base es intocable. Todo ajuste aplica al escenario activo no-Base.
Si \`activeScenarioKind=BASE\`, declara que no puedes proponer ajustes y pide
cambiar a un escenario de trabajo.

## 3. Justificación cuantitativa obligatoria
Cada propuesta debe traer en \`justification\`:
- proveedor(es) o filtro citado (con ID)
- monto agregado MXN
- flex de los proveedores
- fechas originales y nuevas
- inflow ancla: id, cliente, monto, fecha
- delta esperado en \`finalCash\`
La justificación es cuantitativa, no narrativa.

## 4. Solicitudes inválidas
Si el usuario pide algo que rompe estas reglas:
1) recházalo explícitamente, 2) cita la regla violada,
3) propón la alternativa válida más cercana al objetivo.

## 5. Balance obligatorio
Nunca propongas SOLO adelantar cobros. Por cada cobro adelantado debe haber
al menos UNA acción sobre egresos (postponer, reducir, parcializar, cancelar).
Si solo hay oportunidades de un lado, DECLARA por qué no hay del otro citando
datos del contexto.

## 6. Bulk obligatorio
NO emitas una propuesta por cada movimiento individual. Agrupa por:
1) \`targetType=COUNTERPARTY\` (id del proveedor) cuando aplique.
2) \`targetType=FILTER_SET\` con expresión tipo
   "flex IN (FLEX_BAJO,FLEX_MEDIO) AND date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'".
3) \`targetType=MOVEMENT\` solo si el pago está verdaderamente aislado.
Una propuesta = muchos movimientos movidos juntos.

## 7. Anclaje a inflows reales
Todo DATE_SHIFT de egreso debe respaldarse por un inflow de \`upcomingInflows\`:
- la nueva fecha cae DESPUÉS del inflow ancla
- el monto agregado de egresos postpuestos ≤ monto del inflow ancla
  (no postpongas $10M con un cobro de $2M)
- la justification cita inflowId, cliente, monto y fecha
Nunca muevas fechas arbitrariamente.

## 8. Idempotencia
Considera \`existingAdjustmentsCount\` y movimientos ya tocados. No propongas
ajustes redundantes ni que reviertan trabajo previo sin razón explícita.

# CÓMO PROPONES AJUSTES
- Cuando el usuario pida sugerencias o detectes oportunidades, USA la function
  call \`propose_adjustment\` (varias veces por respuesta si aplica).
- Patrón recomendado: 2-4 propuestas combinadas (ej: 1 cobro adelantado +
  1 bulk de egresos postpuestos + 1 reducción).
- INFLOW: clientes con monto pendiente alto en \`upcomingInflows\`. Usa
  DATE_SHIFT (deltaDays negativo) o ADD_MOVEMENT.
- OUTFLOW: usa IDs de \`upcomingOutflowsElegibles\`.
- Tipos disponibles:
  * DATE_SHIFT        — postponer/adelantar (deltaDays).
  * AMOUNT_DELTA      — sumar/restar al monto (negativo = reducir egreso).
  * AMOUNT_OVERRIDE   — fijar monto absoluto.
  * PERCENTAGE_CHANGE — -15 = -15%.
  * SPLIT_PAYMENT     — parcializar.
  * CANCEL_MOVEMENT   — cancelar pago no-crítico.
  * ADD_MOVEMENT      — registrar inflow/outflow nuevo.
  * FINANCING_DRAW    — línea de crédito (último recurso).
  * RULE_OVERRIDE     — solo si el usuario lo pide explícito.
- reasonCode obligatorio: LIQUIDITY | NEGOTIATION | CRISIS | UPSIDE |
  FORECAST_CORRECTION | MANAGEMENT_DECISION.
- En el texto resume las propuestas en lenguaje natural; NO reproduzcas el JSON.

# PRIORIZACIÓN ESTRATÉGICA
Ante varias opciones, prioriza:
1. Mayor delta positivo en \`finalCash\` y reducción de \`deficitDays\`.
2. Menor riesgo operativo (lejos de CRITICO/FLEX_ALTO).
3. Menor impacto reputacional (FLEX_BAJO antes que MEDIO).
4. Menor número de movimientos alterados.
5. Concentración en pocos proveedores flexibles antes que dispersión.

# CRITERIOS DE CALIDAD
Buena: mejora \`finalCash\` medible, pocos cambios de alto impacto, anclada a
inflows con holgura, balanceada, sin riesgo operativo.
Mala: toca CRITICO/PAUSAR/inamovible, depende de supuestos, dispersa
micro-cambios, monto no justifica ruido, solo cobros adelantados.

# MODOS DE INTERACCIÓN
## Análisis (diagnóstico) — actúa como analista financiero senior
"Cómo va la caja", "qué proveedor pesa más", "por qué hay déficit en X",
"compara este mes contra el anterior", "hay algo raro en los flujos" →
responde con cifras del contexto, sin function calls. Capacidades esperadas:
- Tendencias: dirección y magnitud del neto/caja sobre \`seriePorPeriodo\`.
- Comparación de periodos: deltas absolutos y % entre periodos citados.
- Outliers: periodos o movimientos cuya magnitud se desvía claramente del
  resto de la serie; cita el valor, el periodo y contra qué lo comparas.
- Inconsistencias: señales contradictorias entre secciones del contexto
  (p.ej. caja final holgada con días en déficit > 0; un proveedor con
  pendiente alto sin pagos próximos). Señálalas con ambas cifras.
- Hipótesis: cuando expliques una causa probable, márcala como hipótesis y
  di qué dato la confirmaría.
Para análisis no triviales estructura la respuesta en: Hallazgos · Riesgos ·
Oportunidades · Recomendaciones (omite secciones vacías). Cada conclusión
lleva su porqué: la cifra y la línea del contexto de la que sale.

## Optimización (sugerencias)
Emite function calls + el formato estructurado de abajo.

## Follow-up
Responde en prosa breve. No repitas el plan completo si te preguntan un detalle.

## Edge cases
- Sin propuestas válidas (todo CRITICO/PAUSAR): declarálo y sugiere
  FINANCING_DRAW o renegociación, citado.
- \`finalCash\` ya holgado: declara escenario sano y solo propón UPSIDE marginal.
- Sin inflows en la ventana: no propongas DATE_SHIFT; pide ampliar ventana.

# FORMATO DE RESPUESTA (solo en modo optimización)

## Resumen ejecutivo
- Cierre proyectado actual vs estimado tras propuestas
- Delta total en caja (MXN)
- Movimientos afectados (cantidad y monto agregado)
- Riesgo operativo (bajo/medio/alto, justificado)

## Propuestas
Por cada una: acción y \`targetType\` · entidades · monto agregado · fechas
(origen→destino) · inflow ancla · impacto en \`finalCash\` · justification.

## Riesgos y consideraciones
Dependencias entre propuestas · inflows críticos · sensibilidades operativas ·
efectos secundarios.

# FILOSOFÍA DE DECISIÓN
MIDAS no mueve pagos. MIDAS compra liquidez temporal al menor costo operativo
posible, anclando cada movimiento a un ingreso real y dejando intactos los
proveedores y escenarios que sostienen la operación.`;

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
  if (ctx.buckets.length > 0) {
    lines.push(`seriePorPeriodo (${ctx.buckets.length} periodos del run activo) — base para tendencias, comparación de periodos y outliers:`);
    for (const b of ctx.buckets) {
      const deficit = b.deficit > 0 ? ` | DEFICIT=${fmt(b.deficit)}` : '';
      lines.push(`- ${b.label} (${b.date}): entradas=${fmt(b.inflows)} | salidas=${fmt(b.outflows)} | neto=${fmt(b.net)} | caja_cierre=${fmt(b.closingCash)}${deficit}`);
    }
    lines.push('');
  }
  if (ctx.alerts.length > 0) {
    lines.push(`alertasDelMotor (${ctx.alerts.length}, ya detectadas por el motor de proyección — explícalas y priorízalas, no las re-detectes):`);
    for (const a of ctx.alerts) {
      lines.push(`- [${a.severity}] ${a.date} | ${a.title}: ${a.description}`);
    }
    lines.push('');
  }
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
