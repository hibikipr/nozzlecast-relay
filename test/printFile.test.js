const test = require('node:test');
const assert = require('node:assert/strict');
const yazl = require('yazl');
const { candidateFileNames, findPrintFile, plateFromGcodeFile, extractPlateImage } = require('../src/printFile');

function zipOf(files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

test('a job name gets both 3MF spellings, sliced first', () => {
  assert.deepEqual(candidateFileNames('Benchy'), ['Benchy.gcode.3mf', 'Benchy.3mf']);
});

test('a "/" in a job name is looked for as "2f", the way the printer stores it', () => {
  assert.deepEqual(candidateFileNames('OREO / LOVE'), [
    'OREO 2f LOVE.gcode.3mf', 'OREO 2f LOVE.3mf', 'OREO_2f_LOVE.gcode.3mf', 'OREO_2f_LOVE.3mf',
  ]);
});

test('a job name that is already a .3mf file name is kept as is', () => {
  assert.deepEqual(candidateFileNames('plate.3mf'), ['plate.3mf']);
});

test('a cloud print is found in /cache', () => {
  const listings = {
    '/cache': [{ name: '4 Colours - Chococat.gcode.3mf', size: 1234 }],
    '/': [{ name: 'other.gcode.3mf', size: 1 }],
  };
  assert.deepEqual(findPrintFile(listings, '4 Colours - Chococat'), { path: '/cache/4 Colours - Chococat.gcode.3mf', size: 1234 });
});

test('a root file gets a single leading slash', () => {
  assert.deepEqual(findPrintFile({ '/': [{ name: 'Benchy.3mf', size: 9 }] }, 'Benchy'), { path: '/Benchy.3mf', size: 9 });
});

test('the most likely name wins over a directory searched earlier', () => {
  const listings = { '/cache': [{ name: 'Benchy.3mf', size: 1 }], '/': [{ name: 'Benchy.gcode.3mf', size: 2 }] };
  assert.equal(findPrintFile(listings, 'Benchy').path, '/Benchy.gcode.3mf');
});

test('no match, or no listings at all, is null', () => {
  assert.equal(findPrintFile({ '/cache': [{ name: 'x.3mf', size: 1 }] }, 'Benchy'), null);
  assert.equal(findPrintFile({}, 'Benchy'), null);
});

test('the plate number comes from the gcode path', () => {
  assert.equal(plateFromGcodeFile('/data/Metadata/plate_3.gcode'), 3);
  assert.equal(plateFromGcodeFile('Benchy.gcode.3mf'), null);
  assert.equal(plateFromGcodeFile(null), null);
});

test('the asked-for plate render is extracted', async () => {
  const zip = await zipOf({ 'Metadata/plate_1.png': 'one', 'Metadata/plate_2.png': 'two', 'Metadata/top_2.png': 'top two' });
  assert.equal((await extractPlateImage(zip, { plate: 2 })).toString(), 'two');
  assert.equal((await extractPlateImage(zip, { plate: 2, view: 'top' })).toString(), 'top two');
});

test('with no plate known, a per-plate export uses its only sliced plate', async () => {
  const zip = await zipOf({ 'Metadata/plate_1.png': 'one', 'Metadata/plate_4.png': 'four', 'Metadata/plate_4.gcode': 'G28' });
  assert.equal((await extractPlateImage(zip)).toString(), 'four');
});

test('with no plate known and several sliced plates, plate 1 is used', async () => {
  const zip = await zipOf({
    'Metadata/plate_1.png': 'one', 'Metadata/plate_1.gcode': 'G28', 'Metadata/plate_2.png': 'two', 'Metadata/plate_2.gcode': 'G28',
  });
  assert.equal((await extractPlateImage(zip)).toString(), 'one');
});

test('a 3MF without the render is null, and a broken one throws', async () => {
  assert.equal(await extractPlateImage(await zipOf({ '3D/3dmodel.model': 'x' }), { plate: 1 }), null);
  await assert.rejects(extractPlateImage(Buffer.from('not a zip')));
});
