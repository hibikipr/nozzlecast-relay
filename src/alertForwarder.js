const crypto = require('node:crypto');
const { AtomicJsonFile } = require('./atomicJsonFile');

// Bambuddy's alerts, received from its Webhook notification provider and pushed to every
// registered NozzleCast device as an ordinary APNs alert -- except the ones a device has muted,
// which never leave the relay. Without this, alerts reached the phone through ntfy and Firebase,
// and an alert the user had muted could only be blanked on the phone (iOS still showed it).
//
// The webhook's photo (base64 in the body) is too big for a push, so it's kept here for a few
// hours and the app's notification extension fetches it (GET /alert-photo/:id).
//
// Catch-up: Bambuddy logs every send, including a failed one to this webhook while the relay was
// down. The relay learns which provider is its own from the log row Bambuddy writes after a
// delivered alert, then re-sends that provider's failed rows it hasn't handled (without a photo:
// the log has none).

const PHOTO_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PHOTOS = 100;
// Keeps a push well inside APNs' 4 KB payload limit.
const MAX_BODY_CHARS = 1500;
// Events whose alert should break through a Focus, as ntfy's priority 4/5 did.
const TIME_SENSITIVE_EVENTS = new Set([
  'print_failed', 'printer_error', 'ai_failure_detection', 'plate_not_empty', 'printer_offline',
]);
// How long after a webhook delivery Bambuddy's log row for it is looked for.
const PROVIDER_LEARN_DELAY_MS = 20 * 1000;
const CATCH_UP_INTERVAL_MS = 5 * 60 * 1000;

function truncated(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function imageContentType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return 'image/jpeg';
}

class AlertForwarder {
  constructor({
    filePath, deviceTokenStore, apnsClients, bundleId, bambuddyClient = null, now = Date.now,
    setTimeoutImpl = setTimeout,
  }) {
    this.file = new AtomicJsonFile(filePath);
    this.deviceTokenStore = deviceTokenStore;
    this.apnsClients = apnsClients;
    this.bundleId = bundleId;
    this.bambuddyClient = bambuddyClient;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.state = { mutes: {}, webhookSeenAt: null, providerId: null, logCursor: null };
    this.photos = new Map(); // id -> { data, contentType, expiresAt }
    this.logsUnavailable = false;
  }

  async load() {
    const saved = await this.file.read();
    if (saved && typeof saved === 'object') this.state = { ...this.state, ...saved };
  }

  save() {
    return this.file.write(() => this.state);
  }

  // Whether Bambuddy's webhook has reached this relay at least once: the app turns off its own
  // ntfy/Firebase path only then, so alerts never go missing in between.
  isActive() {
    return this.state.webhookSeenAt !== null;
  }

  // A device's muted alerts, replaced whole: [{ title, body }], matched exactly.
  async setMutes(token, alerts) {
    const clean = alerts
      .filter((alert) => typeof alert?.title === 'string' && typeof alert?.body === 'string')
      .map(({ title, body }) => ({ title, body }));
    if (clean.length === 0) delete this.state.mutes[token];
    else this.state.mutes[token] = clean;
    await this.save();
  }

  isMuted(token, title, body) {
    return (this.state.mutes[token] ?? []).some((alert) => alert.title === title && alert.body === body);
  }

