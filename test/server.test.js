const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const { TokenStore } = require('../src/tokenStore');
const { ActivityTokenStore } = require('../src/activityTokenStore');

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  const store = new TokenStore(path.join(dir, 'tokens.json'));
  await store.load();
  return store;
}

async function freshStorePair() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  const tokenStore = new TokenStore(path.join(dir, 'tokens.json'));
  await tokenStore.load();
  const deviceTokenStore = new TokenStore(path.join(dir, 'device-tokens.json'));
  await deviceTokenStore.load();
  return { tokenStore, deviceTokenStore };
}

async function freshActivityStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  const activityTokenStore = new ActivityTokenStore(path.join(dir, 'activity-tokens.json'));
  await activityTokenStore.load();
  return activityTokenStore;
}

test('GET /healthz returns 200 without auth', async () => {
  const store = await freshStore();
  const app = createServer({ tokenStore: store, authSecret: 'secret123' });
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
});

test('POST /register without a valid bearer token is rejected', async () => {
  const store = await freshStore();
  const app = createServer({ tokenStore: store, authSecret: 'secret123' });
  const res = await request(app).post('/register').send({ token: 'abc', environment: 'sandbox' });
  assert.equal(res.status, 401);
  assert.equal(store.list().length, 0);
});

test('POST /register with the correct bearer token registers it', async () => {
  const store = await freshStore();
  const app = createServer({ tokenStore: store, authSecret: 'secret123' });
  const res = await request(app)
    .post('/register')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'abc', environment: 'sandbox' });

  assert.equal(res.status, 200);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].token, 'abc');
});

test('POST /register rejects a missing token or invalid environment', async () => {
  const store = await freshStore();
  const app = createServer({ tokenStore: store, authSecret: 'secret123' });

  const missingToken = await request(app)
    .post('/register')
    .set('Authorization', 'Bearer secret123')
    .send({ environment: 'sandbox' });
  assert.equal(missingToken.status, 400);

  const badEnv = await request(app)
    .post('/register')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'abc', environment: 'staging' });
  assert.equal(badEnv.status, 400);
});

test('DELETE /register with the correct bearer token removes it', async () => {
  const store = await freshStore();
  await store.upsert({ token: 'abc', environment: 'sandbox' });
  const app = createServer({ tokenStore: store, authSecret: 'secret123' });

  const res = await request(app)
    .delete('/register')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'abc' });

  assert.equal(res.status, 200);
  assert.equal(store.list().length, 0);
});

test('DELETE /register without auth is rejected', async () => {
  const store = await freshStore();
  await store.upsert({ token: 'abc', environment: 'sandbox' });
  const app = createServer({ tokenStore: store, authSecret: 'secret123' });

  const res = await request(app).delete('/register').send({ token: 'abc' });
  assert.equal(res.status, 401);
  assert.equal(store.list().length, 1);
});

test('POST /register-device with the correct bearer token registers it, separately from /register', async () => {
  const { tokenStore, deviceTokenStore } = await freshStorePair();
  const app = createServer({ tokenStore, deviceTokenStore, authSecret: 'secret123' });

  const res = await request(app)
    .post('/register-device')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'devabc', environment: 'sandbox' });

  assert.equal(res.status, 200);
  assert.equal(deviceTokenStore.list().length, 1);
  assert.equal(deviceTokenStore.list()[0].token, 'devabc');
  assert.equal(tokenStore.list().length, 0);
});

test('POST /register-device without a valid bearer token is rejected', async () => {
  const { tokenStore, deviceTokenStore } = await freshStorePair();
  const app = createServer({ tokenStore, deviceTokenStore, authSecret: 'secret123' });

  const res = await request(app).post('/register-device').send({ token: 'devabc', environment: 'sandbox' });
  assert.equal(res.status, 401);
  assert.equal(deviceTokenStore.list().length, 0);
});

