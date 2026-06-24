# Migración de estado a servidor — guía para el equipo de backend

> **Estado:** propuesta para construcción por el equipo (Carlos / Javi / Norma).
> **Origen:** junta 2026-06-23 (Santiago, Carlos, Javi, Norma).
> **Autor del borrador:** Claude (a petición de Santiago), sobre los tipos reales del código.

Este documento define **qué se necesita server-side** para sacar a Midas de la persistencia 100% client-side (`localStorage` + IndexedDB por navegador), que causa las quejas recurrentes de "datos incorrectos / atorados" y la pérdida de trabajo entre dispositivos.

La decisión de la junta divide el problema en **dos clases de datos**, con tratamiento distinto:

| Clase | Qué es | Decisión | Quién |
|---|---|---|---|
| **A. Cache JDE/TRESS** | cobranza, CXP, compras, pagos, nómina, ROL, auxiliar, estados de cuenta | **NO** persistir/compartir desde el cliente. **Borrar en cada ingreso y recargar fresco del servidor.** | Ya implementado en el front (ver §1) |
| **B. Trabajo del usuario** | escenarios, propuestas, overrides, filas/entradas manuales, change log | Persistir en **BD real con APIs** (insert/consult/update). | **Backend construye tablas + APIs**; el front consume (§2–§4) |
| **C. Usuarios / roles** | roster correo→rol+permisos | Coordinación de alta de usuarios. | Norma + backend (§5) |

---

## 1. Clase A — Cache JDE/TRESS: "clear on entry" (ya implementado en el front)

No requiere trabajo de backend. Se documenta para contexto.

- En **cada ingreso a la app** el front borra los caches de datos JDE/TRESS (las 10 colecciones pesadas + estados de cuenta JDE + cache diario/mensual + cache de proyección) y **recarga todo fresco** del servidor. La carga completa toma ~12–15 min (aceptable por la conexión directa a BD) y garantiza que todos vean el dato más actual al entrar.
- **Se preservan** las cargas manuales de estados de cuenta (Bajío/Santander) y **todo** el trabajo del usuario de la Clase B (hasta que exista la BD que lo reciba; ver §6).
- Implementación: `clearCacheStorageOnEntry()` en `src/domain/storageRegistry.ts`, disparada al boot en `AppCore.tsx`. Cadencia configurable con `VITE_CACHE_MAX_AGE_MIN` (default `0` = cada ingreso; p. ej. `4320` = cada 3 días).

> **Lo único que el backend podría querer ofrecer aquí** (opcional, mejora futura): que la propia carga JDE/TRESS la haga el servidor (un endpoint que entregue el snapshot ya procesado) en vez de que cada navegador la reconstruya. No es requisito de esta fase.

---

## 2. Clase B — Modelo de datos de escenarios / planeación financiera

Todo esto hoy vive en `localStorage`. Son **6 colecciones**. El *keying es GLOBAL / compartido por organización* (un solo workspace de planeación; todos ven lo mismo). Cada registro ya trae `createdBy` / `createdAt` para atribución.

Los tipos canónicos están en `src/modules/shared-finance/types/index.ts`. A continuación, cada entidad y una **propuesta de tabla** (Postgres; ajusten motor/tipos a su stack). Los campos `…At` son ISO-8601 (`timestamptz`). Donde el tipo es una unión cerrada, se anota como `enum`/`check`.

### 2.1 `scenarios` (FinancialScenario)
El contenedor (la UI lo llama **Escenario**). Campos:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string PK | generado por el cliente (uuid/slug) |
| `name` | string | |
| `kind` | enum `BASE` \| `APPROVED` \| `DRAFT` | **invariante:** existe exactamente uno `BASE`, no borrable |
| `description` | string? | |
| `adjustment_ids` | string[] | FKs lógicas a `adjustments.id` |
| `status` | enum `DRAFT`\|`IN_REVIEW`\|`APPROVED`\|`REJECTED`\|`PUBLISHED`\|`EXECUTED` | |
| `is_base` | bool? | |
| `parent_scenario_id` | string? | |
| `created_by` / `created_at` / `updated_at` | string / ts / ts | |
| `approved_by` / `approved_at` / `published_at` / `archived_at` | string? / ts? | |
| `promoted_from_scenario_id` / `promoted_at` | string? / ts? | |

