const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AtomicJsonFile } = require('../src/atomicJsonFile');

async function tempFilePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  return path.join(dir, 'data.json');
}

test('write() persists the data returned by getData', async () => {
  const filePath = await tempFilePath();
  const file = new AtomicJsonFile(filePath);
  await file.write(() => ({ a: 1 }));

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(onDisk, { a: 1 });
});

test('concurrent write() calls do not throw and the file ends up matching the last one queued', async () => {
  // Reproduces the crash confirmed live 2026-09-06: two overlapping saves on a fixed .tmp path
  // previously raced on fs.rename, and the second rename threw ENOENT as an unhandled rejection.
  const filePath = await tempFilePath();
  const file = new AtomicJsonFile(filePath);

  const writes = [];
  for (let i = 0; i < 10; i++) {
    writes.push(file.write(() => ({ i })));
  }
  await assert.doesNotReject(Promise.all(writes));

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(onDisk, { i: 9 }, 'last-queued write wins, not whichever happened to finish first');
});

test('a write that throws does not permanently wedge the queue for later writes', async () => {
  const filePath = await tempFilePath();
  const file = new AtomicJsonFile(filePath);

  await assert.rejects(
    file.write(() => {
      throw new Error('boom');
    }),
  );

  await file.write(() => ({ ok: true }));
  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(onDisk, { ok: true });
});
