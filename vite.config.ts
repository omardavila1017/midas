import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'
import { resolveVersion } from './scripts/resolveVersion.mjs'

function lucideIconPath(iconName: string): string {
  const fileName = iconName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .replace(/([0-9])([A-Za-z])/g, '$1-$2')
    .toLowerCase()
  return `lucide-react/dist/esm/icons/${fileName}`
}

function lucideDeepImportPlugin({ types: t }: { types: any }) {
  return {
    name: 'lucide-react-deep-imports',
    visitor: {
      ImportDeclaration(path: any) {
        if (path.node.source.value !== 'lucide-react') return
        if (path.node.importKind === 'type') return

        const valueSpecifiers = path.node.specifiers.filter(
          (specifier: any) => t.isImportSpecifier(specifier) && specifier.importKind !== 'type',
        )
        if (valueSpecifiers.length === 0) return

        const passthroughSpecifiers = path.node.specifiers.filter(
          (specifier: any) => !valueSpecifiers.includes(specifier),
        )
        const replacement = valueSpecifiers.map((specifier: any) => {
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value
          return t.importDeclaration(
            [t.importDefaultSpecifier(t.identifier(specifier.local.name))],
            t.stringLiteral(lucideIconPath(imported)),
          )
        })

        if (passthroughSpecifiers.length > 0) {
          replacement.unshift(
            t.importDeclaration(
              passthroughSpecifiers.map((specifier: any) => t.cloneNode(specifier)),
              t.stringLiteral('lucide-react'),
            ),
          )
        }

        path.replaceWithMultiple(replacement)
      },
    },
  }
}

