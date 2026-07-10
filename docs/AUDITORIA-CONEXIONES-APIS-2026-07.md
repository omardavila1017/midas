# Auditoría del sistema de conexión de APIs (2026-07-10)

Auditoría del sistema completo de conexiones API de Midas, cruzada contra la tabla
"Mapa de APIs" entregada por el usuario (Excel, 17 filas: Módulo · Submódulo ·
¿Tiene API? · ¿Qué API? · ¿A qué módulo le habla?). Complementa (no reemplaza)
`docs/MAPA-CONEXIONES-APIS.md` (mapa de cruces entre APIs) y
`AUDITORIA-INTEGRACION-MODULOS.md`.

## 1. Por qué el sistema es así (el "why")

El diseño tiene una sola idea rectora: **el navegador nunca habla directo con los
sistemas fuente ni carga secretos**. Todo pasa por proxies same-origin:

```
Browser ──► /api/jde/*               ──► JDE Orchestrator (ERP: bancos, CXP, cobranza,
        ──► /api/tress/Nomina        ──► TRESS (nómina)      compras, pagos, auxiliar)
        ──► /api/citi/roldiario      ──► CITI (viajes ROL)
        ──► /api/viajes-especiales/* ──► SENTUR (viajes especiales)
        ──► /api/openai/*            ──► OpenAI (Midas AI; key server-side)
        ──► /api/auth/*              ──► backend de sesión (cookie HttpOnly)
        ──► /api/store/*             ──► store compartido (APAGADO, VITE_STORE_ENABLED=false)
```

- **Dev:** proxies de Vite (`vite.config.ts`). **Prod:** funciones serverless en
  `api/*/[...path].ts` vía `createApiProxy` (tokens `JDE_TOKEN`/`OPENAI_API_KEY`/…
  solo server-side).
- **Capa de fetchers tipados** (`src/services/jde.ts` + `jdeClient.ts`): timeout
  240s, 2 reintentos (408/502/503/504), backoff con jitter cap 4s, pool de 10
  requests concurrentes.
- **Cache IDB por día/mes** (`dailyApiCache.ts`) + ventanas de revalidación
  selectiva (días vacíos/parciales, OCs vivas) + clear-on-entry para matar deriva
  entre navegadores.
- **Los módulos NO llaman APIs**: consumen datasets que `AppCore.tsx` carga por
  permiso (`TAB_DATASETS` ∩ `allowedDatasets`) y los motores (MOTOR 1 histórico /
  MOTOR 2 corto plazo / conciliación Auxiliar×Bancos) cruzan esos datos.

Ese "porqué" es sólido: seguridad (cero tokens en bundle), resiliencia (retry/
timeout/pool en un solo choke point), y costo (cache + delta-sync en vez de
repegar al ERP).

## 2. Inventario real de endpoints vs la tabla del Excel

| Endpoint real | Fetcher | Consumidores reales (datasets → tabs) | ¿En el Excel? |
|---|---|---|---|
| `POST /api/jde/antiguedadsaldos` | `fetchAgedBalances` | `cxp` → CXP, Concurso, Proyección, Planeación, Impuestos, KPIs | ✅ |
| `POST /api/jde/bancos` | `fetchBankStatements(Range)` | `banks` → Flujo Neto, Bancos, Fideicomiso, Cobranza (cuadre), Pagos (cruce), Concurso, Impuestos, KPIs, MOTOR 1 | ⚠️ subestimado (dice solo Concurso/Fideicomiso) |
| `POST /api/jde/cobranza` + `cobranzaindicadores` | `fetchCobranza*` | `cobranza` → Cobranza, Venta, Proyección, Planeación, Impuestos, KPIs | ✅ |
| `POST /api/jde/compras` | `fetchComprasRange` | `compras` → Compras, Pasivo por Distribuir, Pagos, Proyección, Planeación, Impuestos, KPIs | ✅ |
| `POST /api/jde/pagoproveedor` | `fetchPagoProveedorRange` | `pagos` → Pagos, CXP, Proyección, Planeación, Impuestos | ✅ |
| `POST /api/jde/AuxiliarContable` | `fetchAuxiliarContableRange` + fetch IVA separado | `auxiliar` → Conciliación, IVA real de Impuestos, histórico re-sourceado de Proyección/Planeación, KPIs | ❌ **AUSENTE** |
| `GET /api/jde/empresas` | `fetchCompanies` | Global (selector + loaders por cía) | ✅ |
| `POST /api/tress/Nomina` | `fetchNomina` | `nomina` → Nómina, Proyección, Planeación, Impuestos, KPIs | ✅ |
| `POST /api/citi/roldiario` | `fetchRolRange` | `rol` → Cobranza (cruce), Venta, **MOTOR 2 (proyección)**, KPIs | ⚠️ (lo liga a "Catálogo Clientes", ver 3.4) |
| `POST /api/viajes-especiales/Servicios` | `fetchViajesEspecialesRange` | comparte slot `rol` → MOTOR 2 (`cxc:especial:`), catálogo de clientes (grupo) | ❌ **AUSENTE** |
| `/api/openai/*` | `openaiClient` | Midas AI (propuestas) | ✅ |
| `/api/auth/*` | `authApi` | Login/sesión/contraseñas | ❌ AUSENTE |
| `/api/store/*` | `remoteStore` (apagado) | Sync de planeación + snapshot (Fase 1, OFF) | ❌ AUSENTE |
| `/api/cognos/*` | **nadie** | proxy muerto | ❌ AUSENTE (correcto no listarlo, pero hay que borrarlo) |

## 3. Falacias encontradas

