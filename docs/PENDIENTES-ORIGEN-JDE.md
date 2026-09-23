# Pendientes del ORIGEN (JDE / BD) — medidos 2026-09-21

Todo lo de esta lista está **fuera de Midas**: son defectos de las tablas espejo
en `db_Artefactos` o de los jobs que las cargan. Midas ya los compensa donde
puede, pero el parche vive en el cliente y no debería ser permanente — mientras
sigan abiertos, cada consumidor nuevo de esas tablas hereda el mismo problema.

Las cifras salen de consultar la BD el 2026-09-21. Cada punto dice **qué pedir**
y **cómo se verifica que quedó**.

---

## 1. Cuatro tablas no truncan antes de insertar (ALTA)

El patrón es el mismo en las cuatro: la carga diaria **reinserta** en vez de
reemplazar, así que la tabla acumula una copia del mismo registro por cada
corrida. Ninguna es un histórico por diseño — las cuatro son *snapshots*.

| Tabla | Filas hoy | Cargas conviviendo | Registros reales | Inflación |
|---|---|---|---|---|
| `jde.Antiguedad_Saldos` | 134,291 | **239** | ~2,800 abiertos | ~48× |
| `jde.Cobranza_Citi` | 49,433 | 236 | 48,759 folios | 674 filas fantasma |
| `jde.Cobranza_Indicadores` | 18,294 | 54 | 8,978 aplicaciones | **2.04×** |
| `jde.Pago_Proveedor` | 35,975 | 27 | 33,343 pagos | 2,632 filas |

**Lo que cuesta, medido:**

- **`Cobranza_Indicadores`** infla el cobro reportado en **$80.6M**
  ($1,013.8M crudos contra $933.2M dedupeados). Eso alimenta el **IVA causado**,
  que es impuesto publicado.
- **`Antiguedad_Saldos`** es la peor: además de no truncar, conserva
  **126,469 documentos marcados `edo_pago = 'P'` (PAGADO) con su
  `importe_pendiente_pesos` congelado — $3,056.1M**. Un documento pagado no es
  pasivo; la antigüedad de SALDOS no debería contenerlo.
- **`Antiguedad_Saldos`** es también lo único que hace lento el arranque de
  Midas: la consulta va por compañía y sin rango de fechas, así que la cía 00011
  sola devuelve decenas de miles de filas en UN request.

**Qué pedir:** que el job **trunque la tabla antes de insertar** y deje UNA sola
corrida. Es un `TRUNCATE`/`DELETE` al inicio del paquete, no un rediseño.

**Cómo se verifica:** `SELECT COUNT(DISTINCT F_Carga) FROM <tabla>` debe dar
**1**. Para `Antiguedad_Saldos`, además:
`SELECT COUNT(*) FROM jde.Antiguedad_Saldos WHERE edo_pago = 'P'` debe dar **0**.

---

## 2. `db_Artefactos` sin respaldo de log (ALTA — riesgo de caída)

`recovery_model = FULL` con `log_reuse_wait = LOG_BACKUP` y **sin job de
`BACKUP LOG`**. El log crece sin poder reciclarse.

Ya pasó: el **2026-08-05** el log se llenó, tumbó el login (que escribe
`F_Ultima_Sesion`) y **las cargas nocturnas de `jde.*` / `citi.*` / `tress.*`
fallaron**. Hoy la base está ONLINE pero en la misma condición.

**Qué pedir:** un job recurrente de `BACKUP LOG` — o pasar la base a
`recovery_model = SIMPLE` si no se necesita recuperación a un punto en el tiempo.

**Cómo se verifica:** `log_reuse_wait_desc` en `sys.databases` deja de decir
`LOG_BACKUP`.

---

## 3. `No_Pago` se reutiliza entre lotes (MEDIA — informativo)

En `jde.Pago_Proveedor`, el mismo `No_Pago` aparece con **proveedor, batch,
fecha e importe distintos**: son pagos diferentes. Ejemplo real, cía 00011,
`Tipo_Pago = PT`, `No_Pago = 428674`:

- GASNGO MEXICO — $956,454.66 — batch 84562250
- CFE SUMINISTRADOR — $24,795.00 — batch 84523892

Medido: **69 grupos dentro de una misma carga** con importes distintos, $38.46M.

**No requiere cambio en JDE** — Midas ya lo resolvió identificando el pago por
`cia + tipo + número + proveedor + batch`. Se documenta para que quien consuma
esa tabla no asuma que `No_Pago` es único: no lo es.

---

## 4. Calidad de captura (MEDIA — no bloquea, ensucia el reporte)

Defectos del capturista que Midas ya no toma por buenos, pero que mientras no se
corrijan en el origen impiden clasificar ese gasto:

- `Pago_Proveedor`: **643 pagos ($62.96M)** con `Clasificacion_Proveedor = " "`
  (comillas literales), **3,023** con `Clasificacion_Proveedor_Financiera` =
  `"-      ."`, y **1,600 ($431.44M)** en `220 - Por Clasificar`.
- `Compras`: **1,050 líneas ($4.28M)** con la familia en `Seleccionar Familia`
  (el placeholder), y varias con `.` como categoría.

**Qué pedir:** limpieza de esos catálogos en JDE. Prioridad por monto: el
`220 - Por Clasificar` de $431M es el que más pesa.

---

## 5. Peticiones de API (BAJA — habilitan funcionalidad)

- **`Clasificacion_Proveedor_Financiera` en `/antiguedadsaldos`.** La columna NO
  existe en esa tabla, sólo en `Pago_Proveedor`. Consecuencia: el MISMO proveedor
  se clasifica distinto en el pasado (pago cruzado, con la columna) que en el
  futuro (CXP abierto, sin ella) — p.ej. casetas PASE cae en Flota en el
  histórico y en Servicios en la proyección, y los dos escenarios no empatan.
- **`Fecha_Contable` en la respuesta de `/antiguedadsaldos`.** Existe en la tabla
  espejo; falta confirmar que el SP la expone. Midas la usa para detectar que la
  fuente dejó de cargar (la fecha de factura sí se puede post-fechar, la contable
  no). Se comprueba en un vistazo: DevTools → Network → respuesta de
  `antiguedadsaldos` → buscar `Fecha_Contable`.
- **Formato de fecha.** `jde.Antiguedad_Saldos` es la ÚNICA tabla del espejo que
  guarda las fechas como varchar `DD-MM-YYYY`; las demás usan ISO. Midas ya lo
  normaliza, pero conviene alinearlo.

---

## Lo que ya NO hay que pedir

Cerrado en el origen, verificado hoy — para no volver a reportarlo:

- **`jde.Cobranza_Citi` ya aplica los recibos.** El hueco que llegó a $385.5M
  (facturas cobradas que seguían con su pendiente completo) está en **$0**.
- **ROL: `Clave_JDE` al 99.9%.** El bloqueador de "columna de cliente no
  confiable" se resolvió.
- **El $0 de las OCs** (bug del SP `SP_Compras_Auditoria_IA`) está corregido:
  41 líneas en $0 de 148,336 = 0.03%.
