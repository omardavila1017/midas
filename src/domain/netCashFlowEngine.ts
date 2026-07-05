/**
 * Net Cash Flow Engine — unified view of CXC (collections) and CXP (payments)
 *
 * Core value proposition: daily, weekly, and monthly net cash position
 * across both inflows (collections) and outflows (payments).
 *
 * Integrates:
 *   - CollectionEvent[] from collectionEngine.ts (CXC)
 *   - CXPRecord[] from CXP service or manual fallback
 *   - ConfirmedPayment[] for real vs projected tracking
 */

import { CollectionEvent, ConfirmedPayment, eventKey } from './types';
import { CXPRecord } from './persistence';
import type { ComprasRecord } from '../services/jdeTypes';
import { enrichFromCatalog, Flexibility, Criticidad } from './providerCatalog';
import { BANK_ACCOUNTS } from './bankAccountsCatalog';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import { isoWeek } from './calendar';

// ─────────────────────────────────────────────────────────────────────────
// Internal transfer detection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Detect bank movements that represent *internal* transfers (traspasos/
 * transferencias entre cuentas propias), not real inflows/outflows of cash
 * from the business.
 *
 * En el estado de cuenta JDE estos movimientos vienen marcados de tres formas:
 *
 *   1. Leyenda de tipo de operación en concepto/referencia, p.ej.
 *      "TRASPASO REF", "TRANSFERENCIA REF", "TRANSFER REF" y abreviaturas.
 *
 *   2. RFC de una de las empresas propias del grupo en el concepto, p.ej.
 *      "TRCC AL R.F.C. TTA4906038F4" — cuando aparece uno de nuestros RFC
 *      como destinatario/origen es un movimiento entre empresas del grupo.
 *
 *   3. Nombre de una empresa propia como beneficiario, p.ej.
 *      "BCO 002 BENEF TRANSPORTES TAMAULIP" — el estado de cuenta trunca
 *      el nombre comercial pero la razón social es clara.
 *
 * Como el ABONO en una cuenta se compensa con el CARGO en otra, sumarlos al
 * flujo infla tanto los cobros como los pagos sin aportar información
 * económica. Por eso cualquier código que construya el "Flujo de efectivo"
 * debe filtrar estos movimientos — la vista de Bancos, en cambio, los sigue
 * mostrando porque ahí sí son relevantes para la conciliación.
 *
 * Detección: permisiva a propósito (case-insensitive, tolera variaciones de
 * espaciado/separadores). Se evalúa tanto `concepto` como `referencia`
 * porque distintos formatos (SWIFT/BAI2/MT940) colocan la leyenda en
 * campos diferentes.
 *
 * Coincide (no exhaustivo) con:
 *   "TRASPASO REF", "TRASPASO REFERENCIA", "TRASPASO-REF", "TRASP REF"
 *   "TRANSPASO REF"
 *   "TRANSFERENCIA REF", "TRANSFER REF", "TRANSF REF", "TRANSF. REF"
 *   Cualquier texto que contenga un RFC en INTERNAL_RFCS.
 *   Cualquier texto que contenga un nombre en INTERNAL_BENEFICIARIES.
 *
 * NO coincide con descripciones legítimas como "TRANSFERENCIA BANCARIA",
 * "TRANSFERENCIA A PROVEEDOR", "PAGO A TERCEROS", etc.
 */
const INTERNAL_TRANSFER_PATTERN = /\bTRA(?:N?S(?:P(?:ASO)?|F(?:ER(?:ENCIA)?)?)?)?[\s._/\-]*REF/i;

/**
 * Patrones complementarios sin "REF" sufijo, agregados después de detectar
 * que algunos traspasos entre empresas llegan a "Otros Egresos" en
 * Planeación cuando la leyenda omite la palabra REF (caso: el detector
 * principal exige REF). Capturan inter-compañía explícitamente:
 *
 *   - `TRASLADO` solo o seguido por contexto bancario.
 *   - `INTERCIA` / `INTERCIAS` (abreviaturas comunes en chequeras corporativas).
 *   - `ENTRE CIAS`, `ENTRE EMPRESAS`, `ENTRE COMPAÑIAS` (con tilde o sin).
 *
 * Riesgo controlado: TRASLADO en contexto bancario MX siempre denota traspaso
 * entre cuentas; INTERCIA(S) y ENTRE CIAS son específicos del grupo. Si alguna
 * vez aparecen como descripción legítima de un pago a tercero, agregar
 * negative-lookahead aquí.
 */
const INTERNAL_INTERCOMPANY_PATTERN = /\b(?:TRASLADO|INTERCIAS?|ENTRE\s+(?:CIAS|EMPRESAS|COMPA(?:N|Ñ)IAS))\b/i;

/**
 * RFCs de empresas propias del grupo. Cuando aparece uno de estos en el
 * concepto o referencia de un movimiento, se trata como transferencia
 * interna aunque la leyenda de tipo de operación no lo diga.
 *
 * Agregar aquí nuevos RFCs conforme se identifiquen (p.ej. al aparecer una
 * nueva razón social en JDE). No hace falta tocar el regex ni la función.
 */
const INTERNAL_RFCS: readonly string[] = [
  // Lista autoritativa de RFCs de las empresas del grupo (2026-04).
  // Aparecen en leyendas tipo "TRCC AL R.F.C. <RFC>" o embebidos en
  // el concepto/referencia de movimientos entre cuentas propias.
  'TTA4906038F4',
  'SIR870615345',
  'TIC0510111G4',
  'MUL9707108M3',
  'SIP990527FA0',
];

/**
 * Nombres (o fragmentos de nombres) de empresas propias del grupo tal como
 * los escriben los bancos en el campo beneficiario. Los estados de cuenta
 * suelen truncar estos campos a ~20-30 chars, así que guardamos el prefijo
 * más largo que sigue siendo único para evitar colisiones con clientes o
 * proveedores externos.
 *
 * Reglas para agregar:
 *   - Usar mayúsculas (el matcheo es case-insensitive, pero así se lee mejor).
 *   - Usar la forma truncada si es como aparece en el estado de cuenta
 *     (ej. "TRANSPORTES TAMAULIP" captura tanto la versión truncada como la
 *     completa "TRANSPORTES TAMAULIPAS").
 *   - Mantener al menos 10-12 caracteres distintivos para evitar falsos
 *     positivos (ej. NO poner "SENDA" a secas — atraparía clientes
 *     comerciales con "Senda" en su razón social).
 */
const INTERNAL_BENEFICIARIES: readonly string[] = [
  'TRANSPORTES TAMAULIP', // "TRANSPORTES TAMAULIPAS" — aparece como "BCO 002 BENEF TRANSPORTES TAMAULIP"
  // Razones sociales del grupo según el catálogo de cuentas de banco
  // (`src/assets/bankAccountsCatalog.json`, 2026-06-10). Un CARGO cuyo
  // beneficiario es una de estas empresas es un traspaso interno aunque no
  // lleve leyenda TRASPASO/REF. Fragmentos elegidos para tolerar el truncado
  // bancario (~20-30 chars) manteniendo ≥12 chars distintivos.
  'GRUPO SENDA AUTOTRA',           // GRUPO SENDA AUTOTRANSPORTE
  'SENDA SERVICIO INDUS',          // SENDA SERVICIO INDUSTRIAL
  'SENDA SERVICIOS FINAN',         // SENDA SERVICIOS FINANCIEROS
  'SERVICIOS INDUSTRIALES SENDA',
  'ESPECIALIZADOS SENDA',          // SERVICIOS ESPECIALIZADOS SENDA
  'SERVICIO INDUSTRIAL REGIOMONT', // SERVICIO INDUSTRIAL REGIOMONTANO
  'SERVICIO INDUSTRIAL POTOSIN',   // SERVICIO INDUSTRIAL POTOSINO
  'TRANSPORTES INDUSTRIALES CHIH', // TRANSPORTES INDUSTRIALES CHIHUAHUENSES
  'TURIMEX DEL NORTE',
  'MULTICARGA',                    // MULTICARGA SA DE CV — fragmento distintivo;
                                   // el beneficiario bancario truncado a veces
                                   // omite el "SA" ("BENEF MULTICARGA"), y el
                                   // nombre del proveedor en JDE llega como
                                   // "MULTICARGA" a secas. "MULTISERVICIOS" no
                                   // colisiona (no contiene "MULTICARGA").
  'SERVICIOS T DE N',              // SERVICIOS T DE N SA DE CV
  'AUTOTRANSPORTES ADVENTUR',
  'OPERADORA DE VENTAS GRUPO',     // Operadora de Ventas Grupo Senda
  'OFICIOS Y PROYECTOS EN REC',    // Oficios y Proyectos en Rec Clas de Per
];

