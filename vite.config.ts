import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { readPublicConfig } from './src/browser/config.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'PUBLIC_');
  const hasConfig = Boolean(env.PUBLIC_SUPABASE_URL || env.PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  // A completely unconfigured site has a deliberate setup state; partial/unsafe config fails.
  if (hasConfig) readPublicConfig(env);
  return {
    root: resolve('src/browser'),
    base: './', // Works under /ecommerce/ and a custom domain without a history router.
    envDir: process.cwd(),
    envPrefix: [],
    define: {
      __PUBLIC_CONFIG__: JSON.stringify({
        PUBLIC_SUPABASE_URL: env.PUBLIC_SUPABASE_URL ?? '',
        PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      }),
    },
    plugins: [{
      name: 'reject-server-code-in-browser',
      load(id) {
        const normalized = id.replaceAll('\\', '/').toLowerCase();
        if (normalized.includes('/src/server/')) this.error('Server-only code must never enter the dashboard bundle.');
      },
    }],
    build: {
      outDir: resolve('dist'), emptyOutDir: true, sourcemap: false,
      rollupOptions: { output: {
        entryFileNames: 'assets/dashboard.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      } },
    },
  };
});
