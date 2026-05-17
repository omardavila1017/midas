/**
 * Servicios JD Edwards — punto de entrada único.
 *
 * Cada función encapsula un endpoint y normaliza la respuesta a los tipos
 * domésticos definidos en jdeTypes.ts. Los mappers son tolerantes a
 * variaciones de naming (snake_case, camelCase, PascalCase) porque el API
 * está en desarrollo y los nombres exactos de campos pueden ajustarse.
 *
 * Uso:
 *   import { fetchAgedBalances, fetchBankStatements, fetchCompanies } from '@/services/jde';
 *
 *   const saldos = await fetchAgedBalances({ cia: '00011' });
 *   const edoCta = await fetchBankStatements({ fechaEstadoCuenta: '2026-04-16', formatoElectronico: 'SWIFT' });
 *   const empresas = await fetchCompanies();
 */

import { jdeClient, JdeClientConfig } from './jdeClient';
import {
  AgedBalanceRecord,
  AgedBalanceRequest,
  BankAccountStatement,
  BankStatementLine,
  BankStatementRequest,
  BankStatementFormat,
  CobranzaRecord,
  CobranzaRequest,
  Company,
} from './jdeTypes';

// ───────────────────────────────────────────────────────────────
// Helpers de normalización
// ───────────────────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

