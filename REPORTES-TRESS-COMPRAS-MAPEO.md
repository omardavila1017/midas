# Mapeo de APIs: TRESS Nomina y Recibo de Compras

Fecha de revision: 2026-05-08

Archivos revisados:

- `/Users/paolo/Desktop/Libro2.xlsx`
- `/Users/paolo/Desktop/Recibo de compras abril.xlsx`

## Resumen ejecutivo

TRESS debe entrar al sistema como fuente de egresos de nomina por empresa, periodo, mes, tipo de nomina y concepto. Sirve para planeacion, prediccion mensual, presupuesto y explicacion de variaciones, pero el archivo actual no trae fechas exactas ni ejercicio, por lo que el API debe agregarlas.

Recibo de Compras debe entrar como fuente operativa de ordenes de compra, recepciones y facturas. No reemplaza a `/antiguedadsaldos`; lo complementa. Para flujo de caja, CXP sigue mandando cuando existe factura abierta y fecha programada de pago. Compras sirve para anticipar compromisos antes de que aparezcan en CXP, clasificar gasto por categoria/familia/producto, detectar diesel y mejorar prediccion por proveedor.

## TRESS - Libro2.xlsx

Muestra revisada:

- Hoja: `Hoja1`
- Registros: 4,609
- Columnas: 8
- Empresa: `SIR` unicamente
- Meses: enero, febrero, marzo, abril
- Total monto: 464,384,440.07
- Sin nulos en columnas actuales

Totales principales:

| Corte | Total |
| --- | ---: |
| Percepcion | 249,473,786.30 |
| Obligacion Empresa | 99,077,273.93 |
| Deduccion | 80,553,034.72 |
| Prestacion | 35,280,345.12 |

### Columnas requeridas

| Columna actual | Campo API recomendado | Uso en sistema |
| --- | --- | --- |
| Empresa | `empresaNomina` y/o `cia` | Filtro por empresa. Confirmar si `SIR` equivale a JDE `00011`. |
| Monto | `amount` | Base de egreso, presupuesto y forecast. |
| Periodo | `payrollPeriod` | Estacionalidad semanal/quincenal y deteccion de semanas pesadas. |
| MES | `month` | Agrupacion mensual. Debe venir tambien como numero o fecha ISO. |
| IDConcepto | `conceptId` | Llave estable para clasificar conceptos. |
| Concepto | `conceptName` | Explicacion en UI y agrupacion de gasto. |
| TipoNomina | `payrollType` | Separar operadores, quincenal, ejecutivos y semanal. |
| TipoConcepto | `conceptType` | Tratamiento de caja: percepcion, prestacion, obligacion empresa, deduccion. |

### Campos que faltan y deben pedirse al API

| Campo necesario | Motivo |
| --- | --- |
| `year` / `ejercicio` | Sin anio no se puede comparar historico ni proyectar varios anios. |
| `paymentDate` | Para flujo diario/semanal; mes no basta. |
| `periodStartDate` y `periodEndDate` | Para alinear nomina con semanas operativas. |
| `ciaJde` o tabla de equivalencias | Necesario para filtrar junto con bancos, CXP y compras. |
| `cashTreatment` | Clasifica si el monto es pago neto, costo patronal, retencion o provision. |
| `costCenter` / `department` si existe | Mejora planeacion por operacion, taller, corporativo, etc. |

### Tratamiento para planeacion y prediccion

No se debe sumar todo TRESS como salida directa de caja sin clasificar:

- `Percepcion`: base de nomina bruta. Para pago real de nomina debe ajustarse contra deducciones si no existe neto.
- `Prestacion`: gasto laboral; algunas prestaciones son pago directo y otras provision. Requiere `cashTreatment`.
- `Obligacion Empresa`: costo patronal/impuestos. Debe proyectarse, pero su fecha de pago puede ser distinta al periodo de nomina.
- `Deduccion`: no es gasto adicional. Reduce el neto al empleado y crea pasivo/entero posterior, por ejemplo ISR, Infonavit, Fonacot, caja de ahorro.

Match recomendado dentro del sistema:

1. `Empresa` -> `cia` mediante catalogo de equivalencias (`SIR` probablemente `00011`, confirmar).
2. `TipoNomina + Periodo + paymentDate` -> calendario de egresos recurrentes.
3. `IDConcepto` -> catalogo de conceptos de nomina con tratamiento de caja.
4. `Concepto` -> fallback visual, no llave principal.

## Recibo de Compras abril.xlsx

