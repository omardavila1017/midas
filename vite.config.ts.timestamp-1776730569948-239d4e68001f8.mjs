// vite.config.ts
import { defineConfig, loadEnv } from "file:///sessions/nifty-quirky-fermi/mnt/FlowSense/flujo-senda/node_modules/vite/dist/node/index.js";
import react from "file:///sessions/nifty-quirky-fermi/mnt/FlowSense/flujo-senda/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "path";
var __vite_injected_original_dirname = "/sessions/nifty-quirky-fermi/mnt/FlowSense/flujo-senda";
var vite_config_default = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const jdeUpstream = env.VITE_JDE_UPSTREAM || "http://srv-desarrollo:90";
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
          target: jdeUpstream,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api\/jde/, "/JDEdwards")
        }
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvbmlmdHktcXVpcmt5LWZlcm1pL21udC9GbG93U2Vuc2UvZmx1am8tc2VuZGFcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9zZXNzaW9ucy9uaWZ0eS1xdWlya3ktZmVybWkvbW50L0Zsb3dTZW5zZS9mbHVqby1zZW5kYS92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vc2Vzc2lvbnMvbmlmdHktcXVpcmt5LWZlcm1pL21udC9GbG93U2Vuc2UvZmx1am8tc2VuZGEvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGxvYWRFbnYgfSBmcm9tICd2aXRlJ1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCdcblxuLy8gUHJveHkgZGUgZGVzYXJyb2xsbyBwYXJhIGxvcyBBUElzIGRlIEpERS5cbi8vIEVsIGJyb3dzZXIgbGxhbWEgYSAvYXBpL2pkZS8uLi4geSBWaXRlIHJlZXNjcmliZSBoYWNpYSBlbCBob3N0IGludGVybm9cbi8vIGh0dHA6Ly9zcnYtZGVzYXJyb2xsbzo5MC9KREVkd2FyZHMvLi4uIChldml0YSBDT1JTIHkgZXhwb25lIHNvbG8gbGFcbi8vIHJ1dGEgcFx1MDBGQWJsaWNhKS4gQ29uZmlndXJhYmxlIHZcdTAwRURhIFZJVEVfSkRFX1VQU1RSRUFNLlxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKCh7IG1vZGUgfSkgPT4ge1xuICBjb25zdCBlbnYgPSBsb2FkRW52KG1vZGUsIHByb2Nlc3MuY3dkKCksICcnKVxuICBjb25zdCBqZGVVcHN0cmVhbSA9IGVudi5WSVRFX0pERV9VUFNUUkVBTSB8fCAnaHR0cDovL3Nydi1kZXNhcnJvbGxvOjkwJ1xuXG4gIHJldHVybiB7XG4gICAgcGx1Z2luczogW3JlYWN0KCldLFxuICAgIHJlc29sdmU6IHtcbiAgICAgIGFsaWFzOiB7XG4gICAgICAgICdAJzogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4vc3JjJyksXG4gICAgICB9LFxuICAgIH0sXG4gICAgc2VydmVyOiB7XG4gICAgICBwb3J0OiA1MTczLFxuICAgICAgc3RyaWN0UG9ydDogZmFsc2UsXG4gICAgICBwcm94eToge1xuICAgICAgICAnL2FwaS9qZGUnOiB7XG4gICAgICAgICAgdGFyZ2V0OiBqZGVVcHN0cmVhbSxcbiAgICAgICAgICBjaGFuZ2VPcmlnaW46IHRydWUsXG4gICAgICAgICAgc2VjdXJlOiBmYWxzZSxcbiAgICAgICAgICByZXdyaXRlOiAocCkgPT4gcC5yZXBsYWNlKC9eXFwvYXBpXFwvamRlLywgJy9KREVkd2FyZHMnKSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBb1YsU0FBUyxjQUFjLGVBQWU7QUFDMVgsT0FBTyxXQUFXO0FBQ2xCLE9BQU8sVUFBVTtBQUZqQixJQUFNLG1DQUFtQztBQVF6QyxJQUFPLHNCQUFRLGFBQWEsQ0FBQyxFQUFFLEtBQUssTUFBTTtBQUN4QyxRQUFNLE1BQU0sUUFBUSxNQUFNLFFBQVEsSUFBSSxHQUFHLEVBQUU7QUFDM0MsUUFBTSxjQUFjLElBQUkscUJBQXFCO0FBRTdDLFNBQU87QUFBQSxJQUNMLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxJQUNqQixTQUFTO0FBQUEsTUFDUCxPQUFPO0FBQUEsUUFDTCxLQUFLLEtBQUssUUFBUSxrQ0FBVyxPQUFPO0FBQUEsTUFDdEM7QUFBQSxJQUNGO0FBQUEsSUFDQSxRQUFRO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixZQUFZO0FBQUEsTUFDWixPQUFPO0FBQUEsUUFDTCxZQUFZO0FBQUEsVUFDVixRQUFRO0FBQUEsVUFDUixjQUFjO0FBQUEsVUFDZCxRQUFRO0FBQUEsVUFDUixTQUFTLENBQUMsTUFBTSxFQUFFLFFBQVEsZUFBZSxZQUFZO0FBQUEsUUFDdkQ7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
