/**
 * Evaluación conversacional de MIDAS AI contra OpenAI REAL, usando el
 * prompt de sistema y el formato de contexto reales del módulo midas-ai.
 *
 * Corre 5 conversaciones tipo analista sobre un contexto financiero
 * realista con señales plantadas (un mes outlier, una inconsistencia y un
 * dato ausente) y verifica de forma ligera que:
 *   1. responde en español con cifras del contexto,
 *   2. compara periodos con deltas,
 *   3. detecta el periodo atípico plantado,
 *   4. declara explícitamente cuando NO tiene el dato (no inventa),
 *   5. propone ajustes vía function calls cuando se le pide.
 *
 * Requiere OPENAI_API_KEY (entorno o .env.local). Uso:
 *   npm run ai:eval
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildContextBlock,
  MIDAS_SYSTEM_PROMPT,
  PROPOSE_ADJUSTMENT_TOOL,
} from '../src/modules/midas-ai/services/midasPromptTemplates';
import type { MidasContext } from '../src/modules/midas-ai/types';

function loadDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = { ...loadDotEnv(resolve('.env')), ...loadDotEnv(resolve('.env.local')) };
const env = (k: string) => process.env[k] ?? fileEnv[k];
const apiKey = env('OPENAI_API_KEY');
const upstream = (env('OPENAI_UPSTREAM') || 'https://api.openai.com/v1').replace(/\/+$/, '');
const model = env('VITE_OPENAI_MODEL') || 'gpt-4o-mini';

if (!apiKey || /^<.*>$/.test(apiKey)) {
  console.error('✘ OPENAI_API_KEY no configurada — este eval requiere conexión real. Corre primero: npm run ai:check');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Contexto fixture: 8 meses de serie con señales plantadas.
//  - OUTLIER: Mar 2026 con salidas 3x (un pago extraordinario).
//  - INCONSISTENCIA: caja final positiva pero 9 días en déficit dentro de la
//    ventana (mínimo de caja negativo en junio).
//  - DATO AUSENTE: no hay nada de 2023 ni de otras compañías.
// ---------------------------------------------------------------------------
const fixture: MidasContext = {
  cia: '00033',
  asOfDate: '2026-06-10',
  activeScenarioId: 'draft-tesoreria',
  activeScenarioKind: 'DRAFT',
  existingAdjustmentsCount: 0,
  forecastSummary: {
    currentCash: 18_400_000,
    projectedCash7: 12_100_000,
    projectedCash30: -2_300_000,
    projectedCash90: 6_800_000,
    minimumCashRequired: 5_000_000,
    deficitDays: 9,
    averageConfidence: 0.82,
    totalInflows: 96_500_000,
    totalOutflows: 108_100_000,
    finalCash: 6_800_000,
    minCash: -4_900_000,
    maxRiskDate: '2026-06-28',
    creditRequired: 9_900_000,
  },
  buckets: [
    { date: '2025-11-01', label: 'Nov 2025', inflows: 41_200_000, outflows: 38_900_000, net: 2_300_000, closingCash: 21_500_000, deficit: 0 },
    { date: '2025-12-01', label: 'Dic 2025', inflows: 46_800_000, outflows: 44_100_000, net: 2_700_000, closingCash: 24_200_000, deficit: 0 },
    { date: '2026-01-01', label: 'Ene 2026', inflows: 39_500_000, outflows: 41_800_000, net: -2_300_000, closingCash: 21_900_000, deficit: 0 },
    { date: '2026-02-01', label: 'Feb 2026', inflows: 40_100_000, outflows: 39_400_000, net: 700_000, closingCash: 22_600_000, deficit: 0 },
    { date: '2026-03-01', label: 'Mar 2026', inflows: 42_300_000, outflows: 121_700_000, net: -79_400_000, closingCash: -56_800_000, deficit: 61_800_000 },
    { date: '2026-04-01', label: 'Abr 2026', inflows: 44_900_000, outflows: 40_200_000, net: 4_700_000, closingCash: -52_100_000, deficit: 57_100_000 },
    { date: '2026-05-01', label: 'May 2026', inflows: 88_700_000, outflows: 18_200_000, net: 70_500_000, closingCash: 18_400_000, deficit: 0 },
    { date: '2026-06-01', label: 'Jun 2026', inflows: 31_400_000, outflows: 43_000_000, net: -11_600_000, closingCash: 6_800_000, deficit: 4_900_000 },
  ],
  alerts: [
    { date: '2026-06-28', severity: 'CRITICAL', title: 'Caja bajo mínimo', description: 'La caja proyectada cae a -$4.9M el 28-jun, por debajo del mínimo operativo de $5.0M.' },
    { date: '2026-06-20', severity: 'WARNING', title: 'Concentración de cobranza', description: 'El 64% de los cobros de junio dependen de un solo cliente (TRANSPORTES DEL NORTE).' },
  ],
  suppliers: [
    { id: 'p-diesel', name: 'COMBUSTIBLES DEL GOLFO', risk: 'CRITICO', flexibility: 'inamovible', pendingAmount: 12_400_000 },
    { id: 'p-llantas', name: 'LLANTERA INDUSTRIAL MTY', risk: 'MEDIO', flexibility: 'FLEX_MEDIO', pendingAmount: 6_900_000 },
    { id: 'p-refacciones', name: 'REFACCIONES PESADAS SA', risk: 'BAJO', flexibility: 'FLEX_BAJO', pendingAmount: 4_300_000 },
    { id: 'p-limpieza', name: 'SERVICIOS DE LIMPIEZA RG', risk: 'BAJO', flexibility: 'FLEX_BAJO', pendingAmount: 800_000 },
    { id: 'p-ti', name: 'CONSULTORIA TI AZTECA', risk: 'BAJO', flexibility: 'PAUSAR', pendingAmount: 1_500_000 },
  ],
  upcomingMovements: [
    { id: 'cxc:f-9912', concept: 'Factura F-9912', type: 'INFLOW', category: 'AR_COLLECTION', projectedAmount: 20_100_000, projectedDate: '2026-06-20', counterpartyName: 'TRANSPORTES DEL NORTE', counterpartyId: 'c-tdn' },
    { id: 'cxc:f-9874', concept: 'Factura F-9874', type: 'INFLOW', category: 'AR_COLLECTION', projectedAmount: 6_200_000, projectedDate: '2026-06-24', counterpartyName: 'CEMENTOS REGIOS', counterpartyId: 'c-cr' },
    { id: 'cxc:f-9931', concept: 'Factura F-9931', type: 'INFLOW', category: 'AR_COLLECTION', projectedAmount: 5_100_000, projectedDate: '2026-07-03', counterpartyName: 'ACEROS DE SALTILLO', counterpartyId: 'c-as' },
    { id: 'cxp:diesel-jun', concept: 'Diesel quincena 2', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedAmount: 12_400_000, projectedDate: '2026-06-18', counterpartyName: 'COMBUSTIBLES DEL GOLFO', counterpartyId: 'p-diesel' },
    { id: 'cxp:llantas-jun', concept: 'OC 4471 llantas', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedAmount: 6_900_000, projectedDate: '2026-06-19', counterpartyName: 'LLANTERA INDUSTRIAL MTY', counterpartyId: 'p-llantas' },
    { id: 'cxp:refa-jun', concept: 'OC 4488 refacciones', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedAmount: 4_300_000, projectedDate: '2026-06-22', counterpartyName: 'REFACCIONES PESADAS SA', counterpartyId: 'p-refacciones' },
    { id: 'payroll:jun-q2', concept: 'Nómina quincena 2 junio', type: 'OUTFLOW', category: 'PAYROLL', projectedAmount: 14_800_000, projectedDate: '2026-06-27', counterpartyName: 'NOMINA TRESS' },
  ],
};

interface Turn { role: 'user' | 'assistant'; content: string }

async function chat(history: Turn[]): Promise<{ text: string; toolCalls: Array<{ name: string; args: string }> }> {
  const res = await fetch(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: MIDAS_SYSTEM_PROMPT }, ...history],
      tools: [{ type: 'function', function: PROPOSE_ADJUSTMENT_TOOL }],
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  return {
    text: (msg.content ?? '').trim(),
    toolCalls: (msg.tool_calls ?? []).map((tc: { function: { name: string; arguments: string } }) => ({
      name: tc.function.name,
      args: tc.function.arguments,
    })),
  };
}

interface Check { label: string; pass: boolean }

const cases: Array<{ q: string; verify: (text: string, toolCalls: Array<{ name: string; args: string }>) => Check[] }> = [
  {
    q: '¿Cómo va la caja y cuáles son los principales riesgos en lo que resta de junio?',
    verify: (t) => [
      { label: 'cita la caja proyectada o el mínimo con cifra MXN', pass: /\$\s?[\d,]/.test(t) },
      { label: 'menciona el riesgo del 28-jun o el déficit', pass: /28|déficit|deficit|mínimo|minimo/i.test(t) },
    ],
  },
  {
    q: 'Compara junio 2026 contra mayo 2026: ¿qué cambió en entradas, salidas y neto?',
    verify: (t) => [
      { label: 'menciona ambos periodos', pass: /may/i.test(t) && /jun/i.test(t) },
      { label: 'da deltas o porcentajes', pass: /%|\$\s?[\d,]/.test(t) },
    ],
  },
  {
    q: '¿Detectas algún periodo atípico (outlier) en la serie mensual? Explica por qué.',
    verify: (t) => [
      { label: 'detecta el outlier plantado de Mar 2026', pass: /mar/i.test(t) },
      { label: 'cita la magnitud anómala (~$121.7M de salidas o neto -$79.4M)', pass: /121|79/.test(t) },
    ],
  },
  {
    q: '¿Cuánto vendimos en 2023 y cómo se compara contra 2026?',
    verify: (t) => [
      {
        label: 'declara explícitamente que NO tiene datos de 2023 (no inventa)',
        pass: /no tengo|no está|no esta|no dispongo|no hay datos|no cuento con|fuera del contexto/i.test(t),
      },
      { label: 'no inventa una cifra para 2023', pass: !/2023[^.]{0,40}\$\s?[\d,]{7,}/.test(t) },
    ],
  },
  {
    q: 'Sugiéreme ajustes concretos para cubrir el déficit de fin de junio sin tocar proveedores críticos.',
    verify: (t, tc) => [
      { label: 'emite ≥1 propuesta vía function call propose_adjustment', pass: tc.some((c) => c.name === 'propose_adjustment') },
      { label: 'no propone tocar al proveedor CRITICO/inamovible (diesel)', pass: !tc.some((c) => /p-diesel|COMBUSTIBLES/i.test(c.args)) },
    ],
  },
];

const contextBlock = buildContextBlock(fixture);
console.log('— MIDAS AI · evaluación conversacional (modelo real) —');
console.log(`  modelo: ${model} · upstream: ${upstream}`);
console.log(`  contexto: ${contextBlock.length} chars · ${fixture.buckets.length} periodos · ${fixture.upcomingMovements.length} movimientos\n`);

const history: Turn[] = [
  { role: 'user', content: contextBlock },
  { role: 'assistant', content: 'Contexto recibido. Listo para asistir.' },
];

let failed = 0;
for (const [i, c] of cases.entries()) {
  console.log(`\n══ Caso ${i + 1}: ${c.q}`);
  history.push({ role: 'user', content: c.q });
  const res = await chat(history);
  history.push({ role: 'assistant', content: res.text || '[function calls]' });
  console.log(`\n${res.text || '(sin texto — solo function calls)'}`);
  if (res.toolCalls.length > 0) {
    console.log(`\n  function calls: ${res.toolCalls.map((t) => t.name).join(', ')}`);
    for (const t of res.toolCalls) console.log(`    · ${t.args.slice(0, 200)}`);
  }
  for (const check of c.verify(res.text, res.toolCalls)) {
    console.log(`  ${check.pass ? '✔' : '✘'} ${check.label}`);
    if (!check.pass) failed += 1;
  }
}

console.log(`\n${failed === 0 ? '✔ Todos los checks pasaron.' : `✘ ${failed} check(s) fallaron — revisar transcript arriba.`}`);
process.exit(failed === 0 ? 0 : 1);
