# Auditoría de cuadre — Planeación Financiera (Escenario Base)

> Fecha: 2026-06-10
> Alcance: auditoría end-to-end de por qué el flujo de efectivo del Escenario
> Base "no cuadra" entre módulos (Planeación ↔ Dashboard ↔ Bancos ↔
> Conciliación), qué se corrigió en código en este PR, qué divergencias son
> **por diseño**, y la lista definitiva de **información que falta** para
> llegar al 100%.

## TL;DR

1. **Bug estructural corregido (este PR):** el motor de conciliación
   Auxiliar×Bancos clasificaba traspasos internos con una señal INCOMPLETA en
   su lado banco (solo heurística de leyenda/RFC/cuenta-propia). La verdad
   bancaria (`buildHistoricalMonths`), MOTOR 1 y la pantalla de Bancos usan
   además el **pareo simétrico CARGO↔ABONO (±3d)** y el **corte de cuentas
   neutras del catálogo**. Resultado: los totales reconciliados
   (`reconciledByCompanyMonth`, que re-sourcean los brutos históricos del
   Dashboard) podían incluir traspasos internos que todas las demás
   superficies excluyen. Con ~$18B de traspasos circulando vs ~$7.5B de flujo
   real, esa asimetría infla los ingresos/egresos "reconciliados" muy por
   encima de lo que muestran Planeación y Bancos para el mismo mes → "la
   información está mal / no hace sentido".
2. **Varias divergencias visibles son por diseño** (sección 3) — el plug
   `INTERNAL_RECON` y el re-sourcing de brutos hacen que
   `ingresos − egresos ≠ Δcaja` a propósito. Eso hay que *explicarlo en UI*,
   no "arreglarlo".
3. **El resto del descuadre es información faltante, no código** (sección 4):
   rangos del plan de cuentas (catálogo GL vacío), columna de cliente en ROL,
   ventanas de carga de estados de cuenta, referencia de factura en
   pagoProveedor, detalle de nómina TRESS, etc.

---

## 1. Qué se corrigió en este PR

### 1.1 Clasificación de traspasos internos alineada entre motores

`src/domain/auxiliarReconciliationEngine.ts`:

- **Lado banco:** ahora usa `classifyMovement` (la MISMA clasificación que
  `buildHistoricalMonths`/MOTOR 1: heurística + `buildPairMatchedKeys` ±3d)
  más el corte de cuentas `flow='neutro'` del catálogo de bancos.
- Los movimientos **económicamente internos** (pareados o de cuenta neutra)
  permanecen en el pool de match para que la pata GL del traspaso encuentre su
  contraparte, pero la línea GL emparejada se bucketea **`interno`** (no
  cuenta como cruce económico). Esto evita inflar `pendiente-revision` y deja
  rastro auditable (`bankMovementKey` se conserva).
- **Lado GL:** una línea asentada sobre una cuenta neutra del catálogo
  (reserva, por_cancelar, garantía, …) se clasifica `interno` pre-match.
- **Bank orphans:** los movimientos económicamente internos sin pata GL ya no
  aparecen como huérfanos (un traspaso sin asiento no es un faltante real).
- **Sin ventana GL** (cero líneas 1020 en el rango): todos los huérfanos
  bancarios se marcan `outOfWindow=true` — el match era imposible por gap
  estructural de datos, no candidatos reales a investigar.

**Efecto esperado con datos reales:** `reconciledByCompanyMonth` (y por tanto
los brutos históricos del Dashboard) quedan comparables al peso con la verdad
bancaria económica; las facturas/OCs "confirmadas" por patas de traspaso dejan
de confirmarse (un traspaso no paga una factura). El invariante nuevo está
fijado por test: *"reconciledByCompanyMonth == buildHistoricalMonths cuando el
GL cubre todo el flujo real"* (`auxiliarReconciliationEngine.test.ts`).

### 1.2 Round de categorización de ingresos/egresos (2026-06-10, mismo PR)

