# Midas Architecture

## Overview

Midas es una SPA en React + Vite para analizar flujo de efectivo, proyectar escenarios y comparar decisiones financieras antes de ejecutarlas.

El proyecto mezcla tres tipos de capacidad:

1. operación diaria:
   - clientes
   - cobranza
   - proveedores
   - CXP
   - bancos
2. planeación:
   - dashboard del plan
   - simulaciones, escenarios y propuestas
3. forecast:
   - P&L
   - flujo de caja
   - drivers

## Navegación principal

La navegación está centralizada en `src/App.tsx`.

Secciones:

- `Cobros`
  - `Clientes`
  - `Cobranza`
  - `Flujo`
- `Pagos`
  - `Proveedores`
  - `CXP`
  - `Bancos`
- `Plan`
  - `Dashboard`
  - `Propuestas`
  - `Simulador`
- `Pronóstico`
  - `P&L`
  - `Flujo de Caja`
  - `Drivers`

El shell también administra:

- selector de compañía JDE
- carga de plan
- exportación del store
- persistencia en `localStorage`

## Arquitectura de estado

El estado global sigue en `App.tsx` con `useState`.

### Estado principal

- `plan`
- `proposals`
- `scenarios`
- `simulations`
- `scenarioCellOverrides`
- `activeProposalId`
- `activeScenarioId`
- `forecastGranularity`
- `providers`
- `clients`
- `assumptions`
- `confirmedPayments`
- `cxpRecords`
- `cxpLoadedCias`

### Estado de integración JDE

- `companies`
- `selectedCia`
- `companiesLoading`
- `companiesError`
- `bankStatements`
- `bankLastQuery`

### Persistencia

La capa de persistencia está en `src/domain/persistence.ts`.

Responsabilidades:

- cargar store desde `localStorage`
- normalizar stores incompletos
- migrar stores legacy
- guardar automáticamente cambios
- importar y exportar estado completo

## Semántica de negocio actual

Esta parte es crítica porque la UI y los tipos internos no coinciden completamente.

### Cómo lo ve el usuario

- `Simulación`: contenedor superior del análisis
- `Escenario`: combinación guardada dentro de una simulación
- `Propuesta`: ajuste financiero reusable aplicado a escenarios
- `Escenario Base`: forecast original y punto de comparación

### Cómo está tipado hoy

- `Proposal` = simulación
- `Scenario` = escenario
- `Simulation` = propuesta

Además:

- `Scenario.simulationIds` guarda IDs de propuestas
- `EvaluatedCell.simulationContributions` representa contribuciones de propuestas

Este desajuste es deuda técnica conocida. La UI ya está corregida, pero el código interno todavía conserva los nombres viejos.

## Modelo de datos

Tipos base en `src/types.ts`.

### FlowPlan

Plan cargado desde Excel.

Incluye:

- nombre
- año
- caja inicial
- conceptos jerárquicos
- fechas de semanas

### FlowConcept

Línea del flujo de efectivo.

Campos clave:

- `id`
- `excelRow`
- `name`
- `parentId`
- `responsible`
- `conceptType`
- `weeklyData`
- `monthlyData`

Tipos de concepto:

- `ingreso`
- `egreso`
- `resumen`
- `reserva`

### Proposal

Contenedor superior de análisis.

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

### Scenario

Agrupación guardada dentro de una simulación.

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

### Simulation

Ajuste financiero reusable.

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

### ScenarioCellOverride

Edición manual tipo Excel por escenario.

```ts
ScenarioCellOverride {
  key,
  scenarioId,
  conceptId,
  yearMonth,
  baseValue,
  simulatedValue,
  manualValue,
  comment?,
  editedAt
}
```

## Escenario Base

El escenario base es un caso especial y debe mantenerse así en toda modificación futura.

Reglas:

- siempre existe
- siempre es visible
- no se borra
- no recibe propuestas
- no admite overrides
- sirve como comparación permanente

Implementación relevante:

- `BASE_SCENARIO_ID`
- `BASE_SCENARIO_NAME`
- `ensureBaseScenario()`
- `isBaseScenario()`

## Motor financiero

La fuente de verdad del forecast es `src/domain/scenarioEngine.ts`.

### Función principal

```ts
evaluateScenario(plan, proposal, scenario, simulations, overrides, { granularity? })
```

### Pipeline actual

1. construir periodos del escenario
2. construir índices de conceptos
3. cargar base del plan
4. aplicar propuestas activas
5. aplicar overrides manuales
6. recalcular métricas agregadas
7. producir celdas, diffs, KPIs y cambios detectados

### Granularidades soportadas

- `monthly`: usa `monthlyData`
- `weekly`: usa `plan.weekDates` + `weeklyData`
- `daily`: reparte cada semana en 7 días para dar visibilidad operativa día a día

Reglas relevantes:

- el forecast mensual sigue siendo la capa editable para overrides manuales
- semana y día son vistas derivadas del mismo motor, no cálculos separados
- una propuesta con `startDate` a mitad del mes se prorratea según el traslape con cada periodo visible
- los montos puntuales se colocan en el periodo que contiene la fecha exacta