/** Busca una clave por varios alias (case-insensitive, snake/camel). */
function pick(obj: RawRecord, aliases: string[]): unknown {
  const keys = Object.keys(obj);
  for (const alias of aliases) {
    const a = alias.toLowerCase();
    const found = keys.find(k => k.toLowerCase() === a);
    if (found !== undefined) return obj[found];
  }
  return undefined;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Normaliza el campo `cia` de la respuesta JDE.
 *
 * El API regresa la cia en varias formas según el endpoint:
 *   - "00011"                                  → /empresas, /antiguedadsaldos
 *   - "00011 - SERVICIO INDUSTRIAL REGIOMONTANO"→ /antiguedadsaldos en algunos casos
 *   - "00011,"                                  → /cobranza (la coma proviene del
 *                                                request body que el equipo JDE
 *                                                comparte como ejemplo y aparece
 *                                                eco en algunas respuestas).
 *
 * Para poder agrupar/filtrar registros por compañía hay que reducir todos
 * estos a un código canónico de 5 dígitos. Estrategia:
 *   1. Tomar la PRIMERA secuencia de dígitos consecutivos de la cadena.
 *      Esto cubre los tres casos sin bifurcarnos por cada formato.
 *   2. Pad a 5 dígitos.
 *   3. Si no hay dígitos (raro, p.ej. cia="MX"), devolver el head limpio.
 */
function normalizeCia(v: unknown): string {
  const raw = toStr(v);
  if (!raw) return '';
  const digitMatch = raw.match(/\d+/);
  if (digitMatch) return digitMatch[0].padStart(5, '0');
  // Sin dígitos: caer al patrón antiguo (split por espacio/guion/coma).
  const head = raw.split(/[\s\-,]/)[0].trim();
  return head;
}

/** Desenvuelve respuestas tipo { data: [...] } o { result: [...] } o arreglo directo. */
function unwrapList(raw: unknown): RawRecord[] {
  if (Array.isArray(raw)) return raw as RawRecord[];
  if (raw && typeof raw === 'object') {
    const obj = raw as RawRecord;
    for (const key of ['data', 'result', 'results', 'records', 'items', 'rows']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as RawRecord[];
    }
  }
  return [];
}

// ───────────────────────────────────────────────────────────────
// 1. Antigüedad de Saldos
// ───────────────────────────────────────────────────────────────

function mapAgedBalance(raw: RawRecord): AgedBalanceRecord {
  return {
    cia:                     normalizeCia(pick(raw, ['cia', 'compania', 'company'])),
    noProveedor:             toStr(pick(raw, ['noProveedor', 'no_prov', 'no_proveedor', 'proveedor'])),
    nombre:                  toStr(pick(raw, ['nombre', 'nombreProveedor', 'razonSocial'])),
    noFactura:               toStr(pick(raw, ['noFactura', 'no_factura', 'factura'])),
    fechaFactura:            toStr(pick(raw, ['fechaFactura', 'fecha_factura'])),
    fechaVence:              toStr(pick(raw, ['fechaVence', 'fecha_vence', 'fechaVencimiento'])),
    fechaProgramacionPago:   toStr(pick(raw, ['fechaProgramacionPago', 'fecha_programacion_pago', 'fechaProgPago'])),
    diasVencida:             toNum(pick(raw, ['diasVencida', 'dias_vencida', 'diasVencido'])),
    importeBrutoPesos:       toNum(pick(raw, ['importeBrutoPesos', 'importe_bruto_pesos'])),
    importePendientePesos:   toNum(pick(raw, ['importePendientePesos', 'importe_pendiente_pesos'])),
    importeSubtotalPesos:    toNum(pick(raw, ['importeSubtotalPesos', 'importe_subtotal_pesos'])),
    importeImpuestosPesos:   toNum(pick(raw, ['importeImpuestosPesos', 'importe_impuestos_pesos'])),
    importeBrutoDolares:     toNum(pick(raw, ['importeBrutoDolares', 'importe_bruto_dolares'])),
    importePendienteDolares: toNum(pick(raw, ['importePendienteDolares', 'importe_pendiente_dolares'])),
    moneda:                  toStr(pick(raw, ['moneda', 'currency'])),
    condPago:                toStr(pick(raw, ['condPago', 'cond_pago', 'condicionPago'])),
    clasifica:               toStr(pick(raw, ['clasifica', 'clasificacion'])),
    clasificacionProveedor:  toStr(pick(raw, ['clasificacionProveedor', 'clasificacion_proveedor'])),
    edoPago:                 toStr(pick(raw, ['edoPago', 'edo_pago', 'estadoPago'])),
    tipoCambio:              toNum(pick(raw, ['tipoCambio', 'tipo_cambio', 'tc'])),
    porVencer:               toNum(pick(raw, ['porVencer', 'por_vencer'])),
    v1_30:                   toNum(pick(raw, ['v1_30', 'v_1_30', 'v0130'])),
    v31_60:                  toNum(pick(raw, ['v31_60', 'v_31_60', 'v3160'])),
    v61_90:                  toNum(pick(raw, ['v61_90', 'v_61_90', 'v6190'])),
    v91_120:                 toNum(pick(raw, ['v91_120', 'v_91_120', 'v91120'])),
    v121_150:                toNum(pick(raw, ['v121_150', 'v_121_150', 'v121150'])),
    v151_180:                toNum(pick(raw, ['v151_180', 'v_151_180', 'v151180'])),
    mas180:                  toNum(pick(raw, ['mas180', 'mas_180', 'masDe180'])),
  };
}

/**
 * POST /v1/erp/tesoreria/antiguedadsaldos
 * Retorna todos los saldos abiertos por proveedor para la compañía indicada.
 */
export async function fetchAgedBalances(
  req: AgedBalanceRequest,
  config: JdeClientConfig = {},
): Promise<AgedBalanceRecord[]> {
  const raw = await jdeClient.post<unknown>('/antiguedadsaldos', req, config);
  return unwrapList(raw).map(mapAgedBalance);
}

// ───────────────────────────────────────────────────────────────
// 2. Bancos — Estado de Cuenta
// ───────────────────────────────────────────────────────────────

/**
 * Extrae el código de compañía JDE a partir del campo Cuenta_Contable.
 *
 * Formato típico de JDE: "BU.Object.Subsidiary" → e.g. "38.1020.0011305"
 * La Business Unit (BU) mapea al código de compañía con padding:
 *   BU "38" → cia "00038",  BU "11" → cia "00011"
 *
 * Si Cuenta_Contable es null (como en TMPB) retorna "".
 */
function extractCiaFromCuentaContable(cuentaContable: unknown): string {
  const raw = toStr(cuentaContable);
  if (!raw) return '';
  const dotIdx = raw.indexOf('.');
  const bu = dotIdx > 0 ? raw.slice(0, dotIdx) : raw;
  const buNum = parseInt(bu, 10);
  if (!Number.isFinite(buNum) || buNum <= 0) return '';
  return String(buNum).padStart(5, '0');
}

/**
 * Extrae el nombre del banco del campo Nombre_cuenta_Contable.
 * Ejemplos:
 *   "BANAMEX  877732401"        → "BANAMEX"
 *   "BANAMEX - 7014 350840"     → "BANAMEX"
 *   "BANORTE 0123456789"        → "BANORTE"
 */
function extractBankName(raw: unknown): string {
  const s = toStr(raw);
  if (!s) return '';
  // Tomar solo la parte alfabética inicial (el nombre del banco)
  const match = s.match(/^([A-Za-zÁÉÍÓÚáéíóúÑñ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]+)*)/);
  return match ? match[1].trim() : s;
}

/**
 * Parsea el concepto/descripción de los campos InF_ADI de JDE.
 *
 * InF_ADI_1 formato típico:  "322?00PAGO A TERCEROS?20/EI/TR"
 *   → extraemos "PAGO A TERCEROS"
 *
 * InF_ADI_2 formato típico:  "P589  00877732401 a 7013870885 1 SERVICIOS T DE N?21  Pago de SERVICIOS T DE N 170405"
 *   → usamos como detalle si InF_ADI_1 no tiene concepto claro
 */
