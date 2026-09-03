const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const { TokenStore } = require('../src/tokenStore');

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
