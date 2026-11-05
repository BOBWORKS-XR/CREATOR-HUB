import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const cache = new Map();
// Isolated, in-memory test compilation. Never writes shared dist/release output.
export async function loadSourceModule(relativePath) {
  if (!cache.has(relativePath)) cache.set(relativePath, (async () => {
    const result = await build({ entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  })());
  return cache.get(relativePath);
}
