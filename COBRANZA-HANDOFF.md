# Cobranza JDE + Cruce con Bancos — Handoff

**Para el próximo Claude que tome este branch.** Este archivo resume todo el trabajo hecho en una sesión continua de Cowork (3 may 2026) integrando el endpoint `/JDEdwards/cobranza` (CXC) y cruzándolo contra los movimientos bancarios. Hay bugs abiertos que el usuario sigue viendo en su navegador y que debes resolver.

> Lee también `CLAUDE.md` para el contexto general del repo. Esto es solo el subconjunto cobranza/cruce.

---

## TL;DR de lo que el usuario reporta AHORA

1. **La app crashea seguido** mientras navega. Se removió el campo `raw` de `CobranzaRecord` para bajar el tamaño en localStorage, pero el usuario dice que el problema persiste y "no le aparece el tamaño del app tampoco" (no logra ver el quota).
2. **El KPI "Cobranza cruzada con banco" salía en 0.0%** — corregido en parte (el mapper estaba buscando alias inventados que JDE nunca devuelve). Hay que verificar que ahora cruza tras el fix.
3. **El usuario quiere el calendario** como vista principal del modo Real. Ya se construyó `CobranzaRealCalendar`, falta validar que renderiza bien con la data productiva.
4. **El filtro de empresa global no se reflejaba** en la vista Real — ya se sincroniza vía `defaultCia` prop, pero hay que confirmar visualmente.

---

## Lo que se construyó (archivos clave)

### Capa de datos
- `src/services/jde.ts` — `fetchCobranza()` con coma trailing forzada en `cia` (la API la pide así). `mapCobranza()` reescrito con los nombres REALES del API productivo (ver shape abajo). Debug log con prefijo `[cobranza]` la primera vez por sesión.
- `src/services/jdeTypes.ts` — `CobranzaRecord` y `CobranzaRequest`. El campo `raw` ahora es opcional y NO se persiste.
- `src/domain/persistence.ts` — store v6 → v7 con `cobranzaRecords` y `cobranzaLoadedCias`. Migración automática que purga `raw` legacy.
- `src/App.tsx` — auto-fetch secuencial al boot, cache, refresh manual (`refreshCobranza`), surfaces de error a la UI.

### Motor de cruce
- `src/domain/realReconciliationEngine.ts` — el corazón. Cruza `CobranzaRecord` ↔ `BankStatementLine` ABONO en 3 capas:
  - **exact**: monto al céntimo, ventana ±5d (cuando hay `fechaCobro`) o ±60d (cuando solo hay `fechaVence`).
  - **tolerance**: monto ±0.5%.
  - **subset**: 1 ABONO paga 2-4 facturas del mismo cliente, sumas ±0.5%. Requiere mención textual del cliente en el concepto bancario para evitar falsos positivos.
- Targets que se prueban: `bruto`, `bruto - pendiente` (pago parcial), `pendiente`.
- Filtra traspasos internos via `isInternalTransfer` (reusa `netCashFlowEngine`).
- Output: `RealReconciliationMatch[]` por factura + `AbonoEnrichment[]` por ABONO + `RealReconciliationSummary` con KPIs y `ciaBreakdown`.
- Tests: `realReconciliationEngine.test.ts` — 12 tests pasando hasta el último build local.

### UI
- `src/components/CollectionProjection.tsx`:
  - Toggle "Real (JDE) | Proyectada" en el header de la pestaña.
  - `CobranzaRealView` — engloba todo el modo Real.
  - `CobranzaRealCalendar` — calendario mensual con ABONOs por día, heat-map verde, click en día → panel con lista de ABONOs y sus facturas matched.
  - `ClientAgingTable` — top 20 clientes con buckets de antigüedad (porVencer, 1-30, 31-60, 61-90, 90+) y % cruzado por cliente.
  - Tabla raw filtrable + export CSV con columnas de cruce.
