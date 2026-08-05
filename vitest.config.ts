import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // La app sirve únicamente America/Mexico_City (ver formatters.todayISO).
    // Sin fijar TZ, los tests corren en la zona de la máquina (UTC en CI) y
    // los bugs de parseo UTC-midnight de fechas ISO pasan invisibles — p.ej.
    // el corrimiento de un día en prorateMinimumExpense sólo reproducía en
    // zonas UTC-negativas. Fijarla hace los tests deterministas y fieles al
    // entorno real del usuario.
    // El modo ONLINE de usuarios (WS/midas) es el default en producción
    // (`VITE_MIDAS_USERS_ENABLED` ausente → true). En tests lo apagamos para que
    // la suite existente corra en el modo local/backend previo; las pruebas del
    // modo online lo prenden por-test con `__setMidasUsersEnabledForTests(true)`.
    env: { TZ: 'America/Mexico_City', VITE_MIDAS_USERS_ENABLED: 'false' },
    // Node 26 expone un `localStorage` global propio que devuelve `undefined`
    // sin `--localstorage-file` y TAPA el de jsdom → 333 tests caían con
    // "Cannot read properties of undefined (reading 'clear')" por la versión de
    // Node, no por el código. `setup.ts` instala una Storage en memoria sólo si
    // la presente no sirve. Ver el docblock de src/test/setup.ts.
    setupFiles: ['./src/test/setup.ts'],
    exclude: [...configDefaults.exclude, '.claude/**', 'tests-e2e/**', '**/tests-e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**', 'api/**'],
      exclude: [
        'scripts/**',
        '**/mock-data/**',
        '**/*.d.ts',
        '**/*.test.*',
      ],
    },
  },
});
