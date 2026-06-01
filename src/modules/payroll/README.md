# Módulo de Nómina (TRESS)

Dashboard analítico de nómina alimentado **únicamente por el API de TRESS**
(`/v1/erp/tress/nomina`). No depende de carga manual de Excel.

## Fuente de datos

El API entrega filas ya agregadas con grano:

```
empresa (cia) × concepto × periodo de pago × mes
```

Tipo normalizado: `PayrollCostRecord` (`src/modules/shared-finance/types/index.ts`).
Campos por fila: `cia, empresaNomina, year, month, paymentDate, periodStartDate?,
periodEndDate?, payrollPeriod, payrollType (Semanal|Quincenal), conceptId,
conceptName, conceptType (Percepción|Deducción|Aportación|Prestación|Informativo),
cashTreatment (CASH_OUT|EMPLOYER_TAX|WITHHOLDING_PAYABLE|DEDUCTION|NON_CASH),
amount, costCenter(SIEMPRE undefined)`.

24 meses de historia se cargan al boot en `MidasStore.nominaRecords`.

## Vistas (sub-pestañas dentro de la pestaña "Nómina")

| Sub-pestaña | Dataset | Servicio |
|---|---|---|
| **Resumen** | mes filtrado | `computeKpis` + `summarizeByCashTreatment/ConceptType/PayrollType` |
| **Comparativo** | mes filtrado | `summarizeByCompany` |
| **Conceptos** | mes filtrado | `topConceptsWithShare` + `groupConceptsByType` |
| **Tendencia** | historia completa | `buildPayrollTimeSeries` + `seriesVariation` |
| **Predictivo** | historia completa | `payrollForecastAdapter` (Holt-Winters) |
| **Alertas** | historia completa | `payrollAnomalyService` (z-score concepto/empresa) |
| **Detalle** | mes filtrado | `summarizePeriods` + `summarizeByConcept` (tablas originales) |

Las vistas de "historia completa" usan los registros filtrados sólo por
(cía, tipo de nómina) — ignoran año/mes a propósito. El cómputo pesado
(forecast, z-scores) corre sólo cuando su sub-pestaña está montada (gating por
render condicional).

## Mapeo con el HTML de referencia (`Dashboard_Analisis_Nomina_v38.html`)

El HTML se alimentaba de un Excel con grano **empleado × concepto × semana** y
dimensiones `Empresa, Centro de Costos, Número, Nombre, Puesto, Segmento Costo,
ID Concepto-Descr, Tipo Nomina`. El API es **agregado** y no trae varias de esas
dimensiones, así que el módulo replica lo posible y sustituye lo demás:

| HTML | API | Estado |
|---|---|---|
| KPIs globales | sí | ✅ replicado |
| Composición por "Segmento Costo" (Sueldo/Variable/Tiempo Extra) | `conceptType` / `cashTreatment` | 🔁 sustituido (el API no trae Segmento) |
| Comparativo por empresa | sí | ✅ replicado |
| Comportamiento Semanal | `paymentDate` (semanal/mensual) | ✅ replicado |
| Costo x Concepto | sí | ✅ replicado |
| Análisis Predictivo (concepto/empresa) | Holt-Winters | ✅ replicado |
| Casos sospechosos (z-score) | nivel concepto/empresa | 🔁 adaptado (no por empleado) |

## Gaps del API (no replicable hoy)

Las filas del API **no tienen identidad de empleado, puesto ni centro de costo**
(`costCenter` siempre `undefined`). Por eso NO es posible construir:

- Detalle por empleado
- Var+TE > Sueldo (outlier por empleado)
- Casos a Revisar / Multi-Caso por empleado
- Por Centro de Costo / Costo x Centro de Costo
- Riesgo por empleado (predictivo)

**Cómo resolverlo:** un endpoint de TRESS de nómina a nivel empleado que exponga
`Número, Nombre, Puesto, Centro de Costo, Segmento` por concepto y periodo. El
punto de entrada esperado sería un nuevo dataset (p. ej. `nominaEmpleadoRecords`)
análogo a `nominaRecords`, sobre el cual se reconstruirían las vistas por
empleado/CC y la detección de outliers a nivel persona del HTML original.
