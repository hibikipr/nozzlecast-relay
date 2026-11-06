const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AlertForwarder } = require('../src/alertForwarder');

const MQTT_TITLE = 'Printer Error: Nozzle/Extruder Error';
const MQTT_BODY = 'Sam P1S\nMQTT Command verification failed.';

function fakeDevices(tokens) {
  const store = new Map(tokens.map((token) => [token, { token, environment: 'production' }]));
  return { list: () => [...store.values()], remove: async (token) => { store.delete(token); } };
}

function fakeApns(results = {}) {
  const sent = [];
  const client = {
    send: async (request) => {
      sent.push(request);
      return results[request.token] ?? { ok: true, status: 200 };
    },
  };
  return { sent, clients: { production: client, sandbox: client } };
}

async function freshForwarder(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const forwarder = new AlertForwarder({
    filePath: path.join(dir, 'alerts.json'),
    bundleId: 'com.victormanuel.NozzleCast',
    setTimeoutImpl: () => {},
    ...options,
  });
  await forwarder.load();
  return { forwarder, dir };
}

test('an alert is pushed to every device that has not muted it', async () => {
  const apns = fakeApns();
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices(['phone', 'ipad']), apnsClients: apns.clients });
  await forwarder.setMutes('ipad', [{ title: MQTT_TITLE, body: MQTT_BODY }]);

  const sent = await forwarder.receive({ title: MQTT_TITLE, message: MQTT_BODY, event: 'printer_error', printer: 'Sam P1S' });
  assert.equal(sent, 1);
  assert.equal(apns.sent.length, 1);
  const [push] = apns.sent;
  assert.equal(push.token, 'phone');
  assert.equal(push.pushType, 'alert');
  assert.equal(push.topic, 'com.victormanuel.NozzleCast');
  assert.deepEqual(push.payload.aps.alert, { title: MQTT_TITLE, body: MQTT_BODY });
  assert.equal(push.payload.aps['mutable-content'], 1);
  assert.equal(push.payload.aps['interruption-level'], 'time-sensitive');
  assert.equal(push.payload.nozzlecast.printer, 'Sam P1S');
  assert.equal(push.payload.nozzlecast.photoID, null);
});

test('a routine alert is active, not time-sensitive', async () => {
  const apns = fakeApns();
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices(['phone']), apnsClients: apns.clients });
  await forwarder.receive({ title: 'Print 50% Complete', message: 'Vic H2C', event: 'print_progress' });
  assert.equal(apns.sent[0].payload.aps['interruption-level'], 'active');
});

test("the webhook's photo is kept for the extension to fetch", async () => {
  const apns = fakeApns();
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices(['phone']), apnsClients: apns.clients });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await forwarder.receive({ title: 'Print Completed', message: 'Vic H2C', image: jpeg.toString('base64') });
  const { photoID } = apns.sent[0].payload.nozzlecast;
  assert.ok(photoID);
  const photo = await forwarder.photo(photoID);
  assert.deepEqual(photo.data, jpeg);
  assert.equal(photo.contentType, 'image/jpeg');
  assert.equal(await forwarder.photo('nope'), null);
});

test('a long alert is cut for the push and still matches a mute of the cut text', async () => {
  const apns = fakeApns();
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices(['phone']), apnsClients: apns.clients });
  const long = 'x'.repeat(3000);
  await forwarder.receive({ title: 'Long', message: long });
  const shown = apns.sent[0].payload.aps.alert.body;
  assert.ok(shown.length <= 1500);

  await forwarder.setMutes('phone', [{ title: 'Long', body: shown }]);
  await forwarder.receive({ title: 'Long', message: long });
  assert.equal(apns.sent.length, 1);
});

test('a dead device token is dropped', async () => {
  const devices = fakeDevices(['gone', 'phone']);
  const apns = fakeApns({ gone: { ok: false, status: 410, shouldRemoveToken: true } });
  const { forwarder } = await freshForwarder({ deviceTokenStore: devices, apnsClients: apns.clients });
  assert.equal(await forwarder.receive({ title: 't', message: 'm' }), 1);
  assert.deepEqual(devices.list().map((entry) => entry.token), ['phone']);
});

