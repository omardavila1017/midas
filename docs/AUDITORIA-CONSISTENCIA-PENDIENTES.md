# Auditoría de consistencia entre módulos — estado por tanda

Estado de la auditoría multi-agente (38 hallazgos verificados). Sitios exactos + decisión
requerida para lo que falta, para que cada tanda siguiente sea turnkey.

## ✅ Aplicado (PR #187)

**Contrato de datos / misma verdad**
- **#1.1** `TAB_DATASETS` = contrato real: taxes/concurso/pagos `+banks`, pagos `+compras`,
  kpisObjectives `+compras/nomina/rol/auxiliar`.
- **#1.2** Salud de datos: no pinta "Al día" lo que nunca sincronizó → "Sin cargar".
- **#1.3** `fideicomiso` deja de sobre-pedir `cobranza`.
- **#2.1** Bancos: banner "carga manual local — solo en este navegador; otros no la ven".
- **#2.2** Usuarios/Permisos: `LocalRegistryNote` — las ediciones del portal no se propagan.
- **#12** Usuarios/Permisos: banner "el acceso no está siendo forzado" (bypass `Senda123`).

**Métricas / terminología**
- **#3.3** `isCxpOverdue()` único (diasVencida>0 || dueDate<hoy) en tarjeta CXP + por-proveedor + KPI.
- **#3.5** columnas "Antigüedad (pedido)" vs "(recepción)".
- **#3.6/#11** *Liquidez inmediata* ≠ *Cobertura CXP con caja* (ahora = caja / CXP vencida).
- **#5.1** "Pasivo por distribuir" unificado en Compras (KPI/chip/filtro/CSV) + tab dedicado.
- **#5.4** ROL "Huérfano"→"Sin cruce"; Pagos "Huérfano" con tooltip "sin conciliar (revisar)".
- **#5.6** "Int. CM" → "Intereses Concurso Mercantil".

**Presentación / navegación**
- **#4.1** tab "Base" → "Real a hoy" + tooltip que aclara dónde vive la proyección.
- **#5.2 (parcial)** header "Flujo de efectivo" → "Flujo Neto".
- **#6.2** nota puente en Nómina → el egreso de caja vive en Egresos/Planeación.
- **#6.3** drill-down "Ingresos/Egresos YTD" → Flujo Neto (caja real).
- **#7.2** CXP → botón "Exportar CSV" (csvDate + BOM).
- **#8.3** calendario Cobranza → tokens DS (arregla dark mode).
- **#8.4** Providers/ProviderDetailModal moneda vía `formatters.ts`.

## 🟢 Mecánico, bajo riesgo — PASADA COMPLETA (media pasada = nueva inconsistencia)

- **#8.2 fechas.** Envolver ISO crudo con `fmtDate` de un jalón: `CXP.tsx:1282-1283,1674`,
  `Compras.tsx:1088(title),1207,1225`, `Pagos.tsx:1233,1305,1325,1330,1370`,
  `CollectionProjection.tsx:764`, celdas de `Bancos.tsx`. Borrar helpers locales
  `formatDate/formatDateMx` (`CashFlowDetail.tsx:1046`, `MovementPickerModal.tsx:156`,
  `CashTroughAlertBanner`) — corrige de paso el drift día-1 en UTC-6. `csvDate` solo export.
- **#8.5 font-mono.** Quitar `font-mono` de celdas de MONEDA (no de referencias) →
  tabular-nums: `Bancos.tsx:829/841/852/888/956/1030/1088/1328/1331`, `CXP.tsx:435`,
  `PasivoDistribuir.tsx:316`. (Se resuelve solo si se hace #8.1 en Bancos.)
- **#8.6 porcentajes.** ⚠️ Requiere verificar la ESCALA de cada var (decimal 0-1 → `fmtPct`;
  0-100 → `fmtPctInt`) — equivocarse muestra 8500%. Sitios en `CollectionProjection.tsx`:
  620,664,690,754,1066,1111,1196,2015,2462,2502. Fijar política de decimales única.
- **#5.3 nombre CXP.** Unificar "Antigüedad de Saldo(s)" en sidebar/header/boot/Salud.
- **#5.5 vocabulario.** "Sin clasificar" para el caso genérico. ⚠️ `bucketVisuals`/
  `OUTFLOW_BUCKET_ORDER` indexan por string exacto — cambiar TODAS las refs juntas. NO
  fusionar 'Empresas del grupo'/'Traspasos internos' (son clasificaciones precisas).
- **#7.3** botón "Actualizar" consistente en Compras/Pagos/Pasivo (o quitarlo de CXP).
- **#9.2** subtítulo de etapa por tab de Egresos.

## 🟡 Requiere TU decisión (dinero / terminología / IA)

- **#3.1 "caja" canónica.** 4-5 definiciones; dos tarjetas dicen "Caja actual" con cálculo
  distinto. Elegir UNA (recom.: concentradoras = "Caja disponible") en helper único; etiquetar
  el resto. **Decisión: ¿cuál def gana?**
- **#3.2 "¿cuánto debo?" unificado.** Tarjeta de pasivo total con split DEVENGADO (CXP +
  pasivo por distribuir) vs COMPROMISO (backlog OC). NO lumpar. **Decisión: dónde y qué cuenta.**
- **#3.4 señal "pagada".** Chip CXP (legacy) vs proyección (Auxiliar) pueden discrepar.
  Unificar a `paidCxpKeys`. Parte del rewrite de tabs display.
- **#4.2** guard de salud en `MidasBubble` (ocultar si OpenAI no alcanzable). Chequeo async.
- **#4.3** compensación cobranza: gate en `clientKeys` confirmadas; matches solo-por-nombre →
  "posible compensación (por confirmar)" que SIGA contando en descuadre.
- **#9.1** landing de Ingresos (hoy Flujo Neto, bank-only). ¿`DEFAULT_TAB.cobranza`→collections?

## 🔵 Feature — PR propio

- **#6.1 drill-down entre módulos (mayor win).** Construir el LECTOR de `midas.navFocus` en los
  10 tabs hoja (hoy inexistente), luego enlaces de fila: OC→CXP→Pago→Banco, Cliente→Cobranza,
  Proveedor→CXP/Pagos, Pasivo→OC.
- **#7.1 filtro por empresa unificado.** Un `CompanyMultiSelect` en todos los tabs por-cía
  (falta en Pagos/Compras/Pasivo/Bancos; 4 widgets distintos hoy).
- **#7.4** Pasivo: strip de antigüedad clicable + expandir OC a líneas (reusar foco de Compras).
- **#8.1 tarjeta KPI única.** Migrar las 6 variantes a `components/ui/KpiCard` y borrar las 5
  duplicadas. (Compras ya usa la canónica.)

## 🔴 Bloqueado en backend (store server-side / BD Carlos-Javi)

- **#2.1 / #2.2 (fix real):** cargas manuales de bancos + ediciones Usuarios/Permisos siguen
  por-navegador. El banner ya avisa; la propagación real espera `VITE_STORE_ENABLED` + el store
  compartido (`docs/MIGRACION-ESTADO-SERVIDOR.md`).
