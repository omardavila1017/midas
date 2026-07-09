# Fiscal — Coordinados, IVA acreditable y tasas de ingreso

> Fuente: José Luis Gallegos (Fiscal Senda), correo del 8-jul-2026 + escritos
> CANAPAT al SAT (29-ene-2026) + reportes `SIR/TT. Reporte Egreso - Ingreso
> JDE.xlsx`. Este documento es el **mapa de negocio**; la implementación vive en
> `src/config/` y `src/modules/taxes/`.

Cierra el "pendiente de coordinación" del PR #175 (Bloque 1 Impuestos): vuelve
**autoritativo** el catálogo de coordinado fiscal y mete las reglas reales de IVA
acreditable (exclusiones) e IVA de ingresos (tasas 16 % / 8 %).

## Procedencia de los archivos (2026-07-09 — recibidos)

Los 4 adjuntos originales de José Luis se recibieron y procesaron el 9-jul-2026:

| Archivo | Qué aportó |
|---|---|
| `1.-Escrito CANAPAT Coordinado TT 2026.pdf` | Lista oficial de integrantes del coordinado TT + RFC + bandera "opta por coordinado" + personas físicas. |
| `2.-Escrito CANAPAT Coordinado SIR 2026.pdf` | Lista oficial de integrantes del coordinado SIR + RFC. |
| `TT. Reporte Egreso - Ingreso JDE.xlsx` | Egresos (`Gastos TT`) + Ingresos (`Ingresos TT`) de la cabeza `00001`. |
| `SIR. Reporte Egreso - Ingreso JDE.xlsx` | Egresos (`Gastos SIR`) + Ingresos (`Ingresos SIR`) de la cabeza `00011`. |

**Con esto TODOS los RFC de ambos coordinados quedaron confirmados** (los que en
la primera pasada estaban por OCR ilegible: TICH, Servicios Industriales Senda,
Zacatecano).

> ⚠️ **Los Excel están filtrados por empresa cabeza.** Su columna `Cia`/`Nombre
> Cia` sólo trae `00001` (TT) / `00011` (SIR); los demás integrantes aparecen
> únicamente como **proveedores "Filiales"** (con su RFC), NO como `Cia`. Por eso
> el Excel **NO** entrega los códigos de cía JDE de los miembros — el **RFC del
> escrito** es la llave autoritativa de cada integrante, y los códigos de cía que
> ya se conocen salen del `AUXILIAR_CIA_ALLOWLIST` / TRESS, no del Excel.

## 1. Coordinados fiscales (autoritativo)

Dos coordinados; declaran de forma conjunta ante el SAT (régimen de coordinados,
Título II Cap. VII LISR). Apoderado legal de ambos: **José Luis Gallegos Ortiz**
(RFC GAOL870905DM2). Implementado en `src/config/coordinadoFiscalCatalog.ts`
(precedencia **código de cía → RFC → nombre**).

### Coordinado TT — Transportes Tamaulipas (cabeza cía `00001`, RFC TTA4906038F4)

| Empresa | RFC | Cía JDE | Opta coord. | Fuente del código |
|---|---|---|---|---|
| Transportes Tamaulipas (cabeza) | TTA4906038F4 | `00001` | Sí | allowlist + TRESS |
| Servicios T de N (STDN) | STN041111521 | `00038` | Sí | allowlist |
| Servicios Especializados Senda (SES) | SES051125TR5 | `00043` | Sí | allowlist |
| Turimex del Norte | TNO010131U98 | *(por RFC)* | Sí | — |
| Inmuebles Autobuses Coahuilenses | IAC0708207S2 | *(por RFC)* | Sí | aparece como filial en `Gastos TT` |
| Operadora de Ventas Grupo Senda | OVG1003022X6 | *(por RFC)* | Sí | — |
| Autotransporte Adventur | AAD040311G68 | *(por RFC)* | Sí | — |
| Oficios y Proyectos en Recl. y Clasif. de Personal de NL | OPR100525RU0 | *(por RFC)* | Sí | — |
| **Multicarga** | MUL9707108M3 | `00033` | **NO** | opta por separado → Sin coordinado |

Personas físicas integrantes (no son cías JDE; se documentan, no se mapean):

| Persona | RFC |
|---|---|
| David Rodríguez Benítez | ROBD690204NW6 |
| María Elena Rodríguez Benítez | ROBX651113GP4 |
| Jaime Protasio Rodríguez Benítez | ROBJ671108J36 |
| Alberto Rodríguez Benítez | ROBX7005239Z3 |
| Jaime Rodríguez Silva | ROSJ360514VE7 |

### Coordinado SIR — Servicio Industrial Regiomontano (cabeza cía `00011`, RFC SIR870615345)

| Empresa | RFC | Cía JDE | Opta coord. | Fuente del código |
|---|---|---|---|---|
| Servicio Industrial Regiomontano (cabeza) | SIR870615345 | `00011` | Sí | allowlist + TRESS |
| Transportes Industriales Chihuahuenses (TICH) | TIC0510111G4 | `00042` | Sí | allowlist + TRESS; aparece como filial en `Gastos SIR` |
| Servicios Industriales Senda | TIJ051011HF9 | *(por RFC)* | Sí | RFC confirmado (era OCR ilegible) |
| Servicio Industrial Potosino | SIP990527FA0 | *(por RFC)* | Sí | — |
| Senda Servicio Industrial | SSI0502091T6 | *(por RFC)* | Sí | — |
| Servicio Industrial Zacatecano | SIZ1309177E6 | *(por RFC)* | Sí | RFC confirmado (era OCR ilegible) |

