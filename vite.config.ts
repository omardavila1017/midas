import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

// Proxies de desarrollo para los APIs de JDE / TRESS.
// El browser llama a /api/jde/... y /api/tress/... y Vite reescribe hacia el
// host productivo (evita CORS en dev). Configurable vía VITE_JDE_UPSTREAM y
// VITE_TRESS_UPSTREAM.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Parsea un upstream URL → { origin, pathname } para reescribir el prefix
  // del proxy (`/api/<ns>`) hacia el path del host productivo. Si no es URL
  // absoluta, fallback al string completo como origin (uso dev local).
  function parseUpstream(raw: string): { origin: string; path: string } {
    try {
      const u = new URL(raw)
      return { origin: u.origin, path: u.pathname.replace(/\/+$/, '') }
    } catch {
      return { origin: raw, path: '' }
    }
  }

  // Header stripping y `accept-encoding: identity` son comunes a ambos
  // namespaces: AWS API Gateway responde 500 con compresión >1MB y los
  // headers que el browser auto-agrega pueden tirar reglas de WAF. Replicamos
  // el comportamiento de curl en ambos proxies.
  function configureProxy(proxy: { on(event: string, cb: (req: any) => void): void }) {
    proxy.on('proxyReq', (proxyReq: any) => {
      proxyReq.removeHeader('origin')
      proxyReq.removeHeader('referer')
      proxyReq.removeHeader('sec-fetch-dest')
      proxyReq.removeHeader('sec-fetch-mode')
      proxyReq.removeHeader('sec-fetch-site')
      proxyReq.removeHeader('sec-ch-ua')
      proxyReq.removeHeader('sec-ch-ua-mobile')
      proxyReq.removeHeader('sec-ch-ua-platform')
      proxyReq.removeHeader('cookie')
      proxyReq.setHeader('accept-encoding', 'identity')
    })
  }

  const jdeUp = parseUpstream(env.VITE_JDE_UPSTREAM || 'https://api.gruposenda.com/v1/erp/tesoreria')
  const tressUp = parseUpstream(env.VITE_TRESS_UPSTREAM || 'https://api.gruposenda.com/v1/erp/tress')

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
          target: jdeUp.origin,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/jde/, jdeUp.path),
          configure: configureProxy,
        },
        '/api/tress': {
          target: tressUp.origin,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/tress/, tressUp.path),
          configure: configureProxy,
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
