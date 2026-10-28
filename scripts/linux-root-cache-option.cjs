const path = require('node:path');
const { linuxRootCacheTarget } = require('./build-unified.cjs');

function select(root, output, input, warn = console.error) {
  try {
    linuxRootCacheTarget(root, output, input);
    return '--linux-root-cache';
  } catch (error) {
    if (error.code !== 'ERR_LINUX_ROOT_CACHE_LINKED_FILE') throw error;
    warn(`Cache not reused; compiling Root in a fresh output directory. ${JSON.stringify({ reason: error.message })}`);
    return '';
  }
}

module.exports = { select };
if (require.main === module) {
  try {
    if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw Error('Provide one absolute signed-input path.');
    const root = path.resolve(__dirname, '..');
    const option = select(root, path.join(root, 'artifacts/unified/ci-signed-unix-hub'), process.argv[2]);
    process.stdout.write(option);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