**Multicarga (cía `00033`)** aparece en el escrito TT con la bandera *"opta por
coordinado: NO"* → declara por separado → cae a **"Sin coordinado"**
(`COORDINADO_OPT_OUT` en el catálogo).

**Sobre la cía `00017` (SIT):** el mapa TRESS `idEmpresa` lista `17 → SIT`
(familia "Servicio Industrial"), por eso el catálogo la agrupa en SIR. **Ojo: el
escrito SIR NO lista ninguna empresa llamada "SIT"** — sus 6 integrantes son los
de la tabla de arriba. `00017` se conserva en SIR como código TRESS-autoritativo,
pero **no está amarrada por RFC a un integrante específico del escrito**
(pendiente abajo).

**Pendientes** (ya NO por RFC — todos confirmados):
1. **Códigos de cía JDE de los integrantes marcados *"por RFC"***. El Excel es
   por-cabeza (no los trae). Para amarrarlos hace falta o bien el catálogo de
   compañías JDE (`Company.cia` × `rfc`), o una consulta JDE por RFC. Hasta
   entonces el resolver los ubica por RFC/nombre (funciona; sólo no tenemos el
   código numérico).
2. **A qué integrante del escrito corresponde exactamente la cía `00017` (SIT)**
   dentro de SIR.

## 2. IVA acreditable — conceptos excluidos

Del reporte de Egresos de JDE, Fiscal **quita** estos 8 conceptos para el IVA
acreditable (JDE los trae, pero no generan acreditable). Catálogo editable en
`src/config/ivaCreditableExclusions.ts`; se aplica en `src/domain/ivaLedger.ts`
(lado acreditable del libro mayor) y en `taxModuleService.ts` (`addIvaCreditable`,
estimadores CXP/OC/movimientos). **No toca el IVA causado.**

1. Empleados 2. Asociación Protacio 3. OCSI 4. Pensiones 5. Nómina 6. Vales
7. Reembolsos 8. Reposiciones

El match es sobre el texto descriptivo del asiento/proveedor (contraparte +
concepto + explicación), tolerante a acentos y con límites de palabra para
evitar falsos positivos.

**Validado contra los Excel (2026-07-09).** Las hojas `Gastos TT`/`Gastos SIR`
confirman que JDE sí reporta IVA acreditable sobre estos conceptos (por eso hay
que quitarlo). Acreditable MXP que caería sin las exclusiones:

| Concepto | Acreditable TT | Acreditable SIR |
|---|---:|---:|
| OCSI | $181,585 | $745,164 |
| Pensiones | $214,907 | $18,546 |
| Empleados | $0 | $33,104 |
| Vales / Reembolsos / Reposiciones | ~$3,491 | ~$9,586 |

**Pendiente (confirmar con Fiscal, NO incluido — sin instrucción explícita):** en
`Gastos SIR` la clasificación de proveedor **"Recursos Humanos"** carga
~$155,874 de acreditable y **"Nominas / Reembolsos / Vales"** ~$1,678. ¿Se
excluyen también? Hoy sólo se quita lo que cae por los 8 conceptos de arriba.

## 3. IVA de ingresos — tasas 16 % y 8 %

El ingreso se parte en **16 %** y **8 %** (8 % = región fronteriza norte). Cuando
sólo hay el monto del depósito (sin desglose de factura), método de Fiscal:

```
base = depósito / (1 + tasa/100)     (÷1.16 ó ÷1.08)
IVA  = depósito − base               (= base × tasa/100)
```

cotejado contra la factura. La tasa por empresa/región vive en
`src/config/ivaRegionRates.ts`. Implementado en `accumulateCobranzaPaymentIva`
(`taxModuleService.ts`): cuando la factura trae su IVA, **ese IVA manda** (tasa
de la factura); sólo los cobros-depósito gravables SIN IVA de factura caen al
catálogo de tasa por región; los exentos / tasa 0 / sin indicador se ignoran (sin
sobre-gravar).

**Evidencia de los Excel (2026-07-09) → el catálogo se queda VACÍO (todo 16 %).**
Las hojas `Ingresos TT`/`Ingresos SIR` traen la tasa POR FACTURA (`tasa iva`):

| Empresa | 16 % (IVA) | 8 % (IVA) | Otros | Lectura |
|---|---:|---:|---|---|
| TT (`00001`) | — | — | 100 % FEDERAL, IVA $0 | Transporte de pasaje exento — el IVA de ingresos es $0. |
| SIR (`00011`) | $28.97M (1,179 fact.) | $2.90M (82 fact.) | IVA0 (20) · EXTO (1) | Mayoría 16 %; el 8 % es una minoría **por factura**, no por cía. |

Conclusión: el 8 % **no es un atributo por empresa** — es por factura/servicio en
la franja fronteriza, y la factura ya lo trae. Marcar SIR como 8 % *blanket*
sobre-gravaría su 16 %. Por eso `IVA_REGION_RATE_RULES` se mantiene vacío: el
default 16 % coincide con la mayoría real y la factura gobierna el 8 % donde
aplica. Sólo llenar `cias`/`rfcs` si Fiscal confirma una cía fronteriza de forma
uniforme (que hoy no se observa en los datos).
