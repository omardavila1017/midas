# Mapa de conexiones entre APIs — el datalake de Midas

> Fecha: 2026-07-05
> Método: auditoría del código real (4 barridos paralelos sobre `src/domain/`,
> `src/modules/shared-finance/`, `src/services/`), verificada línea por línea.
> Complementa (no reemplaza) `AUDITORIA-INTEGRACION-MODULOS.md` (mapa de
> módulos, 2026-05-19) y `AUDITORIA-CUADRE-PLANEACION.md` (cuadre, 2026-06-10).
> Este documento responde UNA pregunta: **¿cómo se conecta cada API con las
> demás, por qué llaves exactas, y quién consume cada cruce?**

Leyenda de estado:
- **ACTIVA** — el cruce altera números de caja/proyección/impuestos.
- **DISPLAY** — alimenta badges/drilldowns/paneles; no toca totales.
- **LEGACY** — superada por el motor Auxiliar; vive solo porque tabs de
  display aún la consumen (rewrite pendiente documentado).

---

## 0. Vista de 10,000 pies

Las APIs son fotografías del MISMO flujo de dinero en momentos distintos del
ciclo. Las conexiones existen para (a) no contar dos veces el mismo peso y
(b) validar cada peso proyectado contra la verdad bancaria/contable.

```text
INGRESO:  ROL (viaje ejecutado) ──folio/uuid/núcleo──▶ COBRANZA (factura CXC)
          Viajes Especiales     ──folio/uuid─────────▶ COBRANZA
          COBRANZA ──recibo/monto/fecha──▶ COBRANZA-INDICADORES (pago aplicado)
          COBRANZA ──factura confirmada──▶ BANCO ABONO (vía AuxiliarContable)

EGRESO:   COMPRAS (OC) ──proveedor+folio/monto──▶ CXP (antigüedad saldos)
          CXP ──factura confirmada────────────────▶ BANCO CARGO (vía Auxiliar)
          PAGO-PROVEEDOR ──cuenta+fecha+monto/batch──▶ BANCO CARGO (legacy/display)
          NÓMINA TRESS (futuro) ∥ tipo_docto T1/PQ/P8 (histórico banco) — sin overlap

VERDAD:   AUXILIAR CONTABLE (GL 1010-1020) ──cuenta+fecha+monto±──▶ BANCO
          (el único cruce contable-determinístico; todo lo demás cuelga de él)

PEGAMENTO: catálogo de clientes (reglas de cobro), catálogo de proveedores
          (prioridad/flexibilidad/crédito), catálogo de cuentas bancarias
          (roles, detección de traspasos internos), /empresas (cia 5 dígitos).
```

Regla de oro del diseño: **el banco es la verdad realizada; el GL es la verdad
contable; todo lo demás es señal temprana** que se apaga en cuanto la señal
más tardía la confirma (`cobradaBancoKeys`, `paidCxpKeys`,
`paidPurchaseOrderKeys`).

---

## 1. Inventario de APIs

| API | Registros | Rol en el datalake |
|---|---|---|
| `/api/jde/empresas` | compañías | Hub: normaliza `cia` (5 dígitos) que TODAS las llaves compuestas usan. No cruza — habilita cruces. |
| `/api/jde/bancos` | estados de cuenta | Verdad realizada. Lado derecho de casi todos los cruces. |
| `/api/jde/cobranza` | facturas CXC | Centro del ciclo de ingreso: ROL y VE cruzan CONTRA ella; ella cruza contra banco. |
| `/api/jde/cobranzaindicadores` | pagos aplicados | Nivel 4 del cruce ROL; IVA causado base-cobro; recibos para el cruce banco. |
| `/api/citi/roldiario` (ROL) | viajes ejecutados | Señal más temprana del ingreso. Cruza contra cobranza; lo no facturado se proyecta. |
| `/api/viajes-especiales` | viajes especiales | Igual que ROL pero con cliente/crédito propios; lo no cruzado emite ingreso sintético. |
| `/api/jde/antiguedadsaldos` (CXP) | facturas por pagar | Centro del ciclo de egreso. |
| `/api/jde/compras` | OCs | Señal temprana del egreso; se deduplica contra CXP antes de proyectar. |
| `/api/jde/pagoproveedor` | pagos ejecutados | Cruce legacy contra banco/CXP (display); clasificación de CARGOs. |
| `/JDEdwards/AuxiliarContable` | libro mayor 1010-1020 | Verdad contable. Motor de conciliación central + IVA acreditable (fetch aparte por objetos de IVA). |
| TRESS `/Nomina` | costos de nómina | Egreso futuro (MOTOR 2). El histórico entra por banco vía `tipo_docto`. |
| Catálogos bundleados | clientes / proveedores / cuentas banco | Reglas de fechado, prioridad de pago, detección de traspasos. |

