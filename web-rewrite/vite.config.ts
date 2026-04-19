import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { VitePWA } from 'vite-plugin-pwa'

process.env.VITE_APP_BUILD_ID ??= new Date().toISOString()

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // App shell + static assets cached on install; API routes always go to network.
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico,webmanifest}'],
        runtimeCaching: [
          {
            // Cache API responses for books/providers with network-first strategy
            urlPattern: /^\/api\/books($|\?)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-books',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 5, maxAgeSeconds: 300 },
            },
          },
          {
            // Audio files cached once fetched (they're immutable once generated)
            urlPattern: /\/library\/books\/.+\.(mp3|wav|m4b)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'audio-files',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: {
        name: 'Storybook Reader',
        short_name: 'Reader',
        description: 'Read PDFs, listen to TTS narration, build vocabulary.',
        theme_color: '#1b2620',
        background_color: '#ede3d2',
        display: 'standalone',
        start_url: '/books',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 1400,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/library': 'http://127.0.0.1:8000',
    },
  },
})
