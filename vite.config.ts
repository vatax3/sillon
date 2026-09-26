/// <reference types="node" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Spotify n'accepte plus "localhost" comme redirect URI : on sert sur l'IP de loopback.
// VITE_BASE=/sillon/ pour GitHub Pages (servi sous un sous-chemin).
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Dev contre le serveur local : SILLON_SERVER=http://127.0.0.1:8080 npm run dev
    proxy: process.env.SILLON_SERVER
      ? { '/api': process.env.SILLON_SERVER, '/auth': process.env.SILLON_SERVER, '/healthz': process.env.SILLON_SERVER }
      : undefined,
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
