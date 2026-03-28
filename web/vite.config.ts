import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // The app ships a large pdf.js worker asset and a single main bundle above Vite's default 500 kB warning threshold.
    // Raise the warning floor so production logs only flag genuinely unexpected growth.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/library': 'http://127.0.0.1:8000',
    },
  },
})
