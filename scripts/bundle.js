/**
 * Bundles the backend app in the current folder into a single ES module, dist/main.mjs, with its
 * dependencies and @flash-sale/shared inlined. The container image then needs no node_modules,
 * and the same kind of bundle is what a Lambda function deploys.
 *
 * Usage, from an app's folder: node ../../scripts/bundle.js [entry, default src/main.ts]
 */
import { build } from 'esbuild';

await build({
  entryPoints: [process.argv[2] ?? 'src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // An optional native add-on that `pg` loads only when asked to; we use the JavaScript client.
  external: ['pg-native'],
  // Dependencies written as CommonJS call require(), which an ES module does not have.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