/**
 * Códigos cortos (acrónimos) de empresas propias del grupo tal como aparecen
 * en el concepto/referencia de movimientos bancarios. A diferencia de los
 * nombres completos (INTERNAL_BENEFICIARIES), estos son siglas de 3-5 letras
 * y requieren matching con word boundaries para no capturar substrings
 * accidentales de palabras legítimas (p.ej. "TRCC" podría estar dentro de
 * otro token si hiciéramos substring-match a pelo).
 *
 * Ejemplos donde aparecen:
 *   - Como título del concepto: "TRCC"
 *   - Al inicio de leyendas: "TRCC AL R.F.C. TTA4906038F4"
 *   - Dentro del concepto: "PAGO TRCC S.A."
 *
 * Reglas para agregar:
 *   - Usar mayúsculas (el matcheo es case-insensitive).
 *   - Mínimo 3 caracteres — menos = alto riesgo de falso positivo.
 *   - Verificar que la sigla NO sea prefijo común de razones sociales
 *     externas (p.ej. "TRA" atraparía "Transportes X" de cualquier cliente).
 */
const INTERNAL_COMPANY_CODES: readonly string[] = [
  'TRCC',
  'TRTT',
  // Códigos cortos de razones sociales del grupo presentes en conceptos del
  // auxiliar contable (ej. "SIR-TICH ABRL 2026 ..."). Word-boundary garantiza
  // que no atrape substrings accidentales (p.ej. "SIR" en "ASIR"). Limitado
  // a códigos ≥3 chars con bajo riesgo de colisión con razones sociales
  // externas. Códigos como "SES" o "MUL" se omiten — alto riesgo de falso
  // positivo (cualquier "ses..." o "Multi..." de un cliente externo matcharía).
  'SIR',
  'TICH',
  'STDN',
];

/**
 * Helper: construye un regex que matchee cualquiera de los strings dados
 * como substring, escapando caracteres especiales. Case-insensitive.
 * Retorna null si la lista está vacía (para evitar hacer .test() en balde).
 */
function buildSubstringPattern(items: readonly string[]): RegExp | null {
  if (items.length === 0) return null;
  const escaped = items.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'i');
}

/**
 * Como `buildSubstringPattern` pero con word boundaries (`\b...\b`). Útil
 * para siglas cortas donde queremos matchear "TRCC" pero NO "ATTRCCX".
 */
function buildWordPattern(items: readonly string[]): RegExp | null {
  if (items.length === 0) return null;
  const escaped = items.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}

const INTERNAL_RFC_PATTERN = buildSubstringPattern(INTERNAL_RFCS);
const INTERNAL_BENEFICIARY_PATTERN = buildSubstringPattern(INTERNAL_BENEFICIARIES);
const INTERNAL_COMPANY_CODE_PATTERN = buildWordPattern(INTERNAL_COMPANY_CODES);

/**
 * Longitud mínima que debe tener un número de cuenta para considerarse en el
 * detector de "cuenta destino interna". Evita falsos positivos con códigos
 * cortos (p.ej. "1" o "0001") que podrían aparecer por casualidad en
 * referencias bancarias legítimas.
 */
const MIN_ACCOUNT_LENGTH = 6;

/** Sólo dígitos (descarta espacios, guiones y cualquier otro separador). */
function accountDigits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D+/g, '');
}

function stripLeadingZeros(s: string): string {
  return s.replace(/^0+/, '');
}

/**
 * Identificadores de cuenta del catálogo estático de cuentas del grupo
 * (`src/assets/bankAccountsCatalog.json`): dígitos de cuenta (con y sin ceros
 * a la izquierda — los bancos rellenan con padding distinto) y CLABE completa.
 *
 * Por qué existe: el índice derivado de `bankStatements` sólo conoce cuentas
 * CON estado de cuenta cargado, y nunca conoce CLABEs. Un traspaso a una
 * cuenta del grupo sin estado de cuenta (reserva, dotación de efectivo, otra
 * cía) o referenciado por CLABE (SPEI imprime la CLABE destino en el concepto)
 * escapaba a la detección y acababa disfrazado de pago a proveedor en
 * Planeación ("Sin identificar · BANCO cuenta" bajo Proveedores sin
 * categoría). El catálogo es la verdad estática de qué cuentas son nuestras.
 */
const CATALOG_ACCOUNT_IDENTIFIERS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  const push = (raw: string | null | undefined, { isClabe = false } = {}) => {
    const digits = accountDigits(raw);
    if (digits.length < MIN_ACCOUNT_LENGTH) return;
    out.add(digits);
    // Las CLABEs se indexan SOLO completas (18 dígitos): los SPEI imprimen la
    // CLABE íntegra, y la forma sin ceros iniciales rompería la auto-exclusión
    // estructural del detector (que reconoce la CLABE propia por sus 18 dígitos).
    if (isClabe) return;
    const stripped = stripLeadingZeros(digits);
    if (stripped.length >= MIN_ACCOUNT_LENGTH) out.add(stripped);
  };
  for (const entry of BANK_ACCOUNTS) {
    push(entry.cuentaDigits);
    push(entry.cuenta);
    push(entry.clabe, { isClabe: true });
  }
  return out;
})();

/**
 * Construye un Set con todas las cuentas que pertenecen al grupo: las del
 * catálogo estático de cuentas (dígitos + CLABE, siempre presentes) más las
 * extraídas de los estados de cuenta que ya estamos consumiendo del API de
 * JDE (cubre cuentas aún no catalogadas).
 *
 * Si el concepto o la referencia de un movimiento menciona cualquiera de
 * estos números (p.ej. "TRASPASO REF 123 CTA DESTINO 0190047839" o la CLABE
 * destino de un SPEI entre cuentas propias), se trata como transferencia
 * interna aunque no tenga la leyenda TRASPASO/TRANSFERENCIA ni un
 * RFC/beneficiario del grupo.
 *
 * Se descartan cuentas demasiado cortas para evitar colisiones accidentales.
 */
export function buildOwnAccountsIndex(
  statements: readonly BankAccountStatement[] | undefined,
): Set<string> {
  const out = new Set<string>(CATALOG_ACCOUNT_IDENTIFIERS);
  if (!statements) return out;
  for (const statement of statements) {
    const cuenta = (statement.cuenta ?? '').trim();
    if (cuenta.length >= MIN_ACCOUNT_LENGTH) {
      out.add(cuenta);
      const digits = accountDigits(cuenta);
      if (digits.length >= MIN_ACCOUNT_LENGTH) out.add(digits);
    }
  }
  return out;
}

/**
 * Línea bancaria mínima que examina el detector de cuenta-destino-interna.
 * Además de `concepto`/`referencia`, escanea los campos `InF_ADI` crudos de
 * JDE: cuando `InF_ADI_1` trae una leyenda limpia ("PAGO A TERCEROS"), el
 * parser de concepto (`parseConcepto` en jde.ts) nunca expone `InF_ADI_2`
 * ("P589  00877732401 a 7013870885 1 SERVICIOS T DE N?21 Pago de …") — que es
 * exactamente donde viene la cuenta DESTINO del traspaso. Esos traspasos
 * escapaban a la detección y acababan en Planeación como AP_PAYMENT
 * "Sin identificar · BANCO cuenta" bajo "Proveedores sin categoría".
 *
 * Los campos InF_ADI se escanean SOLO con los identificadores de cuenta
 * (números + CLABE, con auto-exclusión de la cuenta origen). Los patrones de
 * nombre/RFC de `isInternalTransfer` NO aplican ahí a propósito: InF_ADI
 * imprime también al ORDENANTE ("Pago de <empresa propia>") en pagos reales a
 * terceros, así que escanear nombres marcaría como interno todo pago legítimo.
 */
export type OwnAccountProbe = Pick<
  BankStatementLine,
  'concepto' | 'referencia' | 'cuenta' | 'infAdi1' | 'infAdi2' | 'infAdi3'
