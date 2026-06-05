# Auditoría Técnica de Integración de Módulos — Midas

> **Nota de estado (2026-06-05):** este es un snapshot del 2026-05-19 que se conserva como mapa de integración y de riesgos. Parte de su "Fase 1 — Documentación" ya se atendió: `API.md` (reporte de migración Cognos obsoleto) se **eliminó**, `ARCHITECTURE.md` se **reescribió** al estado real, y se limpiaron referencias de despliegue obsoletas. Las menciones a `API.md` más abajo quedan como contexto histórico. El mapa de módulos/APIs y los pendientes (ROL → caja, desacoplar `App.tsx`, registry como fuente oficial) siguen vigentes.

> Fecha: 2026-05-19  
> Alcance: revisión del código fuente real (`src/`, `api/`) para mapear comunicación entre módulos, APIs, persistencia y oportunidades de optimización.

## Resumen ejecutivo

Midas es una SPA React/Vite sin backend propio de negocio. Las APIs externas entran por proxies (`api/jde`, `api/tress`, `api/citi`, `api/openai`, `api/cognos`) y la persistencia vive en `localStorage` + IndexedDB del navegador. `npm run typecheck` pasa limpio.

El núcleo financiero está bien orientado: `App.tsx` trae datos, `financialProjectionService` arma el input, `shared-finance/canonicalProjection` normaliza movimientos, y `financial-planning/scenarioForecastRun` aplica reglas de tesorería. El problema principal no es ausencia de motor, sino fuentes que no llegan al motor o llegan solo a vistas parciales.

Hallazgos principales:

- **P0/P1 — ROL CITI incompleto:** se fetchea y cachea (`rolRecords`) y sí alimenta `CollectionProjection` vía `RolCobranzaPanel`, pero no impacta `FinancialProjection`, `FinancialPlanning` ni `CanonicalProjectionInputs`. Hoy cuesta red/boot y no cambia caja proyectada.
- **P1 — Orquestador monolítico:** `src/App.tsx` tiene 3,584 líneas y concentra boot, fetch, hidratación, persistencia, routing, reconciliación y props hacia tabs.
- **P1 — Persistencia repartida:** ya existe `src/domain/storageRegistry.ts`, pero el estado sigue distribuido entre `midas-v12`, 4 bases IndexedDB y varias keys por módulo. El registro debe volverse la fuente oficial de soporte/documentación.
- **P2 — Docs stale:** `API.md` y partes de `ARCHITECTURE.md` todavía hablan de Cognos/catalog migrations que no reflejan el código actual. `api/cognos` existe como proxy, pero `apiConfig` ya no expone `cognos` y `catalog.service.ts` usa catálogos locales.

---

## Matriz de módulos