- **Egresos — cobertura total del vocabulario de categorías.** El 6.9% de los
  proveedores CON categoría conocida (75/1093 entre `providerCatalog.json` y
  `proveedores-clasificacion.json`) caía a "Proveedores sin categoría" porque
  `generalizeCategoria` no tenía patrón para su categoría cruda. Se extendieron
  los `MACRO_PATTERNS` con buckets decididos viendo a los proveedores reales de
  cada categoría: `PLATAFORMA`→Proveedor TI (Fracttal/LinkedIn/OPIS),
  `CONVENIO SENDEX`→Flota (FedEx/Autolíneas VIFE), `Pensión`→Personal y nómina
  (personas físicas, pensión alimenticia), `IMPUESTOS`/`predial`/`RENOVACIÓN`→
  **Impuestos** (gobiernos; bucket nuevo para AP), `GRUAS`/`SELLADOR`/`Traslado
  de unidades`→Flota, `Mtto central`/`MANTENIMIENTO CENTRALES`→Inmuebles y
  rentas, médicos→Personal, y el resto→Servicios. Además: **normalización de
  acentos** (antes `/neumat/` NO matcheaba `NEUMÁTICOS` y el proveedor caía sin
  bucket) y **fallback al catálogo** cuando el `providerCategory` del
  movimiento existe pero no generaliza (antes bloqueaba el lookup). Cobertura
  ahora: **0% sin bucket** — fijada por test data-driven
  (`providerCategoryGeneralization.test.ts` recorre TODO el vocabulario de los
  catálogos bundleados; una categoría nueva sin mapear rompe el test).
- **Ingresos — bucket Multicarga.** `resolveInflowSubcategory` nunca emitía
  `'Multicarga'` aunque el bucket SIEMPRE existió en la taxonomía de Planeación
  — los ABONOs de las concentradoras MULTICARGA (Sendex, guías prepagadas)
  caían al default "Clientes Citi". Regla nueva 5b (espejo de Federal):
  `unidadNegocio === 'MULTICARGA'` → bucket Multicarga.
- **Herramientas:** `scripts/analyze-provider-categories.ts` (cobertura del
  vocabulario; correr tras actualizar catálogos) y `scripts/demo-cuadre.ts`
  (demo ejecutable del pipeline completo: GL×Banco → canonical → Base → cruce
  Planeación↔Banco al peso + buckets de categorización).

### 1.3 Higiene

- `auxiliarProjectionAdapter.ts`: las líneas `interno` con `bankMovementKey`
  no emiten enriquecimientos (su movimiento bancario se descarta en MOTOR 1).
- `historicalReconciledEngine.ts` (paso 1c): el comentario prometía un dedup
  por línea (`bankMovementKey`) que el código nunca implementó; ahora
  documenta el dedup real (mes completo) y su costo aceptado.

---

## 2. Cómo se define "cuadrar" en Midas (para verificación)

El invariante ejecutable vive en
`src/modules/financial-planning/services/cashFlowBankReconciliation.ts`
(`reconcilePlanningAgainstBank`) y corre solo en cada visita a Planeación:

- **Caja final de Planeación == saldo final bancario** (al peso), por mes
  histórico cerrado.
- **Ingresos/egresos económicos == Σ ABONO/CARGO reales** (excluyendo
  traspasos internos + cuentas neutras).

Verificación con datos reales (DevTools → consola, pestaña Planeación):

1. `console.table` `[planning.bank-recon]` — meses divergentes y
   `componentBreakdown` por familia de movimiento (`bank` / `internal-recon` /
   `cobranza-historic` / `auxiliar-historic` / `cxc` / `purchase` / `payroll`).
2. `window.__midas__.planningBankReconciliation` — el reporte completo:
   `initialCashVsBankInitial` (≈0 esperado; un offset constante desancla TODA
   la serie), `bankKpiClosing` (definición A vs B del saldo), `scope`.
3. Conciliación: `summary.pendienteRevisionMonto`, `sinBancoMonto`,
   `cuentaNoEnBancoMonto`, `bankOrphanMonto` — cada peso ahí es flujo que el
   cruce no pudo confirmar y explica diferencia Dashboard↔banco.

---

## 3. Divergencias POR DISEÑO (no son bugs — pero confunden en UI)

