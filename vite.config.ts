/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { defineConfig, loadEnv, ViteDevServer } from 'vite';
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: '/',
      server: {
        port: 5173,
        host: '0.0.0.0',
        hmr: {
          clientPort: 5173,
          protocol: 'ws',
        },
        watch: {
          usePolling: true,
        },
        fs: {
          // Allow serving files from one level up to the project root
          allow: ['..'],
        },
        proxy: {
          '/api': {
            target: 'http://localhost:8080',
            changeOrigin: true,
          },
        },
        configure: (server: ViteDevServer) => {
          server.middlewares.use((_req, res, next) => {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            next();
          });
        },
      },
      plugins: [
        tailwindcss(),
      ],
      define: {
        'process.env.GOOGLE_MAPS_API_KEY': JSON.stringify(env.GOOGLE_MAPS_API_KEY),
      },
      resolve: {
        alias: {
          '@modelcontextprotocol/sdk/client/websocket.js': '@modelcontextprotocol/sdk/dist/client/websocket.js',
        },
      },
      build: {
        chunkSizeWarningLimit: 1000, // Increase limit to 1000 kB (1 MB)
        rollupOptions: {
          output: {
            entryFileNames: `assets/[name].${Date.now()}.js`,
            chunkFileNames: `assets/[name].${Date.now()}.js`,
            assetFileNames: `assets/[name].${Date.now()}.[ext]`,
          },
        },
      },
    };
});