function parseConcepto(inf1: unknown, inf2: unknown): string {
  const s1 = toStr(inf1);
  const s2 = toStr(inf2);

  // Intentar extraer de InF_ADI_1: buscar texto entre ?00 y ?
  if (s1) {
    const match = s1.match(/\?00([^?]+)/);
    if (match) return match[1].trim();
    // Formato TMPB: "Hora_carga: 10 - Linea: 0000001" → no es útil, usar s2
    if (!s1.startsWith('Hora_carga')) return s1;
  }

  // Fallback a InF_ADI_2 (limpiar)
  if (s2) return s2.replace(/\?[0-9]+\s*/g, ' ').trim();

  return '';
}

/**
 * Mapea un registro plano del API de Bancos a nuestro tipo interno.
 *
 * Campos reales del API JDE (desarrollo actual):
 *   Tipo_Estado_Cuenta, gsaid, Fecha_Estado_Cuenta, Cuenta_Bancos,
 *   Cuenta_Contable, Nombre_cuenta_Contable, Saldo_Inicial, Saldo_Final,
 *   tipo_Cuenta_Bancos, DESC039, Importe, Codigo_Transaccion_banco,
 *   Tipo_Movimiento ("DEBITO"/"CREDITO"), Referencia_Cliente,
 *   InF_ADI_1, InF_ADI_2, InF_ADI_3, Codigo_Categoria_33..38, DESC033..038
 */
function mapBankLine(raw: RawRecord): BankStatementLine {
  // ── Importe ──
  const importeRaw = toNum(
    pick(raw, ['Importe', 'importe', 'monto', 'amount']),
  );
  const absImporte = Math.abs(importeRaw);

  // ── Tipo de movimiento ──
  const tipo = toStr(
    pick(raw, ['Tipo_Movimiento', 'tipoMovimiento', 'tipo_movimiento', 'tipo', 'dc']),
  ).toUpperCase();
  const tipoMovimiento =
    tipo === 'DEBITO'  || tipo === 'CARGO' || tipo === 'C' || tipo === 'D' || importeRaw < 0
      ? 'CARGO' :
    tipo === 'CREDITO' || tipo === 'ABONO' || tipo === 'A' || tipo === 'CR' || importeRaw > 0
      ? 'ABONO' :
    tipo || 'ABONO';

  // ── Fecha ── prioridad: fechaOperacion real > Fecha_Estado_Cuenta (la de la request)
  // La API de producción (api.gruposenda.com) regresa fechaOperacion por línea
  // cuando existe. Solo cuando no hay campo dedicado caemos al statement date.
  // Normalizamos ISO "2026-04-17T00:00:00" → "2026-04-17".
  const rawFecha = toStr(
    pick(raw, [
      'fechaOperacion', 'fecha_operacion', 'FechaOperacion', 'Fecha_Operacion',
      'fechaMovimiento', 'Fecha_Movimiento', 'fecha_movimiento',
      'fecha', 'date',
      'Fecha_Estado_Cuenta',
    ]),
  );
  const fechaOperacion = rawFecha.includes('T') ? rawFecha.split('T')[0] : rawFecha;

  // ── Empresa ── derivada de Cuenta_Contable (BU → cia con padding)
  const ciaExplicit = toStr(pick(raw, ['cia', 'compania']));
  const cia = ciaExplicit || extractCiaFromCuentaContable(pick(raw, ['Cuenta_Contable', 'cuenta_contable']));

  // ── Banco ── nombre extraído de Nombre_cuenta_Contable + tipo de cuenta (DESC039)
  const nombreBancoRaw = toStr(
    pick(raw, ['Nombre_cuenta_Contable', 'nombreBanco', 'nombre_banco', 'bankName']),
  );
  const bankNameOnly = extractBankName(nombreBancoRaw);
  const tipoCuenta = toStr(pick(raw, ['DESC039']));
  const nombreBanco = bankNameOnly
    ? (tipoCuenta ? `${bankNameOnly} · ${tipoCuenta}` : bankNameOnly)
    : (tipoCuenta || undefined);

  // ── Cuenta bancaria ──
  const cuenta = toStr(
    pick(raw, ['Cuenta_Bancos', 'cuenta', 'numeroCuenta', 'numero_cuenta', 'account']),
  );

  // ── Concepto (parsing inteligente de InF_ADI) ──
  const concepto = parseConcepto(
    pick(raw, ['InF_ADI_1']),
    pick(raw, ['InF_ADI_2']),
  );

  // ── Referencia ──
  const referencia = toStr(
    pick(raw, ['Referencia_Cliente', 'referencia', 'folio', 'reference']),
  );

  // ── Banco ── usamos el nombre extraído como código también (no hay campo banco dedicado en JDE)
  const banco = nombreBanco || toStr(
    pick(raw, ['banco', 'codigoBanco', 'bankCode']),
  );

  // ── Moneda ── JDE no la devuelve explícitamente; inferimos de categorías si posible
  const descMoneda = toStr(pick(raw, ['DESC036', 'moneda', 'currency']));
  const moneda = descMoneda.includes('M.N.') || descMoneda.includes('MXN') ? 'MXN'
    : descMoneda.includes('USD') || descMoneda.includes('DLS') || descMoneda.includes('Dólar') ? 'USD'
    : descMoneda || 'MXN';

  return {
    cia,
    banco,
    nombreBanco,
    cuenta,
    moneda,
    fechaOperacion,
    fechaValor: undefined,
    referencia,
    concepto,
    tipoMovimiento,
    importe: absImporte,
    saldo: undefined, // saldos se manejan a nivel de cuenta, no por línea
  };
}

