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
  const photo = forwarder.photo(photoID);
  assert.deepEqual(photo.data, jpeg);
  assert.equal(photo.contentType, 'image/jpeg');
  assert.equal(forwarder.photo('nope'), null);
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