Muestra revisada:

- Hoja: `Auditoria de Compras`
- Registros: 15,740
- Columnas: 47
- Proveedores: 265
- Ordenes: 1,545
- Facturas: 2,013
- Companias: 5
- Total `Precio T`: 104,210,965.39
- `F Recepcion`: 2026-04-01 a 2026-04-30
- `F Pedido`: 2025-06-20 a 2026-04-30

Top categorias por monto:

| Categoria | Total |
| --- | ---: |
| Combustibles | 59,572,576.65 |
| Sin categoria codigo | 17,581,105.18 |
| Servicios | 13,549,881.19 |
| Directos | 10,133,918.18 |
| Indirectos | 3,373,484.19 |

### Columnas requeridas

| Columna actual | Campo API recomendado | Uso en sistema |
| --- | --- | --- |
| Compañia | `cia` | Filtro principal; normalizar a 5 digitos (`00011`, `00001`, etc.). |
| C Proveedor | `noProveedor` | Match fuerte contra CXP, catalogo de proveedores y bancos. |
| N Proveedor | `supplierName` | UI, fallback de match y enriquecimiento por catalogo. |
| N Factura | `invoiceNo` | Match contra `/antiguedadsaldos.noFactura`. |
| N Orden | `purchaseOrderNo` | Llave de OC y compromiso previo a factura. |
| T Orden | `purchaseOrderType` | Segmenta diesel, contrato, bienes/servicios, factura, urgentes. |
| D T Orden | `purchaseOrderTypeDescription` | Descripcion visible. |
| N Entrada | `receiptNo` | Match de recepcion; evita duplicar lineas de OC. |
| Cantidad | `quantity` | Driver de diesel/refacciones y validacion de precio. |
| Precio U | `unitPrice` | Prediccion por precio unitario y auditoria. |
| Precio T | `totalAmount` | Monto base de compromiso. |
| T Moneda | `currency` | MXP/USD y conversion. |
| Tipo Cambio | `exchangeRate` | Normalizacion a pesos. |
| F Pedido | `orderDate` | Fecha de origen de compromiso. |
| F Recepcion | `receiptDate` | Fecha operativa del gasto recibido. |
| D Credito | `creditDays` | Estimar vencimiento si CXP todavia no trae fecha programada. |
| Centro Costos | `costCenter` | Planeacion por area/operacion. |
| C Producto | `productCode` | Match estable de producto. |
| D Producto | `productDescription` | UI y agrupacion secundaria. |
| T Producto | `productType` | Fallback de producto. |
| Categoria | `categoryCode` | Rubro mayor de gasto. |
| Desc Categoria | `categoryName` | Rubro visible. |
| Familia | `familyCode` | Driver de forecast por familia. |
| Desc Familia | `familyName` | Rubro visible. |
| Sub Familia | `subfamilyCode` | Driver granular. |
| Desc Sub Familia | `subfamilyName` | Rubro visible. |
| C Fiscal | `taxCode` | IVA/retenciones si se requiere subtotal vs impuesto. |
| Tasa Fiscal | `taxRate` | Calculo fiscal y conciliacion. |
| F Cancelada | `cancelledAt` o `cancelFlag` | Excluir canceladas si aplica. Solo 6 registros traen fecha. |
| Edo Ant / Edo Sig | `previousStatus` / `nextStatus` | Validar estado de recepcion/contabilizacion. |
| L Orden / L Req | `orderLine` / `requisitionLine` | Evita duplicados por linea. |

### Columnas opcionales

| Columna | Uso |
| --- | --- |
| Usuario Compras | Auditoria operativa, no forecast. |
| Usuario Autorizador OC | Auditoria/autorizaciones; 15% nulo. |
| Usuario Recepción | Auditoria operativa. |
| Usuario Requisición | Requisiciones; 89.1% nulo. |
| Usuario Autorizador Req | Requisiciones; 89.1% nulo. |
| Tipo Doc Orig | Trazabilidad de documento origen; 89.1% nulo. |
| Doc Orig | Trazabilidad de documento origen; 89.1% nulo. |
| Tipo Busqueda | Catalogo/product lookup; no necesario para caja. |
| Estatus Diesel | Util solo para diesel; 97.3% vacio. |

### Columnas que no conviene usar como base

