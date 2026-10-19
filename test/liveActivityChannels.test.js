const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { ApnsClient } = require('../src/apnsClient');
const { ActivityTokenStore } = require('../src/activityTokenStore');
const { WakeRetryPolicy } = require('../src/wakeRetryPolicy');
const { buildPushToStartPayload } = require('../src/payload');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');
const {
  openPrintChannels, broadcastToChannels, deleteChannels, deleteOrphanChannels,
} = require('../src/liveActivityChannels');

// A fake http2.connect whose every stream answers with `respond(call)`'s result, recording what
// was requested (origin, headers, body).
function fakeConnect(respond) {
  const calls = [];
  const connect = (origin) => {
    const session = new EventEmitter();
    session.close = () => {};
    session.request = (headers) => {
      const call = { origin, headers, body: null };
      calls.push(call);
      const stream = new EventEmitter();
      stream.end = (body) => {
        call.body = body ?? null;
        process.nextTick(() => {
          const { status, headers: responseHeaders = {}, body: responseBody = '' } = respond(call);
          stream.emit('response', { ':status': status, ...responseHeaders });
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

function client(respond) {
  const fake = fakeConnect(respond);
  const apns = new ApnsClient({
    authProvider: { getToken: () => 'jwt' },
    topic: 'com.example.App.push-type.liveactivity',
    bundleId: 'com.example.App',
    connect: fake.connect,
  });
  return { apns, calls: fake.calls };
}

async function freshActivityStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  const store = new ActivityTokenStore(path.join(dir, 'activity-tokens.json'));
  await store.load();
  return store;
}

// --- ApnsClient channel API ---

test('createChannel POSTs a no-storage LiveActivity channel to the management host and returns its id', async () => {
  const { apns, calls } = client(() => ({ status: 201, headers: { 'apns-channel-id': 'Y2hhbg==' } }));
  const channelId = await apns.createChannel({ environment: 'production' });

  assert.equal(channelId, 'Y2hhbg==');
  assert.equal(calls[0].origin, 'https://api-manage-broadcast.push.apple.com:2196');
  assert.equal(calls[0].headers[':method'], 'POST');
  assert.equal(calls[0].headers[':path'], '/1/apps/com.example.App/channels');
  assert.equal(calls[0].headers.authorization, 'bearer jwt');
  assert.deepEqual(JSON.parse(calls[0].body), { 'message-storage-policy': 0, 'push-type': 'LiveActivity' });
});

test('createChannel uses the sandbox management host and port for sandbox', async () => {
  const { apns, calls } = client(() => ({ status: 201, headers: { 'apns-channel-id': 'c' } }));
  await apns.createChannel({ environment: 'sandbox' });
  assert.equal(calls[0].origin, 'https://api-manage-broadcast.sandbox.push.apple.com:2195');
});

test('createChannel throws on a non-201 (e.g. Broadcast not enabled for the App ID)', async () => {
  const { apns } = client(() => ({ status: 403, body: '{"reason":"TopicDisallowed"}' }));
  await assert.rejects(apns.createChannel({ environment: 'production' }), /status 403.*TopicDisallowed/);
});

test('deleteChannel sends DELETE with the channel id header and no body', async () => {
  const { apns, calls } = client(() => ({ status: 204 }));
  await apns.deleteChannel({ environment: 'production', channelId: 'Y2hhbg==' });

  assert.equal(calls[0].headers[':method'], 'DELETE');
  assert.equal(calls[0].headers[':path'], '/1/apps/com.example.App/channels');
  assert.equal(calls[0].headers['apns-channel-id'], 'Y2hhbg==');
  assert.equal(calls[0].headers['content-length'], undefined);
  assert.equal(calls[0].body, null);
});

test('listChannels returns the channels array from all-channels', async () => {
  const { apns, calls } = client(() => ({ status: 200, body: '{"channels":["a","b"]}' }));
  assert.deepEqual(await apns.listChannels({ environment: 'sandbox' }), ['a', 'b']);
  assert.equal(calls[0].headers[':path'], '/1/apps/com.example.App/all-channels');
  assert.equal(calls[0].headers[':method'], 'GET');
});

test('broadcast POSTs to the broadcast host with channel, push-type, priority and zero expiration', async () => {
  const { apns, calls } = client(() => ({ status: 200, headers: { 'apns-unique-id': 'uid-1' } }));
  const payload = { aps: { event: 'update' } };
  const result = await apns.broadcast({ channelId: 'Y2hhbg==', environment: 'production', payload, priority: 5 });

  assert.deepEqual({ ok: result.ok, status: result.status, apnsId: result.apnsId }, { ok: true, status: 200, apnsId: 'uid-1' });
  assert.equal(calls[0].origin, 'https://api-broadcast.push.apple.com');
  assert.equal(calls[0].headers[':path'], '/4/broadcasts/apps/com.example.App');
  assert.equal(calls[0].headers['apns-channel-id'], 'Y2hhbg==');
  assert.equal(calls[0].headers['apns-push-type'], 'liveactivity');
  assert.equal(calls[0].headers['apns-priority'], '5');
  assert.equal(calls[0].headers['apns-expiration'], '0');
  assert.equal(calls[0].headers['apns-topic'], undefined);
  assert.deepEqual(JSON.parse(calls[0].body), payload);
});

test('broadcast to sandbox uses the sandbox broadcast host and defaults to priority 10', async () => {
  const { apns, calls } = client(() => ({ status: 200 }));
  await apns.broadcast({ channelId: 'c', environment: 'sandbox', payload: {} });
  assert.equal(calls[0].origin, 'https://api-broadcast.sandbox.push.apple.com');
  assert.equal(calls[0].headers['apns-priority'], '10');
});

// --- liveActivityChannels ---

function fakeClients(overrides = {}) {
  const log = [];
  const make = (environment) => ({
    createChannel: async () => {
      log.push(['create', environment]);
      if (overrides.createFails?.includes(environment)) throw new Error('403 TopicDisallowed');
      return `${environment}-chan`;
    },
    broadcast: async ({ channelId, priority }) => {
      log.push(['broadcast', environment, channelId, priority]);
      return { ok: true, status: 200, apnsId: 'u' };
    },
    deleteChannel: async ({ channelId }) => {
      log.push(['delete', environment, channelId]);
      if (overrides.deleteFails) throw new Error('boom');
    },
    listChannels: async () => overrides.listed?.[environment] ?? [],
  });
  return { apnsClients: { sandbox: make('sandbox'), production: make('production') }, log };
}

test('openPrintChannels creates one channel per environment and leaves out ones that fail', async () => {
  const { apnsClients } = fakeClients({ createFails: ['sandbox'] });
  const channels = await openPrintChannels({ apnsClients, environments: ['production', 'sandbox'], name: 'Sam P1S' });
  assert.deepEqual(channels, [{ environment: 'production', channelId: 'production-chan' }]);
});

test('broadcastToChannels publishes once per channel with the given priority', async () => {
  const { apnsClients, log } = fakeClients();
  await broadcastToChannels({
    apnsClients,
    channels: [{ environment: 'production', channelId: 'p' }, { environment: 'sandbox', channelId: 's' }],
    payload: {},
    priority: 5,
    name: 'Sam P1S',
    event: 'update',
    progress: 0.5,
  });
  assert.deepEqual(log, [['broadcast', 'production', 'p', 5], ['broadcast', 'sandbox', 's', 5]]);
});

test('broadcastToChannels never throws when a send throws', async () => {
  const apnsClients = { production: { broadcast: async () => { throw new Error('ECONNRESET'); } } };
  await broadcastToChannels({ apnsClients, channels: [{ environment: 'production', channelId: 'p' }], payload: {}, name: 'x', event: 'update' });
});

test('deleteChannels keeps going past a failed delete', async () => {
  const { apnsClients, log } = fakeClients({ deleteFails: true });
  await deleteChannels({ apnsClients, channels: [{ environment: 'production', channelId: 'a' }, { environment: 'production', channelId: 'b' }] });
  assert.deepEqual(log, [['delete', 'production', 'a'], ['delete', 'production', 'b']]);
});

test('deleteOrphanChannels deletes only listed channels nothing references, per environment', async () => {
  const { apnsClients, log } = fakeClients({ listed: { production: ['keep', 'orphan'], sandbox: ['keep'] } });
  await deleteOrphanChannels({ apnsClients, keep: [{ environment: 'production', channelId: 'keep' }] });
  // "keep" is only referenced in production, so the sandbox channel of the same id is an orphan.
  assert.deepEqual(log, [['delete', 'sandbox', 'keep'], ['delete', 'production', 'orphan']]);
});

// --- ActivityTokenStore channel state ---

test('ActivityTokenStore tracks a print\'s channels until its end, and startPrint resets them', async () => {
  const store = await freshActivityStore();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-10-18T23:41:00.000Z' });
  const channels = [{ environment: 'production', channelId: 'p' }];
  await store.setChannels('samp1s', channels);
  assert.deepEqual(store.activeChannelsFor('samp1s'), channels);

  await store.endChannels('samp1s');
  assert.deepEqual(store.activeChannelsFor('samp1s'), []);
  // Still referenced (not yet deleted at APNs), so orphan cleanup must keep it.
  assert.deepEqual(store.allChannels(), channels);

  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-10-19T01:00:00.000Z' });
  assert.deepEqual(store.allChannels(), []);
});

test('ActivityTokenStore keeps channels when a device registers a token, and persists them', async () => {
  const store = await freshActivityStore();
  await store.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-10-18T23:41:00.000Z' });
  await store.setChannels('samp1s', [{ environment: 'production', channelId: 'p' }]);
  await store.registerToken({ printerID: 'samp1s', token: 't1', environment: 'sandbox' });

  const reloaded = new ActivityTokenStore(store.filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.activeChannelsFor('samp1s'), [{ environment: 'production', channelId: 'p' }]);
  assert.equal(reloaded.tokensFor('samp1s').length, 1);
});

test('ActivityTokenStore entries written before channels existed have none', async () => {
  const store = await freshActivityStore();
  await fs.writeFile(store.filePath, JSON.stringify([{ printerID: 'vich2c', startedAt: null, tokens: [] }]));
  await store.load();
  assert.deepEqual(store.activeChannelsFor('vich2c'), []);
  assert.deepEqual(store.allChannels(), []);
});

// --- wake retries, payload, config, server ---

test('WakeRetryPolicy never retries when no token-mode device is expected', () => {
  const policy = new WakeRetryPolicy({ now: () => 10 * 60 * 60 * 1000 });
  policy.startPrint('samp1s', 0);
  assert.equal(policy.check('samp1s', 0), null);
});

test('buildPushToStartPayload adds input-push-channel only when given a channel', () => {
  const withChannel = buildPushToStartPayload({ printerID: 'samp1s', printerName: 'Sam P1S', inputPushChannel: 'Y2hhbg==' });
  assert.equal(withChannel.aps['input-push-channel'], 'Y2hhbg==');
  const without = buildPushToStartPayload({ printerID: 'samp1s', printerName: 'Sam P1S' });
  assert.equal('input-push-channel' in without.aps, false);
});

test('loadConfig enables channels only for LIVE_ACTIVITY_CHANNELS=true', () => {
  const env = {
    RELAY_AUTH_SECRET: 's', APNS_KEY_PATH: 'k', APNS_KEY_ID: 'i', APNS_SANDBOX_KEY_PATH: 'k', APNS_SANDBOX_KEY_ID: 'i',
    APNS_TEAM_ID: 't', APNS_BUNDLE_ID: 'b', BAMBUDDY_URL: 'http://x', BAMBUDDY_API_KEY: 'a',
  };
  assert.equal(loadConfig(env).liveActivityChannels, false);
  assert.equal(loadConfig({ ...env, LIVE_ACTIVITY_CHANNELS: 'true' }).liveActivityChannels, true);
});

test('GET /channel/:printerID returns the print\'s active channels, 404 after its end, 401 without auth', async () => {
  const activityTokenStore = await freshActivityStore();
  await activityTokenStore.startPrint({ printerID: 'samp1s', printerName: 'Sam P1S', startedAt: '2026-10-18T23:41:00.000Z' });
  await activityTokenStore.setChannels('samp1s', [{ environment: 'production', channelId: 'p' }]);
  const app = createServer({ activityTokenStore, authSecret: 'secret123' });

  assert.equal((await request(app).get('/channel/samp1s')).status, 401);

  const ok = await request(app).get('/channel/samp1s').set('Authorization', 'Bearer secret123');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { channels: [{ environment: 'production', channelId: 'p' }] });

  await activityTokenStore.endChannels('samp1s');
  assert.equal((await request(app).get('/channel/samp1s').set('Authorization', 'Bearer secret123')).status, 404);
  assert.equal((await request(app).get('/channel/nope').set('Authorization', 'Bearer secret123')).status, 404);
});
