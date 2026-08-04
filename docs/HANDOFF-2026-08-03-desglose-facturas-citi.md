# Handoff — Desglose por factura de las celdas de Clientes Citi

**Sesión:** 2026-08-03 · **Rama:** `fix/citi-clientes-planeacion` · **Archivo sin commitear** (decide si lo quieres en el repo o lo borras).

---

## 1. LO PRIMERO: el estado de git no es obvio

| Hecho | Detalle |
|---|---|
| **PR #255 → MERGED** | Se mergeó con **UN solo commit**: `d5b30a9` (helper compartido + desglose en el drawer). Ya está en `main` (merge `5754180`). |
| **2 commits sin PR** | `f84cbcc` (fix del anchor) y `65c1cf9` (desglose inline en el panel) están **pusheados a la rama pero sin PR abierto** — #255 ya estaba cerrado cuando se pushearon. |
| **La rama está 17 commits atrás de `main`** | `main` avanzó con los PRs #248, #250, #251, #252, #253, #254 de otras sesiones. |
| **El merge es limpio** | Verificado con `git merge-tree --write-tree origin/main HEAD` → sin conflictos. |

**Acción 1 (obligatoria antes de cualquier cosa):**

```bash
git checkout fix/citi-clientes-planeacion && git merge origin/main && npm run typecheck && npm run build
```

**Acción 2:** abrir un PR nuevo para los 2 commits pendientes. El cuerpo debe explicar que el desglose de #255 era inalcanzable (ver §3).

**Cuidado — `main` tocó lo mismo que nosotros.** Estos commits nuevos entran en el área del prorrateo Citi y hay que leerlos antes de asumir que algo sigue abierto:

- `f22d428 fix(citi): que el diagnostico del prorrateo llegue al hilo principal` — esto **cierra el latente #1** que quedó documentado en `CLAUDE.md` (el `window.__midas__.citiProrrateo` ciego porque el motor corre en el worker).
- `52ad368 test(worker): pinear el pegamento del buzon del diagnostico Citi`
- `9b66e6c fix(cuadre): blindar el join bankCoverage y no callar el peor caso del prorrateo Citi`
- `4266bce fix(source-worker): fallar los jobs en vuelo cuando el worker muere sin responder`

---

## 2. Qué se entregó

**Problema original (Diego):** en Planeación → Ingresos → **Clientes Citi**, al seleccionar la casilla de un mes el panel del pie de página mostraba **sólo el total**, sin las facturas. Reportado sobre `ARGO PROYECTOS Y ESTRUCTURAS`.

**No era pérdida de datos.** La línea `citi-prorrateo:` es UN movimiento por cliente y mes, y su origen es el **depósito bancario**, no una factura: las facturas sólo se usan como *peso* para repartir el depósito, y el `clientWeights` que alimentaba la línea (`{name, amount}`) ya había perdido los folios.

### `d5b30a9` — ya en `main`

- **`src/modules/shared-finance/calculation-engine/citiClientCollection.ts`** (nuevo) — fuente única de los dos consumidores que TIENEN que coincidir: el motor (peso) y la UI (desglose).
  - `selectCitiCollectionByClient` — un solo pase, agrupa por (cía, mes) → cliente. `wantsGroup` acota los periodos. **El pase único es deliberado:** corre en el recómputo del motor con ~23k facturas.
  - `createCitiClientResolver` — las tres exclusiones del criterio Citi + el mismo `clientDisplayCounterparty` que el motor usa para `counterpartyId`. Eso es lo que permite a la UI encontrar su entrada por ese id.
  - `buildCitiCellBreakdown` — facturas, suma y **factor** de una celda.
- **`canonicalProjection.ts`** — el paso 3 del prorrateo consume el helper. Cero cambio de comportamiento (los 46 tests del prorrateo pasan sin tocarse).
- **`MovementDrillDownDrawer.tsx`** — rama para líneas Citi en `InvoiceDetailSection`.
- **`FinancialPlanningDashboard.tsx`** — pasa `cobranzaRecords` al `invoiceContext` (sin esto la sección "Facturas CXC JDE" recibía lista vacía y NINGÚN ingreso se desglosaba).