/**
 * Agrupa líneas planas por cuenta bancaria y asigna saldos.
 *
 * El API de JDE devuelve Saldo_Inicial y Saldo_Final como campos repetidos
 * en cada línea de la misma cuenta. Los tomamos del primer registro raw
 * de cada grupo.
 */
function groupByAccount(
  rawLines: RawRecord[],
  mappedLines: BankStatementLine[],
  fechaEstadoCuenta: string,
): BankAccountStatement[] {
  const map = new Map<string, {
    acc: BankAccountStatement;
    saldoInicial: number | undefined;
    saldoFinal: number | undefined;
  }>();

  for (let i = 0; i < mappedLines.length; i++) {
    const l = mappedLines[i];
    const r = rawLines[i];
    const key = `${l.cia}::${l.cuenta}::${l.moneda}`;

    let entry = map.get(key);
    if (!entry) {
      // Tomar saldos del primer registro raw del grupo
      const si = pick(r, ['Saldo_Inicial', 'saldoInicial', 'saldo_inicial']);
      const sf = pick(r, ['Saldo_Final', 'saldoFinal', 'saldo_final']);
      entry = {
        acc: {
          cia: l.cia,
          banco: l.banco,
          nombreBanco: l.nombreBanco,
          cuenta: l.cuenta,
          moneda: l.moneda,
          fechaEstadoCuenta,
          movimientos: [],
        },
        saldoInicial: si !== undefined && si !== null ? toNum(si) : undefined,
        saldoFinal: sf !== undefined && sf !== null ? toNum(sf) : undefined,
      };
      map.set(key, entry);
    }
    entry.acc.movimientos.push(l);
  }

  // Asignar saldos y ordenar movimientos
  for (const { acc, saldoInicial, saldoFinal } of map.values()) {
    acc.saldoInicial = saldoInicial;
    acc.saldoFinal = saldoFinal;
    acc.movimientos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));
  }

  return Array.from(map.values()).map(e => e.acc);
}

/**
 * POST /v1/erp/tesoreria/bancos
 * Retorna el estado de cuenta agrupado por cuenta bancaria.
 */
export async function fetchBankStatements(
  req: BankStatementRequest,
  config: JdeClientConfig = {},
): Promise<BankAccountStatement[]> {
  const raw = await jdeClient.post<unknown>('/bancos', req, config);
  const list = unwrapList(raw);
  if (list.length === 0) return [];

  // El API actual de JDE Desarrollo devuelve líneas planas con
  // Saldo_Inicial/Saldo_Final repetidos por cuenta → agrupar.
  const lines = list.map(mapBankLine);
  return groupByAccount(list, lines, req.fechaEstadoCuenta);
}

/**
 * Fetch bank statements for a date range and merge by account.
 *
 * Context: /bancos solo acepta una `fechaEstadoCuenta` por request —
 * es una "foto" diaria. Para reconstruir el histórico (flujo de efectivo año
 * a la fecha, conciliación por semana, etc.) hay que llamar el endpoint día
 * por día y concatenar. Esta función lo hace con concurrencia controlada y
 * deduplica movimientos por (fechaOperacion, referencia, importe, tipo,
 * concepto) para tolerar solapes entre fechas contiguas.
 *
 * Comportamiento de saldos al mergear:
 *   - `saldoInicial` = saldo inicial del día más antiguo que respondió.
 *   - `saldoFinal`   = saldo final del día más reciente que respondió.
 *   - `fechaEstadoCuenta` = el día más reciente del rango con datos.
 *
 * Errores por día son silenciados (cada día se trata como 0 movimientos)
 * para no abortar el rango entero si un solo día falla — el caller puede
 * detectar fallos totales viendo si el array devuelto está vacío.
 *
 * @param from   Fecha inicial inclusive (YYYY-MM-DD).
 * @param to     Fecha final inclusive (YYYY-MM-DD).
 * @param formato Formato electrónico (default SWIFT).
 * @param options Concurrencia, callback de progreso, config JDE.
 * @returns Un BankAccountStatement[] — un elemento por (cia, cuenta, moneda)
 *          — con `movimientos` cubriendo todo el rango.
 */