>;

/**
 * Colapsa whitespace ENTRE dígitos ("7013870885 1" → "70138708851"). JDE
 * trocea los números de cuenta en los campos InF_ADI con espacios de ancho
 * fijo; sin re-unirlos, el substring match nunca encuentra la cuenta destino.
 * Se aplica POR CAMPO (los campos nunca se concatenan antes de normalizar)
 * para no fabricar un número uniendo dígitos de campos distintos.
 */
function joinDigitRuns(text: string): string {
  return text.replace(/(\d)\s+(?=\d)/g, '$1');
}

/**
 * Precomputa un detector de cuenta-destino-interna para reusar en un
 * batch grande de movimientos. Evita reconstruir el regex por llamada.
 *
 * El detector excluye los identificadores de la cuenta origen de cada
 * movimiento (dígitos con/sin padding Y su CLABE): si un banco repite el
 * número o la CLABE de la cuenta origen en el concepto (p.ej. "COMISION CTA
 * 0190..." o un SPEI entrante que imprime la CLABE beneficiaria — la propia),
 * esa referencia apunta a la misma cuenta y no indica traspaso interno. Solo
 * marcamos como interno cuando aparece OTRA cuenta del grupo.
 */
export function buildOwnAccountDetector(
  ownAccounts: Set<string> | undefined,
): (mov: OwnAccountProbe) => boolean {
  if (!ownAccounts || ownAccounts.size === 0) return () => false;
  const allAccounts = Array.from(ownAccounts);
  // ¿El identificador pertenece a la cuenta origen? Compara por dígitos
  // normalizados (sin ceros a la izquierda — el padding varía por banco) y,
  // para CLABEs (18 dígitos: 3 banco + 3 plaza + 11 cuenta + 1 control), por
  // el segmento de cuenta embebido.
  const belongsToOwn = (identifier: string, ownKey: string): boolean => {
    const digits = accountDigits(identifier);
    if (!digits) return false;
    if (stripLeadingZeros(digits) === ownKey) return true;
    if (digits.length === 18 && stripLeadingZeros(digits.slice(6, 17)) === ownKey) return true;
    return false;
  };
  // Pre-built pattern cuando el movimiento no trae cuenta origen (usa todas).
  const fullPattern = buildSubstringPattern(allAccounts);
  // Cache por cuenta origen (normalizada) — el set "todas menos las de ésta".
  const patternCache = new Map<string, RegExp | null>();

  return (mov) => {
    // `InF_ADI_1..3` van al final: son el detalle de trazabilidad que el
    // parser de concepto descarta cuando InF_ADI_1 ya trae leyenda limpia,
    // pero es donde el banco imprime la cuenta/CLABE destino del traspaso.
    const fields = [mov.concepto, mov.referencia, mov.infAdi1, mov.infAdi2, mov.infAdi3]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (fields.length === 0) return false;

    const ownKey = stripLeadingZeros(accountDigits(mov.cuenta));
    let pattern: RegExp | null;
    if (!ownKey) {
      pattern = fullPattern;
    } else if (patternCache.has(ownKey)) {
      pattern = patternCache.get(ownKey)!;
    } else {
      const rest = allAccounts.filter(a => !belongsToOwn(a, ownKey));
      pattern = rest.length === allAccounts.length
        ? fullPattern
        : buildSubstringPattern(rest);
      patternCache.set(ownKey, pattern);
    }
    if (!pattern) return false;
    for (const field of fields) {
      // joinDigitRuns no rompe números contiguos, así que todo match previo
      // sigue matcheando — sólo agrega los casos con dígitos troceados.
      if (pattern.test(joinDigitRuns(field))) return true;
    }
    return false;
  };
}

export function isInternalTransfer(
  mov: OwnAccountProbe,
  ownAccountDetector?: (m: OwnAccountProbe) => boolean,
): boolean {
  const concepto = mov.concepto ?? '';
  const referencia = mov.referencia ?? '';

  // 1. Leyenda de tipo de operación (TRASPASO/TRANSFERENCIA REF...)
  if (concepto && INTERNAL_TRANSFER_PATTERN.test(concepto)) return true;
  if (referencia && INTERNAL_TRANSFER_PATTERN.test(referencia)) return true;

  // 1b. Leyendas inter-compañía sin REF (TRASLADO, INTERCIAS, ENTRE CIAS).
  if (concepto && INTERNAL_INTERCOMPANY_PATTERN.test(concepto)) return true;
  if (referencia && INTERNAL_INTERCOMPANY_PATTERN.test(referencia)) return true;

  // 2. RFC de empresa propia en cualquier parte del texto.
  if (INTERNAL_RFC_PATTERN) {
    if (concepto && INTERNAL_RFC_PATTERN.test(concepto)) return true;
    if (referencia && INTERNAL_RFC_PATTERN.test(referencia)) return true;
  }

  // 3. Nombre de empresa propia como beneficiario.
  if (INTERNAL_BENEFICIARY_PATTERN) {
    if (concepto && INTERNAL_BENEFICIARY_PATTERN.test(concepto)) return true;
    if (referencia && INTERNAL_BENEFICIARY_PATTERN.test(referencia)) return true;
  }

  // 3b. Sigla corta de empresa propia (TRCC, TRTT, ...) — con word boundaries
  //     para no matchear substrings accidentales.
  if (INTERNAL_COMPANY_CODE_PATTERN) {
    if (concepto && INTERNAL_COMPANY_CODE_PATTERN.test(concepto)) return true;
    if (referencia && INTERNAL_COMPANY_CODE_PATTERN.test(referencia)) return true;
  }

  // 4. Cuenta destino es otra cuenta nuestra del grupo.
  if (ownAccountDetector && ownAccountDetector(mov)) return true;

  return false;
}

/**
 * ¿La contraparte de una factura de cobranza es una empresa propia del
 * grupo? Reusa la lista autoritativa de RFCs/nombres internos (la misma que
 * `isInternalTransfer` usa para movimientos bancarios) para que exista un
 * solo lugar donde mantener qué es "interno".
 *
 * Una factura cuya razón social/RFC pertenece al grupo es un movimiento
 * intercompañía (traspaso disfrazado de venta), NO una cobranza real
 * externa, y NO debe proyectarse como entrada de caja en el calendario.
 *
 * Señal fuerte: RFC en `INTERNAL_RFCS`. Señales de nombre: beneficiarios y
 * siglas curadas del grupo. NO usamos códigos genéricos para no atrapar
 * clientes externos por accidente.
 */
export function isInternalCounterparty(
  rfc: string | undefined,
  name: string | undefined,
): boolean {
  const r = (rfc ?? '').trim();
  if (r && INTERNAL_RFC_PATTERN && INTERNAL_RFC_PATTERN.test(r)) return true;
  const n = (name ?? '').trim();
  if (!n) return false;
  if (INTERNAL_BENEFICIARY_PATTERN && INTERNAL_BENEFICIARY_PATTERN.test(n)) return true;
  if (INTERNAL_COMPANY_CODE_PATTERN && INTERNAL_COMPANY_CODE_PATTERN.test(n)) return true;
  return false;
}

/**
 * Clasificaciones JDE (`clasificacionProveedor` / `clasificacionProveedorFinanciera`
 * de CXP/PagoProveedor) que marcan que la contraparte es una EMPRESA INTERNA del
 * grupo (filial / intercompañía). JDE clasifica a las propias razones sociales
 * del grupo como "Filiales" en el maestro de proveedores, así que un pago contra
 * una de ellas es un traspaso intercompañía — no un egreso real con un tercero.
 *
 * Señal independiente del nombre/RFC (`isInternalCounterparty`), que puede venir
 * truncado o ausente: el cruce a PagoProveedor expone la clasificación aunque la
 * leyenda bancaria sea opaca. Se usa JUNTO con `isInternalCounterparty`, nunca
 * en su lugar. Mantener acotado a clasificaciones inequívocamente intra-grupo —
 * NO agregar categorías ambiguas que también usen proveedores externos.
 */
const INTERNAL_CLASSIFICATION_PATTERN =
  /\bfilial(?:es)?\b|inter\s*comp|inter\s*c[ií]as?\b|intracompa|intra\s*grupo/i;

