# Clasificación de Proveedores + Gasto Mínimo de Operación

## Qué es esto

`proveedores-clasificacion.json` contiene los 478 proveedores de Senda con
clasificación importada desde `Plantilla de Provedores2.xlsx`. Cada proveedor
trae su **clasificación Alberto** (override manual) y, cuando hay histórico de
pagos 2025, un **gasto mínimo mensual** estimado.

## Cómo se calcula el gasto mínimo

```
gastoMinimoMensual = montoPromedioPago × multiplicadorFrecuencia
```

Donde el multiplicador convierte la frecuencia natural a una métrica mensual:

| Frecuencia            | Multiplicador (veces/mes) |
|-----------------------|---------------------------|
| Diario                | 22 (días hábiles)         |
| Semanal               | 4.33                      |
| Quincenal             | 2                         |
| Mensual               | 1                         |
| Bimestral/Trimestral  | 0.4                       |
| Semestral             | 0.167                     |
| Anual/Esporádico      | 0.083                     |
| Pago único            | 0                         |

## Cifras clave (al generar el JSON, abr 2026)

- **478** proveedores totales con scoring
- **126** clasificados como CRÍTICO por Alberto
- **107** críticos (84.9%) con gasto mínimo mensual calculable
- **$27.6M MXN/mes** = suma del gasto mínimo de los críticos
- **$331M MXN/año** proyectado como piso operativo
- **19** críticos sin histórico (pensión alimenticia, embargos, permisos
  municipales, etc.) — requieren input manual

## Estructura del JSON

```ts
{
  meta: {
    generadoDesde: string;
    fechaGeneracion: string;
    totalProveedores: number;
    totalConHistoricoPagos: number;
    multiplicadoresFrecuencia: Record<string, number>;
    criteriosScoring: { sustituibilidad, impactoOperativo, riesgoLegal, diasCredito };
    umbrales: Record<'CRITICO'|'ALTO'|'MEDIO'|'BAJO', [number, number]>;
  };
  proveedores: Array<{
    numProveedor: string;
    nombre: string;
    categoria: string;
    clasificacionAlberto: 'CRITICO'|'FLEX_ALTO'|'FLEX_MEDIO'|'FLEX_BAJO'|'PAUSAR'|'SIN_CLASIFICAR';
    clasificacionAlbertoRaw: string;          // texto original "(a) Crítico"
    override: string | null;
    frecuencia: string | null;                // "Semanal" | "Mensual" | …
    montoPromedioPago: number | null;         // en MXN
    numPagos2025: number | null;
    montoTotal2025: number | null;
    gastoMinimoMensual: number | null;        // calculado
  }>;
}
```

## Plan de integración a FlowSense

Pasos para conectar este JSON con la proyección operativa:

### 1. Extender el tipo `Provider` (`src/domain/types.ts`)

Agregar campos opcionales (no-breaking):

```ts
export type ClasificacionAlberto =
  | 'CRITICO'
  | 'FLEX_ALTO'
  | 'FLEX_MEDIO'
  | 'FLEX_BAJO'
  | 'PAUSAR'
  | 'SIN_CLASIFICAR';

export interface Provider {
  // … campos existentes …
  clasificacionAlberto?: ClasificacionAlberto;
  gastoMinimoMensual?: number;
  frecuenciaHistorica?: string;
  montoPromedioPago?: number;
}
```

### 2. Cargar el JSON en `loadProvidersCatalog`

En `src/domain/loadProvidersCatalog.ts`, después de cargar el catálogo base,
hacer merge con `proveedores-clasificacion.json` matcheando por `numProveedor`
(o por nombre normalizado como fallback).

### 3. Línea de "gasto mínimo de operación" en la proyección

En `OperatingProjection.tsx`, agregar una línea nueva en el bloque de egresos:

- **Etiqueta:** "Gasto mínimo de operación (proveedores críticos)"
- **Color:** fondo amarillo (`bg-yellow-100`/`bg-yellow-200` con texto oscuro)
- **Monto mensual:** suma de `gastoMinimoMensual` de todos los proveedores
  con `clasificacionAlberto === 'CRITICO'`
- **Comportamiento:** se prorratea día a día (monto / días del mes) en la vista
  diaria; aparece como una sola línea en la mensual
- **Tooltip:** lista de los proveedores que componen ese piso
- **Editable:** sí — botón "Ajustar" que permite override manual del piso

### 4. Filtro nuevo en el supplier queue

En `SupplierFlexFilter`, agregar opción `'critico-alberto'` para mostrar solo
los 126 críticos cuando se quiera revisar uno por uno.

### 5. Mantenimiento

Cuando Alberto actualice la plantilla:

1. Reemplazar `Plantilla de Provedores2.xlsx` (en uploads o ruta acordada)
2. Volver a correr el importador (script aún por crear en `scripts/`)
3. El JSON se regenera y FlowSense toma los cambios al siguiente refresh

## Por hacer (todavía sin código)

- [ ] Crear script `scripts/import-proveedores-clasificacion.ts` reproducible
- [ ] Extender `Provider` type
- [ ] Hook en `loadProvidersCatalog` para hacer merge
- [ ] Componente UI de la línea amarilla en `OperatingProjection.tsx`
- [ ] Tests para cálculo del piso mensual
- [ ] Override manual del piso (editor en UI)
- [ ] Tooltip con desglose de proveedores que componen el piso