### `f84cbcc` — pendiente de PR

**`MovementDrillDownDrawer` nunca había renderizado en ninguna pantalla.** Su guard es `if (!movement || !anchor || !pos) return null` y Planeación pasaba el anchor en `null` justo al seleccionar el movimiento. El desglose de `d5b30a9` quedó dentro de un componente inalcanzable.

Fix: `PlanningCellDetailPanel.onSelectMovement` entrega `event.currentTarget.getBoundingClientRect()` y el call site lo pasa como anchor. Test nuevo `MovementDrillDownDrawer.test.tsx` (3 casos) que renderiza el drawer de verdad — sin anchor el DOM sale literalmente vacío (`<body><div /></body>`), que es cómo se detectó.

### `65c1cf9` — pendiente de PR

El desglose se movió a donde el usuario está mirando: **inline en el panel del pie**, sin segundo clic.

- **`src/modules/shared-finance/components/CitiInvoiceBreakdown.tsx`** (nuevo) — la tabla en módulo propio porque la pintan DOS superficies; importarla desde el drawer arrastraría ese módulo al chunk de Planeación. Modo `compact` para el panel.
- `PlanningCellDetailPanel` ganó props `cobranzaRecords`/`clients` + memo del respaldo por movimiento. La tarjeta pasó de `<button>` a `<div>` con el botón dentro (una tabla anidada en un botón es HTML interactivo anidado).
- El drilldown se conserva para el resto del detalle.

### La invariante que hay que respetar

**El renglón "Factor aplicado" no es decorativo.** `factor = importe atribuido / Σ facturas`. Vale 1 con coincidencia exacta o remanente cubierto, y **< 1 en el reparto proporcional**, donde las facturas NO suman el importe de la línea. Sin declararlo, el desglose se lee como error de captura. Quitarlo cambia un vacío por una mentira.

---

## 3. Qué NO se verificó

1. **El render en el navegador con datos reales.** El componente está probado (3 casos), la cadena completa celda → panel → desglose no se corrió en la app. El dev server se levantó en `localhost:5180` (build `2b775a4a0dde`, cero errores de consola y de compilación) pero se quedó en el login — la contraseña la tiene que capturar el usuario.
2. **`npm test` completo.** Da **40 archivos / 331 tests fallando** y **ése es el estado base de la rama** (verificado con `git stash` de todos los cambios: conteo idéntico). Causa: **Node v26.5.0**; todos los fallos son `localStorage.clear()` con *"localStorage is not available because `--localstorage-file` was not provided"*. El baseline de `CLAUDE.md` es 2673 pasando / 0 fallando. **Correr la suite en el Node del pipeline antes de mergear.** Los 3 archivos que cubren este cambio corren verdes en Node 26.

### Cómo probarlo visualmente

```bash
VITE_CACHE_MAX_AGE_MIN=4320 npm run dev -- --port 5180 --strictPort
```

(el `VITE_CACHE_MAX_AGE_MIN` evita el `clear-on-entry`, que reconstruye todo contra JDE y tarda 20–30 min en cold boot). Login → Planeación Financiera → Ingresos → Clientes Citi → clic en la casilla del mes. El desglose sale en el panel del pie, sin clic extra.

**Caso de prueba con cifras reales** — `ARGO PROYECTOS Y ESTRUCTURAS` (`No_Cliente 55768551`, cía `00011`), **febrero 2026**: 5 facturas sumando **$104,295.60**, factor **1.000**.

| Factura | Fecha factura | Fecha pago | Bruto | Recibo |
|---|---|---|---|---|
| RI-301711 | 2026-01-02 | 2026-02-12 | 13,906.08 | 947475 |
| RI-302177 | 2026-01-16 | 2026-02-12 | 20,859.12 | 947475 |
| RI-302663 | 2026-02-02 | 2026-02-12 | 25,494.48 | 947475 |
| RI-303194 | 2026-02-16 | 2026-02-25 | 20,859.12 | 492202 |
| RI-303794 | 2026-03-02 | 2026-02-25 | 23,176.80 | 492202 |

