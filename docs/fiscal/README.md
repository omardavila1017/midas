# Fiscal — Coordinados, IVA acreditable y tasas de ingreso

> Fuente: José Luis Gallegos (Fiscal Senda), correo del 8-jul-2026 + escritos
> CANAPAT al SAT (29-ene-2026). Este documento es el **mapa de negocio**; la
> implementación vive en `src/config/` y `src/modules/taxes/`.

Cierra el "pendiente de coordinación" del PR #175 (Bloque 1 Impuestos): vuelve
**autoritativo** el catálogo de coordinado fiscal y mete las reglas reales de IVA
acreditable (exclusiones) e IVA de ingresos (tasas 16 % / 8 %).

## ⚠️ Nota de procedencia de los archivos

Los 4 adjuntos originales de José Luis (`SIR. Reporte Egreso - Ingreso JDE.xlsx`,
`TT. Reporte Egreso - Ingreso JDE.xlsx`, `1.-Escrito CANAPAT Coordinado TT
2026.pdf`, `2.-Escrito CANAPAT Coordinado SIR 2026.pdf`) **no estaban presentes
en el entorno** donde se hizo este cambio (ni en el repo ni accesibles por
correo/Drive). El mapeo autoritativo se construyó con:

1. La **transcripción de los escritos CANAPAT** que aportó Santiago (las listas
   de empresas por coordinado + RFC + cabeza de cada coordinado — abajo).
2. Los **registros de cía JDE que ya viven en el repo** (fuente autoritativa
   interna):
   - `AUXILIAR_CIA_ALLOWLIST` en `src/domain/auxiliarReconciliationConfig.ts`:
     `00001` TAMAULIPAS · `00011` SIR · `00033` MULTICARGA · `00038` STDN ·
     `00042` TICH · `00043` SES.
   - Mapa TRESS `idEmpresa` en `src/services/jdeTypes.ts`:
     `1` Federal (=Tamaulipas) · `11` SIR · `17` SIT · `33` Multicarga · `42` TICH.
   - `src/assets/bankAccountsCatalog.json` (razón social × `unidadNegocio`).

**Al recibir los Excel de José Luis**, verificar/cerrar los códigos de cía que
aquí quedaron por RFC/nombre (ver "pendientes" abajo) leyendo la columna
`Cia`/`Nombre Cia` de las hojas `Gastos`/`Ingresos`.

## 1. Coordinados fiscales (autoritativo)

Dos coordinados; declaran de forma conjunta ante el SAT (régimen de coordinados,
Título II Cap. VII LISR). Implementado en `src/config/coordinadoFiscalCatalog.ts`
(precedencia **código de cía → RFC → nombre**).

### Coordinado TT — Transportes Tamaulipas (cabeza cía `00001`, RFC TTA4906038F4)

| Empresa | RFC | Cía JDE | Fuente del código |
|---|---|---|---|
| Transportes Tamaulipas (cabeza) | TTA4906038F4 | `00001` | allowlist + TRESS |
| Servicios T de N (STDN) | STN041111521 | `00038` | allowlist |
| Servicios Especializados Senda (SES) | SES051125TR5 | `00043` | allowlist |
| Turimex del Norte | TNO010131U98 | *(por RFC/nombre)* | pendiente Excel |
| Operadora de Ventas Grupo Senda | OVG1003022X6 | *(por RFC/nombre)* | pendiente Excel |
| Autotransporte Adventur | AAD040311G68 | *(por RFC/nombre)* | pendiente Excel |
| Oficios y Proyectos en Recl. y Clasif. de Personal de NL | OPR100525RU0 | *(por RFC/nombre)* | pendiente Excel |
| Inmuebles Autobuses Coahuilenses | IAC0708207S2 | *(por RFC/nombre)* | pendiente Excel |
| **Multicarga** | MUL9707108M3 | `00033` | **opta por coordinado: NO** → Sin coordinado |

Personas físicas integrantes (no son cías JDE; se documentan, no se mapean):
David Rodríguez Benítez · María Elena Rodríguez Benítez · Jaime Protasio
Rodríguez Benítez · Alberto Rodríguez Benítez · Jaime Rodríguez Silva.

### Coordinado SIR — Servicio Industrial Regiomontano (cabeza cía `00011`, RFC SIR870615345)

| Empresa | RFC | Cía JDE | Fuente del código |
|---|---|---|---|
| Servicio Industrial Regiomontano (cabeza) | SIR870615345 | `00011` | allowlist + TRESS |
| Transportes Industriales Chihuahuenses (TICH) | TIC051011… | `00042` | allowlist + TRESS |
| SIT (familia Servicio Industrial) | *(verificar)* | `00017` | TRESS `idEmpresa` |
| Servicio Industrial Potosino | SIP990527FA0 | *(por RFC/nombre)* | pendiente Excel |
| Senda Servicio Industrial | SSI0502091T6 | *(por RFC/nombre)* | pendiente Excel |
| Servicios Industriales Senda | *(OCR ilegible)* | *(por nombre)* | pendiente Excel |
| Servicio Industrial Zacatecano | SIZ130917… | *(por RFC/nombre)* | pendiente Excel |

**Multicarga (cía `00033`)** aparece en el escrito TT con la bandera *"opta por
coordinado: NO"* → declara por separado → cae a **"Sin coordinado"**
(`COORDINADO_OPT_OUT` en el catálogo).

**Pendientes** (al llegar los Excel): confirmar los códigos de cía JDE de las
empresas marcadas *"por RFC/nombre"*, el RFC de TICH / Servicios Industriales
Senda / Zacatecano (OCR ilegible), y a qué empresa corresponde exactamente la
cía `00017` (SIT) dentro de SIR.

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

## 3. IVA de ingresos — tasas 16 % y 8 %

El ingreso se parte en **16 %** y **8 %** (8 % = región fronteriza norte). Cuando
sólo hay el monto del depósito (sin desglose de factura), método de Fiscal:

```
base = depósito / (1 + tasa/100)     (÷1.16 ó ÷1.08)
IVA  = depósito − base               (= base × tasa/100)
```

cotejado contra la factura. La tasa por empresa/región vive en
`src/config/ivaRegionRates.ts` (**arranca vacío ⇒ todo 16 %**; Fiscal marca qué
cías aplican el 8 % fronterizo por código de cía/RFC/nombre). Cuando la factura
sí trae su IVA, ese IVA manda (se cotejó). Implementado en
`accumulateCobranzaPaymentIva` (`taxModuleService.ts`): los cobros exentos /
tasa 0 / sin indicador se siguen ignorando (sin sobre-gravar).