export function isInternalProviderClassification(
  classification: string | null | undefined,
): boolean {
  const c = (classification ?? '').trim();
  if (!c) return false;
  return INTERNAL_CLASSIFICATION_PATTERN.test(c);
}

// ─────────────────────────────────────────────────────────────────────────
// Pair-matched detector
//
// Algunos traspasos internos no llevan leyenda ni RFC ni nombre de empresa
// propia: aparecen como un CARGO en una cuenta y un ABONO simétrico en otra
// cuenta del MISMO grupo (cia) el MISMO día por EL MISMO importe.
// Esta heurística los detecta cuando la pareja es 1-a-1 (exactamente un
// CARGO y un ABONO en cuentas distintas con el mismo monto). Si hay más
// movimientos del mismo monto/día/cia (ambigüedad), no se marca ninguno —
// preferimos el falso negativo al falso positivo (perder un ingreso real).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construye una llave estable para identificar un movimiento dentro del
 * universo cargado. Incluye todos los campos discriminantes; movimientos
 * funcionalmente idénticos colisionarán pero eso es aceptable para la
 * clasificación (cualquier instancia idéntica se considera paireable).
 */
export function movementHashKey(
  cia: string | undefined,
  cuenta: string | undefined,
  mov: Pick<BankStatementLine, 'fechaOperacion' | 'tipoMovimiento' | 'importe' | 'referencia' | 'concepto'>,
): string {
  return [
    cia ?? '',
    cuenta ?? '',
    mov.fechaOperacion ?? '',
    mov.tipoMovimiento ?? '',
    mov.importe ?? 0,
    mov.referencia ?? '',
    mov.concepto ?? '',
  ].join('::');
}

/**
 * Ventana (en días) dentro de la cual un CARGO y su ABONO gemelo se
 * consideran el mismo traspaso interno aunque no liquiden el mismo día.
 *
 * Por qué existe: un traspaso entre cuentas propias muchas veces NO cae el
 * mismo día en ambas patas — SPEI liquida en T+1, los fines de semana
 * empujan la contraparte al lunes, y los cortes de mes desfasan la
 * operación. Con el criterio anterior (mismo día exacto) esas patas
 * quedaban huérfanas: el CARGO se contaba como "Egreso bancario sin
 * identificar" y su ABONO quedaba como ingreso real sin su egreso
 * compensatorio. Resultado: egresos inflados sin su ingreso compensatorio →
 * la caja proyectada se iba a negativo artificialmente. Ampliar la ventana
 * cierra esa asimetría pareando ambas patas dentro del rango de días.
 *
 * Seguridad: el pareo es SIMÉTRICO — sólo marca un CARGO como interno si
 * existe un ABONO del MISMO importe (al centavo) en OTRA cuenta del grupo
 * dentro de la ventana, y marca AMBOS. Por construcción el flujo NETO no
 * cambia al remover un par (−X y +X se cancelan), así que un eventual falso
 * positivo nunca altera la trayectoria de caja; sólo limpia los brutos.
 */
const PAIR_MATCH_WINDOW_DAYS = 3;

/**
 * Recorre todos los movimientos y devuelve el Set de llaves que parecen ser
 * traspasos internos pareados por monto, permitiendo desfase de días entre
 * las dos patas (ver `PAIR_MATCH_WINDOW_DAYS`).
 *
 * Criterio: se agrupan los movimientos por importe (sin importar la cia —
 * todas las cuentas de `statements` pertenecen al grupo). Dentro de cada
 * grupo se parean CARGOs con ABONOs en cuentas DISTINTAS, eligiendo siempre
 * el ABONO más cercano en fecha (mismo día primero) dentro de la ventana.
 * Cada ABONO se usa a lo más una vez; el sobrante queda como real.
 *
 * Por qué greedy-por-cercanía:
 *   - Se permite N-a-N para no perder días con varios traspasos del mismo
 *     monto. La asimetría de conteos (p.ej. 2 CARGOs + 1 ABONO) sólo parea
 *     min(K,N), dejando el sobrante como real.
 *   - "Mismo día" sigue siendo el match más fuerte (distancia 0 gana), así
 *     que el comportamiento previo es un subconjunto del nuevo.
 */
export function buildPairMatchedKeys(
  statements: readonly BankAccountStatement[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!statements || statements.length === 0) return out;

  type Entry = {
    key: string;
    cuenta: string;
    tipo: 'ABONO' | 'CARGO' | string;
    dayMs: number;
  };
  // Agrupado por importe únicamente; la proximidad de fecha se resuelve con
  // la ventana al momento de parear.
  const buckets = new Map<string, Entry[]>();

  for (const acc of statements) {
    const cia = acc.cia ?? '';
    const cuenta = (acc.cuenta ?? '').trim();
    if (!cuenta) continue;
    for (const mov of acc.movimientos ?? []) {
      if (!mov.fechaOperacion || !mov.tipoMovimiento) continue;
      const importe = Number(mov.importe);
      if (!Number.isFinite(importe) || importe <= 0) continue;
      const iso = parseDate(mov.fechaOperacion);
      if (!iso) continue;
      const dayMs = new Date(iso + 'T00:00:00Z').getTime();
      if (Number.isNaN(dayMs)) continue;
      // Llave de importe normalizada a centavos para evitar que diferencias
      // de punto flotante separen montos que son el mismo peso.
      const amountKey = String(Math.round(importe * 100));
      const list = buckets.get(amountKey);
      const entry: Entry = {
        key: movementHashKey(cia, cuenta, mov),
        cuenta,
        tipo: mov.tipoMovimiento,
        dayMs,
      };
      if (list) list.push(entry);
      else buckets.set(amountKey, [entry]);
    }
  }

  const windowMs = PAIR_MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const cargos = list.filter(e => e.tipo === 'CARGO');
    const abonos = list.filter(e => e.tipo === 'ABONO');
    if (cargos.length === 0 || abonos.length === 0) continue;

    // Orden determinista por (fecha, cuenta, key) para que la elección de
    // cuáles se marcan no dependa del orden de iteración.
    const sortedCargos = [...cargos].sort((a, b) =>
      a.dayMs - b.dayMs || a.cuenta.localeCompare(b.cuenta) || a.key.localeCompare(b.key),
    );
    const sortedAbonos = [...abonos].sort((a, b) =>
      a.dayMs - b.dayMs || a.cuenta.localeCompare(b.cuenta) || a.key.localeCompare(b.key),
    );
    const usedAbono = new Set<number>();
    for (const cargo of sortedCargos) {
      // Elige el ABONO no usado más cercano en fecha, en cuenta distinta,
      // dentro de la ventana. Mismo día (distancia 0) es el match óptimo.
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < sortedAbonos.length; i++) {
        if (usedAbono.has(i)) continue;
        const ab = sortedAbonos[i];
        if (ab.cuenta === cargo.cuenta) continue;
        const dist = Math.abs(ab.dayMs - cargo.dayMs);
        if (dist > windowMs) continue;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
          if (dist === 0) break;
        }
      }
      if (bestIdx === -1) continue;
      usedAbono.add(bestIdx);
      out.add(cargo.key);
      out.add(sortedAbonos[bestIdx].key);
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────

export type InternalReason =
  | 'legend'           // "TRASPASO REF", "TRANSFERENCIA REF", etc.
  | 'legend-extended'  // TRASLADO, INTERCIAS, ENTRE CIAS (leyendas sin REF)
  | 'rfc'              // RFC de empresa del grupo embebido en concepto/referencia
  | 'beneficiary'      // nombre de empresa del grupo como beneficiario
  | 'own-account'      // cuenta destino es otra cuenta del grupo
  | 'pair-matched';    // CARGO-ABONO simétrico el mismo día en cuentas distintas

export interface MovementClassification {
  kind: 'real' | 'internal';
  reason?: InternalReason;
}

export const INTERNAL_REASON_LABELS: Record<InternalReason, string> = {
  legend: 'Marcado como traspaso interno por leyenda',
  'legend-extended': 'Marcado como traspaso entre empresas (TRASLADO / INTERCIAS / ENTRE CIAS)',
  rfc: 'RFC de empresa del grupo en el concepto/referencia',
  beneficiary: 'Beneficiario es una empresa del grupo',
  'own-account': 'Cuenta destino pertenece al grupo',
  'pair-matched': 'CARGO y ABONO simétricos el mismo día en otra cuenta del grupo',
};