**Enero 2026 de ARGO debe estar VACÍO** — no tiene cobranza aplicada en enero (sus facturas de enero se cobraron el 12-feb), así que su peso es 0 y el motor lo borra del reparto. Si ahí aparece un importe, eso **sí** es hallazgo.

---

## 4. Datos de referencia (BD real, vía MCP `midas-db`)

**El grupo Citi es la cía `00011`.** Cuenta concentradora: BANAMEX `0678 0038436` ("CONCENTRADORA CLIENTES CITI", cuenta contable `11.10`). En `jde.Bancos` los abonos son `Tipo_Movimiento = 'CREDITO'` (no `'ABONO'`).

### Control mensual 2026 — cía 00011

| Mes | Venta neta (Fecha_Factura) | # fact | Cobrado bruto (Fecha_Pago) | # cobr | Depósito banco | Ratio |
|---|---|---|---|---|---|---|
| 2026-01 | 212,366,690.17 | 1,031 | 210,719,401.14 | 819 | 267,920,524.93 | 0.786 |
| 2026-02 | 205,913,286.60 | 1,123 | 198,822,157.27 | 1,039 | 206,933,853.89 | 0.961 |
| 2026-03 | 237,671,041.46 | 1,434 | 245,525,133.79 | 1,268 | 266,761,774.14 | 0.920 |
| 2026-04 | 207,471,178.87 | 1,288 | 217,218,742.79 | 1,176 | 350,417,120.97 | 0.620 |
| 2026-05 | 265,965,440.39 | 1,411 | 264,969,386.64 | 1,231 | 236,800,677.32 | 1.119 |
| 2026-06 | 234,827,314.41 | 1,338 | 265,628,411.01 | 1,278 | 267,406,111.40 | 0.993 |
| 2026-07 | 241,239,457.26 | 1,213 | 164,692,712.55 | 802 | 368,039,489.55 | 0.447 |
| 2026-08 | 11,188,410.57 | 35 | 0.00 | 0 | — | — |
| **Total** | **1,616,642,819.73** | **8,873** | **1,567,575,945.19** | **7,613** | **1,964,279,552.20** | 0.798 |

Febrero cuadra al centavo con lo que `CLAUDE.md` documenta ($198,822,157.27), o sea que la medición es la correcta.

**Clientes:** 198 con cobro en 2026 · 207 con factura en 2026 · 230 histórico · 42/49 grupos si se colapsa por `Nombre_Cliente_Padre`.

**Anclas exactas** (depósitos que coinciden al centavo con la cobranza de UN solo cliente el mismo día → celdas que **deben** cuadrar sin tolerancia): sólo **5–18%** del depósito mensual. El resto va por reparto proporcional, así que la mayoría de las celdas son aproximaciones **por construcción**, no errores. Cero depósitos ambiguos.

### Suciedad de la fuente (JDE, no es Midas)

- **`999999 CLIENTES CONTADO/PROVEEDOR REPOSICIONES`** — cajón genérico de JDE (RFC `XAXX010101000`, 0 días de crédito, sin padre) usado para ventas de contado **y** reposiciones a proveedores. 2,477 facturas cobradas en 2026 por $63,959,082.16 en la cía 00011; importes de $0.01 a $25,394,904.88. No es un cliente: distorsiona cualquier análisis por cliente. Dos cuentas más con el mismo RFC genérico: `43574661` y `80222876` (**PÚBLICO EN GENERAL**).
- 2,447 facturas de la cía 00011 **sin `Fecha_Pago`**.
- Dos fechas de pago inválidas: una en **1958** y una en **2508**.
- **`RI-303794`**: `Fecha_Factura = 2026-03-02` pero `Fecha_Pago = 2026-02-25` — **cobrada antes de emitirse**. Descuadra la atribución mes a mes de ese documento.

### Queries para regenerar (los CSV/Excel vivían en el scratchpad y se pierden)