| Columna | Motivo |
| --- | --- |
| T Entrada | Tiene un solo valor (`OV`) en la muestra. Puede guardarse como metadata, pero no aporta al forecast. |
| Desc Categoria duplicada | El Excel trae encabezados duplicados; conservar solo una version canonica. |
| Categoria duplicada | El Excel trae encabezados duplicados; conservar `categoryCode` y descartar duplicado tecnico. |
| Familia duplicada | El Excel trae encabezados duplicados; conservar `familyCode` y descartar duplicado tecnico. |
| Concepto | Es texto libre. Util para busqueda, pero no como llave de match. |

## Matches recomendados

### Compras -> CXP `/antiguedadsaldos`

Orden de confianza:

1. `cia + noProveedor + invoiceNo`
2. `cia + noProveedor + purchaseOrderNo + receiptNo`
3. `cia + noProveedor + totalAmount + receiptDate` con tolerancia de centavos
4. `supplierName normalizado + invoiceNo`

Cuando existe match en CXP, usar CXP como fuente final de pago:

- `fechaProgramacionPago`
- `fechaVence`
- `importePendientePesos`
- `edoPago`
- aging buckets

Compras queda como detalle operativo del origen del compromiso.

### Compras -> Catalogo de proveedores

1. `C Proveedor` -> `Provider.numProveedorJDE`
2. `N Proveedor` normalizado -> `Provider.name`
3. `Desc Categoria/Familia/Sub Familia` -> `Provider.type` o clasificacion automatica si el catalogo no tiene tipo.

### Compras -> Bancos

No hay pago bancario en este reporte. El match debe ser posterior:

1. `supplierName` contra concepto bancario normalizado.
2. `invoiceNo` si aparece en concepto/referencia.
3. `totalAmount` contra cargo bancario con tolerancia.
4. Fecha bancaria posterior a `receiptDate` o vencimiento estimado.

### TRESS -> Flujo y bancos

1. `Empresa/cía + paymentDate + payrollType` contra cargos bancarios de nomina.
2. `conceptType/conceptId` contra reglas de tratamiento de caja.
3. `Periodo + month + year` para forecast recurrente.

## Modelo API recomendado

### `PayrollCostRecord`

Campos minimos:

- `cia`
- `empresaNomina`
- `year`
- `month`
- `paymentDate`
- `periodStartDate`
- `periodEndDate`
- `payrollPeriod`
- `payrollType`
- `conceptId`
- `conceptName`
- `conceptType`
- `cashTreatment`
- `amount`
- `costCenter`

### `PurchaseReceiptRecord`

Campos minimos:

- `cia`
- `noProveedor`
- `supplierName`
- `invoiceNo`
- `purchaseOrderNo`
- `purchaseOrderType`
- `purchaseOrderTypeDescription`
- `receiptNo`
- `orderLine`
- `requisitionLine`
- `orderDate`
- `receiptDate`
- `estimatedDueDate`
- `creditDays`
- `currency`
- `exchangeRate`
- `quantity`
- `unitPrice`
- `totalAmount`
- `amountMxn`
- `taxCode`
- `taxRate`
- `costCenter`
- `productCode`
- `productDescription`
- `productType`
- `categoryCode`
- `categoryName`
- `familyCode`
- `familyName`
- `subfamilyCode`
- `subfamilyName`
- `previousStatus`
- `nextStatus`
- `cancelledAt`

## Reglas para planeacion y prediccion

1. CXP abierto manda sobre Compras para fechas y saldos pendientes.
2. Compras alimenta compromisos tempranos cuando todavia no aparece factura en CXP.
3. TRESS alimenta nomina recurrente, pero necesita fecha de pago y tratamiento de caja para no duplicar deducciones.
4. Diesel debe modelarse por cantidad, precio unitario, proveedor, compania y familia/subfamilia, no solo por monto.
5. Gasto sin categoria codigo debe entrar a cola de clasificacion; en abril suma 17.58M.
6. Canceladas deben excluirse del forecast si `F Cancelada` indica cancelacion real.
7. Para prediccion mensual, agrupar por `cia + proveedor + familia/subfamilia + producto + tipoOrden`.
8. Para presupuesto, mapear `category/family/subfamily` a conceptos del plan.

## Pendientes de negocio

1. Confirmar equivalencia `SIR` -> cía JDE.
2. Confirmar si `Precio T` ya incluye impuestos o es subtotal.
3. Confirmar si `D Credito` esta en dias naturales y desde que fecha corre: pedido, recepcion o factura.
4. Confirmar significado operativo de `Edo Ant/Edo Sig`.
5. Confirmar si `F Cancelada = 0` significa no cancelado.
6. Pedir a TRESS fecha exacta de pago y ejercicio.
