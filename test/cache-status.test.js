const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HOST_NAME = process.env.HOST_NAME || 'http://localhost:7000';
process.env.ADMIN_KEY = 'cache-status-test';
process.env.CACHE_WARMING_INTERVAL = '123';

test('/api/cache/status returns HTTP 200 with the registry-backed warming interval', async () => {
  const { addon, getCacheWarmingInterval } = require('../dist/server/index.js');
  assert.equal(getCacheWarmingInterval(), 123);
  const server = await new Promise(resolve => {
    const listening = addon.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/cache/status`, {
      headers: { 'x-admin-key': process.env.ADMIN_KEY },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.warmingInterval, 123);
    assert.equal(typeof body.initialWarmingComplete, 'boolean');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
