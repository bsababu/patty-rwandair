import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';
const localApiTarget =
  process.env.API_PROXY_TARGET || 'http://127.0.0.1:4000';

export default defineConfig(() => ({
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      // Use one deterministic origin so session cookies do not move between
      // ports when Vite discovers that another port is already occupied.
      host: 'localhost',
      port: 3001,
      strictPort: true,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      // Match Nginx's Docker behavior: /api/v1/... becomes /v1/... at NestJS.
      // Keeping browser traffic same-origin also avoids cross-origin cookies.
      proxy: {
        '/api': {
          target: localApiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    plugins: [vinext()],
  }));