| Lo que se ve | Por qué pasa | Dónde está decidido |
|---|---|---|
| `Σ ingresos − Σ egresos ≠ Δ caja` en la cuadrícula de Planeación | La caja incluye el plug `INTERNAL_RECON` (neto de traspasos no apareados, ancla la caja al saldo bancario real); los brutos económicos lo excluyen. | `historicalReconciledEngine.ts` (paso 1a), `RULES.md` |
| `income/expense` del Dashboard ≠ Δ`closingCash` en meses cerrados | Brutos re-sourceados a la conciliación Auxiliar×Bancos; la caja sigue encadenada del banco real (desanclarla sería peor). Con el fix 1.1 la brecha se reduce a cobertura del cruce (orphans/timing). | `dashboardEngine.ts` (`buildReconciledHistoricalMonths`) |
| El mes en curso "no cuadra" | El mes parcial se modela como `max(real acumulado, proyección, predicción)` y NUNCA se reconcilia como cerrado. | `dashboardEngine.ts`, `cashFlowBankReconciliation.ts` |
| Histórico de Aprobado == histórico de Base | Alineado a propósito (commit `8b9f5d1`); el futuro sí difiere. | `scenarioForecastRun.ts` |

**Recomendación UX (pendiente, decisión de producto):** si
`!report.reconciled`, mostrar un banner en Planeación con los meses
divergentes y su `componentBreakdown` — hoy el diagnóstico es consola-only y
el usuario percibe "no cuadra" sin ver la causa.

---

## 4. INFORMACIÓN QUE FALTA (la lista definitiva)

Por orden de impacto en el cuadre del Escenario Base:

| # | Qué falta | Quién la tiene | Dónde se conecta | Qué desbloquea |
|---|---|---|---|---|
| 1 | **Estados de cuenta bancarios completos para TODO el rango del GL** (el Auxiliar carga automático 2025-01→hoy; el banco depende de cargas/caché). Un mes con banco PARCIAL subreporta: la cobertura se marca por (cía, mes) con una sola línea y los rellenos `cobranza-historic`/`auxiliar-historic` se omiten. | Tesorería (carga operativa) | `App.tsx` boot de bancos, IDB `midas.bankStatements.v2` | Histórico completo por mes; sin esto hay meses estructuralmente subreportados |
| 2 | **`saldoInicial` confiable de la primera ventana cargada.** La caja inicial se deriva del primer mes (`closingCash − ingresos + egresos`); si el primer extracto empieza a media mes, TODA la serie de caja queda offseteada (visible en `initialCashVsBankInitial`). | Tesorería / banco | `canonicalProjection.ts` (initialCash), `calculateInitialCash` | Anclaje de caja al peso desde el primer mes |
| 3 | **Rangos del plan de cuentas → categoría** (`GL_FLOW_RULES` está VACÍO a propósito). Sin él, la categorización del histórico depende de `tipo_docto` + rol de cuenta de banco; lo no cubierto cae a "Egresos bancarios sin identificar". | Contabilidad (plan de cuentas con intención: nómina/impuestos/OPEX/CAPEX por rango `idCuenta`/prefijo `cuentaContable`) | `src/config/glAccountFlowCatalog.ts` (gancho listo, formato documentado en el archivo) | Filas reales en vez de "sin identificar"; mejor IVA/impuestos |
| 4 | **Columna de cliente confiable en `/citi/roldiario` (ROL).** Sin ella no se sabe quién paga ni con qué regla → el ingreso de viajes ejecutados-no-facturados NO se proyecta a caja (bloqueado, documentado). | Equipo CITI / API | `CanonicalProjectionInputs.rolRecords` (punto de entrada previsto) | Ingreso de corto plazo más completo en MOTOR 2 |
| 5 | **Referencia de factura/OC en `/pagoproveedor`.** Hoy el cruce pago↔factura es heurístico (proveedor+monto+fecha); ambiguo con facturas del mismo importe. | Equipo JDE | `cargoProviderMatch.ts`, conciliación CXP | Atribución de pagos exacta; menos `pendiente-revision` |
| 6 | **Confirmación del signo de `importe` en AuxiliarContable** (`deriveFlujo` asume negativo=egreso; hay TODO explícito). Si el API cambiara a todo-positivo, TODOS los egresos se leerían como ingresos. Hay gate de validación (`auxiliarKeyValidation.computeFlujoSignAudit`) pero no defensa runtime en el motor. | Equipo JDE (contrato API) | `auxiliarReconciliationEngine.deriveFlujo` | Robustez del cruce ante cambio de contrato |
| 7 | **Catálogo de cuentas bancarias: las 26 cuentas dormidas** que se filtraron en v1.5 (quedaron 38 de 64). Una cuenta dormida que reactive no se clasifica (ni neutra ni pagadora) → su flujo cuenta como real. | Tesorería | `src/assets/bankAccountsCatalog.json` | Detección de traspasos/neutras completa |
| 8 | **Detalle empleado/puesto/CC en TRESS `/Nomina`** (hoy agregado empresa×concepto×periodo). | Equipo TRESS | `payroll/` (bloqueado, ver README del módulo) | Modelar bajas/altas en escenarios; hoy nómina es lump-sum |
| 9 | **`D_Credito` poblado en `/compras`** (muchas OCs traen 0; el overlay `buildComprasCreditOverlay` lo mitiga derivándolo de otras OCs del proveedor). | Compras / JDE | `comprasToPurchaseReceipts.ts` | Fechado de egresos de OC más fiel |
| 10 | **URL productiva de Viajes Especiales** (hoy apunta a `srv-desarrollo:95`). | DevOps | `VITE_VIAJES_ESPECIALES_UPSTREAM` | Ingresos VE en prod |

