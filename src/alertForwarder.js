const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
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
//
// Feed: every alert is also kept (the last FEED_MAX_ITEMS, for FEED_TTL_MS) for the app to fetch
// with GET /alerts, minus what that device muted. On a relay without Apple push keys that is the
// only way alerts reach the phone: the app checks while it's open and when iOS gives it background
// time. A device is whatever key the app mutes under: its APNs token, or a generated id without one.

const PHOTO_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PHOTOS = 100;
// Alert photos are kept within this size (px) at this JPEG quality: see storePhoto.
const PHOTO_MAX_DIMENSION = 1280;
const PHOTO_JPEG_QUALITY = 72;
// Keeps a push well inside APNs' 4 KB payload limit.
const MAX_BODY_CHARS = 1500;
// Events whose alert should break through a Focus, as ntfy's priority 4/5 did.
const TIME_SENSITIVE_EVENTS = new Set([
  'print_failed', 'printer_error', 'ai_failure_detection', 'plate_not_empty', 'printer_offline',
]);
// How long after a webhook delivery Bambuddy's log row for it is looked for.
const FEED_MAX_ITEMS = 200;
const FEED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PHOTO_ID_PATTERN = /^[0-9a-f-]{36}$/;
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
    filePath, feedPath = null, photoDir = null, deviceTokenStore, apnsClients, bundleId,
    bambuddyClient = null, now = Date.now, setTimeoutImpl = setTimeout,
  }) {
    this.file = new AtomicJsonFile(filePath);
    this.feedFile = feedPath ? new AtomicJsonFile(feedPath) : null;
    // Photos go to disk when there's a folder for them, so a device that fetches the feed hours
    // later (or after a restart) still gets them; otherwise they're kept in memory for PHOTO_TTL_MS.
    this.photoDir = photoDir;
    this.feed = { nextId: 1, items: [] };
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
    const feed = this.feedFile ? await this.feedFile.read() : null;
    if (feed && Number.isInteger(feed.nextId) && Array.isArray(feed.items)) this.feed = feed;
    if (this.photoDir) await fs.mkdir(this.photoDir, { recursive: true });
  }

  // Whether alerts go out as APNs pushes: not on a relay without Apple push keys.
  pushesEnabled() {
    return Boolean(this.apnsClients);
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

  photoFile(id) {
    return path.join(this.photoDir, `${id}.jpg`);
  }

  async photo(id) {
    if (typeof id !== 'string' || !PHOTO_ID_PATTERN.test(id)) return null;
    if (this.photoDir) {
      try {
        const data = await fs.readFile(this.photoFile(id));
        return { data, contentType: imageContentType(data) };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }
    const entry = this.photos.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.photos.delete(id);
      return null;
    }
    return entry;
  }

  // Kept shrunk: an H2C chamber frame is 1080p at 300-600 KB, slow for the notification
  // extension on a mobile connection. Within PHOTO_MAX_DIMENSION as JPEG it's around 100 KB and
  // looks the same in a notification. A photo sharp can't read is kept as it came.
  async storePhoto(base64) {
    let data;
    try {
      data = Buffer.from(base64, 'base64');
    } catch {
      return null;
    }
    if (data.length === 0) return null;
    try {
      data = await sharp(data)
        .rotate()
        .resize(PHOTO_MAX_DIMENSION, PHOTO_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: PHOTO_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
    } catch {
      // Not an image sharp can decode: stored unchanged.
    }
    const id = crypto.randomUUID();
    if (this.photoDir) {
      // Written whole, then renamed, so a fetch never reads half a photo. Pruned with the feed.
      const tmp = `${this.photoFile(id)}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, this.photoFile(id));
      return id;
    }
    for (const [id, entry] of this.photos) {
      if (entry.expiresAt <= this.now()) this.photos.delete(id);
    }
    while (this.photos.size >= MAX_PHOTOS) this.photos.delete(this.photos.keys().next().value);
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

    const photoID = typeof body.image === 'string' ? await this.storePhoto(body.image) : null;
    const alert = { title, message, event: body.event ?? null, printer: body.printer ?? null, photoID };
    await this.record(alert);
    const sent = await this.forward(alert);
    if (this.state.providerId === null && this.bambuddyClient) this.learnProviderSoon(title, message);
    return sent;
  }

  // The app mutes the text it was shown, which is the truncated one for a very long alert.
  isMutedFor(device, title, message) {
    return this.isMuted(device, title, message) || this.isMuted(device, title, truncated(message, MAX_BODY_CHARS));
  }

  // Keeps an alert in the feed, dropping what's past FEED_MAX_ITEMS or FEED_TTL_MS (and its photo).
  async record({ title, message, event, printer, photoID = null }) {
    const item = {
      id: this.feed.nextId,
      receivedAt: new Date(this.now()).toISOString(),
      title,
      message,
      event,
      printer,
      photoID,
    };
    this.feed.nextId += 1;
    this.feed.items.push(item);
    const oldest = this.now() - FEED_TTL_MS;
    const dropped = [];
    while (this.feed.items.length > FEED_MAX_ITEMS || (this.feed.items.length > 0 && Date.parse(this.feed.items[0].receivedAt) < oldest)) {
      dropped.push(this.feed.items.shift());
    }
    if (this.feedFile) await this.feedFile.write(() => this.feed);
    if (this.photoDir) {
      for (const old of dropped) {
        if (old.photoID) await fs.rm(this.photoFile(old.photoID), { force: true });
      }
    }
    return item;
  }

  // A device's alerts newer than `after`, minus the ones it muted. Without `after` (a device's
  // first check) nothing is replayed: it gets only the id to continue from.
  feedFor(device, after) {
    const latestId = this.feed.nextId - 1;
    if (after === null || after === undefined) return { items: [], latestId };
    const items = this.feed.items
      .filter((item) => item.id > after && !(device && this.isMutedFor(device, item.title, item.message)))
      .map((item) => ({
        id: item.id,
        receivedAt: item.receivedAt,
        title: item.title,
        body: truncated(item.message, MAX_BODY_CHARS),
        event: item.event,
        printer: item.printer,
        photoID: item.photoID,
        timeSensitive: TIME_SENSITIVE_EVENTS.has(item.event),
      }));
    return { items, latestId };
  }

  // Pushes one alert to every registered device that hasn't muted it. Returns how many got it.
  async forward({ title, message, event, printer, photoID = null }) {
    if (!this.pushesEnabled()) return 0;
    const body = truncated(message, MAX_BODY_CHARS);
    let sent = 0;
    for (const entry of this.deviceTokenStore.list()) {
      if (this.isMutedFor(entry.token, title, message)) continue;
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
      const alert = { title: row.title, message: row.message, event: row.event_type, printer: row.printer_name ?? null };
      await this.record(alert);
      await this.forward(alert);
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