---

## 2. Conexiones, cluster por cluster

### 2.1 Ciclo del ingreso

| # | Conexión | Llave(s) exacta(s) | Código | Consume | Estado |
|---|---|---|---|---|---|
| I1 | ROL ↔ Cobranza (4 niveles) | 1) folio `normFactura` (multi-folio se parte en `[,;/\|\s]+`) → 2) `normUuid` (hex puro ≥8) → 3) núcleo numérico `facturaDigitsKey` (≥3 dígitos) con **guardia de cliente** (`clientDigits(claveJDE)` vs `noCliente`) → 4) pagos aplicados (`app.noFacturaNormalizada`, exacto + dígitos, con guardia). Desempate `pickBest`: mismo cliente+cia > cliente > cia | `rolCobranzaMatch.ts:buildRolCobranzaCross` | `buildRolProjectedInflows` (proyección) + `RolCobranzaPanel` (display, con nivel 4) | ACTIVA |
| I2 | ROL no facturado → catálogo clientes → ingreso `rol:` | cliente por `claveJDE` dígitos → `lookup.byDigits`, fallback tokens del nombre; fecha = `fechaViaje` + regla del cliente (`creditDays`/`paymentDayName`/`frequency`/factoraje); agrega por `cia::clientId::fecha` | `rolProjectionEngine.ts:buildRolProjectedInflows` → `shortTermProjectionEngine.ts` (~245, emite `rol:` MOTOR 2) | Dashboard/Proyección/Planeación no-Base (`rol:` NO pasa el filtro de Base) + calendario de Cobranza (`ROL_PROJECTED`, con `includePastDates`) | ACTIVA |
| I3 | Viajes Especiales ↔ Cobranza | `normFactura(facturaJDE)` vs `normFactura(noFactura)` → `normUuid` (**desde 2026-07-05 comparten los normalizadores de I1** — antes eran versiones locales débiles y el drift de formato duplicaba ingreso en Base) | `viajesEspecialesCobranzaMatch.ts:buildViajesEspecialesCobranzaCross` | motor: matched → re-etiqueta `cxc:` como `cxc:especial` (llave `cia::normFactura`); unmatched/sin factura → sintético `cxc:especial:viaje:` con `Fecha_Factura + Dias_Credito` (default 30). **`cxc:especial:` SÍ llega a Base** | ACTIVA |
| I4 | VE → catálogo clientes (grupo) | `${cia}::${claveJDE}` vs `Client.jdeAccounts[].{cia,noCliente}`; respeta `manualGroupOverride` | `viajesEspecialesCatalog.ts:applyViajesEspecialesGroup` | promueve a `group-viajes-especiales`; ese grupo se EXCLUYE del prorrateo Citi | ACTIVA |
| I5 | Cobranza → catálogo clientes (sync de reglas) | `findClientForCobranza` (dígitos de `noCliente` + tokens del nombre, ≥0.62); patches: `creditDays` (API o lag observado factura→cobro), `paymentDayName` (CC13), `frequency` (`parseFrequencyStrict`), grupo padre | `collectionCalendarEngine.ts:recomputeClientCreditDaysFromCobranza` | el catálogo alimenta TODO fechado de ingreso (I1-I3, C1) | ACTIVA |
| I6 | Cobranza abierta → ingreso `cxc:` | llave `cxcFacturaKey = cia::noFactura`; fecha por regla del cliente u `Nombre_Dia_Pago_CC13` del API; monto `importePendientePesos`; **se apaga si `cobradaBancoKeys.has(llave)`** (confirmación bancaria vía Auxiliar) | `shortTermProjectionEngine.ts:collectCxcInflowLines` | MOTOR 2; `cxc:` SÍ llega a Base | ACTIVA |
| I7 | Cobranza ↔ CobranzaIndicadores ↔ Banco ABONO | recibos `reciboMatchKeys` (`cia::token`, últimos 8 dígitos), `paymentMatchKey` (`cia::cuenta::fecha::centavos`), folio en concepto/referencia; EXACT → TOLERANCE ±2% (variantes IVA ×/÷1.16) → SUBSET ≤6 facturas; ventanas ±60d vencimiento / ±5d cobro; Federal separado (`unidadNegocio==='FEDERAL'` → `BANK_FEDERAL`) | `realReconciliationEngine.ts:reconcileRealCollections` | pestañas Cobranza/calendario (badges, `Fed.`) | LEGACY/DISPLAY |
| I8 | CobranzaIndicadores → IVA causado | por aplicación: `taxAmount = importeIvaFacturaOriginal × min(1, importeCobrado/importeOriginalFactura)`; fecha `fechaCobro` | `taxModuleService.ts:accumulateCobranzaPaymentIva` | módulo Impuestos (autoritativo para causado, base-cobro) | ACTIVA |
| I9 | Cobranza (pesos por cliente-mes) → prorrateo concentradora Citi | depósitos `TRANSFER`/`Clientes Citi` de cuentas `subRole='clientes_citi'` agrupados `cia::yyyy-mm`; peso = cobranza del cliente en ese mes (`fechaCobro`); el total bancario del mes se conserva EXACTO (cobranza solo pondera) | `canonicalProjection.ts:prorateCitiConcentradoraByClient` | filas por cliente en Planeación (`citi-prorrateo:`, REAL) | ACTIVA |

