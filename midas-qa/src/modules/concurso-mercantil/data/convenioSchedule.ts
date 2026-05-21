// ─────────────────────────────────────────────────────────────────────────
// Convenio Concursal — calendario de amortización (datos congelados en código).
//
// Origen: Libro2.xlsx, hoja "CONVENIO CONCURSAL" (plan de pagos del concurso
// con bancos y proveedores). El archivo llegó como adjunto de Outlook y NO se
// vuelve a obtener; por eso el calendario vive aquí como dataset permanente.
//
// UNIDADES: todas las cifras (interes, capital, saldos, tramos) están **en
// miles de pesos**, tal como en el Excel. Para obtener MXN reales multiplica
// por `CONVENIO_UNIT_SCALE`. Nunca compares estos números crudos contra
// movimientos bancarios sin escalar primero — el chokepoint es `toConvenioMxn`.
//
// ESTRUCTURA del convenio:
//   SALDO CONVENIO  = TRAMO CONTINGENTE + TRAMO SOSTENIBLE
//   El flujo de caja real es la amortización del TRAMO SOSTENIBLE: cada
//   trimestre se paga `interes + capital`; `nuevoSaldo` es el saldo vivo del
//   sostenible tras ese pago. El tramo contingente no genera flujo aquí.
//
// CALENDARIO: pago trimestral en los meses Enero / Abril / Julio / Octubre,
// desde Octubre 2022 hasta Octubre 2029 (29 trimestres). El primer pago
// (Oct-2022) es solo interés (capital = 0).
//
// NOTA (Jul vs Jun): el cliente mencionó "junio"; el Excel dice Julio. Se
// toma el Excel como fuente autoritativa. El mes se expone en la UI para que
// sea verificable.
//
// FECHA DE PAGO: el monto cae el ÚLTIMO DÍA HÁBIL del mes del trimestre; si
// el último día natural es inhábil se recorre al siguiente día hábil (los
// días recorridos siguen devengando interés → variabilidad contra banco).
// Esa resolución de fecha vive en `src/domain/convenioConcursal.ts`, no aquí.
// ─────────────────────────────────────────────────────────────────────────

/** Factor de escala: cifras del dataset están en miles de MXN. */
export const CONVENIO_UNIT_SCALE = 1000;

/** Escala un valor crudo del convenio (miles) a MXN reales. */
export function toConvenioMxn(valueInThousands: number): number {
  return valueInThousands * CONVENIO_UNIT_SCALE;
}

export interface ConvenioQuarter {
  /** Año del pago trimestral. */
  year: number;
  /** Mes en español tal como viene del Excel (Enero/Abril/Julio/Octubre). */
  month: string;
  /** Índice 1-based del mes (1, 4, 7, 10). */
  monthIndex: number;
  /** Interés del trimestre, en miles de MXN. */
  interes: number;
  /** Capital amortizado del trimestre, en miles de MXN. */
  capital: number;
  /** Saldo vivo del tramo sostenible tras el pago, en miles de MXN. */
  nuevoSaldo: number;
}

export interface ConvenioCreditor {
  nombre: string;
  /** "Inst Financiera" | "Proveedor". */
  tipo: string;
  /** "COMUN" | "GARANTIA REAL". */
  clase: string;
  /** Empresa del grupo (GSA, SIR, …). Solo informativo: NO se usa para flujo. */
  empresa: string;
  /** Saldo total del convenio para este acreedor, en miles de MXN. */
  saldoConvenio: number;
  /** Tramo contingente, en miles de MXN. */
  tramoContingente: number;
  /** Tramo sostenible (lo que se amortiza), en miles de MXN. */
  tramoSostenible: number;
  /** Marca "**" del Excel (acreedores destacados); "" si no aplica. */
  marca: string;
}

