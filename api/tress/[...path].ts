/**
 * Vercel Serverless Function — proxy TRESS (Nómina).
 *
 * Namespace paralelo al de Tesorería (api/jde/[...path].ts). Mismo token
 * server-side `JDE_TOKEN`, distinto upstream:
 *     /v1/erp/tress/nomina  → POST con { idEmpresa, tipoNomina, anio, mes }
 *
 * Variables de entorno en Vercel:
 *   JDE_TOKEN        — Bearer credential (compartido con el namespace JDE)
 *   TRESS_UPSTREAM   — base URL (default: api.gruposenda.com/v1/erp/tress)
 */

import { createJdeProxy, proxyConfig } from '../_lib/jdeProxy';

export default createJdeProxy({
  upstreamEnvVar: 'TRESS_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/v1/erp/tress',
  label: 'tress',
});

export const config = proxyConfig;
