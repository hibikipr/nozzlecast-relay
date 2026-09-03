const express = require('express');

function requireAuth(authSecret) {
  return (req, res, next) => {
    if (req.get('authorization') !== `Bearer ${authSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function createServer({ tokenStore, deviceTokenStore, authSecret }) {
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

  return app;
}

module.exports = { createServer };
