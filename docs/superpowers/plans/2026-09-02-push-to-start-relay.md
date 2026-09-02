# nozzlecast-relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and containerize a standalone Node.js relay that watches Bambuddy's ntfy topic and fires ActivityKit push-to-start APNs requests, so NozzleCast's Live Activity appears the moment a print starts even while the phone is locked.

**Architecture:** One Node process, three cooperating pieces: an ntfy SSE watcher that detects "print started" events, a JSON-file-backed token store of registered devices, and a tiny Express API for token registration. On a detected start event, the watcher builds an ActivityKit push-to-start payload and sends it over HTTP/2 to APNs for every registered token, using a JWT signed with a mounted Apple `.p8` auth key.

**Tech Stack:** Node.js 20, Express, `jsonwebtoken` (ES256 signing), Node's built-in `http2` and `fetch`, Node's built-in `node:test` runner + `node:assert`, `supertest` (dev-only, for HTTP API tests), Docker.

**Spec:** [docs/superpowers/specs/2026-09-02-push-to-start-relay-design.md](../specs/2026-09-02-push-to-start-relay-design.md)

## Global Constraints

- No external database or queue — persistence is a single JSON file (`/data/tokens.json`) on a mounted volume.
- Single Docker service/process — no splitting into multiple containers.
- Config is entirely environment variables plus one mounted secret file (the `.p8` key) — see the spec's Configuration table for exact variable names; do not rename them.
- `apns-topic` must be `${APNS_BUNDLE_ID}.push-type.liveactivity` exactly, per Apple's push-to-start spec.
- Content-state and attributes JSON keys must match `PrintActivityAttributes`/`ContentState`'s Swift property names verbatim (camelCase, no translation) — see spec's Data Flow section for the exact shape.
- No dead-letter queue, no retry scheduler, no CI pipeline — explicitly out of scope per the spec's Non-goals/Testing sections.

---

## File Structure

```
nozzlecast-relay/
  package.json
  Dockerfile
  docker-compose.example.yml
  .env.example
  .dockerignore
  README.md
  src/
    config.js         # env var loading/validation
    parsing.js         # isStartEvent / printerName / normalizedID (ported from Swift)
    dedupe.js           # short-window per-printer start-event dedupe
    payload.js          # push-to-start APNs payload builder
    tokenStore.js        # JSON-file-backed token persistence
    apnsAuth.js          # ES256 JWT provider (20-min cache)
    apnsClient.js         # HTTP/2 APNs sender
    ntfyWatcher.js         # SSE connection + reconnect backoff
    server.js               # Express API (/register, /healthz)
    index.js                 # wiring: loads config, starts watcher + server
  test/
    parsing.test.js
    dedupe.test.js
    payload.test.js
    tokenStore.test.js
    apnsAuth.test.js
    apnsClient.test.js
    server.test.js
```

---

### Task 1: Project scaffolding + config loader

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env) -> { ntfyServer, ntfyTopic, ntfyAuthToken, relayAuthSecret, apnsKeyPath, apnsKeyId, apnsTeamId, apnsBundleId, apnsTopic, dataDir }`. Throws `Error` listing missing var names if any required var is absent.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "nozzlecast-relay",
  "version": "1.0.0",
  "private": true,
  "description": "ActivityKit push-to-start relay for NozzleCast",
  "type": "commonjs",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/",
    "start": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd /Users/hibikipr/Developer/nozzlecast-relay && npm install`
Expected: `package-lock.json` created, `node_modules/` populated, no errors.

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
data/
*.p8
.env
```

- [ ] **Step 4: Write the failing test for `loadConfig`**

Create `test/config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const FULL_ENV = {
  NTFY_SERVER: 'https://ntfy.townsville.cc',
  NTFY_TOPIC: 'townsville-3dprinter',
  NTFY_AUTH_TOKEN: 'tk_test',
  RELAY_AUTH_SECRET: 'secret123',
  APNS_KEY_PATH: '/secrets/AuthKey_TEST.p8',
  APNS_KEY_ID: 'ABC123',
  APNS_TEAM_ID: '89863526TH',
  APNS_BUNDLE_ID: 'com.victormanuel.NozzleCast',
};

test('loadConfig returns normalized config when all vars present', () => {
  const config = loadConfig(FULL_ENV);
  assert.equal(config.ntfyServer, 'https://ntfy.townsville.cc');
  assert.equal(config.ntfyTopic, 'townsville-3dprinter');
  assert.equal(config.ntfyAuthToken, 'tk_test');
  assert.equal(config.relayAuthSecret, 'secret123');
  assert.equal(config.apnsKeyPath, '/secrets/AuthKey_TEST.p8');
  assert.equal(config.apnsKeyId, 'ABC123');
  assert.equal(config.apnsTeamId, '89863526TH');
  assert.equal(config.apnsBundleId, 'com.victormanuel.NozzleCast');
  assert.equal(config.apnsTopic, 'com.victormanuel.NozzleCast.push-type.liveactivity');
  assert.equal(config.dataDir, '/data');
});

test('loadConfig strips a trailing slash from NTFY_SERVER', () => {
  const config = loadConfig({ ...FULL_ENV, NTFY_SERVER: 'https://ntfy.townsville.cc/' });
  assert.equal(config.ntfyServer, 'https://ntfy.townsville.cc');
});

test('loadConfig respects DATA_DIR override', () => {
  const config = loadConfig({ ...FULL_ENV, DATA_DIR: '/custom/data' });
  assert.equal(config.dataDir, '/custom/data');
});

