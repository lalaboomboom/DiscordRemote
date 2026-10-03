import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const kind = process.argv[2];
if (process.argv.length !== 3 || !['pty', 'agent'].includes(kind)) {
  console.error('Usage: node scripts/run-live-tests.mjs pty|agent');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', resolve(root, 'dist/test', `${kind}-live.test.js`)], {
  cwd: root,
  env: { ...process.env, REMOTE_OPERATOR_LIVE_TESTS: '1' },
  stdio: 'inherit',
  windowsHide: true,
  timeout: 180_000,
});
if (result.error) console.error('Live test runner failed or timed out. Inspect its disposable test resources before rerunning.');
process.exit(result.status ?? 1);
