import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {localizeUi} from './scripts/localize-ui';
export default defineConfig({
  plugins: [localizeUi(), react(), tailwindcss(), {
    name: 'local-development-csp', apply: 'serve',
    transformIndexHtml(html) { return html.replace("script-src 'self'", "script-src 'self' 'nonce-midgard-local-development'").replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173"); },
  }],
  html: { cspNonce: 'midgard-local-development' }, base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/.qa/**','**/release/**','**/research/**','**/dist-electron/**'] } }, build: { chunkSizeWarningLimit: 1200 },
});