- `src/components/Bancos.tsx` — pill `✓ Factura X` o `Sin factura` en cada ABONO no-interno.
- `src/components/Dashboard.tsx` — banner KPI con % cruzado, saldo CXC, total cobrado. Tiene un panel "Diagnosticar bajo cruce" con `ciaBreakdown`.
- `src/components/CruceDetailModal.tsx` — modal hecho pero **NO cableado todavía** (Fase 4.2/4.3 quedó pendiente al pivotear a fixes). Está listo para usar como drill-down.

---

## Shape REAL del API productivo (validado 2026-05-03)

POST `https://api.gruposenda.com/JDEdwards/cobranza`

**Body:**
```json
{ "cia": "00011,", "fechaInicial": null, "fechaFinal": "2026-04-29" }
```
La coma trailing en `cia` NO es typo. El cliente la pide así. `fechaInicial: null` trae todo el histórico hasta `fechaFinal`.

**Response (campos relevantes):**
```json
{
  "status": 200,
  "success": true,
  "data": [
    {
      "Cia": "00001",
      "No_Cliente": 99999988,
      "Nombre_Cliente": "RITA PRADO VAZQUEZ                ",
      "RFC": "PAVR7405221A9       ",
      "Factura": "RI-85022",
      "Dias_Credito": "1  ",
      "Fecha_Factura": "2025-05-05T00:00:00",
      "Fecha_Vencimiento": "2025-05-06T00:00:00",
      "Fecha_Pago": "2025-05-12T00:00:00",
      "Fecha_Contable": "2025-05-05T00:00:00",
      "Dias_Fecha_Vencimiento_vs_Fecha_Pago": 6,
      "TasaFiscal": "EXTO           ",
      "SubTotal": 1155.44,
      "Importe_IVA": 0,
      "Importe_RETENCION": 0,
      "Importe_Factura": 1155.44,
      "Importe_Pendiente": 0,
      "Observaciones": "VENTAS ABRIL 2025                       ",
      "UUID_Fiscal": "..."
    }
  ]
}
```

**Notas críticas del shape:**
- `No_Cliente` es **número**, no string. El mapper convierte con `toStr`.
- `Nombre_Cliente` viene **padded con espacios**. `toStr` hace trim.
- Fechas vienen como `"YYYY-MM-DDT00:00:00"` (sin TZ). El mapper trunca a `YYYY-MM-DD` para evitar `Date()` inválidos.
- `Importe_Factura` = SubTotal + IVA − RETENCION. Es el gross final, lo que se compara contra el ABONO bancario.
- `Importe_Pendiente == 0` ⇒ factura cobrada en JDE. `Fecha_Pago` está poblado.
- API NO devuelve `moneda`. Default a MXN (todas las facturas son MXN según el equipo de tesorería).
- API NO devuelve `estatus`. Se deriva: `pendiente > 0 → PENDIENTE`, `pendiente = 0 + Fecha_Pago → COBRADA`, raro → `CANCELADA`.

---

## Configuración de entorno

`.env.local` debe usar placeholders o credenciales locales rotadas (no commitear):
```
JDE_TOKEN=<server-side-jde-token>
VITE_JDE_UPSTREAM=https://api.gruposenda.com/JDEdwards
VITE_JDE_ENVIRONMENT=PD920
```

El browser debe llamar a `/api/jde`; Vite local o Atlas/backend inyectan el Bearer fuera del bundle.

---

## Bugs abiertos / por validar

### 🔴 P0 — La app crashea
**Síntomas reportados:** "Sigue crasheando mucho" y "no me aparece el tamaño del app tampoco" (al revisar localStorage no logra ver el quota).

**Hipótesis a investigar (en orden):**
1. **Memory leak en el motor de cruce.** `reconcileRealCollections` recomputa con cada cambio de `cobranzaRecords` o `bankStatements`. Si hay 10k+ facturas y 5k+ ABONOs, el subset-sum O(N · combinatorial) puede saturar el GC. Considerar:
   - Cap de facturas pendientes por cliente al subset-sum (actualmente cualquier cantidad → puede explotar combinatoriamente).
   - Bail-out si el cliente tiene más de N facturas abiertas (skip subset, usar solo capa 1/2).
   - Web Worker para correr el motor fuera del main thread.
