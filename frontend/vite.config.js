import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  build: {
    outDir: '../custom_components/password/www',
    emptyOutDir: true
  },
  plugins: [react()],
  server: {
    proxy: {
      '/api/password': 'http://localhost:8123'
    }
  },
  resolve: {
    alias: {
      "@": '/src/'
    }
  }
})
