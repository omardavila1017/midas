# Compensaciones en el cuadre de cobranza vs banco

Regla de excepción acordada en la junta del **2026-07-09** (cuadre de cobranza
con Blanca/Vero): hay clientes cuyo pago **no aparece (completo) como abono
bancario de cobranza** porque se liquida por **compensación**. Antes de esta
regla, el panel "Cobranza aplicada en Edwards vs banco" (pestaña Cobranza) los
reportaba falsamente como **"Sin banco"** o **"Descuadre de importe"**, y
tesorería los leía como error.

## Nomenclatura

| Término | Significado |
|---------|-------------|
| **Esquema de compensación** | Acuerdo con el cliente por el que el cobro se liquida (total o parcialmente) sin pasar por bancos como abono de cobranza. |
| **`aplica-a-proveedor`** | El pago del cliente se aplica primero contra deuda que el grupo tiene con él como **proveedor**. El dinero nunca entra al banco como cobranza de cliente. Caso: **TLJ**. |
| **`descuento-en-origen`** | El cliente **descuenta en origen** una parte del pago (compensación) y deposita sólo el **neto**. El recibo aplicado en Edwards es mayor que el abono bancario. Casos: **APTIV** (citado "APTI" en la junta) y **CMI**. |
| **Bucket `compensacion`** | Clasificación del cuadre para estos recibos: **esperado, no accionable**. Se muestra aparte (tarjeta + columna propias) y **sale del % de descuadre**. |

**NO es excepción:** Corning pagando a **Banco del Bajío** — ese cobro sí
aparece como abono bancario normal y cuadra por la vía estándar. Por eso la
regla nunca toca un recibo cuyo depósito sí cuadró (`cuadrado` manda siempre).

## Comportamiento exacto

Vive en `src/domain/cobranzaBankCuadre.ts` (`applyCompensacion`), como capa de
**clasificación/agregación read-only** sobre lo que el motor de conciliación ya
resolvió — no re-cruza nada, no toca montos ni fechas, no ejecuta pagos:

- Recibo de cliente con esquema que habría caído **`sin-banco`** →
  **`compensacion`** (ambos esquemas: el cobro no entró al banco y eso es lo
  esperado).
- Recibo que habría caído **`descuadre-importe` con Edwards > banco** →
  **`compensacion`** sólo si el esquema es `descuento-en-origen` (el faltante
  es el descuento; el depósito neto real sigue contando como banco).
- **Banco > Edwards** no es explicable por compensación → se queda como
  descuadre real. `cuadrado` y `revisar` nunca se reclasifican.
- El **% cuadrado** del panel se calcula sobre la **base bancarizable**
  (`totalEdwards − compensación`), así los clientes de compensación no hunden
  el indicador. Si toda la base es compensación → 100 % (nada accionable).

En el panel (`CobranzaBankCuadrePanel`, `src/components/CollectionProjection.tsx`)
el bucket aparece como tarjeta **"Compensación (esperado)"**, segmento propio en
la barra apilada, columna por cliente, una nota explicativa con el esquema y la
**cuenta de compensación asociada** (cuando el catálogo la conoce), y columnas
`EsquemaCompensacion`/`CuentaCompensacion` en el export CSV.

## Cómo agregar (o afinar) un cliente

El catálogo es declarativo y vive en
`src/config/compensationClientsCatalog.ts` (`COMPENSATION_CLIENT_RULES`).
Cada regla:

```ts
{
  scheme: 'aplica-a-proveedor' | 'descuento-en-origen',
  label: 'TLJ',                      // nombre corto visible en el panel
  clientKeys: ['00123'],             // claves JDE No_Cliente (preferible; tolerante a ceros a la izquierda)
  namePatterns: [/\bTLJ\b/i],        // patrones tolerantes sobre el nombre (fallback/refuerzo)
  cuentaCompensacion: '21.2010.xxx', // opcional — se muestra en el panel cuando se conoce
  nota: '…',                         // auditoría, no se muestra al usuario
}
```

Reglas del matching: basta que **un** criterio empate (clave **o** patrón de
nombre); primer match del arreglo gana; las claves se comparan sin ceros a la
izquierda y los nombres con case/whitespace tolerante.

Pasos:

1. Agrega la regla al arreglo (o completa `clientKeys`/`cuentaCompensacion` de
   una existente cuando cobranza confirme el dato — hoy TLJ/APTIV/CMI empatan
   por nombre porque las claves JDE están pendientes de confirmar).
2. Agrega/ajusta el test correspondiente en
   `src/config/compensationClientsCatalog.test.ts` (el seed de producción está
   cubierto caso por caso).
3. `npm run typecheck && npm test && npm run build`.

No hay nada que persistir ni versión de storage que subir: el catálogo es
código y aplica a todos los navegadores en el siguiente deploy.