2. **Render de tablas grandes.** Aging table no virtualiza. Con 100+ clientes la tabla pinta todo. La raw table tiene cap a 500 filas pero el resto queda en memoria. Considerar:
   - `react-window` o virtualización propia.
   - Lazy expansion (solo render visible).
3. **localStorage gigante.** Aunque ya se quitó `raw`, el store puede seguir creciendo si JDE retorna 30-50k facturas. Cuando excede 5MB, `setItem` lanza `QuotaExceededError`. Hoy se silencia pero la app sigue trabajando con state en memoria que no se persiste — al recargar pierde todo y vuelve a hacer 8 llamadas secuenciales a JDE (60s cada una). Considerar:
   - Cap superior en cantidad de records persistidos (ej. solo últimos 90 días).
   - IndexedDB en lugar de localStorage para datasets grandes.
4. **Re-render loop.** Si algún `useEffect` con dependency mal calculada cicla. Sospechosos: el sync `defaultCia → ciaFilter` en `CobranzaRealView`, los memos de `matchByFactura`. Verificar con React DevTools profiler.
5. **HMR + Vite.** Si el dev server crashea (no el navegador), puede ser un loop de tipos en TS. Verificar con `npm run build` (production).

**Cómo reproducir:**
1. `npm run dev`.
2. Abrir pestaña Cobranza → modo Real (JDE).
3. Esperar a que carguen las facturas (auto-fetch al boot).
4. Navegar entre Cobranza/Bancos/Dashboard rápido.
5. Aplicar filtros.

**Qué hacer primero:** Abrir Chrome DevTools → Performance → grabar mientras crashea. Ver si es CPU spike (engine), memory leak (heap snapshot), o React infinite render (Components tab).

### 🟠 P1 — Verificar que el cruce funciona post-fix de mapper
El mapper estaba mapeando `Importe_Factura` a un campo inexistente. Acabo de corregirlo. Hay que validar:

1. Después de un refresh de la app, abrir DevTools → Console y buscar `[cobranza]`.
2. Confirmar que `[cobranza] sample mapped record:` muestra `importeBrutoPesos`, `importePendientePesos`, `fechaVence`, `fechaCobro` con valores reales (no 0/vacíos).
3. Si todo cuadra, el % de cruce en el dashboard debe subir.

### 🟡 P2 — Drill-down bidireccional sin cablear
`src/components/CruceDetailModal.tsx` está hecho pero **no se importa en ningún lado**. Toca cablear:
- En `CobranzaRealView` raw table: click en el `BankBadge` → abre el modal en modo `factura`.
- En `Bancos.tsx`: click en el pill `✓ Factura X` → abre el modal en modo `banco`.
Ambos puntos ya tienen los datos disponibles vía props. El plan estaba documentado en Fase 4.2/4.3 antes del pivote.

### 🟡 P3 — Tests del engine no se han re-corrido en CI
12 tests pasaban en la última corrida válida. Hubieron cambios pequeños al engine (target = bruto - pendiente, daysBetween defensive). Correr `npm test` en local para validar.

---

## Cómo está cableado el flujo

```
App.tsx
├── auto-fetch /cobranza al boot (secuencial por cia)
├── auto-fetch /bancos al boot (range mode, último año)
├── reconcileRealCollections(cobranzaRecords, bankStatements) [memoizado]
├── buildFacturaIndex(matches) [memoizado]
├── buildAbonoIndex(enrichments) [memoizado]
└── pasa todo como props a:
    ├── <CollectionProjection cobranzaReconciliation= ... />
    │   └── <CobranzaRealView>
    │       ├── <CobranzaRealCalendar>  ← vista principal
    │       ├── <ClientAgingTable>
    │       └── tabla raw + export CSV
    ├── <Bancos abonoEnrichmentIndex= ... />
    │   └── pill en cada ABONO
    └── <Dashboard cobranzaReconciliation= ... />
        └── KPI banner + diagnose panel
```