export async function fetchBankStatementsRange(
  from: string,
  to: string,
  formato: BankStatementFormat = 'SWIFT',
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    config?: JdeClientConfig;
  } = {},
): Promise<BankAccountStatement[]> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const config = options.config ?? {};

  // Build the list of dates [from..to] inclusive.
  const dates: string[] = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return [];
  }
  for (
    const d = new Date(start);
    d <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    dates.push(d.toISOString().slice(0, 10));
  }

  // Parallel fetch with a simple worker pool.
  // Cada día puede fallar por timeout transitorio del proxy serverless o
  // por contención del API JDE (devuelve 500 cuando se le encima la cola).
  // Reintentamos hasta 2 veces con backoff antes de aceptar 0 movimientos —
  // en producción esto recupera la mayoría de días que de otro modo se
  // perderían y dejaban al usuario viendo solo los pocos días que pasaron
  // a la primera.
  const results: BankAccountStatement[][] = new Array(dates.length);
  let cursor = 0;
  let done = 0;

  // Throttle del callback de progreso. Si el caller persiste estado de React
  // en cada update (típico en App.tsx), 124 updates en ~30s producen 124
  // re-renders del root y eso congela el main thread en apps grandes. Acotamos
  // a ~5 updates/segundo + un emit final para garantizar que la UI termine
  // mostrando done==total. Ver perfilado 2026-05-03 en COBRANZA-HANDOFF.md.
  const PROGRESS_THROTTLE_MS = 200;
  let lastProgressEmit = 0;
  const emitProgress = (force = false) => {
    if (!options.onProgress) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (force || done === dates.length || now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
      lastProgressEmit = now;
      options.onProgress(done, dates.length);
    }
  };

  const MAX_ATTEMPTS = 3;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= dates.length) return;
      let attempt = 0;
      let dayResult: BankAccountStatement[] = [];
      while (attempt < MAX_ATTEMPTS) {
        try {
          dayResult = await fetchBankStatements(
            { fechaEstadoCuenta: dates[idx], formatoElectronico: formato },
            config,
          );
          break;
        } catch {
          attempt++;
          if (attempt >= MAX_ATTEMPTS) {
            dayResult = [];
            break;
          }
          // Backoff con jitter para no estampar al upstream cuando un batch
          // entero de días concurrentes falla a la vez.
          const delay = 400 * attempt + Math.floor(Math.random() * 300);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      results[idx] = dayResult;
      done++;
      emitProgress();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, dates.length) }, worker),
  );
  // Forzar el último emit para que el caller siempre vea done == total.
  emitProgress(true);

  // Merge by (cia, cuenta, moneda).
  const merged = new Map<string, BankAccountStatement>();
  const seen = new Map<string, Set<string>>();
  const firstDate = new Map<string, string>();
  const lastDate = new Map<string, string>();

  for (let i = 0; i < dates.length; i++) {
    const dayStatements = results[i] || [];
    for (const s of dayStatements) {
      const key = `${s.cia}::${s.cuenta}::${s.moneda}`;
      let acc = merged.get(key);
      if (!acc) {
        acc = {
          cia: s.cia,
          banco: s.banco,
          nombreBanco: s.nombreBanco,
          cuenta: s.cuenta,
          moneda: s.moneda,
          fechaEstadoCuenta: s.fechaEstadoCuenta,
          saldoInicial: s.saldoInicial,
          saldoFinal: s.saldoFinal,
          movimientos: [],
        };
        merged.set(key, acc);
        seen.set(key, new Set());
        firstDate.set(key, s.fechaEstadoCuenta);
        lastDate.set(key, s.fechaEstadoCuenta);
      }

      // Track earliest/latest response dates per account.
      if (s.fechaEstadoCuenta < (firstDate.get(key) ?? s.fechaEstadoCuenta)) {
        firstDate.set(key, s.fechaEstadoCuenta);
        if (s.saldoInicial !== undefined) acc.saldoInicial = s.saldoInicial;
      }
      if (s.fechaEstadoCuenta >= (lastDate.get(key) ?? s.fechaEstadoCuenta)) {
        lastDate.set(key, s.fechaEstadoCuenta);
        acc.fechaEstadoCuenta = s.fechaEstadoCuenta;
        if (s.saldoFinal !== undefined) acc.saldoFinal = s.saldoFinal;
        // Keep the most recent human-readable bank label too.
        if (s.nombreBanco) acc.nombreBanco = s.nombreBanco;
      }

      const seenSet = seen.get(key)!;
      for (const mov of s.movimientos) {
        const mk = `${mov.fechaOperacion}|${mov.referencia}|${mov.tipoMovimiento}|${mov.importe}|${mov.concepto}`;
        if (seenSet.has(mk)) continue;
        seenSet.add(mk);
        acc.movimientos.push(mov);
      }
    }
  }

  // Sort movimientos within each account chronologically.
  for (const acc of merged.values()) {
    acc.movimientos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));
  }

  return Array.from(merged.values());
}

