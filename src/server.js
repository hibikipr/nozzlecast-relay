const crypto = require('node:crypto');
const express = require('express');
const { normalizedID } = require('./parsing');
const { CoverUnavailableError } = require('./printerCover');
const { renderCover, parseRenderOptions, InvalidRenderOptions } = require('./coverRender');

// Constant-time comparison, so response timing can't be used to guess the secret byte by byte.
// timingSafeEqual needs equal-length inputs, so both sides are zero-padded to the longer one and
// the lengths are compared separately. They used to be SHA-256'd to equalize them instead, which
// CodeQL reads as password hashing (js/insufficient-password-hash) though nothing is stored.
function secretsMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function requireAuth(authSecret) {
  return (req, res, next) => {
    if (!secretsMatch(req.get('authorization') || '', `Bearer ${authSecret}`)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

// For the read-only image API: any of `secrets`, as a Bearer header or, for a client that can't
// set headers (a microcontroller's simplest HTTP GET, an <img> tag), a `key` query parameter.
function requireAnyKey(secrets) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : (typeof req.query.key === 'string' ? req.query.key : '');
    // Every secret is compared, so the timing doesn't say which one (if any) matched.
    const matched = secrets.map((secret) => secretsMatch(provided, secret)).includes(true);
    if (!provided || !matched) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
}

// Express 4 doesn't catch a rejected promise from an async route handler: it escapes as an
// unhandled rejection, and Node exits on those. So a single failed token-file write during a
// registration (disk full, a read-only bind mount) took the whole relay down, and with it the
// poller's in-memory print baselines and wake-retry state. Each async handler goes through this,
// so a failure answers that one request with a 500 and the process keeps running.
function handleAsync(route, handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((error) => {
      console.error(`${req.method} ${route} failed:`, error);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  };
}

function createServer({ tokenStore, deviceTokenStore, activityTokenStore, authSecret, coverService = null, archiveCoverService = null, coverApiKey = null }) {
  const app = express();
  app.use(express.json());

  // An archived print's cover, by Bambuddy archive id, for print history: a square JPEG of the
  // model on its contrast backdrop (see archiveCovers.js). 404 when there is none -- Bambuddy's own
  // thumbnail, where it has one, is the client's to fetch.
  app.get('/cover/archive/:archiveId', requireAnyKey([authSecret, coverApiKey].filter(Boolean)), handleAsync('/cover/archive', async (req, res) => {
    if (!archiveCoverService) return res.status(503).json({ error: 'cover images are not set up on this relay' });
    const archiveId = Number(req.params.archiveId);
    if (!Number.isInteger(archiveId) || archiveId <= 0) return res.status(400).json({ error: 'archiveId must be a positive whole number' });

    const jpeg = await archiveCoverService.cover(archiveId);
    if (!jpeg) return res.status(404).json({ error: 'no cover for this archive' });
    const etag = `"${crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 32)}"`;
    res.set({ ETag: etag, 'Cache-Control': 'private, max-age=86400' });
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.type('image/jpeg').send(jpeg);
  }));

  // The cover image (sliced plate render) of a printer's current or last job, for any client --
  // NozzleCast, a dashboard, a microcontroller display. printerID is the printer's name in any
  // normalization ("Vic H2C", "vich2c") or its serial number. See README "Cover image API" for the
  // query options. Answers 304 to a matching If-None-Match, so a client can poll cheaply: the
  // ETag changes only when the job (or the asked-for rendering) does.
  app.get('/cover/:printerID', requireAnyKey([authSecret, coverApiKey].filter(Boolean)), handleAsync('/cover', async (req, res) => {
    if (!coverService) return res.status(503).json({ error: 'cover images are not set up on this relay' });
    let options;
    try {
      options = parseRenderOptions(req.query);
    } catch (error) {
      if (error instanceof InvalidRenderOptions) return res.status(400).json({ error: error.message });
      throw error;
    }

    const printer = await coverService.findPrinter(req.params.printerID);
    if (!printer) return res.status(404).json({ error: 'no such printer' });
    let cover;
    try {
      cover = await coverService.cover(printer, { view: req.query.view === 'top' ? 'top' : null });
    } catch (error) {
      if (error instanceof CoverUnavailableError) return res.status(404).json({ error: error.message });
      throw error;
    }

    const variant = [options.width, options.height, options.format, options.quality, options.background, req.query.view === 'top' ? 'top' : ''].join(',');
    const etag = `${cover.etag.slice(0, -1)}-${crypto.createHash('sha256').update(variant).digest('hex').slice(0, 8)}"`;
    res.set({
      ETag: etag,
      'Cache-Control': 'no-cache',
      'X-Print-Job': encodeURIComponent(cover.jobName),
      'X-Cover-Source': cover.source,
    });
    if (req.get('if-none-match') === etag) return res.status(304).end();

    const rendered = await renderCover(cover.png, options);
    res.set({
      'Content-Type': rendered.contentType,
      'X-Image-Width': String(rendered.width),
      'X-Image-Height': String(rendered.height),
    });
    res.status(200).send(rendered.body);
  }));

  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/register', requireAuth(authSecret), handleAsync('/register', async (req, res) => {
    const { token, environment } = req.body || {};
    if (!token || !['sandbox', 'production'].includes(environment)) {
      return res.status(400).json({ error: 'invalid body: require token and environment (sandbox|production)' });
    }
    await tokenStore.upsert({ token, environment });
    res.status(200).json({ ok: true });
  }));

  app.delete('/register', requireAuth(authSecret), handleAsync('/register', async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'invalid body: require token' });
    }
    await tokenStore.remove(token);
    res.status(200).json({ ok: true });
  }));

  // NozzleCast's own plain APNs device token (distinct from the Live Activity push-to-start
  // token above) — used to send a background content-available push that wakes the app so it
  // can run `PrintLiveActivityManager.sync`, the only thing that makes a push-to-start-created
  // activity actually visible/updatable anywhere. See NozzleCast's ARCHITECTURE.md.
  app.post('/register-device', requireAuth(authSecret), handleAsync('/register-device', async (req, res) => {
    const { token, environment } = req.body || {};
    if (!token || !['sandbox', 'production'].includes(environment)) {
      return res.status(400).json({ error: 'invalid body: require token and environment (sandbox|production)' });
    }
    await deviceTokenStore.upsert({ token, environment });
    console.log(`Registered device token (${environment}) -- background wake now has somewhere to send`);
    res.status(200).json({ ok: true });
  }));

  app.delete('/register-device', requireAuth(authSecret), handleAsync('/register-device', async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'invalid body: require token' });
    }
    await deviceTokenStore.remove(token);
    res.status(200).json({ ok: true });
  }));

  // The activity's own per-activity push token, observed by the app via
  // Activity<PrintActivityAttributes>.activityUpdates -> activity.pushTokenUpdates once a
  // push-to-start-created activity exists. Registering this is what lets the relay send
  // update/end pushes directly to that activity later, instead of relying on any local device
  // code (NSE included) to find and update it -- see ARCHITECTURE.md's push-to-start-relay
  // design notes for why that path can't be relied on. Keyed by printerID, holding one token
  // per DEVICE showing that print: every device running the app gets its own Live Activity for
  // the same print, with its own independent ActivityKit token, so a second device registering
  // must not evict the first (confirmed live 2026-09-08 -- see activityTokenStore.js). Only a new
  // print, detected by the poller, clears the list.
  app.post('/register-activity', requireAuth(authSecret), handleAsync('/register-activity', async (req, res) => {
    const { token, printerID, environment } = req.body || {};
    if (!token || !printerID || !['sandbox', 'production'].includes(environment)) {
      return res.status(400).json({ error: 'invalid body: require token, printerID, and environment (sandbox|production)' });
    }
    // Defensive: normalize whatever printerID the app sends through the same function the relay
    // uses internally, so a lookup at update/end time is guaranteed to match even if the app
    // ever forwards something other than the exact attributes.printerID it was given at start.
    const normalizedPrinterID = normalizedID(printerID);
    await activityTokenStore.registerToken({ printerID: normalizedPrinterID, token, environment });
    // The device count is the load-bearing part: a second device joining a print used to be
    // invisible here precisely because it silently replaced the first one's token.
    const deviceCount = activityTokenStore.tokensFor(normalizedPrinterID).length;
    console.log(`Registered activity token for printer "${normalizedPrinterID}" (${environment}) -- ${deviceCount} device(s) now watching this print`);
    res.status(200).json({ ok: true });
  }));

  // The broadcast channels carrying this printer's current print, for an activity the app starts
  // itself in the foreground (Activity.request with pushType .channel) rather than via
  // push-to-start. 404 when the print has none -- channels disabled, creation failed, or the print
  // has ended -- and the app then falls back to a per-activity token.
  app.get('/channel/:printerID', requireAuth(authSecret), (req, res) => {
    const channels = activityTokenStore.activeChannelsFor(normalizedID(req.params.printerID));
    if (channels.length === 0) {
      return res.status(404).json({ error: 'no active channel for this printer' });
    }
    res.status(200).json({ channels });
  });

  return app;
}

module.exports = { createServer };
