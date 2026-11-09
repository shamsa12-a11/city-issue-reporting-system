import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the API and uploaded photos are proxied to the backend, so
// the browser talks to one origin (no CORS setup, photo URLs like
// "/uploads/issues/<uuid>.jpg" work as returned by the API).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.VITE_DEV_BACKEND_URL || 'http://127.0.0.1:5000';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/uploads': { target: backend, changeOrigin: true },
      },
    },
  };
});
