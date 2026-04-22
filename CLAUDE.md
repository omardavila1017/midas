# CLAUDE.md

## Propósito

Este archivo resume el contexto operativo real de `midas` (antes `flowsense`) para cualquier agente que vaya a tocar el proyecto.

`README.md` y `ARCHITECTURE.md` ya fueron alineados con el estado actual del repo, pero el código sigue siendo la fuente final de verdad. Los archivos más importantes para validar comportamiento son:

- `src/App.tsx`
- `src/types.ts`
- `src/domain/persistence.ts`
- `src/domain/scenarioEngine.ts`
- `src/domain/simulationCompiler.ts`
- `src/components/ProposalCreator.tsx`
- `src/components/Simulator.tsx`
- `src/components/Forecast.tsx`

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

## Regla crítica: semántica de negocio vs nombres internos

La UI y el lenguaje de negocio ya NO coinciden 1:1 con los nombres internos de TypeScript.

### Lenguaje que debe ver el usuario

- `Escenario Base`: pronóstico original, siempre visible, no editable, no eliminable.
- `Simulación`: contenedor superior donde el usuario guarda un análisis.
- `Escenario`: agrupación guardada dentro de una simulación.
- `Propuesta`: ajuste financiero reusable que se asigna a uno o varios escenarios.

### Nombres internos actuales

En código todavía existe esta equivalencia:

- `Proposal` = lo que en UI se presenta como una **Simulación**
- `Scenario` = **Escenario**
- `Simulation` = lo que en UI se presenta como una **Propuesta**

Además:

- `Scenario.simulationIds` realmente significa: IDs de **propuestas** aplicadas al escenario.
- `EvaluatedCell.simulationContributions` realmente representa contribuciones de **propuestas** aplicadas.

Si cambias algo de esta zona, mantén esta compatibilidad mental para no invertir otra vez el modelo.

## Estado global actual

El estado principal vive en `src/App.tsx`.

Campos importantes:

- `plan`
- `proposals`
- `scenarios`
- `simulations`
- `scenarioCellOverrides`
- `activeProposalId`
- `activeScenarioId`
- `forecastGranularity`

Selección activa:

- Si `activeScenarioId === BASE_SCENARIO_ID`, la app entra en modo Base.
- En modo Base, `activeProposalId` debe quedar en `null`.
- `selectScenario()` y la normalización del store ya contemplan esto.

## Modelo de datos actual

Definiciones en `src/types.ts`.

### Base

- `BASE_SCENARIO_ID = 'scenario-base'`
- `BASE_SCENARIO_NAME = 'Escenario Base'`

### Proposal

Internamente sigue siendo:

```ts
Proposal {
  id,
  name,
  description,
  status,
  activeScenarioId?,
  createdAt,
  updatedAt
}
```

En UI esto se interpreta como una **Simulación**.

### Scenario

```ts
Scenario {
  id,
  proposalId,
  kind,
  name,
  description,
  probability,
  startYearMonth,
  horizonMonths,
  simulationIds[],
  locked?,
  createdAt,
  updatedAt
}
```

En UI esto es un **Escenario**.

### Simulation

```ts
Simulation {
  id,
  name,
  description,
  category,
  type,
  targetIds[],
  startYearMonth,
  endYearMonth?,
  startDate?,
  endDate?,
  frequency?,
  operation?,
  amount?,
  percent?,
  installments?,
  customAllocation?,
  shiftMonths?,
  shiftRatio?,
  paymentLabel?,
  comments?,
  effects[],
  createdAt,
  updatedAt
}
```

En UI esto es una **Propuesta**.

## Persistencia

La persistencia vive en `src/domain/persistence.ts`.

Puntos clave:

- El store actual es `midas-v5` (el legacy `flowsense-v5` se migra tal cual; `flowsense-v4..v1` se migran descartando propuestas/escenarios).
- `normalizeV2Store()` siempre reinyecta el escenario base.
- `normalizeSimulation()` rellena simulaciones antiguas que no tengan los campos nuevos (`type`, `targetIds`, `startYearMonth`, etc.).
- Si hay datos legacy, se migran a la estructura actual sin perder overrides.

### Regla importante

No asumas que el `localStorage` tiene objetos completos. La UI debe tolerar datos parciales y la persistencia debe seguir normalizando.

## Motor de cálculo

La fuente de verdad del forecast es `src/domain/scenarioEngine.ts`.

### Orden de cálculo

El orden actual es:

1. Base del plan
2. Propuestas activas del escenario
3. Overrides manuales por celda
4. Recomputar métricas y KPIs

La función principal es:

```ts
evaluateScenario(plan, proposal, scenario, simulations, overrides, { granularity? })
```

### Reglas importantes del motor

- Los overrides son por `scenarioId`, no globales.
- Solo celdas hoja son editables manualmente.
- Subtotales y filas derivadas no deben aceptar override.
- El Base no admite edición manual.
- El mismo motor soporta `monthly`, `weekly` y `daily`.
- La vista semanal sale de `weeklyData`.
- La vista diaria se deriva repartiendo cada semana en 7 días.
- Los overrides manuales siguen siendo mensuales y se reflejan en semana / día.

### Targets sintéticos

Existen estos targets globales:

- `ROLE_TARGET_INCOME`
- `ROLE_TARGET_EXPENSE`
- `ROLE_TARGET_COLLECTIONS`
- `ROLE_TARGET_PROVIDER_PAYMENTS`

### Bug ya corregido

Los ajustes porcentuales globales (`+10% ingresos`, `-5% egresos`, etc.) antes no se reflejaban bien porque tomaban base `0` en esos targets sintéticos.