/** Calendario trimestral agregado (totales de todos los acreedores). */
export const CONVENIO_QUARTERS: ConvenioQuarter[] = [
  { year: 2022, month: 'Octubre', monthIndex: 10, interes: 7519.105608, capital: 0, nuevoSaldo: 1604075.862948 },
  { year: 2023, month: 'Enero', monthIndex: 1, interes: 27670.308636, capital: 0, nuevoSaldo: 1604075.862948 },
  { year: 2023, month: 'Abril', monthIndex: 4, interes: 27369.544412, capital: 0, nuevoSaldo: 1604075.862948 },
  { year: 2023, month: 'Julio', monthIndex: 7, interes: 27068.780187, capital: 2804.143305, nuevoSaldo: 1601271.719643 },
  { year: 2023, month: 'Octubre', monthIndex: 10, interes: 27621.937164, capital: 2804.143305, nuevoSaldo: 1598467.576338 },
  { year: 2024, month: 'Enero', monthIndex: 1, interes: 23812.702043, capital: 2804.143305, nuevoSaldo: 1595663.433034 },
  { year: 2024, month: 'Abril', monthIndex: 4, interes: 24902.324385, capital: 11216.573219, nuevoSaldo: 1584446.859814 },
  { year: 2024, month: 'Julio', monthIndex: 7, interes: 25263.711564, capital: 11216.573219, nuevoSaldo: 1573230.286595 },
  { year: 2024, month: 'Octubre', monthIndex: 10, interes: 25071.713756, capital: 11216.573219, nuevoSaldo: 1562013.713376 },
  { year: 2025, month: 'Enero', monthIndex: 1, interes: 24879.715948, capital: 19442.060247, nuevoSaldo: 1542571.653129 },
  { year: 2025, month: 'Abril', monthIndex: 4, interes: 23746.476712, capital: 19442.060247, nuevoSaldo: 1523129.592882 },
  { year: 2025, month: 'Julio', monthIndex: 7, interes: 24214.123547, capital: 19442.060247, nuevoSaldo: 1503687.532635 },
  { year: 2025, month: 'Octubre', monthIndex: 10, interes: 20650.558862, capital: 19442.060247, nuevoSaldo: 1484245.472388 },
  { year: 2026, month: 'Enero', monthIndex: 1, interes: 28448.038221, capital: 28873.365533, nuevoSaldo: 1455372.106855 },
  { year: 2026, month: 'Abril', monthIndex: 4, interes: 26985.024481, capital: 28873.365533, nuevoSaldo: 1426498.741322 },
  { year: 2026, month: 'Julio', monthIndex: 7, interes: 27341.225875, capital: 28873.365533, nuevoSaldo: 1397625.375789 },
  { year: 2026, month: 'Octubre', monthIndex: 10, interes: 26787.819703, capital: 28873.365533, nuevoSaldo: 1368752.010256 },
  { year: 2027, month: 'Enero', monthIndex: 1, interes: 30359.680005, capital: 28873.365533, nuevoSaldo: 1339878.644723 },
  { year: 2027, month: 'Abril', monthIndex: 4, interes: 36437.255366, capital: 28873.365533, nuevoSaldo: 1311005.27919 },
  { year: 2027, month: 'Julio', monthIndex: 7, interes: 36853.815071, capital: 28873.365533, nuevoSaldo: 1282131.913657 },
  { year: 2027, month: 'Octubre', monthIndex: 10, interes: 36042.152684, capital: 28873.365533, nuevoSaldo: 1253258.548123 },
  { year: 2028, month: 'Enero', monthIndex: 1, interes: 38468.07488, capital: 44914.124163, nuevoSaldo: 1208344.423961 },
  { year: 2028, month: 'Abril', monthIndex: 4, interes: 42292.054839, capital: 44914.124163, nuevoSaldo: 1163430.299798 },
  { year: 2028, month: 'Julio', monthIndex: 7, interes: 41624.950726, capital: 44914.124163, nuevoSaldo: 1118516.175636 },
  { year: 2028, month: 'Octubre', monthIndex: 10, interes: 40018.023173, capital: 44914.124163, nuevoSaldo: 1073602.051473 },
  { year: 2029, month: 'Enero', monthIndex: 1, interes: 39335.586275, capital: 269484.744975, nuevoSaldo: 804117.306498 },
  { year: 2029, month: 'Abril', monthIndex: 4, interes: 29819.350116, capital: 269484.744975, nuevoSaldo: 534632.561523 },
  { year: 2029, month: 'Julio', monthIndex: 7, interes: 20494.248192, capital: 269484.744975, nuevoSaldo: 265147.816547 },
  { year: 2029, month: 'Octubre', monthIndex: 10, interes: 10163.999634, capital: 256451.628589, nuevoSaldo: 8696.187959 },
];