### 2.2 Ciclo del egreso

| # | Conexión | Llave(s) | Código | Consume | Estado |
|---|---|---|---|---|---|
| E1 | Compras self-join (overlay de crédito) | `providerKey` (`normalizeJdeKey(noProveedor)` fallback nombre); moda de `D_Credito` por proveedor rellena OCs con crédito 0 | `comprasToPurchaseReceipts.ts:buildComprasCreditOverlay` | fechado del egreso de OC | ACTIVA |
| E2 | Compras → PurchaseReceipt → movimiento `purchase:`/`po:` | filtra canceladas/workflow 998-999; MXN vía `tipoCambio`; fecha = `F_Recepcion + crédito` (CONFIRMED) o pedido+leadtime+crédito (PROJECTED) | `comprasToPurchaseReceipts.ts` → `sourceRecords.ts:buildPurchaseReceiptMovements` | MOTOR 2; `purchase:`/`po:` SÍ llegan a Base | ACTIVA |
| E3 | PurchaseReceipt ↔ CXP (dedup, 3 niveles) | mismo proveedor (`normalizeJde`) + 1) folio exacto (`normalizeInvoice`) → 2) `noOrden`/`recibo` substring en `noFactura+nombre` → 3) monto ±0.5% + fecha ±7d (PROJECTED solo nivel 1); gate `normalizeCia` | `sourceRecords.ts:purchaseMatchesCxp` | evita proyectar la OC cuando su factura ya vive en CXP | ACTIVA |
| E4 | OC/CXP ← confirmación bancaria (Auxiliar) | `paidPurchaseOrderKeys` (`cia::noOrden`), `paidCxpKeys` (`cia::noFactura::noProveedor`) desde `sourceConfirmation` del motor Auxiliar | `auxiliarProjectionAdapter.ts` → drops en `sourceRecords.ts:135` y `shortTermProjectionEngine.ts:599` | apaga egresos ya pagados según el GL×Banco | ACTIVA |
| E5 | CXP abierta → egreso `cxp:` | fecha `fechaProgramacionPago→fechaVence→fechaFactura` (clamp a vencimiento); proveedor por `providerJdeKey` luego nombre; drops: intercompañía (nombre/RFC/clasificación `filial|intercias|intragrupo`), concurso mercantil, `paidCxpKeys` | `shortTermProjectionEngine.ts:collectOutflowLines` | MOTOR 2 (nota: `cxp:` NO pasa a Base — Base solo lleva `purchase:`/`po:`/`payroll:`/`cxc:`) | ACTIVA |
| E6 | PagoProveedor ↔ CXP (4 niveles) | proveedor `normalizeJde(claveProveedor)` + misma cia; folio en `comentarioPago` → monto exacto en ventana −7/+60d → ±0.5% → subset ≤4 | `paymentReconciliationEngine.ts` | badge "Pagada/Parcial" en CXP.tsx (`cxpCoverage`) | LEGACY/DISPLAY |
| E7 | PagoProveedor ↔ Banco CARGO (5 niveles) | cuenta normalizada (dígitos, sin ceros; sentinel `BANK:BANBAJIO`) + fecha + monto: exact → tolerance ±0.5%/≤120d → **batch** (Σ pagos de `batchPago` ≈ UN CARGO ±7d) → cross-account → subset 2-4 CARGOs; `bankCoverage` (covered/no-account/out-of-range) define "huérfano real" | `paymentReconciliationEngine.ts` | pestaña Pagos (huérfanos, depuración JDE) | LEGACY/DISPLAY |
| E8 | Banco CARGO ↔ Proveedor (heurístico fallback) | token distintivo (≥4 chars, no genérico, de UN solo proveedor) en `concepto+InF_ADI1..3`; o monto redondeado ±1 peso vs recepciones de compras ≤21d con proveedor único | `cargoProviderMatch.ts:matchCargoToProvider` | des-anonimiza CARGOs en Planeación (categoría AP con proveedor) | ACTIVA (enriquecimiento del histórico) |
| E9 | Nómina TRESS → egreso `payroll:` | solo `paymentDate >= asOfDate` (lo pagado YA está en el banco); IMSS→`AP_PAYMENT/TAX`, resto `PAYROLL`; el HISTÓRICO de nómina entra por banco con `tipo_docto` T1/PQ/P8 → **cero overlap temporal, sin dedup necesario** | `sourceRecords.ts:buildPayrollCostMovements` (solo MOTOR 2) | MOTOR 2; `payroll:` SÍ llega a Base | ACTIVA |
| E10 | Convenio concursal ↔ Banco CARGO | calendario trimestral vs CARGOs MXN de TODAS las cuentas; exact → tolerance ±6%/min $50k → subset ≤6; ventana −10/+20d | `convenioReconciliationEngine.ts` | dashboard Concurso Mercantil | DISPLAY |

