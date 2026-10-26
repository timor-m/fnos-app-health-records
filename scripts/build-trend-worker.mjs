import { build } from 'vite';
import { resolve } from 'node:path';

// A standalone Node worker: no Nitro plugins, dev loader or runtime npm install.
await build({
  configFile: false,
  publicDir: false,
  ssr: {noExternal: true},
  build: {
    ssr: resolve('packages/server/workers/trend-snapshot.ts'),
    outDir: resolve('.server-dist/server'),
    emptyOutDir: false,
    minify: true,
    rollupOptions: {output: {entryFileNames: 'trend-snapshot-worker.mjs', codeSplitting: false}}
  }
});
