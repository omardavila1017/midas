# Refresh de la clasificación HORNEADA de proveedores (Excel de Mayte)

Cómo refrescar el dato horneado de **clasificación de proveedores** con el Excel
que manda Mayte (equipo de Proyectos TI): `clasificacion de proveedores jde.xlsx`.

## Contexto (léelo antes de correr nada)

- **Midas NO parsea Excel** en runtime ni en build (a propósito: `exceljs`/`xlsx`
  están fuera del repo). Todo dato de Excel se **hornea** a JSON/TS.
- **Antes de esta entrega NO existía un generador formal Excel→JSON** para el
  catálogo de proveedores. Los archivos horneados que hoy alimentan la
  clasificación:
  - `src/assets/providerCatalog.json` — catálogo rico multi-campo (615+
    proveedores: tipo/clasificación, No. de proveedor, flexibilidad, criticidad
    DTI, días de crédito, último pago…). Generado a mano desde OTROS Excel
    (`Proveedores_AB2026.xlsx`, `Proveedores_2026_conciliado(1).xlsx`).
  - `src/data/proveedores-clasificacion.json` — plantilla de **Alberto** (478
    proveedores con score, frecuencia, montos). Fuente distinta a la de Mayte.
  - `scripts/analyze-provider-categories.ts` **solo ANALIZA** cobertura de
    `generalizeCategoria`; **no genera** nada.
- **El Excel de Mayte solo trae la dimensión de CLASIFICACIÓN** (Clave, Nombre,
  Tipo_Busqueda, Clasificacion_Proveedor, Importe_Pagado). Por eso el refresh es
  un **merge de la clasificación**, no una regeneración total (regenerar
  borraría los demás campos multi-fuente del catálogo).
- **Fuera de alcance (importante):** la MISMA clasificación fluye también
  **directo a JDE** de forma masiva (proceso de Mayte/Yezid) y se refleja en
  Midas vía la **API de JDE que YA existe** — ese lado **NO se toca aquí**. Este
  refresh es solo del dato horneado del frontend, para que quede consistente con
  lo que Mayte mandó. **No hay API nueva de proveedores.**

## Uso

El script consume un **CSV** (el repo no parsea `.xlsx`). Un paso manual:

1. Abre el Excel de Mayte, hoja **"Relacion proveedores 2026"** → *Guardar como*
   → **CSV UTF-8**. (El catálogo de industria de la hoja 2 ya está horneado en
   `scripts/data/provider-industry-catalog.json`; si Mayte lo actualiza,
   re-expórtalo y pásalo con `--catalog=<industria.csv>`.)
2. Corre el script:

   ```bash
   # Solo reporte (default, no toca datos):
   node scripts/refresh-provider-classification.mjs ruta/relacion.csv

   # Aplicar el merge al catálogo horneado:
   node scripts/refresh-provider-classification.mjs ruta/relacion.csv --write
   ```

   Opciones: `--catalog=<industria.csv>` (catálogo de industria alterno),
   `--out=<reporte.csv>` (ruta del reporte, default `scripts/out/…`).

## Qué hace

1. **Valida** cada `Clasificacion_Proveedor` contra el vocabulario conocido =
   catálogo maestro de industria (hoja 2) **∪** vocabulario que Midas ya usa
   (`providerCatalog.json`). Marca cada fila: `vacia` (sin clasificación, típico
   de Employees/Trabajadores), `null-literal` (el string `"NULL"`), o
   `no-mapeable` (clasificación fuera del vocabulario).
2. Escribe un **reporte CSV** de las filas marcadas
   (`scripts/out/provider-classification-issues.csv`, gitignoreado) para
   **devolvérselas a Mayte reclasificadas**.
3. Con `--write`: **merge idempotente** de la clasificación de las filas válidas
   a `providerCatalog.json` (`providerTypeByName` / `classificationByName` /
   `providerNoByName` por nombre), **preservando** todos los demás campos y los
   proveedores no presentes en el Excel. Ordena las llaves para un diff estable.

## Qué revisar DESPUÉS de `--write`

- ⚠️ **`npm test -- providerCategoryGeneralization`** — el test data-driven de
  `providerCategoryGeneralization.test.ts` recorre TODA categoría del catálogo y
  falla si `generalizeCategoria` no la mapea a un bucket real. El Excel de Mayte
  usa una taxonomía de **industria** (Automotriz, Bancario, Acero…) que no
  necesariamente está cubierta por `generalizeCategoria` (hoy pensada para la
  taxonomía de proveedor previa). Si el test falla, extiende
  `src/modules/financial-planning/services/providerCategoryGeneralization.ts`
  para las categorías nuevas (corre
  `npx vite-node scripts/analyze-provider-categories.ts` para ver el desglose).
- `npm run typecheck` + `npm test` en verde.
- **Providers.tsx / ProviderDetailModal** — que la clasificación siga
  mostrándose correctamente para una muestra de proveedores.

## Por qué el merge NO se aplica en este PR

Se entrega el **script + validación + docs** (no el `providerCatalog.json`
regenerado) porque:

1. El Excel actual trae **271 filas por corregir** (261 sin clasificación —
   personas/Employees — y 10 con `"NULL"`); primero se le devuelven a Mayte.
2. La clasificación de Mayte es una taxonomía de **industria** distinta a la que
   hoy alimenta la **categorización financiera** (`generalizeCategoria`);
   aplicarla requiere alinear esa taxonomía (cambio en el motor de
   categorización) — decisión a coordinar, no un bake ciego.
3. La fuente **autoritativa** de esta clasificación es **JDE** (proceso de
   Mayte/Yezid), que ya llega a Midas por la API existente.

Cuando el Excel de Mayte esté limpio y la cobertura de `generalizeCategoria`
alineada, corre `--write` y valida los puntos de arriba.