export interface ClassificationContext {
  ownAccountDetector?: (m: OwnAccountProbe) => boolean;
  pairedKeys?: Set<string>;
}

/**
 * Clasifica un movimiento como real o interno y, si es interno, indica la
 * razón que disparó la detección (en orden de prioridad: legend → rfc →
 * beneficiary → own-account → pair-matched).
 *
 * `accCia` y `accCuenta` se necesitan sólo para el detector pair-matched
 * (porque las llaves se construyen con esos campos). Si no se pasan, ese
 * detector se omite y la función se comporta igual que `isInternalTransfer`.
 */
export function classifyMovement(
  mov: OwnAccountProbe & Pick<BankStatementLine, 'fechaOperacion' | 'tipoMovimiento' | 'importe'>,
  ctx?: ClassificationContext,
  accCia?: string,
  accCuenta?: string,
): MovementClassification {
  const concepto = mov.concepto ?? '';
  const referencia = mov.referencia ?? '';

  if ((concepto && INTERNAL_TRANSFER_PATTERN.test(concepto)) || (referencia && INTERNAL_TRANSFER_PATTERN.test(referencia))) {
    return { kind: 'internal', reason: 'legend' };
  }
  if ((concepto && INTERNAL_INTERCOMPANY_PATTERN.test(concepto)) || (referencia && INTERNAL_INTERCOMPANY_PATTERN.test(referencia))) {
    return { kind: 'internal', reason: 'legend-extended' };
  }
  if (INTERNAL_RFC_PATTERN && ((concepto && INTERNAL_RFC_PATTERN.test(concepto)) || (referencia && INTERNAL_RFC_PATTERN.test(referencia)))) {
    return { kind: 'internal', reason: 'rfc' };
  }
  if (INTERNAL_BENEFICIARY_PATTERN && ((concepto && INTERNAL_BENEFICIARY_PATTERN.test(concepto)) || (referencia && INTERNAL_BENEFICIARY_PATTERN.test(referencia)))) {
    return { kind: 'internal', reason: 'beneficiary' };
  }
  if (INTERNAL_COMPANY_CODE_PATTERN && ((concepto && INTERNAL_COMPANY_CODE_PATTERN.test(concepto)) || (referencia && INTERNAL_COMPANY_CODE_PATTERN.test(referencia)))) {
    return { kind: 'internal', reason: 'beneficiary' };
  }
  if (ctx?.ownAccountDetector && ctx.ownAccountDetector(mov)) {
    return { kind: 'internal', reason: 'own-account' };
  }
  if (ctx?.pairedKeys && accCia !== undefined && accCuenta !== undefined) {
    const key = movementHashKey(accCia, accCuenta, mov);
    if (ctx.pairedKeys.has(key)) {
      return { kind: 'internal', reason: 'pair-matched' };
    }
  }
  return { kind: 'real' };
}

// ─────────────────────────────────────────────────────────────────────────
// Bank-only cash flow
// ─────────────────────────────────────────────────────────────────────────

/**
 * Movimiento bancario enriquecido con la cuenta/banco/cia de origen para
 * renderizarlo en el detalle diario del Flujo de efectivo sin volver a
 * cruzar estructuras. `line` es el registro crudo del API de JDE.
 */
export interface EnrichedBankMovement {
  date: string;         // ISO fechaOperacion
  amount: number;       // siempre positivo
  tipo: 'ABONO' | 'CARGO';
  concepto: string;
  cia: string;
  banco: string;
  bankName?: string;
  cuenta: string;
  moneda: string;
  referencia: string;
  fechaValor?: string;
  conceptoFull: string;
  /** 'real' = ingreso/egreso económico real; 'internal' = traspaso entre
   * cuentas del grupo (no aporta al flujo neto). */
  kind: 'real' | 'internal';
  /** Sólo presente cuando `kind === 'internal'`. Sirve para mostrar tooltip
   * explicando por qué se clasificó como interno. */
  internalReason?: InternalReason;
}

/**
 * Construye el Flujo de efectivo puramente desde los estados de cuenta
 * bancarios — sin proyecciones CXC ni pendientes CXP.
 *
 * Filtra automáticamente transferencias internas (TRASPASO/TRANSFERENCIA REF,
 * RFCs propios, beneficiarios propios, cuenta destino propia) para que los
 * totales reflejen únicamente los flujos reales del grupo hacia fuera y
 * desde fuera.
 *
 * @param bankStatements   Estados de cuenta año a la fecha (merge del range).
 * @param year             Año a filtrar (YYYY).
 * @param startingBalance  Saldo inicial para el cálculo acumulado.
 */
export function computeBankOnlyCashFlow(
  bankStatements: readonly BankAccountStatement[] | undefined,
  year: number,
  startingBalance: number = 0,
): {
  daily: DailyFlow[];
  abonosByDate: Map<string, EnrichedBankMovement[]>;
  cargosByDate: Map<string, EnrichedBankMovement[]>;
  internalAbonosByDate: Map<string, EnrichedBankMovement[]>;
  internalCargosByDate: Map<string, EnrichedBankMovement[]>;
} {
  const abonosByDate = new Map<string, EnrichedBankMovement[]>();
  const cargosByDate = new Map<string, EnrichedBankMovement[]>();
  const internalAbonosByDate = new Map<string, EnrichedBankMovement[]>();
  const internalCargosByDate = new Map<string, EnrichedBankMovement[]>();

  if (!bankStatements || bankStatements.length === 0) {
    return { daily: [], abonosByDate, cargosByDate, internalAbonosByDate, internalCargosByDate };
  }

  const yearStr = String(year);
  const ownAccountDetector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
  const pairedKeys = buildPairMatchedKeys(bankStatements);
  const ctx: ClassificationContext = { ownAccountDetector, pairedKeys };

  for (const acc of bankStatements) {
    for (const mov of acc.movimientos) {
      const date = parseDate(mov.fechaOperacion);
      if (!date) continue;
      if (!date.startsWith(yearStr)) continue;

      const amount = Math.abs(mov.importe || 0);
      if (amount <= 0) continue;

      const classification = classifyMovement(mov, ctx, acc.cia, acc.cuenta);
      const enriched: EnrichedBankMovement = {
        date,
        amount,
        tipo: mov.tipoMovimiento === 'ABONO' ? 'ABONO' : 'CARGO',
        concepto: (mov.concepto || '').trim() || `${acc.nombreBanco ?? 'Banco'} · ${acc.cuenta}`,
        cia: acc.cia,
        banco: acc.banco,
        bankName: acc.nombreBanco,
        cuenta: acc.cuenta,
        moneda: acc.moneda ?? mov.moneda ?? 'MXN',
        referencia: mov.referencia ?? '',
        fechaValor: mov.fechaValor,
        conceptoFull: mov.concepto ?? '',
        kind: classification.kind,
        internalReason: classification.reason,
      };

      const isAbono = enriched.tipo === 'ABONO';
      const bucket = classification.kind === 'internal'
        ? (isAbono ? internalAbonosByDate : internalCargosByDate)
        : (isAbono ? abonosByDate : cargosByDate);
      if (!bucket.has(date)) bucket.set(date, []);
      bucket.get(date)!.push(enriched);
    }
  }

  // Construir DailyFlow[] ordenado por fecha.
  const activeDates = new Set<string>();
  abonosByDate.forEach((_, d) => activeDates.add(d));
  cargosByDate.forEach((_, d) => activeDates.add(d));
  const sortedDates = Array.from(activeDates).sort();

  const daily: DailyFlow[] = [];
  let cumulative = startingBalance;
  for (const date of sortedDates) {
    const dayAbonos = abonosByDate.get(date) ?? [];
    const dayCargos = cargosByDate.get(date) ?? [];
    const inflows = dayAbonos.reduce((sum, mov) => sum + mov.amount, 0);
    const outflows = dayCargos.reduce((sum, mov) => sum + mov.amount, 0);
    const net = inflows - outflows;
    cumulative += net;
    daily.push({
      date,
      inflows,
      outflows,
      net,
      cumulative,
      // En modo banco no hay distinción proyectado/confirmado — todo es real.
      confirmedIn: inflows,
      projectedIn: 0,
    });
  }

  return { daily, abonosByDate, cargosByDate, internalAbonosByDate, internalCargosByDate };
}

