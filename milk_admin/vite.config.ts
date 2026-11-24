import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { VitePWA } from 'vite-plugin-pwa'
import { visualizer } from 'rollup-plugin-visualizer'

// Dev API target — where the NestJS backend listens. Override with VITE_DEV_API_TARGET.
// Must match the server's PORT (server/.env runs it on :13080; server/.env.example defaults to :3000).
const API_TARGET = process.env.VITE_DEV_API_TARGET || 'http://localhost:13080'

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'DairyDirect Admin Portal',
        short_name: 'DairyDirect',
        description: 'Manage farms, cities, orders, deliveries, finance and staff.',
        theme_color: '#2E7D1A',
        background_color: '#F6F9F3',
        display: 'standalone',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        // Never serve the SPA shell for API/media requests
        navigateFallbackDenylist: [/^\/v1\//, /^\/dev\//],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        runtimeCaching: [
          {
            // OpenStreetMap tiles — cache-first, capped
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    ...(mode === 'analyze'
      ? [visualizer({ filename: 'stats.html', json: true, gzipSize: true, brotliSize: true, template: 'treemap' })]
      : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    manifest: true,
    chunkSizeWarningLimit: 120,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: API_TARGET, changeOrigin: false },
      '/dev/private-media': { target: API_TARGET, changeOrigin: false },
      '/dev/catalog-media': { target: API_TARGET, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
}))