test('the first webhook makes forwarding active, and that and the mutes survive a restart', async () => {
  const apns = fakeApns();
  const { forwarder, dir } = await freshForwarder({ deviceTokenStore: fakeDevices([]), apnsClients: apns.clients });
  assert.equal(forwarder.isActive(), false);
  await forwarder.setMutes('phone', [{ title: MQTT_TITLE, body: MQTT_BODY }, { title: 1, body: 'bad' }]);
  await forwarder.receive({ title: 'Test', message: 'from Bambuddy', event: 'test' });
  assert.equal(forwarder.isActive(), true);

  const reloaded = new AlertForwarder({ filePath: path.join(dir, 'alerts.json'), deviceTokenStore: fakeDevices([]), apnsClients: apns.clients, bundleId: 'b' });
  await reloaded.load();
  assert.equal(reloaded.isActive(), true);
  assert.equal(reloaded.isMuted('phone', MQTT_TITLE, MQTT_BODY), true);
  assert.equal(reloaded.state.mutes.phone.length, 1);

  await reloaded.setMutes('phone', []);
  assert.equal(reloaded.isMuted('phone', MQTT_TITLE, MQTT_BODY), false);
});

test("the relay learns its webhook provider from Bambuddy's log, then catches up only its failed sends", async () => {
  const apns = fakeApns();
  const logs = [
    { id: 10, provider_id: 7, provider_type: 'webhook', provider_name: 'NozzleCast relay', title: 'Test', message: 'm', success: true },
    { id: 9, provider_id: 3, provider_type: 'webhook', title: 'Test', message: 'other', success: true },
  ];
  const bambuddyClient = { notificationLogs: async () => logs };
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices(['phone']), apnsClients: apns.clients, bambuddyClient });

  assert.equal(await forwarder.catchUp(), 0); // provider not known yet
  await forwarder.receive({ title: 'Test', message: 'm' });
  await forwarder.learnProvider('Test', 'm');
  assert.equal(forwarder.state.providerId, 7);
  assert.equal(forwarder.state.logCursor, 10);

  logs.unshift(
    { id: 13, provider_id: 3, provider_type: 'webhook', title: 'Other webhook', message: 'x', success: false },
    { id: 12, provider_id: 7, provider_type: 'webhook', title: 'Print Failed', message: 'Vic H2C', event_type: 'print_failed', printer_name: 'Vic H2C', success: false },
    { id: 11, provider_id: 7, provider_type: 'webhook', title: 'Delivered', message: 'ok', success: true },
  );
  apns.sent.length = 0;
  assert.equal(await forwarder.catchUp(), 1);
  assert.deepEqual(apns.sent.map((push) => push.payload.aps.alert.title), ['Print Failed']);
  assert.equal(apns.sent[0].payload.aps['interruption-level'], 'time-sensitive');

  // Nothing is sent twice.
  assert.equal(await forwarder.catchUp(), 0);
});

test("a key that can't read Bambuddy's log turns catch-up off quietly", async () => {
  let calls = 0;
  const bambuddyClient = { notificationLogs: async () => { calls += 1; throw new Error('Bambuddy request to /api/v1/notifications/logs?limit=50 failed with status 403'); } };
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices([]), apnsClients: fakeApns().clients, bambuddyClient });
  await forwarder.learnProvider('t', 'm');
  await forwarder.learnProvider('t', 'm');
  assert.equal(calls, 1);
  assert.equal(forwarder.state.providerId, null);
});