  photo(id) {
    const entry = this.photos.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.photos.delete(id);
      return null;
    }
    return entry;
  }

  storePhoto(base64) {
    let data;
    try {
      data = Buffer.from(base64, 'base64');
    } catch {
      return null;
    }
    if (data.length === 0) return null;
    for (const [id, entry] of this.photos) {
      if (entry.expiresAt <= this.now()) this.photos.delete(id);
    }
    while (this.photos.size >= MAX_PHOTOS) this.photos.delete(this.photos.keys().next().value);
    const id = crypto.randomUUID();
    this.photos.set(id, { data, contentType: imageContentType(data), expiresAt: this.now() + PHOTO_TTL_MS });
    return id;
  }

  // Bambuddy's generic webhook body: { title, message, timestamp, source, event, printer,
  // error_detail, ..., image? }. Field names are Bambuddy's defaults (its provider can rename
  // title/message; then these are absent and the alert is rejected).
  async receive(body) {
    const title = typeof body?.title === 'string' ? body.title : null;
    const message = typeof body?.message === 'string' ? body.message : null;
    if (title === null || message === null) throw new Error('webhook body needs "title" and "message"');

    const firstSeen = !this.isActive();
    this.state.webhookSeenAt = new Date(this.now()).toISOString();
    if (firstSeen) await this.save();

    const photoID = typeof body.image === 'string' ? this.storePhoto(body.image) : null;
    const sent = await this.forward({ title, message, event: body.event ?? null, printer: body.printer ?? null, photoID });
    if (this.state.providerId === null && this.bambuddyClient) this.learnProviderSoon(title, message);
    return sent;
  }

  // Pushes one alert to every registered device that hasn't muted it. Returns how many got it.
  async forward({ title, message, event, printer, photoID = null }) {
    const body = truncated(message, MAX_BODY_CHARS);
    let sent = 0;
    for (const entry of this.deviceTokenStore.list()) {
      // The app mutes the text it was shown, which is the truncated one for a very long alert.
      if (this.isMuted(entry.token, title, message) || this.isMuted(entry.token, title, body)) continue;
      const client = this.apnsClients[entry.environment] || this.apnsClients.production;
      const payload = {
        aps: {
          alert: { title, body },
          sound: 'default',
          'mutable-content': 1,
          'thread-id': 'bambuddy',
          'interruption-level': TIME_SENSITIVE_EVENTS.has(event) ? 'time-sensitive' : 'active',
        },
        nozzlecast: { alertID: crypto.randomUUID(), event, printer, photoID },
      };
      try {
        const result = await client.send({ token: entry.token, environment: entry.environment, payload, pushType: 'alert', topic: this.bundleId });
        if (result.shouldRemoveToken) {
          await this.deviceTokenStore.remove(entry.token);
          console.log(`Removed dead device token (status ${result.status}): ${entry.token}`);
        } else if (!result.ok) {
          console.error(`Alert push failed (status ${result.status}) for device token ${entry.token}: ${result.body}`);
        } else {
          sent += 1;
        }
      } catch (error) {
        console.error(`Alert push threw for device token ${entry.token}:`, error);
      }
    }
    console.log(`Bambuddy alert "${title}" (${event ?? 'no event'}) pushed to ${sent} device(s)`);
    return sent;
  }

  learnProviderSoon(title, message) {
    this.setTimeoutImpl(() => {
      this.learnProvider(title, message).catch((error) => console.error('Learning the alert webhook provider failed:', error));
    }, PROVIDER_LEARN_DELAY_MS);
  }

  // The provider whose delivered log row is this alert is the relay's own webhook.
  async learnProvider(title, message) {
    if (this.state.providerId !== null) return;
    const rows = await this.logs(50);
    if (!rows) return;
    const row = rows.find((candidate) => candidate.provider_type === 'webhook' && candidate.success
      && candidate.title === title && candidate.message === message);
    if (!row) return;
    this.state.providerId = row.provider_id;
    this.state.logCursor = Math.max(this.state.logCursor ?? 0, ...rows.map((candidate) => candidate.id));
    await this.save();
    console.log(`Bambuddy alert webhook is provider ${row.provider_id} ("${row.provider_name ?? 'unnamed'}"): its failed sends will be caught up`);
  }

  // Re-sends the alerts Bambuddy failed to deliver to this webhook (the relay was down) since the
  // last check. Rows only move the cursor forward, so none is sent twice.
  async catchUp() {
    if (this.state.providerId === null) return 0;
    const rows = await this.logs(200);
    if (!rows || rows.length === 0) return 0;
    const cursor = this.state.logCursor ?? 0;
    const missed = rows
      .filter((row) => row.id > cursor && row.provider_id === this.state.providerId && !row.success)
      .sort((a, b) => a.id - b.id);
    this.state.logCursor = Math.max(cursor, ...rows.map((row) => row.id));
    await this.save();
    for (const row of missed) {
      await this.forward({ title: row.title, message: row.message, event: row.event_type, printer: row.printer_name ?? null });
    }
    if (missed.length > 0) console.log(`Caught up ${missed.length} Bambuddy alert(s) the relay missed`);
    return missed.length;
  }

  async logs(limit) {
    if (!this.bambuddyClient || this.logsUnavailable) return null;
    try {
      return await this.bambuddyClient.notificationLogs({ limit });
    } catch (error) {
      if (/status 40[13]/.test(error.message)) {
        this.logsUnavailable = true;
        console.error(`Bambuddy's notification log isn't readable with the relay's API key (${error.message}); missed alerts won't be caught up. Give the key notifications:read.`);
        return null;
      }
      throw error;
    }
  }

  startCatchUp() {
    const run = () => this.catchUp().catch((error) => console.error('Catching up Bambuddy alerts failed:', error));
    run();
    return setInterval(run, CATCH_UP_INTERVAL_MS);
  }
}

module.exports = { AlertForwarder, TIME_SENSITIVE_EVENTS };
