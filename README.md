# FlowSense

FlowSense es una plataforma de análisis y simulación de flujo de efectivo para empresas de transporte en México. Combina carga de planes desde Excel, módulos operativos de cobranza y pagos, integración con JDE y un motor de pronóstico con escenarios, propuestas y edición tipo Excel.

## Estado actual

El proyecto ya no está en modo stub. Hoy incluye:

- carga y parseo de planes de flujo desde Excel
- dashboard del plan
- módulos de clientes, cobranza y flujo neto
- módulos de proveedores, CXP y bancos
- simulación financiera con:
  - `Escenario Base`
  - `Simulación` como contenedor superior
  - `Escenario` como agrupación guardada
  - `Propuesta` como ajuste financiero reusable
- forecast unificado con:
  - impacto por propuestas
  - overrides manuales por escenario
  - comentarios por celda
  - diff vs base

## Terminología importante

La interfaz y el código no usan exactamente los mismos nombres.

| Lo que ve el usuario | Tipo interno actual | Qué representa |
|---|---|---|
| Simulación | `Proposal` | Contenedor superior del análisis |
| Escenario | `Scenario` | Agrupación guardada dentro de una simulación |
| Propuesta | `Simulation` | Ajuste financiero reusable que se asigna a escenarios |
| Escenario Base | `Scenario` especial | Pronóstico original, fijo y de solo lectura |

Si vas a tocar la lógica, ten esto presente para no invertir otra vez la semántica.

## Flujo funcional

### Plan

El usuario puede cargar un plan desde Excel y navegar:

- `Dashboard`
- `Propuestas`
- `Simulador`
- `Pronóstico`

### Cobros

- `Clientes`
- `Cobranza`
- `Flujo`

### Pagos

- `Proveedores`
- `CXP`
- `Bancos`

### Pronóstico

- `P&L`
- `Flujo de Caja`
- `Drivers`

## Pronóstico y simulación

El motor financiero actual trabaja así:

1. Base del plan
2. Aplicar propuestas activas del escenario
3. Aplicar overrides manuales por celda
4. Recalcular métricas, KPIs, flujo neto, caja final y diff vs base

Reglas importantes:

- El `Escenario Base` siempre existe
- El Base no se puede borrar
- El Base no admite overrides manuales
- Los overrides viven por `scenarioId`
- Los cambios manuales de una celda no contaminan otros escenarios
- Si editas una propuesta, se actualiza en todos los escenarios donde esté asignada

## Formulario de propuestas

La creación de propuestas es dinámica.

Ejemplos:

- si eliges incremento de ingresos, el formulario muestra tipos de ingreso
- si eliges reducción de costos, muestra tipos de gasto
- si eliges mover cobros o pagos, muestra cobranza o pagos relevantes
- se puede seleccionar uno o varios conceptos

Además, el formulario muestra una vista rápida del impacto esperado antes de guardar.

## Setup

```bash
npm install
npm run dev
```

Scripts disponibles:

```bash
npm run dev
npm test
npm run build
npm run preview
```

## Integración con JDE

La app consume APIs de JD Edwards para:

- catálogo de compañías
- antigüedad de saldos de CXP
- estados de cuenta bancarios

### Arranque rápido

```bash
cp .env.example .env.local
# editar .env.local con el token real
npm install
npm run dev
```

Por defecto el proyecto usa el proxy de Vite hacia `/api/jde/*`.

Variables relevantes:

- `VITE_JDE_TOKEN`
- `VITE_JDE_UPSTREAM`
- `VITE_JDE_BASE_URL`

### Endpoints usados

| Endpoint | Método | Uso |
|---|---|---|
| `/JDEdwards/Empresas` | GET | Selector de compañía |
| `/JDEdwards/AntiguedadSaldos` | POST | CXP |
| `/JDEdwards/Bancos` | POST | Bancos |

### Troubleshooting rápido

- `401 Unauthorized`: falta o es inválido `VITE_JDE_TOKEN`
- timeout o network error: el host upstream no es alcanzable
- CORS: usa el proxy de Vite, no pegues al host directo desde el browser

## Estructura del proyecto

```text
src/
  components/
    App shell, dashboard, proposals, simulator, forecast, bancos, cxp, clients, providers
  domain/
    persistence, scenarioEngine, simulationCompiler, collectionEngine, netCashFlowEngine
  services/
    jde, jdeClient, jdeTypes
  utils/
    calculations, excelParser, export
```

Archivos clave:

- `src/App.tsx`: shell principal, tabs y estado global
- `src/types.ts`: tipos base del dominio
- `src/domain/persistence.ts`: store, migraciones y normalización
- `src/domain/scenarioEngine.ts`: motor unificado del forecast
- `src/domain/simulationCompiler.ts`: compila propuestas a efectos
- `src/components/ProposalCreator.tsx`: gestión de simulaciones, escenarios y propuestas
- `src/components/Simulator.tsx`: comparación y workbench
- `src/components/Forecast.tsx`: tabla tipo Excel y overrides

## Persistencia

El estado se guarda en `localStorage` con store versionado.

Puntos importantes:

- el store actual es `flowsense-v2`
- al cargar, siempre se reinyecta el `Escenario Base`
- las propuestas legacy se normalizan si les faltan campos nuevos
- los overrides también se migran al nuevo alcance por escenario

## Tests

Actualmente hay cobertura sobre:

- persistencia y migración
- stacking de propuestas
- overrides por escenario
- restauración de celdas
- porcentajes sobre targets agregados
- smoke test del forecast editable

Ejecuta siempre:

```bash
npm test
npm run build
```

## Documentación adicional

- [ARCHITECTURE.md](./ARCHITECTURE.md): diseño técnico más detallado
- [CLAUDE.md](./CLAUDE.md): contexto operativo para agentes que modifiquen el repo
