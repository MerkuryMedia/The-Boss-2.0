import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
      '/health': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    fs: {
      allow: ['..'],
    },
  },
});
