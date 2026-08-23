const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapWithLimit,
  resolveMetaConcurrency,
} = require('../dist/server/utils/concurrency.js');

test('metadata reconstruction uses the configured concurrency limit', async () => {
  const previous = process.env.META_CONCURRENCY;
  process.env.META_CONCURRENCY = '7';
  let active = 0;
  let maximum = 0;
  try {
    await mapWithLimit(Array.from({ length: 100 }, (_, index) => index), async value => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return value;
    });
    assert.equal(maximum, 7);
  } finally {
    if (previous === undefined) delete process.env.META_CONCURRENCY;
    else process.env.META_CONCURRENCY = previous;
  }
});

test('META_CONCURRENCY=0 selects the safe auto limit of 20', () => {
  const previous = process.env.META_CONCURRENCY;
  process.env.META_CONCURRENCY = '0';
  try {
    assert.equal(resolveMetaConcurrency(), 20);
  } finally {
    if (previous === undefined) delete process.env.META_CONCURRENCY;
    else process.env.META_CONCURRENCY = previous;
  }
});
