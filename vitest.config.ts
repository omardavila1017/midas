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
    env: { TZ: 'America/Mexico_City' },
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