### 2.3 Verdad contable: AuxiliarContable × Bancos

| # | Conexión | Llave(s) | Código | Consume | Estado |
|---|---|---|---|---|---|
| V1 | GL (objeto 1020) ↔ línea bancaria | pool `cuentaDigits\|flujo\|moneda`; monto abs ±10% (min $1); fecha ±45d; score `dDays/45 + diffPct/0.10`; tiers: `jde-reconciled` (`Estatus_conciliado='R'`, 0.99) > `exact` > `tolerance` > `cross-account` (misma cia) > `timing-pendiente` > `gl-orphan`/`asiento-contable`; buckets aparte: `caja` (1010), `interno` (misma señal que MOTOR 1: `classifyMovement` + pareo ±3d + cuentas neutras), `sin-banco`, `cuenta-no-en-banco` | `auxiliarReconciliationEngine.ts:reconcileAuxiliar` (worker) | Conciliación (tab) + TODOS los puentes de abajo | ACTIVA (núcleo) |
| V2 | Puente Auxiliar → proyección | `sourceConfirmation` (`factura:cia::folio`, `oc:cia::orden`, `pago:cia::tipoPago+noPago`) → `cobradaBancoKeys`, `paidCxpKeys`, `paidPurchaseOrderKeys`, `abonoEnrichments` (facturas por ABONO), `cargoEnrichments` (proveedor por CARGO), `reconciledByCompanyMonth` (`cia::yyyy-mm`, re-sourcea brutos históricos del Dashboard) | `auxiliarProjectionAdapter.ts:adaptAuxiliarForProjection` | MOTOR 1/2 + `computeBaseCashFlow` | ACTIVA |
| V3 | Ledger de IVA (fetch aparte) | Fase A: descubre objetos candidatos por rangos (`AUX_IVA_PARAMS.discoveryObjetos`, override `VITE_AUX_IVA_OBJETOS`) y clasifica POR NOMBRE (`classifyIvaAccount`: ACREDITABLE/TRASLADADO/RETENIDO); Fase B: fetch del rango completo solo de esos objetos; agrega `importe` (que YA es impuesto) por periodo `yyyy-mm` | `ivaLedger.ts` + `jde.ts:fetchAuxiliarContableIvaRange` | Impuestos: acreditable REAL (el causado NUNCA sale del ledger — mezcla devengado con cobrado) | ACTIVA |
| V4 | Cuadre Planeación ↔ Banco (invariante ejecutable) | por `yearMonth`: ingresos/egresos económicos == Σ ABONO/CARGO sin internos; caja == saldo bancario al peso (incluye plug `INTERNAL_RECON`); tolerancia $1 | `cashFlowBankReconciliation.ts:reconcilePlanningAgainstBank` | consola `[planning.bank-recon]` + `window.__midas__` | DISPLAY (diagnóstico) |

