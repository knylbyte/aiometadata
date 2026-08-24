const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('StremThru and merged real-runtime integration suite passes', () => {
  const fixture = path.join(__dirname, 'stremthru-merged-runtime.integration.cjs');
  const env = { ...process.env, HOST_NAME: process.env.HOST_NAME || 'http://localhost:7000' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-force-exit', fixture], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, result.error?.message || 'runtime integration worker failed');
});