test('loadConfig throws listing every missing required var', () => {
  const { NTFY_SERVER, RELAY_AUTH_SECRET, ...partial } = FULL_ENV;
  assert.throws(
    () => loadConfig(partial),
    /Missing required env vars: NTFY_SERVER, RELAY_AUTH_SECRET/
  );
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config'`

- [ ] **Step 6: Implement `src/config.js`**

```js
const REQUIRED_VARS = [
  'NTFY_SERVER',
  'NTFY_TOPIC',
  'NTFY_AUTH_TOKEN',
  'RELAY_AUTH_SECRET',
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    ntfyServer: env.NTFY_SERVER.replace(/\/$/, ''),
    ntfyTopic: env.NTFY_TOPIC,
    ntfyAuthToken: env.NTFY_AUTH_TOKEN,
    relayAuthSecret: env.RELAY_AUTH_SECRET,
    apnsKeyPath: env.APNS_KEY_PATH,
    apnsKeyId: env.APNS_KEY_ID,
    apnsTeamId: env.APNS_TEAM_ID,
    apnsBundleId: env.APNS_BUNDLE_ID,
    apnsTopic: `${env.APNS_BUNDLE_ID}.push-type.liveactivity`,
    dataDir: env.DATA_DIR || '/data',
  };
}

module.exports = { loadConfig };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all 4 tests in `test/config.test.js`)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore src/config.js test/config.test.js
git commit -m "Add project scaffolding and env config loader"
```

---

### Task 2: Message parsing (ported from NotificationService.swift)

**Files:**
- Create: `src/parsing.js`
- Test: `test/parsing.test.js`

**Interfaces:**
- Produces: `isStartEvent(title: string) -> boolean`, `printerName(message: string) -> string | null`, `normalizedID(name: string) -> string`.

These mirror `isStartEvent(forTitle:)`, `printerName(fromMessage:)`, and `PrintActivityAttributes.normalizedID(_:)` in `NozzleCastNSE/NotificationService.swift` / `NozzleCast/PrintActivityAttributes.swift` in the NozzleCast repo. Keep behavior identical; this is a deliberate duplication (same reasoning as that codebase's own cross-target file duplication), not a shared package.

- [ ] **Step 1: Write the failing tests**

Create `test/parsing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isStartEvent, printerName, normalizedID } = require('../src/parsing');

test('isStartEvent matches Bambuddy\'s "Print Started"', () => {
  assert.equal(isStartEvent('Print Started'), true);
});

test('isStartEvent matches OctoPrint\'s bare "Started"', () => {
  assert.equal(isStartEvent('Started'), true);
});

test('isStartEvent is case-insensitive', () => {
  assert.equal(isStartEvent('PRINT STARTED'), true);
});

test('isStartEvent rejects non-start titles', () => {
  assert.equal(isStartEvent('Print 50% Complete'), false);
  assert.equal(isStartEvent('Bed Cooldown Complete'), false);
  assert.equal(isStartEvent(''), false);
  assert.equal(isStartEvent(undefined), false);
});

test('printerName extracts the prefix before the first colon', () => {
  assert.equal(printerName('Vic H2C: No AMS Version - 0.16mm layer, 2 walls, 15% infill'), 'Vic H2C');
  assert.equal(printerName('sam-p1s: Started'), 'sam-p1s');
});

test('printerName trims whitespace around the name', () => {
  assert.equal(printerName('  Vic H2C  : Started'), 'Vic H2C');
});

test('printerName returns null when there is no colon or the name is empty', () => {
  assert.equal(printerName('no colon here'), null);
  assert.equal(printerName(': Started'), null);
  assert.equal(printerName(''), null);
  assert.equal(printerName(undefined), null);
});

test('normalizedID lowercases and strips non-alphanumerics so both name forms match', () => {
  assert.equal(normalizedID('Vic H2C'), 'vich2c');
  assert.equal(normalizedID('vic-h2c'), 'vich2c');
  assert.equal(normalizedID('Sam P1S'), 'samp1s');
  assert.equal(normalizedID(''), '');
  assert.equal(normalizedID(undefined), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/parsing'`

- [ ] **Step 3: Implement `src/parsing.js`**

```js
function isStartEvent(title) {
  return (title || '').toLowerCase().includes('start');
}

function printerName(message) {
  const text = message || '';
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return null;
  const name = text.slice(0, colonIndex).trim();
  return name.length > 0 ? name : null;
}

function normalizedID(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

module.exports = { isStartEvent, printerName, normalizedID };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/parsing.test.js`, plus Task 1's tests still passing)

- [ ] **Step 5: Commit**

```bash
git add src/parsing.js test/parsing.test.js
git commit -m "Port ntfy title/message parsing logic from NotificationService.swift"
```

---

### Task 3: Start-event dedupe window

**Files:**
- Create: `src/dedupe.js`
- Test: `test/dedupe.test.js`

**Interfaces:**
- Produces: `class StartEventDedupe { constructor({ windowMs = 60000, now = () => Date.now() } = {}); shouldTrigger(printerID: string): boolean }`. `shouldTrigger` returns `true` and records the call the first time a `printerID` is seen (or after `windowMs` has elapsed since its last trigger), `false` otherwise.

**Rationale (not in original spec, needed because real traffic proves it):** Bambuddy and the separate OctoPrint/OctoEverywhere integration both publish to the same ntfy topic and both send a start-shaped title for the same physical print (confirmed in NozzleCast's own message history: Bambuddy's "Print Started" and OctoPrint's bare "Started" for the same `sam-p1s` print, seconds apart). Without a dedupe window, that would fire two push-to-start requests — and two Live Activities — for one print. The existing Swift NSE avoids this by checking `Activity<PrintActivityAttributes>.activities` for an existing match; this relay has no equivalent local ActivityKit state to check, so it uses a short in-memory time window instead.

- [ ] **Step 1: Write the failing tests**

Create `test/dedupe.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { StartEventDedupe } = require('../src/dedupe');

test('shouldTrigger returns true the first time a printer is seen', () => {
  const dedupe = new StartEventDedupe();
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
});

test('shouldTrigger returns false for a repeat within the window', () => {
  let currentTime = 1000;
  const dedupe = new StartEventDedupe({ windowMs: 60000, now: () => currentTime });
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
  currentTime += 5000;
  assert.equal(dedupe.shouldTrigger('samp1s'), false);
});

test('shouldTrigger returns true again once the window has elapsed', () => {
  let currentTime = 1000;
  const dedupe = new StartEventDedupe({ windowMs: 60000, now: () => currentTime });
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
  currentTime += 60001;
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
});

test('shouldTrigger tracks each printerID independently', () => {
  let currentTime = 1000;
  const dedupe = new StartEventDedupe({ windowMs: 60000, now: () => currentTime });
  assert.equal(dedupe.shouldTrigger('samp1s'), true);
  assert.equal(dedupe.shouldTrigger('vich2c'), true);
  currentTime += 5000;
  assert.equal(dedupe.shouldTrigger('samp1s'), false);
  assert.equal(dedupe.shouldTrigger('vich2c'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/dedupe'`

- [ ] **Step 3: Implement `src/dedupe.js`**

```js
class StartEventDedupe {
  constructor({ windowMs = 60000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.lastTriggeredAt = new Map();
  }

  shouldTrigger(printerID) {
    const currentTime = this.now();
    const lastTime = this.lastTriggeredAt.get(printerID);
    if (lastTime !== undefined && currentTime - lastTime < this.windowMs) {
      return false;
    }
    this.lastTriggeredAt.set(printerID, currentTime);
    return true;
  }
}

module.exports = { StartEventDedupe };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/dedupe.test.js`, plus all earlier tasks' tests)

- [ ] **Step 5: Commit**

```bash
git add src/dedupe.js test/dedupe.test.js
git commit -m "Add short-window dedupe for duplicate start events on the same printer"
```

---

### Task 4: Push-to-start payload builder

**Files:**
- Create: `src/payload.js`
- Test: `test/payload.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildPushToStartPayload({ printerID: string, printerName: string, now?: Date }) -> object` matching the exact `aps` shape documented in the spec's Data Flow section.

- [ ] **Step 1: Write the failing tests**

Create `test/payload.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPushToStartPayload } = require('../src/payload');

test('buildPushToStartPayload produces the documented aps shape', () => {
  const now = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C', now });

  assert.equal(payload.aps.event, 'start');
  assert.equal(payload.aps.timestamp, Math.floor(now.getTime() / 1000));
  assert.equal(payload.aps['attributes-type'], 'PrintActivityAttributes');
  assert.deepEqual(payload.aps.attributes, { printerID: 'vich2c', printerName: 'Vic H2C' });
  assert.deepEqual(payload.aps.alert, { title: 'Print Started', body: 'Vic H2C is printing' });
});

test('buildPushToStartPayload content-state matches PrintActivityAttributes.ContentState keys', () => {
  const now = new Date('2026-09-02T13:23:34.000Z');
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C', now });
  const state = payload.aps['content-state'];

  assert.deepEqual(Object.keys(state).sort(), [
    'bedTempC', 'coverImage', 'currentLayer', 'estimatedEndAt', 'jobName',
    'liveSnapshot', 'nozzleTempC', 'progress', 'startedAt', 'stateLabel', 'totalLayers',
  ].sort());
  assert.equal(state.progress, 0);
  assert.equal(state.stateLabel, 'Printing');
  assert.equal(state.startedAt, now.toISOString());
  assert.equal(state.jobName, null);
  assert.equal(state.estimatedEndAt, null);
  assert.equal(state.currentLayer, null);
  assert.equal(state.totalLayers, null);
  assert.equal(state.nozzleTempC, null);
  assert.equal(state.bedTempC, null);
  assert.equal(state.coverImage, null);
  assert.equal(state.liveSnapshot, null);
});

test('buildPushToStartPayload defaults now to the current time', () => {
  const before = Date.now();
  const payload = buildPushToStartPayload({ printerID: 'vich2c', printerName: 'Vic H2C' });
  const after = Date.now();
  assert.ok(payload.aps.timestamp >= Math.floor(before / 1000));
  assert.ok(payload.aps.timestamp <= Math.floor(after / 1000));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/payload'`

- [ ] **Step 3: Implement `src/payload.js`**

```js
function buildContentState(now) {
  return {
    progress: 0,
    stateLabel: 'Printing',
    jobName: null,
    startedAt: now.toISOString(),
    estimatedEndAt: null,
    currentLayer: null,
    totalLayers: null,
    nozzleTempC: null,
    bedTempC: null,
    coverImage: null,
    liveSnapshot: null,
  };
}

function buildPushToStartPayload({ printerID, printerName, now = new Date() }) {
  return {
    aps: {
      timestamp: Math.floor(now.getTime() / 1000),
      event: 'start',
      'content-state': buildContentState(now),
      'attributes-type': 'PrintActivityAttributes',
      attributes: { printerID, printerName },
      alert: { title: 'Print Started', body: `${printerName} is printing` },
    },
  };
}

module.exports = { buildPushToStartPayload };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/payload.test.js`, plus all earlier tasks' tests)

- [ ] **Step 5: Commit**

```bash
git add src/payload.js test/payload.test.js
git commit -m "Add ActivityKit push-to-start payload builder"
```

---

### Task 5: Token store

**Files:**
- Create: `src/tokenStore.js`
- Test: `test/tokenStore.test.js`

**Interfaces:**
- Produces: `class TokenStore { constructor(filePath: string); async load(): Promise<void>; async upsert({ token, environment }): Promise<void>; async remove(token): Promise<void>; list(): Array<{ token, environment, registeredAt }> }`.
- `environment` is `'sandbox' | 'production'`. `list()` reads in-memory state (call `load()` once at startup before serving requests).

- [ ] **Step 1: Write the failing tests**

Create `test/tokenStore.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TokenStore } = require('../src/tokenStore');

async function tempFilePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nozzlecast-relay-test-'));
  return path.join(dir, 'tokens.json');
}

test('load() on a missing file starts with an empty list', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  assert.deepEqual(store.list(), []);
});

test('upsert() adds a token and persists it to disk', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  await store.upsert({ token: 'abc123', environment: 'sandbox' });

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].token, 'abc123');
  assert.equal(store.list()[0].environment, 'sandbox');
  assert.ok(store.list()[0].registeredAt);

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].token, 'abc123');
});

test('upsert() with an existing token updates it in place instead of duplicating', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  await store.upsert({ token: 'abc123', environment: 'sandbox' });
  await store.upsert({ token: 'abc123', environment: 'production' });

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].environment, 'production');
});

test('remove() deletes a token and persists the change', async () => {
  const filePath = await tempFilePath();
  const store = new TokenStore(filePath);
  await store.load();
  await store.upsert({ token: 'abc123', environment: 'sandbox' });
  await store.upsert({ token: 'def456', environment: 'production' });
  await store.remove('abc123');

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].token, 'def456');

  const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(onDisk.length, 1);
});

test('load() reads back tokens written by a previous store instance', async () => {
  const filePath = await tempFilePath();
  const first = new TokenStore(filePath);
  await first.load();
  await first.upsert({ token: 'abc123', environment: 'sandbox' });

  const second = new TokenStore(filePath);
  await second.load();
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].token, 'abc123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/tokenStore'`

- [ ] **Step 3: Implement `src/tokenStore.js`**

```js
const fs = require('node:fs/promises');
const path = require('node:path');

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tokens = new Map();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const entries = JSON.parse(raw);
      this.tokens = new Map(entries.map((entry) => [entry.token, entry]));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.tokens = new Map();
        return;
      }
      throw error;
    }
  }

  async upsert({ token, environment }) {
    const existing = this.tokens.get(token);
    this.tokens.set(token, {
      token,
      environment,
      registeredAt: existing ? existing.registeredAt : new Date().toISOString(),
    });
    await this.save();
  }

  async remove(token) {
    this.tokens.delete(token);
    await this.save();
  }

  list() {
    return Array.from(this.tokens.values());
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.list(), null, 2), 'utf8');
  }
}

module.exports = { TokenStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/tokenStore.test.js`, plus all earlier tasks' tests)

- [ ] **Step 5: Commit**

```bash
git add src/tokenStore.js test/tokenStore.test.js
git commit -m "Add JSON-file-backed token store"
```

---

### Task 6: APNs JWT auth provider

**Files:**
- Create: `src/apnsAuth.js`
- Test: `test/apnsAuth.test.js`

**Interfaces:**
- Produces: `class ApnsAuthProvider { constructor({ keyPath, keyId, teamId, now?: () => number, readKeyFile?: (path) => string }); getToken(): string }`. `getToken()` returns a cached ES256 JWT, regenerating it only once `now()` has advanced 20 minutes past the last signing.

- [ ] **Step 1: Write the failing tests**

Create `test/apnsAuth.test.js`. This generates a real EC P-256 test key pair at test time (via Node's `crypto`) so the test doesn't depend on a checked-in secret, and verifies the signed JWT with `jsonwebtoken`'s own verify:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/apnsAuth'`

- [ ] **Step 3: Implement `src/apnsAuth.js`**

```js
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const TOKEN_LIFETIME_MS = 20 * 60 * 1000;

class ApnsAuthProvider {
  constructor({ keyPath, keyId, teamId, now = () => Date.now(), readKeyFile = (path) => fs.readFileSync(path, 'utf8') }) {
    this.keyPath = keyPath;
    this.keyId = keyId;
    this.teamId = teamId;
    this.now = now;
    this.readKeyFile = readKeyFile;
    this.cachedToken = null;
    this.cachedAt = null;
  }

  getToken() {
    const currentTime = this.now();
    if (this.cachedToken && currentTime - this.cachedAt < TOKEN_LIFETIME_MS) {
      return this.cachedToken;
    }

    const privateKey = this.readKeyFile(this.keyPath);
    this.cachedToken = jwt.sign(
      { iss: this.teamId, iat: Math.floor(currentTime / 1000) },
      privateKey,
      { algorithm: 'ES256', header: { alg: 'ES256', kid: this.keyId } }
    );
    this.cachedAt = currentTime;
    return this.cachedToken;
  }
}

module.exports = { ApnsAuthProvider };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/apnsAuth.test.js`, plus all earlier tasks' tests)

- [ ] **Step 5: Commit**

```bash
git add src/apnsAuth.js test/apnsAuth.test.js
git commit -m "Add ES256 JWT auth provider for APNs, cached for 20 minutes"
```

---

### Task 7: APNs HTTP/2 client

**Files:**
- Create: `src/apnsClient.js`
- Test: `test/apnsClient.test.js`

**Interfaces:**
- Consumes: `ApnsAuthProvider` from Task 6 (`getToken(): string`).
- Produces: `class ApnsClient { constructor({ authProvider, topic, connect? }); async send({ token, environment, payload }): Promise<{ ok: boolean, status: number, shouldRemoveToken: boolean }> }`. `connect` defaults to Node's `http2.connect` and is injectable for testing. `environment` selects `api.push.apple.com` (production) vs `api.sandbox.push.apple.com` (sandbox).

- [ ] **Step 1: Write the failing tests**

Create `test/apnsClient.test.js`. This injects a fake `connect` function that returns a fake HTTP/2 session, so no real network call happens:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ApnsClient } = require('../src/apnsClient');

function fakeAuthProvider(token = 'fake.jwt.token') {
  return { getToken: () => token };
}

function fakeConnectReturning({ status, responseBody = '' }) {
  const calls = [];
  const connect = (origin) => {
    const session = new EventEmitter();
    session.close = () => {};
    session.request = (headers) => {
      calls.push({ origin, headers });
      const stream = new EventEmitter();
      stream.end = () => {
        process.nextTick(() => {
          stream.emit('response', { ':status': status });
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
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.victormanuel.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(calls[0].origin, 'https://api.push.apple.com');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.shouldRemoveToken, false);
});

test('send() posts to the sandbox APNs host for a sandbox token', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.victormanuel.NozzleCast.push-type.liveactivity', connect });

  await client.send({ token: 'devtoken123', environment: 'sandbox', payload: { aps: {} } });

  assert.equal(calls[0].origin, 'https://api.sandbox.push.apple.com');
});

test('send() sets the required headers', async () => {
  const { connect, calls } = fakeConnectReturning({ status: 200 });
  const client = new ApnsClient({ authProvider: fakeAuthProvider('jwt-abc'), topic: 'com.victormanuel.NozzleCast.push-type.liveactivity', connect });

  await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  const headers = calls[0].headers;
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], '/3/device/devtoken123');
  assert.equal(headers['apns-push-type'], 'liveactivity');
  assert.equal(headers['apns-topic'], 'com.victormanuel.NozzleCast.push-type.liveactivity');
  assert.equal(headers['apns-priority'], '10');
  assert.equal(headers['authorization'], 'bearer jwt-abc');
  assert.equal(headers['content-type'], 'application/json');
});

test('send() marks a 400 BadDeviceToken response for removal', async () => {
  const { connect } = fakeConnectReturning({ status: 400, responseBody: '{"reason":"BadDeviceToken"}' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.victormanuel.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.shouldRemoveToken, true);
});

test('send() marks a 410 Unregistered response for removal', async () => {
  const { connect } = fakeConnectReturning({ status: 410, responseBody: '{"reason":"Unregistered"}' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.victormanuel.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.shouldRemoveToken, true);
});

test('send() does not mark a 500 response for removal', async () => {
  const { connect } = fakeConnectReturning({ status: 500, responseBody: '{"reason":"InternalServerError"}' });
  const client = new ApnsClient({ authProvider: fakeAuthProvider(), topic: 'com.victormanuel.NozzleCast.push-type.liveactivity', connect });

  const result = await client.send({ token: 'devtoken123', environment: 'production', payload: { aps: {} } });

  assert.equal(result.ok, false);
  assert.equal(result.shouldRemoveToken, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/apnsClient'`

- [ ] **Step 3: Implement `src/apnsClient.js`**

```js
const http2 = require('node:http2');

const REMOVABLE_STATUSES = new Set([400, 410]);

class ApnsClient {
  constructor({ authProvider, topic, connect = http2.connect }) {
    this.authProvider = authProvider;
    this.topic = topic;
    this.connect = connect;
  }

  async send({ token, environment, payload }) {
    const origin = environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';

    const session = this.connect(origin);
    try {
      return await this._sendOnSession(session, { token, payload });
    } finally {
      session.close();
    }
  }

  _sendOnSession(session, { token, payload }) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        'apns-push-type': 'liveactivity',
        'apns-topic': this.topic,
        'apns-priority': '10',
        authorization: `bearer ${this.authProvider.getToken()}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });

      let status = null;
      let responseBody = '';

      stream.on('response', (headers) => {
        status = headers[':status'];
      });
      stream.on('data', (chunk) => {
        responseBody += chunk.toString();
      });
      stream.on('end', () => {
        resolve({
          ok: status >= 200 && status < 300,
          status,
          shouldRemoveToken: REMOVABLE_STATUSES.has(status),
          body: responseBody,
        });
      });
      stream.on('error', reject);

      stream.end(body);
    });
  }
}

