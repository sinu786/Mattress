import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,           // 0.0.0.0
    port: 5173,
    strictPort: true,
    cors: true,
    // Make HMR sockets reachable from the phone
    hmr: {
      host: '192.168.1.42',   // <- your PC IP
      port: 5173,
      protocol: 'ws',
    },
  },
})
