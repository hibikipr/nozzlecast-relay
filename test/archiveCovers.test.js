const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const yazl = require('yazl');
const { ArchiveCoverStore, ArchiveCoverService, parseBambuddyTime } = require('../src/archiveCovers');

const P1S = { id: 2, name: 'Sam P1S', serial_number: '01P00A', ip_address: '192.168.3.96' };

async function freshStore(options) {
  return new ArchiveCoverStore(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-covers-')), options);
}

// A plate render: a small opaque model on a transparent canvas.
async function renderPng(color = { r: 200, g: 60, b: 40 }) {
  return sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 20, height: 20, channels: 4, background: { ...color, alpha: 1 } } }, top: 10, left: 10 }])
    .png()
    .toBuffer();
}

function zipOf(files) {
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function fakeBambuddy(archives) {
  const calls = { archives: 0 };
  return {
    calls,
    printers: async () => [P1S],
    archives: async ({ printerId, limit }) => {
      calls.archives += 1;
      return archives.filter((archive) => archive.printer_id === printerId).sort((a, b) => b.id - a.id).slice(0, limit);
    },
    archive: async (id) => {
      const found = archives.find((archive) => archive.id === id);
      if (!found) throw new Error(`Bambuddy request to /api/v1/archives/${id} failed with status 404`);
      return found;
    },
  };
}

function fakeCoverService(png) {
  return { cover: async () => ({ png }), accessCodeFor: () => 'code' };
}

test("Bambuddy's offset-less timestamps are read as UTC", () => {
  assert.equal(parseBambuddyTime('2026-10-31T21:11:01'), Date.UTC(2026, 9, 31, 21, 11, 1));
  assert.equal(parseBambuddyTime('2026-10-31T21:11:01Z'), Date.UTC(2026, 9, 31, 21, 11, 1));
  assert.equal(parseBambuddyTime(null), null);
});

test("a running print's cover is saved under its archive, once", async () => {
  const store = await freshStore();
  const bambuddy = fakeBambuddy([
    { id: 621, printer_id: 2, print_name: 'Disney Nutcrackers_', started_at: '2026-10-30T10:00:00', thumbnail_path: null },
    { id: 622, printer_id: 2, print_name: 'Disney Nutcrackers_', started_at: '2026-10-31T21:11:00', thumbnail_path: null },
  ]);
  const service = new ArchiveCoverService({ store, bambuddyClient: bambuddy, coverService: fakeCoverService(await renderPng()) });
  const capture = { printer: P1S, status: { subtask_name: 'Disney Nutcrackers_' }, startedAt: '2026-10-31T21:11:55.000Z' };

  await service.capture(capture);
  await service.capture(capture);
  const saved = await store.get(622);
  assert.ok(saved);
  assert.equal((await sharp(saved).metadata()).format, 'jpeg');
  assert.equal(await store.get(621), null);
  assert.equal(bambuddy.calls.archives, 1);
});

test('no archive started since the print began means none is saved yet', async () => {
  const store = await freshStore();
  const bambuddy = fakeBambuddy([{ id: 621, printer_id: 2, print_name: 'Benchy', started_at: '2026-10-30T10:00:00', thumbnail_path: null }]);
  const service = new ArchiveCoverService({ store, bambuddyClient: bambuddy, coverService: fakeCoverService(await renderPng()) });
  await service.capture({ printer: P1S, status: { subtask_name: 'Benchy' }, startedAt: '2026-10-31T21:11:55.000Z' });
  assert.equal(await store.get(621), null);
});

test("an archive with Bambuddy's own thumbnail isn't saved again", async () => {
  const store = await freshStore();
  const bambuddy = fakeBambuddy([{ id: 585, printer_id: 2, print_name: 'NeeDoh', started_at: '2026-10-21T10:00:00', thumbnail_path: 'archive/585/thumbnail.png' }]);
  const service = new ArchiveCoverService({ store, bambuddyClient: bambuddy, coverService: fakeCoverService(await renderPng()) });
  await service.capture({ printer: P1S, status: { subtask_name: 'NeeDoh' }, startedAt: '2026-10-21T10:01:00.000Z' });
  assert.equal(await store.get(585), null);
});

test("an older archive's cover is read off the printer when it is the job name's newest print", async () => {
  const store = await freshStore();
  const bambuddy = fakeBambuddy([
    { id: 500, printer_id: 2, print_name: 'Hello Kitty / Phoneholder', filename: '/data/Metadata/plate_2.gcode', started_at: '2026-06-01T10:00:00' },
  ]);
  const downloads = [];
  const service = new ArchiveCoverService({
    store,
    bambuddyClient: bambuddy,
    coverService: fakeCoverService(null),
    downloadFile: async (args) => {
      downloads.push(args);
      return {
        path: '/cache/Hello Kitty _ Phoneholder.3mf',
        data: await zipOf({ 'Metadata/plate_1.png': await renderPng({ r: 0, g: 0, b: 255 }), 'Metadata/plate_2.png': await renderPng() }),
        modifiedAt: new Date(Date.UTC(2026, 5, 1, 9, 58)),
      };
    },
  });

  const cover = await service.cover(500);
  assert.ok(cover);
  assert.deepEqual(downloads, [{ host: '192.168.3.96', accessCode: 'code', subtaskName: 'Hello Kitty / Phoneholder' }]);
  assert.deepEqual(await store.get(500), cover);
});

test("an archive whose job name a newer print reused isn't backfilled from the printer's file", async () => {
  const store = await freshStore();
  let clock = 0;
  const bambuddy = fakeBambuddy([
    { id: 618, printer_id: 2, print_name: '0.2mm layer, 2 walls, 10% infill', started_at: '2026-10-31T10:00:00' },
    { id: 623, printer_id: 2, print_name: '0.2mm layer, 2 walls, 10% infill', started_at: '2026-11-01T00:33:00' },
  ]);
  let downloads = 0;
  const service = new ArchiveCoverService({
    store, bambuddyClient: bambuddy, coverService: fakeCoverService(null), now: () => clock,
    downloadFile: async () => { downloads += 1; return null; },
  });

  assert.equal(await service.cover(618), null);
  assert.equal(downloads, 0);

  // Remembered as missing for a day.
  clock = 60 * 60 * 1000;
  assert.equal(await service.cover(618), null);
  assert.equal(bambuddy.calls.archives, 1);
  clock = 25 * 60 * 60 * 1000;
  assert.equal(await service.cover(618), null);
  assert.equal(bambuddy.calls.archives, 2);
});

test('a printer file older than the print is not taken for it', async () => {
  const store = await freshStore();
  const bambuddy = fakeBambuddy([{ id: 400, printer_id: 2, print_name: 'Benchy', started_at: '2026-06-10T10:00:00' }]);
  const service = new ArchiveCoverService({
    store, bambuddyClient: bambuddy, coverService: fakeCoverService(null),
    downloadFile: async () => ({ path: '/cache/Benchy.3mf', data: await zipOf({ 'Metadata/plate_1.png': await renderPng() }), modifiedAt: new Date(Date.UTC(2026, 0, 1)) }),
  });
  assert.equal(await service.cover(400), null);
  assert.equal(await store.get(400), null);
});

test('the store keeps only the newest files past its cap', async () => {
  const store = await freshStore({ maxFiles: 2 });
  const png = await renderPng();
  for (const id of [1, 2, 3]) {
    await store.save(id, png);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
  }
  assert.equal(await store.get(1), null);
  assert.ok(await store.get(2));
  assert.ok(await store.get(3));
});

test('a job name with a "/" matches the archive Bambuddy names after its last part', async () => {
  const store = await freshStore();
  const bambuddy = fakeBambuddy([{ id: 592, printer_id: 2, print_name: ' LOVE', started_at: '2026-10-23T10:00:00', thumbnail_path: null }]);
  const service = new ArchiveCoverService({ store, bambuddyClient: bambuddy, coverService: fakeCoverService(await renderPng()) });
  await service.capture({ printer: P1S, status: { subtask_name: 'CLICKER VERSION OREO / LOVE' }, startedAt: '2026-10-23T10:01:00.000Z' });
  assert.ok(await store.get(592));
});

// A 9-plate project printed plate by plate, all under one job name: the newest file holds every
// plate's render, and a prediction only for the plate it was sliced for.
async function flatBaseFile() {
  return zipOf({
    'Metadata/plate_4.png': await renderPng({ r: 0, g: 200, b: 0 }),
    'Metadata/plate_9.png': await renderPng({ r: 0, g: 0, b: 200 }),
    'Metadata/slice_info.config': '<config><plate><metadata key="index" value="9"/><metadata key="prediction" value="8346"/><metadata key="weight" value="57.57"/></plate></config>',
  });
}

function flatBaseService(store, archives) {
  return new ArchiveCoverService({
    store,
    bambuddyClient: fakeBambuddy(archives),
    coverService: fakeCoverService(null),
    downloadFile: async () => ({ path: '/cache/Flat base to prevent rolling.gcode.3mf', data: await flatBaseFile(), modifiedAt: new Date(Date.UTC(2026, 9, 30, 23, 39)) }),
  });
}

const FLAT_BASE = 'Flat base to prevent rolling';
const newestFlatBase = { id: 617, printer_id: 2, print_name: FLAT_BASE, filename: '/data/Metadata/plate_9.gcode', status: 'completed', started_at: '2026-10-30T23:39:33', completed_at: '2026-10-31T02:05:57' };

test('an older reprint of another plate gets that plate from the newest file', async () => {
  const store = await freshStore();
  const service = flatBaseService(store, [
    { id: 599, printer_id: 2, print_name: FLAT_BASE, filename: '/data/Metadata/plate_4.gcode', status: 'completed', started_at: '2026-10-28T10:00:00', completed_at: '2026-10-28T10:47:00' },
    newestFlatBase,
  ]);
  const cover = await service.cover(599);
  assert.ok(cover);
  // Plate 4's render is green, plate 9's blue: the saved cover is plate 4's.
  const { data } = await sharp(cover).extract({ left: 128, top: 128, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[1] > data[2], 'plate 4 (green), not plate 9 (blue)');
});

test("a finished reprint of the same plate is taken when it ran close to the plate's predicted time", async () => {
  const store = await freshStore();
  const service = flatBaseService(store, [
    // 8489 s against 8346 predicted: 1.7% over.
    { id: 616, printer_id: 2, print_name: FLAT_BASE, filename: '/data/Metadata/plate_9.gcode', status: 'completed', started_at: '2026-10-30T20:00:00', completed_at: '2026-10-30T22:21:29' },
    newestFlatBase,
  ]);
  assert.ok(await service.cover(616));
});

test('a reprint of the same plate that ran far off the prediction, or failed, keeps no cover', async () => {
  const store = await freshStore();
  const service = flatBaseService(store, [
    // 10000 s: 20% over the prediction.
    { id: 610, printer_id: 2, print_name: FLAT_BASE, filename: '/data/Metadata/plate_9.gcode', status: 'completed', started_at: '2026-10-29T10:00:00', completed_at: '2026-10-29T12:46:40' },
    { id: 612, printer_id: 2, print_name: FLAT_BASE, filename: '/data/Metadata/plate_9.gcode', status: 'failed', started_at: '2026-10-29T13:00:00', completed_at: '2026-10-29T13:01:10' },
    newestFlatBase,
  ]);
  assert.equal(await service.cover(610), null);
  assert.equal(await service.cover(612), null);
});
