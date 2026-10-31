const test = require('node:test');
const assert = require('node:assert/strict');
const yazl = require('yazl');
const { PrinterCoverService, CoverUnavailableError, CoverNotReadyError, parseAccessCodes } = require('../src/printerCover');

const H2C = { id: 2, name: 'Vic H2C', serial_number: '31B8AP610800367', ip_address: '192.168.3.244' };

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

function fakeBambuddy({ cover = async () => Buffer.from('bambuddy png'), status = { subtask_name: 'LOVE', gcode_file: null } } = {}) {
  const calls = { cover: 0, status: 0 };
  return {
    calls,
    printers: async () => [H2C, { id: 1, name: 'Sam P1S', serial_number: '01P00A', ip_address: '192.168.3.96' }],
    status: async () => { calls.status += 1; return status; },
    cover: async (...args) => { calls.cover += 1; return cover(...args); },
  };
}

const bambuddyHasNone = async () => { throw new Error('Bambuddy request to /api/v1/printers/2/cover failed with status 404'); };

test('access codes are keyed by normalized serial or name', () => {
  const codes = parseAccessCodes('31B8AP610800367:12345678, Sam P1S:abcd:ef ,broken, :x');
  assert.equal(codes.get('31b8ap610800367'), '12345678');
  assert.equal(codes.get('samp1sabcd'), 'ef'); // the last ":" separates, so a name can't hold one
  assert.equal(codes.size, 2);
  assert.equal(parseAccessCodes(undefined).size, 0);
});

test('a printer is found by name in any normalization or by serial', async () => {
  const service = new PrinterCoverService({ bambuddyClient: fakeBambuddy() });
  assert.equal((await service.findPrinter('vic-h2c')).id, 2);
  assert.equal((await service.findPrinter('31b8ap610800367')).id, 2);
  assert.equal(await service.findPrinter('nope'), null);
  assert.equal(await service.findPrinter(''), null);
});

test("Bambuddy's cover is used when it has one, and the printer is never contacted", async () => {
  let downloads = 0;
  const service = new PrinterCoverService({
    bambuddyClient: fakeBambuddy(), accessCodes: parseAccessCodes('Vic H2C:code'), downloadFile: async () => { downloads += 1; },
  });
  const cover = await service.cover(H2C);
  assert.equal(cover.png.toString(), 'bambuddy png');
  assert.equal(cover.source, 'bambuddy');
  assert.equal(cover.jobName, 'LOVE');
  assert.equal(downloads, 0);
});

test('when Bambuddy has none, the cover is read off the printer with its access code', async () => {
  const downloads = [];
  const service = new PrinterCoverService({
    bambuddyClient: fakeBambuddy({ cover: bambuddyHasNone, status: { subtask_name: 'OREO / LOVE', gcode_file: 'Metadata/plate_2.gcode' } }),
    accessCodes: parseAccessCodes('31B8AP610800367:secret'),
    downloadFile: async (args) => {
      downloads.push(args);
      return { path: '/cache/OREO 2f LOVE.gcode.3mf', data: await zipOf({ 'Metadata/plate_1.png': 'one', 'Metadata/plate_2.png': 'two' }) };
    },
  });
  const cover = await service.cover(H2C);
  assert.equal(cover.png.toString(), 'two');
  assert.equal(cover.source, 'printer');
  assert.deepEqual(downloads, [{ host: '192.168.3.244', accessCode: 'secret', subtaskName: 'OREO / LOVE' }]);
});

test("Bambuddy's current_plate_id wins over the gcode path", async () => {
  const service = new PrinterCoverService({
    bambuddyClient: fakeBambuddy({ cover: bambuddyHasNone, status: { subtask_name: 'X', gcode_file: 'Metadata/plate_1.gcode', current_plate_id: 3 } }),
    accessCodes: parseAccessCodes('Vic H2C:secret'),
    downloadFile: async () => ({ path: '/cache/X.gcode.3mf', data: await zipOf({ 'Metadata/plate_1.png': 'one', 'Metadata/plate_3.png': 'three' }) }),
  });
  assert.equal((await service.cover(H2C)).png.toString(), 'three');
});

