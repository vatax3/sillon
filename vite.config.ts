import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Spotify n'accepte plus "localhost" comme redirect URI : on sert sur l'IP de loopback.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
