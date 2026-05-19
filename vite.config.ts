import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

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

  const jdeUp = parseUpstream(env.VITE_JDE_UPSTREAM || 'https://api.gruposenda.com/JDEdwards')
  const tressUp = parseUpstream(env.VITE_TRESS_UPSTREAM || 'https://api.gruposenda.com/v1/erp/tress')
  const cognosUp = parseUpstream(env.VITE_COGNOS_UPSTREAM || env.COGNOS_UPSTREAM || '')
  const openaiUp = parseUpstream(env.OPENAI_UPSTREAM || 'https://api.openai.com/v1')
  const jdeToken = env.JDE_TOKEN || env.VITE_JDE_TOKEN
  const cognosToken = env.COGNOS_TOKEN || env.VITE_COGNOS_TOKEN
  // CITI: red interna srv-desarrollo:92/CITI. En prod requiere proxy server-side
  // (nginx/cloudflare) que reescriba /api/citi → http://srv-desarrollo:92/CITI.
  const citiUp = parseUpstream(env.VITE_CITI_UPSTREAM || env.CITI_UPSTREAM || 'http://srv-desarrollo:92/CITI')
  const citiToken = env.CITI_TOKEN || jdeToken || env.VITE_CITI_TOKEN

  // Bundle analyzer only when ANALYZE=1. Writes dist/stats.html with a
  // treemap of chunk content + duplicate-module detection.
  const analyze = env.ANALYZE === '1' || process.env.ANALYZE === '1'

  return {
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
        ...(cognosUp.origin
          ? {
              '/api/cognos': {
                target: cognosUp.origin,
                changeOrigin: true,
                secure: true,
                rewrite: (p: string) => p.replace(/^\/api\/cognos/, cognosUp.path),
                configure: (proxy: { on(event: string, cb: (req: any) => void): void }) => configureProxy(proxy, {
                  token: cognosToken,
                  extraHeaders: { 'x-cognos-namespace': env.VITE_COGNOS_NAMESPACE || 'CognosEx' },
                }),
              },
            }
          : {}),
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
