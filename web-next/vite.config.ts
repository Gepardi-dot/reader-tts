import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    host: true,
    port: 5175,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/library': 'http://127.0.0.1:8000',
    },
  },
})
