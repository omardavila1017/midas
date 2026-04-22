// vite.config.ts
import { defineConfig, loadEnv } from "file:///sessions/blissful-gracious-rubin/mnt/flujo-senda/node_modules/vite/dist/node/index.js";
import react from "file:///sessions/blissful-gracious-rubin/mnt/flujo-senda/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "path";
var __vite_injected_original_dirname = "/sessions/blissful-gracious-rubin/mnt/flujo-senda";
var vite_config_default = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const jdeUpstream = env.VITE_JDE_UPSTREAM || "https://api.gruposenda.com/v1/erp/tesoreria";
  let upstreamOrigin = jdeUpstream;
  let upstreamPath = "";
  try {
    const u = new URL(jdeUpstream);
    upstreamOrigin = u.origin;
    upstreamPath = u.pathname.replace(/\/+$/, "");
  } catch {
  }
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__vite_injected_original_dirname, "./src")
      }
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        "/api/jde": {
          target: upstreamOrigin,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/jde/, upstreamPath)
        }
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvYmxpc3NmdWwtZ3JhY2lvdXMtcnViaW4vbW50L2ZsdWpvLXNlbmRhXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvc2Vzc2lvbnMvYmxpc3NmdWwtZ3JhY2lvdXMtcnViaW4vbW50L2ZsdWpvLXNlbmRhL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy9ibGlzc2Z1bC1ncmFjaW91cy1ydWJpbi9tbnQvZmx1am8tc2VuZGEvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGxvYWRFbnYgfSBmcm9tICd2aXRlJ1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCdcblxuLy8gUHJveHkgZGUgZGVzYXJyb2xsbyBwYXJhIGxvcyBBUElzIGRlIEpERSAvIFRlc29yZXJcdTAwRURhLlxuLy8gRWwgYnJvd3NlciBsbGFtYSBhIC9hcGkvamRlLy4uLiB5IFZpdGUgcmVlc2NyaWJlIGhhY2lhIGVsIGhvc3QgcHJvZHVjdGl2b1xuLy8gaHR0cHM6Ly9hcGkuZ3J1cG9zZW5kYS5jb20vdjEvZXJwL3Rlc29yZXJpYS8uLi4gKGV2aXRhIENPUlMgZW4gZGV2KS5cbi8vIENvbmZpZ3VyYWJsZSB2XHUwMEVEYSBWSVRFX0pERV9VUFNUUkVBTS5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZygoeyBtb2RlIH0pID0+IHtcbiAgY29uc3QgZW52ID0gbG9hZEVudihtb2RlLCBwcm9jZXNzLmN3ZCgpLCAnJylcbiAgY29uc3QgamRlVXBzdHJlYW0gPSBlbnYuVklURV9KREVfVVBTVFJFQU0gfHwgJ2h0dHBzOi8vYXBpLmdydXBvc2VuZGEuY29tL3YxL2VycC90ZXNvcmVyaWEnXG5cbiAgLy8gRXh0cmFlbW9zIGVsIHBhdGhuYW1lIGRlbCB1cHN0cmVhbSBwYXJhIHJlZXNjcmliaXIgZWwgcHJlZml4IC9hcGkvamRlXG4gIC8vIGhhY2lhIGxhIHJ1dGEgY29ycmVjdGEgZGVsIGhvc3QgcHJvZHVjdGl2byAoZWouIC92MS9lcnAvdGVzb3JlcmlhKS5cbiAgbGV0IHVwc3RyZWFtT3JpZ2luID0gamRlVXBzdHJlYW1cbiAgbGV0IHVwc3RyZWFtUGF0aCA9ICcnXG4gIHRyeSB7XG4gICAgY29uc3QgdSA9IG5ldyBVUkwoamRlVXBzdHJlYW0pXG4gICAgdXBzdHJlYW1PcmlnaW4gPSB1Lm9yaWdpblxuICAgIHVwc3RyZWFtUGF0aCA9IHUucGF0aG5hbWUucmVwbGFjZSgvXFwvKyQvLCAnJylcbiAgfSBjYXRjaCB7XG4gICAgLy8gU2kgbm8gZXMgdW5hIFVSTCBhYnNvbHV0YSwgZGVqYW1vcyBlbCBzdHJpbmcgdGFsIGN1YWwgKGZhbGxiYWNrIGRldiBsb2NhbCkuXG4gIH1cblxuICByZXR1cm4ge1xuICAgIHBsdWdpbnM6IFtyZWFjdCgpXSxcbiAgICByZXNvbHZlOiB7XG4gICAgICBhbGlhczoge1xuICAgICAgICAnQCc6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuL3NyYycpLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHNlcnZlcjoge1xuICAgICAgcG9ydDogNTE3MyxcbiAgICAgIHN0cmljdFBvcnQ6IGZhbHNlLFxuICAgICAgcHJveHk6IHtcbiAgICAgICAgJy9hcGkvamRlJzoge1xuICAgICAgICAgIHRhcmdldDogdXBzdHJlYW1PcmlnaW4sXG4gICAgICAgICAgY2hhbmdlT3JpZ2luOiB0cnVlLFxuICAgICAgICAgIHNlY3VyZTogdHJ1ZSxcbiAgICAgICAgICByZXdyaXRlOiAocCkgPT4gcC5yZXBsYWNlKC9eXFwvYXBpXFwvamRlLywgdXBzdHJlYW1QYXRoKSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBcVUsU0FBUyxjQUFjLGVBQWU7QUFDM1csT0FBTyxXQUFXO0FBQ2xCLE9BQU8sVUFBVTtBQUZqQixJQUFNLG1DQUFtQztBQVF6QyxJQUFPLHNCQUFRLGFBQWEsQ0FBQyxFQUFFLEtBQUssTUFBTTtBQUN4QyxRQUFNLE1BQU0sUUFBUSxNQUFNLFFBQVEsSUFBSSxHQUFHLEVBQUU7QUFDM0MsUUFBTSxjQUFjLElBQUkscUJBQXFCO0FBSTdDLE1BQUksaUJBQWlCO0FBQ3JCLE1BQUksZUFBZTtBQUNuQixNQUFJO0FBQ0YsVUFBTSxJQUFJLElBQUksSUFBSSxXQUFXO0FBQzdCLHFCQUFpQixFQUFFO0FBQ25CLG1CQUFlLEVBQUUsU0FBUyxRQUFRLFFBQVEsRUFBRTtBQUFBLEVBQzlDLFFBQVE7QUFBQSxFQUVSO0FBRUEsU0FBTztBQUFBLElBQ0wsU0FBUyxDQUFDLE1BQU0sQ0FBQztBQUFBLElBQ2pCLFNBQVM7QUFBQSxNQUNQLE9BQU87QUFBQSxRQUNMLEtBQUssS0FBSyxRQUFRLGtDQUFXLE9BQU87QUFBQSxNQUN0QztBQUFBLElBQ0Y7QUFBQSxJQUNBLFFBQVE7QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLFlBQVk7QUFBQSxNQUNaLE9BQU87QUFBQSxRQUNMLFlBQVk7QUFBQSxVQUNWLFFBQVE7QUFBQSxVQUNSLGNBQWM7QUFBQSxVQUNkLFFBQVE7QUFBQSxVQUNSLFNBQVMsQ0FBQyxNQUFNLEVBQUUsUUFBUSxlQUFlLFlBQVk7QUFBQSxRQUN2RDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
