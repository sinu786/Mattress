import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    react(),
    basicSsl()
  ],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    sourcemap: false, // Disabling sourcemaps trims unnecessary build weight
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('three')) {
              return 'vendor-three' // Isolates Three.js into its own cacheable chunk
            }
            if (id.includes('react') || id.includes('scheduler')) {
              return 'vendor-react' // Isolates React runtime
            }
            return 'vendor' // Everything else
          }
        }
      }
    }
  }
})