### 2.4 Catálogos como pegamento

| # | Conexión | Llave(s) | Código | Estado |
|---|---|---|---|---|
| G1 | Catálogo cuentas banco → detección de traspasos | dígitos de cuenta (con/sin ceros) + CLABE íntegra (18d, estructura 3+3+11+1); escanea `concepto+referencia+InF_ADI1..3` re-uniendo dígitos troceados (`joinDigitRuns` POR CAMPO); auto-excluye la cuenta origen | `netCashFlowEngine.ts:buildOwnAccountsIndex/buildOwnAccountDetector` | ACTIVA (todos los consumidores comparten la fábrica) |
| G2 | Pareo CARGO↔ABONO ±3d | bucket por centavos exactos, cuentas distintas, greedy nearest-date, ABONO se usa una vez | `netCashFlowEngine.ts:buildPairMatchedKeys` | ACTIVA |
| G3 | Catálogo proveedores ← derivación JDE | `normalizeJdeKey` desde CXP+Compras+PagoProveedor; prioridad de categoría: compras-familia > compras-categoría > cxp-clasificación > pp-clasificación | `providerDerivation.ts:deriveProvidersFromJde` | ACTIVA (capa de identidad) |
| G4 | Cliente ↔ cuenta cobranza (sugerencias) | RFC exacto (1.0) > nombre exacto (0.98) > substring ≥8 (0.90) > jaccard de tokens (0.62-0.85); AUTO ≥0.85 | `clientCobranzaMatcher.ts:buildMatchSuggestions` | ACTIVA (vincula `Client.jdeAccounts`) |
| G5 | Categorización del histórico (3 señales) | precedencia: cobranza-factura > pagoProveedor > proveedor-por-monto > `tipo_docto` (T1/PQ/P8→nómina, P*→AP, R*→cobranza, JT→impuestos, Q*→OPEX) > GL-cuenta (`GL_FLOW_RULES` — **VACÍO a propósito**) > rol de cuenta banco (`pagadora/proveedores`→AP) > impuesto-por-concepto > TRANSFER | `historicalReconciledEngine.ts` + `jdeDocTypeFlowCatalog.ts` + `glAccountFlowCatalog.ts` + `bankAccountFlowCatalog.ts` | ACTIVA |

---

## 3. Normalizadores canónicos (NO duplicar versiones locales)

| Normalizador | Dónde vive | Qué hace | Quién DEBE usarlo |
|---|---|---|---|
| `normFactura` | `rolCobranzaMatch.ts` (exportada) | upper, placeholders (`-,0,N/A,S/F,SIN FACTURA`) → '', quita espacios alrededor de guiones y whitespace interno | TODO cruce de folio contra cobranza (ROL, VE, re-etiquetado del motor). La versión local débil de VE causó dobles conteos en Base — corregido 2026-07-05 |
| `normUuid` | `rolCobranzaMatch.ts` (exportada) | hex puro ≥8 chars, case-insensitive | cruces por UUID fiscal |
| `normalizeCia` | `jde.ts` | pad a 5 dígitos | toda llave compuesta `cia::…` |
| `normalizeJdeKey` | `providerIdentity.ts` | canónico numérico (guard notación científica .NET) | identidad de proveedor |
| `cxcFacturaKey` | `canonicalProjectionShared.ts` | `cia::noFactura` | dedup CXC / `cobradaBancoKeys` |
| `bankMovementKey` | `bankMovementKey.ts` | 7 campos con `\|` | join banco↔GL↔enriquecimientos |
| `todayISO` | `formatters.ts` | hoy en America/Mexico_City | todo corte "¿pasado o futuro?" |

---

## 4. Divergencias conocidas (documentadas, no bugs silenciosos)

1. **Dos señales vivas de "CXP pagada" que pueden discrepar.** La proyección
   apaga CXPs con `paidCxpKeys` (Auxiliar, ±10%/45d); el badge "Pagada" de
   CXP.tsx usa el motor legacy (`cxpCoverage`, ±0.5%/60d). Una factura puede
   caerse de la proyección sin badge, o al revés. Fix durable = el rewrite
   pendiente de los tabs display sobre el motor Auxiliar (documentado en
   CLAUDE.md).
