import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4328',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', request => request.setHeader('Origin', 'http://127.0.0.1:4328'));
        },
      },
    },
  },
});
