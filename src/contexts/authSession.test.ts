import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SESSION_KEY,
  clearAuthSession,
  needsLogin,
  readAuthSession,
  resolveSessionEmail,
  writeAuthSession,
} from './authSession';

describe('authSession', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('pide login cuando no hay sesión guardada', () => {
    expect(needsLogin()).toBe(true);
    expect(resolveSessionEmail()).toBeNull();
  });

  it('con "Recordar este equipo" persiste en localStorage y auto-entra', () => {
    writeAuthSession('Ana@Senda.com', true);

    // Recordada → vive en localStorage (sobrevive cerrar el navegador).
    expect(localStorage.getItem(AUTH_SESSION_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull();

    expect(needsLogin()).toBe(false);
    expect(resolveSessionEmail()).toBe('ana@senda.com'); // normalizado
    expect(readAuthSession()?.remember).toBe(true);
  });

  it('sin recordar vive solo en sessionStorage (no auto-entra tras cerrar navegador)', () => {
    writeAuthSession('beto@senda.com', false);

    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).not.toBeNull();
    expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();

    // Dentro de la misma sesión sí entra...
    expect(needsLogin()).toBe(false);

    // ...pero al cerrar el navegador (sessionStorage se vacía) vuelve a login.
    sessionStorage.clear();
    expect(needsLogin()).toBe(true);
  });

  it('cambiar de "recordar" a "no recordar" no deja rastro en el otro almacén', () => {
    writeAuthSession('ana@senda.com', true);
    writeAuthSession('ana@senda.com', false);
    expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).not.toBeNull();
  });

  it('clearAuthSession (logout) borra ambos almacenes y vuelve a pedir login', () => {
    writeAuthSession('ana@senda.com', true);
    clearAuthSession();
    expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
    expect(needsLogin()).toBe(true);
  });
});