test('DELETE /register-device with the correct bearer token removes it', async () => {
  const { tokenStore, deviceTokenStore } = await freshStorePair();
  await deviceTokenStore.upsert({ token: 'devabc', environment: 'sandbox' });
  const app = createServer({ tokenStore, deviceTokenStore, authSecret: 'secret123' });

  const res = await request(app)
    .delete('/register-device')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'devabc' });

  assert.equal(res.status, 200);
  assert.equal(deviceTokenStore.list().length, 0);
});

test('POST /register-activity with the correct bearer token registers it, keyed by printerID', async () => {
  const activityTokenStore = await freshActivityStore();
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });

  const res = await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'actabc', printerID: 'samp1s', environment: 'sandbox' });

  assert.equal(res.status, 200);
  assert.deepEqual(activityTokenStore.tokensFor('samp1s').map((t) => t.token), ['actabc']);
  assert.equal(activityTokenStore.tokensFor('samp1s')[0].environment, 'sandbox');
});

test('POST /register-activity normalizes printerID the same way push-to-start does', async () => {
  const activityTokenStore = await freshActivityStore();
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });

  await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'actabc', printerID: 'Sam P1S', environment: 'sandbox' });

  assert.deepEqual(activityTokenStore.tokensFor('samp1s').map((t) => t.token), ['actabc']);
  assert.equal(activityTokenStore.get('Sam P1S'), undefined);
});

test('POST /register-activity without a valid bearer token is rejected', async () => {
  const activityTokenStore = await freshActivityStore();
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });

  const res = await request(app)
    .post('/register-activity')
    .send({ token: 'actabc', printerID: 'samp1s', environment: 'sandbox' });

  assert.equal(res.status, 401);
  assert.equal(activityTokenStore.list().length, 0);
});

test('POST /register-activity rejects a missing token, printerID, or invalid environment', async () => {
  const activityTokenStore = await freshActivityStore();
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });

  const missingToken = await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ printerID: 'samp1s', environment: 'sandbox' });
  assert.equal(missingToken.status, 400);

  const missingPrinterID = await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'actabc', environment: 'sandbox' });
  assert.equal(missingPrinterID.status, 400);

  const badEnv = await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'actabc', printerID: 'samp1s', environment: 'staging' });
  assert.equal(badEnv.status, 400);
});

test('POST /register-activity from two devices keeps both, under the one printerID', async () => {
  const activityTokenStore = await freshActivityStore();
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });

  await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'old-token', printerID: 'samp1s', environment: 'sandbox' });
  await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'new-token', printerID: 'samp1s', environment: 'production' });

  // One ENTRY per printer still, but now carrying one token per device watching that print --
  // a second device registering must not evict the first (see activityTokenStore.js).
  assert.equal(activityTokenStore.list().length, 1);
  assert.deepEqual(
    activityTokenStore.tokensFor('samp1s').map((t) => t.token).sort(),
    ['new-token', 'old-token'],
  );
});

test('a store write that fails answers 500 instead of escaping as an unhandled rejection', async () => {
  const failing = { upsert: async () => { throw new Error('EROFS: read-only file system'); } };
  for (const [route, deps] of [
    ['/register', { tokenStore: failing }],
    ['/register-device', { deviceTokenStore: failing }],
  ]) {
    const app = createServer({ ...deps, authSecret: 'secret123' });
    const res = await request(app)
      .post(route)
      .set('Authorization', 'Bearer secret123')
      .send({ token: 'abc', environment: 'production' });
    assert.equal(res.status, 500, route);
    assert.deepEqual(res.body, { error: 'internal error' });
  }

  const activityTokenStore = { registerToken: async () => { throw new Error('ENOSPC'); }, tokensFor: () => [] };
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });
  const res = await request(app)
    .post('/register-activity')
    .set('Authorization', 'Bearer secret123')
    .send({ token: 'abc', printerID: 'vich2c', environment: 'production' });
  assert.equal(res.status, 500);
});

