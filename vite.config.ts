import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { readPublicConfig } from './src/browser/config.ts';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'PUBLIC_');
  const hasConfig = Boolean(env.PUBLIC_SUPABASE_URL || env.PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  // A completely unconfigured site has a deliberate setup state; partial/unsafe config fails.
  const publicConfig = hasConfig ? readPublicConfig(env) : null;
  const connectSources = publicConfig
    ? `${publicConfig.supabaseUrl} ${publicConfig.supabaseUrl.replace(/^http/, 'ws')}`
    : "'none'";
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
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
    plugins: [
      {
        name: 'reject-server-code-in-browser',
        load(id) {
          const normalized = id.replaceAll('\\', '/').toLowerCase();
          if (normalized.includes('/src/server/')) this.error('Server-only code must never enter the dashboard bundle.');
        },
      },
      ...(command === 'build' ? [{
        name: 'dashboard-content-security-policy',
        transformIndexHtml() {
          return [{
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy },
            injectTo: 'head-prepend' as const,
          }];
        },
      }] : []),
    ],
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
