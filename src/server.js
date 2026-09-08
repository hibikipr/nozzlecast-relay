const express = require('express');
const { normalizedID } = require('./parsing');

function requireAuth(authSecret) {
  return (req, res, next) => {
    if (req.get('authorization') !== `Bearer ${authSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function createServer({ tokenStore, deviceTokenStore, activityTokenStore, authSecret }) {
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

  // NozzleCast's own plain APNs device token (distinct from the Live Activity push-to-start
  // token above) — used to send a background content-available push that wakes the app so it
  // can run `PrintLiveActivityManager.sync`, the only thing that makes a push-to-start-created
  // activity actually visible/updatable anywhere. See NozzleCast's ARCHITECTURE.md.
  app.post('/register-device', requireAuth(authSecret), async (req, res) => {
    const { token, environment } = req.body || {};
    if (!token || !['sandbox', 'production'].includes(environment)) {
      return res.status(400).json({ error: 'invalid body: require token and environment (sandbox|production)' });
    }
    await deviceTokenStore.upsert({ token, environment });
    console.log(`Registered device token (${environment}) -- background wake now has somewhere to send`);
    res.status(200).json({ ok: true });
  });

  app.delete('/register-device', requireAuth(authSecret), async (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'invalid body: require token' });
    }
    await deviceTokenStore.remove(token);
    res.status(200).json({ ok: true });
  });

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
  app.post('/register-activity', requireAuth(authSecret), async (req, res) => {
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
  });

  return app;
}

module.exports = { createServer };
