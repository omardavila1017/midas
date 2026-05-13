/**
 * Vercel Serverless Function — proxy JDE Tesorería.
 *
 * Por qué existe:
 *   El frontend NO debe llevar el Bearer del JDE en su bundle. Si lo lleva
 *   (con el prefijo `VITE_`), Vite lo "inlinea" en JavaScript público y
 *   cualquier visitante puede extraerlo desde DevTools y golpear directo a
 *   api.gruposenda.com con privilegios de tesorería.
 *
 *   Esta function corre en Vercel (entorno server-side) y:
 *     1. Lee el token desde `JDE_TOKEN` (env var SIN prefijo VITE_).
 *     2. Reescribe la ruta /api/jde/<path> → <JDE_UPSTREAM>/<path>.
 *     3. Inyecta el header Authorization: Bearer <JDE_TOKEN> hacia el upstream.
 *     4. Reenvía cuerpo, status y JSON al cliente.
 *
 *   La lógica concreta vive en api/_lib/jdeProxy.ts — esta función solo
 *   declara el namespace upstream (Tesorería). El proxy paralelo para el
 *   namespace TRESS está en api/tress/[...path].ts.
 *
 * Variables de entorno requeridas en Vercel:
 *   JDE_TOKEN        — Bearer credential (server-side, sin VITE_)
 *   JDE_UPSTREAM     — base URL (default: api.gruposenda.com/v1/erp/tesoreria)
 */

import { createJdeProxy, proxyConfig } from '../_lib/jdeProxy';

export default createJdeProxy({
  upstreamEnvVar: 'JDE_UPSTREAM',
  defaultUpstream: 'https://api.gruposenda.com/v1/erp/tesoreria',
  label: 'jde',
});

export const config = proxyConfig;