### Riesgos documentados que NO se tocaron (decisión consciente)

- **Mes bancario parcial** (ver #1): el dedup mes-completo de MOTOR 1 es
  deliberado — emitir GL-orphans encima del banco rompería el invariante
  `Planeación == banco`. El fix correcto es operativo (cargar el mes
  completo), no de motor.
- **Pareo ±3d con montos idénticos:** puede aparear un ABONO real con un
  CARGO ajeno del mismo importe (falso positivo). Afecta a TODAS las
  superficies por igual desde este PR (antes afectaba a todas MENOS a la
  conciliación — esa asimetría era el bug). Si aparece un caso real, el knob
  es `PAIR_MATCH_WINDOW_DAYS` / las señales de `netCashFlowEngine.ts`.
- **Promoción `estatusConciliado='R'`:** una línea GL sin match que JDE marcó
  R cuenta como cruzada aunque nuestros datos no reconstruyan el match. Si esa
  línea fuera la pata de un traspaso no detectado por narrativa, inflaría el
  reconciliado (edge raro; vigilar `cruzadasSinR` vs `conciliadasJde`).
- **Prorrateo Citi con cobranza parcial de mes:** el ratio se sesga si la
  cobranza del mes está incompleta (carga tardía). Diagnóstico, no corrección.
- **Tolerancias del match** (±10% importe, ±45 días): tuneadas
  empíricamente 2026-05-26; sin tests de frontera. Cambiarlas requiere
  re-validar contra datos reales.

---

## 5. Estado verificado al cierre de esta auditoría

- `npm run typecheck` limpio · `npm test` → 107 archivos, **951 passed /
  12 skipped / 0 failed** (5 tests nuevos del invariante de cuadre) ·
  `npm run build` pasa con el warning esperado de chunk (~845 kB).
- Falsos positivos descartados durante la auditoría (para no re-investigar):
  - El cache del source por `refId` NO está obsoleto: el resultado de la
    conciliación se reemplaza por objeto nuevo en cada corrida
    (`setAuxiliarReconciliation(result)`), nunca se muta in-place.
  - `postMessage` del worker SÍ preserva `Map`/`Set` (structured clone).
  - La normalización de `cia` (5 dígitos) es consistente en todos los puntos
    de entrada actuales (`normalizeCia` en cada fetch, guard `^\d{5}$` en
    cargas manuales); el riesgo residual es solo data persistida por versiones
    MUY viejas.
  - Las cuentas TPV/taquillas/hertruck SÍ rutean a Federal vía
    `unidadNegocio` (el desglose por canal vive como filas dentro del bucket).
