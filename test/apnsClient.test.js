const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ApnsClient } = require('../src/apnsClient');

function fakeAuthProvider(token = 'fake.jwt.token') {
  return { getToken: () => token };
}

function fakeConnectReturning({ status, responseBody = '', apnsId = null }) {
  const calls = [];
  const connect = (origin) => {
    const session = new EventEmitter();
    session.close = () => {};
    session.request = (headers) => {
      calls.push({ origin, headers });
      const stream = new EventEmitter();
      stream.end = () => {
        process.nextTick(() => {
          stream.emit('response', apnsId ? { ':status': status, 'apns-id': apnsId } : { ':status': status });
          if (responseBody) stream.emit('data', Buffer.from(responseBody));
          stream.emit('end');
        });
      };
      return stream;
    };
    return session;
  };
  return { connect, calls };
}

test('send() posts to the production APNs host for a production token', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(calls[0].origin, 'https://api.push.apple.com');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.shouldRemoveToken, false);
});

test('send() posts to the sandbox APNs host for a sandbox token', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  await client.send({ token: 'devtoken123', environment: 'sandbox', payload: { aps: {} } });

  assert.equal(calls[0].origin, 'https://api.sandbox.push.apple.com');
});

test('send() sets the required headers', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider('jwt-abc'), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  const headers = calls[0].headers;
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], '/3/device/devtoken123');
  assert.equal(headers['apns-push-type'], 'liveactivity');
  assert.equal(headers['apns-topic'], 'com.example.NozzleCast.push-type.liveactivity');
  assert.equal(headers['apns-priority'], '10');
  assert.equal(headers['authorization'], 'bearer jwt-abc');
  assert.equal(headers['content-type'], 'application/json');
});

test('send() uses the liveactivity push-type and configured topic by default', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(calls[0].headers['apns-push-type'], 'liveactivity');
  assert.equal(calls[0].headers['apns-topic'], 'com.example.NozzleCast.push-type.liveactivity');
});

test('send() honors an explicit pushType/topic override for a plain background push', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  await client.send({
    token: 'devtoken123',
    environment: 'production',
    payload: { aps: { 'content-available': 1 } },
    pushType: 'background',
    topic: 'com.example.NozzleCast',
  });

  assert.equal(calls[0].headers['apns-push-type'], 'background');
  assert.equal(calls[0].headers['apns-topic'], 'com.example.NozzleCast');
  // APNs rejects a background push sent at priority 10 outright (400 BadPriority) -- 5 is the
  // only value it accepts for this push type.
  assert.equal(calls[0].headers['apns-priority'], '5');
});

test('send() keeps priority 10 for a liveactivity push', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  await client.send({ token: 'abc123', environment: 'production', payload: { aps: {} } });

  assert.equal(calls[0].headers['apns-priority'], '10');
});

test('send() marks a 400 BadDeviceToken response for removal', async () => {
  const { connect } = fakeConnectReturning({ status: 400, responseBody: '{"reason":"BadDeviceToken"}' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.shouldRemoveToken, true);
});

test('send() marks a 410 Unregistered response for removal', async () => {
  const { connect } = fakeConnectReturning({ status: 410, responseBody: '{"reason":"Unregistered"}' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.shouldRemoveToken, true);
});

test('send() does not mark a 500 response for removal', async () => {
  const { connect } = fakeConnectReturning({ status: 500, responseBody: '{"reason":"InternalServerError"}' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.ok, false);
  assert.equal(result.shouldRemoveToken, false);
});

test('send() rejects instead of crashing when the HTTP/2 session itself emits an error', async () => {
  let destroyed = false;
  let closed = false;
  const connect = () => {
    const session = new EventEmitter();
    session.close = () => {
      closed = true;
    };
    session.destroy = () => {
      destroyed = true;
    };
    session.request = () => {
      const stream = new EventEmitter();
      stream.end = () => {
        // Never emits a stream response — instead the session itself errors out,
        // simulating a DNS failure / TLS failure / network hiccup at the session level.
        process.nextTick(() => {
          session.emit('error', new Error('session error: getaddrinfo ENOTFOUND'));
        });
      };
      return stream;
    };
    return session;
  };
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  await assert.rejects(
    client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } }),
    /session error/,
  );
  assert.equal(destroyed, true);
  assert.equal(closed, false);
});

// APNs returns 200 for a Live Activity token whose activity has already ended, right through its
// dismissal window -- the push is simply discarded on-device with no signal back here. `apns-id`
// is the only handle that ties a relay log line to Apple's own delivery record for that push, so
// without it there is no way to investigate an update the device never applied.
test('send() surfaces the apns-id header so a push can be correlated with Apple\'s delivery record', async () => {
  const { connect } = fakeConnectReturning({ status: 200, apnsId: '8A9B7C6D-1E2F-3A4B-5C6D-7E8F9A0B1C2D' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.apnsId, '8A9B7C6D-1E2F-3A4B-5C6D-7E8F9A0B1C2D');
});

test('send() reports apnsId as null when APNs returns no apns-id header', async () => {
  const { connect } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.example.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.apnsId, null);
});