| Módulo | Consume | Produce | Consumidores reales | Estado |
|---|---|---|---|---|
| `App.tsx` | JDE, TRESS, CITI, IDB, `localStorage`, catálogos locales | Records globales, reconciliaciones, estado de navegación, props por tab | Todos los dashboards y componentes principales | **Hub central funcional**, pero demasiado grande |
| `services/jde.ts` + `jdeClient.ts` | `/api/jde`, `/api/tress`, `/api/citi` | Records normalizados (`CXPRecord`, `CobranzaRecord`, `ComprasRecord`, `PagoProveedorRecord`, `RolRecord`, nómina, bancos) | `App.tsx`, algunas vistas operativas | Bien tipado; concentra contratos externos |
| `api/*` proxies | Env server-side (`JDE_TOKEN`, `CITI_TOKEN`, `OPENAI_API_KEY`, etc.) | Reenvío seguro a upstreams | Browser vía `/api/*` | Correcto para evitar tokens en cliente |
| `catalog.service.ts` | `public/clientes-db.json`, assets JSON | `Client[]`, `Provider[]` | `App.tsx`, `Clients`, `Providers`, canonical | Local-only; no Cognos runtime |
| `shared-finance/canonicalProjection` | bancos, clientes, proveedores, CXP, cobranza, compras, nómina, reconciliaciones | `CanonicalProjectionResult`, `FinancialMovement[]`, mensual/predictivo | Proyección, Planeación, Taxes | Núcleo integrador |
| `financial-projection` | source canónico, taxes store, planning storage, caches IDB | KPIs, alertas, movimientos, scenario runs | Landing financiero | Bien conectado, pero acoplado a planning |
| `financial-planning` | source canónico, scenarios, adjustments, manual entries, tax/convenio/fideicomiso | `PlanningScenarioRun`, spreadsheet, change log | Planeación y parte de Proyección | Integrador de escenarios |
| `taxes` | CXP, cobranza, compras, nómina, source movements, `midas.taxes.v1` | Obligaciones fiscales, reservas, pagos aprobados | Planeación y Proyección | Conectado; store separado |
| `payroll` | TRESS `/Nomina` | `PayrollCostRecord[]`, KPIs nómina | App, canonical, Taxes | Conectado |
| `concurso-mercantil` | calendario estático, CXP/bancos para vistas | movimientos de convenio | Planning no-base | Conectado por escenario |
| `fideicomiso` | bancos Bajío, config DINA | movimientos Corning/DINA | Planning no-base | Conectado por escenario |
| `midas-ai` | OpenAI proxy, contexto parcial | sugerencias de ajustes | Planning UI | Parcial: contexto financiero limitado |
| `CollectionProjection` + `RolCobranzaPanel` | clientes, cobranza, bancos, ROL | cruces Cobranza/Banco y ROL/Cobranza visibles | Tab Cobranza | ROL tiene consumidor parcial |
| `CXP`, `Bancos`, `Compras`, `Pagos`, `Clientes`, `Proveedores` | records/API/catálogos por dominio | vistas operativas y edits locales | Usuario, App/canonical indirectamente | Conectados vía App |
| `storageRegistry.ts` | lista estática de keys | inventario y `clearAllMidasStorage()` | Soporte/reset | Existe; falta reflejarlo en docs/procesos |

---

## Mapa real de APIs

| API / ruta browser | Upstream / proxy | Método | Consumidor | Datos | Estado |
|---|---|---|---|---|---|
| `/api/jde/empresas` | `api/jde/[...path].ts` → `JDE_UPSTREAM` | GET | `App.loadCompanies()` | compañías JDE | OK |
| `/api/jde/antiguedadsaldos` | JDE | POST | `App`, `CXP` | aging CXP | OK; 1 cía/request |
| `/api/jde/bancos` | JDE | POST | `App`, `Bancos`, canonical, reconciliaciones | estados de cuenta | OK; cache pesado en IDB |
| `/api/jde/cobranza` | JDE | POST | `App`, Cobranza, canonical, Taxes | facturas CXC | OK |
| `/api/jde/cobranzaindicadores` | JDE | POST | `App`, Taxes/reconciliación | recibos/pagos cobranza | OK |
| `/api/jde/compras` | JDE | POST | `App`, Compras, canonical | órdenes/recepciones compra | OK; chunking por rango |
| `/api/jde/pagoproveedor` | JDE | POST | `App`, Pagos, canonical | pagos ejecutados a proveedor | OK |
| `/api/tress/Nomina` | `api/tress/[...path].ts` → TRESS | POST | `App`, `PayrollDashboard` | costos de nómina | OK |
| `/api/citi/roldiario` | `api/citi/[...path].ts` → CITI | POST | `App.refreshRol()` → `CollectionProjection` | viajes ejecutados | **Parcial**: visible en Cobranza, no en caja |
| `/api/openai/chat/completions` | `api/openai/[...path].ts` → OpenAI | POST | `midas-ai/openaiClient` | respuestas del bot | OK; token server-side |
| `/api/cognos/*` | `api/cognos/[...path].ts` | n/a en frontend actual | Ninguno detectado | n/a | **Stale/configurado pero no usado** |
| `/clientes-db.json` | archivo público local | GET | `loadClientsCatalog()` | catálogo clientes | OK local |
| `src/assets/providerCatalog.json` + `src/data/proveedores-clasificacion.json` | bundle local | import estático | `loadProvidersCatalog()` | catálogo proveedores | OK local |

Nota: `API.md` todavía describe Cognos como fuente migrada para catálogos/reportes, pero el código actual no llama Cognos desde `catalog.service.ts` y `apiConfig` no contiene `cognos`.

---

## Grafo de dependencias por subsistema

Grafo estático de imports entre buckets principales:

| Origen | Dependencias relevantes | Lectura |
|---|---|---|
| `App.tsx` | `components`, `domain`, `services`, `modules/financial-*`, `workers` | Orquestador central y punto de acoplamiento |
| `components` | `domain` (50), `services` (16), `formatters`, `utils` | Vistas operativas mezclan UI con lógica de dominio/API |
| `domain` | `services` (41), `shared-finance` (6), `concurso` (2) | Dominio no está totalmente aislado; conoce módulos |
| `services` | `config`, `domain`, `shared-finance` | Capa API con dependencias de tipos/reglas |
| `financial-projection` | `shared-finance` (46), `domain` (28), `financial-planning` (14), `taxes` | Proyección reutiliza planning storage y tax store |
| `financial-planning` | `shared-finance` (52), `domain` (17), `financial-projection` (5), `taxes`, `concurso`, `fideicomiso` | Integrador de escenarios, pero hay acoplamiento bidireccional con Proyección |
| `shared-finance` | `domain` (32), `services` (4), `workers` (2), `financial-*` | Núcleo compartido con algunas dependencias inversas |
| `workers` | `domain`, `financial-planning`, `financial-projection`, `shared-finance` | Offload de cómputo pesado |

Interpretación: la arquitectura nominal es “App → source → canonical → dashboards”, pero en la práctica Proyección y Planeación se importan mutuamente. No es crítico hoy, pero limita modularidad y aumenta riesgo de recomputes/ciclos conceptuales.

---

## Persistencia

Midas no tiene DB propia. Persistencia real:

| Store | Ubicación | Dueño | Uso |
|---|---|---|---|
| `midas-v12` | `localStorage` | `domain/persistence.ts` | store ligero: catálogos, assumptions, loaded keys |
| `midas-heavy-store` | IndexedDB | `services/heavyStoreIDB.ts` | records pesados JDE/TRESS/CITI y bancos |
| `midas-daily-cache` | IndexedDB | `services/dailyApiCache.ts` | cache por día de endpoints JDE |
| `midas-financial-projection-cache` | IndexedDB | `financialProjectionPersistentCache.ts` | source/scenario run cache |
| `midas.financialPlanning.*` | `localStorage` | planning services | scenarios, adjustments, manual entries, overrides, custom rows, change log |
| `midas.taxes.v1` | `localStorage` | `taxModuleService.ts` | obligaciones/ajustes fiscales |
| varias UI/domain keys | `localStorage` | registry | tema, activity feed, overrides, reset/support |

`storageRegistry.ts` ya enumera estas keys y expone borrado coordinado. La brecha actual es operativa/documental: cada módulo sigue guardando por su cuenta y las docs principales no tratan el registry como fuente de verdad.

---

## Conexiones faltantes o incompletas

| Tipo | Origen | Destino esperado | Estado real | Riesgo | Prioridad |
|---|---|---|---|---|---|
| Consumidor parcial | ROL CITI | `canonicalProjection` / Proyección / Planeación | Solo llega a Cobranza UI | Caja proyectada no incluye viajes no facturados; fetch caro sin beneficio financiero | **P0/P1** |
| Consumidor parcial | `buildRolCobranzaCross` | canonical dedupe ROL ↔ CXC | Usado solo por `RolCobranzaPanel` | Al integrar ROL a caja, sin esta dedupe se duplicaría contra cobranza | **P1** |
| Config/documentación stale | Cognos | catálogos/clientes/proveedores | Proxy existe, frontend no lo usa | Confusión operacional; `API.md` promete algo que no corre | **P2** |
| Acoplamiento bidireccional | financial-projection ↔ financial-planning | shared contracts | Imports cruzados y storage compartido | Difícil separar, probar y evitar recomputes | **P1/P2** |
| Persistencia dispersa | módulos varios | `storageRegistry` como fuente oficial | Registry existe, pero no gobierna helpers/docs | Soporte/reset/migraciones frágiles | **P1** |
| Contexto parcial | midas-ai | `source.movements` + escenarios completos | Usa contexto más limitado | Sugerencias con visión parcial | **P2** |

---

## Roadmap recomendado

### Fase 1 — Documentación verificada

- Actualizar `API.md` para reflejar APIs reales: JDE/TRESS/CITI/OpenAI activas, Cognos proxy no usado por frontend, catálogos locales.
- Actualizar `ARCHITECTURE.md` con `storageRegistry.ts`, worker caches, y el estado real de ROL.
- Mantener este reporte como mapa de riesgos y revisar cuando cambien APIs o stores.