```sql
-- Matriz cobrado por cliente × mes 2026 (lo comparable con Ingresos > Clientes Citi)
SELECT No_Cliente, MIN(RTRIM(Nombre_Cliente)) AS Cliente,
 CAST(SUM(CASE WHEN LEFT(Fecha_Pago,7)='2026-02' THEN Importe_Factura ELSE 0 END) AS decimal(18,2)) AS m02
 -- ... repetir por mes
FROM jde.Cobranza_Citi WHERE Cia='00011' AND LEFT(Fecha_Pago,4)='2026' GROUP BY No_Cliente;

-- Depósitos de la concentradora por mes
SELECT FORMAT(Fecha_Estado_Cuenta,'yyyy-MM') AS mes,
 CAST(SUM(CASE WHEN Tipo_Movimiento='CREDITO' THEN Importe ELSE 0 END) AS decimal(18,2)) AS depositos
FROM jde.Bancos WHERE REPLACE(Cuenta_Bancos,' ','')='06780038436'
 AND Fecha_Estado_Cuenta >= '2026-01-01' GROUP BY FORMAT(Fecha_Estado_Cuenta,'yyyy-MM');
```

**Ojo con el MCP:** un resultado grande se guarda en archivo en vez de volcarse al contexto. Pivotea en SQL (una fila por cliente, meses como columnas) para no pasar de 1000 filas, y procesa el archivo con Python.

---

## 5. Hallazgos abiertos, NO corregidos

Ninguno se tocó porque cambian comportamiento de negocio o de dinero — requieren decisión, no mantenimiento.

1. **Proyección: el drilldown no tiene punto de entrada.** `drillMovement`/`drillAnchor` (`FinancialProjectionDashboard.tsx:775-776`) sólo se setean a `null` y ningún componente los dispara. Decidir: cablearle una entrada o retirar el estado muerto. **Es el hermano del bug que `f84cbcc` cerró en Planeación.**
2. **RFC genérico agrupa clientes ajenos (latente).** `deriveGroup` (`clientGrouping.ts:336`) agrupa por RFC con `length >= 10` y confianza 0.97, **sin excluir** `XAXX010101000`/`XEXX010101000`. Hoy no muerde porque `public/clientes-db.json` no trae campo `rfc` en ninguno de sus 128 registros. En el momento en que se poblen los RFC, `CLIENTES CONTADO/PROVEEDOR REPOSICIONES` y las dos `PÚBLICO EN GENERAL` se fusionan en un grupo falso.
3. **Precisión del remanente.** Con ratio 0.70–0.85 los clientes que no caen en el paso (A) reciben su porción proporcional. Medido en la BD: en 2026-02, **186 depósitos ($31.2M)** coinciden al centavo con **una sola factura**, así que un paso (A2) "depósito ↔ factura única" subiría bastante la atribución exacta. Cambia el criterio de atribución → decisión aparte.
4. **`jde.Bancos.No_Recibo` con prefijo de 10 dígitos** (`0000085900855877` vs `855877` en cobranza) impide el cruce por igualdad exacta. El paso (A) lo esquiva, no lo arregla.
5. **Node v26.5.0 rompe 331 tests localmente** (ver §3.2). No es del código.

---

## 6. Contexto operativo

- **El deploy vive fuera de este repo:** `omardavila1017/midas` rama `qa`, alimentado por `.github/workflows/sync.yml` con `rsync --exclude='.git'`. Por eso `APP_VERSION` (que cuenta merges de git) no sirve allá y la identidad del motor es `BUILD_ID = sha256(src/**)`.
- **Para saber qué código está corriendo un navegador:** `window.__midas__.build`. Sin eso no se distingue "el fix está mal" de "el fix no llegó" — fue exactamente la confusión de los PRs #239/#240.
- **Cómo se verificó cada cosa en esta sesión:** typecheck limpio · build OK (chunk Planeación 103.23 kB vs 102.44 kB antes) · 61 tests verdes en los 3 archivos afectados (`citiClientCollection.test.ts` 11, `canonicalProjection.test.ts` 52 incl. 1 nuevo de invariante de fuente única, `MovementDrillDownDrawer.test.tsx` 3).
