/**
 * Hash de contraseñas SHA-256 en el CLIENTE (Web Crypto API).
 *
 * Contrato con el backend `WS/midas/usuarios` (ver documentación de la entrega
 * de Usuarios/Seguridad):
 *   - El cliente hashea la contraseña en ALTA, MODIFICACIÓN y VALIDACIÓN.
 *   - Se envía el hash en hexadecimal MINÚSCULAS; el backend lo guarda y lo
 *     compara tal cual (no re-hashea).
 *   - La contraseña en claro NUNCA viaja por la red ni se persiste.
 *
 * Nota: esto NO es una frontera de seguridad por sí solo (SHA-256 sin sal por
 * usuario es débil ante rainbow tables); es el contrato acordado con el backend.
 * La autorización vinculante y el almacenamiento seguro los hace el servidor.
 *
 * `SHA-256("Senda123")` = `ef7b600a…` (contraseña inicial de la migración).
 */

/**
 * SHA-256 de `input`, en hexadecimal minúsculas. Usa `crypto.subtle` (disponible
 * en navegadores y en el entorno de test jsdom/node).
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash de una contraseña para el contrato de `WS/midas/usuarios`. Alias legible
 * de `sha256Hex` en los call sites de credenciales (alta/cambio/validación).
 */
export function hashPassword(password: string): Promise<string> {
  return sha256Hex(password);
}