module.exports = { ApnsClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/apnsClient.test.js`, plus all earlier tasks' tests)

- [ ] **Step 5: Commit**

```bash
git add src/apnsClient.js test/apnsClient.test.js
git commit -m "Add HTTP/2 APNs client for push-to-start requests"
```

---

### Task 8: Express registration API

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `TokenStore` from Task 5 (`upsert`, `remove`).
- Produces: `createServer({ tokenStore, authSecret }) -> express.Application`.

- [ ] **Step 1: Add `supertest` and write the failing tests**

`supertest` is already listed in `package.json` from Task 1; confirm it installed (`node_modules/supertest` exists) — if not, run `npm install`.

Create `test/server.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/server'`

- [ ] **Step 3: Implement `src/server.js`**

```js
const express = require('express');

function requireAuth(authSecret) {
  return (req, res, next) => {
    if (req.get('authorization') !== `Bearer ${authSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function createServer({ tokenStore, authSecret }) {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/register', requireAuth(authSecret), async (req, res) => {
    const { token, environment } = req.body || {};
    if (!token || !['sandbox', 'production'].includes(environment)) {
      return res.status(400).json({ error: 'invalid body: require token and environment (sandbox|production)' });
    }
    await tokenStore.upsert({ token, environment });
    res.status(200).json({ ok: true });
  });

  app.delete('/register', requireAuth(authSecret), async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'invalid body: require token' });
    }
    await tokenStore.remove(token);
    res.status(200).json({ ok: true });
  });

  return app;
}

