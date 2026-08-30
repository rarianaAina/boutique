import { fileURLToPath, URL } from 'node:url';
// `defineConfig` vient de vitest/config : c'est la même que celle de Vite,
// augmentée de la clé `test`. Sans elle, la configuration des tests ne
// passerait pas le contrôle de types.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Configuration alignée sur les attentes de Tauri : port fixe, écran non
 * nettoyé (les erreurs Rust doivent rester lisibles), dossier Rust exclu de la
 * surveillance (cargo s'en charge déjà).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    __APP_VERSION__: JSON.stringify(process.env['npm_package_version'] ?? '0.0.0'),
  },
  build: {
    // Cible des WebViews embarquées : WebView2 (Windows), WebKitGTK (Linux).
    target: 'esnext',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // `node:sqlite` est encore derrière un drapeau sur Node 22. Les tests des
    // dépôts tournent sur une VRAIE base SQLite, jamais sur une simulation :
    // un test qui ne passe pas par SQLite ne dirait rien des contraintes
    // d'unicité, qui sont précisément ce qui protège les IMEI.
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--experimental-sqlite', '--no-warnings'] } },
  },
});
