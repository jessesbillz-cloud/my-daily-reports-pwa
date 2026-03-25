import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

export default defineConfig({
  define: {
    '__SW_RESET_VERSION__': JSON.stringify('mdr-reset-' + Date.now()),
  },
  plugins: [
    react(),
    {
      name: 'rewrite-index',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '/index.html') {
            req.url = '/index-vite.html'
          }
          next()
        })
      },
    },
    {
      name: 'rename-index',
      closeBundle() {
        const src = path.resolve(__dirname, 'dist/index-vite.html')
        const dest = path.resolve(__dirname, 'dist/index.html')
        if (fs.existsSync(src)) {
          fs.renameSync(src, dest)
        }
      },
    },
  ],
  server: {
    port: 3000,
    open: '/index-vite.html',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index-vite.html'),
      external: ['pdf-lib', 'pdfjs-dist'],
      output: {
        globals: {
          'pdf-lib': 'PDFLib',
          'pdfjs-dist': 'pdfjsLib',
        },
      },
    },
  },
  optimizeDeps: {
    entries: ['index-vite.html'],
  },
})
