# REGLAS DE NEGOCIO

Artefacto: Midas
Ultima actualizacion: 2026-04-21

> Este documento explica por que la herramienta se comporta como se comporta.
> Es util para capacitar nuevos usuarios y para revisiones de auditoria.

## Regla 1: El Escenario Base siempre existe

**Que hace?**
Mantiene un escenario original, bloqueado y visible al inicio de cada analisis.

**Por que existe?**
El usuario necesita una referencia estable para comparar cualquier cambio financiero.

**Cuando aplica?**
Aplica siempre que se carga un plan o se restauran escenarios guardados.

**Quien la definio?**
Definida por el proceso de planeacion financiera e inferida del motor de escenarios.

---

## Regla 2: Los cambios manuales pertenecen a un escenario especifico

**Que hace?**
Un ajuste manual de una celda solo modifica el escenario donde se capturo. No contamina otros escenarios.

**Por que existe?**
Permite comparar alternativas sin perder la trazabilidad de cada caso.

**Cuando aplica?**
Aplica al editar el pronostico en vista mensual.

**Quien la definio?**
Definida por la logica de escenarios de tesoreria.

---

## Regla 3: Los overrides manuales se aplican despues de las propuestas

**Que hace?**
Primero calcula el efecto de propuestas y simulaciones. Despues aplica el valor manual capturado por el usuario.

**Por que existe?**
El ajuste manual representa la decision final del usuario sobre una celda especifica.

**Cuando aplica?**
Aplica en la evaluacion mensual de escenarios con cambios manuales.

**Quien la definio?**
Definida en el flujo operativo de simulacion financiera.

---

## Regla 4: Solo se editan conceptos hoja

**Que hace?**
Permite editar conceptos detallados, pero no conceptos resumen ni reservas.

**Por que existe?**
Los totales y saldos deben calcularse a partir del detalle para evitar inconsistencias.

**Cuando aplica?**
Aplica al seleccionar celdas editables en el pronostico.

**Quien la definio?**
Definida por control financiero e inferida de la estructura del plan.

---

## Regla 5: La caja final se calcula acumulando el flujo neto

**Que hace?**
Parte de la caja inicial y suma el flujo neto de cada periodo para obtener la caja final.

**Por que existe?**
La posicion de caja depende del saldo inicial mas entradas menos salidas.

**Cuando aplica?**
Aplica en todas las vistas de pronostico y comparacion de escenarios.

**Quien la definio?**
Definida por la practica contable de flujo de efectivo.

---

## Regla 6: La caja minima es el punto mas bajo del escenario

**Que hace?**
Identifica el menor saldo de caja dentro del horizonte evaluado.

**Por que existe?**
Ayuda a detectar meses o dias donde la liquidez puede quedar comprometida.

**Cuando aplica?**
Aplica en KPIs y comparaciones de escenarios.

**Quien la definio?**
Definida por tesoreria como indicador de riesgo de liquidez.

---

## Regla 7: La fecha real de cobro sigue el calendario del cliente

**Que hace?**
Si la fecha teorica no coincide con un dia valido de pago del cliente, el cobro se mueve a la siguiente ocurrencia de su propio ciclo.

**Por que existe?**
Muchos clientes pagan solo en dias o semanas especificas. Mover al siguiente dia habil no reflejaria su proceso real.

**Cuando aplica?**
Aplica a clientes con patrones de pago semanales, quincenales, mensuales, por dia de mes o por semana del mes.

**Quien la definio?**
Definida por la regla operativa de cobranza indicada para el artefacto.

---

## Regla 8: La cobranza mensual se divide por frecuencia

**Que hace?**
Divide la facturacion mensual en 4 eventos para frecuencia semanal, 2 para quincenal y 1 para mensual o contado.

**Por que existe?**
Permite proyectar entradas de efectivo con mayor precision que un solo monto mensual.

**Cuando aplica?**
Aplica al proyectar cobros de clientes.

**Quien la definio?**
Definida por el modelo de cobranza del artefacto.

---

## Regla 9: El cumplimiento reduce el monto, no cambia la fecha

**Que hace?**
Aplica el porcentaje de cumplimiento al importe esperado, pero conserva la fecha de cobro proyectada.

**Por que existe?**
La herramienta proyecta caja; la parte no cobrada se trata como reduccion esperada, no como una reprogramacion.

**Cuando aplica?**
Aplica al calcular eventos de cobranza por cliente.

**Quien la definio?**
Definida por el modelo de proyeccion de cobranza.

---

## Regla 10: El factoraje usa su propio plazo

**Que hace?**
Cuando un cliente esta marcado con factoraje, la fecha real se calcula desde la factura usando el plazo de factoraje.

**Por que existe?**
El factoraje cambia la mecanica de cobro y no depende del calendario normal de pago del cliente.

**Cuando aplica?**
Aplica a clientes identificados como factoraje.

**Quien la definio?**
Definida por la practica de financiamiento de cobranza.

---

## Regla 11: Enero puede incluir facturas de meses anteriores

**Que hace?**
El motor mira hacia atras lo suficiente para no perder cobros reales que caen dentro del ano evaluado aunque la factura venga de meses previos.

**Por que existe?**
Los creditos y ciclos de pago pueden desplazar cobros de diciembre hacia enero.

