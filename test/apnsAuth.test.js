const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { ApnsAuthProvider } = require('../src/apnsAuth');

function generateTestKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

test('getToken returns a JWT with the documented ES256 header and claims', () => {
  const { privateKey, publicKey } = generateTestKeyPair();
  let currentTime = 1_700_000_000_000;
  const provider = new ApnsAuthProvider({
    keyPath: '/secrets/AuthKey_TEST.p8',
    keyId: 'KEYID123',
    teamId: '89863526TH',
    now: () => currentTime,
    readKeyFile: () => privateKey,
  });

  const token = provider.getToken();
  const decodedHeader = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(decodedHeader.alg, 'ES256');
  assert.equal(decodedHeader.kid, 'KEYID123');

  const verified = jwt.verify(token, publicKey, { algorithms: ['ES256'] });
  assert.equal(verified.iss, '89863526TH');
  assert.equal(verified.iat, Math.floor(currentTime / 1000));
});

test('getToken reuses the cached token within the 20-minute window', () => {
  const { privateKey } = generateTestKeyPair();
  let currentTime = 1_700_000_000_000;
  const provider = new ApnsAuthProvider({
    keyPath: '/secrets/AuthKey_TEST.p8',
    keyId: 'KEYID123',
    teamId: '89863526TH',
    now: () => currentTime,
    readKeyFile: () => privateKey,
  });

  const first = provider.getToken();
  currentTime += 10 * 60 * 1000; // +10 minutes
  const second = provider.getToken();
  assert.equal(first, second);
});

test('getToken regenerates once 20 minutes have elapsed', () => {
  const { privateKey } = generateTestKeyPair();
  let currentTime = 1_700_000_000_000;
  const provider = new ApnsAuthProvider({
    keyPath: '/secrets/AuthKey_TEST.p8',
    keyId: 'KEYID123',
    teamId: '89863526TH',
    now: () => currentTime,
    readKeyFile: () => privateKey,
  });

  const first = provider.getToken();
  currentTime += 20 * 60 * 1000 + 1; // +20 minutes and 1ms
  const second = provider.getToken();
  assert.notEqual(first, second);
});

test('readKeyFile defaults to reading keyPath from disk', () => {
  const { privateKey } = generateTestKeyPair();
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  const keyPath = path.join(dir, 'AuthKey_TEST.p8');
  fs.writeFileSync(keyPath, privateKey);

  const provider = new ApnsAuthProvider({ keyPath, keyId: 'KEYID123', teamId: '89863526TH' });
  assert.doesNotThrow(() => provider.getToken());
});
