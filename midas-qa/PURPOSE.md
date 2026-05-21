# PURPOSE

## Oración de Propósito

> Este artefacto permite a la analista de tesorería evaluar el flujo de efectivo consolidado para priorizar cobros y pagos antes de comprometer la liquidez.

## Justificación

### ROL elegido
La analista de tesorería es el rol principal porque el artefacto concentra bancos, cuentas por pagar, cobranza, escenarios, pronóstico, KPIs y posición de caja. Finanzas y dirección consumen la salida, pero tesorería opera el flujo con mayor frecuencia.

### ACCIÓN elegida
La acción core es **evaluar**. El artefacto no solo muestra saldos: integra entradas, salidas, compromisos, escenarios y reglas de pago para que la persona compare alternativas antes de decidir.

### RESULTADO elegido
El resultado es priorizar cobros y pagos sin comprometer la liquidez. Es verificable porque el usuario puede contrastar caja final, flujo neto, CXP, cobranza esperada, movimientos bancarios y escenarios antes de ejecutar decisiones.

## Implicaciones para el pipeline

### Para clean-agent
Quitar funciones que no ayuden a la evaluación de flujo de efectivo consolidado, especialmente residuos de modo oscuro, componentes deshabilitados, wrappers obsoletos y patrones de diseño prohibidos que no aportan al flujo principal.

### Para ui-agent
El diseño debe enfatizar claridad, lectura rápida de caja, saldos, cobros, pagos y escenarios. La skin debe ser `corporativo` porque el propósito es consolidado y cross-empresa, no exclusivo de una subsidiaria.

### Para doc-agent
El manual debe explicar cómo revisar la posición de efectivo, filtrar compañías, interpretar cobros y pagos, usar escenarios y entender qué hacer cuando los datos no cargan.

## Diagnóstico del purpose-agent

El propósito es suficientemente sólido para continuar, pero el artefacto todavía intenta cubrir varios flujos amplios dentro de una sola herramienta. No se recomienda partirlo ahora porque todos los módulos comparten el mismo dominio de tesorería y liquidez; sí se debe evitar que módulos secundarios distraigan de la evaluación del flujo consolidado.