Eso ya quedó corregido en `evaluateScenario()` calculando una base agregada separada para:

- ingresos
- egresos
- cobranza
- pagos a proveedores

No reviertas esta lógica por accidente.

## Compilación de propuestas a efectos

La capa que convierte la propuesta de negocio en efectos homogéneos vive en:

- `src/domain/simulationCompiler.ts`

Funciones importantes:

- `buildSimulationEffects()`
- `ensureBaseScenario()`
- `isBaseScenario()`
- `createBaseScenario()`

Tipos soportados actualmente:

- `percent_adjustment`
- `amount_adjustment`
- `recurring_series`
- `installment_plan`
- `timing_shift`
- `pause_expense`

Todos terminan compilando a `concept_delta`.

## Propuestas: comportamiento dinámico del formulario

La pantalla de Propuestas está en `src/components/ProposalCreator.tsx`.

### Qué hace hoy

- Expone 3 pasos visibles:
  - Simulación
  - Escenario
  - Propuestas
- Muestra un resumen de contexto arriba:
  - simulación activa
  - escenario activo
  - cuántas propuestas están activas
- En el formulario de propuesta, los conceptos disponibles cambian dinámicamente según:
  - `type`
  - `category`

### Ejemplos

- Si el usuario elige incremento de ingresos, debe ver solo ingresos relevantes.
- Si elige reducción de costos, debe ver solo gastos relevantes.
- Si elige mover cobros/pagos, debe ver cobranza o pagos.
- Puede seleccionar uno o varios conceptos.

### Regla importante

No vuelvas a mostrar siempre el mismo selector plano de conceptos. El usuario pidió explícitamente una experiencia dinámica:

- primero define qué quiere hacer
- luego el sistema muestra en qué conceptos puede aplicarlo

## Forecast

La tabla de forecast está en `src/components/Forecast.tsx`.

### Reglas importantes

- Debe poder mostrar:
  - Base
  - Simulado
  - Manual
  - Diff
- El Base es solo lectura.
- El popover de una celda muestra:
  - valor base
  - delta de propuestas
  - valor simulado
  - delta manual
  - valor final
  - diff vs base
  - comentarios

### Terminología

En la UI ya se habla de:

- `Impactada por propuesta`
- `Propuestas aplicadas`

Pero internamente los nombres de tipos siguen siendo `simulationContributions`.

## Simulator

La vista de análisis está en `src/components/Simulator.tsx`.

### Qué debe representar

- Árbol de trabajo: simulaciones y escenarios
- KPIs contra Base
- Caja base vs escenario
- Comparación entre escenarios
- Biblioteca lateral de propuestas activables

### Regla de negocio

Si editas una propuesta, el cambio debe reflejarse en todos los escenarios donde esa propuesta esté asignada.

Eso hoy ocurre naturalmente porque el escenario solo guarda IDs de propuestas.

## Base scenario

El `Escenario Base` es un caso especial:

- siempre visible
- no se elimina
- no admite simulaciones/propuestas aplicadas
- no admite overrides
- es el punto de comparación permanente

Si tocas selección, persistencia o UI de escenarios, esta regla no se negocia.

## Tests existentes

Actualmente hay cobertura sobre:

- migración / persistencia
- aislamiento de overrides por escenario
- stacking determinista de efectos
- restauración de celdas
- ajuste porcentual sobre targets agregados
- smoke test de edición en Forecast

Archivos:

- `src/domain/persistence.test.ts`
- `src/domain/scenarioEngine.test.ts`
- `src/components/Forecast.test.tsx`

Siempre corre:

```bash
npm test
npm run build
```

## Riesgos frecuentes

### 1. Invertir otra vez la terminología

El error más común aquí es volver a mezclar:

- simulación
- escenario
- propuesta

Antes de renombrar o mover algo, revisa cómo lo entiende el usuario y cómo está guardado realmente.

### 2. Romper el Base

Muchos cambios de selección activa pueden forzar accidentalmente un `proposalId` o permitir edición manual en Base.

Valida siempre:

- `activeScenarioId`
- `activeProposalId`
- `isBaseScenario()`

### 3. Romper simulaciones legacy

Hay datos guardados con estructura vieja. No asumas presencia de:

- `targetIds`
- `type`
- `startYearMonth`

La persistencia ya lo compensa; la UI también debe ser defensiva.

### 4. Porcentajes sobre agregados

No calcules `%` sobre `baseValuesByConceptId` cuando el target sea sintético global. Usa la base agregada ya preparada en el motor.

### 5. UI demasiado compleja

El usuario ha pedido varias veces que Propuestas sea más fácil de entender.

Cuando hagas UX en esa zona:

- prioriza preguntas simples
- muestra pocos controles a la vez
- cambia los conceptos disponibles según el tipo de ajuste
- evita meter demasiados campos visibles de golpe

## Si vas a seguir mejorando este módulo

El siguiente paso natural de UX sería convertir la creación de propuestas en un flujo aún más guiado, por ejemplo:

1. ¿Qué quieres cambiar?
2. ¿En qué rubros aplica?
3. ¿Cuánto cambia?
4. ¿Desde cuándo y con qué frecuencia?

Ese camino está alineado con lo que el usuario quiere.

## Resumen corto para no equivocarte

- UI:
  - Simulación > Escenario > Propuesta
- Código:
  - Proposal > Scenario > Simulation
- Base:
  - siempre existe
  - nunca editable
- Forecast:
  - base -> propuestas activas -> override manual
- Propuestas:
  - formulario dinámico según el tipo de ajuste
- Antes de cerrar:
  - `npm test`
  - `npm run build`