test('without an access code, a cover Bambuddy lacks is unavailable, saying why', async () => {
  const service = new PrinterCoverService({ bambuddyClient: fakeBambuddy({ cover: bambuddyHasNone }) });
  await assert.rejects(service.cover(H2C), (error) => error instanceof CoverUnavailableError && /no access code/.test(error.message));
});

test('a printer with no job has no cover', async () => {
  const service = new PrinterCoverService({ bambuddyClient: fakeBambuddy({ status: { subtask_name: null } }) });
  await assert.rejects(service.cover(H2C), CoverUnavailableError);
});

test('a file missing from the printer, or one without a render, is unavailable', async () => {
  for (const downloadFile of [async () => null, async () => ({ path: '/cache/LOVE.gcode.3mf', data: await zipOf({ 'a.txt': 'x' }) })]) {
    const service = new PrinterCoverService({
      bambuddyClient: fakeBambuddy({ cover: bambuddyHasNone }), accessCodes: parseAccessCodes('Vic H2C:c'), downloadFile,
    });
    await assert.rejects(service.cover(H2C), CoverUnavailableError);
  }
});

test('an FTPS failure is reported as unavailable, not as a server error', async () => {
  const service = new PrinterCoverService({
    bambuddyClient: fakeBambuddy({ cover: bambuddyHasNone }),
    accessCodes: parseAccessCodes('Vic H2C:c'),
    downloadFile: async () => { throw new Error('530 Login incorrect.'); },
  });
  await assert.rejects(service.cover(H2C), (error) => error instanceof CoverUnavailableError && /530/.test(error.message));
});

test('a found cover is served from memory for the rest of the job, and a new job fetches again', async () => {
  const status = { subtask_name: 'A', gcode_file: null };
  const bambuddy = fakeBambuddy({ status });
  const service = new PrinterCoverService({ bambuddyClient: bambuddy });
  const first = await service.cover(H2C);
  await service.cover(H2C);
  assert.equal(bambuddy.calls.cover, 1);
  assert.match(first.etag, /^"[0-9a-f]{32}"$/);

  status.subtask_name = 'B';
  await service.cover(H2C);
  assert.equal(bambuddy.calls.cover, 2);
});

test('a job that finishes keeps its cover when its gcode_file goes blank', async () => {
  const status = { subtask_name: 'Piano Markers', gcode_file: '/data/Metadata/plate_1.gcode' };
  let found = true;
  const bambuddy = fakeBambuddy({ status, cover: async () => { if (!found) throw new Error('404'); return Buffer.from('png'); } });
  const service = new PrinterCoverService({ bambuddyClient: bambuddy });
  await service.cover(H2C);

  // RUNNING -> FINISH: Bambuddy reports gcode_file "" and, just then, no /cover either.
  status.gcode_file = '';
  found = false;
  assert.equal((await service.cover(H2C)).png.toString(), 'png');
  assert.equal(bambuddy.calls.cover, 1);

  // Another plate of the same job name is a different print.
  status.gcode_file = '/data/Metadata/plate_2.gcode';
  found = true;
  await service.cover(H2C);
  assert.equal(bambuddy.calls.cover, 2);
});

test('the top view is its own image', async () => {
  const views = [];
  const service = new PrinterCoverService({
    bambuddyClient: fakeBambuddy({ cover: async (id, { view }) => { views.push(view); return Buffer.from(`png ${view}`); } }),
  });
  assert.equal((await service.cover(H2C)).png.toString(), 'png null');
  assert.equal((await service.cover(H2C, { view: 'top' })).png.toString(), 'png top');
  assert.deepEqual(views, [null, 'top']);
});

