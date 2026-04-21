import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Proxy de desarrollo para los APIs de JDE / Tesorería.
// El browser llama a /api/jde/... y Vite reescribe hacia el host productivo
// https://api.gruposenda.com/v1/erp/tesoreria/... (evita CORS en dev).
// Configurable vía VITE_JDE_UPSTREAM.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const jdeUpstream = env.VITE_JDE_UPSTREAM || 'https://api.gruposenda.com/v1/erp/tesoreria'

  // Extraemos el pathname del upstream para reescribir el prefix /api/jde
  // hacia la ruta correcta del host productivo (ej. /v1/erp/tesoreria).
  let upstreamOrigin = jdeUpstream
  let upstreamPath = ''
  try {
    const u = new URL(jdeUpstream)
    upstreamOrigin = u.origin
    upstreamPath = u.pathname.replace(/\/+$/, '')
  } catch {
    // Si no es una URL absoluta, dejamos el string tal cual (fallback dev local).
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        '/api/jde': {
          target: upstreamOrigin,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/jde/, upstreamPath),
        },
      },
    },
  }
})