2. **Nivel 4 del cruce ROL (pagos aplicados) solo corre en el display.** El
   motor llama `buildRolProjectedInflows` sin `cobranzaPayments`
   (`shortTermProjectionEngine.ts:245`); el panel de Cobranza sí lo pasa.
   **NO afecta caja**: la proyección solo consume `predicted` (viajes SIN
   folio/UUID), y el nivel 4 únicamente reclasifica huérfanos facturados →
   cobrados. Cablearlo al motor solo cambiaría diagnósticos, al costo de
   meter `cobranzaPayments` al fingerprint del cache — no se hizo a propósito.
3. **`expensePerProvider` (nombre-en-concepto) vs `cargoEnrichments`
   (Auxiliar)** son dos mecanismos distintos de atribuir CARGOs a proveedores:
   el primero alimenta la trayectoria mensual (`canonical.monthly`), el
   segundo las líneas de movimiento. Coexisten por diseño (totales vs líneas).
4. **El dedup de la pestaña Venta ahora usa el join, no la presencia de folio
   (corregido 2026-07-09, B2.6).** Antes un viaje ROL con `factura` vacío/
   placeholder pero ya facturado en cobranza contaba DOBLE. `salesCalendarService`
   reusa `buildRolCobranzaCross`: sólo el bucket `predicted` alimenta "por
   facturar"; VE juzga "tiene factura" con `normFactura`. Sin doble conteo.
