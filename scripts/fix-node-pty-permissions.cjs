// node-pty's macOS prebuilds ship spawn-helper without its execute bit, and every spawn then fails
// with "posix_spawnp failed". Linux builds from source and is unaffected. Macs are development only.
const { chmodSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

if (process.platform === 'darwin') {
  const root = dirname(require.resolve('node-pty/package.json', { paths: [join(__dirname, '../apps/api')] }));
  const helper = join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
