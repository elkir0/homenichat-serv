import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Base path pour production (servi depuis /admin)
  base: process.env.NODE_ENV === 'production' ? '/admin/' : '/',

  // Build output pour intégration avec Express
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },

  // Résolution des alias
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Proxy pour le développement
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },

  // Preview server
  preview: {
    port: 5173,
  },
})