// GET /cover/:printerID -- the cover image API. A fake cover service stands in for Bambuddy and
// the printer; the route's own job is auth, lookup, rendering and caching headers.
const sharp = require('sharp');
const { CoverUnavailableError } = require('../src/printerCover');

async function coverApp({ cover, coverApiKey = null } = {}) {
  const png = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const calls = [];
  const coverService = {
    findPrinter: async (id) => (id === 'vic-h2c' ? { id: 2, name: 'Vic H2C' } : null),
    cover: async (printer, options) => {
      calls.push(options);
      return cover ? cover(printer, options) : { png, etag: '"abc123"', source: 'printer', jobName: 'OREO / LOVE' };
    },
  };
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123', coverService, coverApiKey });
  return { app, calls };
}

test('GET /cover without a key is rejected', async () => {
  const { app } = await coverApp();
  assert.equal((await request(app).get('/cover/vic-h2c')).status, 401);
  assert.equal((await request(app).get('/cover/vic-h2c?key=wrong')).status, 401);
});

test('GET /cover takes the relay secret as a Bearer header or a key parameter', async () => {
  const { app } = await coverApp();
  const viaHeader = await request(app).get('/cover/vic-h2c').set('Authorization', 'Bearer secret123');
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.headers['content-type'], 'image/png');
  assert.equal(viaHeader.headers['x-image-width'], '400');
  assert.equal(viaHeader.headers['x-cover-source'], 'printer');
  assert.equal(decodeURIComponent(viaHeader.headers['x-print-job']), 'OREO / LOVE');
  assert.equal((await request(app).get('/cover/vic-h2c?key=secret123')).status, 200);
});

test('GET /cover takes the separate cover key, which registration does not', async () => {
  const { app } = await coverApp({ coverApiKey: 'display-key' });
  assert.equal((await request(app).get('/cover/vic-h2c?key=display-key')).status, 200);
  const register = await request(app).post('/register').set('Authorization', 'Bearer display-key').send({ token: 'a', environment: 'sandbox' });
  assert.equal(register.status, 401);
});