// ─────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * A single day's cash flow position.
 * Includes both confirmed and projected inflows for visibility into confidence.
 */
export interface DailyFlow {
  /** ISO 8601 date string (YYYY-MM-DD) */
  date: string;
  /** Total CXC collections landing on this day (projected) */
  inflows: number;
  /** Total CXP payments due on this day */
  outflows: number;
  /** Inflows minus outflows */
  net: number;
  /** Running cumulative from start of period */
  cumulative: number;
  /** Portion of inflows already confirmed by user */
  confirmedIn: number;
  /** Portion of inflows still projected */
  projectedIn: number;
}

/**
 * Weekly aggregation of cash flow.
 * Groups daily flows by ISO week (Monday..Sunday).
 */
export interface WeeklyFlow {
  /** ISO date of week start (Monday, YYYY-MM-DD) */
  weekStart: string;
  /** ISO week number (1–53) */
  weekNumber: number;
  /** Total weekly inflows */
  inflows: number;
  /** Total weekly outflows */
  outflows: number;
  /** Inflows minus outflows */
  net: number;
  /** Running cumulative from start of period */
  cumulative: number;
}

/**
 * Monthly aggregation of cash flow.
 * Groups daily flows by calendar month.
 */
export interface MonthlyFlow {
  /** Month index (0 = January, 11 = December) */
  month: number;
  /** Month display name in es-MX (Spanish), matching the UI (e.g. "Enero"). */
  monthName: string;
  /** Total monthly inflows */
  inflows: number;
  /** Total monthly outflows */
  outflows: number;
  /** Inflows minus outflows */
  net: number;
  /** Running cumulative from start of period */
  cumulative: number;
  /** Portion of inflows already confirmed */
  confirmedIn: number;
  /** Portion of inflows still projected */
  projectedIn: number;
}

/**
 * Summary KPIs for the entire period.
 * Provides at-a-glance metrics for reporting and alerting.
 */
export interface FlowSummary {
  /** Total inflows across entire period */
  totalInflows: number;
  /** Total outflows across entire period */
  totalOutflows: number;
  /** Net flow (inflows - outflows) */
  netFlow: number;
  /** Average daily net flow */
  avgDailyNet: number;
  /** Worst week by net flow (or null if no weeks) */
  worstWeek: { weekStart: string; net: number } | null;
  /** Best week by net flow (or null if no weeks) */
  bestWeek: { weekStart: string; net: number } | null;
  /** 0-based month indices where net < 0 (negative cash flow) */
  monthsNegative: number[];
  /** Collection efficiency: confirmed / total inflows for dates <= today (0–1) */
  collectionEfficiency: number;
}

/**
 * Payment event — normalized from CXPRecord for flow computations.
 * Simpler shape than CXPRecord, focused on timing and amount.
 *
 * Represents either:
 *   - An actual expense already paid (kind = 'paid'), dated on the actual payment date
 *   - A projected payment still pending (kind = 'pending'), dated on the scheduled/due date
 */
export interface PaymentEvent {
  /** ISO 8601 date string (YYYY-MM-DD) — actual payment date for 'paid', due date for 'pending' */
  date: string;
  /** Amount in local currency (pesos) */
  amount: number;
  /** Supplier name */
  supplier: string;
  /** Supplier classification (from clasificacionProveedor) */
  classification: string;
  /** Whether this event represents an actual historical payment or a projected future payment */
  kind: 'paid' | 'pending';
  /**
   * Payment flexibility from the provider catalog.
   *   - 'inamovible'  → must be paid on credit time, no rescheduling
   *   - 'flexible'    → payment can be rescheduled / pushed out
   *   - 'revisar'     → needs area sign-off before deciding
   *   - 'unknown'     → provider not in catalog
   */
  flexibility: Flexibility;
  /** DTI criticality (Alta/Media/Baja) if provider is in the DTI catalog. */
  criticidad: Criticidad | null;
  /**
   * Optional traceability to the originating source. Populated when the event
   * comes from a real bank CARGO (estado de cuenta JDE) so that the UI can
   * drill down from an aggregated list to the exact movement: qué cuenta,
   * qué banco, qué referencia, en qué empresa del grupo.
   *
   * For CXP-derived events (pending projections) these fields are undefined.
   */
  source?: {
    /** 'bank' → came from a bank statement CARGO; 'cxp' → came from CXPRecord */
    origin: 'bank' | 'cxp';
    /** Company code JDE (p.ej. "00011"). */
    cia?: string;
    /** Bank code JDE. */
    banco?: string;
    /** Human-readable bank name (BBVA, Santander, ...). */
    bankName?: string;
    /** Bank account number. */
    cuenta?: string;
    /** Bank reference / folio. */
    referencia?: string;
    /** Full, untrimmed concept as returned by JDE. */
    conceptoFull?: string;
    /** ISO date of fechaValor (if reported) — useful to flag T+1 settlements. */
    fechaValor?: string;
    /** Currency of the movement (MXN / USD). */
    moneda?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Utility Functions — Date Handling
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a date string coming from operational systems into ISO 8601 (YYYY-MM-DD).
 *
 * Accepted formats (JDE CXP exports mix several):
 *   - "YYYY-MM-DD"                 → ISO date
 *   - "YYYY-MM-DD HH:MM:SS"        → ISO datetime (space separator)
 *   - "YYYY-MM-DDTHH:MM:SS..."     → ISO datetime (T separator)
 *   - "M/D/YYYY" or "MM/DD/YYYY"   → American format (JDE default)
 *   - "D/M/YYYY" or "DD/MM/YYYY"   → Mexican format (used as fallback when
 *                                    the first part is > 12 and cannot be a month)
 *
 * The slash-separated branch detects American vs. Mexican order:
 *   - If the first part is > 12, it must be a day → DD/MM/YYYY
 *   - Otherwise assume MM/DD/YYYY (JDE default for these exports)
 *
 * @param dateStr Raw date value (string). Null/undefined/non-string returns null.
 * @returns ISO date string (YYYY-MM-DD), or null if parsing fails.
 */
function parseDate(dateStr: string | null | undefined): string | null {
  if (dateStr === null || dateStr === undefined) return null;
  const trimmed = String(dateStr).trim();
  if (!trimmed) return null;

  // YYYY-MM-DD (optionally followed by space/T and a time we ignore)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }

  // M/D/YYYY or D/M/YYYY — decide by first-part value
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T].*)?$/);
  if (slashMatch) {
    const first = parseInt(slashMatch[1], 10);
    const second = parseInt(slashMatch[2], 10);
    const year = parseInt(slashMatch[3], 10);

    let month: number;
    let day: number;
    if (first > 12 && second <= 12) {
      // Unambiguously DD/MM/YYYY
      day = first;
      month = second;
    } else {
      // Assume MM/DD/YYYY (JDE default)
      month = first;
      day = second;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }

  // Last resort — let Date try to parse it
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) {
    const y = fallback.getUTCFullYear();
    const m = String(fallback.getUTCMonth() + 1).padStart(2, '0');
    const d = String(fallback.getUTCDate()).padStart(2, '0');
    if (y > 1900 && y < 2200) {
      return `${y}-${m}-${d}`;
    }
  }

  return null;
}

/**
 * Get the ISO week number (1–53) for a given ISO date string.
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @returns Week number (1–53)
 */
function getISOWeekNumber(dateStr: string): number {
  // Delegate to the canonical ISO-8601 implementation in calendar.ts. The
  // previous naive `floor((date − Jan4)/7weeks) + 1` never snapped to Monday
  // boundaries, so it was only correct in years where Jan 4 is a Monday and
  // was off-by-one for most dates (e.g. 2023-01-09 → 1 instead of 2).
  return isoWeek(new Date(dateStr + 'T00:00:00Z'));
}

/**
 * Get the Monday (start) date of the ISO week containing the given date.
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @returns ISO date string of the Monday (YYYY-MM-DD)
 */
function getWeekStartDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = date.getUTCDay();
  const diff = date.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), diff));
  return monday.toISOString().split('T')[0];
}

/**
 * Get the month display name in es-MX (Spanish) — the locale the whole UI
 * renders in. Returns "Enero".."Diciembre" so callers (e.g. MonthlyFlow) show
 * the same month label the user sees everywhere else in the app.
 *
 * @param monthIndex 0-based month index (0 = Enero, 11 = Diciembre)
 * @returns Spanish month name, or '' if the index is out of range
 */