test('a large webhook photo is kept shrunk to fit 1280 px as JPEG', async () => {
  const sharp = require('sharp');
  const apns = fakeApns();
  const { forwarder } = await freshForwarder({ deviceTokenStore: fakeDevices(['phone']), apnsClients: apns.clients });
  // A 1920x1080 noisy frame, like an H2C chamber snapshot.
  const pixels = Buffer.alloc(1920 * 1080 * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
  const frame = await sharp(pixels, { raw: { width: 1920, height: 1080, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

  await forwarder.receive({ title: 'Print 50% Complete', message: 'Vic H2C', image: frame.toString('base64') });
  const photo = await forwarder.photo(apns.sent[0].payload.nozzlecast.photoID);
  const meta = await sharp(photo.data).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);
  assert.ok(photo.data.length < frame.length);
  assert.equal(photo.contentType, 'image/jpeg');
});

// The feed: what the app fetches with GET /alerts (the only way alerts reach it without APNs).
function feedForwarder(dir, options = {}) {
  return new AlertForwarder({
    filePath: path.join(dir, 'alerts.json'),
    feedPath: path.join(dir, 'alert-feed.json'),
    photoDir: path.join(dir, 'alert-photos'),
    deviceTokenStore: fakeDevices([]),
    apnsClients: null,
    bundleId: null,
    setTimeoutImpl: () => {},
    ...options,
  });
}

test('without Apple push keys an alert is kept in the feed, not pushed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const forwarder = feedForwarder(dir);
  await forwarder.load();
  assert.equal(forwarder.pushesEnabled(), false);

  assert.equal(await forwarder.receive({ title: MQTT_TITLE, message: MQTT_BODY, event: 'printer_error', printer: 'Sam P1S' }), 0);
  assert.deepEqual(forwarder.feedFor('phone', null), { items: [], latestId: 1 });
  const { items, latestId } = forwarder.feedFor('phone', 0);
  assert.equal(latestId, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1);
  assert.equal(items[0].title, MQTT_TITLE);
  assert.equal(items[0].body, MQTT_BODY);
  assert.equal(items[0].printer, 'Sam P1S');
  assert.equal(items[0].timeSensitive, true);
  assert.equal(items[0].photoID, null);
  assert.deepEqual(forwarder.feedFor('phone', 1).items, []);
});

test("the feed leaves out a device's muted alerts, for that device only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const forwarder = feedForwarder(dir);
  await forwarder.load();
  await forwarder.setMutes('device-a', [{ title: MQTT_TITLE, body: MQTT_BODY }]);
  await forwarder.receive({ title: MQTT_TITLE, message: MQTT_BODY, event: 'printer_error' });
  await forwarder.receive({ title: 'Print Completed', message: 'Vic H2C', event: 'print_complete' });

  assert.deepEqual(forwarder.feedFor('device-a', 0).items.map((item) => item.title), ['Print Completed']);
  assert.deepEqual(forwarder.feedFor('device-b', 0).items.map((item) => item.title), [MQTT_TITLE, 'Print Completed']);
  assert.equal(forwarder.feedFor('device-a', 0).items[0].timeSensitive, false);
});

test('a long alert in the feed is cut and still matches a mute of the cut text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const forwarder = feedForwarder(dir);
  await forwarder.load();
  const long = 'x'.repeat(4000);
  await forwarder.receive({ title: 'Long', message: long });
  const [item] = forwarder.feedFor('phone', 0).items;
  assert.equal(item.body.length, 1500);
  await forwarder.setMutes('phone', [{ title: 'Long', body: item.body }]);
  assert.deepEqual(forwarder.feedFor('phone', 0).items, []);
});

test('the feed and its photos survive a restart; old items and their photos are dropped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  let clock = Date.UTC(2026, 10, 1);
  const forwarder = feedForwarder(dir, { now: () => clock });
  await forwarder.load();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await forwarder.receive({ title: 'Print Completed', message: 'Vic H2C', image: jpeg.toString('base64') });
  const [{ photoID }] = forwarder.feedFor('phone', 0).items;
  assert.ok(photoID);

  const restarted = feedForwarder(dir, { now: () => clock });
  await restarted.load();
  assert.equal(restarted.feedFor('phone', 0).items.length, 1);
  assert.deepEqual((await restarted.photo(photoID)).data, jpeg);
  assert.equal(await restarted.photo('../alerts'), null);

  // Eight days on, the next alert pushes the old one (and its photo) out.
  clock += 8 * 24 * 60 * 60 * 1000;
  await restarted.receive({ title: 'Print Started', message: 'Vic H2C' });
  assert.deepEqual(restarted.feedFor('phone', 0).items.map((item) => item.id), [2]);
  assert.equal(await restarted.photo(photoID), null);
  assert.deepEqual(await fs.readdir(path.join(dir, 'alert-photos')), []);
});

test('the feed keeps only its newest 200 alerts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const forwarder = feedForwarder(dir);
  await forwarder.load();
  for (let i = 0; i < 205; i += 1) await forwarder.receive({ title: `Alert ${i}`, message: 'm' });
  const { items, latestId } = forwarder.feedFor(null, 0);
  assert.equal(items.length, 200);
  assert.equal(items[0].id, 6);
  assert.equal(latestId, 205);
});

test('alerts caught up from the log go into the feed too', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const rows = [{ id: 11, provider_id: 4, provider_type: 'webhook', success: false, title: 'Print Failed', message: 'Sam P1S', event_type: 'print_failed', printer_name: 'Sam P1S' }];
  const forwarder = feedForwarder(dir, { bambuddyClient: { notificationLogs: async () => rows } });
  await forwarder.load();
  forwarder.state.providerId = 4;
  forwarder.state.logCursor = 10;
  assert.equal(await forwarder.catchUp(), 1);
  const [item] = forwarder.feedFor('phone', 0).items;
  assert.equal(item.title, 'Print Failed');
  assert.equal(item.printer, 'Sam P1S');
  assert.equal(item.timeSensitive, true);
});

test('with Apple push keys an alert is pushed and kept in the feed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alerts-'));
  const apns = fakeApns();
  const forwarder = feedForwarder(dir, { deviceTokenStore: fakeDevices(['phone']), apnsClients: apns.clients, bundleId: 'com.victormanuel.NozzleCast' });
  await forwarder.load();
  assert.equal(await forwarder.receive({ title: 'Print Completed', message: 'Vic H2C' }), 1);
  assert.equal(forwarder.feedFor('phone', 0).items.length, 1);
});
