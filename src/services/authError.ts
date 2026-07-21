/**
 * Error tipado del cliente de autenticación.
 *
 * Vive en su propio módulo (separado de `authApi.ts`) para que tanto el cliente
 * de backend (`authApi.ts`) como el modo local (`localAuth.ts`) puedan lanzarlo
 * sin crear un ciclo de imports en runtime. `authApi.ts` lo re-exporta, así que
 * los consumidores existentes (`Login.tsx`, `ChangePasswordModal.tsx`, …) siguen
 * importando `AuthApiError` desde `../services/authApi` sin cambios.
 */

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'forbidden'
  | 'password_expired'
  | 'rate_limited'
  | 'invalid_token'
  // Usuario registrado que aún no define su contraseña (primer ingreso /
  // "register"): la UI debe mandarlo a definirla en vez de tratarlo como error.
  | 'password_setup_required'
  // Administración de usuarios (API `WS/midas/usuarios`): usuario inexistente
  // (404) y alta duplicada (406). Ver el mapeo de errores en `usuariosApi.ts`.
  | 'not_found'
  | 'duplicate'
  | 'validation'
  | 'network'
  | 'unknown';

export class AuthApiError extends Error {
  code: AuthErrorCode;
  status: number;

  constructor(code: AuthErrorCode, message: string, status: number = 0) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.status = status;
  }
}