function getMonthName(monthIndex: number): string {
  const months = [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre',
  ];
  return months[monthIndex] || '';
}

/**
 * Check if a date is today or earlier (for collection efficiency cutoff).
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @returns true if date is <= today
 */
function isDateInPastOrToday(dateStr: string): boolean {
  const date = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return date <= today;
}

// ─────────────────────────────────────────────────────────────────────────
// Public Functions — Domain Logic
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extract payment events from CXP records and (optionally) real bank movements.
 *
 * Converts CXPRecord array to PaymentEvent array for the unified cash flow engine.
 * Emits up to TWO events per CXP record so that both historical and projected
 * expenses show up in the cash flow:
 *
 *   1. "paid" event   → (importeBrutoPesos − importePendientePesos) on fechaProgramacionPago
 *                       Represents the portion of the invoice already paid, dated on the
 *                       day it actually happened. Falls back to fechaFactura / fechaVence
 *                       if fechaProgramacionPago is missing.
 *   2. "pending" event → importePendientePesos on fechaProgramacionPago | fechaVence
 *                        Represents the portion still owed, projected on the scheduled or
 *                        due date.
 *
 * Fully paid invoices emit only the "paid" event. Fully open invoices emit only the
 * "pending" event. Partially paid invoices emit both.
 *
 * ─────────────────────────────────────────────────────────────
 * Bank statements (optional)
 * ─────────────────────────────────────────────────────────────
 * When `bankStatements` is supplied, the bank is treated as the source of truth
 * for *actual* outflows that already hit the account:
 *
 *   - Every CARGO movement is emitted as a "paid" PaymentEvent on its
 *     `fechaOperacion`, so weekly/daily PAGOS totals reflect real egresos.
 *   - To avoid double-counting against the CXP "paid" portion (which represents
 *     the same real-world payment from the AP side), CXP "paid" events are
 *     SKIPPED when bank data is provided. CXP "pending" events are kept —
 *     those are future projections that have not yet hit the bank.
 *
 * If no bank data is provided, the legacy behaviour (CXP paid + pending) is used.
 *
 * @param cxpRecords Array of CXP records from the service layer
 * @param bankStatements Optional real bank statements (JDE). When provided,
 *                       CARGOs become the authoritative source for "paid" events.
 * @returns Array of payment events, sorted by date
 */
export function extractPaymentEvents(
  cxpRecords: CXPRecord[],
  bankStatements?: BankAccountStatement[],
): PaymentEvent[] {
  const events: PaymentEvent[] = [];
  const hasBankData = !!bankStatements && bankStatements.length > 0;

  for (const record of cxpRecords) {
    const pending = record.importePendientePesos || 0;
    const gross = record.importeBrutoPesos || 0;
    const paid = Math.max(0, gross - pending);

    const supplier = record.nombre || 'Unknown';
    const classification = record.clasificacionProveedor || 'Uncategorized';
    const enrich = enrichFromCatalog({ supplier, classification });

    // Already-paid portion → use the actual payment date so the expense shows up
    // in cash flow on the day it really happened. When real bank data exists we
    // defer to the bank (below) and skip this to avoid double-counting.
    if (paid > 0 && !hasBankData) {
      const paidDate =
        parseDate(record.fechaProgramacionPago) ||
        parseDate(record.fechaFactura) ||
        parseDate(record.fechaVence);

      if (paidDate) {
        events.push({
          date: paidDate,
          amount: paid,
          supplier,
          classification,
          kind: 'paid',
          flexibility: enrich.flexibility,
          criticidad: enrich.criticidad,
        });
      }
    }

    // Still-pending portion → project on scheduled or due date.
    if (pending > 0) {
      const dueDate =
        parseDate(record.fechaProgramacionPago) || parseDate(record.fechaVence);

      if (dueDate) {
        events.push({
          date: dueDate,
          amount: pending,
          supplier,
          classification,
          kind: 'pending',
          flexibility: enrich.flexibility,
          criticidad: enrich.criticidad,
        });
      }
    }
  }

  // Fold real bank CARGOs (actual egresos) as "paid" events on fechaOperacion.
  if (hasBankData) {
    // Precompute own-account detector una sola vez para todo el batch.
    const ownAccounts = buildOwnAccountsIndex(bankStatements);
    const ownAccountDetector = buildOwnAccountDetector(ownAccounts);

    for (const acc of bankStatements!) {
      const bankLabel =
        acc.nombreBanco?.trim() ||
        (acc.banco ? `Banco ${acc.banco}` : 'Banco');

      for (const mov of acc.movimientos) {
        if (mov.tipoMovimiento !== 'CARGO') continue;
        // Skip traspasos internos — se compensan entre cuentas propias y no
        // representan egresos reales del negocio.
        if (isInternalTransfer(mov, ownAccountDetector)) continue;
        const date = parseDate(mov.fechaOperacion);
        if (!date) continue;
        const amount = Math.abs(mov.importe || 0);
        if (amount <= 0) continue;

        const concepto = (mov.concepto || '').trim();
        // Prefer concepto for traceability; fall back to bank+cuenta.
        const supplier = concepto || `${bankLabel} · ${acc.cuenta}`;

        events.push({
          date,
          amount,
          supplier,
          classification: 'Banco (real)',
          kind: 'paid',
          flexibility: 'unknown',
          criticidad: null,
          source: {
            origin: 'bank',
            cia: acc.cia,
            banco: acc.banco,
            bankName: acc.nombreBanco,
            cuenta: acc.cuenta,
            referencia: mov.referencia,
            conceptoFull: mov.concepto,
            fechaValor: mov.fechaValor,
            moneda: mov.moneda,
          },
        });
      }
    }
  }

  // Sort by date for efficient grouping
  events.sort((a, b) => a.date.localeCompare(b.date));

  return events;
}

/**
 * Convierte órdenes de compra (Compras / `/JDEdwards/compras`) en
 * eventos de pago proyectado.
 *
 * Una OC representa un compromiso de egreso **antes** de que JDE genere la
 * factura (CXP). Esto permite anticipar el egreso 0-30 días antes que CXP
 * lo refleje. Reglas:
 *   - Si `cancelada` → ignorada.
 *   - Si `facturada` → ignorada (CXP / API Facturas la cubrirá; evita doble
 *     conteo cuando se concatena con `extractPaymentEvents(cxp,...)`).
 *   - Si `fechaPagoProyectada` vacía (OC sin recepción) → ignorada para cash
 *     flow; la UI puede mostrar el bucket "Pendiente recepción" por su lado.
 *   - Resto → evento `kind: 'pending'` con monto = `importeTotal` en
 *     `fechaPagoProyectada` = `fechaRecepcion + diasCredito`.
 *
 * El catálogo de proveedores se consulta vía `enrichFromCatalog` igual que
 * en `extractPaymentEvents` para que la flexibilidad y criticidad estén
 * disponibles en la proyección.
 */