test('GET /cover renders the asked-for size and format', async () => {
  const { app } = await coverApp();
  const res = await request(app).get('/cover/vic-h2c?key=secret123&width=120&format=jpeg').buffer(true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-image-width'], '120');
  assert.equal((await sharp(res.body).metadata()).width, 120);
});

test('GET /cover answers 304 to a matching If-None-Match, and a different rendering has its own ETag', async () => {
  const { app } = await coverApp();
  const first = await request(app).get('/cover/vic-h2c?key=secret123&width=100');
  const etag = first.headers.etag;
  assert.ok(etag);
  const again = await request(app).get('/cover/vic-h2c?key=secret123&width=100').set('If-None-Match', etag);
  assert.equal(again.status, 304);
  const otherSize = await request(app).get('/cover/vic-h2c?key=secret123&width=50');
  assert.notEqual(otherSize.headers.etag, etag);
});

test('GET /cover passes the top view through', async () => {
  const { app, calls } = await coverApp();
  await request(app).get('/cover/vic-h2c?key=secret123&view=top');
  assert.deepEqual(calls, [{ view: 'top' }]);
});

test('GET /cover is 404 for an unknown printer or a job without a cover, 400 for bad options', async () => {
  const { app } = await coverApp({ cover: async () => { throw new CoverUnavailableError('printer "Vic H2C" has no current or last job'); } });
  assert.equal((await request(app).get('/cover/nope?key=secret123')).status, 404);
  const noCover = await request(app).get('/cover/vic-h2c?key=secret123');
  assert.equal(noCover.status, 404);
  assert.match(noCover.body.error, /no current or last job/);
  assert.equal((await request(app).get('/cover/vic-h2c?key=secret123&format=gif')).status, 400);
});

test('GET /cover is 503 on a relay built without a cover service', async () => {
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123' });
  assert.equal((await request(app).get('/cover/vic-h2c?key=secret123')).status, 503);
});

// GET /cover/archive/:archiveId -- an archived print's cover, for print history.
test('GET /cover/archive/:archiveId serves the saved JPEG behind the cover key, 404 when there is none', async () => {
  const jpeg = Buffer.from('jpeg bytes');
  const archiveCoverService = { cover: async (id) => (id === 622 ? jpeg : null) };
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123', archiveCoverService, coverApiKey: 'coverkey' });

  assert.equal((await request(app).get('/cover/archive/622')).status, 401);
  const res = await request(app).get('/cover/archive/622?key=coverkey');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.deepEqual(res.body, jpeg);
  assert.equal((await request(app).get('/cover/archive/622').set('If-None-Match', res.headers.etag).set('Authorization', 'Bearer secret123')).status, 304);
  assert.equal((await request(app).get('/cover/archive/600?key=coverkey')).status, 404);
  assert.equal((await request(app).get('/cover/archive/abc?key=coverkey')).status, 400);
});

test('GET /cover/archive/:archiveId is a 503 when covers are not set up', async () => {
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123' });
  assert.equal((await request(app).get('/cover/archive/1').set('Authorization', 'Bearer secret123')).status, 503);
});

// Bambuddy alert webhook, mute sync, status and photos.
test('POST /bambuddy/alerts takes a large webhook body behind the relay secret and answers 202', async () => {
  const received = [];
  const alertForwarder = { receive: async (body) => { received.push(body); }, isActive: () => true, photo: () => null };
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123', alertForwarder });
  const body = { title: 'Print Completed', message: 'Vic H2C', event: 'print_complete', image: 'A'.repeat(2 * 1024 * 1024) };

  assert.equal((await request(app).post('/bambuddy/alerts').send({ title: 't', message: 'm' })).status, 401);
  const res = await request(app).post('/bambuddy/alerts').set('Authorization', 'Bearer secret123').send(body);
  assert.equal(res.status, 202);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(received.length, 1);
  assert.equal(received[0].image.length, 2 * 1024 * 1024);
  assert.equal((await request(app).post('/bambuddy/alerts').set('Authorization', 'Bearer secret123').send({ text: 'slack' })).status, 400);
});

test('GET /alerts/status, PUT /muted-alerts and GET /alert-photo/:id', async () => {
  const mutes = [];
  const photo = { data: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' };
  const alertForwarder = {
    isActive: () => true,
    setMutes: async (token, alerts) => { mutes.push([token, alerts]); },
    photo: (id) => (id === 'p1' ? photo : null),
  };
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123', alertForwarder });
  const auth = (req) => req.set('Authorization', 'Bearer secret123');

  assert.deepEqual((await auth(request(app).get('/alerts/status'))).body, { active: true });
  assert.equal((await request(app).get('/alerts/status')).status, 401);

  assert.equal((await auth(request(app).put('/muted-alerts')).send({ token: 'phone', alerts: [{ title: 't', body: 'b' }] })).status, 200);
  assert.deepEqual(mutes, [['phone', [{ title: 't', body: 'b' }]]]);
  assert.equal((await auth(request(app).put('/muted-alerts')).send({ alerts: [] })).status, 400);

  const res = await auth(request(app).get('/alert-photo/p1'));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal((await auth(request(app).get('/alert-photo/p2'))).status, 404);
});

test('alert routes without a forwarder: status inactive, the rest 503', async () => {
  const app = createServer({ tokenStore: await freshStore(), authSecret: 'secret123' });
  const auth = (req) => req.set('Authorization', 'Bearer secret123');
  assert.deepEqual((await auth(request(app).get('/alerts/status'))).body, { active: false });
  assert.equal((await auth(request(app).post('/bambuddy/alerts')).send({ title: 't', message: 'm' })).status, 503);
  assert.equal((await auth(request(app).put('/muted-alerts')).send({ token: 'p', alerts: [] })).status, 503);
});