### Métricas derivadas

- ingresos
- egresos
- flujo neto
- caja final
- cobranza
- pagos a proveedores
- saldos finales

### KPIs principales

- ingresos 12m
- egresos 12m
- flujo neto 12m
- caja final
- caja mínima
- cobranza 12m
- pagos a proveedores 12m

### Regla de edición manual

Solo conceptos hoja son editables.

No deben aceptar override:

- subtotales
- filas resumen
- reservas
- métricas derivadas

## Compilación de propuestas

La capa de compilación está en `src/domain/simulationCompiler.ts`.

Convierte propuestas de negocio a efectos homogéneos del motor.

### Tipos soportados en v1

- `percent_adjustment`
- `amount_adjustment`
- `recurring_series`
- `installment_plan`
- `timing_shift`
- `pause_expense`

Todos se compilan a `concept_delta`.

### Targets sintéticos globales

- `ROLE_TARGET_INCOME`
- `ROLE_TARGET_EXPENSE`
- `ROLE_TARGET_COLLECTIONS`
- `ROLE_TARGET_PROVIDER_PAYMENTS`

Esto permite aplicar ajustes generales, por ejemplo:

- `+10% ingresos`
- `-8% egresos`
- atraso en cobranza
- movimiento de pagos a proveedores

## Bug histórico importante

Los porcentajes sobre agregados globales no se reflejaban correctamente porque usaban base `0` en targets sintéticos.

Eso ya fue corregido en `scenarioEngine.ts` con una base agregada separada para:

- ingresos
- egresos
- cobranza
- pagos a proveedores

Si tocas el motor, no reviertas esto.

## Propuestas: arquitectura de UI

La pantalla de Propuestas está en `src/components/ProposalCreator.tsx`.

### Objetivo actual

Hacer que el flujo sea entendible para usuarios no técnicos.

### Estructura actual

1. bloque explicativo superior
2. resumen de contexto:
   - simulación activa
   - escenario activo
   - número de propuestas activas
3. columna izquierda:
   - escenario base
   - simulaciones
4. columna central:
   - escenarios
5. columna derecha:
   - biblioteca de propuestas

### Comportamiento dinámico del formulario

El selector de conceptos cambia según:

- tipo de propuesta
- categoría

Ejemplos:

- ingresos: solo conceptos de ingreso
- costos: solo conceptos de egreso
- timing shift de cobranza: conceptos relevantes de cobranza
- timing shift de pagos: conceptos relevantes de pagos

Además, el formulario incluye:

- pasos visibles
- ayuda contextual
- vista rápida del impacto esperado

## Simulator

La pantalla `src/components/Simulator.tsx` funciona como workbench analítico.

### Responsabilidades

- árbol de simulaciones y escenarios
- KPIs del escenario activo
- comparación vs Base
- detalle mensual
- comparación entre escenarios
- activación o desactivación de propuestas por escenario

## Forecast

La tabla de forecast vive en `src/components/Forecast.tsx`.

### Capas de visualización

- `base`
- `simulated`
- `manual`
- `diff`

### Elementos clave

- selector de simulación
- selector de escenario
- toggles de vista
- tabla tipo Excel
- popover por celda

### Origen visual de las celdas

- base
- propuesta aplicada
- ajuste manual
- comentario

### Popover

Muestra:

- valor base
- delta de propuestas
- valor simulado
- delta manual
- valor final
- diff vs base
- comentarios

## Integración con JDE

Servicios en `src/services/`.

### Módulos

- `jdeClient.ts`: cliente base
- `jde.ts`: funciones de negocio
- `jdeTypes.ts`: tipos de respuesta

### Uso actual

- catálogo de compañías
- CXP
- bancos

La app usa proxy de Vite para evitar problemas de CORS.

## Ingesta de datos

### Excel

La carga del plan está soportada por:

- `src/components/Upload.tsx`
- `src/utils/excelParser.ts`

### Catálogo de clientes

Auto-carga inicial desde:

- `src/domain/loadClientsCatalog.ts`

## Testing

Cobertura actual:

- `src/domain/persistence.test.ts`
- `src/domain/scenarioEngine.test.ts`
- `src/components/Forecast.test.tsx`

Casos cubiertos:

- migración y normalización de persistencia
- stacking de propuestas
- overrides por escenario
- restauración de celdas
- porcentajes sobre targets agregados
- smoke test de edición de forecast

## Deuda técnica conocida

### 1. Nombres internos desalineados

La UI ya usa la terminología correcta, pero el código interno todavía no.

### 2. Estado global en `App.tsx`

Funciona, pero ya concentra mucha responsabilidad.

Si el módulo sigue creciendo, conviene moverlo a una store dedicada.

### 3. Documentación histórica

Antes había docs de MVP con componentes stub. Ya no reflejan el estado real. Mantén este archivo y `README.md` sincronizados con el código.

## Reglas para cambios futuros

- No rompas el `Escenario Base`
- No hagas overrides globales; siguen siendo por escenario
- No conviertas el formulario de propuestas en un selector plano otra vez
- Mantén la UI simple y guiada
- Verifica siempre con:

```bash
npm test
npm run build
```