### 2.2 `adjustments` (FinancialAdjustment — la UI lo llama **Propuesta**)

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string PK | |
| `name` | string | |
| `scenario_ids` | string[] | una propuesta puede aplicar a varios escenarios |
| `type` | enum | `DATE_SHIFT`\|`AMOUNT_OVERRIDE`\|`AMOUNT_DELTA`\|`PERCENTAGE_CHANGE`\|`SPLIT_PAYMENT`\|`CANCEL_MOVEMENT`\|`ADD_MOVEMENT`\|`FINANCING_DRAW`\|`RULE_OVERRIDE` |
| `target_type` | enum `MOVEMENT`\|`FILTER_SET`\|`COUNTERPARTY`\|`CATEGORY`\|`DATE_RANGE` | |
| `target_expression` | string | |
| `original_value` / `adjusted_value` | json? | tipo libre (`unknown`) |
| `delta_amount` / `delta_days` / `percentage_change` | number? | |
| `split_config` | json? | `{ numberOfPayments, frequency: WEEKLY\|BIWEEKLY\|MONTHLY\|CUSTOM, dates?: string[] }` |
| `reason_code` | enum | `LIQUIDITY`\|`NEGOTIATION`\|`CRISIS`\|`UPSIDE`\|`FORECAST_CORRECTION`\|`MANAGEMENT_DECISION` |
| `justification` | string | |
| `impact_summary` | json? | `{ cashImpact, deficitDaysReduced, riskChange }` |
| `status` | enum (sin `PUBLISHED`) | |
| `created_by` / `created_at` / `approved_by` / `approved_at` | | |

### 2.3 `cell_overrides` (CellOverride) — ediciones manuales por celda

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string PK | forma `co::{scenarioId}::{granularity}::{conceptKey}::{bucketKey}` |
| `scenario_id` | string FK | |
| `concept_key` / `bucket_key` | string | |
| `granularity` | enum `daily`\|`weekly`\|`monthly` | |
| `type` | enum `INFLOW`\|`OUTFLOW` | |
| `mode` | enum `REPLACE`\|`DELTA` | |
| `value` | number (≥ 0) | |
| `previous_aggregated_value` | number? | |
| `note` | string? | |
| `created_by` / `created_at` / `updated_at` | | |

### 2.4 `custom_rows` (PlanningCustomRow) — filas añadidas al spreadsheet

`id` PK, `scenario_id` FK, `concept_key`, `label`, `type` (`INFLOW`\|`OUTFLOW`), `category` (`AR_COLLECTION`\|`AP_PAYMENT`\|`PAYROLL`\|`TAX`\|`DEBT`\|`CAPEX`\|`OPEX`\|`TRANSFER`\|`MANUAL`), `note?`, `created_by`, `created_at`, `updated_at`.

### 2.5 `manual_entries` (ManualPlanningEntry) — líneas tecleadas a mano

`id` PK, `scenario_ids` string[], `type` (`INFLOW`\|`OUTFLOW`), `category` (`MANUAL_INFLOW`\|`MANUAL_OUTFLOW`\|`SUPPLIER_PAYMENT`\|`TAX_PAYMENT`\|`PAYROLL`\|`CAPEX`\|`OPEX`\|`OTHER`), `name`, `amount`, `start_date`, `end_date?`, `recurrence` (`ONE_TIME`\|`WEEKLY`\|`BIWEEKLY`\|`MONTHLY`\|`QUARTERLY`), `company_id?`, `business_unit_id?`, `counterparty_name?`, `description?`, `tax_treatment` (`IVA_CAUSED`\|`IVA_CREDITABLE`\|`IVA_EXEMPT`\|`UNCLASSIFIED`), `tax_rate?` (0\|8\|16), `tax_base_amount?`, `tax_amount?`, `status` (`DRAFT`\|`APPROVED`), `replaced_by_source_system?`, `replaced_by_source_object_id?`, `replaced_at?`, `replacement_note?`, `created_by`, `created_at`, `updated_at`.

### 2.6 `change_log` (ScenarioChangeLogEntry) — bitácora de auditoría **append-only**

`id` PK, `scenario_id` FK, `kind` (`ADD_ROW`\|`REMOVE_ROW`\|`RENAME_ROW`\|`EDIT_CELL`\|`CLEAR_CELL`\|`CREATE_DRAFT`\|`DUPLICATE_DRAFT`\|`MERGE_TO_APPROVED`), `payload` json, `auto_description`, `user_note?`, `created_by`, `created_at`.
- **Append-only**: nunca se edita ni borra una entrada existente. El front hoy capa a 500 por escenario; el servidor puede capar/retener a su criterio pero sin reescribir histórico.

---

## 3. Contrato de APIs que necesita el front (insert / consult / update)

El front ya tiene un cliente genérico (`src/services/remoteStore.ts`) que habla con el patrón **mismo-origen** `/api/store/*` (proxy en `api/store/[...path].ts`, que en el deployment reenvía a `STORE_UPSTREAM`). Hay **dos formas** de cumplir el contrato; el equipo elige:

### Opción 1 (la más simple — la que el cliente ya consume): store de documentos por namespace
Una colección = un "documento" JSON bajo el namespace `planning`:

```
GET    /api/store/planning/{coleccion}        → { value: <array>, updatedAt }   | 404
PUT    /api/store/planning/{coleccion}        body { value: <array> }            (upsert)
DELETE /api/store/planning/{coleccion}
GET    /api/store/planning                    → [{ key, updatedAt }]   (manifest)
POST   /api/store/planning/batch-get          body { keys: [...] } → { [key]: value }
```
donde `{coleccion}` ∈ `scenarios` \| `adjustments` \| `cellOverrides` \| `customRows` \| `manualEntries` \| `changeLog`.
- Es lo mínimo para que funcione hoy: el front sube/baja cada colección completa. Internamente el backend puede normalizar a las tablas de §2.
- Semántica: `PUT` = reemplazo total de la colección (upsert idempotente, last-write-wins por `updatedAt`).

### Opción 2 (REST por recurso — más natural para BD relacional)
CRUD por entidad, p. ej.:
```
GET    /api/planning/scenarios               (consult — lista)
POST   /api/planning/scenarios               (insert)
PUT    /api/planning/scenarios/{id}          (update)
DELETE /api/planning/scenarios/{id}
```
…y análogo para `adjustments`, `cell-overrides`, `custom-rows`, `manual-entries`. Para `change-log`: sólo `GET` (lista) + `POST` (append); **sin** `PUT`/`DELETE`.
- Si eligen esta opción, el front adapta su capa de cliente (`planningRemoteSync.ts`) — el cambio es **local y aislado**.

### Requisitos transversales (ambas opciones)
- **Auth**: el front llama same-origin con `credentials: 'include'`; el proxy server-side inyecta el token. Confirmar el esquema (cookie de sesión vs. bearer) — hoy el login sigue client-side (§5), así que de momento puede ser un token de servicio del deployment.
- **Tamaño de payload**: la colección más grande (`change_log`, `manual_entries`) es chica (KB–pocos MB). No hay payloads pesados aquí (eso era Clase A, que ya NO se sube).
- **Concurrencia**: last-write-wins por `updated_at` es suficiente para el flujo actual del equipo (pocos editores). Si más adelante hay edición concurrente intensa, evaluar control de versión por registro.
- **Keying**: GLOBAL (un workspace org). No hay partición por usuario en esta fase.

---

## 4. Cómo lo consume el front (ya construido, apagado)

- Cliente: `src/services/remoteStore.ts` (`getDoc`/`putDoc`/`deleteDoc`/`listManifest`/`batchGet`) + `src/modules/financial-planning/services/planningRemoteSync.ts` (write-through al guardar + hidratación una vez al montar).
- **Kill switch:** `VITE_STORE_ENABLED` (default `false`). Encender con `'true'` + `STORE_UPSTREAM` (+ `STORE_TOKEN`, cae a `JDE_TOKEN`) cuando las APIs existan.
- Modelo: **local-first** (render instantáneo desde el mirror local) + **write-through** (cada cambio se publica a la API) + **hidratación al montar** (baja del servidor y siembra local→servidor en la primera corrida). Best-effort: si la API no responde, el front cae al mirror local sin tirar.

---

## 5. Clase C — Usuarios / roles

Hoy el roster vive en `localStorage` (`midas.users.registry.*`) y el login corre client-side. **Sin cambios de código en esta fase** (decisión de Santiago); Norma coordina el alta de usuarios. Modelo para referencia futura (`src/modules/users/services/accessControlStore.ts`):

```
ManagedUser { email: string; role: 'admin' | 'user'; permissions: AppTabId[] }
```
- `admin` ve todo; a un `user` un admin le concede tabs uno por uno (`permissions`).
- Las contraseñas en modo local viven en un overlay `localStorage` (hash SHA-256). Mover esto server-side (sesión real + hash en servidor) es una fase posterior, separada de esta migración.

---

## 6. Secuencia recomendada

1. **Ya hecho (front):** clear-on-entry de los caches JDE/TRESS → todos ven dato fresco al ingresar.
2. **Backend:** construir tablas (§2) + APIs (§3, una de las dos opciones) para escenarios/planeación.
3. **Front:** encender `VITE_STORE_ENABLED` + apuntar a las APIs; validar que el trabajo del usuario persiste y se comparte entre navegadores.
4. **Luego (y SÓLO entonces):** una vez el trabajo del usuario vive en BD, se puede ampliar el clear-on-entry para limpiar también esas keys locales (meta "cero localStorage"). Antes de ese punto, **NO** borrar el trabajo del usuario (se perdería).
5. **Aparte:** usuarios/roles + auth real server-side (Norma + backend).

---

## 7. Entregables que el equipo debe estimar
- [ ] Tablas de §2 (6 colecciones) en la BD.
- [ ] APIs de §3 (insert/consult/update) — elegir Opción 1 o 2.
- [ ] Esquema de auth para `/api/store/*` (o el equivalente REST).
- [ ] (Opcional/futuro) endpoint server-side que entregue el snapshot JDE/TRESS ya procesado.
- [ ] (Futuro) usuarios/roles + auth real server-side.
