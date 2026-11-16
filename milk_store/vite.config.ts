import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { VitePWA } from 'vite-plugin-pwa'
import { visualizer } from 'rollup-plugin-visualizer'

// Store-web standalone dev server: http://localhost:5174
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode !== 'test'
      ? [VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['favicon.svg'],
          manifest: {
            name: 'DairyDirect Store Manager Portal',
            short_name: 'DairyDirect Store',
            description: 'Run picking, inventory, riders, returns and COD for your assigned store.',
            theme_color: '#1D4D16',
            background_color: '#F6F9F3',
            display: 'standalone',
            icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
          },
          workbox: {
            navigateFallback: '/index.html',
            // Never serve the app shell for authenticated API requests.
            navigateFallbackDenylist: [/^\/v1\//],
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
        })]
      : []),
    ...(mode === 'analyze'
      ? [visualizer({ filename: 'stats.html', json: true, gzipSize: true, brotliSize: true, template: 'treemap' })]
      : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@dairydirect/shared/': fileURLToPath(new URL('./shared/src/', import.meta.url)),
    },
  },
  build: {
    manifest: true,
    chunkSizeWarningLimit: 120,
  },
  server: {
    port: 5174,
    // Same-origin API in development: production routing must expose /v1 on
    // the portal origin (cookie auth requires it).
    proxy: {
      '/v1': {
        target: process.env.VITE_DEV_API_TARGET || 'http://localhost:13080',
        changeOrigin: true,
      },
    },
  },
}))