export function extractComprasPaymentEvents(
  comprasRecords: ComprasRecord[],
): PaymentEvent[] {
  const events: PaymentEvent[] = [];
  for (const record of comprasRecords) {
    if (record.cancelada || record.facturada) continue;
    if (!record.fechaPagoProyectada) continue;
    const amount = record.importeTotal || 0;
    if (amount <= 0) continue;
    const supplier = record.nombreProveedor || 'Unknown';
    const classification = record.descFamilia || record.descCategoria || 'Uncategorized';
    const enrich = enrichFromCatalog({ supplier, classification });
    events.push({
      date: record.fechaPagoProyectada,
      amount,
      supplier,
      classification,
      kind: 'pending',
      flexibility: enrich.flexibility,
      criticidad: enrich.criticidad,
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events;
}

/**
 * Compute daily cash flow for each day in the period.
 *
 * Aggregates collections (CXC) and payments (CXP) by day, tracking both
 * confirmed and projected inflows. Skips days with no activity.
 *
 * @param collections Array of collection events from collectionEngine
 * @param payments Array of payment events from extractPaymentEvents()
 * @param confirmedPayments Array of confirmed payment records
 * @param year Year to process (filters collections to this year)
 * @param startingBalance Starting cash balance (default 0)
 * @returns Array of daily flows with activity, sorted by date
 */
export function computeDailyFlow(
  collections: CollectionEvent[],
  payments: PaymentEvent[],
  confirmedPayments: ConfirmedPayment[],
  year: number,
  startingBalance: number = 0
): DailyFlow[] {
  // Build a map of confirmed payments for O(1) lookup
  const confirmedMap = new Map<string, ConfirmedPayment>();
  for (const cp of confirmedPayments) {
    confirmedMap.set(cp.key, cp);
  }

  // Group collections by date
  const collectionsByDate = new Map<string, CollectionEvent[]>();
  for (const collection of collections) {
    // Filter to the target year
    const date = collection.realDate;
    if (!date.startsWith(year.toString())) {
      continue;
    }

    if (!collectionsByDate.has(date)) {
      collectionsByDate.set(date, []);
    }
    collectionsByDate.get(date)!.push(collection);
  }

  // Group payments by date
  const paymentsByDate = new Map<string, PaymentEvent[]>();
  for (const payment of payments) {
    // Filter to the target year
    if (!payment.date.startsWith(year.toString())) {
      continue;
    }

    if (!paymentsByDate.has(payment.date)) {
      paymentsByDate.set(payment.date, []);
    }
    paymentsByDate.get(payment.date)!.push(payment);
  }

  // Collect all active dates
  const activeDates = new Set<string>();
  collectionsByDate.forEach((_, date) => activeDates.add(date));
  paymentsByDate.forEach((_, date) => activeDates.add(date));

  // Sort dates chronologically
  const sortedDates = Array.from(activeDates).sort();

  // Compute daily flows
  const dailyFlows: DailyFlow[] = [];
  let cumulative = startingBalance;

  for (const date of sortedDates) {
    let inflows = 0;
    let confirmedIn = 0;
    let projectedIn = 0;

    // Sum inflows for this date
    const dayCollections = collectionsByDate.get(date) || [];
    for (const collection of dayCollections) {
      const key = eventKey(collection);
      const confirmed = confirmedMap.get(key);

      if (confirmed) {
        confirmedIn += confirmed.amount;
      } else {
        projectedIn += collection.amount;
      }

      inflows += collection.amount;
    }

    // Sum outflows for this date
    let outflows = 0;
    const dayPayments = paymentsByDate.get(date) || [];
    for (const payment of dayPayments) {
      outflows += payment.amount;
    }

    // Compute net and cumulative
    const net = inflows - outflows;
    cumulative += net;

    dailyFlows.push({
      date,
      inflows,
      outflows,
      net,
      cumulative,
      confirmedIn,
      projectedIn,
    });
  }

  return dailyFlows;
}

/**
 * Aggregate daily flows into weekly groups.
 *
 * Groups by ISO week (Monday–Sunday) and sums all flows within each week.
 *
 * @param daily Array of daily flows
 * @returns Array of weekly flows, one per week, sorted by date
 */
export function aggregateWeekly(daily: DailyFlow[]): WeeklyFlow[] {
  const weeklyMap = new Map<string, WeeklyFlow>();

  for (const day of daily) {
    const weekStart = getWeekStartDate(day.date);
    const weekNumber = getISOWeekNumber(day.date);

    if (!weeklyMap.has(weekStart)) {
      weeklyMap.set(weekStart, {
        weekStart,
        weekNumber,
        inflows: 0,
        outflows: 0,
        net: 0,
        cumulative: 0,
      });
    }

    const week = weeklyMap.get(weekStart)!;
    week.inflows += day.inflows;
    week.outflows += day.outflows;
    week.net += day.net;
    week.cumulative = day.cumulative; // Use last day's cumulative
  }

  // Sort by week start date
  const weeks = Array.from(weeklyMap.values());
  weeks.sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return weeks;
}

/**
 * Aggregate daily flows into monthly groups.
 *
 * Groups by calendar month and sums all flows within each month,
 * tracking both confirmed and projected inflows. El saldo inicial ya viene
 * aplicado en `day.cumulative` (ver generateDailyFlows), así que el último
 * `cumulative` del mes es la caja al cierre sin ajustes adicionales.
 *
 * @param daily Array of daily flows
 * @returns Array of monthly flows, one per month, sorted by date
 */
export function aggregateMonthly(
  daily: DailyFlow[]
): MonthlyFlow[] {
  const monthlyMap = new Map<number, MonthlyFlow>();

  for (const day of daily) {
    const date = new Date(day.date + 'T00:00:00Z');
    const monthIndex = date.getUTCMonth();

    if (!monthlyMap.has(monthIndex)) {
      monthlyMap.set(monthIndex, {
        month: monthIndex,
        monthName: getMonthName(monthIndex),
        inflows: 0,
        outflows: 0,
        net: 0,
        cumulative: 0,
        confirmedIn: 0,
        projectedIn: 0,
      });
    }

    const month = monthlyMap.get(monthIndex)!;
    month.inflows += day.inflows;
    month.outflows += day.outflows;
    month.net += day.net;
    month.confirmedIn += day.confirmedIn;
    month.projectedIn += day.projectedIn;
    month.cumulative = day.cumulative; // Use last day's cumulative
  }

  // Build result array in calendar order
  const months: MonthlyFlow[] = [];
  for (let i = 0; i < 12; i++) {
    if (monthlyMap.has(i)) {
      months.push(monthlyMap.get(i)!);
    }
  }

  return months;
}

/**
 * Compute summary KPIs for the entire period.
 *
 * Calculates key metrics including worst/best weeks, negative months,
 * and collection efficiency for reporting and alerting.
 *
 * @param monthly Array of monthly flows
 * @param collections Array of collection events (all years)
 * @param confirmedPayments Array of confirmed payment records
 * @returns Summary KPIs for the period
 */
export function computeSummary(
  monthly: MonthlyFlow[],
  collections: CollectionEvent[],
  confirmedPayments: ConfirmedPayment[]
): FlowSummary {
  // Sum totals from monthly data
  let totalInflows = 0;
  let totalOutflows = 0;
  const monthsNegative: number[] = [];

  for (const m of monthly) {
    totalInflows += m.inflows;
    totalOutflows += m.outflows;
    if (m.net < 0) {
      monthsNegative.push(m.month);
    }
  }

  const netFlow = totalInflows - totalOutflows;
  const avgDailyNet = monthly.length > 0 ? netFlow / (monthly.length * 30) : 0; // Rough average

  // Collection efficiency: confirmed / total for dates <= today
  let confirmedTotal = 0;
  let projectedTotal = 0;

  for (const collection of collections) {
    if (!isDateInPastOrToday(collection.realDate)) {
      continue;
    }

    const key = eventKey(collection);
    const isConfirmed = confirmedPayments.some((cp) => cp.key === key);

    if (isConfirmed) {
      confirmedTotal += collection.amount;
    } else {
      projectedTotal += collection.amount;
    }
  }

  const collectionEfficiency =
    confirmedTotal + projectedTotal > 0
      ? confirmedTotal / (confirmedTotal + projectedTotal)
      : 0;

  // Worst and best weeks (computed separately since we don't store weeks here)
  // For now, return null — caller can compute from weekly aggregation if needed
  const worstWeek: { weekStart: string; net: number } | null = null;
  const bestWeek: { weekStart: string; net: number } | null = null;

  return {
    totalInflows,
    totalOutflows,
    netFlow,
    avgDailyNet,
    worstWeek,
    bestWeek,
    monthsNegative,
    collectionEfficiency,
  };
}

/**
 * Compute worst and best weeks from weekly aggregation.
 *
 * Helper function to find extreme weeks for KPI reporting.
 * Returns null if the weekly array is empty.
 *
 * @param weekly Array of weekly flows
 * @returns Object with worstWeek and bestWeek, or null for either if empty
 */
export function findExtremeWeeks(weekly: WeeklyFlow[]): {
  worstWeek: { weekStart: string; net: number } | null;
  bestWeek: { weekStart: string; net: number } | null;
} {
  if (weekly.length === 0) {
    return { worstWeek: null, bestWeek: null };
  }

  let worst = weekly[0];
  let best = weekly[0];

  for (const week of weekly) {
    if (week.net < worst.net) {
      worst = week;
    }
    if (week.net > best.net) {
      best = week;
    }
  }

  return {
    worstWeek: { weekStart: worst.weekStart, net: worst.net },
    bestWeek: { weekStart: best.weekStart, net: best.net },
  };
}
