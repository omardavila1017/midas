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