5. **El cruce VE no desempata por cia** (mapa single-value, último gana) —
   el de ROL sí (`pickBest`). Con `companyCode='all'`, un folio repetido
   entre cias podría cruzar contra la cia equivocada. Riesgo bajo (el folio
   JDE trae serie por cia); pendiente confirmar con datos (pregunta #5).

### 4b. Defectos confirmados de los motores LEGACY (documentados, fix = el rewrite pendiente)

Cacería de bugs 2026-07-05 sobre los motores de display. Reales pero NO se
parcharon: son display-only y el fix durable documentado es reescribir esos
tabs sobre el motor Auxiliar.

1. **Preempción de pago-interno con ventana de 120d**
   (`paymentReconciliationEngine.ts:311`): el check "¿este pago es un traspaso
   interno?" reusa el matcher de tolerancia (±0.5%, ±120 días) — un pago real a
   proveedor con monto redondo igual a CUALQUIER traspaso interno de la misma
   cuenta en ±4 meses desaparece de la cobertura CXP y su CARGO real sale
   huérfano. Fix sugerido: ventana corta (±7d) para el check interno.
2. **`cxpCoverage.totalPaidPesos` inflado en matches subset**
   (`paymentReconciliationEngine.ts:393-418`): un pago que cubre N facturas
   acredita el pago COMPLETO a cada una (hasta ×4). El builder nuevo del módulo
   de impuestos (`allocatePaymentAmount`) ya reparte bien; el tab CXP hereda la
   cifra inflada.
3. **Variante `monto × (1+IVA)` acuña matches 'exact' falsos**
   (`realReconciliationEngine.ts:879-904`): `importeBrutoPesos` YA incluye IVA
   (contrato del mapper); probar ×1.16 permite que un ABONO ajeno del 116% del
   bruto cruce como exacto y robe el ABONO a su factura real. Solo la variante
   ÷(1+IVA) es consistente con el contrato.
4. **Dedup del rango bancario colapsa movimientos idénticos legítimos**
   (`jde.ts` merge por `fecha|referencia|tipo|importe|concepto`): dos SPEIs
   iguales el mismo día al mismo beneficiario con referencia vacía se funden en
   uno (subreporta egreso real). OJO: `gsaid` NO es la solución — es ID de
   CUENTA, no de línea (comentario en `auxiliarReconciliationEngine.ts:572`).
   Pregunta abierta #7. Cambiarlo además toca la unicidad asumida de
   `bankMovementKey` en todos los joins — requiere diseño, no parche.

## 5. Conexiones que NO existen (y su porqué)

| Conexión esperada | Estado real | Porqué / desbloqueador |
|---|---|---|
| ROL → caja para viajes sin cliente confiable | NO proyectado (`unmatchedTrips` se reporta y se descarta) | falta columna de cliente confiable en `/citi/roldiario` (pendiente #4 de AUDITORIA-CUADRE) |
| PagoProveedor → factura exacta | heurístico (folio en `comentarioPago`, monto, batch) | falta referencia de factura/OC en el payload (pendiente #5) |
| GL → categoría por rango de cuenta | gancho listo pero `GL_FLOW_RULES = []` | faltan rangos del plan de cuentas de Contabilidad (pendiente #3) |
| `gsaid === idCuenta` como tier determinístico banco↔GL | solo validación diagnóstica (`auxiliarKeyValidation.ts`), no tier del motor | el gate exige ≥95% match con datos reales antes de promoverlo |
| Cognos | proxy existe, frontend no lo llama | catálogos son JSON bundleado (documentado) |
| Pasivo por Distribuir ↔ cuenta puente del GL | monto sale de OCs `porPagar`, sin validar contra el Auxiliar | mejora futura documentada en CLAUDE.md (Etapa 6) |

**Islas:** ninguna. Todos los datasets que se fetchean cruzan al menos con
otro (verificado 2026-07-05; `viajesEspecialesRecords` comparte el slot de
boot de `rol` y cruza en I3/I4).

## 6. Preguntas → estado (respuestas de negocio 2026-07-05)

### Resueltas

1. **Signo de `importe` en AuxiliarContable — CONFIRMADO: negativo = egreso.**
   `deriveFlujo` ya no es un supuesto; el comentario del código lo refleja y
   el gate `computeFlujoSignAudit` se conserva como guardia de regresión por
   si el contrato del API cambiara algún día.
2. **Folio `Factura_JDE` de Viajes Especiales — CONFIRMADO: mismo consecutivo
   que `noFactura` de cobranza.** El cruce por folio debe dar **~100%**; un
   viaje facturado en `unmatched` persistente es un DEFECTO DE DATOS a
   reportar a JDE, no comportamiento esperado. El diag de dev
   (`[viajes-esp-diag]`) ahora emite `console.warn` con los folios huérfanos.

### TODO (pendientes de dato/respuesta)

| # | Qué falta | Quién | Cómo se cierra |
|---|---|---|---|
| T1 | **¿`noFactura` puede repetirse entre cias?** (afecta precisión de I1/I3 con `companyCode='all'`) | JDE / verificar con datos | Si NO se repite: nada. Si SÍ: agregar desempate por cia al cruce VE (ROL ya lo tiene vía `pickBest`) |
| T2 | **ID único por LÍNEA en `/bancos`** (`gsaid` es por cuenta) — sin él, dos movimientos idénticos legítimos del mismo día colapsan en el dedup del rango (defecto 4b.4) | JDE | Exponer el ID de línea y usarlo como llave de dedup + parte de `bankMovementKey` |
| T3 | **Dígitos reales de la cuenta Bajío en el GL.** El negocio confirma que el GL SÍ trae dígitos reales en `cuentaBanco`; el repo no los conoce (el catálogo solo tiene el centinela y el API de bancos manda folio por línea). Hasta mapearlos, esas líneas GL caen en `cuenta-no-en-banco`. | **Santiago** — leer los dígitos y pasarlos | En la pestaña Conciliación (o `window.__midas__`), filtrar líneas `cuenta-no-en-banco` de la cía del fideicomiso y copiar los `cuentaBanco` distintos → agregarlos al entry BANBAJIO de `bankAccountsCatalog.json` (requiere decidir cómo: campo alias nuevo o entry adicional que resuelva al mismo `accountMatchKey` centinela) |
| T4 | **Rangos del plan de cuentas** para `GL_FLOW_RULES` (categorización del histórico por cuenta contable — gancho listo, catálogo vacío) | Contabilidad | Llenar `GL_FLOW_RULES` en `src/config/glAccountFlowCatalog.ts` (formato documentado en el archivo) |
| T5 | **Columna de cliente confiable en `/citi/roldiario`** — desbloquea proyectar a caja los viajes hoy descartados por cliente no identificable (`unmatchedTrips`) | Equipo CITI | Al llegar, `buildRolProjectedInflows` los resuelve solo (el lookup ya cae por dígitos → tokens) |
| T6 | **Referencia de factura/OC en `/pagoproveedor`** — mata el matching heurístico (proveedor+monto+fecha) del cruce de pagos | Equipo JDE | Usarla como tier determinístico en `paymentReconciliationEngine` (o directo en el rewrite sobre el motor Auxiliar) |