### En la tabla del Excel

1. **"Proyección financiera / Planeación: NO tiene API" — falso en la práctica.**
   No tienen endpoint propio, pero son los consumidores **más grandes** del
   sistema: 7 datasets cada una (`cxp, cobranza, compras, pagos, nomina, rol,
   auxiliar`). Tratarlas como "sin API" oculta que un fallo en cualquiera de las
   7 APIs las degrada. Lo mismo Impuestos ("NO"): consume 7 datasets + el fetch
   dedicado de IVA del libro mayor (`auxiliarcontable-iva`).
2. **Falta AuxiliarContable — la omisión más grave.** Es la columna vertebral:
   conciliación Auxiliar×Bancos (verdad contable), IVA acreditable REAL, y el
   re-sourceo del histórico de Proyección/Planeación. Cualquier mapa sin este
   endpoint describe otro sistema.
3. **Faltan Viajes Especiales, `/api/auth` y `/api/store`.**
4. **"Catálogo Clientes ← /api/citi/roldiario" y "Catálogo Proveedores ←
   /api/jde/pagoproveedor" — falso.** Ambos catálogos son **JSON estático
   bundleado** (`public/clientes-db.json` vía `loadClientsCatalog`;
   `src/assets/providerCatalog.json`). Ninguna API los alimenta. Lo que sí existe
   son *overlays* de runtime parciales: `/cobranza` parcha `creditDays`/
   `frequency` del cliente; `/compras` deriva días de crédito del proveedor;
   Viajes Especiales promueve clientes a su grupo. La tabla describe la
   **aspiración** (catálogos vivos desde el ERP), no la realidad.
5. **"Catálogo Bancos → habla a Concurso/Fideicomiso"** — `/bancos` alimenta
   Flujo Neto, Bancos, la conciliación, Planeación, Impuestos y el cuadre de
   Cobranza; Concurso/Fideicomiso son consumidores menores.
6. **Direccionalidad confusa.** La columna "a qué módulo le habla" mezcla dos
   relaciones distintas: (a) qué módulo *consume* el dataset y (b) qué motor
   *cruza* dos APIs. El mapa real de cruces (folio/UUID/monto/fecha) está en
   `docs/MAPA-CONEXIONES-APIS.md` §2.

### En el sistema real

7. **Proxy `/api/cognos` muerto.** Existe `api/cognos/[...path].ts` + config,
   ningún servicio lo llama (los catálogos son JSON). Candidato a borrar —
   superficie de ataque y confusión gratis.
8. **Doc drift en CLAUDE.md:** documenta timeout de 120s; el código real es
   `DEFAULT_TIMEOUT_MS = 240_000` (`jdeClient.ts:38`). Y el snapshot de handoff
   dice "ROL no proyectado a caja" cuando `buildRolProjectedInflows` SÍ alimenta
   MOTOR 2 (`shortTermProjectionEngine.ts`) desde 2026-06-10 — la nota vieja
   quedó junto a la nueva.
9. **Dos señales vivas de "CXP pagada" que pueden divergir** (documentado como
   abierto en `MAPA-CONEXIONES-APIS.md` §4.1): la conciliación Auxiliar (±10%/45d)
   alimenta el motor, pero los tabs Pagos/CXP/Bancos/Cobranza siguen sobre los
   engines legacy (`realReconciliationEngine`/`paymentReconciliationEngine`,
   ±0.5%/60d). Un usuario puede ver "pagado" en un tab y "pendiente" en otro.
10. **Catálogos estáticos = deriva estructural.** Cliente/proveedor nuevos en JDE
    no existen en Midas hasta re-bundlear. Los overlays de runtime mitigan
    (crédito/frecuencia) pero no crean entidades nuevas. Es la brecha que el
    Excel ya asume cerrada (falacia 4) — señal de que negocio la espera.
11. **Costo de arranque estructural:** clear-on-entry + reconstrucción por
    navegador = ~5,000–7,000 requests (~20–30 min cold boot con splash al 100%).
    Ya hay rediseño diseñado y apagado (snapshot server-side,
    `snapshotRemoteSync.ts` + `MIGRACION-ESTADO-SERVIDOR.md`); el problema no es
    de diseño faltante sino de activación pendiente (backend de Carlos/Javi).

## 4. Veredicto de rediseño

**NO se necesita rediseño estructural.** La arquitectura
proxy same-origin → fetcher tipado → cache IDB revalidable → datasets por
permiso → motores es correcta y ya sobrevivió a las auditorías de cuadre. Un
rewrite introduciría más riesgo del que quita. Lo que sí procede (quirúrgico,
por prioridad):

1. **Borrar `/api/cognos`** (proxy + config + tests de config). Sin consumidores.
2. **Corregir doc drift** (timeout 240s; bullet stale de ROL en handoff).
3. **Terminar la migración de los tabs display a la conciliación Auxiliar** y
   borrar los dos engines legacy — cierra la falacia 9 (única fuente de "pagado").
4. **Catálogos:** decidir con negocio si clientes/proveedores pasan a API (JDE ya
   expone los datos vía cobranza/pagoproveedor) o se formaliza el pipeline de
   re-bundleo. Hoy la tabla de negocio cree que ya es API.
5. **Activar el snapshot server-side** cuando exista el backend — resuelve costo
   de arranque y deriva de una vez (ya construido, `VITE_SNAPSHOT_ENABLED`).
6. **Actualizar el Excel de negocio** con la tabla de §2 (agregar Auxiliar
   Contable, Viajes Especiales, auth; corregir catálogos y el alcance de bancos).