module.exports = { createServer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/server.test.js`, plus all earlier tasks' tests)

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "Add Express registration API for push-to-start tokens"
```

---

### Task 9: ntfy SSE watcher

**Files:**
- Create: `src/ntfyWatcher.js`
- Test: `test/ntfyWatcher.test.js`

**Interfaces:**
- Produces:
  - `parseSseChunk(buffer: string) -> { messages: object[], remainder: string }` — pure function, splits a raw SSE byte chunk into complete `data:` JSON messages plus any incomplete trailing text to prepend to the next chunk.
  - `class NtfyWatcher { constructor({ server, topic, authToken, onMessage, fetchImpl?, backoff? }); start(): void; stop(): void }`. Calls `onMessage(parsedNtfyMessage)` for every ntfy message whose `event` field is `"message"` (ignoring `"open"`/`"keepalive"`). Reconnects with exponential backoff (`backoff.minMs` default 1000, `backoff.maxMs` default 30000) when the connection ends or errors, until `stop()` is called.

- [ ] **Step 1: Write the failing tests for `parseSseChunk`**

Create `test/ntfyWatcher.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSseChunk, NtfyWatcher } = require('../src/ntfyWatcher');

test('parseSseChunk extracts a single complete message', () => {
  const chunk = 'data: {"event":"message","title":"Print Started","message":"Vic H2C: Started"}\n\n';
  const { messages, remainder } = parseSseChunk(chunk);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, 'Print Started');
  assert.equal(remainder, '');
});

test('parseSseChunk extracts multiple messages from one chunk', () => {
  const chunk =
    'data: {"event":"open"}\n\n' +
    'data: {"event":"message","title":"Print Started","message":"Vic H2C: Started"}\n\n';
  const { messages } = parseSseChunk(chunk);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].event, 'open');
  assert.equal(messages[1].event, 'message');
});

test('parseSseChunk carries an incomplete trailing message into remainder', () => {
  const chunk = 'data: {"event":"message","title":"Print S';
  const { messages, remainder } = parseSseChunk(chunk);
  assert.equal(messages.length, 0);
  assert.equal(remainder, chunk);
});

test('parseSseChunk combines a remainder with the next chunk correctly', () => {
  const first = parseSseChunk('data: {"event":"message","tit');
  const second = parseSseChunk(first.remainder + 'le":"Print Started"}\n\n');
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].title, 'Print Started');
});

test('parseSseChunk skips malformed JSON lines without throwing', () => {
  const chunk = 'data: {not valid json}\n\ndata: {"event":"message","title":"OK"}\n\n';
  const { messages } = parseSseChunk(chunk);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, 'OK');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/ntfyWatcher'`

- [ ] **Step 3: Implement `parseSseChunk` in `src/ntfyWatcher.js`**

```js
function parseSseChunk(buffer) {
  const parts = buffer.split('\n\n');
  const remainder = parts.pop();
  const messages = [];

  for (const part of parts) {
    const dataLine = part.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const jsonText = dataLine.slice('data:'.length).trim();
    try {
      messages.push(JSON.parse(jsonText));
    } catch {
      // Skip malformed lines rather than crashing the watcher.
    }
  }

  return { messages, remainder };
}

module.exports = { parseSseChunk };
```

- [ ] **Step 4: Run test to verify `parseSseChunk` tests pass**

Run: `npm test`
Expected: PASS (all 5 `parseSseChunk` tests)

- [ ] **Step 5: Write the failing tests for `NtfyWatcher`'s reconnect behavior**

Append to `test/ntfyWatcher.test.js`. This injects a fake `fetchImpl` that returns a readable stream via an async iterator, so no real network call happens:

```js
function fakeStreamResponse(chunks) {
  return {
    ok: true,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield Buffer.from(chunk);
        }
      },
    },
  };
}

test('NtfyWatcher delivers parsed "message" events to onMessage', async () => {
  const received = [];
  const chunk = 'data: {"event":"message","title":"Print Started","message":"Vic H2C: Started"}\n\n';
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) return fakeStreamResponse([chunk]);
    return new Promise(() => {}); // second connection just hangs, so the test can finish
  };

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: (msg) => received.push(msg),
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  watcher.stop();

  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'Print Started');
});

test('NtfyWatcher ignores non-"message" events', async () => {
  const received = [];
  const chunk = 'data: {"event":"open"}\n\ndata: {"event":"keepalive"}\n\n';
  const fetchImpl = async () => fakeStreamResponse([chunk]);

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: (msg) => received.push(msg),
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  watcher.stop();

  assert.equal(received.length, 0);
});

test('NtfyWatcher reconnects after the stream ends', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount <= 2) return fakeStreamResponse([]); // ends immediately each time
    return new Promise(() => {});
  };

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: () => {},
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  watcher.stop();

  assert.ok(callCount >= 2, `expected at least 2 connection attempts, got ${callCount}`);
});

test('NtfyWatcher sends the auth token as a Bearer header', async () => {
  let capturedUrl = null;
  let capturedHeaders = null;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return new Promise(() => {});
  };

  const watcher = new NtfyWatcher({
    server: 'https://ntfy.townsville.cc',
    topic: 'townsville-3dprinter',
    authToken: 'tk_test',
    onMessage: () => {},
    fetchImpl,
    backoff: { minMs: 5, maxMs: 10 },
  });

  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  watcher.stop();

  assert.equal(capturedUrl, 'https://ntfy.townsville.cc/townsville-3dprinter/sse');
  assert.equal(capturedHeaders.Authorization, 'Bearer tk_test');
});
```

- [ ] **Step 6: Run test to verify the new tests fail**

Run: `npm test`
Expected: FAIL — `NtfyWatcher is not a constructor` (or similar, since only `parseSseChunk` is exported so far)

- [ ] **Step 7: Implement `NtfyWatcher` in `src/ntfyWatcher.js`**

Replace the file's `module.exports` line and append the class above `module.exports`:

```js
class NtfyWatcher {
  constructor({ server, topic, authToken, onMessage, fetchImpl = fetch, backoff = {} }) {
    this.server = server;
    this.topic = topic;
    this.authToken = authToken;
    this.onMessage = onMessage;
    this.fetchImpl = fetchImpl;
    this.minBackoffMs = backoff.minMs ?? 1000;
    this.maxBackoffMs = backoff.maxMs ?? 30000;
    this.stopped = false;
    this.currentBackoffMs = this.minBackoffMs;
  }

  start() {
    this.stopped = false;
    this._connectLoop();
  }

  stop() {
    this.stopped = true;
  }

  async _connectLoop() {
    while (!this.stopped) {
      try {
        await this._connectOnce();
        this.currentBackoffMs = this.minBackoffMs; // reset on a clean connect+stream
      } catch {
        // fall through to backoff/retry below
      }
      if (this.stopped) return;
      await this._sleep(this.currentBackoffMs);
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
    }
  }

  async _connectOnce() {
    const url = `${this.server}/${this.topic}/sse`;
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.authToken}` },
    });

    let remainder = '';
    for await (const chunk of response.body) {
      if (this.stopped) return;
      const { messages, remainder: nextRemainder } = parseSseChunk(remainder + chunk.toString());
      remainder = nextRemainder;
      for (const message of messages) {
        if (message.event === 'message') {
          this.onMessage(message);
        }
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { parseSseChunk, NtfyWatcher };
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests in `test/ntfyWatcher.test.js`, plus all earlier tasks' tests)

- [ ] **Step 9: Commit**

```bash
git add src/ntfyWatcher.js test/ntfyWatcher.test.js
git commit -m "Add ntfy SSE watcher with reconnect backoff"
```

---

### Task 10: Wiring, Docker, and docs

**Files:**
- Create: `src/index.js`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.example.yml`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `isStartEvent`/`printerName`/`normalizedID` (Task 2), `StartEventDedupe` (Task 3), `buildPushToStartPayload` (Task 4), `TokenStore` (Task 5), `ApnsAuthProvider` (Task 6), `ApnsClient` (Task 7), `createServer` (Task 8), `NtfyWatcher` (Task 9).
- Produces: `main()` — the process entry point, run when `src/index.js` is executed directly.

This task has no unit test of its own (it's pure wiring of already-tested pieces); verification is the manual startup check in Step 3 plus the full `npm test` run in Step 6.

- [ ] **Step 1: Implement `src/index.js`**

```js
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('./config');
const { isStartEvent, printerName, normalizedID } = require('./parsing');
const { StartEventDedupe } = require('./dedupe');
const { buildPushToStartPayload } = require('./payload');
const { TokenStore } = require('./tokenStore');
const { ApnsAuthProvider } = require('./apnsAuth');
const { ApnsClient } = require('./apnsClient');
const { createServer } = require('./server');
const { NtfyWatcher } = require('./ntfyWatcher');

async function main() {
  const config = loadConfig();

  const tokenStore = new TokenStore(path.join(config.dataDir, 'tokens.json'));
  await tokenStore.load();

  const authProvider = new ApnsAuthProvider({
    keyPath: config.apnsKeyPath,
    keyId: config.apnsKeyId,
    teamId: config.apnsTeamId,
  });
  const apnsClient = new ApnsClient({ authProvider, topic: config.apnsTopic });
  const dedupe = new StartEventDedupe();

  // Startup auth check: send to a syntactically-valid-but-nonexistent device token. A working
  // key/kid/team-id combination gets a 400 BadDeviceToken (auth succeeded, token just isn't
  // real); a misconfigured one gets 403 InvalidProviderToken. Fail loudly now rather than
  // silently dropping every future push-to-start request.
  const authCheck = await apnsClient.send({
    token: '0'.repeat(64),
    environment: 'production',
    payload: buildPushToStartPayload({ printerID: 'startup-check', printerName: 'startup-check' }),
  });
  if (authCheck.status === 403) {
    console.error(`APNs auth check failed (403 ${authCheck.body}) — check APNS_KEY_ID/APNS_TEAM_ID/APNS_KEY_PATH`);
    process.exit(1);
  }
  console.log(`APNs auth check passed (status ${authCheck.status}, as expected for a fake device token)`);

  const onNtfyMessage = async (message) => {
    if (!isStartEvent(message.title || '')) return;
    const name = printerName(message.message || '');
    if (!name) return;

    const printerID = normalizedID(name);
    if (!dedupe.shouldTrigger(printerID)) return;

    const payload = buildPushToStartPayload({ printerID, printerName: name });
    for (const entry of tokenStore.list()) {
      try {
        const result = await apnsClient.send({ token: entry.token, environment: entry.environment, payload });
        if (result.shouldRemoveToken) {
          await tokenStore.remove(entry.token);
          console.log(`Removed dead token (status ${result.status}): ${entry.token}`);
        } else if (!result.ok) {
          console.error(`Push-to-start send failed (status ${result.status}) for token ${entry.token}: ${result.body}`);
        } else {
          console.log(`Push-to-start sent for printer "${name}" to token ${entry.token}`);
        }
      } catch (error) {
        console.error(`Push-to-start send threw for token ${entry.token}:`, error);
      }
    }
  };

  const watcher = new NtfyWatcher({
    server: config.ntfyServer,
    topic: config.ntfyTopic,
    authToken: config.ntfyAuthToken,
    onMessage: onNtfyMessage,
  });
  watcher.start();

  const app = createServer({ tokenStore, authSecret: config.relayAuthSecret });
  const port = process.env.PORT || 3000;
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`nozzlecast-relay listening on :${port}, watching ${config.ntfyServer}/${config.ntfyTopic}`);
  });

  const shutdown = () => {
    console.log('Shutting down...');
    watcher.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
  });
}

