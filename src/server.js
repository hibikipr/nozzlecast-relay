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