**Cuando aplica?**
Aplica al proyectar la cobranza anual.

**Quien la definio?**
Definida por necesidad de corte anual de tesoreria.

---

## Regla 12: Las transferencias internas no cuentan como flujo operativo

**Que hace?**
Excluye traspasos entre cuentas propias del calculo de flujo de efectivo.

**Por que existe?**
Un traspaso interno no crea ni consume efectivo del negocio; contarlo inflaria cobros y pagos.

**Cuando aplica?**
Aplica en el flujo de efectivo consolidado. La vista de bancos puede seguir mostrando esos movimientos para conciliacion.

**Quien la definio?**
Definida por tesoreria y conciliacion bancaria.

---

## Regla 13: Los estados de cuenta se consolidan por fecha y cuenta

**Que hace?**
Cuando se consultan varios dias, deduplica movimientos repetidos y conserva saldo inicial del dia mas antiguo y saldo final del dia mas reciente con datos.

**Por que existe?**
El sistema de contabilidad entrega estados por fecha; la herramienta necesita una vista de rango sin duplicar movimientos.

**Cuando aplica?**
Aplica al consultar bancos por rangos o al consolidar movimientos diarios.

**Quien la definio?**
Definida por integracion operativa con bancos y tesoreria.

---

## Regla 14: La CXP se clasifica por antiguedad

**Que hace?**
Separa pagos por vencer y vencidos en buckets de 1-30, 31-60, 61-90, 91-120, 121-150, 151-180 y mas de 180 dias.

**Por que existe?**
Tesoreria necesita priorizar obligaciones vencidas y detectar concentracion de riesgo.

**Cuando aplica?**
Aplica en cuentas por pagar y tableros de antiguedad.

**Quien la definio?**
Definida por el proceso de Cuentas por Pagar.

---

## Regla 15: La flexibilidad del proveedor se resuelve por catalogo

**Que hace?**
Clasifica proveedores como inamovibles, flexibles, revisar o sin clasificar. Primero busca por nombre exacto y luego por clasificacion.

**Por que existe?**
No todos los pagos pueden moverse con el mismo criterio. Algunos requieren pago obligatorio y otros autorizacion del area.

**Cuando aplica?**
Aplica al enriquecer saldos de CXP y al revisar pagos pendientes.

**Quien la definio?**
Definida por catalogos internos de proveedores y criterios de Cuentas por Pagar.

---

## Regla 16: La criticidad DTI se muestra cuando existe

**Que hace?**
Marca proveedores de tecnologia con criticidad Alta, Media o Baja cuando el catalogo lo informa.

**Por que existe?**
Los pagos a proveedores criticos pueden afectar continuidad operativa.

**Cuando aplica?**
Aplica en el analisis de proveedores y CXP cuando el proveedor esta en el catalogo DTI.

**Quien la definio?**
Definida por el area DTI.

---

## Regla 17: Pausar gasto equivale a reducirlo al 100 por ciento

**Que hace?**
Una propuesta de pausa genera una reduccion completa del concepto durante los meses seleccionados.

**Por que existe?**
Permite modelar el efecto de suspender temporalmente un gasto.

**Cuando aplica?**
Aplica en simulaciones de tipo pausa de gasto.

**Quien la definio?**
Definida por el modelo de simulacion financiera.

---

## Regla 18: Los cambios porcentuales usan la base del concepto

**Que hace?**
Un ajuste porcentual calcula el impacto sobre el valor base del concepto o grupo seleccionado.

**Por que existe?**
Un porcentaje debe escalar con el monto real del concepto, no con una cifra fija.

**Cuando aplica?**
Aplica a incrementos o reducciones porcentuales.

**Quien la definio?**
Definida por la logica financiera de escenarios.

---

## Regla 19: Los planes en parcialidades se distribuyen por asignacion

**Que hace?**
Divide un monto entre parcialidades. Si hay asignacion personalizada valida, la normaliza; si no, reparte en partes iguales.

**Por que existe?**
Permite modelar pagos o cobros diferidos sin perder el total de la propuesta.

**Cuando aplica?**
Aplica en simulaciones de parcialidades.

**Quien la definio?**
Definida por el modelo de propuestas financieras.

---

## Regla 20: Mover timing quita de un periodo y agrega en otro

**Que hace?**
Al mover un cobro o pago, descuenta el monto del periodo origen y lo suma al periodo destino.

**Por que existe?**
Mover una fecha cambia el calendario de caja, pero no debe duplicar ni eliminar el importe.

**Cuando aplica?**
Aplica en propuestas de desplazamiento de cobros o pagos.

**Quien la definio?**
Definida por tesoreria para comparacion de escenarios.

---

## Reglas pendientes de documentar

- Confirmar con Tesoreria si el supuesto de factura el dia 1 de cada mes debe mantenerse o reemplazarse por fechas reales por evento.
- Confirmar con Cuentas por Pagar la fuente oficial y periodicidad de actualizacion del catalogo de flexibilidad.
- Confirmar con DTI el propietario del catalogo de criticidad y el proceso para cambios de Alta, Media o Baja.
- Los catalogos de clientes y proveedores viven como JSON local (`catalog.service.ts`); no dependen de un servicio externo de reportes.