// ───────────────────────────────────────────────────────────────
// 3. Empresas
// ───────────────────────────────────────────────────────────────

function mapCompany(raw: RawRecord): Company {
  const activaRaw = pick(raw, ['activa', 'activo', 'active', 'enabled']);
  return {
    cia:        toStr(pick(raw, ['cia', 'codigo', 'code', 'compania'])),
    nombre:     toStr(pick(raw, ['nombre', 'razonSocial', 'razon_social', 'name'])),
    rfc:        toStr(pick(raw, ['rfc', 'taxId', 'tax_id'])) || undefined,
    monedaBase: toStr(pick(raw, ['monedaBase', 'moneda_base', 'moneda', 'currency'])) || undefined,
    activa:     activaRaw === undefined ? undefined
                : activaRaw === true || activaRaw === 'S' || activaRaw === 'SI' || activaRaw === 1
                  ? true : activaRaw === false || activaRaw === 'N' || activaRaw === 'NO' || activaRaw === 0
                    ? false : undefined,
  };
}

/**
 * GET /v1/erp/tesoreria/empresas
 * Retorna el catálogo de compañías disponible para el usuario autenticado.
 */
export async function fetchCompanies(config: JdeClientConfig = {}): Promise<Company[]> {
  const raw = await jdeClient.get<unknown>('/empresas', config);
  return unwrapList(raw).map(mapCompany).filter(c => c.cia);
}

// ───────────────────────────────────────────────────────────────
// 4. Cobranza (CXC)
// ───────────────────────────────────────────────────────────────

/**
 * Mapper de un registro CXC del API JDE de Cobranza.
 *
 * Shape real de la respuesta productiva (validado 2026-05-03 con un dump
 * compartido por el equipo de tesorería):
 *
 *   {
 *     "Cia": "00001",
 *     "No_Cliente": 99999988,                               // number
 *     "Nombre_Cliente": "RITA PRADO VAZQUEZ           ",    // padded con espacios
 *     "RFC": "PAVR7405221A9       ",
 *     "Factura": "RI-85022",
 *     "Dias_Credito": "1  ",
 *     "Fecha_Factura": "2025-05-05T00:00:00",
 *     "Fecha_Vencimiento": "2025-05-06T00:00:00",
 *     "Fecha_Pago": "2025-05-12T00:00:00",                 // ← cobrada efectiva
 *     "Fecha_Contable": "2025-05-05T00:00:00",
 *     "Dias_Fecha_Vencimiento_vs_Fecha_Pago": 6,           // solo cuando ya cobrada
 *     "TasaFiscal": "EXTO           ",
 *     "SubTotal": 1155.44,
 *     "Importe_IVA": 0,
 *     "Importe_RETENCION": 0,
 *     "Importe_Factura": 1155.44,                           // ← gross (Sub + IVA − RET)
 *     "Importe_Pendiente": 0,                                // ← saldo abierto
 *     "UUID_Fiscal": "..."
 *   }
 *
 * Notas operativas:
 *   - El API NO devuelve `moneda` ni `tipoCambio` — todos los importes son
 *     MXN según el equipo. Asumimos default MXN; si en el futuro liberan
 *     facturas USD, agregamos el alias.
 *   - El API NO devuelve un `estatus` textual, pero se puede derivar:
 *     pendiente > 0 → "PENDIENTE", pendiente == 0 + Fecha_Pago set →
 *     "COBRADA", caso raro pendiente==0 sin Fecha_Pago → "CANCELADA".
 *   - `Dias_Fecha_Vencimiento_vs_Fecha_Pago` solo está poblado cuando la
 *     factura ya fue cobrada en JDE. Para facturas pendientes computamos
 *     `today − fechaVencimiento` localmente.
 */
