import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Proxy de desarrollo para los APIs de JDE.
// El browser llama a /api/jde/... y Vite reescribe hacia el host interno
// http://srv-desarrollo:90/JDEdwards/... (evita CORS y expone solo la
// ruta pública). Configurable vía VITE_JDE_UPSTREAM.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const jdeUpstream = env.VITE_JDE_UPSTREAM || 'http://srv-desarrollo:90'

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
          target: jdeUpstream,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api\/jde/, '/JDEdwards'),
        },
      },
    },
  }
})
