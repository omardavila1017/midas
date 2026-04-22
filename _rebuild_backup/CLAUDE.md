# CLAUDE.md

## Propósito

Este archivo resume el contexto operativo real de `flowsense` para cualquier agente
que vaya a tocar el proyecto. El código es siempre la fuente final de verdad; este
archivo solo debe ayudarte a entender lo que vas a encontrar.

Los archivos más importantes para validar comportamiento son:

- `src/App.tsx`
- `src/types.ts`
- `src/domain/persistence.ts`
- `src/domain/scenarioEngine.ts`
- `src/domain/proposalCompiler.ts`
- `src/components/ProjectionWorkspace.tsx`
- `src/components/ProposalDrawer.tsx`

## Stack y comandos

- Frontend: React 18 + Vite + TypeScript + Tailwind
- Charts: Recharts
- Tests: Vitest + Testing Library
- Parsing Excel: `xlsx`

Comandos principales:

```bash
npm run dev
npm test
npm run build
```

## Regla crítica: semántica de negocio == nombres internos

A diferencia de versiones anteriores del repo, hoy la UI y los nombres de
TypeScript **coinciden 1:1**. No hay inversión semántica:

| UI                | Código TS    |
| ----------------- | ------------ |
| Escenario Base    | `Scenario` con `id === BASE_SCENARIO_ID` |
| Escenario         | `Scenario`   |
| Propuesta         | `Proposal`   |

El tipo `Simulation` todavía existe en `types.ts` / `persistence.ts` / `scenarioEngine.ts`
por dos razones:

1. Compatibilidad con datos ya guardados en `localStorage` bajo `flowsense-v2`.
2. `evaluateScenario()` recibe un `simulation` como parámetro y lo usa sólo para
   etiquetar el resultado (`simulation.id`). En el módulo de Proyección le
   pasamos un `Simulation` virtual (`VIRTUAL_SIM`) porque la capa de "Simulación"
   intermedia ya se eliminó del UI.

Si tocas esta zona, **no reintroduzcas la capa "Simulación" visible**. El usuario
la pidió eliminar explícitamente: proyección es un módulo plano con Base + N
escenarios y propuestas globales reusables.

## Arquitectura actual del módulo Proyección

Antes: dos tabs separadas (`forecast` y `scenarios`) con lógica duplicada y un
dashboard teaser. Hoy: **una sola pestaña `projection`** que renderiza
`ProjectionWorkspace`.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Top bar: Escenario activo · Granularidad · [+ Escenario] [+ Prop.]  │
├──────────────────────────────────────────────────────────────────────┤
│ KPI cards (Ingresos · Egresos · Flujo · Caja · Cobranza · Pagos)    │
├──────────────────────────────────────────────────────────────────────┤
│ Tabs: [P&L] [Flujo de Caja] [Drivers]                                │
├──────────────────┬───────────────────────────────────────────────────┤
│ Propuestas       │  Gráfico Base vs Escenario (línea punteada + sól.)│
│ (toggles live)   │                                                    │
│ [+ crear]        ├───────────────────────────────────────────────────┤
│                  │  Tabla editable (doble-click abre popover)        │
└──────────────────┴───────────────────────────────────────────────────┘
                      │
                      └── Drawer lateral derecho: ProposalDrawer
                          (abre al crear/editar una propuesta)
