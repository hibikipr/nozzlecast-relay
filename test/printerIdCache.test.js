const test = require('node:test');
const assert = require('node:assert/strict');
const { PrinterIdCache } = require('../src/printerIdCache');

function fakeBambuddyClient(printerLists) {
  let call = 0;
  const calls = [];
  return {
    printers: async () => {
      calls.push(call);
      const list = printerLists[Math.min(call, printerLists.length - 1)];
      call += 1;
      return list;
    },
    calls,
  };
}

test('resolve() fetches printers() lazily on first use and matches by normalizedID', async () => {
  const bambuddyClient = fakeBambuddyClient([[{ id: 1, name: 'Sam P1S' }, { id: 2, name: 'Vic H2C' }]]);
  const cache = new PrinterIdCache({ bambuddyClient });

  assert.equal(bambuddyClient.calls.length, 0);
  const id = await cache.resolve('samp1s');
  assert.equal(id, 1);
  assert.equal(bambuddyClient.calls.length, 1);
});

test('resolve() reuses the cached map on a second lookup instead of re-fetching', async () => {
  const bambuddyClient = fakeBambuddyClient([[{ id: 1, name: 'Sam P1S' }]]);
  const cache = new PrinterIdCache({ bambuddyClient });

  await cache.resolve('samp1s');
  await cache.resolve('samp1s');

  assert.equal(bambuddyClient.calls.length, 1);
});

test('resolve() refreshes once on a cache miss, in case a printer was added since the last fetch', async () => {
  const bambuddyClient = fakeBambuddyClient([
    [{ id: 1, name: 'Sam P1S' }],
    [{ id: 1, name: 'Sam P1S' }, { id: 2, name: 'Vic H2C' }],
  ]);
  const cache = new PrinterIdCache({ bambuddyClient });

  await cache.resolve('samp1s'); // primes the cache with only Sam P1S
  const id = await cache.resolve('vich2c'); // miss -> refresh -> found

  assert.equal(id, 2);
  assert.equal(bambuddyClient.calls.length, 2);
});

test('resolve() returns null for a printer that still isn\'t found after a refresh', async () => {
  const bambuddyClient = fakeBambuddyClient([[{ id: 1, name: 'Sam P1S' }]]);
  const cache = new PrinterIdCache({ bambuddyClient });

  const id = await cache.resolve('nonexistent');

  assert.equal(id, null);
  assert.equal(bambuddyClient.calls.length, 2); // initial fetch + one refresh-on-miss
});

test('a printers() rejection propagates rather than being swallowed here', async () => {
  const bambuddyClient = { printers: async () => { throw new Error('network down'); } };
  const cache = new PrinterIdCache({ bambuddyClient });

  await assert.rejects(cache.resolve('samp1s'), /network down/);
});
