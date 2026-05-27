/**
 * Heurística para distinguir nombre de PERSONA física vs RAZÓN SOCIAL.
 *
 * Usado en dos lugares:
 *   1. AppCore: auto-clasifica clientes `auto-*` con nombre persona al grupo
 *      Viajes Especiales (matcher comercial).
 *   2. canonicalProjection: cuando un ABONO bancario está cobranza-matched
 *      con un cliente cuyo nombre es persona, lo enruta a Viajes Especiales
 *      aunque la cuenta sea unidadNegocio=FEDERAL — protege contra clientes
 *      auto-creados pero aún no promovidos al grupo del catálogo.
 *
 * Reglas (Santiago, 2026-05-12 v3):
 *   - Persona física: 2-6 tokens (sin contar partículas), sin marcadores SA/CV/INC
 *     ni dígitos. Trato como viajero ad-hoc.
 *   - Empresa: cualquier marcador de razón social, dígitos en el nombre, o
 *     fuera del rango 2-6 tokens.
 */

const COMPANY_MARKERS = new Set([
  // Razón social
  'SA', 'SAB', 'SAPI', 'SC', 'AC', 'RL', 'SRL', 'SADECV', 'CV',
  'COMPANIA', 'COMPANY', 'CORP', 'CORPORATION', 'CO',
  'INC', 'LLC', 'GMBH', 'LTD', 'LIMITED', 'BV', 'NV',
  // Tipos de negocio
  'GRUPO', 'INDUSTRIAS', 'INDUSTRIA', 'INDUSTRIAL',
  'SERVICIOS', 'SERVICIO', 'CONSTRUCTORA', 'COMERCIALIZADORA',
  'TRANSPORTES', 'AUTOTRANSPORTES', 'INMOBILIARIA', 'INMUEBLES',
  'DISTRIBUIDORA', 'DISTRIBUCION', 'SOLUCIONES', 'TECNOLOGIA', 'TECHNOLOGIES',
  'SISTEMAS', 'CONSULTORES', 'CONSULTORIA', 'INTERNACIONAL',
  'NACIONAL', 'MEXICANA', 'PRODUCTOS', 'OPERADORA', 'MANUFACTURAS',
  'COMERCIAL', 'EMPRESA', 'CORPORATIVO', 'AGROPECUARIA',
  'AUTOMOTRIZ', 'FERRETERA', 'HOTELERA', 'TURISTICA',
  'BANCO', 'BANCARIA', 'FINANCIERA', 'ASEGURADORA',
  // Industria viajes / transporte
  'VIAJES', 'AGENCIA', 'TURISMO', 'TOURS', 'TRAVEL',
  'BUS', 'BUSES', 'AUTOBUSES', 'AUTOBUS', 'TRANSPORTE',
  'FERROCARRIL', 'AEROLINEA', 'AEROPUERTO', 'PUERTO', 'TERMINAL',
  // Gobierno / instituciones
  'MUNICIPIO', 'GOBIERNO', 'AYUNTAMIENTO', 'SECRETARIA',
  'INSTITUTO', 'UNIVERSIDAD', 'ESCUELA', 'COLEGIO',
  'HOSPITAL', 'CLINICA', 'FUNDACION', 'ASOCIACION', 'PARTIDO',
  'COMISION', 'CONSEJO', 'DIRECCION',
  // Comercio
  'CADENA', 'COMERCIO', 'TIENDA', 'TIENDAS', 'CENTRAL', 'CENTRO',
  'CLUB', 'COOPERATIVA', 'PROMOTORA', 'CONSORCIO', 'HOLDING',
  'EDITORIAL', 'IMPRENTA', 'FABRICA', 'PLANTA',
  'SUPERMERCADOS', 'SUPERMERCADO', 'ALMACEN', 'ALMACENES',
  // Sufijos / términos genéricos de marca
  'SOLUTIONS', 'NETWORKS', 'NETWORK', 'SYSTEMS', 'GROUP',
  'INTERNACIONALES', 'NACIONALES', 'MEXICANO', 'MEXICANOS',
  'MEXICO', 'AMERICA', 'AMERICANA', 'AMERICAS', 'LATAM',
  'DESARROLLO', 'DESARROLLOS', 'PROYECTOS', 'PROYECTO',
  'GLOBAL', 'WORLD', 'WORLDWIDE', 'INTERAMERICANA',
  // Concepto bancario que no es persona aunque tenga estructura corta
  'LIQUIDACIONES', 'LIQUIDACION', 'PAGO', 'PAGOS', 'COBRO', 'COBROS',
  'DEPOSITO', 'DEPOSITOS', 'TRANSFERENCIA', 'TRASPASO',
]);

const PERSON_PARTICLES = new Set([
  'DE', 'DEL', 'LA', 'LOS', 'LAS', 'Y', 'VAN', 'DER', 'VON', 'MAC', 'MC', 'EL',
]);

export function normalizeNameUpper(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\b([A-Z])\.\s*([A-Z])\.\s*([A-Z])\.\b/g, '$1$2$3')
    .replace(/\b([A-Z])\.\s*([A-Z])\.\b/g, '$1$2')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCompanyName(rawName: string | undefined): boolean {
  if (!rawName) return false;
  const norm = normalizeNameUpper(rawName);
  if (!norm) return false;
  if (/\d/.test(norm)) return true;
  for (const t of norm.split(' ')) {
    if (COMPANY_MARKERS.has(t)) return true;
  }
  return false;
}

export function isPersonName(rawName: string | undefined): boolean {
  if (!rawName) return false;
  if (isCompanyName(rawName)) return false;
  const norm = normalizeNameUpper(rawName);
  if (!norm) return false;
  const tokens = norm.split(' ').filter(t => !PERSON_PARTICLES.has(t) && t.length >= 2);
  return tokens.length >= 2 && tokens.length <= 6;
}