/** Acreedores del convenio (resumen por acreedor; solo informativo/UI). */
export const CONVENIO_CREDITORS: ConvenioCreditor[] = [
  { nombre: 'Credit Suisse (Sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 622032.616128, tramoContingente: 329366.270128, tramoSostenible: 292666.346, marca: '' },
  { nombre: 'BBVA (sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 464870.803223, tramoContingente: 246149.090223, tramoSostenible: 218721.713, marca: '' },
  { nombre: 'Banorte (sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 463493.908431, tramoContingente: 245420.024431, tramoSostenible: 218073.884, marca: '' },
  { nombre: 'Bancomext (sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 418374.724601, tramoContingente: 221529.416601, tramoSostenible: 196845.308, marca: '' },
  { nombre: 'EDC (Sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 185939.999929, tramoContingente: 98455.229929, tramoSostenible: 87484.77, marca: '' },
  { nombre: 'Sab Capital (Sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 185997.542968, tramoContingente: 98485.698968, tramoSostenible: 87511.844, marca: '' },
  { nombre: 'Monex (Sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 94112.004215, tramoContingente: 49832.306215, tramoSostenible: 44279.698, marca: '' },
  { nombre: 'Afime (Sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 92546.263514, tramoContingente: 49003.246514, tramoSostenible: 43543.017, marca: '' },
  { nombre: 'Bancrea (Sindicado)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 92924.010591, tramoContingente: 49203.263591, tramoSostenible: 43720.747, marca: '' },
  { nombre: 'Certificados Bursátiles (Rep Monex)', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 339864.337808, tramoContingente: 179958.166808, tramoSostenible: 159906.171, marca: '**' },
  { nombre: 'Banorte', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 53457.494135, tramoContingente: 28305.743135, tramoSostenible: 25151.751, marca: '' },
  { nombre: 'Exitus', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 53292.510075, tramoContingente: 28218.384075, tramoSostenible: 25074.126, marca: '**' },
  { nombre: 'Deloitte', tipo: 'Proveedor', clase: 'COMUN', empresa: 'GSA', saldoConvenio: 218.376195, tramoContingente: 115.630195, tramoSostenible: 102.746, marca: '' },
  { nombre: 'ICBC', tipo: 'Inst Financiera', clase: 'GARANTIA REAL', empresa: 'GSA', saldoConvenio: 131392.299631, tramoContingente: 69572.222631, tramoSostenible: 61820.077, marca: '**' },
  { nombre: 'Volkswagen', tipo: 'Inst Financiera', clase: 'GARANTIA REAL', empresa: 'SIR', saldoConvenio: 133118.784, tramoContingente: 70486.396104, tramoSostenible: 62632.388, marca: '' },
  { nombre: 'Arr y Fac Banorte', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 47084.799451, tramoContingente: 41430.707522, tramoSostenible: 5654.091928, marca: '' },
  { nombre: 'Banco Santander', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 25934.080222, tramoContingente: 22819.833685, tramoSostenible: 3114.245187, marca: '**' },
  { nombre: 'Banco Santander', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 28285.308243, tramoContingente: 24888.718794, tramoSostenible: 3396.587976, marca: '**' },
  { nombre: 'Banco Santander', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 52213.61259, tramoContingente: 45943.636527, tramoSostenible: 6269.973344, marca: '**' },
  { nombre: 'CSI LEASING', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 28748.895247, tramoContingente: 25296.636801, tramoSostenible: 3452.264957, marca: '**' },
  { nombre: 'AFIRME', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 4248.010967, tramoContingente: 3737.896348, tramoSostenible: 510.114619, marca: '' },
  { nombre: 'AMERICAN EXPRESS', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 10005.213956, tramoContingente: 8803.756158, tramoSostenible: 1201.457798, marca: '' },
  { nombre: 'RECARGAS GRUPO ENERGETICOS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 5396.645959, tramoContingente: 4748.59961, tramoSostenible: 648.046349, marca: '' },
  { nombre: 'PEGASO PCS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 2318.269857, tramoContingente: 2039.884666, tramoSostenible: 278.385191, marca: '' },
  { nombre: 'FILOGONIO MARTINEZ SERRANO', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 323.475289, tramoContingente: 284.631352, tramoSostenible: 38.843938, marca: '' },
  { nombre: 'MERCADOTECNIA DIGITAL APLICADA DEL PACIFICO SC', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 372.099009, tramoContingente: 327.41618, tramoSostenible: 44.682828, marca: '' },
  { nombre: 'EQUIPOS PARA MERCADOS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 115.920027, tramoContingente: 101.999983, tramoSostenible: 13.920044, marca: '' },
  { nombre: 'RADIO TRANSPORTES LOGO SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 93.670028, tramoContingente: 82.421834, tramoSostenible: 11.248194, marca: '' },
  { nombre: 'GUILLERMO ROCHA GONZALEZ', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 60.319992, tramoContingente: 53.076576, tramoSostenible: 7.243416, marca: '' },
  { nombre: 'JUAN ANTONIO LOPEZ TORRES', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 10.000012, tramoContingente: 8.799179, tramoSostenible: 1.200833, marca: '' },
  { nombre: 'CLINICA DEL AZUCAR SAPI DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 176.314803, tramoContingente: 155.142363, tramoSostenible: 21.17244, marca: '' },
  { nombre: 'ADSE RED COMERCIALIZADORA SA DE CV Jose Oviedo', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIR', saldoConvenio: 0.243575, tramoContingente: 0.214325, tramoSostenible: 0.029249, marca: '' },
  { nombre: 'AMERICAN EXPRESS', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SES', saldoConvenio: 4973.284829, tramoContingente: 4376.077026, tramoSostenible: 597.207802, marca: '' },
  { nombre: 'Banco Santander', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SES', saldoConvenio: 45014.572945, tramoContingente: 39609.080376, tramoSostenible: 5405.492569, marca: '**' },
  { nombre: 'PRICEWATERHOUSECOOPERS SC', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 13139.357615, tramoContingente: 11561.541914, tramoSostenible: 1577.815701, marca: '' },
  { nombre: 'INGENIERIA LOGISTICA Y PROYECTOS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 209.504879, tramoContingente: 184.346869, tramoSostenible: 25.15801, marca: '' },
  { nombre: 'GLOBAL PORTFOLIO SOLUTIONS SL', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 66.322756, tramoContingente: 58.35851, tramoSostenible: 7.964247, marca: '' },
  { nombre: 'SAUCEDO SANTOS SC', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 38.000031, tramoContingente: 33.436867, tramoSostenible: 4.563164, marca: '' },
  { nombre: 'TORITO & TORITO SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 20.879976, tramoContingente: 18.372642, tramoSostenible: 2.507334, marca: '' },
  { nombre: 'CLINICA DEL AZUCAR SAPI DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 14.789997, tramoContingente: 13.013968, tramoSostenible: 1.77603, marca: '' },
  { nombre: 'INGENIERIA Y SERVICIOS INDUSTRIALES AL3', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SES', saldoConvenio: 50.072126, tramoContingente: 44.059306, tramoSostenible: 6.01282, marca: '' },
  { nombre: 'AMERICAN EXPRESS', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'TT', saldoConvenio: 16063.356278, tramoContingente: 14134.417552, tramoSostenible: 1928.938726, marca: '' },
  { nombre: 'GOAL SYSTEMS SOCIEDAD LIMITADA UNIPERSONAL', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 6225.561852, tramoContingente: 5477.976657, tramoSostenible: 747.585196, marca: '' },
  { nombre: 'SOLEMTI SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 385.7, tramoContingente: 339.383922, tramoSostenible: 46.316078, marca: '' },
  { nombre: 'INGENIERIA LOGISTICA Y PROYECTOS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 189.865123, tramoContingente: 167.065517, tramoSostenible: 22.799606, marca: '' },
  { nombre: 'AUDITORIO INTEGRAL SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 75.400023, tramoContingente: 66.34575, tramoSostenible: 9.054274, marca: '' },
  { nombre: 'CONDUCKTING SC', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 46.40003, tramoContingente: 40.828167, tramoSostenible: 5.571863, marca: '' },
  { nombre: 'NEXTA TECHNOLOGY SERVICES SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 114.994769, tramoContingente: 101.185833, tramoSostenible: 13.808936, marca: '' },
  { nombre: 'CLINICA DEL AZUCAR SAPI DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 33.905653, tramoContingente: 29.834155, tramoSostenible: 4.071498, marca: '' },
  { nombre: 'SERVICIO ROT SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 16.553231, tramoContingente: 14.565466, tramoSostenible: 1.987764, marca: '' },
  { nombre: 'JESUS MARIA RODRIGUEZ QUINTERO', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 6.896506, tramoContingente: 6.068352, tramoSostenible: 0.828154, marca: '' },
  { nombre: 'MARIA ELENA FERNANDEZ VILLANUEVA', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 5.75002, tramoContingente: 5.05954, tramoSostenible: 0.690481, marca: '' },
  { nombre: 'PATRICIA JANETH LOPEZ ROMERO', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 4.596471, tramoContingente: 4.044512, tramoSostenible: 0.551959, marca: '' },
  { nombre: 'RECARGAS GRUPO ENERGETICOS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 3.198463, tramoContingente: 2.814382, tramoSostenible: 0.384082, marca: '' },
  { nombre: 'SIMON ARRIAGA NIÑO', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 1.79998, tramoContingente: 1.583833, tramoSostenible: 0.216147, marca: '' },
  { nombre: 'VITOL MARKETING MEXICO S DE RL DE CV (Mercadotecnia)', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 0.685691, tramoContingente: 0.603351, tramoSostenible: 0.08234, marca: '' },
  { nombre: 'IVAN ALEJANDRO VEGA CISNEROS Jose Oviedo', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TT', saldoConvenio: 12.180026, tramoContingente: 10.71741, tramoSostenible: 1.462616, marca: '' },
  { nombre: 'AMERICAN EXPRESS', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SIP', saldoConvenio: 1757.26243, tramoContingente: 1546.244788, tramoSostenible: 211.017641, marca: '' },
  { nombre: 'JOEL MORALES MENDOZA', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIP', saldoConvenio: 582.668253, tramoContingente: 512.699603, tramoSostenible: 69.96865, marca: '' },
  { nombre: 'EL MOVIMIENTO ALTERNATIVO PARA SUADMINISTRACION SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SIP', saldoConvenio: 21.064933, tramoContingente: 18.535389, tramoSostenible: 2.529544, marca: '' },
  { nombre: 'AMERICAN EXPRESS', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 4601.277445, tramoContingente: 4048.741468, tramoSostenible: 552.535977, marca: '' },
  { nombre: 'ENERGETICOS INTERNACIONALES SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 1146.054166, tramoContingente: 1008.43235, tramoSostenible: 137.621816, marca: '' },
  { nombre: 'GRUPO INTELLMEDIA SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 313.199983, tramoContingente: 275.589936, tramoSostenible: 37.610046, marca: '' },
  { nombre: 'SOLEMTI SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 255.199996, tramoContingente: 224.554772, tramoSostenible: 30.645224, marca: '' },
  { nombre: 'BENJAMIN AGUILAR BAUTISTA', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 41.76002, tramoContingente: 36.745345, tramoSostenible: 5.014676, marca: '' },
  { nombre: 'EL MOVIMIENTO ALTERNATIVO PARA SUADMINISTRACION SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 9.815327, tramoContingente: 8.636671, tramoSostenible: 1.178656, marca: '' },
  { nombre: 'SERVICIO ROT SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 7.644415, tramoContingente: 6.726449, tramoSostenible: 0.917966, marca: '' },
  { nombre: 'ROBERTO CARLOS PEREZ AGUILLON Jose Oviedo (empleado)', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 5.499993, tramoContingente: 4.839536, tramoSostenible: 0.660457, marca: '' },
  { nombre: 'LUIS ALEJANDRO REYNA CONTRERAS', tipo: 'Proveedor', clase: 'COMUN', empresa: 'STDN', saldoConvenio: 24.982602, tramoContingente: 21.982612, tramoSostenible: 2.99999, marca: '' },
  { nombre: 'AMERICAN EXPRESS', tipo: 'Inst Financiera', clase: 'COMUN', empresa: 'SSI', saldoConvenio: 704.083274, tramoContingente: 619.534723, tramoSostenible: 84.548551, marca: '' },
  { nombre: 'RECARGAS GRUPO ENERGETICOS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'SSI', saldoConvenio: 1928.194207, tramoContingente: 1696.650536, tramoSostenible: 231.543671, marca: '' },
  { nombre: 'SISTEMAS DE GEOLOCALIZACION DIGITAL SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TURIMEX', saldoConvenio: 543.201272, tramoContingente: 477.971942, tramoSostenible: 65.22933, marca: '' },
  { nombre: 'SERVICIO ROT SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TURIMEX', saldoConvenio: 12.875973, tramoContingente: 11.329785, tramoSostenible: 1.546188, marca: '' },
  { nombre: 'CARLOS EDUARDO MARTINEZ MIRELES', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TURIMEX', saldoConvenio: 4.399967, tramoContingente: 3.871605, tramoSostenible: 0.528362, marca: '' },
  { nombre: 'DEL PRADO LOGISTICS INC JD', tipo: 'Proveedor', clase: 'COMUN', empresa: 'TURIMEX', saldoConvenio: 0.223062, tramoContingente: 0.196276, tramoSostenible: 0.026786, marca: '' },
  { nombre: 'LAKESONS EXPRESS SA DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'MULTICARGA', saldoConvenio: 57.8386, tramoContingente: 50.893157, tramoSostenible: 6.945442, marca: '' },
  { nombre: 'HECTOR CASTILLO CALVILLO', tipo: 'Proveedor', clase: 'COMUN', empresa: 'MULTICARGA', saldoConvenio: 35.779059, tramoContingente: 31.482596, tramoSostenible: 4.296463, marca: '' },
  { nombre: 'MENSAJERIA SPLINTER S DE RL DE CV', tipo: 'Proveedor', clase: 'COMUN', empresa: 'MULTICARGA', saldoConvenio: 82.47575, tramoContingente: 72.571801, tramoSostenible: 9.903949, marca: '' },
  { nombre: 'JUAN MARTIN GALAVIZ TOVAR', tipo: 'Proveedor', clase: 'COMUN', empresa: 'MULTICARGA', saldoConvenio: 59.721447, tramoContingente: 52.549907, tramoSostenible: 7.171541, marca: '' },
  { nombre: 'EMILIO PADILLA ZARAGOZA', tipo: 'Proveedor', clase: 'COMUN', empresa: 'MULTICARGA', saldoConvenio: 4.000032, tramoContingente: 3.519695, tramoSostenible: 0.480337, marca: '' },
];

/** Totales agregados del convenio (en miles de MXN), tal como en el Excel. */
export const CONVENIO_TOTALS = {
  saldoConvenio: 3635935.406145,
  tramoContingente: 2031859.54427,
  tramoSostenible: 1604075.862948,
  sumInteres: 821262.302065,
  sumCapital: 1595379.67499,
} as const;
