import { defineConfig } from 'vite';

// getUserMedia requires a secure context. http://localhost counts as secure,
// so the dev server below is fine. If you serve to another device, use https.
export default defineConfig({
  root: '.',
  server: {
    host: 'localhost',
    port: 5173,
    open: true,
  },
});
