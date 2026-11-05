import { build } from 'esbuild';

// Bundled CommonJS dependencies still need Node's built-in module loader in ESM.
await build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'release/creator-works-mcp.mjs',
  banner: { js: "import { createRequire as __createNodeRequire } from 'node:module'; const require = __createNodeRequire(import.meta.url);" },
  logLevel: 'info',
});
