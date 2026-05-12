import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

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

  // Bundle analyzer only when ANALYZE=1. Writes dist/stats.html with a
  // treemap of chunk content + duplicate-module detection.
  const analyze = env.ANALYZE === '1' || process.env.ANALYZE === '1'

  return {
    plugins: [
      react(),
      ...(analyze
        ? [
            visualizer({
              filename: 'dist/stats.html',
              template: 'treemap',
              gzipSize: true,
              brotliSize: true,
            }),
          ]
        : []),
    ],
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
          // Stripear headers que el browser agrega y que pueden activar reglas
          // de WAF / CORS en AWS API Gateway. curl no los manda y funciona;
          // el browser sí los manda y endpoints nuevos (cobranzaindicadores)
          // responden 500. Replicamos el comportamiento de curl.
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.removeHeader('origin')
              proxyReq.removeHeader('referer')
              proxyReq.removeHeader('sec-fetch-dest')
              proxyReq.removeHeader('sec-fetch-mode')
              proxyReq.removeHeader('sec-fetch-site')
              proxyReq.removeHeader('sec-ch-ua')
              proxyReq.removeHeader('sec-ch-ua-mobile')
              proxyReq.removeHeader('sec-ch-ua-platform')
              proxyReq.removeHeader('cookie')
              // Forzar respuesta sin compresión. Cuando el browser pide
              // gzip/br/zstd, AWS API Gateway ocasionalmente devuelve
              // InternalServerErrorException al comprimir respuestas grandes
              // (~1MB en cobranzaindicadores). curl funciona porque no pide
              // compresión por default — replicamos ese comportamiento.
              proxyReq.setHeader('accept-encoding', 'identity')
            })
          },
        },
      },
    },
    build: {
      // Las dependencias de charts e icons pesan ~350 KB juntas y rara vez
      // cambian. Separarlas a chunks propios acelera el arranque de sesiones
      // nuevas porque el browser puede cachearlos entre deploys del app core.
      //
      // Function form (no string-array): el array previo dejaba a recharts
      // arrastrar react-dom dentro de `vendor-charts` (~133KB de react-dom
      // viajaban en el chunk de charts). Aquí evaluamos react/react-dom
      // PRIMERO para garantizar que terminen en `vendor-react`.
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('/react-dom/') || id.includes('/react/') ||
                id.includes('/scheduler/')) {
              return 'vendor-react'
            }
            if (id.includes('/recharts/') || id.includes('/d3-') ||
                id.includes('/victory-vendor/') || id.includes('/decimal.js-light/')) {
              return 'vendor-charts'
            }
            if (id.includes('/lucide-react/')) return 'vendor-icons'
          },
        },
      },
    },
  }
})