module.exports = { main };
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "src/index.js"]
```

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
test
docs
.git
.env
data
*.p8
```

- [ ] **Step 4: Create `docker-compose.example.yml`**

```yaml
services:
  nozzlecast-relay:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NTFY_SERVER: "https://ntfy.townsville.cc"
      NTFY_TOPIC: "townsville-3dprinter"
      NTFY_AUTH_TOKEN: "${NTFY_AUTH_TOKEN}"
      RELAY_AUTH_SECRET: "${RELAY_AUTH_SECRET}"
      APNS_KEY_PATH: "/secrets/AuthKey.p8"
      APNS_KEY_ID: "${APNS_KEY_ID}"
      APNS_TEAM_ID: "89863526TH"
      APNS_BUNDLE_ID: "com.victormanuel.NozzleCast"
    volumes:
      - ./data:/data
      - ./secrets/AuthKey.p8:/secrets/AuthKey.p8:ro
```

- [ ] **Step 5: Create `.env.example`**

```
NTFY_AUTH_TOKEN=
RELAY_AUTH_SECRET=
APNS_KEY_ID=
```

- [ ] **Step 6: Create `README.md`**

```markdown
# nozzlecast-relay

ActivityKit push-to-start relay for [NozzleCast](https://github.com/hibikipr/NozzleCast). Watches
Bambuddy's ntfy topic directly and fires an APNs push-to-start request the moment a print starts,
so NozzleCast's Live Activity appears even while the phone is locked — something the app's own
Notification Service Extension cannot do (`Activity.request()` only succeeds while the app is
foreground; see NozzleCast's `ARCHITECTURE.md`).

Design: [docs/superpowers/specs/2026-09-02-push-to-start-relay-design.md](docs/superpowers/specs/2026-09-02-push-to-start-relay-design.md)

## Configuration

| Var | Purpose |
|---|---|
| `NTFY_SERVER` | Base URL of the ntfy server |
| `NTFY_TOPIC` | Topic to subscribe to |
| `NTFY_AUTH_TOKEN` | ntfy auth token |
| `RELAY_AUTH_SECRET` | Bearer secret required on `/register` and `DELETE /register` |
| `APNS_KEY_PATH` | Path to the mounted Apple `.p8` auth key |
| `APNS_KEY_ID` | Apple APNs auth key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_BUNDLE_ID` | NozzleCast's bundle ID (relay derives the APNs topic by appending `.push-type.liveactivity`) |
| `DATA_DIR` | Optional, defaults to `/data` |
| `PORT` | Optional, defaults to `3000` |

