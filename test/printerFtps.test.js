const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadPrintFile } = require('../src/printerFtps');

// Stands in for basic-ftp's Client: a directory listing per path and a body per file.
function fakeClient({ dirs = {}, files = {}, failAccess = null } = {}) {
  const log = [];
  return {
    log,
    access: async (options) => { log.push(['access', options]); if (failAccess) throw new Error(failAccess); },
    list: async (dir) => {
      log.push(['list', dir]);
      if (!dirs[dir]) throw new Error('550 Failed to change directory.');
      return dirs[dir];
    },
    downloadTo: async (sink, path) => {
      log.push(['download', path]);
      // basic-ftp listens for the destination's own error event too, and rejects with it.
      await new Promise((resolve, reject) => {
        sink.once('error', reject);
        sink.write(files[path], (error) => (error ? reject(error) : resolve()));
      });
    },
    close: () => log.push(['close']),
  };
}

test('logs in as bblp over implicit FTPS on 990 and downloads the job file from /cache', async () => {
  const client = fakeClient({
    dirs: { '/cache': [{ name: 'OREO 2f LOVE.gcode.3mf', size: 4 }], '/': [] },
    files: { '/cache/OREO 2f LOVE.gcode.3mf': Buffer.from('3mf!') },
  });
  const file = await downloadPrintFile({ host: '192.168.3.244', accessCode: 'code', subtaskName: 'OREO / LOVE', createClient: () => client });
  assert.deepEqual(file, { path: '/cache/OREO 2f LOVE.gcode.3mf', data: Buffer.from('3mf!') });
  const [, options] = client.log[0];
  assert.equal(options.port, 990);
  assert.equal(options.user, 'bblp');
  assert.equal(options.password, 'code');
  assert.equal(options.secure, 'implicit');
  assert.equal(options.secureOptions.rejectUnauthorized, false);
  assert.deepEqual(client.log.at(-1), ['close']);
});

test('a directory the printer lacks is skipped, and no file is null', async () => {
  const client = fakeClient({ dirs: { '/': [{ name: 'other.3mf', size: 1 }] } });
  assert.equal(await downloadPrintFile({ host: 'h', accessCode: 'c', subtaskName: 'Benchy', createClient: () => client }), null);
  assert.deepEqual(client.log.at(-1), ['close']);
});

test('a file over the limit is refused before downloading', async () => {
  const client = fakeClient({ dirs: { '/cache': [{ name: 'Big.gcode.3mf', size: 100 }] } });
  await assert.rejects(downloadPrintFile({ host: 'h', accessCode: 'c', subtaskName: 'Big', maxBytes: 10, createClient: () => client }), /limit/);
  assert.ok(!client.log.some(([step]) => step === 'download'));
});

test('a file that grows past the limit mid-download fails', async () => {
  const client = fakeClient({ dirs: { '/cache': [{ name: 'Big.gcode.3mf', size: 1 }] }, files: { '/cache/Big.gcode.3mf': Buffer.alloc(20) } });
  await assert.rejects(downloadPrintFile({ host: 'h', accessCode: 'c', subtaskName: 'Big', maxBytes: 10, createClient: () => client }), /limit/);
});

test('a failed login throws, and the connection is still closed', async () => {
  const client = fakeClient({ failAccess: '530 Login incorrect.' });
  await assert.rejects(downloadPrintFile({ host: 'h', accessCode: 'bad', subtaskName: 'X', createClient: () => client }), /530/);
  assert.deepEqual(client.log.at(-1), ['close']);
});
