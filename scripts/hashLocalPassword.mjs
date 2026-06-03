#!/usr/bin/env node
/**
 * Genera el hash de una contraseña para `src/config/authLocalUsers.json`.
 *
 * Uso:
 *   node scripts/hashLocalPassword.mjs <password> [salt]
 *
 * El salt por defecto es el del JSON ("midas.local.auth.v1"). El hash es
 * SHA-256(`${salt}:${password}`) en hex — el mismo algoritmo que
 * `hashLocalPassword` en `src/services/localAuth.ts`.
 *
 * Recordatorio: el modo local NO es seguridad (el bundle es público). Esto solo
 * evita dejar la contraseña en texto plano en el repo.
 */
import { createHash } from 'node:crypto';

const password = process.argv[2];
const salt = process.argv[3] ?? 'midas.local.auth.v1';

if (!password) {
  console.error('Uso: node scripts/hashLocalPassword.mjs <password> [salt]');
  process.exit(1);
}

const hash = createHash('sha256').update(`${salt}:${password}`).digest('hex');
console.log(hash);