function mapCobranza(raw: RawRecord): CobranzaRecord {
  // ── Importes ── el campo "Importe_Factura" es el gross final (subtotal +
  // IVA − retenciones). Es lo que se compara contra el ABONO bancario
  // cuando la factura está pagada al 100%. Mantenemos también pendiente
  // como saldo abierto.
  const importeBrutoPesos = toNum(
    pick(raw, [
      'importeBrutoPesos', 'importe_bruto_pesos', 'importeBruto',
      'importe_factura', 'Importe_Factura', // ← shape real del API
      'monto', 'amount',
    ]),
  );
  const importePendientePesos = toNum(
    pick(raw, [
      'importePendientePesos', 'importe_pendiente_pesos', 'importePendiente',
      'importe_pendiente', 'Importe_Pendiente', // ← shape real del API
      'saldoPendiente', 'saldo_pendiente',
    ]),
  );

  // ── Fechas ──
  // El API devuelve ISO con time ("2025-05-12T00:00:00"). Recortamos a
  // YYYY-MM-DD porque el resto del app trabaja con day-precision y
  // appendear "T12:00:00Z" sobre una cadena que YA tiene una T producía
  // un Date inválido (NaN) que rompía ventanas de fecha en el motor de
  // cruce.
  const trimDate = (v: unknown): string => {
    const s = toStr(v);
    if (!s) return '';
    return s.length >= 10 ? s.slice(0, 10) : s;
  };
  const fechaFactura = trimDate(pick(raw, ['fechaFactura', 'fecha_factura', 'Fecha_Factura', 'fechaEmision', 'fecha_emision']));
  const fechaVence = trimDate(pick(raw, ['fechaVence', 'fecha_vence', 'fechaVencimiento', 'fecha_vencimiento', 'Fecha_Vencimiento', 'dueDate']));
  // Fecha de pago efectiva — JDE la llama Fecha_Pago. Para nosotros es el
  // ancla de cruce más tight (±5 días) cuando la factura ya está cobrada.
  const fechaCobro = trimDate(pick(raw, [
    'fechaCobro', 'fecha_cobro',
    'fecha_pago', 'Fecha_Pago', // ← shape real del API
    'fechaProgramacionCobro', 'fechaProgCobro', 'fechaCobrado',
  ]));

  // ── Días vencida ──
  // El API regresa `Dias_Fecha_Vencimiento_vs_Fecha_Pago` solo cuando la
  // factura ya fue cobrada (=positivo si se pagó tarde). Para facturas
  // pendientes ese campo es null y debemos computar `today − fechaVence`
  // localmente para que el aging por buckets funcione.
  const diasVencidaApi = toNum(
    pick(raw, [
      'diasVencida', 'dias_vencida', 'diasVencido', 'dias_vencido',
      'dias_fecha_vencimiento_vs_fecha_pago', 'Dias_Fecha_Vencimiento_vs_Fecha_Pago',
    ]),
  );
  let diasVencida = diasVencidaApi;
  if (importePendientePesos > 0 && fechaVence) {
    // factura pendiente: días vencida = hoy − fechaVencimiento
    const hoy = new Date();
    const venc = new Date(fechaVence);
    if (!Number.isNaN(venc.getTime())) {
      const ms = hoy.getTime() - venc.getTime();
      diasVencida = Math.max(0, Math.round(ms / 86_400_000));
    }
  } else if (importePendientePesos === 0 && diasVencidaApi <= 0) {
    // factura cobrada a tiempo: el campo del API es 0 o negativo, dejarlo así.
    diasVencida = diasVencidaApi;
  }

  // ── Estatus derivado ──
  const estatusApi = toStr(pick(raw, ['estatus', 'estado', 'edoCobro', 'edo_cobro', 'status']));
  const estatus = estatusApi
    || (importePendientePesos > 0
      ? 'PENDIENTE'
      : fechaCobro
        ? 'COBRADA'
        : 'CANCELADA');

  // ── Moneda ── el API actual no la devuelve; default MXN.
  const moneda = toStr(pick(raw, ['moneda', 'currency'])) || 'MXN';

  // ── Condición de pago ──
  // El API la trae como "Dias_Credito" (string con padding tipo "30 ").
  // toStr ya hace trim. Si no viene, dejamos vacío.
  const condPago = toStr(pick(raw, ['condPago', 'cond_pago', 'condicionPago', 'dias_credito', 'Dias_Credito']));

  return {
    cia:                     normalizeCia(pick(raw, ['cia', 'compania', 'company', 'Cia'])),
    noCliente:               toStr(pick(raw, ['noCliente', 'no_cliente', 'No_Cliente', 'noCte', 'cliente', 'customerNo', 'customer'])),
    nombreCliente:           toStr(pick(raw, ['nombreCliente', 'nombre_cliente', 'Nombre_Cliente', 'nombre', 'razonSocial', 'razon_social', 'customerName'])),
    noFactura:               toStr(pick(raw, ['noFactura', 'no_factura', 'factura', 'Factura', 'invoice', 'invoiceNo'])),
    fechaFactura,
    fechaVence,
    fechaCobro,
    diasVencida,
    importeBrutoPesos,
    importePendientePesos,
    importeBrutoDolares:     toNum(pick(raw, ['importeBrutoDolares', 'importe_bruto_dolares'])),
    importePendienteDolares: toNum(pick(raw, ['importePendienteDolares', 'importe_pendiente_dolares'])),
    moneda,
    condPago,
    estatus,
    tipoCambio:              toNum(pick(raw, ['tipoCambio', 'tipo_cambio', 'tc'])),
    // INTENCIONALMENTE NO persistimos `raw` aquí: con 10k+ facturas y ~30
    // campos cada una, el JSON.stringify del store excedía el quota de
    // 5 MB de localStorage y la app crasheaba al intentar guardar. Si se
    // necesita inspeccionar el raw para debug, se puede activar bajo flag
    // dev (env VITE_COBRANZA_KEEP_RAW=1) o leerlo desde el log
    // `[cobranza] sample raw record` en la consola.
  };
}

