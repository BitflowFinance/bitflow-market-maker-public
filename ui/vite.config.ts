import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.CONSOLE_API_PORT || '4173';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${api}`,
    },
  },
});