```

### Decisiones deliberadas

- **Sin capa Simulación**: Base + N escenarios, y ya.
- **Propuestas globales**: una propuesta es reusable y se enciende/apaga por
  escenario vía `scenario.proposalIds[]`.
- **Overrides manuales**: sólo permitidos en escenarios ≠ Base, sólo en celdas
  hoja, siguen guardados en `scenarioCellOverrides`.
- **Sin sistema de confianza**: se removió (no aportaba valor). Los tipos
  `ForecastConfidenceOverride` todavía viven en `types.ts` por compatibilidad
  de `localStorage`, pero nadie los lee.
- **Drawer lateral derecho** para crear/editar propuestas: no se pierde la
  vista del gráfico mientras se configura.
- **Teaser del Dashboard** simplificado: un solo botón "Abrir proyección".

## Estado global (en `App.tsx`)

Campos importantes:

- `plan`
- `proposals`
- `scenarios`
- `simulations` (legacy, poblado desde store pero ya no se usa en UI)
- `scenarioCellOverrides`
- `activeScenarioId`
- `activeSimulationId` (legacy, se mantiene para no romper el store)
- `forecastGranularity`

Selección activa:

- Si `activeScenarioId === BASE_SCENARIO_ID`, la app está viendo el Base.
- Base no admite propuestas aplicadas ni overrides manuales.
- `selectScenario()` también setea `activeSimulationId` por compatibilidad,
  pero el nuevo `ProjectionWorkspace` no se entera.

## Modelo de datos actual

### Base

```ts
BASE_SCENARIO_ID = 'scenario-base'
BASE_SCENARIO_NAME = 'Escenario Base'
```

### Scenario (UI: Escenario)

```ts
Scenario {
  id, simulationId, kind, name, description, probability,
  startYearMonth, horizonMonths, proposalIds[], locked?,
  createdAt, updatedAt
}
```

`proposalIds` es la lista de propuestas activas en ese escenario.

### Proposal (UI: Propuesta)

```ts
Proposal {
  id, name, description, category, type, targetIds[],
  startYearMonth, endYearMonth?, startDate?, endDate?,
  frequency?, operation?, amount?, percent?,
  installments?, customAllocation?,
  shiftMonths?, shiftRatio?, paymentLabel?, comments?,
  effects[], createdAt, updatedAt
}
```

### Simulation (legacy, no UI)

Sigue existiendo como tipo y se guarda en el store por compatibilidad. En el
flujo nuevo no hay pantalla para crearlas; `ProjectionWorkspace` construye un
`VIRTUAL_SIM` para pasárselo al motor.

## Persistencia

`src/domain/persistence.ts`, store `flowsense-v2`.

Notas importantes:

- `normalizeV2Store()` siempre reinyecta el Base.
- La persistencia tolera documentos parciales — no asumas que tiene todos los
  campos nuevos.
- `scenarioCellOverrides` sigue llevando `scenarioId::conceptId::yearMonth`.
- Al migrar datos legacy, las simulaciones viejas se rellenan con defaults para
  no romper `evaluateScenario`.

## Motor de cálculo

`src/domain/scenarioEngine.ts` — fuente de verdad del forecast.

Función principal:

```ts
evaluateScenario(plan, simulation, scenario, proposals, overrides, { granularity? })
```

### Orden de cálculo

1. Base del plan.
2. Propuestas activas del escenario (compiladas a `concept_delta`).
3. Overrides manuales por celda (sólo en escenarios ≠ Base).
4. Recomputar métricas y KPIs.

### Reglas no negociables

- Overrides son por `scenarioId`, no globales.
- Sólo celdas hoja son editables manualmente.
- Subtotales y filas derivadas no aceptan override.
- El Base no admite edición manual.
- Soporta `monthly`, `weekly` y `daily`. Semanal sale de `weeklyData`;
  la diaria se deriva repartiendo semanas. Overrides siguen siendo mensuales
  pero se reflejan proporcionalmente en semana / día.

### Targets sintéticos

- `ROLE_TARGET_INCOME`
- `ROLE_TARGET_EXPENSE`
- `ROLE_TARGET_COLLECTIONS`
- `ROLE_TARGET_PROVIDER_PAYMENTS`

Los ajustes porcentuales sobre estos targets usan una **base agregada separada**
dentro del motor. No calcules `%` sobre `baseValuesByConceptId` para targets
sintéticos — ese bug ya se corrigió y no hay que reintroducirlo.

## Compilador de propuestas

`src/domain/proposalCompiler.ts`.

Funciones:

- `buildProposalEffects()`
- `isBaseScenario()`
- `ensureBaseScenario()`
- `createBaseScenario()`
- `enumerateYearMonths()`

Tipos de propuesta soportados:

- `percent_adjustment`
- `amount_adjustment`
- `recurring_series`
- `installment_plan`
- `timing_shift`
- `pause_expense`

Todos terminan compilando a `concept_delta`.

## Componentes clave

### ProjectionWorkspace

`src/components/ProjectionWorkspace.tsx` — el módulo unificado.

Props importantes:

```ts
interface ProjectionWorkspaceProps {
  plan, scenarios, proposals, overrides, activeScenarioId, granularity,
  onGranularityChange, onSelectScenario, onUpdateScenario, onDeleteScenario,
  onSaveAsScenario, onOverridesChange,
  onAddProposal, onUpdateProposal, onDeleteProposal,
}
```

- Auto-asigna propuestas recién creadas al escenario activo (salvo Base).
- Edición manual con popover por celda.
- Sidebar de propuestas a la izquierda con toggles para activar/desactivar.
- Chart live: Base punteado, Escenario sólido.

### ProposalDrawer

`src/components/ProposalDrawer.tsx` — editor guiado lateral derecho, 4 pasos:

1. Tipo de ajuste (6 opciones con iconos).
2. Rubros donde aplica (targetIds — dinámico según tipo).
3. Parámetros (monto / %, fechas, frecuencia).
4. Nombre + notas.

Al guardar, corre `buildProposalEffects()` para dejar la propuesta lista para
`evaluateScenario`.

## Base scenario — reglas no negociables

- Siempre visible.
- Nunca se elimina.
- No admite propuestas aplicadas.
- No admite overrides manuales.
- Es el punto de comparación permanente.

Valida siempre `isBaseScenario(scenario)` antes de permitir edición.

## Tests existentes

Hay cobertura sobre:

- migración / persistencia
- aislamiento de overrides por escenario
- stacking determinista de efectos
- restauración de celdas
- ajuste porcentual sobre targets agregados

Archivos:

- `src/domain/persistence.test.ts`
- `src/domain/scenarioEngine.test.ts`

(El antiguo `Forecast.test.tsx` se eliminó junto con `Forecast.tsx`).

Antes de cerrar cualquier cambio:

```bash
npm test
npm run build
```

## Riesgos frecuentes

### 1. Reintroducir la capa "Simulación" visible

El usuario la pidió eliminar. Si necesitas agrupar escenarios, consúltalo
antes de añadir esa capa otra vez.

### 2. Romper el Base

Muchos bugs de selección activa terminan forzando propuestas sobre Base o
permitiendo edición manual en Base. Valida siempre:

- `activeScenarioId`
- `isBaseScenario(scenario)`

### 3. Romper datos legacy

Hay simulaciones / scenarios viejos en `localStorage`. La persistencia ya los
rellena, pero la UI también debe ser defensiva (campos opcionales de propuesta,
arrays vacíos, etc.).

### 4. Porcentajes sobre targets sintéticos

No calcules `%` sobre `baseValuesByConceptId` cuando el target sea un r