// Proxies de desarrollo para APIs externas. El browser llama a /api/* y Vite
// reescribe hacia el upstream, inyectando credenciales desde env local para
// que el cliente no mande Bearer headers.
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
  function configureProxy(
    proxy: { on(event: string, cb: (req: any) => void): void },
    options: { token?: string; extraHeaders?: Record<string, string> } = {},
  ) {
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
      if (options.token) proxyReq.setHeader('authorization', `Bearer ${options.token}`)
      for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
        proxyReq.setHeader(key, value)
      }
    })
  }

  const jdeUp = parseUpstream(env.VITE_JDE_UPSTREAM || 'https://appqa.gruposenda.com/WS/jde/JDEdwards')
  const tressUp = parseUpstream(env.VITE_TRESS_UPSTREAM || 'https://appqa.gruposenda.com/WS/tress/TRESS')
  const openaiUp = parseUpstream(env.OPENAI_UPSTREAM || 'https://api.openai.com/v1')
  // Diagnóstico temprano MIDAS AI: sin OPENAI_API_KEY el proxy responde 401
  // upstream; un OPENAI_UPSTREAM de api.openai.com SIN /v1 responde 404
  // "Invalid URL". Avisar al arrancar evita perseguir el error en el chat.
  if (!env.OPENAI_API_KEY) {
    console.warn('[vite] OPENAI_API_KEY no está en el entorno — /api/openai (MIDAS AI) responderá 401. Agrégala a .env.local.')
  }
  if (openaiUp.origin.includes('api.openai.com') && openaiUp.path === '') {
    console.warn(`[vite] OPENAI_UPSTREAM (${env.OPENAI_UPSTREAM}) no incluye /v1 — OpenAI responderá 404 "Invalid URL". Usa https://api.openai.com/v1.`)
  }
  const jdeToken = env.JDE_TOKEN || env.VITE_JDE_TOKEN
  // CITI: upstream QA https://appqa.gruposenda.com/WS/citi. En prod el proxy
  // server-side (nginx/cloudflare o la función serverless) reescribe /api/citi.
  const citiUp = parseUpstream(env.VITE_CITI_UPSTREAM || env.CITI_UPSTREAM || 'https://appqa.gruposenda.com/WS/citi/CITI')
  const citiToken = env.CITI_TOKEN || jdeToken || env.VITE_CITI_TOKEN
  // Viajes Especiales (SENTUR) — upstream QA
  // https://appqa.gruposenda.com/WS/sentur/ViajesEspeciales. Comparte token JDE
  // (mismo backend Senda). Ajustar VITE_VIAJES_ESPECIALES_UPSTREAM para apuntar
  // a otro entorno (p.ej. productivo) cuando se publique.
  const viajesEspUp = parseUpstream(env.VITE_VIAJES_ESPECIALES_UPSTREAM || env.VIAJES_ESPECIALES_UPSTREAM || 'https://appqa.gruposenda.com/WS/sentur/ViajesEspeciales')
  const viajesEspToken = env.VIAJES_ESPECIALES_TOKEN || jdeToken || env.VITE_VIAJES_ESPECIALES_TOKEN
  // Usuarios/Seguridad ONLINE (WS/midas). El browser llama `/api/midas/usuarios`;
  // aquí inyectamos el Bearer (MIDAS_TOKEN con fallback JDE_TOKEN). Upstream QA
  // por defecto; ajustar MIDAS_UPSTREAM para producción.
  const midasUp = parseUpstream(env.MIDAS_UPSTREAM || env.VITE_MIDAS_UPSTREAM || 'https://appqa.gruposenda.com/WS/midas')
  const midasToken = env.MIDAS_TOKEN || jdeToken || env.VITE_MIDAS_TOKEN
  // Shared server-side store (Omar Dávila's deployment). Sin STORE_UPSTREAM no
  // se registra el proxy `/api/store` (target vacío rompería la config de Vite);
  // en ese caso remoteStore queda OFF y la app corre solo con localStorage/IDB.
  const storeUp = parseUpstream(env.VITE_STORE_UPSTREAM || env.STORE_UPSTREAM || '')
  const storeToken = env.STORE_TOKEN || jdeToken || env.VITE_STORE_TOKEN

  // Bundle analyzer only when ANALYZE=1. Writes dist/stats.html with a
  // treemap of chunk content + duplicate-module detection.
  const analyze = env.ANALYZE === '1' || process.env.ANALYZE === '1'

  return {
    // Versión automática del login (MAJOR.MINOR.<#PRs> desde git). Ver
    // scripts/resolveVersion.mjs. En tests (vitest) no se define → 'dev'.
    define: {
      __APP_VERSION__: JSON.stringify(resolveVersion()),
    },
    plugins: [
      react({
        babel: {
          plugins: [lucideDeepImportPlugin],
        },
      }),
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
    base: '/midas/',
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
          secure: false,
          rewrite: (p) => p.replace(/^\/api\/jde/, jdeUp.path),
          configure: (proxy) => configureProxy(proxy, { token: jdeToken }),
        },
        '/api/tress': {
          target: tressUp.origin,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/tress/, tressUp.path),
          configure: (proxy) => configureProxy(proxy, { token: jdeToken }),
        },
        '/api/openai': {
          target: openaiUp.origin,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/openai/, openaiUp.path),
          configure: (proxy) => configureProxy(proxy, { token: env.OPENAI_API_KEY }),
        },
        '/api/citi': {
          target: citiUp.origin,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api\/citi/, citiUp.path),
          configure: (proxy) => configureProxy(proxy, { token: citiToken }),
        },
        '/api/viajes-especiales': {
          target: viajesEspUp.origin,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api\/viajes-especiales/, viajesEspUp.path),
          configure: (proxy) => configureProxy(proxy, { token: viajesEspToken }),
        },
        '/api/midas': {
          target: midasUp.origin,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api\/midas/, midasUp.path),
          configure: (proxy) => configureProxy(proxy, { token: midasToken }),
        },
        ...(storeUp.origin
          ? {
              '/api/store': {
                target: storeUp.origin,
                changeOrigin: true,
                secure: false,
                rewrite: (p: string) => p.replace(/^\/api\/store/, storeUp.path),
                configure: (proxy: any) => configureProxy(proxy, { token: storeToken }),
              },
            }
          : {}),
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
      worker: {
        format: 'es',
      },
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