---

## Decisiones de diseño que conviene preservar

1. **El motor se computa UNA vez en `App.tsx`** y se pasa hacia abajo. Antes cada componente lo recomputaba — destructor de performance. Si tocas esto, mantenlo memoizado arriba.
2. **Filtro de cía sincronizado**: el header global `selectedCia` baja a `CollectionProjection` como prop y se aplica como filtro inicial dentro de `CobranzaRealView`. Cambios al global se reflejan abajo via `useEffect` con dependencia en `defaultCia`.
3. **Default mode = `real` cuando hay datos JDE**, `projected` cuando no. El toggle aparece desde que hay catálogo de empresas (no espera a tener data) para que el usuario pueda dar refresh manual.
4. **Tolerancias del cruce** (`AMOUNT_TOLERANCE_PCT = 0.005`, `DATE_WINDOW_DAYS = 60`, `COBRO_WINDOW_DAYS = 5`) son constantes en el engine. Si el negocio pide aflojar/apretar, son los pomos.
5. **Subset-sum acotado a 4 facturas máx**. Más allá es exponencial. Si SEDENA u otro cliente paga >4 facturas con un solo ABONO, hay que iterar el algoritmo.
6. **El `raw` field NO se persiste**. Si necesitas inspeccionar campos no mapeados, está el log `[cobranza] sample raw record:` en consola, o agregar un flag dev `VITE_COBRANZA_KEEP_RAW=1` (pendiente).

---

## Comandos útiles

```bash
# Typecheck rápido (lo que más uso para validar después de un cambio)
npx tsc --noEmit

# Tests del motor de cruce específicamente
npx vitest run src/domain/realReconciliationEngine.test.ts

# Build de producción (más estricto, atrapa cosas que dev no)
npm run build

# Limpiar localStorage del usuario (para testing desde cero)
# En consola del browser:
localStorage.removeItem('midas-v7'); location.reload();

# Ver el shape exacto que JDE responde
# En consola del browser, después del primer fetch:
JSON.parse(localStorage.getItem('midas-v7')).data.cobranzaRecords.slice(0, 1)
```

---

## Tareas pendientes priorizadas

| # | Pri | Qué | Dónde |
|---|-----|-----|-------|
| 1 | 🔴 | Reproducir crash y profile con Chrome DevTools | runtime |
| 2 | 🔴 | Si es memory: virtualizar tablas o agregar Web Worker para el engine | `realReconciliationEngine.ts`, `CollectionProjection.tsx` |
| 3 | 🔴 | Si es localStorage: cap de facturas persistidas o switch a IndexedDB | `persistence.ts` |
| 4 | 🟠 | Validar que el cruce funciona ahora (console logs `[cobranza]`) | runtime |
| 5 | 🟡 | Cablear `CruceDetailModal` en CobranzaRealView y Bancos | `CollectionProjection.tsx`, `Bancos.tsx` |
| 6 | 🟡 | Re-correr tests `npm test` y arreglar fallidos | runtime |
| 7 | 🟢 | Considerar agregar Excel export (no solo CSV) | `CollectionProjection.tsx` |
| 8 | 🟢 | Drill-down: clic en una factura abre la pestaña Bancos pre-filtrada | nuevo |

---

## Cómo arrancar la próxima sesión

Pegale a Claude esto al iniciar:

> Lee `COBRANZA-HANDOFF.md` y `CLAUDE.md`. El proyecto es Midas (FlowSense). Estoy trabajando en la integración del API de cobranza JDE y su cruce contra movimientos bancarios. La app me sigue crasheando — empieza por el #1 de la tabla de tareas pendientes: reproduce el crash, hazle profile en DevTools, y dime qué encontraste antes de tocar código.

Si Claude empieza a refactorizar sin entender el crash, **frenarlo**. La causa root del crash NO está confirmada todavía y cualquier fix prematuro puede empeorarlo.