/**
 * POST /v1/erp/tesoreria/cobranza
 *
 * Retorna las facturas de cobranza (CXC) abiertas/históricas para la
 * compañía indicada en el rango de fechas dado.
 *
 * Body de ejemplo:
 *   { "cia": "00011,", "fechaInicial": "2024-01-01", "fechaFinal": "2026-04-29" }
 *
 * IMPORTANTE — coma trailing en `cia`:
 *   El equipo JDE compartió el body con la cia terminando en coma. No es
 *   un typo: replicamos exactamente ese formato porque al menos un usuario
 *   reportó respuesta vacía cuando se enviaba "00011" sin coma. Por
 *   seguridad, si el caller manda la cia sin coma, se la agregamos aquí.
 *
 * IMPORTANTE — `fechaInicial` no puede ser `null`:
 *   Aunque el body de ejemplo que compartió el equipo JDE el 2026-05-01
 *   incluía `"fechaInicial": null`, ese formato regresa SIEMPRE `data: []`
 *   (validado contra api.gruposenda.com el 2026-05-03 sobre las 29 cías
 *   del catálogo). Hay que mandar una fecha ISO `YYYY-MM-DD`. El caller
 *   en App.tsx ya pasa `hoy - 365 días` y eso es lo que la app usa hoy.
 *   Si en el futuro el equipo libera el modo "histórico completo", revisar
 *   este comentario.
 *
 * Notas:
 *   • Como /antiguedadsaldos, una compañía por request. Para múltiples
 *     compañías llamar en serie y mergear.
 *   • El token productivo lo inyecta server-side la Vercel Function
 *     (api/jde/[...path].ts) leyendo `JDE_TOKEN`. En dev local, usa
 *     `VITE_JDE_TOKEN`.
 */
export async function fetchCobranza(
  req: CobranzaRequest,
  config: JdeClientConfig = {},
): Promise<CobranzaRecord[]> {
  // Forzar la coma trailing en cia para mimetizar exactamente el body que
  // JDE compartió. El normalizer del response (`normalizeCia`) ya extrae
  // dígitos sin importar puntuación, así que no contamina los registros
  // mapeados.
  const ciaWithComma = req.cia.endsWith(',') ? req.cia : `${req.cia},`;
  const body: CobranzaRequest = { ...req, cia: ciaWithComma };

  const raw = await jdeClient.post<unknown>('/cobranza', body, config);
  const list = unwrapList(raw);

  // Log de diagnóstico — la primera vez que esta función responde con N
  // registros, mostramos el primero en la consola para que el equipo pueda
  // validar el shape contra el mapper. No es ruido permanente: solo se
  // imprime una vez por sesión gracias al flag global.
  if (typeof window !== 'undefined' && !cobranzaShapeLogged) {
    cobranzaShapeLogged = true;
    // eslint-disable-next-line no-console
    console.info(
      `[cobranza] ${list.length} registros para cia=${ciaWithComma} entre ${req.fechaInicial ?? '∞'} y ${req.fechaFinal}`,
    );
    if (list.length > 0) {
      // eslint-disable-next-line no-console
      console.info('[cobranza] sample raw record:', list[0]);
      // eslint-disable-next-line no-console
      console.info('[cobranza] sample mapped record:', mapCobranza(list[0]));
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[cobranza] respuesta VACÍA. Posibles causas: (1) sin permisos del token para esta cia, (2) sin facturas en el rango, (3) body no aceptado por JDE.',
      );
    }
  }

  return list.map(mapCobranza);
}

// Flag para que el log de shape solo aparezca una vez por sesión.
let cobranzaShapeLogged = false;

// Re-exports convenientes
export type {
  AgedBalanceRecord,
  AgedBalanceRequest,
  BankAccountStatement,
  BankStatementLine,
  BankStatementRequest,
  BankStatementFormat,
  BankMovementType,
  CobranzaRecord,
  CobranzaRequest,
  Company,
} from './jdeTypes';
export { JdeApiError } from './jdeTypes';