### Fase 2 — Quick wins de performance sin rediseño

- Controlar auto-fetch de ROL: si no se integra al canonical de inmediato, hacerlo lazy al abrir Cobranza o behind flag para no pagar `/api/citi/roldiario` en tabs financieros.
- Incluir explícitamente ROL en fingerprints/cache keys solo cuando empiece a impactar source; hoy no debe invalidar proyección porque no participa.
- Revisar props inestables en Proyección/Planeación y conservar el patrón actual de workers + persistent cache.
- Usar `storageRegistry.ts` en documentación de soporte/reset para evitar borrados parciales.

### Fase 3 — Integración ROL → canonical

- Agregar `rolRecords?: RolRecord[]` a `FinancialProjectionSourceInput` y `CanonicalProjectionInputs`.
- Pasar `rolRecords` desde `App.tsx` a `FinancialProjectionDashboard` y `FinancialPlanningDashboard`.
- Agregar ROL a `sourceCacheKey` y `projectionSourcePersistentCacheKey`.
- Emitir `FinancialMovement` solo para viajes predichos/no facturados; usar `buildRolCobranzaCross(rolRecords, cobranzaRecords)` para excluir matches ya facturados y no duplicar CXC.
- Reglas mínimas: `sourceSystem='CITI'`, `category='AR_COLLECTION'`, `subcategory='Clientes Citi'` salvo mapeo de cliente, `status='PROJECTED_BASE'`, fecha proyectada = fecha viaje + crédito/regla de cliente cuando exista; si falta cliente confiable, mantenerlo fuera de caja o emitirlo como baja confianza según decisión de negocio.

### Fase 4 — Extraer orquestación de `App.tsx`

- Crear hook/servicio tipo `useDataOrchestrator` para datasets (`cxp`, `cobranza`, `compras`, `pagos`, `nomina`, `rol`, `banks`).
- Sacar hidratación IDB/localStorage, request gating y boot status del componente visual.
- Mantener `App.tsx` como shell/routing y proveedor de props, no como capa de datos.

### Fase 5 — Consolidar persistencia y docs stale

- Hacer que cualquier key nueva requiera entrada en `MIDAS_STORAGE_REGISTRY`.
- Documentar qué stores son fuente de verdad y cuáles son cache regenerable.
- Eliminar o reescribir secciones Cognos obsoletas en `API.md`/`ARCHITECTURE.md`.

---

## Test plan para próximas fases

Verificación documental:

- Re-ejecutar búsquedas de endpoints (`fetch*`, `jdeClient.post/get`, `/api/*`) antes de cerrar cambios de API.
- Re-ejecutar grafo de imports si se mueve lógica entre módulos.
- Confirmar que cada API listada tenga consumidor real o quede marcada como configurada/no usada.

Verificación técnica mínima:

- `npm run typecheck`
- Si se integra ROL al canonical:
  - `src/modules/shared-finance/calculation-engine/canonicalProjection.test.ts`
  - `src/modules/financial-projection/services/financialProjectionService.test.ts`
  - `src/modules/financial-planning/services/scenarioForecastRun.test.ts`
  - `src/components/CollectionProjection.test.tsx`
  - `src/services/jde.test.ts`

Escenarios de aceptación para ROL:

- Viaje ROL sin factura/UUID en cobranza genera movimiento proyectado una sola vez.
- Viaje ROL con factura encontrada en cobranza no duplica CXC.
- Factura CXC cobrada por banco sigue tomando el banco como verdad realizada.
- Cambiar `rolRecords` invalida source cache solo después de que ROL participe en `FinancialProjectionSourceInput`.

---

## Conclusión

La mejor ruta no es crear otro pipeline financiero: el patrón correcto ya existe y debe mantenerse. La optimización de plataforma pasa por hacer que todas las fuentes reales importantes entren al motor canónico, reducir el costo de fuentes que aún no impactan caja, y bajar el acoplamiento de `App.tsx`.

La prioridad inmediata es decidir ROL: integrarlo al canonical con deduplicación ROL ↔ Cobranza ↔ Banco, o volverlo lazy/feature-flag hasta que pueda impactar caja. Después conviene cerrar la brecha documental de Cognos y hacer que `storageRegistry.ts` sea la referencia operativa oficial de persistencia.