## Running locally

```bash
npm install
npm test
NTFY_SERVER=... NTFY_TOPIC=... NTFY_AUTH_TOKEN=... RELAY_AUTH_SECRET=... \
  APNS_KEY_PATH=... APNS_KEY_ID=... APNS_TEAM_ID=... APNS_BUNDLE_ID=... \
  npm start
```

## Deploying

Copy `docker-compose.example.yml` to `docker-compose.yml`, put your Apple `.p8` key at
`./secrets/AuthKey.p8`, fill in `.env` (copy from `.env.example`), then:

```bash
docker compose up -d --build
```

## API

- `POST /register` — body `{ "token": string, "environment": "sandbox" | "production" }`,
  `Authorization: Bearer <RELAY_AUTH_SECRET>`.
- `DELETE /register` — body `{ "token": string }`, same auth.
- `GET /healthz` — unauthenticated.
```

- [ ] **Step 7: Manual startup smoke check**

`main()` now performs a real startup APNs auth check (Step 1, added above) before it opens the
HTTP port — with no real Apple `.p8` key available yet, this check can't succeed, so this smoke
test instead confirms wiring reaches that point cleanly (config loads, token store initializes,
APNs client attempts the real network call) rather than a full clean boot. A full green boot is
verified later against real credentials, per the spec's Testing section.

Run:

```bash
NTFY_SERVER=https://example.invalid NTFY_TOPIC=test NTFY_AUTH_TOKEN=x \
  RELAY_AUTH_SECRET=x APNS_KEY_PATH=/dev/null APNS_KEY_ID=x APNS_TEAM_ID=x \
  APNS_BUNDLE_ID=com.victormanuel.NozzleCast PORT=3999 \
  node src/index.js