test('a failed lookup is not retried until its backoff passes, and the backoff doubles', async () => {
  let clock = 0;
  const bambuddy = fakeBambuddy({ cover: bambuddyHasNone });
  const service = new PrinterCoverService({ bambuddyClient: bambuddy, now: () => clock });

  await assert.rejects(service.cover(H2C));
  await assert.rejects(service.cover(H2C));
  assert.equal(bambuddy.calls.cover, 1);

  clock = 30 * 1000;
  await assert.rejects(service.cover(H2C));
  assert.equal(bambuddy.calls.cover, 2);

  clock += 59 * 1000;
  await assert.rejects(service.cover(H2C));
  assert.equal(bambuddy.calls.cover, 2);
  clock += 1000;
  await assert.rejects(service.cover(H2C));
  assert.equal(bambuddy.calls.cover, 3);
});

test('a new job is looked up at once even while the last one is backing off', async () => {
  const status = { subtask_name: 'A' };
  let fail = true;
  const bambuddy = fakeBambuddy({ status, cover: async () => { if (fail) throw new Error('404'); return Buffer.from('b'); } });
  const service = new PrinterCoverService({ bambuddyClient: bambuddy, now: () => 0 });
  await assert.rejects(service.cover(H2C));
  status.subtask_name = 'B';
  fail = false;
  assert.equal((await service.cover(H2C)).png.toString(), 'b');
});

test('concurrent requests for one job share one lookup', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bambuddy = fakeBambuddy({ cover: async () => { await gate; return Buffer.from('png'); } });
  const service = new PrinterCoverService({ bambuddyClient: bambuddy });
  const requests = [service.cover(H2C), service.cover(H2C), service.cover(H2C)];
  release();
  const covers = await Promise.all(requests);
  assert.equal(bambuddy.calls.cover, 1);
  assert.ok(covers.every((cover) => cover.png.toString() === 'png'));
});

test('a status the caller already has saves the status request', async () => {
  const bambuddy = fakeBambuddy();
  const service = new PrinterCoverService({ bambuddyClient: bambuddy });
  await service.cover(H2C, { status: { subtask_name: 'Given' } });
  assert.equal(bambuddy.calls.status, 0);
});

test('a failed lookup shared by several requests is counted once', async () => {
  let clock = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bambuddy = fakeBambuddy({ cover: async () => { await gate; return bambuddyHasNone(); } });
  const service = new PrinterCoverService({ bambuddyClient: bambuddy, now: () => clock });
  const requests = [service.cover(H2C), service.cover(H2C)];
  release();
  for (const request of requests) await assert.rejects(request);

  // One failure: retried after 30 s, not 60.
  clock = 30 * 1000;
  await assert.rejects(service.cover(H2C));
  assert.equal(bambuddy.calls.cover, 2);
});

test('a 3MF still being written is retried after 10 s without growing the backoff', async () => {
  let clock = 0;
  let file = Buffer.from('PK\u0003\u0004 half a zip');
  const service = new PrinterCoverService({
    bambuddyClient: fakeBambuddy({ cover: bambuddyHasNone, status: { subtask_name: 'Disney Nutcrackers_', gcode_file: 'Disney Nutcrackers_.3mf' } }),
    accessCodes: parseAccessCodes('Vic H2C:c'),
    downloadFile: async () => ({ path: '/cache/Disney Nutcrackers_.3mf', data: file }),
    now: () => clock,
  });
  await assert.rejects(service.cover(H2C), (error) => error instanceof CoverNotReadyError && /still downloading/.test(error.message));

  clock = 9 * 1000;
  await assert.rejects(service.cover(H2C), (error) => /still downloading/.test(error.message));
  clock = 10 * 1000;
  await assert.rejects(service.cover(H2C), CoverNotReadyError);

  file = await zipOf({ 'Metadata/plate_1.png': 'nutcrackers' });
  clock = 20 * 1000;
  assert.equal((await service.cover(H2C)).png.toString(), 'nutcrackers');
});