```

Expected: process runs (doesn't crash on a missing module or syntax error), then fails at the
APNs auth check step with an error originating from `jwt.sign` (invalid key material from
`/dev/null`) — e.g. `Fatal startup error: ... secretOrPrivateKey must be an asymmetric key...`,
then exits. This confirms every module up through `ApnsClient`/`ApnsAuthProvider` wired and
loaded correctly; it does not confirm a full successful boot, which needs real Apple credentials.

- [ ] **Step 8: Run the full test suite one more time**

Run: `npm test`
Expected: PASS — every test file from every task passes together.

- [ ] **Step 9: Commit**

```bash
git add src/index.js Dockerfile .dockerignore docker-compose.example.yml .env.example README.md
git commit -m "Wire relay entry point, add Dockerfile and deployment docs"
```

---

## Post-plan follow-ups (not part of this plan)

These are called out in the spec's "Open questions / follow-ups" and intentionally not tasks here:

- Adding `pushToStartTokenUpdates` observation + `/register` POST to the **NozzleCast** app itself (separate repo, separate change).
- Once the relay is confirmed working end-to-end, removing the NSE's now-redundant `Activity.request()` start attempt and `NCDEBUG` logging from `NozzleCastNSE/NotificationService.swift`, and updating NozzleCast's `ARCHITECTURE.md` accordingly.
